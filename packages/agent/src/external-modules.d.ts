declare module "@elizaos/plugin-agent-orchestrator";
declare module "@elizaos/plugin-agent-skills";
declare module "@elizaos/plugin-computeruse";
declare module "@elizaos/plugin-telegram/account-auth-service" {
  export interface TelegramAccountAuthSessionLike {
    getSnapshot(): TelegramAccountAuthSnapshot;
    getResolvedConnectorConfig(): TelegramAccountConnectorConfig | null;
    start(args: {
      phone: string;
      credentials: { apiId: number; apiHash: string } | null;
    }): Promise<TelegramAccountAuthSnapshot>;
    submit(
      input:
        | { provisioningCode: string }
        | { telegramCode: string }
        | { password: string },
    ): Promise<TelegramAccountAuthSnapshot>;
    getSessionString(): string;
    stop(): Promise<void>;
  }
  export type TelegramAccountAuthSnapshot = {
    status: string;
    phone?: string | null;
    error: string | null;
    account?: {
      id: string;
      username?: string | null;
      firstName?: string | null;
    } | null;
    [key: string]: unknown;
  };
  export type TelegramAccountConnectorConfig = {
    appId?: string;
    appHash?: string;
    deviceModel?: string;
    systemVersion?: string;
    [key: string]: unknown;
  };
  export class TelegramAccountAuthSession
    implements TelegramAccountAuthSessionLike
  {
    constructor();
    getSnapshot(): TelegramAccountAuthSnapshot;
    getResolvedConnectorConfig(): TelegramAccountConnectorConfig | null;
    start(args: {
      phone: string;
      credentials: { apiId: number; apiHash: string } | null;
    }): Promise<TelegramAccountAuthSnapshot>;
    submit(
      input:
        | { provisioningCode: string }
        | { telegramCode: string }
        | { password: string },
    ): Promise<TelegramAccountAuthSnapshot>;
    getSessionString(): string;
    stop(): Promise<void>;
  }
  export function defaultTelegramAccountDeviceModel(): string;
  export function defaultTelegramAccountSystemVersion(): string;
  export function loadTelegramAccountSessionString(): string;
}
declare module "telegram" {
  export class TelegramClient {
    constructor(
      session: unknown,
      apiId: number,
      apiHash: string,
      options: Record<string, unknown>,
    );
    session: { save(): string } & Record<string, unknown>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    checkAuthorization(): Promise<boolean>;
    sendCode(
      ...args: unknown[]
    ): Promise<
      { phoneCodeHash: string; isCodeViaApp: boolean } & Record<string, unknown>
    >;
    invoke(request: unknown): Promise<unknown>;
    signInWithPassword(...args: unknown[]): Promise<Record<string, unknown>>;
    getDialogs(args: { limit: number }): Promise<ReadonlyArray<unknown>>;
    getEntity(target: unknown): Promise<unknown>;
    sendMessage(
      entity: unknown,
      args: { message: string },
    ): Promise<{ id?: unknown } | null | undefined>;
    getMessages(
      entity: unknown,
      args: { search?: string; ids?: number | number[]; limit?: number },
    ): Promise<ReadonlyArray<unknown>>;
    [key: string]: unknown;
  }
  export namespace Api {
    interface User {
      id: { toString(): string } | string;
      username?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      phone?: string | null;
      [key: string]: unknown;
    }
    namespace auth {
      class SignIn {
        constructor(args: {
          phoneNumber: string;
          phoneCodeHash: string;
          phoneCode: string;
        });
      }
      class Authorization {
        user: unknown;
        [key: string]: unknown;
      }
    }
    namespace account {}
  }
  export const Api: {
    auth: {
      SignIn: typeof Api.auth.SignIn;
      Authorization: typeof Api.auth.Authorization;
    };
    account: Record<string, unknown>;
    [key: string]: unknown;
  };
}
declare module "telegram/sessions" {
  export class StringSession {
    constructor(sessionString?: string);
    save(): string;
    [key: string]: unknown;
  }
}
declare module "@elizaos/plugin-elizacloud";
declare module "@elizaos/plugin-commands";
declare module "@elizaos/plugin-edge-tts";
declare module "@elizaos/plugin-edge-tts/node";
declare module "@elizaos/plugin-local-embedding";
declare module "@elizaos/plugin-ollama";
declare module "@elizaos/plugin-openai";
declare module "@elizaos/plugin-shell";
declare module "@elizaos/signal-native";
declare module "qrcode";
declare module "bun:ffi";

