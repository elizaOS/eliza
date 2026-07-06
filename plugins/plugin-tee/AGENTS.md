# @elizaos/plugin-tee

Trusted Execution Environment (TEE) integration plugin for elizaOS — provides secure key derivation and remote attestation for Eliza agents running inside a TEE.

## Purpose / role

Adds TEE-backed cryptographic primitives to any Eliza agent: deterministic Solana (Ed25519) and EVM (ECDSA) keypair derivation and TDX remote attestation via Phala Network's dstack SDK. Loaded as `teePlugin` (the default export). Opt-in — add it to the `plugins` array in the agent character config. `init` defaults `TEE_MODE` to `LOCAL` when unset and throws only when the supplied value is not one of `LOCAL` / `DOCKER` / `PRODUCTION`.

## Plugin surface

**Actions:** none (PhalaVendor.getActions() returns [])

**Providers** (registered by PhalaVendor):
- `phala-derive-key` — derives a Solana public key and EVM address from `WALLET_SECRET_SALT` via the Phala TappdClient; injects `solana_public_key` and `evm_address` into agent context. Dynamic, contexts: `["secrets", "agent_internal"]`.
- `phala-remote-attestation` — generates a TDX quote over the current message payload; injects `quote` and `timestamp`. Dynamic, same context gate.

**Services:**
- `TEEService` (serviceType: `ServiceType.TEE`) — wraps PhalaDeriveKeyProvider; exposes `deriveEd25519Keypair`, `deriveEcdsaKeypair`, `rawDeriveKey`. Retrieved by other plugins via `runtime.getService<TEEService>(TEEService.serviceType)`.

**Evaluators:** none  
**Routes:** none  
**Events:** none

## Layout

```
src/
  index.ts                      Plugin definition (teePlugin), re-exports
  types/
    index.ts                    Enums (TeeMode, TeeVendor, TeeType), interfaces,
                                parseTeeMode(), parseTeeVendor()
  vendors/
    types.ts                    TeeVendorInterface, TeeVendorNames const object
    phala.ts                    PhalaVendor — wires providers; getActions() → []
    index.ts                    getVendor() factory, re-exports
  providers/
    base.ts                     Abstract DeriveKeyProvider, RemoteAttestationProvider
    deriveKey.ts                PhalaDeriveKeyProvider + phalaDeriveKeyProvider (Provider)
    remoteAttestation.ts        PhalaRemoteAttestationProvider + phalaRemoteAttestationProvider
    index.ts                    Re-exports
  services/
    tee.ts                      TEEService (extends Service)
    index.ts                    Re-export
  utils/
    index.ts                    getTeeEndpoint(), hexToUint8Array(), uint8ArrayToHex(),
                                calculateSHA256(), sha256Bytes(), uploadAttestationQuote()
```

## Commands

```bash
bun run --cwd plugins/plugin-tee build           # compile via build.ts (Bun.build + tsc for declarations)
bun run --cwd plugins/plugin-tee dev             # hot-reload build
bun run --cwd plugins/plugin-tee test            # vitest run src/__tests__/
bun run --cwd plugins/plugin-tee test:watch      # vitest watch
bun run --cwd plugins/plugin-tee format          # biome format --write
bun run --cwd plugins/plugin-tee format:check    # biome format (check only)
bun run --cwd plugins/plugin-tee clean           # rm -rf dist .turbo .turbo-tsconfig.json tsconfig.tsbuildinfo
```

## Config / env vars

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `TEE_MODE` | no (defaults `LOCAL`) | `LOCAL` | `LOCAL` · `DOCKER` · `PRODUCTION`. `init` throws only on a present-but-invalid value. |
| `WALLET_SECRET_SALT` | yes (for key derivation) | — | Secret salt for deterministic keypair derivation. Sensitive. |
| `TEE_VENDOR` | no | `PHALA` | Only `PHALA` is implemented. |

**Endpoint resolution (getTeeEndpoint):**
- `LOCAL` → `http://localhost:8090` (dstack simulator)
- `DOCKER` → `http://host.docker.internal:8090`
- `PRODUCTION` → no endpoint (TappdClient connects to real TEE infra)

## How to extend

**Add a provider to PhalaVendor:**
1. Create `src/providers/<name>.ts` implementing the abstract class from `base.ts` and exporting a `Provider` constant.
2. Export from `src/providers/index.ts`.
3. Add to `PhalaVendor.getProviders()` in `src/vendors/phala.ts`.

**Add a new vendor:**
1. Create `src/vendors/<name>.ts` implementing `TeeVendorInterface` (getActions, getProviders, getName, getDescription).
2. Add an entry to the `TeeVendorNames` const object in `src/vendors/types.ts`.
3. Register in the `vendors` map in `src/vendors/index.ts`.
4. Select it via `TEE_VENDOR=<name>` at runtime.

**Add an action:**
1. Create the action in `src/actions/<name>.ts` following @elizaos/core Action interface.
2. Return it from the relevant vendor's `getActions()`.

## Conventions / gotchas

- The plugin currently registers **no actions** — `PhalaVendor.getActions()` returns `[]`. Remote attestation is the `phala-remote-attestation` **provider**, not an action. The README states this explicitly; do not reintroduce a `REMOTE_ATTESTATION` action claim.
- `TEEService` uses `PhalaDeriveKeyProvider` unconditionally regardless of `TEE_VENDOR`; vendor selection in `teePlugin.init` only affects which vendor's providers/actions are registered.
- `WALLET_SECRET_SALT` doubles as the derivation `path` argument inside `phalaDeriveKeyProvider`; it is passed directly to `TappdClient.deriveKey(secretSalt, "solana"|"evm")`.
- `uploadAttestationQuote` POSTs to `https://proof.t16z.com/api/upload` — requires network access in production.
- Node-only: `"eliza": { "platforms": ["node"] }`, and `build.ts` bundles `src/index.ts` with `target: "node"`. `index.browser.ts` is a browser-unavailable `teePlugin` that only warns "use a server proxy"; it is not wired into package `exports`.
- External deps: `@phala/dstack-sdk` (TappdClient, TDX quotes), `@solana/web3.js` (Keypair), `viem` (keccak256, privateKeyToAccount).
- For architecture rules, logger conventions, and git workflow see the root `AGENTS.md`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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
