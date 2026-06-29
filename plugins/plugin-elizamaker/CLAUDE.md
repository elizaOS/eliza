# @elizaos/plugin-elizamaker

ERC-8041 NFT drop/mint/whitelist routes, Twitter-verified Merkle proofs, and OG code tracking for Eliza agents.

## Purpose / role

Adds an on-chain NFT drop system to an Eliza agent: exposes HTTP API routes for minting ERC-8041 agent NFTs (public, shiny, and whitelist variants) and Twitter/X-verified whitelist proofs using Merkle trees. It also exports Eliza NFT holder-check helpers (`nft-verify.ts`), though those are not wired to any route. Loaded by adding `@elizaos/plugin-elizamaker` to the agent's plugin list; opt-in only (no default-enable). Requires EVM wallet config and a deployed ERC-8041 collection contract to activate drop/mint functionality.

## Plugin surface

No actions, providers, or evaluators. The plugin registers **8 HTTP routes** and runs initialization on `init`:

| Route | Method | Description |
|---|---|---|
| `/api/drop/status` | GET | Drop phase flags, supply, shiny price, and whether the agent wallet has minted |
| `/api/drop/mint` | POST | Public free mint (agent pays gas) |
| `/api/drop/mint-whitelist` | POST | Whitelist mint with Merkle proof; auto-generates proof from agent EVM wallet if not supplied |
| `/api/whitelist/status` | GET | Twitter/NFT verification status and Merkle tree info for the agent wallet |
| `/api/whitelist/twitter/message` | POST | Returns the verification message the user must post on X |
| `/api/whitelist/twitter/verify` | POST | Verifies a tweet URL via FxTwitter API (no auth needed) and marks the wallet whitelisted |
| `/api/whitelist/merkle/root` | GET | Current Merkle root and address count |
| `/api/whitelist/merkle/proof` | GET | Merkle proof for `?address=<evm>` |

On `init`, the plugin asynchronously bootstraps `RegistryService` (ERC-8004 on-chain agent registry) and `DropService` (ERC-8041 collection) via `initializeRegistryAndDropServices`. Both are stored in module-level singletons and accessed through `drop-service-registry` and `registry-service-registry`.

## Layout

```
src/
  plugin.ts                  Plugin definition, route wiring, Plugin.init bootstrap
  index.ts                   Package public exports
  drop-routes.ts             Route handler logic (all 8 routes in one function)
  drop-service.ts            DropService class — ERC-8041 mint/status via ethers v6
  drop-service-registry.ts   Module singleton for DropService (get/set)
  registry-service-registry.ts  Module singleton for RegistryService (get/set)
  init-registry-services.ts  Bootstrap: reads config, probes RPC, wires TxService/RegistryService/DropService
  merkle-tree.ts             Merkle tree build/proof/verify (no external dep, uses ethers keccak256)
  twitter-verify.ts          Tweet verification via FxTwitter API; whitelist.json persistence
  nft-verify.ts              Eliza NFT holder check on Base (contract 0x5Af0D9827E0c53E4799BB226655A1de152A425a5)
  og-tracker.ts              Writes ~/.eliza/.og UUID on first run; reads/validates OG codes
```

## Commands

Only scripts in `package.json`:

```bash
bun run --cwd plugins/plugin-elizamaker build        # tsup JS + tsc types
bun run --cwd plugins/plugin-elizamaker build:js     # tsup only
bun run --cwd plugins/plugin-elizamaker build:types  # tsc --noCheck only
bun run --cwd plugins/plugin-elizamaker clean        # rm -rf dist
```

No test script in this package's `package.json`.

## Config / env vars

Read during `initializeRegistryAndDropServices` from `loadElizaConfig()` (eliza config file) and `runtime.getSetting()`:

| Name | Source | Required | Notes |
|---|---|---|---|
| `EVM_PRIVATE_KEY` | runtime setting or `config.env.EVM_PRIVATE_KEY` | Yes, to activate | No key → services disabled silently |
| `config.registry.registryAddress` | eliza config file | Yes, to activate | ERC-8004 registry contract address |
| `config.registry.mainnetRpc` | eliza config file | Yes, to activate | JSON-RPC URL; probed before use |
| `config.registry.collectionAddress` | eliza config file | Optional | ERC-8041 collection; omit to skip DropService |
| `config.features.dropEnabled` | eliza config file | Optional | `true` to enable drop routes; default false |
| `ELIZA_NFT_RPC_URL` | `process.env` | Optional | Override RPC for Eliza NFT holder check; defaults to `https://mainnet.base.org` |

Whitelist data is persisted to `<stateDir>/whitelist.json` (mode 0600). OG code is persisted to `<stateDir>/.og` (mode 0600). State dir is resolved via `resolveStateDir()` from `@elizaos/agent`.

## How to extend

**Add a new route:**
1. Add a `{ type, path, rawPath: true }` entry to `elizaMakerRouteSpecs` in `src/plugin.ts`.
2. Add the handler branch in `src/drop-routes.ts` inside `handleDropRoutes()` — match on `method` and `pathname`, destructure `json` and `error` from `ctx` and call `json(res, data)` / `error(res, message)` to respond.
3. No other registration needed; all routes share the single `elizaMakerRoute` handler.

**Add a new service:**
1. Write the service class in a new `src/<name>-service.ts`.
2. Add a module-level singleton file `src/<name>-service-registry.ts` (mirrors `drop-service-registry.ts`).
3. Wire initialization into `initializeRegistryAndDropServices` in `src/init-registry-services.ts`.
4. Expose getters via `src/index.ts` exports.

## Conventions / gotchas

- **No actions/providers/evaluators** — this plugin is pure HTTP route surface. Do not add agent-facing actions here without a deliberate design decision.
- **Service init is async and deferred.** `Plugin.init` fires `void initializeRegistryAndDropServices(runtime)` without awaiting. Routes guard against `null` service and return 503 while the service is still initializing or not configured.
- **ethers v6 only.** `drop-service.ts` and `merkle-tree.ts` use ethers v6 APIs (`ethers.solidityPackedKeccak256`, `ethers.formatEther`, etc.). Do not mix v5 patterns.
- **Merkle tree is in-memory and rebuilt per request** from `whitelist.json`. No caching — acceptable for small whitelists; add caching if the list grows large.
- **FxTwitter API** (`api.fxtwitter.com`) is used for tweet verification — no API key required. Rate limits apply.
- **Eliza NFT contract** is hardcoded to `0x5Af0D9827E0c53E4799BB226655A1de152A425a5` on Base mainnet. `ELIZA_NFT_RPC_URL` overrides the RPC but not the address.
- **NFT verification helpers are not route-wired.** `verifyElizaHolder` and `verifyAndWhitelistHolder` (`nft-verify.ts`) are exported but no HTTP route calls them. The `nftVerified` field in `/api/whitelist/status` is an alias of the Twitter verification state (`nftVerified: twitterVerified`), not a real on-chain check.
- **OG code** is a silent UUID written at first startup to `~/.eliza/.og`. It is surfaced in `/api/whitelist/status` as `ogCode`. Validation helpers (`generateValidCodes`, `isValidOGCode`) are exported from `og-tracker.ts` but not re-exported from the package index and not called at runtime — reserved for external scripts.
- Route handler requires a real Node.js `http.IncomingMessage` / `http.ServerResponse` — will throw `TypeError` if passed a non-Node HTTP adapter.
- See root `AGENTS.md` for repo-wide conventions (logger usage, ESM, naming, architecture rules).

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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
