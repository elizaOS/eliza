import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NormalizedLspSettings } from "../lsp/types";
import type { AgentMode, ClawdSettings, McpServerConfig, SolanaConfig, SubAgentConfig } from "../types/index.js";

export type { McpServerConfig } from "../types/index.js";

import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelInfo,
  getModelProvider,
  getProviderDefinition,
  normalizeModelId,
  normalizeProviderId,
  type ProviderId,
  resolveModelRoute,
} from "../grok/models.js";

// === Path Constants ===

export function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

export const LEGACY_PROJECT_SETTINGS_DIR = ".grok";
export const PROJECT_SETTINGS_DIR = ".clawd";

export function getClawdHome(): string {
  return path.join(getHomeDir(), PROJECT_SETTINGS_DIR);
}

export function getLegacyGrokHome(): string {
  return path.join(getHomeDir(), LEGACY_PROJECT_SETTINGS_DIR);
}

export const USER_SETTINGS_PATH = path.join(getClawdHome(), "user-settings.json");
export const WORKSPACE_TRUST_PATH = path.join(getClawdHome(), "workspace-trust.json");
export const INSTALL_METADATA_PATH = path.join(getClawdHome(), "install-metadata.json");

// === User Settings ===

let userSettingsCache: ClawdSettings | null = null;

export function loadUserSettings(): ClawdSettings {
  if (userSettingsCache) return userSettingsCache;
  try {
    if (fs.existsSync(USER_SETTINGS_PATH)) {
      const raw = fs.readFileSync(USER_SETTINGS_PATH, "utf-8");
      userSettingsCache = JSON.parse(raw) as ClawdSettings;
      return userSettingsCache;
    }
  } catch {
    // Silently ignore parse errors
  }
  userSettingsCache = {};
  return userSettingsCache;
}

export function saveUserSettings(partial: Partial<ClawdSettings>): void {
  const current = loadUserSettings();
  const merged: ClawdSettings = { ...current, ...partial };
  // Deep merge for nested objects
  if (partial.subAgents) merged.subAgents = partial.subAgents;
  if (partial.hooks) merged.hooks = { ...current.hooks, ...partial.hooks };
  if (partial.telegram) merged.telegram = { ...current.telegram, ...partial.telegram };
  if (partial.mcpServers) merged.mcpServers = { ...current.mcpServers, ...partial.mcpServers };
  if (partial.providerApiKeys) {
    merged.providerApiKeys = { ...current.providerApiKeys, ...partial.providerApiKeys };
  }
  if (partial.providerBaseURLs) {
    merged.providerBaseURLs = { ...current.providerBaseURLs, ...partial.providerBaseURLs };
  }

  fs.mkdirSync(getClawdHome(), { recursive: true });
  fs.writeFileSync(USER_SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf-8");
  userSettingsCache = merged;
}

// === Project Settings ===

let projectSettingsCache: Map<string, ClawdSettings> = new Map();

function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, PROJECT_SETTINGS_DIR, "settings.json");
}

export function loadProjectSettings(cwd: string): ClawdSettings {
  const cached = projectSettingsCache.get(cwd);
  if (cached) return cached;

  try {
    const settingsPath = getProjectSettingsPath(cwd);
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as ClawdSettings;
      projectSettingsCache.set(cwd, parsed);
      return parsed;
    }
  } catch {
    // Silently ignore parse errors
  }

  const empty: ClawdSettings = {};
  projectSettingsCache.set(cwd, empty);
  return empty;
}

export function saveProjectSettings(cwd: string, partial: Partial<ClawdSettings>): void;
export function saveProjectSettings(partial: Partial<ClawdSettings>): void;
export function saveProjectSettings(
  cwdOrPartial: string | Partial<ClawdSettings>,
  maybePartial?: Partial<ClawdSettings>,
): void {
  const cwd = typeof cwdOrPartial === "string" ? cwdOrPartial : process.cwd();
  const partial = typeof cwdOrPartial === "string" ? (maybePartial ?? {}) : cwdOrPartial;
  const current = loadProjectSettings(cwd);
  const merged: ClawdSettings = { ...current, ...partial };
  if (partial.mcpServers) merged.mcpServers = { ...current.mcpServers, ...partial.mcpServers };

  const dir = path.join(cwd, PROJECT_SETTINGS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getProjectSettingsPath(cwd), JSON.stringify(merged, null, 2), "utf-8");
  projectSettingsCache.set(cwd, merged);
}

