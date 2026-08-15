/**
 * Lightweight connector health monitor.
 *
 * Periodically checks whether configured connectors (Discord, Telegram, etc.)
 * still have their corresponding plugin loaded. On status transition to
 * "missing", broadcasts a system-warning via WebSocket.
 */

import { type AgentRuntime, ElizaError } from "@elizaos/core";

export type ConnectorStatus = "ok" | "missing" | "unknown";

type PollerHealthProbe = {
  getPollerHealth: () =>
    | { ok?: boolean; connected?: boolean; lastError?: string }
    | Promise<{ ok?: boolean; connected?: boolean; lastError?: string }>;
};

export interface ConnectorHealthMonitorOptions {
  runtime: AgentRuntime;
  config: { connectors?: Record<string, unknown> };
  broadcastWs: (payload: object) => void;
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Resolves the owner-facing interval before the API server binds. The monitor
 * receives only this validated number, so its deferred post-listen startup has
 * no configuration failure left for the best-effort boundary to hide.
 */
export function resolveConnectorHealthIntervalMs(
  envVal: string | undefined,
): number {
  if (envVal === undefined || envVal === "") return DEFAULT_INTERVAL_MS;

  const parsed = Number(envVal);
  if (
    !/^[1-9][0-9]*$/.test(envVal) ||
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_INTERVAL_MS ||
    parsed > MAX_INTERVAL_MS
  ) {
    throw new ElizaError(
      `Invalid CONNECTOR_HEALTH_INTERVAL_MS value ${JSON.stringify(envVal)}: expected an exact decimal integer from ${MIN_INTERVAL_MS} through ${MAX_INTERVAL_MS}`,
      {
        code: "CONNECTOR_HEALTH_INTERVAL_INVALID",
        context: {
          setting: "CONNECTOR_HEALTH_INTERVAL_MS",
          configured: envVal,
          minimum: MIN_INTERVAL_MS,
          maximum: MAX_INTERVAL_MS,
        },
        severity: "fatal",
      },
    );
  }
  return parsed;
}

/**
 * Maps connector config keys to the service/client name the plugin registers.
 *
 * Kept aligned with CONNECTOR_PLUGINS in plugin-auto-enable.ts — every
 * connector that can be configured should be probeable here so that cloud
 * and local agents get the same health monitoring coverage.
 */
export const CONNECTOR_PLUGIN_MAP: Record<string, string> = {
  bluebubbles: "bluebubbles",
  discord: "discord",
  discordLocal: "discord-local",
  telegram: "telegram",
  telegramAccount: "telegram-account",
  twitter: "twitter",
  slack: "slack",
  farcaster: "farcaster",
  lens: "lens",
  whatsapp: "whatsapp",
  signal: "signal",
  imessage: "imessage",
  msteams: "msteams",
  feishu: "feishu",
  matrix: "matrix",
  nostr: "nostr",
  blooio: "blooio",
  twitch: "twitch",
  mattermost: "mattermost",
  googlechat: "google-chat",
  wechat: "wechat",
};
const CONNECTOR_PLUGIN_MAP_NORMALIZED = Object.fromEntries(
  Object.entries(CONNECTOR_PLUGIN_MAP).map(([connectorName, pluginName]) => [
    connectorName.toLowerCase(),
    pluginName,
  ]),
);

function hasPollerHealthProbe(service: unknown): service is PollerHealthProbe {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as PollerHealthProbe).getPollerHealth === "function"
  );
}

export class ConnectorHealthMonitor {
  private runtime: AgentRuntime;
  private config: { connectors?: Record<string, unknown> };
  private broadcastWs: (payload: object) => void;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statuses: Map<string, ConnectorStatus> = new Map();

  constructor(opts: ConnectorHealthMonitorOptions) {
    this.runtime = opts.runtime;
    this.config = opts.config;
    this.broadcastWs = opts.broadcastWs;
    this.intervalMs = opts.intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getConnectorStatuses(): Record<string, ConnectorStatus> {
    const result: Record<string, ConnectorStatus> = {};
    for (const [name, status] of this.statuses) {
      result[name] = status;
    }
    return result;
  }

  private getConfiguredConnectors(): string[] {
    const connectors = this.config.connectors;
    if (!connectors) return [];

    const result: string[] = [];
    for (const [name, cfg] of Object.entries(connectors)) {
      if (
        cfg &&
        typeof cfg === "object" &&
        (cfg as Record<string, unknown>).enabled !== false
      ) {
        result.push(name);
      }
    }
    return result;
  }

  private async probeConnector(name: string): Promise<ConnectorStatus> {
    const pluginName =
      CONNECTOR_PLUGIN_MAP[name] ??
      CONNECTOR_PLUGIN_MAP_NORMALIZED[name.toLowerCase()];
    if (!pluginName) return "unknown";

    const service = this.runtime.getService(pluginName);
    if (service) {
      if (hasPollerHealthProbe(service)) {
        const health = await service.getPollerHealth();
        return health.ok === true && health.connected === true
          ? "ok"
          : "missing";
      }
      return "ok";
    }

    // Also check runtime.clients if available
    const clients = (
      this.runtime as typeof this.runtime & {
        clients?: Record<string, unknown>;
      }
    ).clients;
    if (clients?.[pluginName]) return "ok";

    return "missing";
  }

  async check(): Promise<void> {
    const configured = this.getConfiguredConnectors();

    for (const name of configured) {
      const newStatus = await this.probeConnector(name);
      const prevStatus = this.statuses.get(name);

      if (newStatus === "missing" && prevStatus !== "missing") {
        this.broadcastWs({
          type: "system-warning",
          message: `${name.charAt(0).toUpperCase() + name.slice(1)} connector appears disconnected`,
        });
      }

      this.statuses.set(name, newStatus);
    }

    // Clean up connectors that are no longer configured
    for (const name of this.statuses.keys()) {
      if (!configured.includes(name)) {
        this.statuses.delete(name);
      }
    }
  }
}
