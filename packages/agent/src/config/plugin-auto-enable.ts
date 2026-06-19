/**
 * Compat re-export — kept so older bundled callers that wrote
 * `import { CONNECTOR_PLUGINS, STREAMING_PLUGINS } from "@elizaos/agent/config/plugin-auto-enable"`
 * resolve.
 *
 * The auto-enable surface lives in `@elizaos/shared`. The published
 * `@elizaos/app-core@2.0.0-alpha.537` bundle has a frozen reference to the
 * old `@elizaos/agent` subpath; until that bundle is republished against
 * `@elizaos/shared`, this file is the bridge that keeps Linux Electrobun
 * (and any other consumer of the packaged eliza-dist) booting.
 */
export {
  CONNECTOR_PLUGINS,
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  STREAMING_PLUGINS,
} from "@elizaos/shared";
