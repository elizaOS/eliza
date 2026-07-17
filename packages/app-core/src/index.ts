/**
 * Node/runtime barrel for `@elizaos/app-core` (the `.` export): re-exports the
 * dashboard HTTP API plus auth/response helpers, the Eliza runtime loader and
 * runtime-mode/desktop surfaces, the curated registry, security/vault/steward
 * services, first-run config, and diagnostics. Frontend surfaces live in
 * `@elizaos/ui`; pure contracts/utilities live in `@elizaos/shared`. Star
 * re-exports are used except where a name collides with `@elizaos/ui`
 * (`ConfigField`/`getPlugins`, re-exported explicitly); `./platform/empty-node-module`
 * is deliberately excluded so its browser aliases can't shadow the real Node
 * exports.
 */

// Runtime-mode resolution moved into @elizaos/agent (api/runtime-mode/) so the
// bare agent server enforces the same route-visibility gate as this wrapper.
// Re-exported by name to keep this barrel's public surface stable without
// star-leaking the whole agent package.
export {
  getRuntimeMode,
  getRuntimeModeSnapshot,
  isLocalRemoteHost,
  isLocalRuntime,
  type RemoteApiBaseValidation,
  type RemoteApiBaseValidationErr,
  type RemoteApiBaseValidationOk,
  RUNTIME_MODES,
  type RuntimeMode,
  type RuntimeModeSnapshot,
  resolveRuntimeMode,
  validateRemoteApiBase,
} from "@elizaos/agent";
export * from "./api/auth.ts";
export * from "./api/automation-node-contributors";
export * from "./api/compat-route-shared";
export * from "./api/credential-tunnel-routes";
export * from "./api/ios-local-agent-transport";
export * from "./api/response";
export * from "./api/secrets-inventory-routes";
export * from "./api/secrets-manager-routes";
export * from "./api/server";
export * from "./api/server-security";
export * from "./api/server-wallet-trade";
export * from "./api/setup-contract";
export * from "./config/app-config";
export * from "./diagnostics/integration-observability";
export * from "./first-run/first-run-config";
export * from "./permissions/types";
// `./platform/empty-node-module` is intentionally NOT re-exported here.
// It exists as a tsconfig-paths target for browser builds — re-exporting it
// would shadow the real api/server, runtime/eliza, etc. exports above with
// inert browser aliases. Browser bundlers alias it in via the path map; Node imports
// the originals directly through this barrel.
export { IOS_FULL_BUN_SMOKE_FAILURE_RE } from "./platform/chat-failure-strings.generated";
export * from "./platform/ios-runtime-backends";
export {
  IOS_FULL_BUN_SMOKE_REQUEST_KEY,
  IOS_FULL_BUN_SMOKE_RESULT_KEY,
  runIosFullBunSmokeIfRequested,
} from "./platform/ios-runtime-bridge";
export * from "./registry";
// `ConfigField` and `getPlugins` also exist in @elizaos/ui. Re-export the
// app-core registry versions explicitly so the Node barrel stays authoritative
// and avoids ambiguous star re-exports.
export { type ConfigField, getPlugins } from "./registry";
export * from "./runtime/android-avf-microdroid-bridge";
export * from "./runtime/app-route-plugin-registry";
export * from "./runtime/build-character-from-config";
export * from "./runtime/build-variant";
export * from "./runtime/channel-plugin-map";
export * from "./runtime/desktop";
export * from "./runtime/eliza";
export * from "./runtime/mobile-safe-runtime";
export * from "./security/agent-vault-id";
export * from "./security/hydrate-wallet-keys-from-platform-store";
export * from "./security/platform-secure-store";
export * from "./security/platform-secure-store-node";
export * from "./security/wallet-os-store-actions";
export * from "./services/account-pool";
export * from "./services/account-pool-consumer-metering";
export * from "./services/auth-store";
export * from "./services/credential-tunnel-service";
export * from "./services/github-credentials";
export * from "./services/inference-abort";
export * from "./services/steward-credentials";
export * from "./services/steward-sidecar/helpers";
// Explicit .ts extension on steward-sidecar.ts disambiguates from the
// sibling steward-sidecar/ directory: `tsc --rewriteRelativeImportExtensions`
// emits `./services/steward-sidecar.js` in dist, which Node ESM can resolve
// without falling through to the directory and crashing on the missing
// dist/services/steward-sidecar/index.json fallback (the Docker production
// smoke regression observed on PR #7528 / #7530).
export * from "./services/steward-sidecar.ts";
export * from "./services/task-host-capabilities";
export * from "./services/vault-bootstrap";
export * from "./services/vault-mirror";
export * from "./ui-compat";
