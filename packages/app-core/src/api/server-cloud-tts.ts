/**
 * Re-export shim. The canonical implementation now lives in
 * `@elizaos/plugin-elizacloud/lib/server-cloud-tts`. Several app-core
 * server-internal modules (`server.ts`,
 * `@elizaos/plugin-wallet/lib/server-wallet-trade`) import the helpers via
 * this relative path; this shim preserves that surface.
 */
export {
  __resetCloudBaseUrlCache,
  ELIZA_CLOUD_TTS_MAX_TEXT_CHARS,
  ensureCloudTtsApiKeyAlias,
  handleCloudTtsPreviewRoute,
  mirrorCompatHeaders,
  normalizeElizaCloudTtsModelId,
  readTtsDebugClientHeaders,
  resolveCloudProxyTtsModel,
  resolveCloudTtsBaseUrl,
  resolveCloudTtsCandidateUrls,
  resolveElevenLabsApiKeyForCloudMode,
  resolveElizaCloudTtsVoiceId,
  shouldRetryCloudTtsUpstream,
} from "@elizaos/plugin-elizacloud/lib/server-cloud-tts";
