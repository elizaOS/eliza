declare module "@elizaos/plugin-agent-orchestrator";
declare module "@elizaos/plugin-agent-skills";
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
declare module "@elizaos/plugin-elizacloud" {
  export interface CloudConfigLike {
    apiKey?: string | null;
    baseUrl?: string | null;
    [key: string]: unknown;
  }

  export interface CloudOnboardingResult {
    apiKey: string;
    agentId: string | undefined;
    baseUrl: string;
    bridgeUrl?: string;
  }

  export interface CloudRouteState {
    config?: unknown;
    runtime?: unknown;
    [key: string]: unknown;
  }

  export interface CloudWalletDescriptor {
    agentWalletId: string;
    walletAddress: string;
    walletProvider: CloudWalletProvider;
    chainType: "evm" | "solana";
    balance?: string | number;
  }

  export type CloudWalletProvider = "privy" | "steward";

  export class ElizaCloudClient {
    constructor(...args: unknown[]);
    [key: string]: unknown;
  }

  export class CloudManager {
    constructor(...args: unknown[]);
    init(): Promise<void>;
    connect(agentId: string): Promise<{ agentName?: string; [key: string]: unknown }>;
    disconnect(): Promise<void>;
    [key: string]: unknown;
  }

  export function normalizeCloudSiteUrl(value?: string): string;
  export function normalizeCloudSecret(value: string | null | undefined): string | null;
  export function validateCloudBaseUrl(value: string): string | null;
  export function resolveCloudApiBaseUrl(...args: unknown[]): string;
  export function resolveCloudApiKey(...args: unknown[]): string | null;
  export function __resetCloudBaseUrlCache(): void;
  export function clearCloudSecrets(): void;
  export function ensureCloudTtsApiKeyAlias(...args: unknown[]): void;
  export function getCloudSecret(...args: unknown[]): string | undefined;
  export function getOrCreateClientAddressKey(): Promise<{ address: string }>;
  export function isCloudProvisionedContainer(...args: unknown[]): boolean;
  export function provisionCloudWalletsBestEffort(
    ...args: unknown[]
  ): Promise<{
    descriptors: Partial<Record<"evm" | "solana", CloudWalletDescriptor>>;
    failures: Array<{ chain: "evm" | "solana"; error: unknown }>;
    warnings: string[];
  }>;
  export function persistCloudWalletCache(...args: unknown[]): void;
  export function resolveCloudTtsBaseUrl(...args: unknown[]): string;
  export function resolveElevenLabsApiKeyForCloudMode(
    ...args: unknown[]
  ): string | undefined;
  export function runCloudOnboarding(
    ...args: unknown[]
  ): Promise<CloudOnboardingResult | null>;

  export function handleCloudBillingRoute(...args: unknown[]): Promise<boolean>;
  export function handleCloudCompatRoute(...args: unknown[]): Promise<boolean>;
  export function handleCloudRelayRoute(...args: unknown[]): Promise<boolean>;
  export function handleCloudRoute(...args: unknown[]): Promise<boolean>;
  export function handleCloudStatusRoutes(...args: unknown[]): Promise<boolean>;
  export function handleCloudTtsPreviewRoute(
    ...args: unknown[]
  ): Promise<boolean>;
  export function mirrorCompatHeaders(...args: unknown[]): void;

  const plugin: unknown;
  export default plugin;
}
declare module "@elizaos/plugin-commands";
declare module "@elizaos/plugin-signal" {
  export type SignalPairingStatus =
    | "idle"
    | "initializing"
    | "waiting_for_qr"
    | "connected"
    | "disconnected"
    | "timeout"
    | "error";

  export interface SignalPairingEvent {
    type: "signal-qr" | "signal-status";
    accountId: string;
    qrDataUrl?: string;
    status?: SignalPairingStatus;
    uuid?: string;
    phoneNumber?: string;
    error?: string;
  }

