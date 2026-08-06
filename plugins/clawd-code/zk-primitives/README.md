# 🦞🔐 Clawd ZK Primitives

> **A zero-knowledge primitive layer for Solana-native AI models.**
> Built on [Light Protocol](https://www.zkcompression.com).
> Powers the on-chain identity, attestation, and encrypted-state
> layer for the Clawd agent fleet.

## What this is

A focused, audited-friendly on-chain program plus a TypeScript SDK
that together provide three ZK primitives the rest of the Clawd
model stack relies on:

1. **Nullifier registry** — a 32-byte, deterministic, per-action hash
   that proves an action was taken exactly once. Stored as a
   compressed PDA (15,000 lamports per nullifier vs. 890,880 for a
   regular PDA). Used for: anti-double-publish, anti-double-claim,
   anti-double-inference-reward.

2. **Groth16 proof verification** — on-chain verifier for the
   bn128 / alt-bn128 zk-SNARK (~200k CU). Used for: model inference
   correctness, encrypted-state commitment, license-bound action
   authorization, ZK identity.

3. **Compressed state via Light Protocol** — model metadata,
   attestation records, and encrypted parameters live in
   rent-free compressed accounts in 26-deep (V1) or 32-deep (V2)
   state trees. Reads via Helius Photon; writes via CPI to the
   Light System Program.

The architecture is documented in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
The reasoning, cost analysis, and security model are all there.

## Repo layout

```
zk-primitives/
├── README.md                                ← you are here
├── docs/
│   └── ARCHITECTURE.md                      ← deep dive: design, costs, security
├── programs/
│   └── clawd-zk/                           ← Anchor program
│       ├── Cargo.toml
│       ├── Xargo.toml
│       └── src/
│           ├── lib.rs                       ← program entry, instruction dispatch
│           ├── nullifier.rs                 ← compressed-PDA nullifier logic
│           ├── proof.rs                     ← Groth16 verifier wrapper
│           └── state.rs                     ← compressed state writes / consumes
├── client/                                  ← TypeScript SDK (@clawd/zk-client)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                         ← public exports
│       ├── types.ts                         ← shared types
│       ├── nullifier.ts                     ← nullifier computation
│       ├── proof.ts                         ← public-input packing + proof serialization
│       ├── state.ts                         ← Light Protocol helpers
│       └── client.ts                        ← high-level ClawdZkClient
├── tests/                                   ← integration tests
│   ├── nullifier.test.ts                    ← vitest, off-chain pieces
│   └── nullifier.rs                         ← cargo test-sbf, on-chain pieces
└── configs/
    └── light-trees.yaml                     ← canonical V2 tree pubkeys
```

## The three instructions

```text
publish_attestation(model_hash, payload_commitment, proof, nullifiers)
   ├── Verifies Groth16(attester, model_hash, payload_commitment, nullifiers)
   ├── CPI → Light System Program
   │   ├── Create nullifier compressed PDA at derived address
   │   └── Write AttestationAccount (compressed state)
   └── Emits: tx log, ~25,000 lamports, ~618k CU

consume_attestation(attestation_address, consume_nonce, proof)
   ├── Verifies Groth16(consumer, attestation_address, consume_nonce)
   ├── CPI → Light System Program
   │   └── Read+modify AttestationAccount (status 0→1)
   └── Emits: tx log, ~5,000 lamports, ~310k CU

commit_encrypted_state(model_hash, ciphertext_commitment, version, proof)
   ├── Verifies Groth16(committer, model_hash, ciphertext_commitment, version)
   ├── CPI → Light System Program
   │   └── Write EncryptedStateAccount (compressed state)
   └── Emits: tx log, ~5,300 lamports, ~410k CU
```

## Quick start

### Install

```bash
# Install the on-chain deps
cd programs/clawd-zk
cargo build-sbf

# Install the client SDK
cd ../../client
pnpm install   # or npm install
```

### Use the SDK

```ts
import { ClawdZkClient, computeNullifier } from "@clawd/zk-client";
import { createSolanaRpc, createKeyPairSignerFromBytes } from "@solana/kit";

const rpc = createSolanaRpc("https://mainnet.helius-rpc.com?api-key=...");
const signer = await createKeyPairSignerFromBytes(secretKey);
const client = new ClawdZkClient({ rpc, programId: PROGRAM_ID });

// 1. Compute the nullifier.
const nullifier = await computeNullifier({
  secret: signer.secretKey,
  context: "model-attestation:abc123",
});

// 2. Build the publish-attestation instruction.
//    (The Groth16 proof is generated off-chain and supplied by the caller.)
const ix = await client.publishAttestation({
  signer: signer.address,
  modelHash: hexToBytes("ab12..."),
  payloadCommitment: hexToBytes("cd34..."),
  nullifier,
  proof: { a: proofA, b: proofB, c: proofC, verifyingKey },
});

// 3. Send.
const sig = await sendAndConfirm([ix], signer);
console.log("attestation published:", sig);
```

### Test

```bash
# Off-chain tests (vitest)
cd client
pnpm test

# On-chain tests (cargo test-sbf)
cd programs/clawd-zk
# In another terminal, first run:
#   light test-validator
# Then:
cargo test-sbf
```

## Why this matters for the Clawd stack

The `ai-training/` pipeline produces fine-tuned models. The
`clawd-zk` primitive gives those models a verifiable on-chain
footprint:

- **Provenance**: every published inference or attestation gets a
  nullifier, so the same model can't claim the same reward twice.
- **Confidentiality**: weights and training data can be committed
  in encrypted form, with the proof attesting the committer's
  authority to publish.
- **Portability**: a Clawd agent on any chain, on any device, can
  read a model's attestation by querying the Helius Photon indexer
  with a single `getCompressedAccount` call.

This is the missing layer between "we trained a model" and "we
have provable, on-chain, sovereign identity for that model."

## Status

**Scaffold**: All modules compile-check, all tests are written and
parse, the SDK structure mirrors the reference `nullifier_creation`
crate from Light Protocol. Production deployment requires:

1. Generate the canonical `LIGHT_CPI_SIGNER` via `anchor idl build`.
2. Set up a per-circuit Powers-of-Tau ceremony for the Groth16 VK.
3. Run `light test-validator` + `cargo test-sbf` against a deployed
   V2 mainnet/devnet tree set.
4. Wire the `Borsh` encoding layer (replace the JSON-encode shim
   in `client.ts` with proper `BorshInstructionCoder` from
   `@coral-xyz/anchor`).

The architecture is designed to be reviewable: the on-chain program
is < 400 lines of Rust across 4 files, and the off-chain SDK is
< 300 lines of TypeScript across 5 files.

## See also

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the deep dive
- [`../ai-training/README.md`](../ai-training/README.md) — the model
  training pipeline that produces the weights this primitive attests to
- [`../AGENTS.md`](../AGENTS.md) — the Clawd agent catalog
- [Light Protocol docs](https://www.zkcompression.com) — the
  underlying ZK compression framework
- [light-verifier](https://docs.rs/light-verifier) — the on-chain
  Groth16 verifier we use
- [Helius Photon](https://docs.helius.dev) — the indexer that
  serves compressed-state reads

## License

Apache-2.0. The on-chain program and the TypeScript SDK are both
under Apache-2.0. The Light Protocol dependencies retain their
upstream licenses.
