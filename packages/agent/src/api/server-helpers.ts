/**
 * General-purpose helper functions extracted from server.ts.
 *
 * Utility functions for plugin services, UUID validation, state persistence,
 * onboarding, config, and package root resolution.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import {
  type AgentRuntime,
  type ChannelType,
  type Content,
  ContentType,
  createMessageMemory,
  logger,
  type Media,
  sendJsonError,
  type UUID,
} from "@elizaos/core";
import {
  normalizeCharacterLanguage,
  normalizeOnboardingProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
  resolveStylePresetByName,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { resolveStateDir } from "../config/paths.ts";
import {
  type AgentEventServiceLike,
  getAgentEventService,
} from "../runtime/agent-event-service.ts";
import {
  type CoreManagerLike,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.ts";
import { maybeAugmentChatMessageWithDocuments as augmentChatMessageWithDocuments } from "./chat-augmentation.ts";
import { extractCompatTextContent } from "./compat-utils.ts";
import type { ChatAttachmentWithData, ServerState } from "./server-types.ts";
import { getWalletAddresses } from "./wallet.ts";
import {
  resolvePluginEvmLoaded,
  resolveWalletCapabilityStatus,
} from "./wallet-capability.ts";

// ---------------------------------------------------------------------------
// Service accessors
// ---------------------------------------------------------------------------

export function getAgentEventSvc(
  runtime: AgentRuntime | null,
): AgentEventServiceLike | null {
  return getAgentEventService(runtime);
}

export function requirePluginManager(
  runtime: AgentRuntime | null,
): PluginManagerLike {
  const service = runtime?.getService("plugin_manager");
  if (!isPluginManagerLike(service)) {
    throw new Error("Plugin manager service not found");
  }
  return service;
}

export function requireCoreManager(
  runtime: AgentRuntime | null,
): CoreManagerLike {
  const service = runtime?.getService("core_manager");
  if (!isCoreManagerLike(service)) {
    throw new Error("Core manager service not found");
  }
  return service;
}

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

export function isUuidLike(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

// ---------------------------------------------------------------------------
// Deleted conversations state management
// ---------------------------------------------------------------------------

const OG_FILENAME = ".og";
const DELETED_CONVERSATIONS_FILENAME = "deleted-conversations.v1.json";
const MAX_DELETED_CONVERSATION_IDS = 5000;

export interface DeletedConversationsStateFile {
  version: 1;
  updatedAt: string;
  ids: string[];
}

export function readDeletedConversationIdsFromState(): Set<string> {
  const filePath = path.join(resolveStateDir(), DELETED_CONVERSATIONS_FILENAME);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeletedConversationsStateFile>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    );
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to read deleted conversations state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

export function persistDeletedConversationIdsToState(ids: Set<string>): void {
  const dir = resolveStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const normalized = Array.from(ids)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(-MAX_DELETED_CONVERSATION_IDS);

  const filePath = path.join(dir, DELETED_CONVERSATIONS_FILENAME);
  const tmpFilePath = `${filePath}.${process.pid}.tmp`;
  const payload: DeletedConversationsStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ids: normalized,
  };

  fs.writeFileSync(tmpFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmpFilePath, filePath);
}

// ---------------------------------------------------------------------------
// OG code state management
// ---------------------------------------------------------------------------

export function readOGCodeFromState(): string | null {
  const filePath = path.join(resolveStateDir(), OG_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8").trim();
}

export function initializeOGCodeInState(): void {
  const dir = resolveStateDir();
  const filePath = path.join(dir, OG_FILENAME);
  if (fs.existsSync(filePath)) return;

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, crypto.randomUUID(), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata for a web-chat conversation. */
export interface ConversationMeta {
  id: string;
  title: string;
  roomId: UUID;
  metadata?: import("./server-types.ts").ConversationMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStartupDiagnostics {
  phase: string;
  attempt: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
}

// ---------------------------------------------------------------------------
// Onboarding & config helpers
// ---------------------------------------------------------------------------

export function hasPersistedOnboardingState(config: ElizaConfig): boolean {
  if (config.meta?.onboardingComplete === true) {
    return true;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = normalizeOnboardingProviderId(llmText?.backend);
  const remoteApiBase =
    llmText?.remoteApiBase?.trim() ?? deploymentTarget.remoteApiBase?.trim();
  const hasCompleteCanonicalRouting =
    (llmText?.transport === "direct" &&
      Boolean(backend && backend !== "elizacloud")) ||
    (llmText?.transport === "remote" && Boolean(remoteApiBase)) ||
    (llmText?.transport === "cloud-proxy" &&
      backend === "elizacloud" &&
      Boolean(llmText.smallModel?.trim() && llmText.largeModel?.trim())) ||
    (deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase?.trim()));

  if (hasCompleteCanonicalRouting) {
    return true;
  }

  const agents = config.agents;
  if (!agents) {
    return false;
  }

  if (Array.isArray(agents.list) && agents.list.length > 0) {
    return true;
  }

  return Boolean(
    agents.defaults?.workspace?.trim() ||
      agents.defaults?.adminEntityId?.trim(),
  );
}

const APP_OWNER_NAME_MAX_LENGTH = 60;

/** Resolve the app owner's display name from config, or fall back to "User". */
export function resolveAppUserName(config: ElizaConfig): string {
  const ownerName = (config.ui as Record<string, unknown> | undefined)
    ?.ownerName as string | undefined;
  const normalized = ownerName?.trim().slice(0, APP_OWNER_NAME_MAX_LENGTH);
  return normalized || "User";
}

export function patchTouchesProviderSelection(
  patch: Record<string, unknown>,
): boolean {
  if (
    Object.hasOwn(patch, "cloud") ||
    Object.hasOwn(patch, "env") ||
    Object.hasOwn(patch, "models")
  ) {
    return true;
  }

  const agents =
    patch.agents &&
    typeof patch.agents === "object" &&
    !Array.isArray(patch.agents)
      ? (patch.agents as Record<string, unknown>)
      : null;
  const defaults =
    agents?.defaults &&
    typeof agents.defaults === "object" &&
    !Array.isArray(agents.defaults)
      ? (agents.defaults as Record<string, unknown>)
      : null;
  if (!defaults) {
    return false;
  }

  return (
    Object.hasOwn(defaults, "subscriptionProvider") ||
    Object.hasOwn(defaults, "model")
  );
}

// ---------------------------------------------------------------------------
// Conversation greeting
// ---------------------------------------------------------------------------

export function resolveConversationGreetingText(
  runtime: AgentRuntime,
  lang: string,
  uiConfig?: ElizaConfig["ui"],
): string {
  const pickRandom = (values: string[] | undefined): string => {
    const choices = (values ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (choices.length === 0) {
      return "";
    }

    return choices[Math.floor(Math.random() * choices.length)] ?? "";
  };

  const normalizedLanguage = normalizeCharacterLanguage(lang);
  const characterName = runtime.character.name?.trim();
  const assistantName = uiConfig?.assistant?.name?.trim();

  // Prefer explicit UI selections over the loaded character card: users pick a
  // style in onboarding/roster (avatar + preset) while `runtime.character.name`
  // can still reflect the bundled preset name until save/restart.
  const preset =
    resolveStylePresetByAvatarIndex(
      uiConfig?.avatarIndex,
      normalizedLanguage,
    ) ??
    resolveStylePresetById(uiConfig?.presetId, normalizedLanguage) ??
    resolveStylePresetByName(assistantName, normalizedLanguage) ??
    resolveStylePresetByName(characterName, normalizedLanguage);

  const presetGreeting = pickRandom(preset?.postExamples);
  if (presetGreeting) {
    return presetGreeting;
  }

  return pickRandom(runtime.character.postExamples);
}

// ---------------------------------------------------------------------------
// Package root resolution (for reading bundled plugins.json)
// ---------------------------------------------------------------------------

export function findOwnPackageRoot(startDir: string): string {
  // Mobile bundles are single-file — there is no workspace tree to walk.
  // Return startDir immediately to avoid crossing the fs-shim sandbox boundary.
  if (process.env.ELIZA_MOBILE_PLATFORM) {
    return startDir;
  }
  const KNOWN_NAMES = new Set(["eliza", "eliza", "elizaos"]);
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<
          string,
          unknown
        >;
        const pkgName =
          typeof pkg.name === "string" ? pkg.name.toLowerCase() : "";
        if (KNOWN_NAMES.has(pkgName)) return dir;
        // Also match if plugins.json exists at this level (resilient to renames)
        if (fs.existsSync(path.join(dir, "plugins.json"))) return dir;
      } catch {
        /* keep searching */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export function getErrorMessage(
  err: unknown,
  fallback = "generation failed",
): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  sendJsonError(res, message, status);
}

export function decodePathComponent(
  raw: string,
  res: http.ServerResponse,
  fieldName: string,
): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    error(res, `Invalid ${fieldName}: malformed URL encoding`, 400);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Blocked-key helpers
// ---------------------------------------------------------------------------

function isBlockedObjectKey(key: string): boolean {
  return (
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype" ||
    key === "$include"
  );
}

export function hasBlockedObjectKeyDeep(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasBlockedObjectKeyDeep);
  if (typeof value !== "object") return false;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedObjectKey(key)) return true;
    if (hasBlockedObjectKeyDeep(child)) return true;
  }
  return false;
}

