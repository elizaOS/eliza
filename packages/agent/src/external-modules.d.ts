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
declare module "@elizaos/plugin-elizacloud/onboarding" {
  export interface CloudOnboardingResult {
    apiKey: string;
    agentId: string | undefined;
    baseUrl: string;
    bridgeUrl?: string;
  }
  export function runCloudOnboarding(
    clack: unknown,
    name: string,
    chosenTemplate?: unknown,
  ): Promise<CloudOnboardingResult | null>;
}
declare module "@elizaos/plugin-commands";
declare module "@elizaos/plugin-discord" {
  export interface DiscordProfileLike {
    displayName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    rawUserId?: string | null;
  }

  export function cacheDiscordAvatarUrl(...args: unknown[]): Promise<string>;
  export function getDiscordAvatarCacheDir(): string;
  export function getDiscordAvatarCachePath(fileName: string): string;
  export function cacheDiscordAvatarForRuntime(
    ...args: unknown[]
  ): Promise<string | undefined>;
  export function isCanonicalDiscordSource(source: unknown): boolean;
  export function resolveDiscordMessageAuthorProfile(
    ...args: unknown[]
  ): Promise<DiscordProfileLike | null>;
  export function resolveDiscordUserProfile(
    ...args: unknown[]
  ): Promise<DiscordProfileLike | null>;
  export function resolveStoredDiscordEntityProfile(
    ...args: unknown[]
  ): Promise<DiscordProfileLike | null>;
  const discordPlugin: unknown;
  export default discordPlugin;
}
declare module "@elizaos/plugin-edge-tts";
declare module "@elizaos/plugin-edge-tts/node";
declare module "@elizaos/plugin-imessage" {
  export function resolveBlueBubblesWebhookPath(...args: unknown[]): string;
  const imessagePlugin: unknown;
  export default imessagePlugin;
}
declare module "@elizaos/plugin-local-embedding";
declare module "@elizaos/plugin-ollama";
declare module "@elizaos/plugin-openai";
declare module "@elizaos/plugin-shell";
declare module "@elizaos/signal-native";
declare module "qrcode";

declare module "@elizaos/app-documents/routes" {
  export type DocumentRouteContext = unknown;
  export type DocumentRouteHelpers = unknown;
  export const handleDocumentsRoutes: (
    context: unknown,
  ) => Promise<boolean> | boolean;
}

declare module "@elizaos/app-documents/service-loader" {
  // Source of truth lives in @elizaos/agent/api/documents-service-loader.
  // The plugin re-exports those names verbatim, so this ambient declaration
  // simply forwards the same surface for environments where the workspace
  // resolver fails to pick up the plugin's TypeScript exports map.
  export type {
    DocumentAddedByRole,
    DocumentAddedFrom,
    DocumentSearchMode,
    DocumentsLoadFailReason,
    DocumentsServiceLike,
    DocumentsServiceResult,
    DocumentVisibilityScope,
  } from "@elizaos/agent/api/documents-service-loader";
  export {
    getDocumentsService,
    getDocumentsServiceTimeoutMs,
  } from "@elizaos/agent/api/documents-service-loader";
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
  export const phoneCallLogProvider: Provider;
  export const appPhonePlugin: Plugin;
  export default appPhonePlugin;
}

declare module "@elizaos/app-wifi/plugin" {
  import type { Plugin, Provider } from "@elizaos/core";

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
