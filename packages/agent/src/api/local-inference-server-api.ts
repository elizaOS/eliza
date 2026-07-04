import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";

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