// === API Key Resolution ===

// Priority: env var > provider-scoped user settings > legacy user settings.

export function getApiKey(provider: ProviderId = DEFAULT_PROVIDER): string | undefined {
  const envKey = getProviderApiKeyFromEnv(provider);
  if (envKey) return envKey;

  const userSettings = loadUserSettings();
  const providerSettingsKey = userSettings.providerApiKeys?.[provider];
  if (providerSettingsKey) return providerSettingsKey;

  const settingsKey =
    provider === "xai" || provider === "custom"
      ? (((userSettings as Record<string, unknown>).aiKey as string | undefined) ||
          ((userSettings as Record<string, unknown>).apiKey as string | undefined))
      : undefined;
  if (settingsKey) return settingsKey;

  return undefined;
}

export function getBaseURL(provider: ProviderId = DEFAULT_PROVIDER): string {
  const envURL = getProviderBaseURLFromEnv(provider);
  if (envURL) return envURL;

  const userSettings = loadUserSettings();
  const providerSettingsURL = userSettings.providerBaseURLs?.[provider];
  if (providerSettingsURL) return providerSettingsURL;

  if ((provider === "xai" || provider === "custom") && userSettings.baseURL) {
    return userSettings.baseURL;
  }

  return getProviderDefinition(provider).defaultBaseURL;
}

export function getCurrentProvider(model?: string): ProviderId {
  const modelProvider = model ? getModelProvider(model) : undefined;
  if (modelProvider) return modelProvider;

  const envProvider = normalizeProviderId(process.env.CLAWD_PROVIDER || process.env.AI_PROVIDER || process.env.GROK_PROVIDER);
  if (envProvider) return envProvider;

  const settings = loadUserSettings();
  return settings.provider ?? settings.defaultProvider ?? DEFAULT_PROVIDER;
}

export function getCurrentToolsets(): string[] {
  const envToolsets = parseToolsets(process.env.CLAWD_TOOLSETS);
  if (envToolsets.length > 0) return envToolsets;
  return parseToolsets(loadUserSettings().toolsets);
}

function getProviderApiKeyFromEnv(provider: ProviderId): string | undefined {
  switch (provider) {
    case "xai":
      return process.env.XAI_API_KEY || process.env.AI_API_KEY || process.env.GROK_API_KEY;
    case "zai":
      return process.env.ZAI_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "openrouter":
      return process.env.OPENROUTER_API_KEY;
    case "deepseek":
      return process.env.DEEPSEEK_API_KEY;
    case "custom":
      return process.env.CLAWD_API_KEY || process.env.AI_API_KEY;
  }
}

function getProviderBaseURLFromEnv(provider: ProviderId): string | undefined {
  switch (provider) {
    case "xai":
      return process.env.XAI_BASE_URL || process.env.AI_BASE_URL || process.env.GROK_BASE_URL;
    case "zai":
      return process.env.ZAI_BASE_URL;
    case "openai":
      return process.env.OPENAI_BASE_URL;
    case "openrouter":
      return process.env.OPENROUTER_BASE_URL;
    case "deepseek":
      return process.env.DEEPSEEK_BASE_URL;
    case "custom":
      return process.env.CLAWD_BASE_URL || process.env.AI_BASE_URL;
  }
}

function parseToolsets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

// === Solana / Phoenix Config ===

export function getSolanaConfig(): SolanaConfig {
  return {
    rpcUrl: process.env.SOLANA_TRACKER_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    apiUrl: process.env.PHOENIX_API_URL || "https://perp-api.phoenix.trade",
    apiKey: process.env.PHOENIX_API_KEY,
  };
}

