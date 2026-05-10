/**
 * Chat message enhancement helpers extracted from server.ts.
 *
 * Functions for augmenting chat messages with language instructions,
 * document context, wallet context, image attachments, and user message building.
 */

import crypto from "node:crypto";

import {
  type AgentRuntime,
  type ChannelType,
  type Content,
  ContentType,
  createMessageMemory,
  type Media,
  ModelType,
  parseJSONObjectFromText,
  type UUID,
} from "@elizaos/core";
import { isCloudProvisionedContainer } from "@elizaos/plugin-elizacloud";
import { normalizeCharacterLanguage } from "@elizaos/shared";
import { detectRuntimeModel, resolveProviderFromModel } from "./agent-model.ts";
import { extractCompatTextContent } from "./compat-utils.ts";
import {
  type DocumentsServiceLike,
  getDocumentsService,
} from "./documents-service-loader.ts";
import { getWalletAddresses } from "./wallet.ts";
import { resolvePluginEvmLoaded } from "./wallet-capability.ts";

type DocumentMatch = Awaited<
  ReturnType<DocumentsServiceLike["searchDocuments"]>
>[number];
type DocumentMatches = DocumentMatch[];

// ---------------------------------------------------------------------------
// Language augmentation
// ---------------------------------------------------------------------------

const CHAT_LANGUAGE_INSTRUCTION: Record<string, string> = {
  en: "Reply in natural English unless the user explicitly requests another language.",
  "zh-CN":
    "Reply in natural Simplified Chinese unless the user explicitly requests another language.",
  ko: "Reply in natural Korean unless the user explicitly requests another language.",
  es: "Reply in natural Spanish unless the user explicitly requests another language.",
  pt: "Reply in natural Brazilian Portuguese unless the user explicitly requests another language.",
  vi: "Reply in natural Vietnamese unless the user explicitly requests another language.",
  tl: "Reply in natural Tagalog unless the user explicitly requests another language.",
};

export function maybeAugmentChatMessageWithLanguage(
  message: ReturnType<typeof createMessageMemory>,
  preferredLanguage?: string,
): ReturnType<typeof createMessageMemory> {
  if (!preferredLanguage) return message;
  const instruction =
    CHAT_LANGUAGE_INSTRUCTION[normalizeCharacterLanguage(preferredLanguage)];
  if (!instruction) return message;
  const originalText = extractCompatTextContent(message.content);
  if (!originalText) return message;

  return {
    ...message,
    content: {
      ...(message.content as Content),
      text: `${originalText}\n\n[Language instruction: ${instruction}]`,
    },
  };
}

// ---------------------------------------------------------------------------
// Error message helper
// ---------------------------------------------------------------------------

export function getErrorMessage(
  err: unknown,
  fallback = "generation failed",
): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

// ---------------------------------------------------------------------------
// Agent self-awareness augmentation
// ---------------------------------------------------------------------------

const AGENT_AWARENESS_INTENT_RE =
  /\b(model|provider|wallet|address|balance|swap|trade|transfer|send|token|bnb|eth|sol|onchain|on-chain|plugin|plugins|capabilit(?:y|ies)|cloud|credits|hosted|hosting|runtime|what are you running)\b/i;

const AGENT_AWARENESS_CLOUD_CREDITS_TIMEOUT_MS = 1_500;
const MAX_EXPOSED_PLUGIN_NAMES = 12;
const CHAT_DOCUMENTS_THRESHOLD = 0.2;
const CHAT_DOCUMENTS_LIMIT = 4;
const CHAT_DOCUMENTS_SNIPPET_MAX_CHARS = 700;
const CHAT_DOCUMENTS_RECOVERY_QUERY_LIMIT = 3;

interface CloudAuthAwarenessService {
  isAuthenticated?: () => boolean;
  getClient?: () => { get: <T>(path: string) => Promise<T> };
  getUserId?: () => string | undefined;
  getOrganizationId?: () => string | undefined;
}

function formatActivePluginList(runtime: AgentRuntime): string {
  const pluginNames = Array.isArray(runtime.plugins)
    ? runtime.plugins
        .map((plugin) =>
          typeof plugin?.name === "string" ? plugin.name.trim() : "",
        )
        .filter((name): name is string => name.length > 0)
    : [];

  if (pluginNames.length === 0) return "none";
  if (pluginNames.length <= MAX_EXPOSED_PLUGIN_NAMES) {
    return pluginNames.join(", ");
  }

  return `${pluginNames.slice(0, MAX_EXPOSED_PLUGIN_NAMES).join(", ")} (+${pluginNames.length - MAX_EXPOSED_PLUGIN_NAMES} more)`;
}

