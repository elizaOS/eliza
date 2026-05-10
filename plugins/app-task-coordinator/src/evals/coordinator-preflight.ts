import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getElizaNamespace,
  resolveStateDir,
  resolveUserPath,
} from "@elizaos/core";
import {
  CoordinatorEvalClient,
  resolveCoordinatorEvalBaseUrl,
} from "./coordinator-eval-client.js";
import type { CoordinatorEvalChannel } from "./coordinator-scenarios.js";

type PreflightStatus = "pass" | "warn" | "fail";

export interface CoordinatorPreflightCheck {
  id: string;
  status: PreflightStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface CoordinatorChannelReadiness {
  channel: CoordinatorEvalChannel;
  connectorKeys: string[];
  configured: boolean;
  configReady: boolean;
  healthStatuses: Record<string, string>;
  available: boolean;
  reason: string;
}

export interface CoordinatorPreflightResult {
  ok: boolean;
  baseUrl: string;
  configPath: string;
  availableChannels: CoordinatorEvalChannel[];
  supportedConnectors: CoordinatorEvalChannel[];
  channelReadiness: CoordinatorChannelReadiness[];
  shareCapabilities: string[];
  checks: CoordinatorPreflightCheck[];
}

type FrameworkAvailability = {
  id?: string;
  installed?: boolean;
  authReady?: boolean;
  subscriptionReady?: boolean;
  reason?: string;
};

const SUPPORTED_CONNECTOR_CHANNELS: Exclude<
  CoordinatorEvalChannel,
  "app_chat"
>[] = [
  "discord",
  "telegram",
  "slack",
  "whatsapp",
  "signal",
  "matrix",
  "wechat",
];

const CHANNEL_CONNECTOR_KEYS: Record<
  Exclude<CoordinatorEvalChannel, "app_chat">,
  string[]
> = {
  discord: ["discord"],
  telegram: ["telegram", "telegramAccount"],
  slack: ["slack"],
  whatsapp: ["whatsapp"],
  signal: ["signal"],
  matrix: ["matrix"],
  wechat: ["wechat"],
};

function isConnectorConfigured(
  connectorName: string,
  connectorConfig: unknown,
): boolean {
  if (!connectorConfig || typeof connectorConfig !== "object") {
    return false;
  }

  const config = connectorConfig as Record<string, unknown>;
  if (config.enabled === false) {
    return false;
  }
  if (config.botToken || config.token || config.apiKey) {
    return true;
  }

  const hasEnabledSignalAccount =
    connectorName === "signal" &&
    typeof config.accounts === "object" &&
    config.accounts !== null &&
    Object.values(config.accounts as Record<string, unknown>).some(
      (account) => {
        if (!account || typeof account !== "object") return false;
        const accountConfig = account as Record<string, unknown>;
        if (accountConfig.enabled === false) return false;
        return Boolean(
          accountConfig.authDir ||
            accountConfig.account ||
            accountConfig.httpUrl ||
            accountConfig.httpHost ||
            accountConfig.httpPort ||
            accountConfig.cliPath,
        );
      },
    );

  if (hasEnabledSignalAccount) {
    return true;
  }

  switch (connectorName) {
    case "bluebubbles":
      return Boolean(config.serverUrl && config.password);
    case "discordLocal":
      return Boolean(config.clientId && config.clientSecret);
    case "imessage":
      return Boolean(config.cliPath);
    case "signal":
      return Boolean(
        config.authDir ||
          config.account ||
          config.httpUrl ||
          config.httpHost ||
          config.httpPort ||
          config.cliPath,
      );
    case "whatsapp":
      return Boolean(
        config.authState ||
          config.sessionPath ||
          config.authDir ||
          (config.accounts &&
            typeof config.accounts === "object" &&
            Object.values(config.accounts as Record<string, unknown>).some(
              (account) => {
                if (!account || typeof account !== "object") return false;
                const acc = account as Record<string, unknown>;
                if (acc.enabled === false) return false;
                return Boolean(acc.authDir);
              },
            )),
      );
    case "twitch":
      return Boolean(
        config.accessToken || config.clientId || config.enabled === true,
      );
    default:
      return false;
  }
}

function getHomeDir(): string {
  return (
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir()
  );
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveElizaConfigPath(): string {
  const explicit = process.env.ELIZA_CONFIG_PATH?.trim();
  if (explicit) return resolveUserPath(explicit);
  const namespace = getElizaNamespace();
  return path.join(resolveStateDir(), `${namespace}.json`);
}

function commandExists(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

function detectShareCapabilities(
  config: Record<string, unknown> | null,
): string[] {
  const capabilities: string[] = [];
  const gateway =
    config && typeof config.gateway === "object" && config.gateway
      ? (config.gateway as Record<string, unknown>)
      : null;
  const gatewayTailscale =
    gateway && typeof gateway.tailscale === "object" && gateway.tailscale
      ? (gateway.tailscale as Record<string, unknown>)
      : null;
  const gatewayRemote =
    gateway && typeof gateway.remote === "object" && gateway.remote
      ? (gateway.remote as Record<string, unknown>)
      : null;

  const tailscaleMode =
    typeof gatewayTailscale?.mode === "string" ? gatewayTailscale.mode : null;
  if (tailscaleMode && tailscaleMode !== "off") {
    capabilities.push(`tailscale:${tailscaleMode}`);
  }
  if (typeof gatewayRemote?.url === "string" && gatewayRemote.url.trim()) {
    capabilities.push("gateway-remote-url");
  }
  if (
    typeof gatewayRemote?.sshTarget === "string" &&
    gatewayRemote.sshTarget.trim()
  ) {
    capabilities.push("gateway-remote-ssh");
  }
  if (typeof gateway?.mode === "string" && gateway.mode === "remote") {
    capabilities.push("gateway-remote-mode");
  }

  return capabilities;
}

function normalizeConnectorConfig(
  connectors: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(connectors)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    normalized[key] = value as Record<string, unknown>;
  }
  return normalized;
}

function normalizeConnectorHealth(
  connectors: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!connectors) return normalized;
  for (const [key, value] of Object.entries(connectors)) {
    if (typeof value !== "string" || !value.trim()) continue;
    normalized[key] = value.trim();
  }
  return normalized;
}

function connectorKeysForChannel(
  channel: Exclude<CoordinatorEvalChannel, "app_chat">,
): string[] {
  return CHANNEL_CONNECTOR_KEYS[channel];
}

function buildChannelReadiness(params: {
  connectorConfig: Record<string, Record<string, unknown>>;
  connectorHealth: Record<string, string>;
}): CoordinatorChannelReadiness[] {
  const readiness: CoordinatorChannelReadiness[] = [
    {
      channel: "app_chat",
      connectorKeys: [],
      configured: true,
      configReady: true,
      healthStatuses: {},
      available: true,
      reason: "App chat is always available when the Eliza API is reachable.",
    },
  ];

  for (const channel of SUPPORTED_CONNECTOR_CHANNELS) {
    const connectorKeys = connectorKeysForChannel(channel);
    const configuredKeys = connectorKeys.filter(
      (key) => params.connectorConfig[key] !== undefined,
    );
    const healthStatuses = Object.fromEntries(
      connectorKeys.flatMap((key) =>
        typeof params.connectorHealth[key] === "string"
          ? [[key, params.connectorHealth[key]]]
          : [],
      ),
    );
    const configReady = configuredKeys.some((key) =>
      isConnectorConfigured(key, params.connectorConfig[key]),
    );
    const available = connectorKeys.some(
      (key) =>
        typeof params.connectorHealth[key] === "string" &&
        params.connectorHealth[key] === "ok" &&
        params.connectorConfig[key] !== undefined &&
        isConnectorConfigured(key, params.connectorConfig[key]),
    );

    let reason: string;
    if (available) {
      reason = "Eliza reported a live connector runtime for this channel.";
    } else if (configuredKeys.length === 0) {
      reason = "This channel is not configured in Eliza.";
    } else if (!configReady) {
      reason =
        "This channel is present in config but is missing required credentials or auth state.";
    } else if (Object.values(healthStatuses).includes("missing")) {
      reason =
        "This channel is configured, but the runtime did not load its connector plugin.";
    } else if (Object.values(healthStatuses).includes("configured")) {
      reason =
        "This channel is configured, but Eliza has not confirmed a live connector runtime yet.";
    } else if (Object.values(healthStatuses).includes("unknown")) {
      reason =
        "This channel is configured, but the connector health monitor could not classify its runtime state.";
    } else if (Object.keys(healthStatuses).length === 0) {
      reason =
        "This channel is configured, but Eliza did not report runtime health for it.";
    } else {
      reason = "This channel is not currently available for live evaluation.";
    }

    readiness.push({
      channel,
      connectorKeys,
      configured: configuredKeys.length > 0,
      configReady,
      healthStatuses,
      available,
      reason,
    });
  }

  return readiness;
}

export async function runCoordinatorPreflight(options?: {
  baseUrl?: string;
}): Promise<CoordinatorPreflightResult> {
  const baseUrl = resolveCoordinatorEvalBaseUrl(options?.baseUrl);
  const client = new CoordinatorEvalClient(baseUrl);
  const configPath = resolveElizaConfigPath();
  const config = readJsonFile(configPath);
  const checks: CoordinatorPreflightCheck[] = [];

  const addCheck = (
    id: string,
    status: PreflightStatus,
    summary: string,
    details?: Record<string, unknown>,
  ): void => {
    checks.push({ id, status, summary, ...(details ? { details } : {}) });
  };

  addCheck(
    "local-cli-codex",
    commandExists("codex") ? "pass" : "fail",
    commandExists("codex")
      ? "Codex CLI is installed."
      : "Codex CLI is not installed.",
  );
  addCheck(
    "local-cli-claude",
    commandExists("claude") ? "pass" : "fail",
    commandExists("claude")
      ? "Claude Code CLI is installed."
      : "Claude Code CLI is not installed.",
  );
  addCheck(
    "local-auth-files",
    fs.existsSync(path.join(getHomeDir(), ".codex", "auth.json")) ||
      fs.existsSync(path.join(getHomeDir(), ".claude", ".credentials.json"))
      ? "pass"
      : "warn",
    "Local Codex/Claude auth files were inspected.",
    {
      codexAuthFile: fs.existsSync(
        path.join(getHomeDir(), ".codex", "auth.json"),
      ),
      claudeCredentialsFile: fs.existsSync(
        path.join(getHomeDir(), ".claude", ".credentials.json"),
      ),
    },
  );

  const shareCapabilities = detectShareCapabilities(config);
  addCheck(
    "share-capabilities",
    shareCapabilities.length > 0 ? "pass" : "warn",
    shareCapabilities.length > 0
      ? "Share or remote-preview capabilities were discovered in config."
      : "No explicit remote share capability was discovered in config.",
    { shareCapabilities, configPath },
  );

  let coordinatorStatusResponse:
    | {
        frameworks?: FrameworkAvailability[];
      }
    | undefined;
  try {
    coordinatorStatusResponse = await client.requestJson<{
      frameworks?: FrameworkAvailability[];
    }>("/api/coding-agents/coordinator/status");
  } catch (error) {
    addCheck(
      "eliza-api",
      "fail",
      "Eliza API is not reachable at the configured base URL.",
      {
        baseUrl,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return {
      ok: false,
      baseUrl,
      configPath,
      availableChannels: [],
      supportedConnectors: SUPPORTED_CONNECTOR_CHANNELS,
      channelReadiness: [],
      shareCapabilities,
      checks,
    };
  }

  const subscriptionStatus = await client.requestJson<{
    providers?: Array<{
      provider?: string;
      configured?: boolean;
      valid?: boolean;
      expiresAt?: number | null;
    }>;
  }>("/api/subscription/status");
  const providerMap = new Map(
    (subscriptionStatus.providers ?? []).flatMap((provider) =>
      provider.provider ? [[provider.provider, provider]] : [],
    ),
  );
  const codexProvider = providerMap.get("openai-codex");
  const claudeProvider = providerMap.get("anthropic-subscription");
  addCheck(
    "subscription-openai-codex",
    codexProvider?.configured && codexProvider.valid ? "pass" : "fail",
    codexProvider?.configured && codexProvider.valid
      ? "OpenAI Codex subscription is configured and valid."
      : "OpenAI Codex subscription is missing or invalid.",
    codexProvider,
  );
  addCheck(
    "subscription-anthropic",
    claudeProvider?.configured && claudeProvider.valid ? "pass" : "fail",
    claudeProvider?.configured && claudeProvider.valid
      ? "Claude subscription is configured and valid for task-agent use."
      : "Claude subscription is missing or invalid for task-agent use.",
    claudeProvider,
  );

  const frameworks = Array.isArray(coordinatorStatusResponse?.frameworks)
    ? coordinatorStatusResponse.frameworks
    : [];
  const frameworkMap = new Map(
    frameworks.flatMap((framework) =>
      framework.id ? [[framework.id, framework]] : [],
    ),
  );
  for (const id of ["codex", "claude"] as const) {
    const framework = frameworkMap.get(id);
    const ready =
      framework?.installed === true &&
      (framework.authReady === true || framework.subscriptionReady === true);
    addCheck(
      `framework-${id}`,
      ready ? "pass" : "fail",
      ready
        ? `${id} is installed and ready for coordinator task execution.`
        : `${id} is not ready for coordinator task execution.`,
      framework as Record<string, unknown> | undefined,
    );
  }

  const trajectoryConfig = await client.requestJson<{ enabled?: boolean }>(
    "/api/trajectories/config",
  );
  addCheck(
    "trajectory-logging",
    trajectoryConfig.enabled === true ? "pass" : "fail",
    trajectoryConfig.enabled === true
      ? "Trajectory logging is enabled."
      : "Trajectory logging is disabled.",
    trajectoryConfig as Record<string, unknown>,
  );

  const connectorsResponse = await client.requestJson<{
    connectors?: Record<string, unknown>;
  }>("/api/connectors");
  const healthResponse = await client.requestJson<{
    connectors?: Record<string, unknown>;
  }>("/api/health");
  const connectorConfig = normalizeConnectorConfig(
    connectorsResponse.connectors ?? {},
  );
  const connectorHealth = normalizeConnectorHealth(healthResponse.connectors);
  const channelReadiness = buildChannelReadiness({
    connectorConfig,
    connectorHealth,
  });
  const availableChannels = channelReadiness
    .filter((channel) => channel.available)
    .map((channel) => channel.channel);
  const readyConnectorChannels = channelReadiness
    .filter((channel) => channel.channel !== "app_chat" && channel.available)
    .map((channel) => channel.channel);
  const configuredConnectorChannels = channelReadiness
    .filter((channel) => channel.channel !== "app_chat" && channel.configured)
    .map((channel) => channel.channel);
  addCheck(
    "connectors",
    readyConnectorChannels.length > 0
      ? "pass"
      : configuredConnectorChannels.length > 0
        ? "fail"
        : "warn",
    readyConnectorChannels.length > 0
      ? "At least one external connector is live and ready for evaluation."
      : configuredConnectorChannels.length > 0
        ? "External connectors are configured, but none are currently live."
        : "No external connectors are configured; live eval coverage is limited to app chat.",
    {
      readyChannels: readyConnectorChannels,
      configuredChannels: configuredConnectorChannels,
      supportedConnectorChannels: SUPPORTED_CONNECTOR_CHANNELS,
      connectorHealth,
    },
  );
  for (const readiness of channelReadiness) {
    if (readiness.channel === "app_chat") continue;
    addCheck(
      `channel-${readiness.channel}`,
      readiness.available ? "pass" : readiness.configured ? "fail" : "warn",
      readiness.reason,
      readiness as unknown as Record<string, unknown>,
    );
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    baseUrl,
    configPath,
    availableChannels,
    supportedConnectors: SUPPORTED_CONNECTOR_CHANNELS,
    channelReadiness,
    shareCapabilities,
    checks,
  };
}
