import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { cache } from "../../cache/client";
import { CEREBRAS_DEFAULT_TEXT_MODEL } from "../../models";
import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
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
  role: OnboardingChatRole;
  content: string;
  createdAt: string;
}

export interface OnboardingSession {
  id: string;
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
  } | null;
  trustedPlatformIdentity?: boolean;
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
}

const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_HISTORY_MESSAGES = 200;
/**
 * Hard byte bound on a stored user message. The public route already caps
 * message length, but gateway services call runOnboardingChat directly with
 * raw connector payloads, so the session store enforces its own bound.
 */
const MAX_MESSAGE_LENGTH = 4000;
const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL = CEREBRAS_DEFAULT_TEXT_MODEL;
const DEFAULT_ONBOARDING_APP_URL = "https://app.elizacloud.ai";
const ELIZA_APP_INITIAL_CREDIT_USD = "$5";
const ELIZA_APP_PRICING_SUMMARY =
  "Eliza Cloud is usage-based: your agent runs in a private cloud container and spends credits only as it works.";

function sessionCacheKey(sessionId: string): string {
  return `eliza-app:onboarding:${sessionId}`;
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
 * derived from messaging identities (usually phone numbers), so they are
 * guessable. Only two callers may present one:
 * - a trusted transport (internal gateway auth, `trustedPlatformIdentity`);
 * - an authenticated user continuing a session from their login link.
 * Anonymous callers with a malformed or platform-scoped id get a fresh
 * random session instead, so a forged id can never read or mutate another
 * user's onboarding state.
 */
function sanitizeSessionId(value: string | undefined, input: OnboardingChatInput): string {
  const trimmed = value?.trim();
  if (trimmed && SESSION_ID_PATTERN.test(trimmed)) {
    if (!trimmed.startsWith(PLATFORM_SESSION_PREFIX)) {
      return trimmed;
    }
    if (input.trustedPlatformIdentity === true || input.authenticatedUser) {
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

async function loadSession(sessionId: string): Promise<OnboardingSession | null> {
  return cache.get<OnboardingSession>(sessionCacheKey(sessionId));
}

async function saveSession(session: OnboardingSession): Promise<void> {
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
    history: trimHistory([...session.history, { role, content: message, createdAt: nowIso() }]),
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

  try {
    await elizaAppUserService.linkPhoneToUser(input.authenticatedUser.userId, phoneNumber);
  } catch (error) {
    logger.warn("[eliza-app onboarding] phone link after login failed", {
      userId: input.authenticatedUser.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return session;
}

function getCerebrasClient(): ReturnType<typeof createOpenAI> | null {
  const env = getCloudAwareEnv();
  if (!env.CEREBRAS_API_KEY) return null;
  return createOpenAI({
    apiKey: env.CEREBRAS_API_KEY,
    baseURL: CEREBRAS_BASE_URL,
  });
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

function fallbackReply(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  handoffComplete: boolean;
}): string {
  const name = hasPreferredName(args.session) ? args.session.name : undefined;
  if (!name) {
    return `Hey, I'm Eliza. I set up private Eliza Cloud agents that can text, remember context, and work for you. ${ELIZA_APP_PRICING_SUMMARY} New users get ${ELIZA_APP_INITIAL_CREDIT_USD} free credit to try it. What should I call you?`;
  }
  if (args.requiresLogin) {
    return `Nice to meet you, ${name}. I can set up your private Eliza Cloud agent next. ${ELIZA_APP_PRICING_SUMMARY} When you connect, you get ${ELIZA_APP_INITIAL_CREDIT_USD} free credit to try it. Connect Eliza Cloud here: ${args.loginUrl}`;
  }
  if (args.handoffComplete) {
    return `You're live, ${name}. Your private agent is running, and I copied this onboarding chat into its memory so you can continue with context. Your ${ELIZA_APP_INITIAL_CREDIT_USD} starter credit is on your account.`;
  }
  if (args.provisioning.status === "running") {
    return `Your container is running, ${name}. I'm finishing the handoff now.`;
  }
  if (args.provisioning.status === "error") {
    return `I hit a provisioning issue, ${name}. Your control panel has the latest status, and the team can inspect it there.`;
  }
  if (args.provisioning.status === "insufficient_credits") {
    return `You're out of credits, ${name}. ${ELIZA_APP_PRICING_SUMMARY} Add credits at ${onboardingAppPath("/dashboard/billing")} and I'll start your private agent.`;
  }
  return `Good, ${name}. Your private Eliza container is provisioning now. Keep chatting here while it starts up.`;
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

function mentionsStarterCredit(text: string): boolean {
  return /\$5\b[\s\S]{0,80}\bfree\b[\s\S]{0,80}\bcredits?\b/i.test(text);
}

function ensureExactLoginUrl(reply: string, loginUrl: string): string {
  const sanitized = sanitizeReplyText(reply);

  let withoutGeneratedUrls = sanitized
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*[*_`~]+\s*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (!mentionsStarterCredit(withoutGeneratedUrls)) {
    withoutGeneratedUrls = `${withoutGeneratedUrls ? `${withoutGeneratedUrls}\n\n` : ""}You get ${ELIZA_APP_INITIAL_CREDIT_USD} free credit to try it.`;
  }
  return `${withoutGeneratedUrls ? `${withoutGeneratedUrls}\n\n` : ""}Connect Eliza Cloud here: ${loginUrl}`;
}

async function generateOnboardingReply(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  controlPanelUrl: string;
  launchUrl: string | null;
  handoffComplete: boolean;
  preferredNameCaptured: boolean;
}): Promise<string> {
  // Fallback replies go through the same ASCII/markdown sanitizer as
  // generated ones so the SMS-safety invariant holds on every reply path
  // (session names captured before sanitization could carry non-ASCII).
  if (!args.preferredNameCaptured) {
    return sanitizeReplyText(fallbackReply(args));
  }

  // Out-of-credits is a money-state reply: keep it deterministic (exact
  // billing link, no invented amounts) instead of letting the model
  // improvise billing copy.
  if (args.provisioning.status === "insufficient_credits") {
    return sanitizeReplyText(fallbackReply(args));
  }

  const client = getCerebrasClient();
  if (!client) return sanitizeReplyText(fallbackReply(args));

  try {
    const { text } = await generateText({
      model: client.chat(CEREBRAS_MODEL),
      system: `You are the Eliza Cloud onboarding agent. Keep onboarding smooth and conversational.

Goals:
- Learn the user's preferred name.
- Briefly explain the product: a private Eliza Cloud agent in its own cloud container that can text, remember context, and work for the user.
- Briefly explain pricing: usage-based cloud credits; new users get ${ELIZA_APP_INITIAL_CREDIT_USD} free credit to try it.
- If the user's preferred name is unknown, ask what to call them and do not claim their container is provisioning or running yet.
- If not logged in, ask them to connect Eliza Cloud and give this private link: ${args.loginUrl}
- If logged in, explain that their personal Eliza container is provisioning and their starter credit is available.
- If running, announce the container is running and that the onboarding conversation was copied into agent memory.
- Keep responses short, warm, and direct.

State:
- Known name: ${args.session.name ?? "unknown"}
- Preferred name captured: ${args.preferredNameCaptured ? "yes" : "no"}
- Logged in: ${args.requiresLogin ? "no" : "yes"}
- Container status: ${args.provisioning.status}
- Control panel: ${args.controlPanelUrl}
- Agent launch URL: ${args.launchUrl ?? "not ready"}`,
      messages: args.session.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });
    const sanitized = sanitizeReplyText(text);
    if (!sanitized) return fallbackReply(args);
    return args.requiresLogin ? ensureExactLoginUrl(sanitized, args.loginUrl) : sanitized;
  } catch (error) {
    logger.warn("[eliza-app onboarding] generation failed; using fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return sanitizeReplyText(fallbackReply(args));
  }
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
        body: JSON.stringify({ text: transcriptText(session) }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!rememberResponse.ok) {
      const body = await rememberResponse.text().catch(() => "");
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
    createdAt,
    updatedAt: createdAt,
    platform: input.platform,
    platformUserId: input.platformUserId,
    platformDisplayName: input.platformDisplayName,
    history: [],
  };
}

export async function runOnboardingChat(input: OnboardingChatInput): Promise<OnboardingChatResult> {
  let sessionId = sanitizeSessionId(input.sessionId, input);
  let session = await loadSession(sessionId);

  // Authenticated web callers may CONTINUE a platform-scoped session (they
  // carry its id from a login link the gateway texted out), but they may not
  // CREATE one — that would let any signed-in user pre-bind a messaging
  // identity they do not own.
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

  const loginUrl = onboardingAppPath(
    `/get-started/?onboardingSession=${encodeURIComponent(session.id)}`,
  );
  const panelUrl = controlPanelUrl(session.agentId);
  const reply = await generateOnboardingReply({
    session,
    provisioning,
    requiresLogin,
    loginUrl,
    controlPanelUrl: panelUrl,
    launchUrl,
    handoffComplete,
    preferredNameCaptured,
  });

  session = appendMessage(session, "assistant", reply);
  await saveSession(session);

  return {
    session,
    reply,
    requiresLogin,
    loginUrl,
    controlPanelUrl: panelUrl,
    launchUrl,
    provisioning,
    handoffComplete,
  };
}
