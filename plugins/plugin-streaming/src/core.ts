/**
 * Shared RTMP streaming utilities: destinations, cloud relay, overlay presets,
 * and pipeline control actions (local FFmpeg via dashboard API).
 */

import { isCloudConnected } from "@elizaos/cloud-routing";
import type {
  Action,
  ActionParameter,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

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

// ── Named / custom RTMP (config-driven ingest) ───────────────────────────────

export function createNamedRtmpDestination(params: {
  id: string;
  name?: string;
  rtmpUrl: string;
  rtmpKey: string;
}): StreamingDestination {
  const trimmedId = params.id.trim();
  const label = (params.name ?? trimmedId).trim() || trimmedId;
  return {
    id: trimmedId,
    name: label,
    async getCredentials() {
      const rtmpUrl = params.rtmpUrl.trim();
      const rtmpKey = params.rtmpKey.trim();
      if (!rtmpUrl || !rtmpKey) {
        throw new Error(`${label}: RTMP URL and stream key are required`);
      }
      return { rtmpUrl, rtmpKey };
    },
  };
}

export function createCustomRtmpDestination(config?: {
  rtmpUrl?: string;
  rtmpKey?: string;
}): StreamingDestination {
  return {
    id: "custom-rtmp",
    name: "Custom RTMP",
    async getCredentials() {
      const rtmpUrl = (
        config?.rtmpUrl ??
        process.env.CUSTOM_RTMP_URL ??
        ""
      ).trim();
      const rtmpKey = (
        config?.rtmpKey ??
        process.env.CUSTOM_RTMP_KEY ??
        ""
      ).trim();
      if (!rtmpUrl || !rtmpKey) {
        throw new Error(
          "Custom RTMP requires rtmpUrl and rtmpKey in streaming.customRtmp config or CUSTOM_RTMP_* env",
        );
      }
      return { rtmpUrl, rtmpKey };
    },
  };
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

export function streamingPipelineLocalPort(): number {
  return Number(process.env.SERVER_PORT || process.env.PORT || "2138");
}

// ── Unified STREAM_OP router action + streamStatus provider ────────────────

export const STREAMING_PLATFORMS = [
  "twitch",
  "youtube",
  "x",
  "pumpfun",
] as const;

export type StreamingPlatform = (typeof STREAMING_PLATFORMS)[number];

export type StreamingOp = "start" | "stop" | "status";

const PLATFORM_LABELS: Record<StreamingPlatform, string> = {
  twitch: "Twitch",
  youtube: "YouTube",
  x: "X (Twitter)",
  pumpfun: "pump.fun",
};

interface StreamStatusSnapshot {
  platform: StreamingPlatform;
  running: boolean;
  uptimeSeconds: number | null;
  frames: number | null;
  destination: string;
}

function isStreamingPlatform(value: unknown): value is StreamingPlatform {
  return (
    typeof value === "string" &&
    (STREAMING_PLATFORMS as readonly string[]).includes(value)
  );
}

function isStreamingOp(value: unknown): value is StreamingOp {
  return value === "start" || value === "stop" || value === "status";
}

function readParam(
  options: unknown,
  key: string,
): string | number | boolean | null | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return undefined;
  }
  const handler = options as HandlerOptions;
  const params = handler.parameters as Record<string, JsonValue> | undefined;
  if (params && key in params) {
    const v = params[key];
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      return v as string | number | boolean | null;
    }
  }
  const flat = options as Record<string, unknown>;
  const v = flat[key];
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    v === null
  ) {
    return v as string | number | boolean | null;
  }
  return undefined;
}