declare module "@elizaos/app-knowledge/routes" {
  export type KnowledgeRouteContext = unknown;
  export type KnowledgeRouteHelpers = unknown;
  export const handleKnowledgeRoutes: (
    context: unknown,
  ) => Promise<boolean> | boolean;
}

declare module "@elizaos/app-knowledge/service-loader" {
  import type { AgentRuntime, Memory, UUID } from "@elizaos/core";

  export type KnowledgeLoadFailReason =
    | "timeout"
    | "runtime_unavailable"
    | "not_registered";
  export interface KnowledgeServiceLike {
    addKnowledge(options: {
      agentId?: UUID;
      worldId: UUID;
      roomId: UUID;
      entityId: UUID;
      clientDocumentId: UUID;
      contentType: string;
      originalFilename: string;
      content: string;
      metadata?: Record<string, unknown>;
    }): Promise<{
      clientDocumentId: string;
      storedDocumentMemoryId: UUID;
      fragmentCount: number;
    }>;
    getKnowledge(
      message: Memory,
      options?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
    ): Promise<
      Array<{
        id: UUID;
        content: { text?: string };
        similarity?: number;
        metadata?: Record<string, unknown>;
      }>
    >;
    getMemories(params: {
      tableName: string;
      roomId?: UUID;
      count?: number;
      offset?: number;
      end?: number;
    }): Promise<Memory[]>;
    countMemories(params: {
      tableName: string;
      roomId?: UUID;
      unique?: boolean;
    }): Promise<number>;
    updateKnowledgeDocument?(options: {
      documentId: UUID;
      content: string;
    }): Promise<{
      documentId: UUID;
      fragmentCount: number;
    }>;
    deleteMemory(memoryId: UUID): Promise<void>;
  }
  export interface KnowledgeServiceResult {
    service: KnowledgeServiceLike | null;
    reason?: KnowledgeLoadFailReason;
  }
  export const getKnowledgeService: (
    runtime: AgentRuntime | null,
  ) => Promise<KnowledgeServiceResult>;
  export const getKnowledgeTimeoutMs: () => number;
}

declare module "@elizaos/app-training/core/context-types" {
  export type AgentContext = string;
  export const AGENT_CONTEXTS: AgentContext[];
}

declare module "@elizaos/app-contacts/plugin" {
  import type { Plugin, Provider } from "@elizaos/core";

  export const contactsProvider: Provider;
  export const appContactsPlugin: Plugin;
  export default appContactsPlugin;
}

declare module "@elizaos/app-phone/plugin" {
  import type { Action, Plugin, Provider } from "@elizaos/core";

  export const placeCallAction: Action;
  export const readCallLogAction: Action;
  export const phoneCallLogProvider: Provider;
  export const appPhonePlugin: Plugin;
  export default appPhonePlugin;
}

declare module "@elizaos/app-wifi/plugin" {
  import type { Action, Plugin, Provider } from "@elizaos/core";

  export const scanWifiAction: Action;
  export const wifiNetworksProvider: Provider;
  export const appWifiPlugin: Plugin;
  export default appWifiPlugin;
}

declare module "@elizaos/app-training/core/context-catalog" {
  import type { AgentContext } from "@elizaos/app-training";

  export type ContextResolutionSource = string;
  export const ACTION_CONTEXT_MAP: Record<string, AgentContext[]>;
  export const PROVIDER_CONTEXT_MAP: Record<string, AgentContext[]>;
  export const ALL_CONTEXTS: AgentContext[];
  export const resolveActionContexts: (...args: unknown[]) => AgentContext[];
  export const resolveProviderContexts: (...args: unknown[]) => AgentContext[];
  export const resolveActionContextResolution: (...args: unknown[]) => {
    contexts: AgentContext[];
    source: ContextResolutionSource;
  };
  export const resolveProviderContextResolution: (...args: unknown[]) => {
    contexts: AgentContext[];
    source: ContextResolutionSource;
  };
}

