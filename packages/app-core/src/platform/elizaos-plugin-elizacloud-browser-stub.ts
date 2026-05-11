// Browser-side stub for @elizaos/plugin-elizacloud. The plugins runtime
// surface (cloud secrets, TTS routes, ElevenLabs key resolver) only runs
// server-side; the renderer just needs the named imports to statically
// resolve. Every export is a noop / empty stub.

const noop = () => undefined;
const asyncNoop = async () => undefined;
export const clearCloudSecrets = noop;
export const ensureCloudTtsApiKeyAlias = noop;
export const getCloudSecret = noop;
export const handleCloudTtsPreviewRoute = noop;
export const mirrorCompatHeaders = noop;
export const normalizeCloudSiteUrl = noop;
export const __resetCloudBaseUrlCache = noop;
export const resolveCloudTtsBaseUrl = noop;
export const resolveElevenLabsApiKeyForCloudMode = noop;
export default new Proxy(noop, { get: () => noop, apply: () => undefined });