export function cloneWithoutBlockedObjectKeys<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => cloneWithoutBlockedObjectKeys(item)) as T;
  }
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedObjectKey(key)) continue;
    out[key] = cloneWithoutBlockedObjectKeys(child);
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Chat language augmentation (re-exported from chat-augmentation.ts)
// ---------------------------------------------------------------------------

export { maybeAugmentChatMessageWithLanguage } from "./chat-augmentation.ts";

// ---------------------------------------------------------------------------
// Chat image validation
// ---------------------------------------------------------------------------

interface ChatImageAttachment {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
}

const MAX_CHAT_IMAGES = 4;
const MAX_IMAGE_DATA_BYTES = 5 * 1_048_576;
const MAX_IMAGE_NAME_LENGTH = 255;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const IMAGE_ONLY_CHAT_FALLBACK_PROMPT =
  "Please describe the attached image.";

/** Returns an error message string, or null if valid. Exported for unit tests. */
export function validateChatImages(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  if (images.length > MAX_CHAT_IMAGES)
    return `Too many images (max ${MAX_CHAT_IMAGES})`;
  for (const img of images) {
    if (!img || typeof img !== "object") return "Each image must be an object";
    const { data, mimeType, name } = img as Record<string, unknown>;
    if (typeof data !== "string" || !data)
      return "Each image must have a non-empty data string";
    if (data.startsWith("data:"))
      return "Image data must be raw base64, not a data URL";
    if (data.length > MAX_IMAGE_DATA_BYTES)
      return `Image too large (max ${MAX_IMAGE_DATA_BYTES / 1_048_576} MB per image)`;
    if (!BASE64_RE.test(data))
      return "Image data contains invalid base64 characters";
    if (typeof mimeType !== "string" || !mimeType)
      return "Each image must have a mimeType string";
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase()))
      return `Unsupported image type: ${mimeType}`;
    if (typeof name !== "string" || !name)
      return "Each image must have a name string";
    if (name.length > MAX_IMAGE_NAME_LENGTH)
      return `Image name too long (max ${MAX_IMAGE_NAME_LENGTH} characters)`;
  }
  return null;
}