  export interface SignalPairingSnapshot {
    status: SignalPairingStatus;
    qrDataUrl: string | null;
    phoneNumber: string | null;
    error: string | null;
  }

  export interface SignalPairingOptions {
    authDir: string;
    accountId: string;
    cliPath?: string;
    onEvent: (event: SignalPairingEvent) => void;
  }

  export class SignalPairingSession {
    constructor(options: SignalPairingOptions);
    start(): Promise<void>;
    stop(): void;
    getStatus(): SignalPairingStatus;
    getSnapshot(): SignalPairingSnapshot;
  }

  export function applySignalQrOverride(
    plugins: {
      id: string;
      validationErrors: unknown[];
      configured: boolean;
      qrConnected?: boolean;
    }[],
    workspaceDir: string,
  ): void;

  export function classifySignalPairingErrorStatus(
    errorMessage: string,
  ): SignalPairingStatus;
  export function extractSignalCliProvisioningUrl(text: string): string | null;
  export function parseSignalCliAccountsOutput(output: string): string | null;
  export function sanitizeSignalAccountId(raw: string): string;
  export function signalAuthExists(
    workspaceDir: string,
    accountId?: string,
  ): boolean;
  export function signalLogout(workspaceDir: string, accountId?: string): void;
}
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
  import type { AgentRuntime, Memory, UUID } from "@elizaos/core";

  export type DocumentVisibilityScope =
    | "global"
    | "owner-private"
    | "user-private"
    | "agent-private";

  export type DocumentAddedByRole =
    | "OWNER"
    | "ADMIN"
    | "USER"
    | "AGENT"
    | "RUNTIME";

  export type DocumentAddedFrom =
    | "chat"
    | "upload"
    | "url"
    | "file"
    | "agent-autonomous"
    | "runtime-internal"
    | "lifeops"
    | "default-seed"
    | "character";

  export type DocumentSearchMode = "hybrid" | "vector" | "keyword";

  export interface DocumentsServiceLike {
    addDocument(options: {
      agentId?: UUID;
      worldId: UUID;
      roomId: UUID;
      entityId: UUID;
      clientDocumentId: UUID;
      contentType: string;
      originalFilename: string;
      content: string;
      metadata?: Record<string, unknown>;
      scope?: DocumentVisibilityScope;
      scopedToEntityId?: UUID;
      addedBy?: UUID;
      addedByRole?: DocumentAddedByRole;
      addedFrom?: DocumentAddedFrom;
    }): Promise<{
      clientDocumentId: string;
      storedDocumentMemoryId: UUID;
      fragmentCount: number;
    }>;
    searchDocuments(
      message: Memory,
      scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
      searchMode?: DocumentSearchMode,
    ): Promise<
      Array<{
        id: UUID;
        content: { text?: string };
        similarity?: number;
        metadata?: Record<string, unknown>;
        worldId?: UUID;
      }>
    >;
    listDocuments?(
      message?: Memory,
      options?: Record<string, unknown>,
    ): Promise<Memory[]>;
    getDocumentById?(
      documentId: UUID,
      message?: Memory,
    ): Promise<Memory | null>;
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
    updateDocument(options: {
      documentId: UUID;
      content: string;
      message?: Memory;
    }): Promise<{
      documentId: UUID;
      fragmentCount: number;
    }>;
    deleteDocument?(documentId: UUID, message?: Memory): Promise<void>;
    deleteMemory(memoryId: UUID): Promise<void>;
  }

  export type DocumentsLoadFailReason =
    | "timeout"
    | "runtime_unavailable"
    | "not_registered";

  export interface DocumentsServiceResult {
    service: DocumentsServiceLike | null;
    reason?: DocumentsLoadFailReason;
  }

  export function getDocumentsServiceTimeoutMs(): number;
  export function getDocumentsService(
    runtime: AgentRuntime | null,
  ): Promise<DocumentsServiceResult>;
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