export function getSolanaTrackerConfig() {
  return {
    apiKey: process.env.SOLANA_TRACKER_API_KEY,
    rpcUrl: process.env.SOLANA_TRACKER_RPC_URL,
    wssUrl: process.env.SOLANA_TRACKER_WSS_URL,
    dataUrl: process.env.SOLANA_TRACKER_URL || "https://data.solanatracker.io",
  };
}

// === Sandbox Settings ===

export type SandboxMode = "shuru" | "off";

let sandboxOverride: { mode: SandboxMode; settings: SandboxSettings } | null = null;

export interface SandboxSettings {
  allowNet?: boolean;
  allowedHosts?: string[];
  allowEphemeralInstall?: boolean;
  hostBrowserCommandsOnHost?: boolean;
  ports?: string[];
  cpus?: number;
  memory?: string | number;
  diskSize?: string | number;
  checkpoint?: string;
  from?: string;
  verifyBaseFrom?: string;
  guestWorkdir?: string;
  syncHostWorkspace?: boolean;
  shellInit?: string[];
  secrets?: Array<{ name: string; fromEnv: string; hosts: string[] }>;
  [key: string]: unknown;
}

export function getCurrentSandboxMode(): SandboxMode {
  if (sandboxOverride) return sandboxOverride.mode;
  const userSettings = loadUserSettings();
  const configured = (userSettings as Record<string, unknown>).sandboxMode as SandboxMode | undefined;
  return configured || "off";
}

export function setCurrentSandboxMode(mode: SandboxMode): void {
  if (!sandboxOverride) sandboxOverride = { mode, settings: {} };
  sandboxOverride.mode = mode;
}

export function getCurrentSandboxSettings(): SandboxSettings {
  if (sandboxOverride) return sandboxOverride.settings;
  const userSettings = loadUserSettings();
  const configured = (userSettings as Record<string, unknown>).sandboxSettings as SandboxSettings | undefined;
  return configured || {};
}

export function mergeSandboxSettings(base: SandboxSettings, overrides: SandboxSettings): SandboxSettings {
  return {
    allowNet: overrides.allowNet ?? base.allowNet,
    allowedHosts: overrides.allowedHosts ?? base.allowedHosts,
    allowEphemeralInstall: overrides.allowEphemeralInstall ?? base.allowEphemeralInstall,
    hostBrowserCommandsOnHost: overrides.hostBrowserCommandsOnHost ?? base.hostBrowserCommandsOnHost,
    ports: overrides.ports ?? base.ports,
    cpus: overrides.cpus ?? base.cpus,
    memory: overrides.memory ?? base.memory,
    diskSize: overrides.diskSize ?? base.diskSize,
    checkpoint: overrides.checkpoint ?? base.checkpoint,
    from: overrides.from ?? base.from,
    verifyBaseFrom: overrides.verifyBaseFrom ?? base.verifyBaseFrom,
    guestWorkdir: overrides.guestWorkdir ?? base.guestWorkdir,
    syncHostWorkspace: overrides.syncHostWorkspace ?? base.syncHostWorkspace,
    shellInit: overrides.shellInit ?? base.shellInit,
    secrets: overrides.secrets ?? base.secrets,
  };
}

