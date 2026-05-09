// Backward-compat surface for callers that imported from the old wrapper path.
//
// Auto-enable now lives in ./plugin-manifest.ts (per-plugin manifest pattern).
// What's left here are the connector / streaming reverse-lookup maps and
// the configured-detection helpers that several other packages still consume —
// they're not auto-enable, just shared data.
export {
  CONNECTOR_PLUGINS,
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  STREAMING_PLUGINS,
} from "./plugin-auto-enable-engine.js";
