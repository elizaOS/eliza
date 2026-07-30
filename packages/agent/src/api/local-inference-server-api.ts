/** Routes local inference server API requests between the agent backend and local model service. */
import type http from "node:http";
import type {
  AgentRuntime,
  IAgentRuntime,
  LegacyRouteHandler,
  Route,
} from "@elizaos/core";

/**
 * Single owner of the `@elizaos/plugin-local-inference` subpath layout for the
 * agent's HTTP server.
 *
 * The mobile agent bundle null-stubs the plugin's *bare* entry
 * (`@elizaos/plugin-local-inference`, the heavy `Plugin` object) via an exact
 * alias in `scripts/build-mobile-bundle.mjs`, so a bare import yields `undefined`
 * handlers and every `/api/local-inference/*`, `/api/status`, and local chat
 * status path fails on-device. The deep route subpaths (`./local-inference-routes`
 * and `./routes`) are matched by the same anchored stub regex and are therefore
 * NOT stubbed — they carry the real implementations on every platform.
 *
 * This module is the ONLY file in `packages/agent` that encodes that
 * stub/subpath knowledge. Every server-side consumer (server routing, health,
 * chat) imports the typed loaders below instead of hand-picking a subpath.
 */

/** Route + chat surface exported by `.../local-inference-routes`. */
export type LocalInferenceRouteApi = {
  getLocalInferenceActiveModelId: () => string | undefined;
  getLocalInferenceActiveSnapshot: () => Promise<{
    status?: string;
    modelId?: string;
  } | null>;
  handleLocalInferenceRoutes: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  getLocalInferenceChatStatus: (
    intent: LocalInferenceCommandIntent,
    error?: unknown,
  ) => Promise<{
    text: string;
    localInference: LocalInferenceChatMetadata;
  }>;
  handleLocalInferenceChatCommand: (
    intent: LocalInferenceCommandIntent,
    prompt: string,
  ) => Promise<{
    text: string;
    localInference: LocalInferenceChatMetadata;
  }>;
};

/** Voice (TTS/ASR/diarization) surface exported by `.../routes`. */
export type LocalInferenceVoiceRouteApi = {
  handleLocalInferenceTtsRoute: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    state: { current: AgentRuntime | null },
  ) => Promise<boolean>;
  handleLocalInferenceAsrRoute: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    state: { current: AgentRuntime | null },
  ) => Promise<boolean>;
  handleLiveDiarizationRoute: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    state: { current: AgentRuntime | null },
  ) => Promise<boolean>;
};

export type LocalInferenceChatMetadata = Record<string, unknown>;

export type LocalInferenceCommandIntent =
  | "cancel"
  | "download"
  | "redownload"
  | "resume"
  | "retry"
  | "status"
  | "switch_smaller"
  | "use_cloud"
  | "use_local";

let routeApiPromise: Promise<LocalInferenceRouteApi> | null = null;
let voiceRouteApiPromise: Promise<LocalInferenceVoiceRouteApi> | null = null;
const transportRouteRuntimes = new WeakSet<IAgentRuntime>();

/**
 * Load the local-inference route + chat API from the always-real
 * `./local-inference-routes` subpath. A cold-boot import failure must not poison
 * the memo: `??=` would otherwise cache the rejection and fail EVERY dependent
 * route for the process lifetime, so the memo is cleared on reject and the next
 * caller retries once the deferred plugin closure is resolvable.
 */
export function loadLocalInferenceRouteApi(): Promise<LocalInferenceRouteApi> {
  routeApiPromise ??= (
    import(
      /* @vite-ignore */ "@elizaos/plugin-local-inference/local-inference-routes"
    ) as Promise<LocalInferenceRouteApi>
  ).catch((err: unknown) => {
    routeApiPromise = null;
    throw err;
  });
  return routeApiPromise;
}

/**
 * Load the local-inference voice (TTS/ASR/diarization) API from the always-real
 * `./routes` subpath. Same clear-on-reject memo semantics as
 * {@link loadLocalInferenceRouteApi}.
 */
export function loadLocalInferenceVoiceRouteApi(): Promise<LocalInferenceVoiceRouteApi> {
  voiceRouteApiPromise ??= (
    import(
      /* @vite-ignore */ "@elizaos/plugin-local-inference/routes"
    ) as Promise<LocalInferenceVoiceRouteApi>
  ).catch((err: unknown) => {
    voiceRouteApiPromise = null;
    throw err;
  });
  return voiceRouteApiPromise;
}

/**
 * Mount server-owned local-inference routes onto `runtime.routes` for
 * transports that dispatch in-process without constructing the HTTP server.
 * Android's abstract-UDS bridge uses the same handlers as desktop rather than
 * maintaining a second route implementation.
 */
export function registerLocalInferenceTransportRoutes(
  runtime: IAgentRuntime,
): void {
  if (transportRouteRuntimes.has(runtime)) return;

  const handler: LegacyRouteHandler = async (req, res, activeRuntime) => {
    const [routeApi, voiceApi] = await Promise.all([
      loadLocalInferenceRouteApi(),
      loadLocalInferenceVoiceRouteApi(),
    ]);
    if (await routeApi.handleLocalInferenceRoutes(req as never, res as never)) {
      return;
    }
    if (
      voiceApi.handleLocalInferenceAsrRoute &&
      (await voiceApi.handleLocalInferenceAsrRoute(req as never, res as never, {
        current: activeRuntime as AgentRuntime,
      }))
    ) {
      return;
    }
    if (
      voiceApi.handleLocalInferenceTtsRoute &&
      (await voiceApi.handleLocalInferenceTtsRoute(req as never, res as never, {
        current: activeRuntime as AgentRuntime,
      }))
    ) {
      return;
    }
    if (
      voiceApi.handleLiveDiarizationRoute &&
      (await voiceApi.handleLiveDiarizationRoute(req as never, res as never, {
        current: activeRuntime as AgentRuntime,
      }))
    ) {
      return;
    }
    res.status(404).json({ error: "Local inference route not found" });
  };

  const routes: Route[] = [
    ...(["GET", "POST", "DELETE"] as const).map((type) => ({
      type,
      path: "/api/local-inference/:path*",
      handler,
      public: false as const,
    })),
    {
      type: "GET",
      path: "/api/tts/local-inference/status",
      handler,
      public: false,
    },
    {
      type: "POST",
      path: "/api/tts/local-inference",
      handler,
      public: false,
    },
    {
      type: "POST",
      path: "/api/asr/local-inference",
      handler,
      public: false,
    },
    ...(["GET", "POST", "DELETE"] as const).map((type) => ({
      type,
      path: "/api/voice/:path*",
      handler,
      public: false as const,
    })),
  ];
  runtime.routes.push(...routes);
  transportRouteRuntimes.add(runtime);
}