export function normalizeIncomingChatPrompt(
  text: string | null | undefined,
  images: ChatImageAttachment[] | null | undefined,
): string | null {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (normalizedText.length > 0) {
    return normalizedText;
  }
  return Array.isArray(images) && images.length > 0
    ? IMAGE_ONLY_CHAT_FALLBACK_PROMPT
    : null;
}

// ---------------------------------------------------------------------------
// Chat attachments
// ---------------------------------------------------------------------------

export function buildChatAttachments(
  images: ChatImageAttachment[] | undefined,
): {
  attachments: ChatAttachmentWithData[] | undefined;
  compactAttachments: Media[] | undefined;
} {
  if (!images?.length)
    return { attachments: undefined, compactAttachments: undefined };
  const attachments: ChatAttachmentWithData[] = images.map((img, i) => ({
    id: `img-${i}`,
    url: `attachment:img-${i}`,
    title: img.name,
    source: "client_chat",
    contentType: ContentType.IMAGE,
    _data: img.data,
    _mimeType: img.mimeType,
  }));
  const compactAttachments: Media[] = attachments.map(
    ({ _data: _d, _mimeType: _m, ...rest }) => rest,
  );
  return { attachments, compactAttachments };
}

type MessageMemory = ReturnType<typeof createMessageMemory>;