async function fetchStreamStatus(
  platform: StreamingPlatform,
): Promise<StreamStatusSnapshot> {
  const port = streamingPipelineLocalPort();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream/status`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as Record<string, unknown>;
  const uptime = typeof data.uptime === "number" ? Number(data.uptime) : null;
  const frames = typeof data.frames === "number" ? Number(data.frames) : null;
  return {
    platform,
    running: !!data.running,
    uptimeSeconds: uptime,
    frames,
    destination: PLATFORM_LABELS[platform],
  };
}

export interface BuildStreamOpActionParams {
  validate?: () => Promise<boolean>;
}

export function buildStreamOpAction(
  params: BuildStreamOpActionParams = {},
): Action {
  const validate = params.validate ?? (async () => true);

  const platformParam: ActionParameter = {
    name: "platform",
    description:
      "Streaming destination platform: twitch, youtube, x, or pumpfun.",
    descriptionCompressed: "Platform: twitch|youtube|x|pumpfun.",
    required: true,
    schema: {
      type: "string",
      enum: [...STREAMING_PLATFORMS],
    },
  };

  const opParam: ActionParameter = {
    name: "subaction",
    description:
      "Operation to perform: start (go live), stop (go offline), or status.",
    descriptionCompressed: "Op: start|stop|status.",
    required: true,
    schema: {
      type: "string",
      enum: ["start", "stop", "status"],
    },
  };

  return {
    name: "STREAM",
    contexts: ["media", "automation", "connectors"],
    contextGate: { anyOf: ["media", "automation", "connectors"] },
    roleGate: { minRole: "ADMIN" },
    description:
      "Control the local RTMP streaming pipeline for a target platform. Dispatches start, stop, and status calls to the dashboard stream API for twitch, youtube, x, or pumpfun.",
    descriptionCompressed:
      "Stream ops: start, stop, status; platforms: twitch, youtube, x, pumpfun.",
    similes: [
      "START_STREAM",
      "STOP_STREAM",
      "GET_STREAM_STATUS",
      "GO_LIVE",
      "GO_OFFLINE",
      "STREAM_STATUS",
      "IS_LIVE",
    ],
    parameters: [platformParam, opParam],
    validate,
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State | undefined,
      options:
        | HandlerOptions
        | Record<string, JsonValue | undefined>
        | undefined,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const platformRaw = readParam(options, "platform");
      const opRaw = readParam(options, "op");
      if (!isStreamingPlatform(platformRaw)) {
        const text = `STREAM_OP requires platform in {${STREAMING_PLATFORMS.join(", ")}}, got ${String(platformRaw)}`;
        if (callback) await callback({ text, actions: [] } as Content);
        return { success: false, error: text };
      }
      if (!isStreamingOp(opRaw)) {
        const text = `STREAM_OP requires op in {start, stop, status}, got ${String(opRaw)}`;
        if (callback) await callback({ text, actions: [] } as Content);
        return { success: false, error: text };
      }

      const platform: StreamingPlatform = platformRaw;
      const op: StreamingOp = opRaw;
      const label = PLATFORM_LABELS[platform];
      const port = streamingPipelineLocalPort();

      try {
        if (op === "start") {
          const res = await fetch(`http://127.0.0.1:${port}/api/stream/live`, {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
          });
          const data = (await res.json()) as Record<string, unknown>;
          const ok = !!data.ok;
          const text = ok
            ? `${label} stream started successfully! We're live.`
            : `Failed to start ${label} stream: ${data.error ?? "unknown error"}`;
          if (callback) await callback({ text, actions: [] } as Content);
          return { success: ok, text };
        }

        if (op === "stop") {
          const res = await fetch(
            `http://127.0.0.1:${port}/api/stream/offline`,
            {
              method: "POST",
              signal: AbortSignal.timeout(15_000),
            },
          );
          const data = (await res.json()) as Record<string, unknown>;
          const ok = !!data.ok;
          const text = ok
            ? `${label} stream stopped. We're offline now.`
            : `Failed to stop ${label} stream: ${data.error ?? "unknown error"}`;
          if (callback) await callback({ text, actions: [] } as Content);
          return { success: ok, text };
        }

        const snapshot = await fetchStreamStatus(platform);
        const status = snapshot.running ? "LIVE" : "OFFLINE";
        const uptime =
          snapshot.uptimeSeconds === null
            ? "n/a"
            : `${Math.floor(snapshot.uptimeSeconds / 60)}m`;
        const text = `${label} stream status: ${status} | Uptime: ${uptime} | Destination: ${label}`;
        if (callback) await callback({ text, actions: [] } as Content);
        return { success: true, text, data: { snapshot } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const text = `Error running STREAM_OP ${op} for ${label}: ${msg}`;
        if (callback) await callback({ text, actions: [] } as Content);
        return { success: false, error: msg, text };
      }
    },
    examples: [
      [
        {
          name: "{{user1}}",
          content: { text: "Go live on Twitch" },
        },
        {
          name: "{{agent}}",
          content: {
            text: "Starting the Twitch stream now.",
            actions: ["STREAM"],
          },
        },
      ],
      [
        {
          name: "{{user1}}",
          content: { text: "Stop the YouTube stream" },
        },
        {
          name: "{{agent}}",
          content: {
            text: "Stopping the stream now.",
            actions: ["STREAM"],
          },
        },
      ],
      [
        {
          name: "{{user1}}",
          content: { text: "Is the X stream live?" },
        },
        {
          name: "{{agent}}",
          content: {
            text: "Let me check the stream status.",
            actions: ["STREAM"],
          },
        },
      ],
    ],
  };
}