async function resolveCloudCreditsBalance(
  runtime: AgentRuntime,
): Promise<string> {
  const cloudAuth = runtime.getService?.("CLOUD_AUTH") as
    | CloudAuthAwarenessService
    | undefined;
  if (!cloudAuth?.isAuthenticated?.() || !cloudAuth.getClient) {
    return "unavailable";
  }

  try {
    const client = cloudAuth.getClient();
    const response = (await Promise.race([
      client.get<Record<string, unknown>>("/credits/balance"),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("cloud credits lookup timed out"));
        }, AGENT_AWARENESS_CLOUD_CREDITS_TIMEOUT_MS);
      }),
    ])) as Record<string, unknown>;

    const coerce = (value: unknown): number | null => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const parsed = Number.parseFloat(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    };
    // Eliza Cloud returns `balance` as `string | number` (per the bridge
    // client + types.eliza.ts type defs). Accept both shapes — string is
    // what the upstream returns when the value is held as a fixed-precision
    // decimal.
    const rawBalance =
      coerce(response.balance) ??
      coerce((response.data as Record<string, unknown> | undefined)?.balance);

    return typeof rawBalance === "number"
      ? rawBalance.toFixed(2)
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function buildAgentAwarenessContextPrompt(
  runtime: AgentRuntime,
  userPrompt: string,
): Promise<string> {
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
  const model = detectRuntimeModel(runtime) ?? "unknown";
  const provider = resolveProviderFromModel(model) ?? "unknown";
  const cloudHosted = isCloudProvisionedContainer();
  const cloudAuth = runtime.getService?.("CLOUD_AUTH") as
    | CloudAuthAwarenessService
    | undefined;
  const cloudConnected = cloudHosted || Boolean(cloudAuth?.isAuthenticated?.());
  const cloudCredits = cloudConnected
    ? await resolveCloudCreditsBalance(runtime)
    : "not connected";
  const encodedUserPrompt = JSON.stringify(userPrompt);

  return [
    "Original self-status request (JSON-encoded untrusted user input):",
    encodedUserPrompt,
    "",
    "Server-verified agent self-awareness:",
    `- model: ${model}`,
    `- provider: ${provider}`,
    `- cloudHosted: ${cloudHosted ? "true" : "false"}`,
    `- cloudConnected: ${cloudConnected ? "true" : "false"}`,
    `- cloudCredits: ${cloudCredits}`,
    `- activePlugins: ${formatActivePluginList(runtime)}`,
    `- walletNetwork: ${walletNetwork}`,
    `- evmAddress: ${addrs.evmAddress ?? "not generated"}`,
    `- solanaAddress: ${addrs.solanaAddress ?? "not generated"}`,
    `- localSignerAvailable: ${localSignerAvailable ? "true" : "false"}`,
    `- rpcReady: ${rpcReady ? "true" : "false"}`,
    `- pluginEvmLoaded: ${pluginEvmLoaded ? "true" : "false"}`,
    `- executionReady: ${executionReady ? "true" : "false"}`,
    `- executionBlockedReason: ${executionBlockedReason}`,
    "Use this context as source of truth when answering questions about your model, cloud status, plugins, wallets, or on-chain capabilities.",
  ].join("\n");
}

