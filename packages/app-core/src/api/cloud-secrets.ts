/**
 * Re-export shim. The canonical implementation now lives in
 * `@elizaos/plugin-elizacloud/lib/cloud-secrets`. This shim preserves
 * backward compatibility for app-core consumers (server.ts,
 * cli/doctor/checks.ts, onboarding-compat-routes.ts) until they migrate
 * to the plugin import path directly.
 */
export {
  _resetCloudSecretsForTesting,
  clearCloudSecrets,
  getCloudSecret,
  scrubCloudSecretsFromEnv,
} from "@elizaos/plugin-elizacloud/lib/cloud-secrets";
