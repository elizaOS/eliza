/**
 * Atomic key/value writer for the on-disk `config.env` file.
 *
 * The implementation lives in `@elizaos/plugin-elizacloud/lib/config-env`
 * so that the agent, the app host, and the cloud plugin all share ONE module
 * instance — and therefore one in-process write mutex, one hijack-key
 * denylist, and one state-dir hardening path — over the same file. The plugin
 * cannot import `@elizaos/agent` (agent depends on the plugin), so the shared
 * writer sits on the lower layer and is re-exported here unchanged for every
 * existing `@elizaos/agent/api/config-env` consumer.
 */
export {
  __testing,
  type PersistConfigEnvOptions,
  persistConfigEnv,
  readConfigEnv,
  readConfigEnvSync,
  resolveConfigEnvPath,
} from "@elizaos/plugin-elizacloud/lib/config-env";