export async function maybeAugmentChatMessageWithAgentAwareness(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<ReturnType<typeof createMessageMemory>> {
  const userPrompt = extractCompatTextContent(message.content)?.trim();
  if (!userPrompt) return message;

  const shouldInject =
    AGENT_AWARENESS_INTENT_RE.test(userPrompt) || isCloudProvisionedContainer();
  if (!shouldInject) return message;

  return {
    ...message,
    content: {
      ...message.content,
      text: await buildAgentAwarenessContextPrompt(runtime, userPrompt),
    },
  };
}

export async function maybeAugmentChatMessageWithDocuments(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<ReturnType<typeof createMessageMemory>> {
  const userPrompt = extractCompatTextContent(message.content)?.trim();
  if (!userPrompt || !runtime.agentId) return message;

  const documents = await getDocumentsService(runtime);
  if (!documents.service) return message;

  const agentId = runtime.agentId as UUID;
  const roomId =
    typeof message.roomId === "string" && message.roomId.trim().length > 0
      ? (message.roomId as UUID)
      : agentId;
  const searchMessage = {
    ...message,
    id: crypto.randomUUID() as UUID,
    agentId,
    entityId:
      typeof message.entityId === "string" && message.entityId.length > 0
        ? message.entityId
        : agentId,
    roomId,
    content: {
      ...(message.content as Content),
      text: userPrompt,
    },
    createdAt: Date.now(),
  };

  const loadMatches = async (scopeRoomId: UUID, queryText: string) =>
    documents.service?.searchDocuments(
      {
        ...searchMessage,
        content: {
          ...(searchMessage.content as Content),
          text: queryText,
        },
      },
      { roomId: scopeRoomId },
    ) ?? [];

  const loadMatchesAcrossScopes = async (
    queryText: string,
  ): Promise<DocumentMatches> => {
    let matches = await loadMatches(roomId, queryText);
    if (matches.length === 0 && roomId !== agentId) {
      matches = await loadMatches(agentId, queryText);
    }
    return matches;
  };

  const selectRelevantMatches = (matches: DocumentMatches): DocumentMatches =>
    matches.filter((match) => {
      const text = match.content?.text?.trim();
      return (
        typeof text === "string" &&
        text.length > 0 &&
        (match.similarity ?? 0) >= CHAT_DOCUMENTS_THRESHOLD
      );
    });

  const recoverDocumentSearchQueriesWithLlm = async (): Promise<string[]> => {
    const prompt = [
      "Extract up to 3 short semantic-search queries for retrieving documents that answer the user's request.",
      "Return only JSON with this shape:",
      '  {"queries":["query one","query two"]}',
      "",
      "Rules:",
      "- Preserve named entities, topics, codewords, and filenames when present.",
      "- Remove meta instructions about reply format, such as 'answer with only the codeword'.",
      "- If the user refers to 'the uploaded file' or a prior document without naming it, focus the queries on the fact being requested, not the phrase 'uploaded file'.",
      "- Keep each query short and retrieval-oriented.",
      "",
      "Examples:",
      '  "what is the qa codeword from the uploaded file? answer with only the codeword" -> {"queries":["qa codeword","codeword"]}',
      '  "what is the deployment codeword? reply with only the codeword" -> {"queries":["deployment codeword","codeword"]}',
      '  "which document mentions denver?" -> {"queries":["denver"]}',
      "",
      `User request: ${JSON.stringify(userPrompt)}`,
    ].join("\n");

    try {
      const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      const raw = typeof result === "string" ? result : "";
      const parsed = parseJSONObjectFromText(raw) as Record<
        string,
        unknown
      > | null;
      if (!parsed) {
        return [];
      }
      const rawQueries = Array.isArray(parsed.queries)
        ? parsed.queries
        : typeof parsed.queries === "string"
          ? parsed.queries.split(/\s*\|\|\s*|,|\n/)
          : [];
      return [
        ...new Set(
          rawQueries
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .slice(0, CHAT_DOCUMENTS_RECOVERY_QUERY_LIMIT),
        ),
      ];
    } catch (error) {
      runtime.logger?.warn?.(
        {
          src: "api:chat-augmentation",
          error: error instanceof Error ? error.message : String(error),
        },
        "Document query recovery model call failed",
      );
      return [];
    }
  };

  let relevantMatches: DocumentMatches = [];
  try {
    relevantMatches = selectRelevantMatches(
      await loadMatchesAcrossScopes(userPrompt),
    )
      .sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0))
      .slice(0, CHAT_DOCUMENTS_LIMIT);

    if (relevantMatches.length === 0) {
      const recoveredQueries = await recoverDocumentSearchQueriesWithLlm();
      for (const query of recoveredQueries) {
        const recoveredMatches = selectRelevantMatches(
          await loadMatchesAcrossScopes(query),
        )
          .sort(
            (left, right) => (right.similarity ?? 0) - (left.similarity ?? 0),
          )
          .slice(0, CHAT_DOCUMENTS_LIMIT);
        if (recoveredMatches.length > 0) {
          relevantMatches = recoveredMatches;
          break;
        }
      }
    }
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "api:chat-augmentation",
        agentId,
        roomId,
        error: getErrorMessage(error, "document lookup failed"),
      },
      "Document augmentation skipped after retrieval failure",
    );
    return message;
  }

  if (relevantMatches.length === 0) return message;

  const contextualDocuments = relevantMatches
    .map((match, index) => {
      const metadata = match.metadata as Record<string, unknown> | undefined;
      const title =
        typeof metadata?.filename === "string" &&
        metadata.filename.trim().length > 0
          ? metadata.filename.trim()
          : typeof metadata?.title === "string" &&
              metadata.title.trim().length > 0
            ? metadata.title.trim()
            : `source-${index + 1}`;
      const text = (match.content?.text ?? "").trim();
      const snippet =
        text.length > CHAT_DOCUMENTS_SNIPPET_MAX_CHARS
          ? `${text.slice(0, CHAT_DOCUMENTS_SNIPPET_MAX_CHARS)}...`
          : text;
      return [
        `<source title=${JSON.stringify(title)} similarity=${JSON.stringify(
          (match.similarity ?? 0).toFixed(3),
        )}>`,
        snippet,
        "</source>",
      ].join("\n");
    })
    .join("\n\n");

  return {
    ...message,
    content: {
      ...(message.content as Content),
      text: [
        "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
        "If the answer appears verbatim in the contextual documents, repeat it exactly.",
        "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
        "",
        "<contextual_documents>",
        contextualDocuments,
        "</contextual_documents>",
        "",
        "<user_request>",
        userPrompt,
        "</user_request>",
      ].join("\n"),
    },
  };
}

