# Clawd ZK Primitive — Architecture

> **A ZK primitive layer for Solana-native AI models.**
> Built on Light Protocol, designed for the Clawd agent fleet.

## 1. Goals

The Clawd ZK primitive provides three on-chain capabilities that are
useful for the full Clawd model stack:

| Capability | What it does | Why it matters |
|------------|-------------|----------------|
| **Nullifier registry** | Prevents double-publish of model attestations, double-claim of inference rewards, double-issuance of agent tokens | A Clawd agent must be able to prove "I attested to this model exactly once" without trusting any central registry |
| **Groth16 proof verification** | Verifies a Groth16 zk-SNARK on-chain (~200k CU) | The agent can prove off-chain computation (inference, gradient step, encryption key derivation) without re-executing on-chain |
| **Compressed state** | Stores attestation records, encrypted model parameters, and zk-nullifiers in Light Protocol state trees (rent-free) | Makes the system scalable to millions of model attestations without exhausting rent budget |
| **Encrypted state** | Commits ciphertext hashes; plaintext stays off-chain | Agents can publish state without leaking model weights or training data |

## 2. Why ZK on Solana

Solana is the highest-throughput, lowest-cost L1 with first-class
program execution. With Light Protocol's ZK Compression:

- **67M leaves per state tree** (V2: 4B) means we can store every
  attestation ever issued, ever, for a fixed cost of ~5k lamports per
  tree per instruction.
- **128-byte validity proofs** let us prove a Merkle inclusion in a
  single constant-size field of the transaction.
- **Photon indexer** (Helius, Triton) serves Merkle proofs over a
  standard JSON-RPC interface, so any agent can read compressed state
  with the same tooling it uses for regular accounts.

For a per-action primitive like "publish attestation" or "consume
license," the economics are:
- **15,000 lamports** per new compressed nullifier
- **5,000 lamports** per state tree touched per instruction
- **~300 lamports** per new state leaf
- **~100,000 CU** for validity proof verification
- **~100,000 CU** for state tree Poseidon hashing

Compared to a regular Solana account (~890,880 lamports per nullifier
via PDA, plus the ~50,000 CU for a CPI), compressed nullifiers are
~60× cheaper to create.

## 3. System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                            Clawd Agent (off-chain)                      │
│                                                                        │
│   ┌────────────────┐  ┌─────────────────┐  ┌────────────────────┐      │
│   │ Nullifier      │  │ Groth16         │  │ Photon RPC client  │      │
│   │ computation    │  │ prover (snarkjs │  │ (validity proofs,  │      │
│   │ (Poseidon)     │  │  / gnark / etc.) │  │  compressed reads) │      │
│   └────────────────┘  └─────────────────┘  └────────────────────┘      │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │   (1) signed transaction
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Solana (on-chain)                              │
│                                                                        │
│   ┌────────────────┐  ┌──────────────────┐  ┌────────────────────┐      │
│   │ clawd-zk       │  │ Light System     │  │ State Trees        │      │
│   │ program        │─▶│ Program          │─▶│ (Merkle, ~67M     │      │
│   │                │  │ (CPI: verify     │  │  leaves per tree)  │      │
│   │ ① verify       │  │  proof, append   │  │                    │      │
│   │   Groth16      │  │  to state tree)  │  │ Address Trees      │      │
│   │ ② create       │  │                  │  │ (Merkle, ~1T      │      │
│   │   nullifier    │  │ Account Compress.│  │  leaves)           │      │
│   │ ③ write        │  │ Program          │  │                    │      │
│   │   attestation  │  │ (tree update)    │  │                    │      │
│   └────────────────┘  └──────────────────┘  └────────────────────┘      │
└────────────────────────────────────────────────────────────────────────┘
                           │   (2) state roots
                           ▼
                  ┌─────────────────────┐
                  │ Photon Indexer      │
                  │ (Helius, Triton)    │
                  │  serves: getCompr-  │
                  │  essedAccount,      │
                  │  getValidityProof   │
                  └─────────────────────┘
