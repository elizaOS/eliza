/**
 * Runs the onboarding state machine and persists its transcript. Worker
 * deployments delegate each session to one Durable Object; local callers use
 * an in-process keyed queue over the cache-backed store.
 */

import { ElizaError } from "@elizaos/core";
import type {
  RuntimeDurableObjectNamespace,
  RuntimeDurableObjectStub,
} from "../../../types/cloud-worker-env";
import { cache } from "../../cache/client";
import {
  getCloudAwareEnv,
  getCloudBinding,
  hasCloudBindingsContext,
} from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";
import { launchManagedElizaAgent } from "../eliza-managed-launch";
import {
  enqueueDiscordProactiveGreeting,
  PROACTIVE_GREETING_QUEUE_PREFIX,
  type ProactiveGreetingRequest,
} from "./onboarding-proactive-greeting";
import {
  type ElizaAppProvisioningStatus,
  ensureElizaAppProvisioning,
  getElizaAppProvisioningStatus,
} from "./provisioning";
import { elizaAppUserService } from "./user-service";

export type OnboardingChatRole = "user" | "assistant";
export type OnboardingPlatform = "web" | "telegram" | "discord" | "whatsapp" | "twilio" | "blooio";

export interface OnboardingChatMessage {
  /** Stable marker used to reconstruct idempotent response snapshots. */
  id?: string;
  role: OnboardingChatRole;
  content: string;
  createdAt: string;
}

export interface OnboardingSession {
  id: string;
  /**
   * Opaque credential carried by browser continuation links. Messaging
   * transports keep the deterministic platform session id private because
   * platform user ids are commonly public or guessable.
   */
  continuationToken?: string;
  createdAt: string;
  updatedAt: string;
  platform?: OnboardingPlatform;
  platformUserId?: string;
  platformDisplayName?: string;
  /**
   * True once a trusted transport (internal gateway auth) has attested the
   * platform identity on this session. Only trusted platform identities may
   * be linked to a cloud account after login.
   */
  platformIdentityTrusted?: boolean;
  name?: string;
  userId?: string;
  organizationId?: string;
  agentId?: string;
  handoffCopiedAt?: string;
  launchUrl?: string;
  history: OnboardingChatMessage[];
}

export interface OnboardingChatInput {
  sessionId?: string;
  message?: string;
  platform?: OnboardingPlatform;
  platformUserId?: string;
  platformDisplayName?: string;
  authenticatedUser?: {
    userId: string;
    organizationId: string;
    telegramId?: string;
  } | null;
  trustedPlatformIdentity?: boolean;
  /** Requests fail-closed redemption of an existing trusted Telegram session. */
  continuationMode?: "trusted-telegram";
  /** Stable transport delivery id. Replays return the original result. */
  idempotencyKey?: string;
  /**
   * Read-only status poll. When true the call returns the current provisioning
   * state and a deterministic reply but never appends to session history, even
   * on a brand-new session. Browser polling uses this so repeated 5 s polls
   * cannot grow the durable transcript with duplicate status copy.
   */
  statusOnly?: boolean;
  /** Explicit, informed browser confirmation of a trusted platform link. */
  confirmPlatformLink?: boolean;
}

export interface DiscordOnboardingContinuationPreview {
  platform: "discord";
  platformUserId: string;
  platformDisplayName: string;
}

export interface OnboardingChatCta {
  label: string;
  url: string;
}

export interface OnboardingChatResult {
  session: OnboardingSession;
  reply: string;
  requiresLogin: boolean;
  loginUrl: string;
  controlPanelUrl: string;
  launchUrl: string | null;
  provisioning: ElizaAppProvisioningStatus;
  handoffComplete: boolean;
  /**
   * Login handoff rendered as a platform affordance (for example a Discord
   * link button). When present, the reply text intentionally omits the raw
   * loginUrl; transports without button support keep the inline URL and get
   * null here. Same loginUrl either way - presentation only.
   */
  cta?: OnboardingChatCta | null;
  /**
   * Commit-ordering handoff: the proactive greeting this turn produced, if
   * any. The state machine only RECORDS it; the caller that owns the turn's
   * durable commit (coordinator transaction or local store) enqueues it
   * strictly AFTER the commit lands and strips this field before the result
   * crosses the service boundary. A turn that fails to persist therefore can
   * never DM "you're all set" for a sign-in that did not durably complete.
   */
  proactiveGreeting?: ProactiveGreetingRequest | null;
}

const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_HISTORY_MESSAGES = 200;
/**
 * Hard byte bound on a stored user message. The public route already caps
 * message length, but gateway services call runOnboardingChat directly with
 * raw connector payloads, so the session store enforces its own bound.
 */
const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_ONBOARDING_APP_URL = "https://app.elizacloud.ai";
// `/get-started` belongs to the homepage, while dashboard and billing links
// belong to the Cloud app. Keep these origins separate so fixing one route
// cannot silently break the other surface.
const DEFAULT_ONBOARDING_LOGIN_APP_URL = "https://eliza.app";
const ELIZA_APP_INITIAL_CREDIT_USD = "$5";
/** Label for platforms that render the login link as a UI affordance. */
const ONBOARDING_CTA_LABEL = "Connect";
/**
 * Discord rejects button URLs longer than 512 characters. Enforced here so a
 * too-long login URL falls back to inline-URL copy instead of producing a CTA
 * the transport would refuse (which would drop the whole reply).
 */
const MAX_CTA_URL_LENGTH = 512;

function sessionCacheKey(sessionId: string): string {
  return `eliza-app:onboarding:${sessionId}`;
}

function continuationCacheKey(token: string): string {
  return `eliza-app:onboarding-continuation:${token}`;
}

