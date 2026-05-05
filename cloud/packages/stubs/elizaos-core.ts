/**
 * @elizaos/core — Cloudflare Workers stub (and any other edge bundle that must
 * not load the real package).
 *
 * The real package performs forbidden top-level I/O on Workers. Agent runtime
 * runs on the Node sidecar (`services/agent-server`). This module supplies the
 * shape of common exports so transitive imports resolve.
 */

const noop = (() => undefined) as unknown as (...args: unknown[]) => unknown;

const stubLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => stubLogger,
};

export const logger = stubLogger;

/** Matches public `ContentType` in published @elizaos/core primitives. */
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
  RUN_ENDED: "RUN_ENDED",
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

export const UUID = ((s?: string) => s ?? "00000000-0000-0000-0000-000000000000") as unknown as (
  s?: string,
) => string;

export const addHeader = (header: string, body: string) => (body ? `${header}\n${body}` : "");

export const composeActionExamples = noop;
export const formatActions = noop;
export const formatActionNames = noop;
export const composePromptFromState = noop;
export const composePrompt = noop;
export const parseJSONObjectFromText = noop;
export const generateText = noop;
export const generateObject = noop;
export const stringToUuid = (s: string) => s;
export const getTokenForProvider = noop;
export const trimTokens = (s: unknown) => String(s ?? "");
export const truncateToCompleteSentence = (s: unknown) => String(s ?? "");

export const elizaLogger = stubLogger;
export const parseKeyValueXml = noop;
export const parseBooleanFromText = (s: unknown) => Boolean(s);
export const parseCharacter = noop;
export const formatMessages = noop;
export const formatPosts = noop;
export const getEntityDetails = noop;
export const createUniqueUuid = (() => "00000000-0000-0000-0000-000000000000") as unknown as (
  ...args: unknown[]
) => string;
export const asUUID = (s: unknown) => String(s ?? "");
export const splitChunks = noop;

export function getRequestContext(): undefined {
  return undefined;
}

export class Service {
  constructor(..._args: unknown[]) {}
  static start(..._args: unknown[]): unknown {
    return undefined;
  }
}
export class AgentRuntime {
  constructor(..._args: unknown[]) {}
}
export class Semaphore {
  constructor(_max: number = 1) {}
  async acquire(): Promise<void> {}
  release(): void {}
}
export class BM25 {
  constructor(..._args: unknown[]) {}
  search(..._args: unknown[]): unknown[] {
    return [];
  }
}

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

export const createMessageMemory = (params: Record<string, unknown>) => {
  const now = Date.now();
  return {
    ...params,
    createdAt: now,
    metadata: {
      type: MemoryType.MESSAGE,
      timestamp: now,
      scope: params.agentId ? "private" : "shared",
    },
  };
};

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

const target = {
  logger,
  ContentType,
  EventType,
  ChannelType,
  ModelType,
  ServiceType,
  UUID,
  addHeader,
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
  createMessageMemory,
};

const proxy = new Proxy(target, {
  get(t, prop) {
    if (prop in t) return (t as Record<PropertyKey, unknown>)[prop];
    if (typeof prop === "string" && /^[A-Z]/.test(prop)) return prop;
    return noop;
  },
});

export default proxy;