```

### 3.1 The on-chain program (`clawd-zk`)

Three instructions, all Groth16-gated:

#### `publish_attestation`
Creates a nullifier (compressed PDA at a derived address) and writes
an attestation record (compressed state). Public inputs of the
Groth16 proof:
- `attester` (32 bytes — signer pubkey)
- `model_hash` (32 bytes)
- `payload_commitment` (32 bytes)
- `nullifier[0..N]` (32 bytes each)

#### `consume_attestation`
Reads an existing attestation record via a validity proof, then
transitions its `status` byte from 0 (active) to 1 (consumed).
Public inputs:
- `consumer` (32 bytes)
- `attestation_address` (32 bytes)
- `consume_nonce` (32 bytes — replay protection)

#### `commit_encrypted_state`
Writes a new encrypted-state record to a compressed state leaf.
The Groth16 proof attests that the committer knows the plaintext
(or holds a license to publish). Public inputs:
- `committer` (32 bytes)
- `model_hash` (32 bytes)
- `ciphertext_commitment` (32 bytes)
- `state_version` (u64 LE, padded to 32 bytes)

### 3.2 The TypeScript client (`@clawd/zk-client`)

Four modules:

- `nullifier.ts` — `computeNullifier`, `computeNullifierBatch`,
  `deriveNullifierAddress`
- `proof.ts` — `buildPublishPublicInputs`, `buildConsumePublicInputs`,
  `buildCommitPublicInputs`, `serializeProof`, `verifyGroth16Offchain`
- `state.ts` — `fetchValidityProofV2`, `fetchAddressTreeV2`,
  `fetchRandomStateTreeV2`, `packAccounts`
- `client.ts` — high-level `ClawdZkClient.publishAttestation(...)` and
  `ClawdZkClient.commitEncryptedState(...)` returning ready-to-sign
  `TransactionInstruction`s.

## 4. Cryptographic Details

### 4.1 Nullifiers

A nullifier is a 32-byte field element derived from
`secret || context || nonce` (we use SHA-256 for client-side
ergonomics; production circuits swap to Poseidon for SNARK-friendly
field arithmetic).

The on-chain nullifier is stored as a compressed PDA at an address
derived by:
```
address = derive_address(
    seeds = [b"clawd-zk-nullifier", nullifier_32_bytes],
    address_tree = <V2 address tree>,
    program_id = clawd-zk,
)
```

The address tree rejects the CPI if the address already exists. This
is the "one-shot" property: the nullifier can be created exactly once.

### 4.2 Groth16 verification

We use `light-verifier` (the same crate Light Protocol uses
internally for its validity proofs). The wire format:

- `proof_a`: 64 bytes (G1, big-endian)
- `proof_b`: 128 bytes (G2, big-endian)
- `proof_c`: 64 bytes (G1, big-endian)
- `verifying_key`: variable length — `[G1 alpha; G2 beta; G1 gamma;
  G1 delta; G1[N+1] gamma_abc]` (alt-bn128)

The verifier:
1. Swaps endianness on each G1 element (BN254 uses big-endian
   field elements; Solana Groth16 libs use little-endian).
2. Initializes `Groth16Verifier` with the proof points, public inputs,
   and VK.
3. Calls `verify()` which runs the pairing check.

Cost: ~200,000 CU per verification (Light Protocol benchmarks).

### 4.3 Compressed state

State trees are 26-deep (V1) or 32-deep (V2) binary Merkle trees
maintained by the Light Protocol. Each leaf contains a Poseidon
hash of the compressed account's (data_hash, state_hash, owner,
lamports). The state root is stored in a single Solana account;
the full state is reconstructed by the Photon indexer from on-chain
logs.

Reading:
```ts
const account = await rpc.getCompressedAccount(hash);
```

Writing requires a validity proof (the existing tree root must be
proven to match the on-chain root at the time of the transaction).

## 5. Cost Analysis

| Operation | CU | Lamports |
|-----------|----:|---------:|
| Create 1 nullifier (compressed PDA) | ~206k | 15,000 |
| Create N nullifiers (one tx) | ~206k + 30k per extra | 15,000 + 5k per extra tree |
| Write 1 attestation (compressed state) | ~212k | 5,300 |
| Verify Groth16 proof | ~200k | 0 (CU only) |
| Full publish_attestation (proof + 1 null + 1 state write) | ~618k | ~25,000 |

A typical "publish + consume" cycle for one model attestation:
- 2 transactions × ~25k lamports = 50k lamports (~$0.01 at $200/SOL)
- ~1.2M CU total (under the 1.4M per-tx limit)

## 6. Security Considerations

### 6.1 Trust model
- The user trusts the on-chain program (`clawd-zk`).
- The user trusts the Light System Program (audited; see
  `light-protocol/audits`).
- The user trusts the Groth16 trusted setup (per-circuit).
- The user does **not** trust the Photon indexer for state truth
  (it serves Merkle proofs, which can be re-verified on-chain).

### 6.2 Known attack vectors and mitigations
- **Groth16 trusted setup compromise**: a toxic-waste leak would
  let an attacker forge proofs. Mitigation: use a per-circuit
  ceremony with multiple contributions; the production deployment
  will pin to a Powers-of-Tau output.
- **Nullifier collision (2nd preimage)**: an attacker who finds
  `secret2` such that `Poseidon(secret2, ctx) == nullifier` could
  replay the action. Mitigation: use a 256-bit secret with a
  domain-separated sub-key derivation (e.g. HKDF).
- **Replay of consume-proof**: a valid consume-proof could be
  replayed. Mitigation: `consume_nonce` is a public input; the
  program tracks consumed nonces in compressed state.

### 6.3 Operational notes
- The Light CPI signer is auto-derived from the program ID. For
  mainnet deployment, regenerate the constant via `anchor idl build`.
- Helius Photon indexer must support V2 trees; confirm via
  `getIndexerHealth()` before relying on it.
- Always simulate before sending; ZK transactions are larger than
  vanilla Solana transactions.

## 7. Comparison to Alternatives

| | Clawd ZK + Light | ZK on EVM (e.g. Aztec) | Off-chain ZK only |
|---|---|---|---|
| Proof cost | ~200k CU on Solana | ~300k gas on L1 | 0 (off-chain) |
| State cost | ~5k lamports per tree per tx | ~20k gas per storage slot | Free |
| Finality | ~400ms (Solana) | ~12s (Ethereum L1) | N/A (need separate attestation layer) |
| Composability | Native to Solana programs | Requires L1↔L2 messaging | Requires trusted relayer |
| Trust model | Trust Light System Program | Trust Aztec rollup | Trust the relayer |
| Best for | High-frequency on-chain ZK | EVM liquidity + ZK | Off-chain analytics |

For Solana-native agents, Clawd ZK + Light is the right choice: it
inherits Solana's composability and finality while still giving you
the privacy and verifiability of ZK.

## 8. Future Work

- **Verifiable inference**: integrate a Halo2 / Plonky2 circuit
  for "I ran model M on input X and produced output Y" — proof
  verification stays on-chain at the same cost.
- **Shielded pool**: a ZK mixer over compressed token accounts for
  private agent-to-agent payments (the "shielded pool" reference
  from Light).
- **ZK federation**: let multiple Clawd nodes collaboratively
  train a model, with each step's gradient provably correct via
  Groth16.
- **Cross-program nullifier sharing**: expose a CPI so other
  Clawd programs can read / write the nullifier tree without
  re-implementing the derivation.
