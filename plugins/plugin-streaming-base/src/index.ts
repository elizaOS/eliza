/**
 * Shared factory for RTMP streaming destination plugins.
 *
 * Both @elizaos/plugin-twitch-streaming and @elizaos/plugin-youtube-streaming
 * delegate to this factory to eliminate near-identical boilerplate for actions,
 * destination creation, and plugin wiring.
 */

import type {
  Action,
  ActionExample,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import { isCloudConnected } from "@elizaos/cloud-routing";

// ── Overlay layout data (JSON-serializable, no React refs) ──────────────────

export interface OverlayWidgetInstance {
  id: string;
  type: string;
  enabled: boolean;
  position: { x: number; y: number; width: number; height: number };
  zIndex: number;
  config: Record<string, unknown>;
}

export interface OverlayLayoutData {
  version: 1;
  name: string;
  widgets: OverlayWidgetInstance[];
}

// ── Shared types ────────────────────────────────────────────────────────────
// Canonical definition — stream-routes.ts re-exports this interface.

export interface StreamingDestination {
  id: string;
  name: string;
  getCredentials(): Promise<{ rtmpUrl: string; rtmpKey: string }>;
  onStreamStart?(): Promise<void>;
  onStreamStop?(): Promise<void>;
  /** Per-destination default overlay layout, seeded on first stream start. */
  defaultOverlayLayout?: OverlayLayoutData;
}

export interface StreamingPluginConfig {
  /** Short lowercase identifier, e.g. "twitch" or "youtube" */
  platformId: string;
  /** Display name, e.g. "Twitch" or "YouTube" */
  platformName: string;
  /** Env var that holds the stream key, e.g. "TWITCH_STREAM_KEY" */
  streamKeyEnvVar: string;
  /** Default RTMP ingest URL for this platform */
  defaultRtmpUrl: string;
  /** Optional env var for a custom RTMP URL (YouTube supports this) */
  rtmpUrlEnvVar?: string;
  /** Override the elizaOS plugin name (defaults to `${platformId}-streaming`) */
  pluginName?: string;
  /** Per-destination default overlay layout, seeded on first stream start. */
  defaultOverlayLayout?: OverlayLayoutData;
  /**
   * When true, the plugin auto-selects between direct RTMP push and the
   * Eliza Cloud RTMP relay backend based on `<UPPER>_STREAMING_BACKEND`
   * (`direct` | `cloud` | `auto`, default `auto`).
   *
   * - `direct` — push to platform RTMP ingest using a local stream key (Mode A).
   * - `cloud`  — request a per-session relay from Eliza Cloud (Mode B).
   *               The cloud fans the inbound stream out to N destinations.
   * - `auto`   — pick `cloud` when Eliza Cloud is connected AND no local
   *               stream key is set; otherwise pick `direct`.
   *
   * Existing users with a local `<PLATFORM>_STREAM_KEY` keep the direct path
   * unchanged; cloud relay only activates when they enable cloud and have no
   * local key.
   */
  cloudRelay?: boolean;
}

// ── Preset layout builder ───────────────────────────────────────────────────

/** All known built-in widget types. */
const WIDGET_DEFAULTS: Record<
  string,
  { position: OverlayWidgetInstance["position"]; zIndex: number }
> = {
  "thought-bubble": {
    position: { x: 2, y: 2, width: 30, height: 20 },
    zIndex: 10,
  },
  "action-ticker": {
    position: { x: 0, y: 85, width: 100, height: 15 },
    zIndex: 5,
  },
  "alert-popup": {
    position: { x: 30, y: 10, width: 40, height: 20 },
    zIndex: 20,
  },
  "viewer-count": {
    position: { x: 88, y: 2, width: 10, height: 6 },
    zIndex: 15,
  },
  branding: { position: { x: 2, y: 90, width: 20, height: 8 }, zIndex: 2 },
  "custom-html": {
    position: { x: 50, y: 50, width: 30, height: 20 },
    zIndex: 1,
  },
  "peon-hud": {
    position: { x: 82, y: 10, width: 16, height: 30 },
    zIndex: 12,
  },
  "peon-glass": {
    position: { x: 2, y: 2, width: 32, height: 40 },
    zIndex: 16,
  },
  "peon-sakura": {
    position: { x: 0, y: 0, width: 25, height: 50 },
    zIndex: 3,
  },
};

let _presetCounter = 0;

/**
 * Build a preset overlay layout with the given widget types enabled.
 * Widget types not listed in `enabledTypes` are included but disabled.
 */
export function buildPresetLayout(
  name: string,
  enabledTypes: string[],
): OverlayLayoutData {
  const enabledSet = new Set(enabledTypes);
  const widgets: OverlayWidgetInstance[] = Object.entries(WIDGET_DEFAULTS).map(
    ([type, defaults]) => {
      _presetCounter += 1;
      return {
        id: `preset${_presetCounter.toString(36)}`,
        type,
        enabled: enabledSet.has(type),
        position: { ...defaults.position },
        zIndex: defaults.zIndex,
        config: {},
      };
    },
  );
  return { version: 1, name, widgets };
}

// ── Destination factory ─────────────────────────────────────────────────────

export function createStreamingDestination(
  cfg: StreamingPluginConfig,
  overrides?: { streamKey?: string; rtmpUrl?: string },
): StreamingDestination {
  return {
    id: cfg.platformId,
    name: cfg.platformName,
    defaultOverlayLayout: cfg.defaultOverlayLayout,

    async getCredentials() {
      const streamKey = (
        overrides?.streamKey ??
        process.env[cfg.streamKeyEnvVar] ??
        ""
      ).trim();
      if (!streamKey) {
        throw new Error(`${cfg.platformName} stream key not configured`);
      }

      const rtmpUrl = (
        overrides?.rtmpUrl ??
        (cfg.rtmpUrlEnvVar ? process.env[cfg.rtmpUrlEnvVar] : undefined) ??
        cfg.defaultRtmpUrl
      ).trim();
      if (!rtmpUrl) {
        throw new Error(`${cfg.platformName} RTMP URL not configured`);
      }

      return { rtmpUrl, rtmpKey: streamKey };
    },
    // Platforms detect stream automatically via RTMP ingest -- no API calls needed
  };
}

// ── Cloud relay destination ────────────────────────────────────────────────

const CLOUD_BASE_FALLBACK = "https://www.elizacloud.ai/api/v1";

function readSetting(runtime: IAgentRuntime, key: string): string | null {
  const raw = runtime.getSetting(key);
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

function getCloudBaseUrl(runtime: IAgentRuntime): string {
  const override = readSetting(runtime, "ELIZAOS_CLOUD_BASE_URL");
  return (override ?? CLOUD_BASE_FALLBACK).replace(/\/+$/, "");
}

function getCloudApiKey(runtime: IAgentRuntime): string {
  const apiKey = readSetting(runtime, "ELIZAOS_CLOUD_API_KEY");
  if (apiKey === null) {
    throw new Error(
      "Eliza Cloud relay requested but ELIZAOS_CLOUD_API_KEY is not set",
    );
  }
  return apiKey;
}

interface CreateRelaySessionResponse {
  sessionId: string;
  streamKey: string;
  ingestUrl: string;
  wsUrl?: string;
}

/**
 * Configuration for the Eliza Cloud relay-backed streaming destination.
 *
 * The destination POSTs to `/v1/apis/streaming/sessions` to acquire a
 * per-session ingest URL + stream key. The cloud forwards the inbound
 * stream to the user's stored destinations for `platformId`.
 */
export interface CloudRelayDestinationCfg {
  /** Short lowercase platform identifier — e.g. "twitch", "youtube". */
  platformId: string;
  /** Display name — e.g. "Twitch", "YouTube". */
  platformName: string;
  /** Active runtime — used to read ELIZAOS_CLOUD_* settings. */
  runtime: IAgentRuntime;
  /** Optional per-destination default overlay layout. */
  defaultOverlayLayout?: OverlayLayoutData;
}

/**
 * Build a `StreamingDestination` whose RTMP credentials come from the
 * Eliza Cloud relay (Mode B). The cloud-issued credentials point at the
 * SRS ingest, NOT at the platform's RTMP endpoint — the cloud relays the
 * inbound stream to platform RTMP servers using stored per-org credentials.
 *
 * Lifecycle:
 *  - `getCredentials()` — POST `/v1/apis/streaming/sessions` →
 *    `{ sessionId, ingestUrl, streamKey }`, returned to the caller as
 *    `{ rtmpUrl: ingestUrl, rtmpKey: streamKey }`.
 *  - `onStreamStop()`  — DELETE `/v1/apis/streaming/sessions/{id}`.
 *
 * Throws if Eliza Cloud is not connected.
 */
export function createCloudRelayDestination(
  cfg: CloudRelayDestinationCfg,
): StreamingDestination {
  if (!isCloudConnected(cfg.runtime)) {
    throw new Error(
      `Cloud relay requested for ${cfg.platformName} but Eliza Cloud is not connected ` +
        `(ELIZAOS_CLOUD_API_KEY missing or ELIZAOS_CLOUD_ENABLED falsy)`,
    );
  }

  let activeSessionId: string | null = null;

  return {
    id: cfg.platformId,
    name: cfg.platformName,
    defaultOverlayLayout: cfg.defaultOverlayLayout,

    async getCredentials(): Promise<{ rtmpUrl: string; rtmpKey: string }> {
      const baseUrl = getCloudBaseUrl(cfg.runtime);
      const apiKey = getCloudApiKey(cfg.runtime);

      const res = await fetch(`${baseUrl}/apis/streaming/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ destinations: [cfg.platformId] }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Cloud relay session create failed: ${res.status} ${text}`,
        );
      }

      const body = (await res.json()) as CreateRelaySessionResponse;
      if (!body.sessionId || !body.streamKey || !body.ingestUrl) {
        throw new Error(
          "Cloud relay session create returned malformed response",
        );
      }

      activeSessionId = body.sessionId;
      return { rtmpUrl: body.ingestUrl, rtmpKey: body.streamKey };
    },

    async onStreamStop(): Promise<void> {
      if (!activeSessionId) return;
      const baseUrl = getCloudBaseUrl(cfg.runtime);
      const apiKey = getCloudApiKey(cfg.runtime);
      const sessionId = activeSessionId;
      activeSessionId = null;

      const res = await fetch(
        `${baseUrl}/apis/streaming/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Cloud relay session close failed: ${res.status} ${text}`,
        );
      }
    },
  };
}

