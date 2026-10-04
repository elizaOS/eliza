/** Node host API. UI and platform composition use the browser and desktop-shell entries. */
export * from "./api/auth.ts";
export * from "./api/compat-route-shared";
export * from "./api/credential-tunnel-routes";
export * from "./api/ios-local-agent-transport";
export * from "./api/response";
export * from "./api/secrets-inventory-routes";
export * from "./api/secrets-manager-routes";
export * from "./api/server";
export * from "./api/server-security";
export * from "./api/server-wallet-trade";
export { IOS_FULL_BUN_SMOKE_FAILURE_RE } from "./platform/chat-failure-strings";
export * from "./platform/ios-runtime-backends";
export * from "./runtime/android-avf-microdroid-bridge";
export * from "./runtime/build-character-from-config";
export * from "./runtime/eliza";
export * from "./runtime/server-only-process";
export * from "./security/agent-vault-id";
export * from "./security/hydrate-wallet-keys-from-platform-store";
export * from "./security/platform-secure-store-node";
export * from "./security/wallet-os-store-actions";
export type * from "./services/auth-repository";
export * from "./services/auth-store";
export * from "./services/credential-tunnel-service";
export * from "./services/steward-credentials";
export * from "./services/steward-sidecar/helpers";
// Explicit .ts extension on steward-sidecar.ts disambiguates from the
// sibling steward-sidecar/ directory: `tsc --rewriteRelativeImportExtensions`
// emits `./services/steward-sidecar.js` in dist, which Node ESM can resolve
// without falling through to the directory and crashing on the missing
// dist/services/steward-sidecar/index.json fallback (the Docker production
// smoke regression observed on PR #7528 / #7530).
export * from "./services/steward-sidecar.ts";
export * from "./services/vault-bootstrap";
export * from "./services/vault-mirror";
