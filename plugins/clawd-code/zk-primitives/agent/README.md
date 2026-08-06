# 🦞🔐 @clawd/zk-agent

> **The Clawd ZK Agent** — an agent-shaped wrapper around
> [`@clawd/zk-client`](../client/) that turns the nullifier / Groth16 /
> Light Protocol primitives into intent-routable operations a Clawd
> agent can call directly. Ships a CLI (`clawd-zk-agent`), a typed
> TypeScript API (`ClawdZkAgent`), and a deterministic natural-language
> intent router.

The ZK primitive on its own is a low-level SDK: nullifier
computation, Groth16 proof assembly, Light Protocol state-tree
plumbing. Useful, but it forces every Clawd agent that wants to
attest a model to re-derive the same wiring. `@clawd/zk-agent` wraps
that wiring in a single class and a single CLI, so an agent can do:

```ts
const agent = await ClawdZkAgent.fromEnv();
const { nullifierHex, signature } = await agent.attestModel({
  modelHash: ...,
  payloadCommitment: ...,
  proof,
  context: "model-attest:v1:my-model",
});
```

…without ever touching `ClawdZkClient.publishAttestation` directly.

## Repo layout (this package)

```
agent/
├── package.json
├── tsconfig.json
├── README.md                         ← you are here
├── SKILL.md                          ← loadable by Clawd Code / Claude / Cursor
├── src/
│   ├── index.ts                      ← public exports
│   ├── agent.ts                      ← ClawdZkAgent class
│   ├── config.ts                     ← env-driven ZkAgentConfig
│   ├── intents.ts                    ← deterministic natural-language router
│   └── cli.ts                        ← clawd-zk-agent binary
└── tests/
    └── agent.test.ts                 ← vitest, off-chain only
```

## Install (inside the monorepo)

```bash
# from the repo root
pnpm install              # workspaces resolve @clawd/zk-client automatically
pnpm --filter @clawd/zk-agent build
pnpm --filter @clawd/zk-agent test
```

## CLI

```bash
# Show the active configuration (program, RPC, network, signer).
clawd-zk-agent inspect

# Build a publish_attestation instruction.
clawd-zk-agent attest <modelHash> <payloadCommitment> <proof.json> \
    [--context "model-attest:v1:my-model"]

# Build a commit_encrypted_state instruction.
clawd-zk-agent commit <ciphertextCommitment> <stateVersion> <proof.json> \
    [--model <modelHash>]

# Off-chain Groth16 sanity check (point sizes + public input packing).
clawd-zk-agent verify <proof.json>

# Derive a deterministic 32-byte nullifier for a context.
clawd-zk-agent nullifier "model-attest:v1:my-model"

# Natural-language intent router.
clawd-zk-agent ask "attest this model 0xab12… with my proof"
```

The proof JSON shape:

```json
{
  "a": "0x0102…",          // 64 bytes
  "b": "0x0102…",          // 128 bytes
  "c": "0x0102…",          // 64 bytes
  "verifyingKey": "0x0102…" // optional, variable length
}
```

## Programmatic API

```ts
import { ClawdZkAgent } from "@clawd/zk-agent";

// 1. From env (recommended)
const agent = await ClawdZkAgent.fromEnv();

// 2. Or build it explicitly
const agent = ClawdZkAgent.create({
  config: {
    rpcUrl: "https://mainnet.helius-rpc.com?api-key=…",
    programId: /* base58 */,
    photonUrl: "https://mainnet.helius-rpc.com",
    commitment: "confirmed",
    network: "mainnet",
  },
  signer: myKeypair, // optional
});

// 3. Use it
const result = await agent.attestModel({
  modelHash: new Uint8Array(32),
  payloadCommitment: new Uint8Array(32),
  proof: { a: ..., b: ..., c: ..., verifyingKey: ... },
  context: "model-attest:v1:my-model",
});
console.log(result.nullifierHex);
console.log(result.signature);
```

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `CLAWD_ZK_RPC_URL` | — (required) | Helius or other Solana RPC URL. |
| `CLAWD_ZK_PROGRAM_ID` | `CLAWDzk11…111` (mainnet) | Base58 pubkey, or one of the named aliases `CLAWDZK_MAINNET` / `CLAWDZK_DEVNET` / `CLAWDZK_LOCALNET`. |
| `CLAWD_ZK_PHOTON_URL` | = `CLAWD_ZK_RPC_URL` | Helius Photon indexer for compressed-state reads. |
| `CLAWD_ZK_API_KEY` | none | If your RPC needs a separate header. |
| `CLAWD_ZK_COMMITMENT` | `confirmed` | `processed` \| `confirmed` \| `finalized`. |
| `CLAWD_ZK_KEYPAIR` | none | Path to a Solana CLI keypair JSON (used for signing). |
| `CLAWD_ZK_NETWORK` | `mainnet` | `mainnet` \| `devnet` \| `localnet`. Used only for the `inspect` report. |

