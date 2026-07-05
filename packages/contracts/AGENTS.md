# @elizaos/contracts

Pure TypeScript type contracts for elizaOS — no runtime code, no dependencies.

## Purpose / role

This package extracts shared type definitions from `@elizaos/core` so they can be imported by packages that need types but not the full runtime. The only direct dependents are `@elizaos/core` and `@elizaos/shared`; UI and cloud-frontend layers consume these types transitively through `@elizaos/shared`. `@elizaos/core` re-exports a curated subset of these types as a transition shim (`src/index.ts`, lines 16-22). `@elizaos/shared` re-exports the full wallet and service-routing contract types. Nothing in this package executes at runtime — it is declaration-only after build.

## Layout

```
src/
  index.ts            Barrel — re-exports everything from all modules
  cloud-topology.ts   ElizaCloudService, ResolvedElizaCloudTopology
  deployment.ts       DeploymentTargetRuntime, DeploymentTargetConfig
  roles.ts            RoleName, RoleGrantSource, RolesWorldMetadata,
                      ConnectorAdminWhitelist, RolesConfig
  service-routing.ts  LinkedAccount* types, LinkedAccountProviderId union,
                      ServiceCapability, ServiceRouteConfig, ServiceRoutingConfig
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — wallet / chain / contracts:**
- On-chain transaction hash(es) + explorer link, wallet balance **before and after**, and the signed-payload/log trail — run against a testnet or fork.
- Revert / insufficient-funds / nonce / gas-estimation-failure paths, and signature-authorization (role/permission) checks.
- The decision trajectory when an agent initiated the on-chain action.
- Never a mocked RPC asserted green — prove the chain state actually changed.
<!-- END: evidence-and-e2e-mandate -->