export function normalizeSandboxSettings(value: unknown): SandboxSettings {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    allowNet: typeof raw.allowNet === "boolean" ? raw.allowNet : undefined,
    allowedHosts: Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.filter((v): v is string => typeof v === "string")
      : undefined,
    allowEphemeralInstall: typeof raw.allowEphemeralInstall === "boolean" ? raw.allowEphemeralInstall : undefined,
    hostBrowserCommandsOnHost:
      typeof raw.hostBrowserCommandsOnHost === "boolean" ? raw.hostBrowserCommandsOnHost : undefined,
    ports: Array.isArray(raw.ports) ? raw.ports.filter((v): v is string => typeof v === "string") : undefined,
    cpus: typeof raw.cpus === "number" ? raw.cpus : undefined,
    memory:
      typeof raw.memory === "string" ? raw.memory : typeof raw.memory === "number" ? String(raw.memory) : undefined,
    diskSize:
      typeof raw.diskSize === "string" ? raw.diskSize : typeof raw.diskSize === "number" ? raw.diskSize : undefined,
    checkpoint: typeof raw.checkpoint === "string" ? raw.checkpoint : undefined,
    from: typeof raw.from === "string" ? raw.from : undefined,
    verifyBaseFrom: typeof raw.verifyBaseFrom === "string" ? raw.verifyBaseFrom : undefined,
    guestWorkdir: typeof raw.guestWorkdir === "string" ? raw.guestWorkdir : undefined,
    syncHostWorkspace: typeof raw.syncHostWorkspace === "boolean" ? raw.syncHostWorkspace : undefined,
    shellInit: Array.isArray(raw.shellInit)
      ? raw.shellInit.filter((v): v is string => typeof v === "string")
      : undefined,
    secrets: Array.isArray(raw.secrets)
      ? raw.secrets.filter((entry): entry is { name: string; fromEnv: string; hosts: string[] } => {
          if (typeof entry !== "object" || entry === null) return false;
          const secret = entry as Record<string, unknown>;
          return (
            typeof secret.name === "string" &&
            typeof secret.fromEnv === "string" &&
            Array.isArray(secret.hosts) &&
            secret.hosts.every((host) => typeof host === "string")
          );
        })
      : undefined,
  };
}

// === Payment Settings ===

export interface PaymentSettings {
  enabled: boolean;
  chain: string;
  approval: { autoApprove?: boolean; [key: string]: unknown };
  walletAddress: string;
}

let paymentSettingsCache: PaymentSettings | null = null;
const PAYMENT_SETTINGS_PATH = path.join(getClawdHome(), "payment-settings.json");

