import type { IAgentRuntime } from "@elizaos/core";
import {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  logger,
  resolveSetting,
} from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/core";

export const DEFAULT_ELIZA_CLOUD_LARGE_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;

/**
 * Runtime config first, then `process.env`, then the supplied default.
 *
 * Thin wrapper over core `resolveSetting` so the precedence lives in one
 * canonical place. The env fallback uses dotenv semantics (trimmed; empty
 * strings treated as unset).
 */
export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string
): string | undefined {
  return defaultValue === undefined
    ? resolveSetting(runtime, key)
    : resolveSetting(runtime, key, { defaultValue });
}

export function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

export function isProxyMode(runtime: IAgentRuntime): boolean {
  return isBrowser() && !!getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL");
}

export function getBaseURL(runtime: IAgentRuntime): string {
  const browserURL = getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL");
  const baseURL = (
    isBrowser() && browserURL
      ? browserURL
      : getSetting(runtime, "ELIZAOS_CLOUD_BASE_URL", "https://elizacloud.ai/api/v1")
  ) as string;
  return baseURL;
}

export function getEmbeddingBaseURL(runtime: IAgentRuntime): string {
  const embeddingURL = isBrowser()
    ? getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL") ||
      getSetting(runtime, "ELIZAOS_CLOUD_BROWSER_BASE_URL")
    : getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_URL");
  if (embeddingURL) {
    logger.debug(`[ELIZAOS_CLOUD] Using specific embedding base URL: ${embeddingURL}`);
    return embeddingURL;
  }
  logger.debug("[ELIZAOS_CLOUD] Falling back to general base URL for embeddings.");
  return getBaseURL(runtime);
}

export function getApiKey(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "ELIZAOS_CLOUD_API_KEY");
}

/**
 * The Eliza Cloud app this agent's inference should be attributed to (#10423).
 *
 * The managed deploy path injects the platform-authoritative `ELIZA_APP_ID`
 * (the app's UUID) into a deployed app container, so its inference bills the
 * app's credits + the creator's earnings rather than the caller's own org. When
 * set, {@link createCloudApiClient} attaches it as the `X-App-Id` header on
 * every request. The cloud verifies the caller is authorized for the app and
 * falls back to normal (caller-org) billing when it is not — so a non-app agent
 * that happens to carry an unrelated `ELIZA_APP_ID` (e.g. the desktop bundle id)
 * is simply billed normally, never rejected.
 */
export function getAppId(runtime: IAgentRuntime): string | undefined {
  return getSetting(runtime, "ELIZA_APP_ID");
}

/**
 * Truthiness for host-written cloud flags: "true" or "1" (trimmed,
 * case-insensitive), mirroring how core `isCloudConnected` reads
 * `ELIZAOS_CLOUD_ENABLED`. Runtime boolean `true` arrives here as the
 * string "true" (getSetting/resolveSetting coerce to string).
 */
function isTruthyCloudFlag(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower === "true" || lower === "1";
}

/**
 * Whether Cloud TTS may serve: a Cloud API key is present AND the operator
 * turned cloud audio on — either through the full cloud connection
 * (`ELIZAOS_CLOUD_ENABLED`) or through the per-service routing flag
 * (`ELIZAOS_CLOUD_USE_TTS`) that `applyCloudConfigToEnv` writes in
 * capability-only mode (elizaOS/eliza#10819), where an external provider
 * owns the text brain so `ELIZAOS_CLOUD_ENABLED` deliberately stays unset.
 *
 * This is deliberately NOT a change to core `isCloudConnected`: its other
 * consumers (wallet RPC proxy routing, streaming, tailscale) read ENABLED as
 * "Eliza Cloud is the inference brain" and must keep that coupling. TTS is a
 * capability with an explicit per-service opt-in that has to work without
 * the inference coupling — gating it on ENABLED alone made the registered
 * TEXT_TO_SPEECH handler throw `CloudTtsUnavailableError` on every call in
 * capability-only mode, even when the operator cloud-routed TTS.
 */
export function isCloudTtsAvailable(runtime: IAgentRuntime): boolean {
  const apiKey = getApiKey(runtime);
  if (!apiKey?.trim()) return false;
  return (
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_ENABLED")) ||
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_USE_TTS"))
  );
}

