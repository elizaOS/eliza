# @elizaos/plugin-tee

Trusted Execution Environment (TEE) integration plugin for elizaOS. Adds secure key derivation and remote attestation to Eliza agents running inside a TEE.

## What it does

- **Remote attestation** — a `phala-remote-attestation` **provider** that generates a TDX quote over the current message payload (Phala Network / dstack). This is a context provider, **not** an action; the plugin registers no actions (`PhalaVendor.getActions()` returns `[]`).
- **Key derivation** — a `phala-derive-key` **provider** plus the `TEEService`: deterministically derives Ed25519 (Solana) and ECDSA (EVM) keypairs from a secret salt, with per-derivation attestation.
- **TEEService** — a runtime service (`ServiceType.TEE`) that other plugins can call to derive keys without going through providers.

> This plugin exposes **providers + a service only — no actions**. An earlier
> revision of this README implied a `REMOTE_ATTESTATION` action; there is no such
> action. The attestation surface is the `phala-remote-attestation` provider above.
> The provider-neutral evidence/policy/key-release trust contract used by the
> agent boot path lives separately in `packages/agent/src/services/tee-*`
> (`tee-evidence.ts` + `evaluateTeeEvidencePolicy`), not in this plugin.

## Quick start

```typescript
import { teePlugin, TEEService } from "@elizaos/plugin-tee";

const runtime = new AgentRuntime({
  plugins: [teePlugin],
  // TEE_MODE defaults to LOCAL; set WALLET_SECRET_SALT for key derivation
});

// Access via service
const svc = runtime.getService<TEEService>(TEEService.serviceType);
const { keypair, attestation } = await svc.deriveEd25519Keypair("salt", "solana", agentId);
const { keypair: evmKeypair } = await svc.deriveEcdsaKeypair("salt", "evm", agentId);
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TEE_MODE` | no | `LOCAL` | Operation mode: `LOCAL`, `DOCKER`, or `PRODUCTION`. `init` defaults to `LOCAL` when unset and throws only on a present-but-invalid value. |
| `WALLET_SECRET_SALT` | **yes** | — | Secret salt used as the derivation path for all keypairs. Sensitive — treat as a private key. |
| `TEE_VENDOR` | no | `PHALA` | TEE vendor. Only `PHALA` is supported. |

### TEE modes

| Mode | dstack endpoint | Use |
|------|----------------|-----|
| `LOCAL` | `http://localhost:8090` | Local simulator |
| `DOCKER` | `http://host.docker.internal:8090` | Docker simulator |
| `PRODUCTION` | (TappdClient default) | Real TEE hardware |

Run the Phala dstack simulator for `LOCAL`/`DOCKER` development: see [Phala dstack docs](https://github.com/Phala-Network/dstack).

## Providers registered

| Provider | Description |
|----------|-------------|
| `phala-derive-key` | Derives Solana public key and EVM address from `WALLET_SECRET_SALT`; injects `solana_public_key` and `evm_address` into agent context. |
| `phala-remote-attestation` | Generates a TDX quote over the current message payload; injects `quote` and `timestamp`. |

Both providers are dynamic and gated to `secrets` / `agent_internal` contexts.

## TEEService API

```typescript
class TEEService {
  static serviceType: ServiceType.TEE;

  // Derive Ed25519 keypair (Solana)
  deriveEd25519Keypair(path: string, subject: string, agentId: UUID):
    Promise<{ keypair: Keypair; attestation: RemoteAttestationQuote }>;

  // Derive ECDSA keypair (EVM)
  deriveEcdsaKeypair(path: string, subject: string, agentId: UUID):
    Promise<{ keypair: PrivateKeyAccount; attestation: RemoteAttestationQuote }>;

  // Derive raw key bytes
  rawDeriveKey(path: string, subject: string): Promise<DeriveKeyResponse>;
}
```

## Enabling the plugin

Add `@elizaos/plugin-tee` to your agent character's `plugins` array and set the required environment variables. The plugin is opt-in and not auto-loaded.

## Development

```bash
bun run --cwd plugins/plugin-tee build          # compile
bun run --cwd plugins/plugin-tee test           # run tests
bun run --cwd plugins/plugin-tee format:check   # lint
```
