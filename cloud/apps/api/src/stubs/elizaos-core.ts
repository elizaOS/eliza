/**
 * @elizaos/core Cloudflare Workers stub.
 *
 * The real package performs forbidden top-level I/O on Workers. Agent runtime
 * code runs on the Node sidecar (`services/agent-server`). This module keeps
 * Worker bundles resolvable, while runtime-only helpers throw if an accidental
 * Worker-side path reaches them.
 */

const NOT_AVAILABLE =
  "@elizaos/core runtime APIs are not available in the Cloudflare Workers API bundle. Route agent runtime work through the agent-server sidecar.";

function unavailable(name: string): never {
  throw new Error(`${name}: ${NOT_AVAILABLE}`);
}

function throwingExport(name: string): (...args: unknown[]) => never {
  return () => unavailable(name);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    hex.push(bytes[index].toString(16).padStart(2, "0"));
  }

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha1Bytes(message: string): Uint8Array {
  const bytes = utf8Encode(message);
  const messageLength = bytes.length;
  const padded = new Uint8Array(((messageLength + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[messageLength] = 0x80;

  const dataView = new DataView(padded.buffer);
  const bitLength = messageLength * 8;
  dataView.setUint32(padded.length - 4, bitLength >>> 0, false);
  dataView.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32) >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = dataView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 80; index += 1) {
      const value = words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16];
      words[index] = (value << 1) | (value >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const output = new Uint8Array(20);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, h0, false);
  outputView.setUint32(4, h1, false);
  outputView.setUint32(8, h2, false);
  outputView.setUint32(12, h3, false);
  outputView.setUint32(16, h4, false);
  return output;
}

export function stringToUuid(target: string | number): string {
  const value = typeof target === "number" ? target.toString() : target;
  if (typeof value !== "string") {
    throw new TypeError("Value must be string");
  }

  if (UUID_RE.test(value)) {
    return value;
  }

  const bytes = sha1Bytes(encodeURIComponent(value)).slice(0, 16);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  bytes[6] = bytes[6] & 0x0f;
  return bytesToUuid(bytes);
}

export function asUUID(value: string): string {
  if (!value || !UUID_RE.test(value)) {
    throw new Error(`Invalid UUID format: ${value}`);
  }
  return value;
}

export function createUniqueUuid(
  runtime: { agentId?: string } | null | undefined,
  baseUserId: string,
): string {
  if (runtime?.agentId && baseUserId === runtime.agentId) {
    return runtime.agentId;
  }

  return stringToUuid(`${baseUserId}:${runtime?.agentId ?? ""}`);
}

const stubLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  success: () => {},
  child: () => stubLogger,
};

export const logger = stubLogger;
export const elizaLogger = stubLogger;

export const ContentType = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  DOCUMENT: "document",
  LINK: "link",
} as const;

export const EventType = {
  MESSAGE_RECEIVED: "MESSAGE_RECEIVED",
  MESSAGE_SENT: "MESSAGE_SENT",
  ACTION_STARTED: "ACTION_STARTED",
  ACTION_COMPLETED: "ACTION_COMPLETED",
  WORLD_JOINED: "WORLD_JOINED",
  ROOM_JOINED: "ROOM_JOINED",
  ENTITY_JOINED: "ENTITY_JOINED",
  USER_JOINED: "USER_JOINED",
  RUN_STARTED: "RUN_STARTED",
  RUN_ENDED: "RUN_ENDED",
  RUN_TIMEOUT: "RUN_TIMEOUT",
  MODEL_USED: "MODEL_USED",
} as const;

export const ChannelType = {
  DM: "DM",
  GROUP: "GROUP",
  VOICE_DM: "VOICE_DM",
  VOICE_GROUP: "VOICE_GROUP",
  FEED: "FEED",
  THREAD: "THREAD",
  WORLD: "WORLD",
  FORUM: "FORUM",
  API: "API",
  SELF: "SELF",
} as const;

export const ModelType = {
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_LARGE: "TEXT_LARGE",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",
  TEXT_REASONING_SMALL: "TEXT_REASONING_SMALL",
  TEXT_REASONING_LARGE: "TEXT_REASONING_LARGE",
  IMAGE: "IMAGE",
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
  TRANSCRIPTION: "TRANSCRIPTION",
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
  AUDIO: "AUDIO",
  VIDEO: "VIDEO",
  OBJECT_SMALL: "OBJECT_SMALL",
  OBJECT_LARGE: "OBJECT_LARGE",
} as const;

export const ServiceType = {
  TRANSCRIPTION: "TRANSCRIPTION",
  VIDEO: "VIDEO",
  BROWSER: "BROWSER",
  PDF: "PDF",
  REMOTE_FILES: "REMOTE_FILES",
} as const;

export const VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  XXXL: 3072,
} as const;

export const MemoryType = {
  DOCUMENT: "document",
  FRAGMENT: "fragment",
  MESSAGE: "message",
  DESCRIPTION: "description",
  CUSTOM: "custom",
} as const;

export const addHeader = (header: string, body: string) => (body ? `${header}\n${body}` : "");

