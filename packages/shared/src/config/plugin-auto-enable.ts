/**
 * Backward-compat re-export surface for callers that imported from the old
 * plugin-auto-enable wrapper path. Auto-enable itself now lives in
 * ./plugin-manifest.ts (per-plugin manifest pattern); what this module
 * forwards are the connector / streaming reverse-lookup maps and the
 * configured-detection helpers several other packages still consume — shared
 * data, not auto-enable logic.
 */
export {
  CONNECTOR_PLUGINS,
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  STREAMING_PLUGINS,
} from "./plugin-auto-enable-engine.js";
