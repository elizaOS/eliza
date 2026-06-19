/**
 * Narrow runtime bridge consumed by `@elizaos/agent` via dynamic import.
 *
 * Phase-2 refactor: agent has a runtime-only dependency on a small number of
 * app-core symbols (account-pool singleton, shared vault, vault bootstrap,
 * wallet-key hydration, build-variant flags). The agent loads them lazily
 * via `await import("@elizaos/app-core/agent-bridge")` so the static
 * dependency graph (and `bunx madge`) sees a leaf `.d.ts` whose transitive
 * imports do NOT reach back into `@elizaos/agent`. This is the documented
 * "narrow subpath" exception in `AGENTS.md` — used here deliberately to
 * break the agent ↔ app-core .d.ts cycle that madge picks up by following
 * the dynamic-import specifier into `app-core/dist/index.d.ts` (the full
 * barrel which re-exports server-* + runtime/* modules that DO import from
 * `@elizaos/agent`).
 *
 * Every symbol re-exported here lives in an app-core source file whose
 * compiled `.d.ts` does not import from `@elizaos/agent`. Keep it that way:
 * if a new bridge symbol's source pulls in agent types in its public
 * signatures, do NOT add it here — rework the underlying module so its
 * emitted `.d.ts` stays agent-free, or move the type to `@elizaos/shared`.
 */

export { getBuildVariant, isStoreBuild } from "./runtime/build-variant";
export { hydrateWalletKeysFromNodePlatformSecureStore } from "./security/hydrate-wallet-keys-from-platform-store";
export {
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
} from "./services/account-pool";
export { runVaultBootstrap } from "./services/vault-bootstrap";
export { sharedVault } from "./services/vault-mirror";
