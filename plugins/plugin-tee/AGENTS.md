# @elizaos/plugin-tee

Trusted Execution Environment (TEE) integration plugin for elizaOS — provides secure key derivation and remote attestation for Eliza agents running inside a TEE.

## Purpose / role

Adds TEE-backed cryptographic primitives to any Eliza agent: deterministic Solana (Ed25519) and EVM (ECDSA) keypair derivation and TDX remote attestation via Phala Network's dstack SDK. Loaded as `teePlugin` (the default export). Opt-in — add it to the `plugins` array in the agent character config. `TEE_MODE` is required; the plugin throws on init if it is missing or invalid.

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
    types.ts                    TeeVendorInterface, TeeVendorNames enum
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
bun run --cwd plugins/plugin-tee build           # compile via build.ts (tsdown)
bun run --cwd plugins/plugin-tee dev             # hot-reload build
bun run --cwd plugins/plugin-tee test            # vitest run src/__tests__/
bun run --cwd plugins/plugin-tee test:watch      # vitest watch
bun run --cwd plugins/plugin-tee format          # biome format --write
bun run --cwd plugins/plugin-tee format:check    # biome format (check only)
bun run --cwd plugins/plugin-tee clean           # rm dist .turbo tsconfig.tsbuildinfo
```

## Config / env vars

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `TEE_MODE` | yes | — | `LOCAL` · `DOCKER` · `PRODUCTION`. Init throws on invalid value. |
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
2. Add an entry to `TeeVendorNames` enum in `src/vendors/types.ts`.
3. Register in the `vendors` map in `src/vendors/index.ts`.
4. Select it via `TEE_VENDOR=<name>` at runtime.

**Add an action:**
1. Create the action in `src/actions/<name>.ts` following @elizaos/core Action interface.
2. Return it from the relevant vendor's `getActions()`.

## Conventions / gotchas

- The plugin currently registers **no actions**. The README's mention of a `REMOTE_ATTESTATION` action is inaccurate — PhalaVendor.getActions() returns [].
- `TEEService` uses `PhalaDeriveKeyProvider` unconditionally regardless of `TEE_VENDOR`; vendor selection in `teePlugin.init` only affects which vendor's providers/actions are registered.
- `WALLET_SECRET_SALT` doubles as the derivation `path` argument inside `phalaDeriveKeyProvider`; it is passed directly to `TappdClient.deriveKey(secretSalt, "solana"|"evm")`.
- `uploadAttestationQuote` POSTs to `https://proof.t16z.com/api/upload` — requires network access in production.
- Node-only: `"eliza": { "platforms": ["node"] }`. No browser entrypoint.
- External deps: `@phala/dstack-sdk` (TappdClient, TDX quotes), `@solana/web3.js` (Keypair), `viem` (keccak256, privateKeyToAccount).
- For architecture rules, logger conventions, and git workflow see the root `AGENTS.md`.
