// Node/runtime barrel for @elizaos/app-core.
// Frontend surfaces live in @elizaos/ui; pure contracts/utilities live in @elizaos/shared.

export * from "./account-pool";
export * from "./api/auth";
export * from "./api/automation-node-contributors";
export * from "./api/compat-route-shared";
export * from "./api/response";
export * from "./api/secrets-inventory-routes";
export * from "./api/secrets-manager-routes";
export * from "./api/server";
export * from "./api/server-security";
export * from "./api/server-wallet-trade";
export * from "./api/workbench-compat-routes";
export * from "./diagnostics/integration-observability";
export * from "./permissions/types";
export * from "./platform/empty-node-module";
export * from "./registry";
export * from "./runtime/app-route-plugin-registry";
export * from "./runtime/build-character-from-config";
export * from "./runtime/build-variant";
export * from "./runtime/channel-plugin-map";
export * from "./runtime/eliza";
export * from "./security/agent-vault-id";
export * from "./security/hydrate-wallet-keys-from-platform-store";
export * from "./security/platform-secure-store";
export * from "./security/platform-secure-store-node";
export * from "./security/wallet-os-store-actions";
export * from "./services/account-pool";
export * from "./services/auth-store";
export * from "./services/github-credentials";
export * from "./services/plugin-installer";
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
