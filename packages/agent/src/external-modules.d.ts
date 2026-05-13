declare module "@elizaos/plugin-agent-orchestrator";
declare module "@elizaos/plugin-agent-skills";
declare module "@elizaos/plugin-capacitor-bridge" {
  import type { Server } from "node:http";
  import type { AgentRuntime } from "@elizaos/core";

  export interface MobileDeviceBridgeStatus {
    enabled: boolean;
    connected: boolean;
    devices: Array<{
      deviceId: string;
      capabilities: {
        platform: "ios" | "android" | "web";
        deviceModel: string;
        totalRamGb: number;
        cpuCores: number;
        gpu: {
          backend: "metal" | "vulkan" | "gpu-delegate";
          available: boolean;
        } | null;
      };
      loadedPath: string | null;
      connectedSince: string;
    }>;
    primaryDeviceId: string | null;
    pendingRequests: number;
    modelPath: string | null;
  }

  export const mobileDeviceBridge: unknown;
  export function getMobileDeviceBridgeStatus(): MobileDeviceBridgeStatus;
  export function loadMobileDeviceBridgeModel(
    modelPath: string,
    modelId?: string,
  ): Promise<void>;
  export function unloadMobileDeviceBridgeModel(): Promise<void>;
  export function attachMobileDeviceBridgeToServer(
    server: Server,
  ): Promise<void>;
  export function ensureMobileDeviceBridgeInferenceHandlers(
    runtime: AgentRuntime,
  ): Promise<boolean>;
}
declare module "qrcode-terminal" {
  export function generate(
    input: string,
    options?: { small?: boolean },
    callback?: (qrcode: string) => void,
  ): void;
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
declare module "@elizaos/plugin-elizacloud" {
  export interface CloudOnboardingResult {
    apiKey: string;
    agentId: string | undefined;
    baseUrl: string;
    bridgeUrl?: string;
  }
  export interface CloudOnboardingObserver {
    [key: string]: unknown;
  }
  export class ClackObserver implements CloudOnboardingObserver {
    constructor(clack: unknown);
    [key: string]: unknown;
  }
  export class NullCloudOnboardingObserver implements CloudOnboardingObserver {
    [key: string]: unknown;
  }
  export function runCloudOnboarding(
    observer: CloudOnboardingObserver,
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
    connect(
      agentId: string,
    ): Promise<{ agentName?: string; [key: string]: unknown }>;
    disconnect(): Promise<void>;
    [key: string]: unknown;
  }