/**
 * Whether Cloud STT (TRANSCRIPTION) may serve. Exact mirror of
 * {@link isCloudTtsAvailable}: a Cloud API key is present AND cloud audio is
 * on — either through the full cloud connection (`ELIZAOS_CLOUD_ENABLED`) or
 * through the per-service flag (`ELIZAOS_CLOUD_USE_STT`, the STT counterpart
 * of `ELIZAOS_CLOUD_USE_TTS`) for capability-only mode where an external
 * provider owns the text brain and `ELIZAOS_CLOUD_ENABLED` stays unset.
 *
 * When this returns false the TRANSCRIPTION handler throws
 * `CloudSttUnavailableError` so the local-inference router's per-pick retry
 * loop falls through to the next eligible provider instead of firing an
 * unauthenticated cloud request.
 */
export function isCloudSttAvailable(runtime: IAgentRuntime): boolean {
  const apiKey = getApiKey(runtime);
  if (!apiKey?.trim()) return false;
  return (
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_ENABLED")) ||
    isTruthyCloudFlag(getSetting(runtime, "ELIZAOS_CLOUD_USE_STT"))
  );
}

export function getEmbeddingApiKey(runtime: IAgentRuntime): string | undefined {
  const embeddingApiKey = getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_API_KEY");
  if (embeddingApiKey) {
    logger.debug("[ELIZAOS_CLOUD] Using specific embedding API key (present)");
    return embeddingApiKey;
  }
  logger.debug("[ELIZAOS_CLOUD] Falling back to general API key for embeddings.");
  return getApiKey(runtime);
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ??
    (getSetting(runtime, "SMALL_MODEL", DEFAULT_ELIZA_CLOUD_TEXT_MODEL) as string)
  );
}

export function getNanoModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_NANO_MODEL") ??
    getSetting(runtime, "NANO_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getMediumModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_MEDIUM_MODEL") ??
    getSetting(runtime, "MEDIUM_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_LARGE_MODEL") ??
    (getSetting(runtime, "LARGE_MODEL", DEFAULT_ELIZA_CLOUD_LARGE_MODEL) as string)
  );
}

export function getMegaModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_MEGA_MODEL") ??
    getSetting(runtime, "MEGA_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseHandlerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL") ??
    getSetting(runtime, "RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "SHOULD_RESPOND_MODEL") ??
    getSmallModel(runtime)
  );
}

export function getActionPlannerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "ELIZAOS_CLOUD_PLANNER_MODEL") ??
    getSetting(runtime, "ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "PLANNER_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getResponseModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_MODEL") ??
    getSetting(runtime, "RESPONSE_MODEL") ??
    getLargeModel(runtime)
  );
}

export function getImageDescriptionModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL", "gpt-5.4-mini") as string;
}

export function getImageGenerationModel(runtime: IAgentRuntime): string {
  // Must be a cloud SUPPORTED_IMAGE_MODELS id with an image:generation price;
  // the retired BitRouter default (google/gemini-2.5-flash-image) 500'd (#11005).
  return (
    getSetting(
      runtime,
      "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
      "google/nano-banana-2/text-to-image",
    ) ?? "google/nano-banana-2/text-to-image"
  );
}

export function getResearchModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "ELIZAOS_CLOUD_RESEARCH_MODEL") ??
    (getSetting(runtime, "RESEARCH_MODEL", "o3-deep-research") as string)
  );
}

export function getTTSModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "ELIZAOS_CLOUD_TTS_MODEL", "gpt-5-mini-tts") as string;
}

export function getExperimentalTelemetry(runtime: IAgentRuntime): boolean {
  const setting = getSetting(runtime, "ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY", "false");
  return String(setting).toLowerCase() === "true";
}

/**
 * Resolve a client-side timeout (ms) for a cloud model round-trip from `envKey`,
 * falling back to `defaultMs`. `0`/negative/non-numeric → undefined (opt out).
 *
 * cloud-sdk applies NO default timeout (a fetch with no signal hangs until the
 * platform default), so turn-blocking calls (TTS/STT in a voice turn, deep
 * research) need an explicit ceiling or a stalled gateway hangs the turn.
 */
export function resolveCloudTimeoutMs(
  envKey: string,
  defaultMs: number
): number | undefined {
  const raw = typeof process !== "undefined" ? process.env[envKey] : undefined;
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultMs;
  return parsed <= 0 ? undefined : parsed;
}