// ── Backend selection ──────────────────────────────────────────────────────

export type StreamingBackend = "direct" | "cloud" | "auto";

function readBackendSetting(
  runtime: IAgentRuntime,
  envVar: string,
): StreamingBackend {
  const raw = readSetting(runtime, envVar);
  if (raw === null) return "auto";
  const lower = raw.toLowerCase();
  if (lower === "direct" || lower === "cloud" || lower === "auto") return lower;
  throw new Error(
    `Invalid ${envVar}="${raw}" (expected "direct" | "cloud" | "auto")`,
  );
}

/**
 * Resolve which streaming backend to use for a given platform at runtime.
 *
 * Reads `<UPPER>_STREAMING_BACKEND` (e.g. `TWITCH_STREAMING_BACKEND`) — one
 * of `direct`, `cloud`, or `auto` (default `auto`).
 *
 * `auto` picks `cloud` iff Eliza Cloud is connected AND no local stream key
 * is set in `cfg.streamKeyEnvVar`. Otherwise it picks `direct`.
 */
export function resolveStreamingBackend(
  runtime: IAgentRuntime,
  cfg: StreamingPluginConfig,
): "direct" | "cloud" {
  const upper = cfg.platformId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const setting = readBackendSetting(runtime, `${upper}_STREAMING_BACKEND`);
  if (setting === "direct" || setting === "cloud") return setting;

  const localKey = readSetting(runtime, cfg.streamKeyEnvVar);
  if (localKey !== null) return "direct";
  return isCloudConnected(runtime) ? "cloud" : "direct";
}