  export function normalizeCloudSiteUrl(value?: string): string;
  export function normalizeCloudSecret(
    value: string | null | undefined,
  ): string | null;
  export function validateCloudBaseUrl(value: string): string | null;
  export function resolveCloudApiBaseUrl(...args: unknown[]): string;
  export function resolveCloudApiKey(...args: unknown[]): string | null;
  export function __resetCloudBaseUrlCache(): void;
  export function clearCloudSecrets(): void;
  export function ensureCloudTtsApiKeyAlias(...args: unknown[]): void;
  export function getCloudSecret(...args: unknown[]): string | undefined;
  export function getOrCreateClientAddressKey(): Promise<{ address: string }>;
  export function isCloudProvisionedContainer(...args: unknown[]): boolean;
  export function provisionCloudWalletsBestEffort(...args: unknown[]): Promise<{
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
declare module "@elizaos/plugin-whatsapp" {
  import type { Plugin } from "@elizaos/core";

  export function applyWhatsAppQrOverride(...args: unknown[]): void;
  export function handleWhatsAppRoute(...args: unknown[]): unknown;
  export type WhatsAppPairingEventLike = Record<string, unknown>;
  export type WhatsAppPairingSessionLike = Record<string, unknown>;
  export type WhatsAppRouteDeps = Record<string, unknown>;
  export type WhatsAppRouteState = Record<string, unknown>;

  export type WhatsAppPairingEvent = Record<string, unknown>;
  export type WhatsAppPairingOptions = Record<string, unknown>;
  export type WhatsAppPairingStatus = string;

  export class WhatsAppPairingSession {
    constructor(...args: unknown[]);
    stop(): void;
  }

  export function sanitizeWhatsAppAccountId(...args: unknown[]): string;
  export function whatsappAuthExists(...args: unknown[]): boolean;
  export function whatsappLogout(...args: unknown[]): void;

  const whatsappPlugin: Plugin;
  export default whatsappPlugin;
}

declare module "@elizaos/plugin-computeruse" {
  export function handleSandboxRoute(
    req: unknown,
    res: unknown,
    pathname: unknown,
    method: unknown,
    options: unknown,
  ): Promise<boolean>;
  export function handleComputerUseRoutes(...args: unknown[]): unknown;
}

declare module "@elizaos/plugin-mcp" {
  export function handleMcpRoutes(...args: unknown[]): unknown;
}

declare module "@elizaos/app-contacts" {
  import type { Plugin, Provider } from "@elizaos/core";

  export const contactsProvider: Provider;
  export const appContactsPlugin: Plugin;
}

declare module "@elizaos/app-wifi" {
  import type { Plugin, Provider } from "@elizaos/core";

  export const appWifiPlugin: Plugin;
  export const wifiNetworksProvider: Provider;
}

declare module "@elizaos/plugin-discord-local" {
  const plugin: unknown;
  export default plugin;
}

declare module "@elizaos/plugin-edge-tts";
declare module "@elizaos/plugin-imessage" {
  export function resolveBlueBubblesWebhookPath(...args: unknown[]): string;
  const imessagePlugin: unknown;
  export default imessagePlugin;
}
declare module "@elizaos/plugin-local-embedding";
declare module "@elizaos/plugin-ollama";
declare module "@elizaos/plugin-mlx";
declare module "@elizaos/plugin-openai";
declare module "@elizaos/plugin-shell";
declare module "@elizaos/plugin-x402" {
  import type {
    IAgentRuntime,
    PaymentEnabledRoute,
    Route,
    RouteRequest,
    RouteResponse,
  } from "@elizaos/core";

  export interface X402StartupValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
  }

  export function createPaymentAwareHandler(
    route: PaymentEnabledRoute,
  ): (
    req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => void | Promise<void>;
  export function isRoutePaymentWrapped(route: unknown): boolean;
  export function validateX402Startup(
    routes: Route[],
    character?: unknown,
    options?: { agentId?: string },
  ): X402StartupValidationResult;
}
declare module "@elizaos/signal-native";

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

declare module "@elizaos/plugin-discord" {
  import type { AgentRuntime } from "@elizaos/core";

  export interface DiscordUserProfile {
    avatarUrl?: string;
    displayName?: string;
    username?: string;
  }

  export interface DiscordMessageAuthorProfile extends DiscordUserProfile {
    rawUserId?: string;
  }

  export interface StoredDiscordEntityProfile extends DiscordUserProfile {
    rawUserId?: string;
  }

  export function cacheDiscordAvatarUrl(
    url: string | undefined,
    options?: {
      fetchImpl?: typeof fetch;
      userId?: string;
    },
  ): Promise<string | undefined>;
  export function getDiscordAvatarCacheDir(): string;
  export function getDiscordAvatarCachePath(fileName: string): string;
  export function isCanonicalDiscordSource(
    source: string | null | undefined,
  ): boolean;
  export function cacheDiscordAvatarForRuntime(
    runtime: AgentRuntime,
    avatarUrl: string | undefined,
    userId?: string,
  ): Promise<string | undefined>;
  export function resolveDiscordMessageAuthorProfile(
    runtime: AgentRuntime,
    channelId: string,
    messageId: string,
  ): Promise<DiscordMessageAuthorProfile | null>;
  export function resolveDiscordUserProfile(
    runtime: AgentRuntime,
    userId: string,
  ): Promise<DiscordUserProfile | null>;
  export function resolveStoredDiscordEntityProfile(
    runtime: AgentRuntime,
    entityId: string | undefined,
  ): Promise<StoredDiscordEntityProfile | null>;
}