/**
 * Provider that renders the live status of every supported streaming platform
 * as JSON context. The pipeline currently exposes a single shared
 * `/api/stream/status` endpoint, so each platform row reflects that same
 * snapshot tagged with its destination label.
 */
export const streamStatusProvider: Provider = {
  name: "streamStatus",
  description:
    "Live RTMP pipeline status per supported platform (twitch, youtube, x, pumpfun) rendered as JSON.",
  descriptionCompressed: "RTMP status per platform.",
  dynamic: true,
  contexts: ["media", "automation"],
  contextGate: { anyOf: ["media", "automation"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const rows = await Promise.all(
      STREAMING_PLATFORMS.map(async (platform) => {
        try {
          const snap = await fetchStreamStatus(platform);
          return {
            platform: snap.platform,
            running: snap.running,
            uptimeSeconds: snap.uptimeSeconds ?? 0,
            frames: snap.frames ?? 0,
            destination: snap.destination,
            error: null,
          };
        } catch (err) {
          return {
            platform,
            running: false,
            uptimeSeconds: 0,
            frames: 0,
            destination: PLATFORM_LABELS[platform],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return {
      text: JSON.stringify({
        stream_status: {
          count: rows.length,
          platforms: rows,
        },
      }),
      data: { stream_status: rows },
    };
  },
};

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
  createDestination: (
    runtime?: IAgentRuntime,
    overrides?: { streamKey?: string; rtmpUrl?: string },
  ) => StreamingDestination;
}

export function createStreamingPlugin(
  cfg: StreamingPluginConfig,
): CreatedStreamingPlugin {
  const NAME = cfg.platformName;

  const configEntries: Record<string, string | null> = {
    [cfg.streamKeyEnvVar]: process.env[cfg.streamKeyEnvVar] ?? null,
  };
  if (cfg.rtmpUrlEnvVar) {
    configEntries[cfg.rtmpUrlEnvVar] = process.env[cfg.rtmpUrlEnvVar] ?? null;
  }

  const plugin: Plugin = {
    name: cfg.pluginName ?? `${cfg.platformId}-streaming`,
    description: `${NAME} RTMP streaming destination — credentials and overlay layout. Stream control actions live on the unified streaming plugin.`,
    get config() {
      return configEntries;
    },
    actions: [],
    async init(_config: Record<string, string>, _runtime: IAgentRuntime) {
      const streamKey = (
        _config[cfg.streamKeyEnvVar] ??
        process.env[cfg.streamKeyEnvVar] ??
        ""
      ).trim();
      if (!streamKey) {
        return;
      }
    },
  };

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