export const UUID = asUUID as unknown as (value?: string) => string;
export const composeActionExamples = throwingExport("composeActionExamples");
export const formatActions = throwingExport("formatActions");
export const formatActionNames = throwingExport("formatActionNames");
export const composePromptFromState = throwingExport("composePromptFromState");
export const composePrompt = throwingExport("composePrompt");
export const parseJSONObjectFromText = throwingExport("parseJSONObjectFromText");
export const generateText = throwingExport("generateText");
export const generateObject = throwingExport("generateObject");
export const getTokenForProvider = throwingExport("getTokenForProvider");
export const trimTokens = throwingExport("trimTokens");
export const truncateToCompleteSentence = throwingExport("truncateToCompleteSentence");
export const parseKeyValueXml = throwingExport("parseKeyValueXml");
export const parseBooleanFromText = throwingExport("parseBooleanFromText");
export const parseCharacter = throwingExport("parseCharacter");
export const formatMessages = throwingExport("formatMessages");
export const formatPosts = throwingExport("formatPosts");
export const getEntityDetails = throwingExport("getEntityDetails");
export const splitChunks = throwingExport("splitChunks");
export const createMessageMemory = throwingExport("createMessageMemory");

function renderSystemPromptBio(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

function textFromChatMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildCanonicalSystemPrompt(args: {
  character?: { name?: unknown; system?: unknown; bio?: unknown } | null;
  userRole?: unknown;
}): string {
  const character = args.character;
  const system = typeof character?.system === "string" ? character.system.trim() : "";
  const bio = renderSystemPromptBio(character?.bio);
  const name =
    typeof character?.name === "string" && character.name.trim()
      ? character.name.trim()
      : "the agent";
  const role = typeof args.userRole === "string" ? args.userRole.trim().toUpperCase() : "";
  return [system, bio ? `# About ${name}\n${bio}` : "", role ? `user_role: ${role}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function resolveEffectiveSystemPrompt(args: {
  params?: unknown;
  fallback?: string | null;
}): string | undefined {
  const params =
    args.params && typeof args.params === "object" && !Array.isArray(args.params)
      ? (args.params as Record<string, unknown>)
      : null;
  if (params && Object.hasOwn(params, "system")) {
    return typeof params.system === "string" ? params.system.trim() || undefined : undefined;
  }
  const messages = params?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0] as { role?: unknown; content?: unknown };
    if (first?.role === "system") {
      const system = textFromChatMessageContent(first.content);
      if (system) return system;
    }
  }
  const fallback = typeof args.fallback === "string" ? args.fallback.trim() : "";
  return fallback || undefined;
}

export function renderChatMessagesForPrompt(
  messages: Array<{ role?: unknown; content?: unknown }> | undefined,
  options: { omitDuplicateSystem?: string } = {},
): string {
  if (!Array.isArray(messages)) return "";
  const omitDuplicateSystem = options.omitDuplicateSystem?.trim();
  return messages
    .filter((message, index) => {
      if (index !== 0 || !omitDuplicateSystem || message?.role !== "system") return true;
      return textFromChatMessageContent(message.content) !== omitDuplicateSystem;
    })
    .map((message) => {
      const role = typeof message?.role === "string" ? message.role : "user";
      const content = textFromChatMessageContent(message?.content);
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function getRequestContext(): undefined {
  return undefined;
}

export class Service {
  constructor(..._args: unknown[]) {
    unavailable("Service");
  }

  static start(..._args: unknown[]): never {
    unavailable("Service.start");
  }
}

export class AgentRuntime {
  constructor(..._args: unknown[]) {
    unavailable("AgentRuntime");
  }
}

export class Semaphore {
  constructor(_max: number = 1) {
    unavailable("Semaphore");
  }

  async acquire(): Promise<never> {
    unavailable("Semaphore.acquire");
  }

  release(): never {
    unavailable("Semaphore.release");
  }
}

export class BM25 {
  constructor(..._args: unknown[]) {
    unavailable("BM25");
  }

  search(..._args: unknown[]): never {
    unavailable("BM25.search");
  }
}

export type IAgentRuntime = unknown;
export type Plugin = unknown;
export type Action = unknown;
export type Provider = unknown;
export type Evaluator = unknown;
export type Memory = unknown;
export type Entity = unknown;
export type Participant = unknown;
export type Room = unknown;
export type World = unknown;
export type Media = { url?: string; contentType?: string };
export type State = unknown;
export type MessagePayload = unknown;
export type HandlerCallback = (...args: unknown[]) => unknown;
export type Character = unknown;
export type Component = unknown;
export type Task = unknown;
export type ActionExample = unknown;
export type Content = unknown;

export default {
  logger,
  elizaLogger,
  ContentType,
  EventType,
  ChannelType,
  ModelType,
  ServiceType,
  VECTOR_DIMS,
  MemoryType,
  addHeader,
  UUID,
  composeActionExamples,
  formatActions,
  formatActionNames,
  composePrompt,
  composePromptFromState,
  parseJSONObjectFromText,
  generateText,
  generateObject,
  stringToUuid,
  getTokenForProvider,
  trimTokens,
  truncateToCompleteSentence,
  parseKeyValueXml,
  parseBooleanFromText,
  parseCharacter,
  formatMessages,
  formatPosts,
  getEntityDetails,
  createUniqueUuid,
  asUUID,
  splitChunks,
  createMessageMemory,
  buildCanonicalSystemPrompt,
  resolveEffectiveSystemPrompt,
  renderChatMessagesForPrompt,
  getRequestContext,
  Service,
  AgentRuntime,
  Semaphore,
  BM25,
};