// ── Plugin factory ──────────────────────────────────────────────────────────

/**
 * Build a complete elizaOS Plugin for a streaming destination.
 *
 * Returns:
 *  - `plugin`  -- the Plugin object to register with elizaOS
 *  - `createDestination` -- the destination factory (for the streaming pipeline)
 */
/** Result of {@link createStreamingPlugin} — plugin + a backend-aware destination factory. */
export interface CreatedStreamingPlugin {
  plugin: Plugin;
  /**
   * Build a `StreamingDestination` for this platform.
   *
   * - If `cloudRelay` is enabled in the plugin config AND `runtime` resolves
   *   the backend to `cloud`, returns a cloud-relay destination.
   * - Otherwise returns a direct-mode destination using the local stream key
   *   from env / overrides.
   *
   * `runtime` is required when `cloudRelay: true` is set on the plugin
   * config (so the factory can read settings); it is otherwise optional and
   * the direct destination is used.
   */
  createDestination: (
    runtime?: IAgentRuntime,
    overrides?: { streamKey?: string; rtmpUrl?: string },
  ) => StreamingDestination;
}

export function createStreamingPlugin(
  cfg: StreamingPluginConfig,
): CreatedStreamingPlugin {
  const LOCAL_API_PORT = Number(
    process.env.SERVER_PORT || process.env.PORT || "2138",
  );

  const UPPER = cfg.platformName.toUpperCase();
  const NAME = cfg.platformName;

  // -- helpers ----------------------------------------------------------------

  const validate = async (): Promise<boolean> => {
    const key = (process.env[cfg.streamKeyEnvVar] ?? "").trim();
    return !!key;
  };

  // -- actions ----------------------------------------------------------------

  const startAction: Action = {
    name: `START_${UPPER}_STREAM`,
    description: `Start streaming to ${NAME}. Initiates the RTMP pipeline with browser capture.`,
    similes: [
      `GO_LIVE_${UPPER}`,
      `START_${UPPER}`,
      `BEGIN_${UPPER}_STREAM`,
      `${UPPER}_GO_LIVE`,
    ],
    parameters: [],
    validate,

    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown> | undefined,
      callback?: HandlerCallback,
    ) => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${LOCAL_API_PORT}/api/stream/live`,
          { method: "POST", signal: AbortSignal.timeout(30_000) },
        );
        const data = (await res.json()) as Record<string, unknown>;
        if (callback) {
          await callback({
            text: data.ok
              ? `${NAME} stream started successfully! We're live.`
              : `Failed to start ${NAME} stream: ${data.error ?? "unknown error"}`,
            actions: [],
          } as Content);
        }
        return { success: !!data.ok };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (callback) {
          await callback({
            text: `Error starting ${NAME} stream: ${msg}`,
            actions: [],
          } as Content);
        }
        return { success: false };
      }
    },

    examples: [
      [
        {
          name: "{{user1}}",
          content: { text: `Go live on ${NAME}` },
        } as ActionExample,
        {
          name: "{{agent}}",
          content: {
            text: `Starting the ${NAME} stream now.`,
            actions: [`START_${UPPER}_STREAM`],
          },
        } as ActionExample,
      ],
    ],
  };

  const stopAction: Action = {
    name: `STOP_${UPPER}_STREAM`,
    description: `Stop the active ${NAME} stream. Shuts down the FFmpeg pipeline.`,
    similes: [
      `GO_OFFLINE_${UPPER}`,
      `STOP_${UPPER}`,
      `END_${UPPER}_STREAM`,
      `${UPPER}_GO_OFFLINE`,
    ],
    parameters: [],
    validate,

    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown> | undefined,
      callback?: HandlerCallback,
    ) => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${LOCAL_API_PORT}/api/stream/offline`,
          { method: "POST", signal: AbortSignal.timeout(15_000) },
        );
        const data = (await res.json()) as Record<string, unknown>;
        if (callback) {
          await callback({
            text: data.ok
              ? `${NAME} stream stopped. We're offline now.`
              : `Failed to stop ${NAME} stream: ${data.error ?? "unknown error"}`,
            actions: [],
          } as Content);
        }
        return { success: !!data.ok };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (callback) {
          await callback({
            text: `Error stopping ${NAME} stream: ${msg}`,
            actions: [],
          } as Content);
        }
        return { success: false };
      }
    },

    examples: [
      [
        {
          name: "{{user1}}",
          content: { text: `Stop the ${NAME} stream` },
        } as ActionExample,
        {
          name: "{{agent}}",
          content: {
            text: "Stopping the stream now.",
            actions: [`STOP_${UPPER}_STREAM`],
          },
        } as ActionExample,
      ],
    ],
  };

  const statusAction: Action = {
    name: `GET_${UPPER}_STREAM_STATUS`,
    description: `Check the current status of the ${NAME} stream (running, uptime, frame count, etc).`,
    similes: [
      `${UPPER}_STATUS`,
      `${UPPER}_STREAM_STATUS`,
      `IS_${UPPER}_LIVE`,
      `CHECK_${UPPER}_STREAM`,
    ],
    parameters: [],
    validate,

    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown> | undefined,
      callback?: HandlerCallback,
    ) => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${LOCAL_API_PORT}/api/stream/status`,
          { signal: AbortSignal.timeout(10_000) },
        );
        const data = (await res.json()) as Record<string, unknown>;
        const status = data.running ? "LIVE" : "OFFLINE";
        const uptime = data.uptime
          ? `${Math.floor(Number(data.uptime) / 60)}m`
          : "n/a";
        if (callback) {
          await callback({
            text: `${NAME} stream status: ${status} | Uptime: ${uptime} | Destination: ${NAME}`,
            actions: [],
          } as Content);
        }
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (callback) {
          await callback({
            text: `Error checking ${NAME} stream status: ${msg}`,
            actions: [],
          } as Content);
        }
        return { success: false };
      }
    },

    examples: [
      [
        {
          name: "{{user1}}",
          content: { text: `Is the ${NAME} stream live?` },
        } as ActionExample,
        {
          name: "{{agent}}",
          content: {
            text: "Let me check the stream status.",
            actions: [`GET_${UPPER}_STREAM_STATUS`],
          },
        } as ActionExample,
      ],
    ],
  };

  // -- config env vars --------------------------------------------------------

  const configEntries: Record<string, string | null> = {
    [cfg.streamKeyEnvVar]: process.env[cfg.streamKeyEnvVar] ?? null,
  };
  if (cfg.rtmpUrlEnvVar) {
    configEntries[cfg.rtmpUrlEnvVar] = process.env[cfg.rtmpUrlEnvVar] ?? null;
  }

  // -- plugin -----------------------------------------------------------------

  const plugin: Plugin = {
    name: cfg.pluginName ?? `${cfg.platformId}-streaming`,
    description: `${NAME} RTMP streaming destination with agent stream control actions`,

    get config() {
      return configEntries;
    },

    actions: [startAction, stopAction, statusAction],

    async init(_config: Record<string, string>, _runtime: IAgentRuntime) {
      const streamKey = (
        _config[cfg.streamKeyEnvVar] ??
        process.env[cfg.streamKeyEnvVar] ??
        ""
      ).trim();
      if (!streamKey) {
        // Plugin loaded but no stream key -- actions will fail validation gracefully
        return;
      }
    },
  };

  // -- public API -------------------------------------------------------------

  const createDestination = (
    runtime?: IAgentRuntime,
    overrides?: { streamKey?: string; rtmpUrl?: string },
  ): StreamingDestination => {
    if (cfg.cloudRelay && runtime) {
      const backend = resolveStreamingBackend(runtime, cfg);
      if (backend === "cloud") {
        return createCloudRelayDestination({
          platformId: cfg.platformId,
          platformName: cfg.platformName,
          runtime,
          defaultOverlayLayout: cfg.defaultOverlayLayout,
        });
      }
    }
    return createStreamingDestination(cfg, overrides);
  };

  return { plugin, createDestination };
}
