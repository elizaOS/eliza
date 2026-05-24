/**
 * Connection configuration for app-xr.
 *
 * Supports three modes:
 *   "local"  — agent is running on the same network (LAN IP or localhost)
 *   "cloud"  — agent is hosted on Eliza Cloud (wss://...)
 *   "custom" — user-supplied WebSocket URL
 */

export type ConnectionMode = "local" | "cloud" | "custom";

export interface ConnectionConfig {
  mode: ConnectionMode;
  /** LAN IP or hostname (local mode) */
  host?: string;
  /** Port (local mode, default 31338) */
  port?: number;
  /** Eliza Cloud app ID (cloud mode) */
  appId?: string;
  /** Fully-qualified WebSocket URL (custom mode) */
  customUrl?: string;
}

const DEFAULT_LOCAL_PORT = 31338;

/**
 * Convert a ConnectionConfig to the WebSocket URL used to connect to the agent.
 */
export function configToWsUrl(config: ConnectionConfig): string {
  switch (config.mode) {
    case "local": {
      const host = config.host ?? "localhost";
      const port = config.port ?? DEFAULT_LOCAL_PORT;
      return `ws://${host}:${port}/ws-xr`;
    }
    case "cloud": {
      if (!config.appId) throw new Error("cloud mode requires appId");
      return `wss://cloud.elizaos.app/xr/${config.appId}/ws`;
    }
    case "custom": {
      if (!config.customUrl) throw new Error("custom mode requires customUrl");
      return config.customUrl;
    }
  }
}

/**
 * Load config from localStorage, falling back to local mode defaults.
 */
export function loadConfig(): ConnectionConfig {
  try {
    const raw = localStorage.getItem("xr-connection-config");
    if (raw) return JSON.parse(raw) as ConnectionConfig;
  } catch {
    // ignore
  }
  return { mode: "local", host: "localhost", port: DEFAULT_LOCAL_PORT };
}

/**
 * Persist config to localStorage.
 */
export function saveConfig(config: ConnectionConfig): void {
  localStorage.setItem("xr-connection-config", JSON.stringify(config));
}