declare module "@elizaos/app-training/core/cli" {}
declare module "@elizaos/app-training/core/context-audit" {}
declare module "@elizaos/app-training/core/dataset-generator" {}
declare module "@elizaos/app-training/core/replay-validator" {}
declare module "@elizaos/app-training/core/roleplay-executor" {}
declare module "@elizaos/app-training/core/roleplay-trajectories" {}
declare module "@elizaos/app-training/core/scenario-blueprints" {}
declare module "@elizaos/app-training/core/trajectory-task-datasets" {}
declare module "@elizaos/app-training/core/vertex-tuning" {}

declare module "abitype" {
  export type TypedData = Record<
    string,
    ReadonlyArray<{ name: string; type: string; [key: string]: unknown }>
  >;
  export type TypedDataDomain = {
    name?: string;
    version?: string;
    chainId?: bigint | number | undefined;
    verifyingContract?: `0x${string}` | undefined;
    salt?: `0x${string}` | undefined;
  };
  export type TypedDataToPrimitiveTypes<T extends TypedData> = {
    [K in keyof T]: unknown;
  };
  export type Address = `0x${string}`;
  export type TypedDataParameter = { name: string; type: string };
  export type TypedDataType = string;
}

declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";

  export * from "@elizaos/plugin-sql/schema";
  export type { DrizzleDatabase } from "@elizaos/plugin-sql/types";

  export const PGLITE_ERROR_CODES: {
    ACTIVE_LOCK: string;
    CORRUPT_DATA: string;
    MANUAL_RESET_REQUIRED: string;
  };

  export function getPgliteErrorCode(error: unknown): string | null;
  export function createPgliteInitError(
    code: string,
    message: string,
    options?: Record<string, unknown>,
  ): Error;

  const plugin: Plugin;
  export default plugin;
}

declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { Server as HttpServer, IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: number;
    constructor(address: string | URL, options?: Record<string, unknown>);
    close(code?: number, reason?: string): void;
    send(
      data: string | Buffer | ArrayBuffer | ArrayBufferView,
      cb?: (err?: Error) => void,
    ): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: {
      noServer?: boolean;
      server?: HttpServer;
      path?: string;
      [key: string]: unknown;
    });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: WebSocket, request: IncomingMessage) => void,
    ): void;
    emit(event: "connection", ws: WebSocket, request: IncomingMessage): boolean;
    emit(event: string, ...args: unknown[]): boolean;
    on(
      event: "connection",
      listener: (ws: WebSocket, request: IncomingMessage) => void,
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    close(callback?: () => void): void;
    clients: Set<WebSocket>;
  }
}

declare module "fast-redact" {
  interface FastRedactOptions {
    paths: string[];
    censor?: string | ((value: unknown, path: string) => unknown);
    serialize?: boolean | ((value: unknown) => string);
    strict?: boolean;
    remove?: boolean;
  }
  function fastRedact(
    opts: FastRedactOptions,
  ): (obj: Record<string, unknown>) => string | Record<string, unknown>;
  export = fastRedact;
}

declare module "markdown-it" {
  interface Token {
    type: string;
    tag: string;
    nesting: number;
    content: string;
    children: Token[] | null;
    markup: string;
    info: string;
    level: number;
    block: boolean;
    hidden: boolean;
    attrs: [string, string][] | null;
    map: [number, number] | null;
    meta: unknown;
  }
  class MarkdownIt {
    constructor(
      presetOrOptions?: string | Record<string, unknown>,
      options?: Record<string, unknown>,
    );
    parse(src: string, env?: object): Token[];
    render(src: string, env?: object): string;
    enable(rule: string | string[], ignoreInvalid?: boolean): this;
    disable(rule: string | string[], ignoreInvalid?: boolean): this;
  }
  export = MarkdownIt;
}

declare module "three/examples/jsm/libs/meshopt_decoder.module.js" {
  export const MeshoptDecoder: {
    supported: boolean;
    ready: Promise<void>;
    decode(
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode?: number,
    ): void;
    decodeGltfBuffer(
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode: string,
      filter?: string,
    ): void;
    useWorkers?(count: number): void;
  };
}

declare module "jsdom" {
  export class JSDOM {
    constructor(
      html?: string,
      options?: {
        url?: string;
        pretendToBeVisual?: boolean;
        [key: string]: unknown;
      },
    );
    window: Window & typeof globalThis;
    serialize(): string;
  }
}