## The four core operations

| Method | On-chain ix | Purpose |
|---|---|---|
| `agent.attestModel({ modelHash, payloadCommitment, proof, context })` | `publish_attestation` | Proves a model was attested to, with a nullifier to prevent double-claim. |
| `agent.commitEncryptedState({ modelHash, ciphertextCommitment, stateVersion, proof })` | `commit_encrypted_state` | Commits an encrypted state blob (weights, training data) with a license-bound proof. |
| `agent.verifyProof({ proof, publicInputs?, … })` | off-chain only | Sanity check the proof is well-formed and the public inputs match the expected shape. |
| `agent.computeNullifierFor(secret, context)` | off-chain only | Deterministic 32-byte hash that prevents double-action. |

## Intent router

The router is rule-based and deterministic — no model calls — so it is
fast, predictable, and CI-testable. Recognised verbs:

| Verb (regex) | Routed action |
|---|---|
| `attest`, `attestation`, `publish`, `publish_attestation` | `attestModel` |
| `commit`, `commit_state`, `encrypted state`, `ciphertext` | `commitEncryptedState` |
| `verify`, `check`, `validate` | `verifyProof` |
| `nullifier`, `derive`, `compute_nullifier` | `computeNullifier` |
| `inspect`, `config`, `status`, `show` | `describe` |
| `help`, `usage`, `how`, `what` | `help` |

The router is exported as `routeIntent(text, agent, ctx)` so any
Clawd component (REPL, MCP tool, Telegram bridge, etc.) can call it
without going through the CLI.

## Why this matters for the Clawd stack

`@clawd/zk-agent` is the agent-shaped surface of the
[`clawd-zk`](../programs/clawd-zk/) on-chain program. Without it,
every Clawd agent that wants to publish an attestation has to:

1. Build the right nullifier, with the right domain tag.
2. Fetch the right V2 state tree, validity proof, and address tree.
3. Pack the public inputs, serialise the proof, encode the
   instruction data.
4. Sign and submit, and handle the response.

With it, an agent does:

```ts
await agent.attestModel({ … });
```

…and trusts the SDK to get the plumbing right. The class is
intentionally thin so that any Clawd agent — `clawd-code`, the
Leviathan OODA loop, the Hermes voice agent, the x402 micro-agents —
can drop it in.

## Status

Scaffold: all modules compile-check, all tests pass, the CLI runs
end-to-end (the `inspect` and `nullifier` subcommands work without
network; the others require `CLAWD_ZK_RPC_URL`).

Production deployment requires:

1. Wire the `trySend` hook in `agent.ts` to `@solana/kit`'s
   `sendAndConfirm` (one method).
2. Generate the canonical `LIGHT_CPI_SIGNER` via `anchor idl build`
   and bake the resulting pubkey into the program.
3. Set up a per-circuit Powers-of-Tau ceremony for the Groth16 VK
   (and ship the resulting VK in the production release artifact).
4. Replace the JSON-encode shim in `client.ts` with the real
   `BorshInstructionCoder` from `@coral-xyz/anchor`.

## See also

- [`../README.md`](../README.md) — the parent `zk-primitives` doc
- [`../client/`](../client/) — the lower-level SDK (`@clawd/zk-client`)
- [`../programs/clawd-zk/`](../programs/clawd-zk/) — the Anchor program
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — the deep dive
- [`../configs/light-trees.yaml`](../configs/light-trees.yaml) — the canonical V2 tree pubkeys
- [`../tests/`](../tests/) — the off-chain and on-chain test suites
- [`../../AGENTS.md`](../../AGENTS.md) — the Clawd agent catalog
- [`../../clawd-code/`](../../clawd-code/) — the Grok-first harness that drives every Clawd agent

## License

Apache-2.0. The on-chain program, the SDK, and this agent wrapper are
all under Apache-2.0. The Light Protocol dependencies retain their
upstream licenses.