export function loadPaymentSettings(): PaymentSettings {
  if (paymentSettingsCache) return paymentSettingsCache;
  try {
    if (fs.existsSync(PAYMENT_SETTINGS_PATH)) {
      const raw = fs.readFileSync(PAYMENT_SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(raw) as PaymentSettings & { approval?: unknown };
      paymentSettingsCache = {
        ...parsed,
        approval:
          typeof parsed.approval === "object" && parsed.approval !== null
            ? parsed.approval
            : { autoApprove: parsed.approval === "auto" },
      };
      return paymentSettingsCache;
    }
  } catch {
    // ignore
  }
  paymentSettingsCache = { enabled: false, chain: "solana", approval: { autoApprove: false }, walletAddress: "" };
  return paymentSettingsCache;
}

export function savePaymentSettings(partial: Partial<PaymentSettings>): void {
  const current = loadPaymentSettings();
  const merged = { ...current, ...partial };
  fs.mkdirSync(getClawdHome(), { recursive: true });
  fs.writeFileSync(PAYMENT_SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf-8");
  paymentSettingsCache = merged;
}

// === Telegram Settings Helper ===

export function getTelegramBotToken(): string | undefined {
  const env = process.env.TELEGRAM_BOT_TOKEN;
  if (env) return env;
  const userSettings = loadUserSettings();
  return userSettings.telegram?.botToken;
}

export type CustomSubagentConfig = SubAgentConfig;
export type TelegramSettings = NonNullable<ClawdSettings["telegram"]>;
export type PaymentChain = string;
export type McpRemoteTransport = "stdio" | "sse" | "http";
export type LspSettings = NormalizedLspSettings;

const MODE_DEFAULTS: Record<string, string> = {
  agent: "grok-4.3",
  explore: "grok-4.3",
  vision: "grok-4.3",
  verify: "grok-4.3",
  general: "grok-4.3",
};

export function getModeSpecificModel(mode?: AgentMode): string | undefined {
  if (!mode) return undefined;
  return MODE_DEFAULTS[mode];
}

export function getCurrentModel(mode?: AgentMode): string {
  const envModel = process.env.CLAWD_MODEL || process.env.GROK_MODEL;
  if (envModel?.trim()) return normalizeModelId(envModel.trim());
  const settingsModel = loadUserSettings().defaultModel;
  if (settingsModel?.trim()) return normalizeModelId(settingsModel.trim());
  return normalizeModelId(getModeSpecificModel(mode) || DEFAULT_MODEL);
}

export function resolveProviderModelSelection(args: {
  provider?: ProviderId;
  model?: string;
  mode?: AgentMode;
}): { provider: ProviderId; model: string } {
  const model = normalizeModelId(args.model || getCurrentModel(args.mode));
  const provider = args.provider ?? getCurrentProvider(args.model) ?? resolveModelRoute(model).provider;
  const route = resolveModelRoute(model, provider);
  return { provider: route.provider, model: route.modelId };
}

export function parseSubAgentsRawList(value: unknown): SubAgentConfig[] {
  if (!Array.isArray(value)) return [];
  const reserved = new Set(["general", "explore", "vision", "verify", "computer"]);
  const seen = new Set<string>();
  const parsed: SubAgentConfig[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const instruction = typeof raw.instruction === "string" ? raw.instruction : "";
    const model = typeof raw.model === "string" ? normalizeModelId(raw.model) : "";
    if (!name || reserved.has(name.toLowerCase()) || seen.has(name.toLowerCase())) continue;
    if (!model || !getModelInfo(model)) continue;
    seen.add(name.toLowerCase());
    parsed.push({ name, model, instruction });
  }
  return parsed;
}

export function loadValidSubAgents(): SubAgentConfig[] {
  return parseSubAgentsRawList(loadUserSettings().subAgents);
}

export function loadMcpServers(): McpServerConfig[] {
  const servers = loadUserSettings().mcpServers;
  if (Array.isArray(servers)) return servers;
  return servers ? Object.values(servers) : [];
}

export function loadRecapsEnabled(): boolean {
  return true;
}

export function getReasoningEffortForModel(_modelId: string): string | undefined {
  return undefined;
}

export function getCurrentLspSettings(): LspSettings {
  return {
    enabled: true,
    tool: true,
    autoInstall: true,
    startupTimeoutMs: 10_000,
    diagnosticsDebounceMs: 250,
    builtins: {},
    servers: [],
  };
}

export function isReservedSubagentName(name: string): boolean {
  return new Set(["general", "explore", "vision", "verify", "computer"]).has(name.trim().toLowerCase());
}

export function saveMcpServers(servers: McpServerConfig[]): void {
  saveUserSettings({ mcpServers: servers });
}

export function saveRecapsEnabled(_enabled: boolean): void {}

export function saveApprovedTelegramUserId(userId: number | string): void {
  const settings = loadUserSettings();
  const current = settings.telegram?.approvedUserIds ?? [];
  const normalized = Number(userId);
  if (!Number.isFinite(normalized)) return;
  saveUserSettings({
    telegram: {
      ...settings.telegram,
      approvedUserIds: current.includes(normalized) ? current : [...current, normalized],
    },
  });
}

export function resolveTelegramStreamSettings(_settings?: TelegramSettings): {
  enabled: boolean;
  approvedUserIds: number[];
  streaming: "on" | "off";
  typingIndicator: boolean;
} {
  const telegram = loadUserSettings().telegram;
  return {
    enabled: Boolean(telegram?.botToken),
    approvedUserIds: (telegram?.approvedUserIds ?? []).map(Number).filter(Number.isFinite),
    streaming: "on",
    typingIndicator: true,
  };
}

export function resolveTelegramAudioInputSettings(telegramSettings: TelegramSettings | undefined): {
  enabled: boolean;
  language: string;
} {
  const audioInput = telegramSettings?.audioInput;
  return {
    enabled: typeof audioInput?.enabled === "boolean" ? audioInput.enabled : true,
    language: typeof audioInput?.language === "string" && audioInput.language.trim() ? audioInput.language : "en",
  };
}

// === Clear caches (useful for testing) ===

export function clearSettingsCache(): void {
  userSettingsCache = null;
  projectSettingsCache = new Map();
  paymentSettingsCache = null;
  sandboxOverride = null;
}
