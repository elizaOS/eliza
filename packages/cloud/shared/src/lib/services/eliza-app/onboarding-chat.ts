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
  /** Stable transport delivery id. Replays return the original result. */
  idempotencyKey?: string;
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
const ELIZA_APP_INITIAL_CREDIT_USD = "$5";
/** Label for platforms that render the login link as a UI affordance. */
const ONBOARDING_CTA_LABEL = "Connect";

function sessionCacheKey(sessionId: string): string {
  return `eliza-app:onboarding:${sessionId}`;
}

function continuationCacheKey(token: string): string {
  return `eliza-app:onboarding-continuation:${token}`;
}

function resultCacheKey(sessionId: string, idempotencyKey: string): string {
  return `eliza-app:onboarding-result:${sessionId}:${idempotencyKey}`;
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
  if (trimmed && SESSION_ID_PATTERN.test(trimmed)) {
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

async function resolveSessionId(input: OnboardingChatInput): Promise<string> {
  const sessionId = sanitizeSessionId(input.sessionId, input);
  if (
    input.authenticatedUser &&
    input.trustedPlatformIdentity !== true &&
    input.sessionId?.trim() === sessionId
  ) {
    const coordinator = onboardingCoordinator();
    if (coordinator) {
      const response = await coordinator
        .getByName(sessionId)
        .fetch("https://onboarding.internal/resolve", { method: "POST" });
      if (response.ok) {
        const resolved: unknown = await response.json();
        if (isOnboardingContinuation(resolved)) {
          return resolved.sessionId;
        }
      }
    }
    const continuation = await cache.get<unknown>(continuationCacheKey(sessionId));
    if (isOnboardingContinuation(continuation)) {
      return continuation.sessionId;
    }
  }
  return sessionId;
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
  // Phone linking requires a platform identity attested by a trusted
  // transport — either this turn or a previous gateway turn on the session.
  // An authenticated web caller claiming an arbitrary phone number in the
  // request body must never bind that phone to their account.
  const platformIdentityTrusted =
    input.trustedPlatformIdentity === true || session.platformIdentityTrusted === true;
  if (
    !input.authenticatedUser ||
    !platformIdentityTrusted ||
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
  if (
    !input.authenticatedUser ||
    input.trustedPlatformIdentity === true ||
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

/**
 * Platforms whose transports render the login handoff as a link button. The
 * reply text on these platforms drops the raw URL; everything else (SMS,
 * iMessage, web fallback) keeps the URL inline because it has no buttons.
 */
function rendersLoginAsButton(platform: OnboardingPlatform | undefined): boolean {
  return platform === "discord";
}

function fallbackReply(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  handoffComplete: boolean;
}): string {
  const name = hasPreferredName(args.session) ? args.session.name : undefined;
  if (!name) {
    return `hey, I'm Eliza. I can get you set up with your own agent. it chats right here, remembers everything you talk about, and your first ${ELIZA_APP_INITIAL_CREDIT_USD} is on me. what should I call you?`;
  }
  if (args.requiresLogin) {
    if (rendersLoginAsButton(args.session.platform)) {
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
    return `hit a snag on my end, ${name}. your dashboard has the details and the team is on it.`;
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

  if (input.authenticatedUser) {
    assertAuthenticatedTelegramIdentity(session, input);
    session = {
      ...session,
      userId: input.authenticatedUser.userId,
      organizationId: input.authenticatedUser.organizationId,
    };
  }

  session = await maybeLinkAuthenticatedPlatformIdentity(session, input);

  const userMessage = input.message?.trim().slice(0, MAX_MESSAGE_LENGTH);
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
  const loginUrl = onboardingAppPath(`/get-started/?${loginParams.toString()}`);
  const panelUrl = controlPanelUrl(session.agentId);
  const reply = generateOnboardingReply({
    session,
    provisioning,
    requiresLogin,
    loginUrl,
    handoffComplete,
  });

  session = appendMessage(session, "assistant", reply);
  await store.save(session);

  // The button CTA exists exactly when the reply is the login handoff on a
  // button-capable platform: the text omits the URL, so the CTA must carry it.
  const cta =
    requiresLogin && hasPreferredName(session) && rendersLoginAsButton(session.platform)
      ? { label: ONBOARDING_CTA_LABEL, url: loginUrl }
      : null;

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
  };
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
    if (normalizedInput.idempotencyKey) {
      const replay = await cache.get<OnboardingChatResult>(
        resultCacheKey(sessionId, normalizedInput.idempotencyKey),
      );
      if (replay) return replay;
    }
    const result = await runOnboardingChatWithStore(normalizedInput, sessionId, {
      load: loadCachedOnboardingSession,
      save: mirrorOnboardingSessionToCache,
    });
    if (normalizedInput.idempotencyKey) {
      await cache.set(
        resultCacheKey(sessionId, normalizedInput.idempotencyKey),
        result,
        SESSION_TTL_SECONDS,
      );
    }
    return result;
  });
}
