import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { cache } from "@/lib/cache/client";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import {
  type ElizaAppProvisioningStatus,
  ensureElizaAppProvisioning,
  getElizaAppProvisioningStatus,
} from "@/lib/services/eliza-app/provisioning";
import { elizaAppUserService } from "@/lib/services/eliza-app/user-service";
import { launchManagedElizaAgent } from "@/lib/services/eliza-managed-launch";
import { logger } from "@/lib/utils/logger";

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
const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL = "gpt-oss-120b";
const DEFAULT_ONBOARDING_APP_URL = "https://app.elizacloud.ai";

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

function sanitizeSessionId(value: string | undefined, input: OnboardingChatInput): string {
  const trimmed = value?.trim();
  if (trimmed && /^[a-zA-Z0-9:_-]{8,160}$/.test(trimmed)) {
    return trimmed;
  }
  return createOnboardingSessionId(input);
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

function inferName(message: string): string | undefined {
  const patterns = [
    /\b(?:my name is|i am|i'm|call me)\s+([a-z][a-z .'-]{1,40})/i,
    /^\s*([A-Z][a-z]{1,30})(?:\s+[A-Z][a-z]{1,30})?\s*$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    const name = match?.[1]?.trim().replace(/[.!?]+$/, "");
    if (name && !/\b(hello|hi|hey|yo|thanks|thank you)\b/i.test(name)) {
      return name;
    }
  }
  return undefined;
}

function isPhoneLikePlatform(input: OnboardingChatInput): boolean {
  return (
    input.trustedPlatformIdentity === true &&
    (input.platform === "blooio" || input.platform === "twilio") &&
    /^\+?[1-9]\d{7,15}$/.test(input.platformUserId ?? "")
  );
}

async function maybeBindTrustedPlatformIdentity(
  session: OnboardingSession,
  input: OnboardingChatInput,
): Promise<OnboardingSession> {
  if (session.userId || !isPhoneLikePlatform(input) || !input.platformUserId) {
    return session;
  }

  const result = await elizaAppUserService.findOrCreateByPhone(input.platformUserId);
  return {
    ...session,
    userId: result.user.id,
    organizationId: result.organization.id,
    name: session.name ?? result.user.name ?? input.platformDisplayName,
  };
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

function buildSystemPrompt(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  controlPanelUrl: string;
  launchUrl: string | null;
}): string {
  return `You are the Eliza Cloud onboarding agent. Keep the onboarding smooth and conversational.

Primary goals:
- Learn the user's preferred name.
- If they are not logged in, ask them to connect or log into Eliza Cloud and give them the private link: ${args.loginUrl}
- If they are logged in, explain that their personal Eliza container is being provisioned.
- If the container is running, announce that it is running and that the conversation has been copied into their agent memory.
- Keep responses short, warm, and direct.

Current state:
- Known name: ${args.session.name ?? "unknown"}
- Logged in: ${args.requiresLogin ? "no" : "yes"}
- Container status: ${args.provisioning.status}
- Control panel: ${args.controlPanelUrl}
- Agent launch URL: ${args.launchUrl ?? "not ready"}`;
}

function fallbackReply(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  launchUrl: string | null;
  handoffComplete: boolean;
}): string {
  const name = args.session.name;
  if (!name) {
    return "Hey, I'm Eliza. What should I call you?";
  }
  if (args.requiresLogin) {
    return `Nice to meet you, ${name}. I can set up your private Eliza Cloud agent next. Connect Eliza Cloud here: ${args.loginUrl}`;
  }
  if (args.handoffComplete) {
    return `You're live, ${name}. Your container is running, and I copied this onboarding chat into your agent memory so we can continue with context.`;
  }
  if (args.provisioning.status === "running") {
    return `Your container is running, ${name}. I'm finishing the handoff now.`;
  }
  if (args.provisioning.status === "error") {
    return `I hit a provisioning issue, ${name}. Your control panel has the latest status, and the team can inspect it there.`;
  }
  return `Good, ${name}. Your private Eliza container is provisioning now. Keep chatting here while it starts up.`;
}

async function generateOnboardingReply(args: {
  session: OnboardingSession;
  provisioning: ElizaAppProvisioningStatus;
  requiresLogin: boolean;
  loginUrl: string;
  controlPanelUrl: string;
  launchUrl: string | null;
  handoffComplete: boolean;
}): Promise<string> {
  const client = getCerebrasClient();
  if (!client) {
    return fallbackReply(args);
  }

  try {
    const { text } = await generateText({
      model: client.chat(CEREBRAS_MODEL),
      system: buildSystemPrompt(args),
      messages: args.session.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });
    return text.trim() || fallbackReply(args);
  } catch (error) {
    logger.warn("[eliza-app onboarding] generation failed; using fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackReply(args);
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

async function copyTranscriptToManagedAgent(
  session: OnboardingSession,
): Promise<{ session: OnboardingSession; launchUrl: string | null; copied: boolean }> {
  if (!session.userId || !session.organizationId || !session.agentId || session.handoffCopiedAt) {
    return { session, launchUrl: session.launchUrl ?? null, copied: !!session.handoffCopiedAt };
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
  return onboardingAppPath(
    agentId ? `/dashboard/containers/agents/${agentId}` : "/dashboard/containers",
  );
}

export async function runOnboardingChat(input: OnboardingChatInput): Promise<OnboardingChatResult> {
  const sessionId = sanitizeSessionId(input.sessionId, input);
  const createdAt = nowIso();
  let session = (await loadSession(sessionId)) ?? {
    id: sessionId,
    createdAt,
    updatedAt: createdAt,
    platform: input.platform,
    platformUserId: input.platformUserId,
    platformDisplayName: input.platformDisplayName,
    history: [],
  };

  session = {
    ...session,
    platform: input.platform ?? session.platform,
    platformUserId: input.platformUserId ?? session.platformUserId,
    platformDisplayName: input.platformDisplayName ?? session.platformDisplayName,
    updatedAt: nowIso(),
  };

  if (input.authenticatedUser) {
    session = {
      ...session,
      userId: input.authenticatedUser.userId,
      organizationId: input.authenticatedUser.organizationId,
    };
  }

  session = await maybeBindTrustedPlatformIdentity(session, input);

  const userMessage = input.message?.trim();
  if (userMessage) {
    session = appendMessage(session, "user", userMessage);
    session.name = session.name ?? inferName(userMessage) ?? input.platformDisplayName;
  }

  const requiresLogin = !session.userId || !session.organizationId;
  let provisioning: ElizaAppProvisioningStatus = {
    status: "none",
    agentId: null,
    bridgeUrl: null,
    sandbox: null,
  };

  if (!requiresLogin && session.userId && session.organizationId) {
    provisioning = userMessage
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
    `/get-started?onboardingSession=${encodeURIComponent(session.id)}`,
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