function resultCacheKey(
  sessionId: string,
  idempotencyKey: string,
  input: OnboardingChatInput,
): string {
  const account = input.authenticatedUser;
  const scope = account
    ? `account:${encodeURIComponent(account.organizationId)}:${encodeURIComponent(account.userId)}`
    : "transport";
  const mode = input.continuationMode ?? "standard";
  const telegramId = input.authenticatedUser?.telegramId ?? "no-telegram";
  return `eliza-app:onboarding-result:${sessionId}:${scope}:${mode}:${encodeURIComponent(telegramId)}:${idempotencyKey}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createOnboardingSessionId(input?: {
  platform?: OnboardingPlatform;
  platformUserId?: string;
}): string {
  if (input?.platform && input.platformUserId) {
    return `platform:${input.platform}:${input.platformUserId}`;
  }
  return crypto.randomUUID();
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9:+_-]{8,180}$/;
const PLATFORM_SESSION_PREFIX = "platform:";

/**
 * The proactive-greeting queues live in the same Durable Object namespace as
 * per-session coordinators under a reserved, well-known name. No caller may
 * ever address a queue instance as a chat session: a chat turn landing there
 * would contend the queue's serialize lock and write chat state into queue
 * storage.
 */
function isReservedSessionId(value: string): boolean {
  return value.startsWith(PROACTIVE_GREETING_QUEUE_PREFIX);
}

function redactSessionIdForLog(sessionId: string): string {
  return sessionId.replace(/\d(?=\d{4})/g, "*");
}

/**
 * Platform-scoped session ids (`platform:<platform>:<platformUserId>`) are
 * derived from public or guessable messaging identities. Only a trusted
 * transport may present one. Browser continuations use a separate opaque
 * credential, so authentication alone never grants access to a session whose
 * platform id an attacker can derive.
 */
function sanitizeSessionId(value: string | undefined, input: OnboardingChatInput): string {
  const trimmed = value?.trim();
  if (trimmed && isReservedSessionId(trimmed)) {
    logger.warn("[eliza-app onboarding] rejected reserved queue instance name as session id", {
      sessionId: redactSessionIdForLog(trimmed),
    });
  } else if (trimmed && SESSION_ID_PATTERN.test(trimmed)) {
    if (!trimmed.startsWith(PLATFORM_SESSION_PREFIX)) {
      return trimmed;
    }
    if (input.trustedPlatformIdentity === true) {
      return trimmed;
    }
    logger.warn(
      "[eliza-app onboarding] rejected platform-scoped session id from untrusted caller",
      { sessionId: redactSessionIdForLog(trimmed) },
    );
  }
  // Only a trusted transport may mint a platform-scoped id from the
  // platform/platformUserId inputs; everyone else gets an unguessable id.
  if (input.trustedPlatformIdentity === true) {
    return createOnboardingSessionId(input);
  }
  return crypto.randomUUID();
}

interface OnboardingContinuation {
  sessionId: string;
}

export interface TelegramOnboardingContinuationValidation {
  sessionId: string;
  userId?: string;
  organizationId?: string;
}

export interface ValidateTelegramOnboardingContinuationInput {
  continuationToken: string;
  telegramId: string;
  authenticatedAccount?: {
    userId: string;
    organizationId: string;
  } | null;
}

function isOnboardingContinuation(value: unknown): value is OnboardingContinuation {
  if (!value || typeof value !== "object" || !("sessionId" in value)) {
    return false;
  }
  const sessionId = value.sessionId;
  return (
    typeof sessionId === "string" &&
    SESSION_ID_PATTERN.test(sessionId) &&
    sessionId.startsWith(PLATFORM_SESSION_PREFIX)
  );
}

async function resolveContinuationToken(token: string): Promise<string | null> {
  const trimmed = token.trim();
  if (
    !SESSION_ID_PATTERN.test(trimmed) ||
    trimmed.startsWith(PLATFORM_SESSION_PREFIX) ||
    isReservedSessionId(trimmed)
  ) {
    return null;
  }

  const coordinator = onboardingCoordinator();
  if (coordinator) {
    const response = await coordinator
      .getByName(trimmed)
      .fetch("https://onboarding.internal/resolve", { method: "POST" });
    if (response.ok) {
      const resolved: unknown = await response.json();
      if (isOnboardingContinuation(resolved)) return resolved.sessionId;
    }
  }

  const continuation = await cache.get<unknown>(continuationCacheKey(trimmed));
  return isOnboardingContinuation(continuation) ? continuation.sessionId : null;
}

async function resolveSessionId(input: OnboardingChatInput): Promise<string> {
  const sessionId = sanitizeSessionId(input.sessionId, input);
  if (
    input.authenticatedUser &&
    input.trustedPlatformIdentity !== true &&
    input.sessionId?.trim() === sessionId
  ) {
    return (await resolveContinuationToken(sessionId)) ?? sessionId;
  }
  return sessionId;
}

async function loadOnboardingSessionForValidation(
  sessionId: string,
): Promise<OnboardingSession | null> {
  const coordinator = onboardingCoordinator();
  if (coordinator) {
    const response = await coordinator
      .getByName(sessionId)
      .fetch("https://onboarding.internal/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    if (response.ok) {
      return (await response.json()) as OnboardingSession;
    }
  }
  return loadCachedOnboardingSession(sessionId);
}

function trustedDiscordContinuationError(session: OnboardingSession | null): ElizaError {
  return new ElizaError("Invalid Discord onboarding continuation", {
    code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    context: { platform: "discord", sessionFound: Boolean(session) },
    severity: "ephemeral",
  });
}

function isDiscordContinuationForAccount(
  session: OnboardingSession | null,
  authenticatedAccount: { userId: string; organizationId: string },
): session is OnboardingSession & { platform: "discord"; platformUserId: string } {
  const hasUserBinding = session?.userId !== undefined;
  const hasOrganizationBinding = session?.organizationId !== undefined;
  return Boolean(
    session &&
      session.platform === "discord" &&
      session.platformIdentityTrusted === true &&
      session.platformUserId &&
      isFreshOnboardingSession(session) &&
      hasUserBinding === hasOrganizationBinding &&
      (session.userId === undefined || session.userId === authenticatedAccount.userId) &&
      (session.organizationId === undefined ||
        session.organizationId === authenticatedAccount.organizationId),
  );
}

/** Resolve an opaque Discord continuation without mutating or binding it. */
export async function inspectDiscordOnboardingContinuation(
  continuationToken: string,
  authenticatedAccount: { userId: string; organizationId: string },
): Promise<DiscordOnboardingContinuationPreview> {
  const sessionId = await resolveContinuationToken(continuationToken);
  const session = sessionId ? await loadOnboardingSessionForValidation(sessionId) : null;
  if (!isDiscordContinuationForAccount(session, authenticatedAccount)) {
    throw trustedDiscordContinuationError(session);
  }
  return {
    platform: "discord",
    platformUserId: session.platformUserId,
    platformDisplayName: session.platformDisplayName?.trim() || session.platformUserId,
  };
}

/**
 * A mutating Discord confirmation must still resolve the exact trusted session
 * previewed by this account. This closes expiry/binding TOCTOU windows between
 * GET preview and POST confirmation and refuses direct forged confirmations.
 */
function assertConfirmedDiscordContinuation(
  session: OnboardingSession | null,
  input: OnboardingChatInput,
): void {
  if (input.confirmPlatformLink !== true) return;
  if (
    !input.authenticatedUser ||
    input.trustedPlatformIdentity === true ||
    !isDiscordContinuationForAccount(session, input.authenticatedUser)
  ) {
    throw trustedDiscordContinuationError(session);
  }
}

function isFreshOnboardingSession(session: OnboardingSession): boolean {
  const createdAt = Date.parse(session.createdAt);
  return (
    Number.isFinite(createdAt) &&
    createdAt <= Date.now() + 5 * 60 * 1000 &&
    Date.now() - createdAt <= SESSION_TTL_SECONDS * 1000
  );
}

function trustedContinuationError(session: OnboardingSession | null): ElizaError {
  return new ElizaError("Invalid trusted Telegram onboarding continuation", {
    code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    context: {
      sessionFound: Boolean(session),
      trustedTelegramSession:
        session?.platform === "telegram" && session.platformIdentityTrusted === true,
    },
    severity: "ephemeral",
  });
}

export async function validateTelegramOnboardingContinuation(
  input: ValidateTelegramOnboardingContinuationInput,
): Promise<TelegramOnboardingContinuationValidation> {
  const sessionId = await resolveContinuationToken(input.continuationToken);
  if (!sessionId) throw trustedContinuationError(null);

  const session = await loadOnboardingSessionForValidation(sessionId);
  const hasUserBinding = session?.userId !== undefined;
  const hasOrganizationBinding = session?.organizationId !== undefined;
  if (
    !session ||
    session.platform !== "telegram" ||
    session.platformIdentityTrusted !== true ||
    !session.platformUserId ||
    !isFreshOnboardingSession(session) ||
    hasUserBinding !== hasOrganizationBinding ||
    (session.userId !== undefined && session.userId !== input.authenticatedAccount?.userId) ||
    (session.organizationId !== undefined &&
      session.organizationId !== input.authenticatedAccount?.organizationId)
  ) {
    throw trustedContinuationError(session);
  }

  if (session.platformUserId !== input.telegramId) {
    throw new ElizaError(
      "The authenticated messaging identity does not match this onboarding session",
      {
        code: "ONBOARDING_PLATFORM_IDENTITY_MISMATCH",
        context: { platform: "telegram", hasSignedPlatformIdentity: true },
        severity: "ephemeral",
      },
    );
  }

  return {
    sessionId,
    userId: session.userId,
    organizationId: session.organizationId,
  };
}

export interface ClaimTelegramOnboardingContinuationInput
  extends ValidateTelegramOnboardingContinuationInput {
  claimId: string;
  phoneNumber: string;
}

export interface TelegramOnboardingContinuationClaim {
  status: "acquired" | "completed";
  sessionId: string;
  userId?: string;
  organizationId?: string;
}

function parseTelegramOnboardingContinuationClaim(
  value: unknown,
): TelegramOnboardingContinuationClaim {
  if (!value || typeof value !== "object") throw trustedContinuationError(null);
  const claim = value as Record<string, unknown>;
  const validSession = typeof claim.sessionId === "string" && Boolean(claim.sessionId);
  const valid =
    validSession &&
    (claim.status === "acquired" ||
      (claim.status === "completed" &&
        typeof claim.userId === "string" &&
        Boolean(claim.userId) &&
        typeof claim.organizationId === "string" &&
        Boolean(claim.organizationId)));
  if (!valid) throw trustedContinuationError(null);
  return claim as unknown as TelegramOnboardingContinuationClaim;
}

export async function claimTelegramOnboardingContinuation(
  input: ClaimTelegramOnboardingContinuationInput,
): Promise<TelegramOnboardingContinuationClaim> {
  const token = input.continuationToken.trim();
  const coordinator = onboardingCoordinator();
  if (!coordinator || !SESSION_ID_PATTERN.test(token) || isReservedSessionId(token)) {
    throw trustedContinuationError(null);
  }
  const response = await coordinator.getByName(token).fetch("https://onboarding.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      claimId: input.claimId,
      telegramId: input.telegramId,
      phoneNumber: input.phoneNumber,
      userId: input.authenticatedAccount?.userId,
      organizationId: input.authenticatedAccount?.organizationId,
    }),
  });
  if (!response.ok) throw trustedContinuationError(null);
  return parseTelegramOnboardingContinuationClaim(await response.json());
}

export async function completeTelegramOnboardingContinuationClaim(input: {
  continuationToken: string;
  claimId: string;
  telegramId: string;
  phoneNumber: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const coordinator = onboardingCoordinator();
  if (!coordinator) throw trustedContinuationError(null);
  const response = await coordinator
    .getByName(input.continuationToken.trim())
    .fetch("https://onboarding.internal/complete-claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  if (!response.ok) throw trustedContinuationError(null);
}

export async function loadCachedOnboardingSession(
  sessionId: string,
): Promise<OnboardingSession | null> {
  return cache.get<OnboardingSession>(sessionCacheKey(sessionId));
}

export async function mirrorOnboardingSessionToCache(session: OnboardingSession): Promise<void> {
  if (session.continuationToken && session.id.startsWith(PLATFORM_SESSION_PREFIX)) {
    await cache.set(
      continuationCacheKey(session.continuationToken),
      { sessionId: session.id } satisfies OnboardingContinuation,
      SESSION_TTL_SECONDS,
    );
  }
  await cache.set(sessionCacheKey(session.id), session, SESSION_TTL_SECONDS);
}

function trimHistory(history: OnboardingChatMessage[]): OnboardingChatMessage[] {
  return history.length > MAX_HISTORY_MESSAGES
    ? history.slice(history.length - MAX_HISTORY_MESSAGES)
    : history;
}

function appendMessage(
  session: OnboardingSession,
  role: OnboardingChatRole,
  content: string,
): OnboardingSession {
  const message = content.trim();
  if (!message) return session;
  return {
    ...session,
    updatedAt: nowIso(),
    history: trimHistory([
      ...session.history,
      { id: crypto.randomUUID(), role, content: message, createdAt: nowIso() },
    ]),
  };
}

/**
 * Words that confused users send as standalone replies (or as "I'm <state>"
 * continuations) which must never be captured as a preferred name. Includes
 * URL scheme fragments so "my name is https://evil.example" never names the
 * user "https".
 */
const NAME_STOPWORDS = new Set([
  "back",
  "busy",
  "confused",
  "cool",
  "done",
  "eliza",
  "fine",
  "good",
  "great",
  "hello",
  "help",
  "here",
  "hey",
  "hi",
  "hmm",
  "how",
  "http",
  "https",
  "huh",
  "interested",
  "lol",
  "lost",
  "maybe",
  "nah",
  "new",
  "nice",
  "no",
  "nope",
  "not",
  "ok",
  "okay",
  "please",
  "ready",
  "sorry",
  "start",
  "stop",
  "sure",
  "test",
  "thank",
  "thanks",
  "what",
  "when",
  "where",
  "who",
  "why",
  "www",
  "yeah",
  "yep",
  "yes",
  "yo",
  "you",
]);

const EXPLICIT_NAME_PATTERN = /\b(?:my name is|i am|i'm|call me)\s+([a-z][a-z .'-]{1,40})/i;
const BARE_NAME_PATTERN = /^\s*([A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]{1,30})?)\s*$/;

function containsStopword(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(Boolean)
    .some((word) => NAME_STOPWORDS.has(word.replace(/'/g, "")));
}

/**
 * Normalizes a candidate preferred name to the ASCII-safe form the SMS reply
 * path requires and rejects candidates that are placeholders, stopwords, or
 * empty after sanitization (for example fully non-ASCII display names, which
 * simply keep the "what should I call you?" prompt active).
 */
function sanitizePreferredName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = sanitizeReplyText(raw)
    .replace(/\s+/g, " ")
    .replace(/[.!?,]+$/, "")
    .trim()
    .slice(0, 60)
    .trim();
  if (!cleaned) return undefined;
  if (isPlaceholderPhoneName(cleaned)) return undefined;
  if (containsStopword(cleaned)) return undefined;
  return cleaned;
}

/** Explicit intent ("call me X") — allowed to replace an existing name. */
function inferExplicitName(message: string): string | undefined {
  const match = EXPLICIT_NAME_PATTERN.exec(message);
  return sanitizePreferredName(match?.[1]);
}

/** Weak inference (bare capitalized word) — only fills an empty name. */
function inferBareName(message: string): string | undefined {
  const match = BARE_NAME_PATTERN.exec(message);
  return sanitizePreferredName(match?.[1]);
}

/**
 * Auto-generated account display names ("User ***1234", "WhatsApp ***5678",
 * masked emails like "User ab***cd", or raw phone numbers) are never a
 * captured preferred name.
 */
function isPlaceholderPhoneName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.includes("***")) return true;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 7 && !/[a-zA-Z]/.test(trimmed);
}

function hasPreferredName(session: OnboardingSession): boolean {
  return Boolean(session.name?.trim() && !isPlaceholderPhoneName(session.name));
}

function isPhoneLikePlatformIdentity(args: {
  trustedPlatformIdentity?: boolean;
  platform?: OnboardingPlatform;
  platformUserId?: string;
}): boolean {
  return (
    args.trustedPlatformIdentity === true &&
    (args.platform === "blooio" || args.platform === "twilio") &&
    /^\+?[1-9]\d{7,15}$/.test(args.platformUserId ?? "")
  );
}

async function maybeLinkAuthenticatedPlatformIdentity(
  session: OnboardingSession,
  input: OnboardingChatInput,
): Promise<OnboardingSession> {
  // Identity linking requires a platform identity attested by a trusted
  // transport — either this turn or a previous gateway turn on the session.
  // An authenticated web caller claiming an arbitrary phone number or Discord
  // id in the request body must never bind that identity to their account.
  const platformIdentityTrusted =
    input.trustedPlatformIdentity === true || session.platformIdentityTrusted === true;
  if (!input.authenticatedUser || !platformIdentityTrusted) {
    return session;
  }

  // Discord: a PRIOR gateway turn attested "this session belongs to discord
  // user X"; the user then authenticated (e.g. Steward email login) via the
  // opaque continuation credential. Bind the Discord identity so
  // routeDiscordMessage resolves their DMs to the provisioned agent instead of
  // onboarding forever. Skipped on gateway turns themselves
  // (input.trustedPlatformIdentity): there the authenticated account was
  // RESOLVED FROM user_identities.discord_id, so the link already exists and
  // re-linking would just add a DB round trip to every DM turn.
  if (
    session.platform === "discord" &&
    session.platformUserId &&
    input.trustedPlatformIdentity !== true
  ) {
    if (input.confirmPlatformLink !== true) {
      throw new ElizaError("Discord identity linking requires explicit confirmation", {
        code: "ONBOARDING_PLATFORM_LINK_CONFIRMATION_REQUIRED",
        context: { platform: "discord" },
        severity: "ephemeral",
      });
    }
    // Same error policy as the phone link below: success:false is the designed
    // tenant-safety decline (identity owned by another account) and onboarding
    // continues; a genuine infra failure throws and propagates — it reruns on
    // every eligible turn, so a transient throw self-heals on the next attempt.
    const discordLink = await elizaAppUserService.linkDiscordToUser(
      input.authenticatedUser.userId,
      {
        discordId: session.platformUserId,
        username: session.platformDisplayName?.trim() || session.platformUserId,
      },
    );
    if (!discordLink.success) {
      throw new ElizaError(discordLink.error || "Discord identity could not be linked", {
        code: "ONBOARDING_PLATFORM_IDENTITY_CONFLICT",
        context: { platform: "discord" },
        severity: "ephemeral",
      });
    }
    return session;
  }

  if (
    !isPhoneLikePlatformIdentity({
      trustedPlatformIdentity: true,
      platform: session.platform,
      platformUserId: session.platformUserId,
    })
  ) {
    return session;
  }

  const phoneNumber = session.platformUserId;
  if (!phoneNumber) return session;

  // linkPhoneToUser returns success:false only for the designed tenant-safety
  // decline (the phone is already bound to a different account); a genuine
  // DB/infra failure throws and must propagate — leaving a messaging identity
  // silently unlinked is a broken pipeline this onboarding domain fails closed
  // on. It runs on every eligible turn, so a transient throw self-heals on the
  // next attempt once a boundary has surfaced it.
  const linkResult = await elizaAppUserService.linkPhoneToUser(
    input.authenticatedUser.userId,
    phoneNumber,
  );
  if (!linkResult.success) {
    // error-policy:J4 expected tenant-safety decline (phone owned by another
    // account); onboarding continues without binding the identity.
    logger.warn("[eliza-app onboarding] phone link declined", {
      userId: input.authenticatedUser.userId,
      error: linkResult.error,
    });
  }

  return session;
}

function assertAuthenticatedTelegramIdentity(
  session: OnboardingSession,
  input: OnboardingChatInput,
): void {
  // A trusted transport attests its own platform identity — except in strict
  // continuation mode, where the caller is the auth route acting on a signed
  // browser payload and the identity match must always run.
  if (
    !input.authenticatedUser ||
    (input.trustedPlatformIdentity === true && input.continuationMode !== "trusted-telegram") ||
    session.platformIdentityTrusted !== true
  ) {
    return;
  }

  if (session.platform !== "telegram") {
    return;
  }
  const signedPlatformId = input.authenticatedUser.telegramId;
  if (signedPlatformId === session.platformUserId) {
    return;
  }

  throw new ElizaError(
    "The authenticated messaging identity does not match this onboarding session",
    {
      code: "ONBOARDING_PLATFORM_IDENTITY_MISMATCH",
      context: {
        platform: session.platform,
        hasSignedPlatformIdentity: Boolean(signedPlatformId),
      },
      severity: "ephemeral",
    },
  );
}

export function assertTrustedTelegramContinuation(
  session: OnboardingSession | null,
  input: OnboardingChatInput,
): void {
  if (input.continuationMode !== "trusted-telegram") return;

  const hasUserBinding = session?.userId !== undefined;
  const hasOrganizationBinding = session?.organizationId !== undefined;
  if (
    !session ||
    !input.authenticatedUser ||
    session.platform !== "telegram" ||
    session.platformIdentityTrusted !== true ||
    !session.platformUserId ||
    !isFreshOnboardingSession(session) ||
    hasUserBinding !== hasOrganizationBinding ||
    (session.userId !== undefined && session.userId !== input.authenticatedUser.userId) ||
    (session.organizationId !== undefined &&
      session.organizationId !== input.authenticatedUser.organizationId)
  ) {
    throw trustedContinuationError(session);
  }

  assertAuthenticatedTelegramIdentity(session, input);
}

function getOnboardingAppUrl(): string {
  const env = getCloudAwareEnv();
  const configured =
    env.ELIZA_ONBOARDING_APP_URL ||
    env.NEXT_PUBLIC_ELIZA_APP_URL ||
    env.NEXT_PUBLIC_APP_URL ||
    DEFAULT_ONBOARDING_APP_URL;
  return configured.replace(/\/+$/, "");
}

function onboardingAppPath(path: string): string {
  return `${getOnboardingAppUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

function onboardingLoginAppPath(path: string): string {
  const configured =
    getCloudAwareEnv().ELIZA_ONBOARDING_LOGIN_APP_URL || DEFAULT_ONBOARDING_LOGIN_APP_URL;
  const baseUrl = configured.replace(/\/+$/, "");
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Platforms whose transports render the login handoff as a link button. The
 * reply text on these platforms drops the raw URL; everything else (SMS,
 * iMessage, web fallback) keeps the URL inline because it has no buttons.
 */
function rendersLoginAsButton(platform: OnboardingPlatform | undefined): boolean {
  return platform === "discord";
}

/**
 * Builds the login CTA, or null when the login URL cannot ride a link button
 * (non-https scheme - possible via ELIZA_ONBOARDING_APP_URL and friends, which
 * are read from env without scheme validation - or over Discord's 512-char
 * button URL cap). The caller chooses the reply copy from whether this
 * returned a CTA, so "text says tap below" and "button actually renders" are
 * the same decision and cannot disagree.
 */
function buildLoginCta(loginUrl: string): OnboardingChatCta | null {
  let parsed: URL;
  try {
    parsed = new URL(loginUrl);
  } catch {
    // error-policy:J3 Environment-derived login URLs are untrusted; malformed
    // values disable the button and preserve the inline-link reply variant.
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (loginUrl.length > MAX_CTA_URL_LENGTH) return null;
  return { label: ONBOARDING_CTA_LABEL, url: loginUrl };
}

function fallbackReply(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  handoffComplete: boolean;
  cta: OnboardingChatCta | null;
}): string {
  const name = hasPreferredName(args.session) ? args.session.name : undefined;
  if (!name) {
    return `hey, I'm Eliza. I can get you set up with your own agent. it chats right here, remembers everything you talk about, and your first ${ELIZA_APP_INITIAL_CREDIT_USD} is on me. what should I call you?`;
  }
  if (args.requiresLogin) {
    // "tap below" copy only when a CTA will actually render; otherwise the
    // URL stays inline (SMS/iMessage, or a button-capable platform whose
    // login URL could not become a valid button - see buildLoginCta).
    if (args.cta) {
      return `nice to meet you, ${name}. tap below to connect your account and I'll spin up your agent. your first ${ELIZA_APP_INITIAL_CREDIT_USD} is on me.`;
    }
    return `nice to meet you, ${name}. connect your account here and I'll spin up your agent, first ${ELIZA_APP_INITIAL_CREDIT_USD} on me: ${args.loginUrl}`;
  }
  if (args.handoffComplete) {
    return `you're in, ${name}. your agent is live and already knows everything from this chat. just keep talking here.`;
  }
  if (args.provisioning.status === "running") {
    return `almost there, ${name}. finishing setup now.`;
  }
  if (args.provisioning.status === "error") {
    // The row is still `error` at this instant — the retry only flips it once
    // the daemon claims the job — so this promises a retry, not progress, and
    // sends nobody to a dashboard that has no button to fix it.
    return `last attempt failed, ${name}. I've queued another one, nothing for you to do. keep chatting here.`;
  }
  if (args.provisioning.status === "insufficient_credits") {
    return `you're out of credits, ${name}. top up at ${onboardingAppPath("/dashboard/billing")} and I'll get your agent going.`;
  }
  return `on it, ${name}. your agent is spinning up now, takes a minute or two. keep chatting here in the meantime.`;
}

function sanitizeReplyText(reply: string): string {
  return reply
    .replaceAll("httpshttps://", "https://")
    .replaceAll("httphttp://", "http://")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "$1")
    .replace(/__([^_\n][\s\S]*?[^_\n])__/g, "$1")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .trim();
}

function generateOnboardingReply(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  handoffComplete: boolean;
  cta: OnboardingChatCta | null;
}): string {
  // This is a finite product state machine, not an open-ended generation task.
  // Deterministic copy prevents model latency, cost amplification, invented
  // billing claims, and non-repeatable responses on transport replay.
  return sanitizeReplyText(fallbackReply(args));
}

function transcriptText(session: OnboardingSession): string {
  const lines = session.history.map((message) => {
    const speaker = message.role === "user" ? "User" : "Eliza onboarding";
    return `${speaker}: ${message.content}`;
  });
  return [
    "Onboarding conversation transcript copied from Eliza Cloud.",
    session.name ? `User's preferred name: ${session.name}` : null,
    "",
    ...lines,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function copyTranscriptToManagedAgent(session: OnboardingSession): Promise<{
  session: OnboardingSession;
  launchUrl: string | null;
  copied: boolean;
}> {
  if (!session.userId || !session.organizationId || !session.agentId || session.handoffCopiedAt) {
    return {
      session,
      launchUrl: session.launchUrl ?? null,
      copied: !!session.handoffCopiedAt,
    };
  }

  try {
    const launch = await launchManagedElizaAgent({
      agentId: session.agentId,
      organizationId: session.organizationId,
      userId: session.userId,
    });

    const rememberResponse = await fetch(
      `${launch.connection.apiBase.replace(/\/+$/, "")}/api/memory/remember`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launch.connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: transcriptText(session),
          idempotencyKey: `onboarding-handoff:${session.id}`,
        }),
      },
    );

    if (!rememberResponse.ok) {
      // error-policy:J6 best-effort read of the error body to enrich the error
      // we throw next; a failed body read must not mask the non-ok status.
      const body = await rememberResponse.text().catch((error) => {
        logger.warn("[eliza-app onboarding] failed to read remember error body", {
          agentId: session.agentId,
          status: rememberResponse.status,
          error: error instanceof Error ? error.message : String(error),
        });
        return "";
      });
      throw new Error(`memory copy failed (${rememberResponse.status}) ${body.slice(0, 200)}`);
    }

    return {
      session: {
        ...session,
        launchUrl: launch.appUrl,
        handoffCopiedAt: nowIso(),
      },
      launchUrl: launch.appUrl,
      copied: true,
    };
  } catch (error) {
    // error-policy:J4 handoff copy is retried on every turn until it lands;
    // returning copied:false keeps handoffComplete false — a distinguishable
    // not-yet-copied state, never a fabricated success.
    logger.warn("[eliza-app onboarding] handoff memory copy failed", {
      agentId: session.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { session, launchUrl: session.launchUrl ?? null, copied: false };
  }
}

function controlPanelUrl(agentId?: string | null): string {
  return onboardingAppPath(agentId ? `/dashboard/agents/${agentId}` : "/dashboard/agents");
}

function newSession(id: string, input: OnboardingChatInput): OnboardingSession {
  const createdAt = nowIso();
  return {
    id,
    continuationToken: id.startsWith(PLATFORM_SESSION_PREFIX) ? crypto.randomUUID() : undefined,
    createdAt,
    updatedAt: createdAt,
    platform: input.platform,
    platformUserId: input.platformUserId,
    platformDisplayName: input.platformDisplayName,
    history: [],
  };
}

export interface OnboardingSessionStore {
  load(sessionId: string): Promise<OnboardingSession | null>;
  save(session: OnboardingSession): Promise<void>;
}

export async function runOnboardingChatWithStore(
  input: OnboardingChatInput,
  resolvedSessionId: string,
  store: OnboardingSessionStore,
): Promise<OnboardingChatResult> {
  let sessionId = resolvedSessionId;
  let session = await store.load(sessionId);

  // Browser account authentication is not proof that an arbitrary opaque ID
  // belongs to a bot-issued Telegram session. Strict redemption must resolve
  // an existing trusted session and match its signed Telegram identity before
  // any new session, account binding, or provisioning work can occur.
  assertTrustedTelegramContinuation(session, input);
  assertConfirmedDiscordContinuation(session, input);

  // An untrusted caller must never create a platform-scoped session. Opaque
  // browser credentials resolve to an existing platform session above.
  if (
    !session &&
    sessionId.startsWith(PLATFORM_SESSION_PREFIX) &&
    input.trustedPlatformIdentity !== true
  ) {
    logger.warn(
      "[eliza-app onboarding] refused to create platform-scoped session for untrusted caller",
      { sessionId: redactSessionIdForLog(sessionId) },
    );
    sessionId = crypto.randomUUID();
  }

  session = session ?? newSession(sessionId, input);
  if (session.id.startsWith(PLATFORM_SESSION_PREFIX) && !session.continuationToken) {
    session = { ...session, continuationToken: crypto.randomUUID() };
  }

  // A session already bound to one cloud account never carries over to a
  // different authenticated account: the second account gets a fresh session
  // instead of the first account's transcript, name, and phone identity.
  if (
    input.authenticatedUser &&
    session.userId &&
    session.userId !== input.authenticatedUser.userId
  ) {
    logger.warn(
      "[eliza-app onboarding] session bound to a different user; starting fresh session",
      {
        sessionId: redactSessionIdForLog(session.id),
        boundUserId: session.userId,
        callerUserId: input.authenticatedUser.userId,
      },
    );
    session = newSession(crypto.randomUUID(), input);
  }

  // Platform identity fields are first-write-wins: a platform-scoped session
  // is permanently tied to the messaging identity in its id, and later turns
  // (for example the authenticated web continuation sending platform "web")
  // must not mutate it.
  session = {
    ...session,
    platform: session.platform ?? input.platform,
    platformUserId: session.platformUserId ?? input.platformUserId,
    platformDisplayName: input.platformDisplayName ?? session.platformDisplayName,
    updatedAt: nowIso(),
  };

  if (input.trustedPlatformIdentity === true && session.platform && session.platformUserId) {
    session = { ...session, platformIdentityTrusted: true };
  }

  const wasUnboundBeforeThisTurn = !session.userId;
  if (input.authenticatedUser) {
    assertAuthenticatedTelegramIdentity(session, input);
    session = {
      ...session,
      userId: input.authenticatedUser.userId,
      organizationId: input.authenticatedUser.organizationId,
    };
  }

  session = await maybeLinkAuthenticatedPlatformIdentity(session, input);

  // The exact moment a trusted Discord DM session becomes account-bound from
  // a BROWSER turn (not the DM transport itself) is the user completing the
  // sign-in handoff. Their Discord chat is silent right now; RECORD the
  // one-shot proactive greeting for the gateway to deliver there. The
  // greeting is only recorded on the result here — the caller that owns the
  // turn's durable commit enqueues it AFTER the commit lands, so a turn that
  // fails mid-flight (for example a provisioning outage below) never DMs
  // "you're all set" for a sign-in that did not durably complete.
  // Bot-transport turns (trustedPlatformIdentity) are excluded: on those the
  // user just messaged and gets a synchronous reply. Enqueue is keyed by
  // session id (set semantics) so retried or replayed authenticated turns
  // cannot duplicate the greeting.
  const proactiveGreeting: ProactiveGreetingRequest | null =
    wasUnboundBeforeThisTurn &&
    session.userId &&
    input.authenticatedUser &&
    input.trustedPlatformIdentity !== true &&
    session.platform === "discord" &&
    session.platformIdentityTrusted === true &&
    session.platformUserId
      ? {
          sessionId: session.id,
          platformUserId: session.platformUserId,
          name: hasPreferredName(session) ? session.name : undefined,
        }
      : null;

  // statusOnly is a read-only poll: skip all user-message processing so it
  // can never mutate session history, name, or preferred-name state, even if
  // a caller accidentally includes a message field.
  const userMessage = input.statusOnly
    ? undefined
    : input.message?.trim().slice(0, MAX_MESSAGE_LENGTH);
  let preferredNameProvidedThisTurn = false;
  if (userMessage) {
    session = appendMessage(session, "user", userMessage);
    const explicitName = inferExplicitName(userMessage);
    const inferredName =
      explicitName ??
      inferBareName(userMessage) ??
      sanitizePreferredName(input.platformDisplayName);
    const mayCapture =
      Boolean(explicitName) || !session.name || isPlaceholderPhoneName(session.name);
    if (inferredName && mayCapture && inferredName !== session.name) {
      session.name = inferredName;
      preferredNameProvidedThisTurn = true;
    }
  }

  const requiresLogin = !session.userId || !session.organizationId;
  const preferredNameCaptured =
    hasPreferredName(session) &&
    (!isPhoneLikePlatformIdentity(input) ||
      preferredNameProvidedThisTurn ||
      Boolean(input.authenticatedUser));
  let provisioning: ElizaAppProvisioningStatus = {
    status: "none",
    agentId: null,
    bridgeUrl: null,
    sandbox: null,
  };

  if (!requiresLogin && session.userId && session.organizationId) {
    provisioning = preferredNameCaptured
      ? await ensureElizaAppProvisioning({
          userId: session.userId,
          organizationId: session.organizationId,
        })
      : await getElizaAppProvisioningStatus(session.organizationId);
    session.agentId = provisioning.agentId ?? session.agentId;
  }

  let launchUrl = session.launchUrl ?? null;
  let handoffComplete = !!session.handoffCopiedAt;
  if (provisioning.status === "running" && session.agentId && !handoffComplete) {
    const copied = await copyTranscriptToManagedAgent(session);
    session = copied.session;
    launchUrl = copied.launchUrl;
    handoffComplete = copied.copied;
  }

  const loginParams = new URLSearchParams({
    onboardingSession: session.continuationToken ?? session.id,
  });
  if (session.platform === "telegram") {
    loginParams.set("method", "telegram");
    loginParams.set("link", "true");
  }
  const loginUrl = onboardingLoginAppPath(`/get-started/?${loginParams.toString()}`);
  const panelUrl = controlPanelUrl(session.agentId);
  // The CTA is derived FIRST and the copy chosen from whether it exists, so
  // "tap below" text without a button is unrepresentable: the button CTA is
  // present exactly when the reply is the login handoff on a button-capable
  // platform AND the login URL is button-eligible (https, within Discord's
  // URL bound). The text omits the URL only when the CTA carries it.
  const cta =
    requiresLogin && hasPreferredName(session) && rendersLoginAsButton(session.platform)
      ? buildLoginCta(loginUrl)
      : null;
  // A turn with no user message produces a proactive welcome only the FIRST
  // time — the initial mount/poll that has no user content yet. Every
  // subsequent message-less turn (status-only polls every 5 s, continuation
  // polls) returns the current provisioning state and a deterministic reply
  // but leaves session.history untouched. Without this guard the durable
  // transcript grows one assistant-only entry per poll; those duplicates are
  // then returned to the UI and copied into managed-agent memory.
  //
  // The explicit statusOnly flag (sent by browser polling) is belt-and-
  // suspenders: even if a poll arrives against a fresh session, statusOnly
  // suppresses the welcome append — the initial mount POST already produced it.
  const isFirstWelcome = !userMessage && session.history.length === 0 && !input.statusOnly;
  const shouldAppendReply = userMessage || isFirstWelcome;
  const reply = generateOnboardingReply({
    session,
    provisioning,
    requiresLogin,
    loginUrl,
    handoffComplete,
    cta,
  });

  if (shouldAppendReply) {
    session = appendMessage(session, "assistant", reply);
  }
  await store.save(session);

  return {
    session,
    reply,
    requiresLogin,
    loginUrl,
    controlPanelUrl: panelUrl,
    launchUrl,
    provisioning,
    handoffComplete,
    cta,
    proactiveGreeting,
  };
}

/**
 * Enqueues the turn's recorded proactive greeting (if any) and strips the
 * commit-ordering field from the result. Called by the turn's durable-commit
 * owner strictly AFTER persistence succeeds — never before — so a failed turn
 * cannot produce a false-success DM. Enqueue itself remains best-effort.
 */
export async function deliverCommittedProactiveGreeting(
  result: OnboardingChatResult,
): Promise<OnboardingChatResult> {
  const { proactiveGreeting, ...committed } = result;
  if (proactiveGreeting) {
    await enqueueDiscordProactiveGreeting(proactiveGreeting);
  }
  return committed;
}

const localQueues = new Map<string, Promise<void>>();

async function serializeLocal<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = localQueues.get(sessionId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  localQueues.set(sessionId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localQueues.get(sessionId) === queued) {
      localQueues.delete(sessionId);
    }
  }
}

function onboardingCoordinator(): RuntimeDurableObjectNamespace | undefined {
  return getCloudBinding<RuntimeDurableObjectNamespace>("ONBOARDING_SESSIONS");
}

async function readCoordinatorResult(response: Response): Promise<OnboardingChatResult> {
  if (!response.ok) {
    throw new Error(`onboarding session coordinator failed (${response.status})`);
  }
  return (await response.json()) as OnboardingChatResult;
}

async function runViaCoordinator(
  stub: RuntimeDurableObjectStub,
  input: OnboardingChatInput,
  sessionId: string,
): Promise<OnboardingChatResult> {
  return readCoordinatorResult(
    await stub.fetch("https://onboarding.internal/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, sessionId }),
    }),
  );
}