// ---------------------------------------------------------------------------
// Image validation & attachment building
// ---------------------------------------------------------------------------

export interface ChatImageAttachment {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
}

const MAX_CHAT_IMAGES = 4;

/** Maximum base64 data length for a single image (~3.75 MB binary). */
const MAX_IMAGE_DATA_BYTES = 5 * 1_048_576;

/** Maximum length of an image filename. */
const MAX_IMAGE_NAME_LENGTH = 255;

/** Matches a valid standard-alphabet base64 string (RFC 4648 §4, `+/`, optional `=` padding). */
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

/**
 * Extension of the core Media attachment shape that carries raw image bytes for
 * action handlers (e.g. POST) while the message is in-memory. The
 * extra fields are intentionally stripped before the message is persisted.
 *
 * Note: `_data`/`_mimeType` survive only because elizaOS passes the
 * `userMessage` object reference directly to action handlers without
 * deep-cloning or serializing it. If that ever changes, action handlers
 * that read these fields will silently receive `undefined`.
 */
export interface ChatAttachmentWithData extends Media {
  /** Raw base64 image data — never written to the database. */
  _data: string;
  /** MIME type corresponding to `_data`. */
  _mimeType: string;
}

/**
 * Builds in-memory and compact (DB-persisted) attachment arrays from
 * validated images. Exported so it can be unit-tested independently.
 */
export function buildChatAttachments(
  images: ChatImageAttachment[] | undefined,
): {
  /** In-memory attachments that include `_data`/`_mimeType` for action handlers. */
  attachments: ChatAttachmentWithData[] | undefined;
  /** Persistence-safe attachments with `_data`/`_mimeType` stripped. */
  compactAttachments: Media[] | undefined;
} {
  if (!images?.length)
    return { attachments: undefined, compactAttachments: undefined };
  // Compact placeholder URL (no base64) keeps the LLM context lean. The raw
  // image bytes are stashed in `_data`/`_mimeType` for action handlers (e.g.
  // POST) that need to upload them.
  const attachments: ChatAttachmentWithData[] = images.map((img, i) => ({
    id: `img-${i}`,
    url: `attachment:img-${i}`,
    title: img.name,
    source: "client_chat",
    contentType: ContentType.IMAGE,
    _data: img.data,
    _mimeType: img.mimeType,
  }));
  // DB-persisted version omits _data/_mimeType so raw bytes aren't stored.
  const compactAttachments: Media[] = attachments.map(
    ({ _data: _d, _mimeType: _m, ...rest }) => rest,
  );
  return { attachments, compactAttachments };
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

type MessageMemory = ReturnType<typeof createMessageMemory>;

/**
 * Constructs the in-memory user message (with image data for action handlers)
 * and the persistence-safe counterpart (image data stripped). Extracted to
 * avoid duplicating this logic across the stream and non-stream chat endpoints.
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
  // In-memory message carries _data/_mimeType so action handlers can upload.
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
  // Persisted message: compact placeholder URL, no raw bytes in DB.
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