/**
 * Constructs the in-memory user message (with image data for action handlers)
 * and the persistence-safe counterpart (image data stripped).
 */
export function buildUserMessages(params: {
  images: ChatImageAttachment[] | undefined;
  prompt: string;
  userId: UUID;
  agentId: UUID;
  roomId: UUID;
  channelType: ChannelType;
  conversationMode?: "simple" | "power";
  messageSource?: string;
  metadata?: Record<string, unknown>;
}): { userMessage: MessageMemory; messageToStore: MessageMemory } {
  const {
    images,
    prompt,
    userId,
    agentId,
    roomId,
    channelType,
    conversationMode,
    messageSource,
    metadata,
  } = params;
  const source = messageSource?.trim() || "client_chat";
  const { attachments, compactAttachments } = buildChatAttachments(images);
  const id = crypto.randomUUID() as UUID;
  const userMessage = createMessageMemory({
    id,
    entityId: userId,
    agentId,
    roomId,
    content: {
      text: prompt,
      source,
      channelType,
      ...(conversationMode ? { conversationMode } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(metadata ? { metadata } : {}),
    } as Content & { text: string },
  });
  const messageToStore = compactAttachments?.length
    ? createMessageMemory({
        id,
        entityId: userId,
        agentId,
        roomId,
        content: {
          text: prompt,
          source,
          channelType,
          ...(conversationMode ? { conversationMode } : {}),
          attachments: compactAttachments,
          ...(metadata ? { metadata } : {}),
        } as Content & { text: string },
      })
    : userMessage;
  return { userMessage, messageToStore };
}

// ---------------------------------------------------------------------------
// Conversation room title persistence
// ---------------------------------------------------------------------------

type ConversationRoomTitleRef = Pick<
  ConversationMeta,
  "id" | "title" | "roomId"
>;

export async function persistConversationRoomTitle(
  runtime: Pick<AgentRuntime, "getRoom" | "adapter"> | null | undefined,
  conversation: ConversationRoomTitleRef,
): Promise<boolean> {
  if (!runtime) return false;
  const room = await runtime.getRoom(conversation.roomId);
  if (!room) return false;
  if (room.name === conversation.title) return false;

  const adapter = runtime.adapter as {
    updateRoom?: (nextRoom: typeof room) => Promise<void>;
  };
  if (typeof adapter.updateRoom !== "function") return false;

  await adapter.updateRoom({ ...room, name: conversation.title });
  return true;
}

// ---------------------------------------------------------------------------
// Wallet context augmentation
// ---------------------------------------------------------------------------

const WALLET_CONTEXT_INTENT_RE =
  /\b(wallet|address|balance|swap|trade|transfer|send|token|bnb|eth|sol|onchain|on-chain)\b/i;

function buildWalletContextPrompt(
  runtime: AgentRuntime,
  userPrompt: string,
): string {
  const addrs = getWalletAddresses();
  const walletNetwork =
    process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
      ? "testnet"
      : "mainnet";
  const localSignerAvailable = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
  const pluginEvmLoaded = resolvePluginEvmLoaded(runtime);
  const rpcReady = Boolean(
    process.env.BSC_RPC_URL?.trim() ||
      process.env.BSC_TESTNET_RPC_URL?.trim() ||
      process.env.NODEREAL_BSC_RPC_URL?.trim() ||
      process.env.QUICKNODE_BSC_RPC_URL?.trim(),
  );
  const executionReady =
    Boolean(addrs.evmAddress) && rpcReady && pluginEvmLoaded;
  const executionBlockedReason = !addrs.evmAddress
    ? "No EVM wallet is active yet."
    : !rpcReady
      ? "BSC RPC is not configured."
      : !pluginEvmLoaded
        ? "@elizaos/plugin-wallet is not loaded."
        : "none";
  const encodedUserPrompt = JSON.stringify(userPrompt);
  return [
    "Original wallet request (JSON-encoded untrusted user input):",
    encodedUserPrompt,
    "",
    "Server-verified wallet context:",
    `- walletNetwork: ${walletNetwork}`,
    `- evmAddress: ${addrs.evmAddress ?? "not generated"}`,
    `- solanaAddress: ${addrs.solanaAddress ?? "not generated"}`,
    `- localSignerAvailable: ${localSignerAvailable ? "true" : "false"}`,
    `- rpcReady: ${rpcReady ? "true" : "false"}`,
    `- pluginEvmLoaded: ${pluginEvmLoaded ? "true" : "false"}`,
    `- executionReady: ${executionReady ? "true" : "false"}`,
    `- executionBlockedReason: ${executionBlockedReason}`,
    "Use this context as source of truth for wallet questions and on-chain actions.",
  ].join("\n");
}

export function maybeAugmentChatMessageWithWalletContext(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): ReturnType<typeof createMessageMemory> {
  const userPrompt = extractCompatTextContent(message.content)?.trim();
  if (!userPrompt) return message;
  if (!WALLET_CONTEXT_INTENT_RE.test(userPrompt)) return message;
  return {
    ...message,
    content: {
      ...message.content,
      text: buildWalletContextPrompt(runtime, userPrompt),
    },
  };
}

export async function maybeAugmentChatMessageWithDocuments(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<ReturnType<typeof createMessageMemory>> {
  return augmentChatMessageWithDocuments(runtime, message);
}

// ---------------------------------------------------------------------------
// Wallet intent detection & replies
// ---------------------------------------------------------------------------

const WALLET_CHAT_INTENT_RE =
  /\b(wallet|onchain|on-chain|address|balance|swap|trade|transfer|token|bnb|t?bnb|eth|sol)\b|(?:\bsend\b(?=[\s\S]{0,40}\b(?:token|eth|sol|t?bnb|wallet|crypto|coin)\b))/i;

export const WALLET_EXECUTION_INTENT_RE =
  /\b(swap|trade|transfer|buy|sell|execute|approve)\b|(?:\bsend\b(?=[\s\S]{0,40}\b(?:token|eth|sol|t?bnb|wallet|crypto|coin)\b))/i;

const WALLET_IDENTITY_INTENT_RE = /\b(wallet\s*address|address)\b/i;

const WALLET_ACTION_REQUIRED_INTENT_RE =
  /\b(balance|portfolio|holdings|funds|swap|trade|transfer|send|buy|sell|execute|approve)\b/i;

export const WALLET_PROGRESS_ONLY_RE =
  /\b(let me|i(?:'| wi)ll|checking|fetching|looking up|pulling|one moment|just a second|hold on)\b[\s\S]{0,80}\b(check|look|fetch|pull|get|verify|see|review)\b/i;

export function isWalletActionRequiredIntent(prompt: string): boolean {
  return (
    WALLET_CHAT_INTENT_RE.test(prompt) &&
    !WALLET_IDENTITY_INTENT_RE.test(prompt) &&
    WALLET_ACTION_REQUIRED_INTENT_RE.test(prompt)
  );
}

export function buildWalletActionNotExecutedReply(
  runtime: AgentRuntime,
  userPrompt: string,
): string {
  const addrs = getWalletAddresses();
  const walletNetwork =
    process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
      ? "testnet"
      : "mainnet";
  const pluginEvmLoaded = resolvePluginEvmLoaded(runtime);
  const rpcReady = Boolean(
    process.env.BSC_RPC_URL?.trim() ||
      process.env.BSC_TESTNET_RPC_URL?.trim() ||
      process.env.NODEREAL_BSC_RPC_URL?.trim() ||
      process.env.QUICKNODE_BSC_RPC_URL?.trim(),
  );
  const executionBlockedReason = !addrs.evmAddress
    ? "No EVM wallet is active yet."
    : !rpcReady
      ? "BSC RPC is not configured."
      : !pluginEvmLoaded
        ? "@elizaos/plugin-wallet is not loaded, so EVM wallet execution is unavailable."
        : "A wallet action was not executed for this turn.";

  return [
    `I could not complete "${userPrompt}" because no wallet action actually ran.`,
    `Wallet network: ${walletNetwork}.`,
    `Detected wallets:`,
    `- EVM: ${addrs.evmAddress ?? "not generated"}`,
    `- Solana: ${addrs.solanaAddress ?? "not generated"}`,
    `@elizaos/plugin-wallet: ${pluginEvmLoaded ? "loaded" : "not loaded"}.`,
    `RPC ready: ${rpcReady ? "yes" : "no"}.`,
    `Blocked reason: ${executionBlockedReason}`,
  ].join("\n");
}

const WALLET_PROGRESS_PREFIX_RE =
  /^\s*(?:let me|i(?:'ll| will)|checking|fetching|looking up|pulling|one moment|just a second|hold on)[\s\S]{0,120}?(?:now|\.{3}|…)?\s*/i;

export function trimWalletProgressPrefix(text: string): string {
  const balanceIdx = text.indexOf("Wallet Balances:");
  if (balanceIdx > 0) {
    return text.slice(balanceIdx).trimStart();
  }

  const markers = [
    "Action: TRANSFER_TOKEN",
    "Action: EXECUTE_TRADE",
    "Transfer",
    "Swap",
    "Trade",
    "Tx hash:",
    "Transaction hash:",
  ];
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx <= 0) continue;
    const prefix = text.slice(0, idx);
    if (WALLET_PROGRESS_PREFIX_RE.test(prefix)) {
      return text.slice(idx).trimStart();
    }
  }
  return text;
}

export function resolveWalletModeGuidanceReply(
  state: Pick<ServerState, "config" | "runtime">,
  prompt: string,
): string | null {
  if (!WALLET_CHAT_INTENT_RE.test(prompt)) {
    return null;
  }

  const capability = resolveWalletCapabilityStatus(state);
  const {
    automationMode,
    evmAddress,
    solanaAddress,
    walletNetwork,
    pluginEvmLoaded,
    executionReady,
    executionBlockedReason,
  } = capability;
  const walletSummary = `Detected wallets:
- EVM: ${evmAddress ?? "not generated"}
- Solana: ${solanaAddress ?? "not generated"}`;

  if (automationMode === "connectors-only") {
    if (!WALLET_EXECUTION_INTENT_RE.test(prompt)) {
      return null;
    }
    return [
      "I am in connectors-only mode, so wallet actions are disabled in chat right now.",
      "Turn on full mode with one of these:",
      '1) Settings -> Permissions -> Agent Automation Mode -> "Full".',
      '2) API: PUT /api/permissions/automation-mode with {"mode":"full"}.',
      "Then retry your wallet request.",
      `Wallet network: ${walletNetwork}.`,
      walletSummary,
    ].join("\n");
  }

  if (
    !evmAddress &&
    !solanaAddress &&
    WALLET_EXECUTION_INTENT_RE.test(prompt)
  ) {
    return [
      "No wallet is active yet.",
      "Open the Wallet page to set up Steward (Eliza Cloud) or a local wallet.",
      walletSummary,
    ].join("\n");
  }

  if (WALLET_IDENTITY_INTENT_RE.test(prompt)) {
    return [
      `Wallet network: ${walletNetwork}.`,
      walletSummary,
      `@elizaos/plugin-wallet: ${pluginEvmLoaded ? "loaded" : "not loaded"}.`,
      `Execution readiness: ${executionReady ? "ready for wallet actions" : (executionBlockedReason ?? "blocked")}.`,
      `Automation mode: ${automationMode}.`,
    ].join("\n");
  }

  if (WALLET_EXECUTION_INTENT_RE.test(prompt) && !executionReady) {
    return [
      `Wallet execution is currently blocked: ${executionBlockedReason ?? "unknown reason"}`,
      `Wallet network: ${walletNetwork}.`,
      walletSummary,
      `@elizaos/plugin-wallet: ${pluginEvmLoaded ? "loaded" : "not loaded"}.`,
      `Automation mode: ${automationMode}.`,
    ].join("\n");
  }

  return null;
}
