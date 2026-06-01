# @elizaos/contracts

Pure TypeScript type contracts for elizaOS — no runtime code, no dependencies.

## Purpose / role

This package extracts shared type definitions from `@elizaos/core` so they can be imported by packages that need types but not the full runtime (e.g., `@elizaos/shared`, `@elizaos/cloud-frontend`, UI layers). `@elizaos/core` re-exports a curated subset of these types as a transition shim (`src/index.ts`, lines 16-22). `@elizaos/shared` re-exports the full wallet and service-routing contract types. Nothing in this package executes at runtime — it is declaration-only after build.

## Layout

```
src/
  index.ts            Barrel — re-exports everything from all modules
  cloud-topology.ts   ElizaCloudService, ResolvedElizaCloudTopology
  deployment.ts       DeploymentTargetRuntime, DeploymentTargetConfig
  roles.ts            RoleName, RoleGrantSource, RolesWorldMetadata,
                      ConnectorAdminWhitelist, RolesConfig
  service-routing.ts  LinkedAccount* types, ServiceCapability, ServiceRouteConfig,
                      ServiceRoutingConfig, plus per-provider credential key union
  style.ts            CHARACTER_LANGUAGES const, CharacterLanguage, StylePreset,
                      MessageExample, MessageExampleContent
  wallet.ts           All wallet shapes: balances, NFTs, BSC trade, Steward,
                      RPC provider selectors, trading-profile ledger
```

## Key exports / surface

Everything is a named re-export from the barrel `src/index.ts`. Major groups:

- **Cloud topology:** `ElizaCloudService`, `ResolvedElizaCloudTopology`
- **Deployment:** `DeploymentTargetRuntime`, `DeploymentTargetConfig`
- **Roles:** `RoleName` (`'OWNER'|'ADMIN'|'USER'|'GUEST'`), `RolesWorldMetadata`, `RolesConfig`, `ConnectorAdminWhitelist`
- **Service routing:** `LinkedAccountConfig`, `LinkedAccountProviderId`, `ServiceRouteConfig`, `ServiceRoutingConfig`, `ServiceCapability`, `ServiceTransport`
- **Style/character:** `CHARACTER_LANGUAGES`, `CharacterLanguage`, `StylePreset`, `MessageExample`
- **Wallet:** `WalletConfigStatus`, `WalletKeys`, `WalletBalancesResponse`, `BscTradeQuoteResponse`, `BscTradeExecuteResponse`, `StewardPolicyResult`, `EvmSigningCapabilityKind`, `WalletTradingProfileResponse`, and ~70 additional types for EVM/Solana balances, NFTs, trades, transfers, and Steward webhooks

This package has **no dependencies** — not even `@elizaos/core`. Any logic that operates on these types belongs in `@elizaos/core` or the package that owns the use case.

## Commands

```bash
bun run --cwd packages/contracts build        # tsc --noCheck (emit d.ts + js to dist/)
bun run --cwd packages/contracts typecheck    # tsgo --noEmit
bun run --cwd packages/contracts lint         # biome check --write --unsafe
bun run --cwd packages/contracts lint:check   # biome check (read-only)
bun run --cwd packages/contracts format       # biome format --write
bun run --cwd packages/contracts format:check # biome format (read-only)
bun run --cwd packages/contracts clean        # rm -rf dist
```

## Config / env vars

None. This package reads no env vars and has no config.

## How to extend

**Add a new contract type:**
1. Decide which module owns the new type. If it is a new domain, create `src/<domain>.ts`.
2. Write the type with a JSDoc comment pointing to where the resolution logic lives (e.g., `@elizaos/core`).
3. Add `export * from './<domain>.js';` to `src/index.ts`.
4. If `@elizaos/core` or `@elizaos/shared` should re-export it, add the explicit named import to `packages/core/src/index.ts` (the shim list) or the relevant `packages/shared/src/contracts/*.ts` relay.

**Guiding rule:** types go here; all logic, validation, normalization, and runtime resolution stay in `@elizaos/core` or the owning service package.

## Conventions / gotchas

- **No runtime code.** The package has zero runtime dependencies (`devDependencies` only). Any `const` exported here must be a pure compile-time literal (like `CHARACTER_LANGUAGES as const`).
- **Import with `.js` extension.** Source files import siblings as `./cloud-topology.js` — ESM build requirement.
- `@elizaos/core` re-exports only a cherry-picked subset (not the full barrel) to avoid `d.ts` generation ambiguity with long-standing `core` exports. Do not add blanket `export * from '@elizaos/contracts'` to `core`.
- `@elizaos/shared` re-exports the full wallet and service-routing types from here; prefer importing those contracts directly from `@elizaos/contracts` in new code rather than going through `@elizaos/shared`.
- `EvmSigningCapabilityKind` source of truth is documented as `packages/agent/src/services/evm-signing-capability.ts` — keep the type in sync when that file changes.
- Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../AGENTS.md).