export async function runOnboardingChat(input: OnboardingChatInput): Promise<OnboardingChatResult> {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey && idempotencyKey.length > 256) {
    throw new Error("Onboarding idempotency key exceeds 256 characters");
  }
  const normalizedInput = {
    ...input,
    idempotencyKey: idempotencyKey || undefined,
  };
  const sessionId = await resolveSessionId(normalizedInput);
  const coordinator = onboardingCoordinator();
  if (coordinator) {
    return runViaCoordinator(coordinator.getByName(sessionId), normalizedInput, sessionId);
  }
  if (hasCloudBindingsContext()) {
    throw new Error("ONBOARDING_SESSIONS binding is required in Worker deployments");
  }

  return serializeLocal(sessionId, async () => {
    if (normalizedInput.continuationMode === "trusted-telegram") {
      assertTrustedTelegramContinuation(
        await loadCachedOnboardingSession(sessionId),
        normalizedInput,
      );
    }
    if (normalizedInput.idempotencyKey) {
      const replay = await cache.get<OnboardingChatResult>(
        resultCacheKey(sessionId, normalizedInput.idempotencyKey, normalizedInput),
      );
      if (replay) return replay;
    }
    // In the local path the store's save IS the durable commit, so once
    // runOnboardingChatWithStore returns the session has persisted and the
    // recorded greeting may enqueue (commit ordering: greeting only after a
    // durably committed turn).
    const result = await deliverCommittedProactiveGreeting(
      await runOnboardingChatWithStore(normalizedInput, sessionId, {
        load: loadCachedOnboardingSession,
        save: mirrorOnboardingSessionToCache,
      }),
    );
    if (normalizedInput.idempotencyKey) {
      await cache.set(
        resultCacheKey(sessionId, normalizedInput.idempotencyKey, normalizedInput),
        result,
        SESSION_TTL_SECONDS,
      );
    }
    return result;
  });
}
