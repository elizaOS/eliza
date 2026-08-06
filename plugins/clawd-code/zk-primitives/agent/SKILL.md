---
name: clawd-zk-agent
description: Drive the on-chain clawd-zk program (nullifiers, Groth16 proofs, Light Protocol compressed state) from a Clawd agent or REPL. Use when the user wants to attest a model, commit encrypted state, verify a proof, derive a nullifier, or ask a natural-language question that maps to any of those verbs.
when_to_use: |
  Use this skill whenever the request is one of:
    - "attest this model with hash 0xab12… and proof.json"
    - "publish an attestation for my fine-tuned model"
    - "commit this encrypted state blob to clawd-zk"
    - "verify this Groth16 proof against the publish inputs"
    - "derive a nullifier for context foo"
    - "show me the clawd-zk config" / "inspect the zk agent"
  Do NOT use it for: on-chain trading (→ clawd-pump), voice calls
  (→ Hermes voice agent), or generic Solana RPC queries (→ Helius).
inputs:
  - modelHash            (optional, hex) — 32-byte model hash for attest intents
  - payloadCommitment    (optional, hex) — 32-byte payload commitment for attest
  - ciphertextCommitment (optional, hex) — 32-byte ciphertext commitment for commit
  - stateVersion         (optional, number) — version number for commit (default 1)
  - context              (optional, string) — domain-separated context tag
  - proofPath            (optional, string) — path to a Groth16 proof JSON file
  - proof                (optional, Groth16Proof) — inline proof if not loading from disk
outputs:
  - nullifierHex            (string) — the derived 32-byte nullifier (hex)
  - publicInputsPackedHex   (string) — the canonical 32-byte-per-field public input vector
  - instruction             (TransactionInstruction) — ready-to-sign Solana instruction
  - signature               (string, optional) — the on-chain tx signature when a signer is attached
  - summary                 (string) — human-readable summary of the operation
env:
  required: [CLAWD_ZK_RPC_URL]
  optional:
    - CLAWD_ZK_PROGRAM_ID
    - CLAWD_ZK_PHOTON_URL
    - CLAWD_ZK_API_KEY
    - CLAWD_ZK_COMMITMENT
    - CLAWD_ZK_KEYPAIR
    - CLAWD_ZK_NETWORK
---

# clawd-zk-agent

A Clawd agent that drives the on-chain **clawd-zk** program
(Anchor / Solana). The program provides three primitives:

1. **`publish_attestation`** — nullifier-gated Groth16-verified attestation.
2. **`commit_encrypted_state`** — Groth16-verified commitment to encrypted state.
3. **`consume_attestation`** — Groth16-verified consume (one-shot read).

This skill wraps the low-level `@clawd/zk-client` SDK and exposes the
four operations a Clawd agent would actually want to call:

| Method | Purpose |
|---|---|
| `agent.attestModel({ modelHash, payloadCommitment, proof, context })` | `publish_attestation` |
| `agent.commitEncryptedState({ modelHash, ciphertextCommitment, stateVersion, proof })` | `commit_encrypted_state` |
| `agent.verifyProof({ proof, publicInputs?, … })` | Off-chain Groth16 sanity check |
| `agent.computeNullifierFor(secret, context)` | Deterministic 32-byte nullifier |

Plus a **deterministic natural-language intent router**
(`routeIntent(text, agent, ctx)`) so any Clawd component (REPL,
MCP tool, Telegram bridge, voice agent) can call this skill with
free-form text and get back a typed `{ intent, action, args,
confidence, rationale }` plan.

## Quick start (for an LLM calling this skill)

```ts
import { ClawdZkAgent, routeIntent, dispatchRoute } from "@clawd/zk-agent";

const agent = await ClawdZkAgent.fromEnv();

// 1. Route the user's request
const route = routeIntent(
  "attest this model 0xab12cd34… with my proof.json",
  agent,
  { payloadCommitment: "0x" + "ab".repeat(32) },
);
//   → { intent: "attest-model", action: "attestModel", confidence: 0.9, ... }

// 2. (Optional) Review the plan with the user
console.log(route.rationale, route.args);

// 3. Dispatch
const result = await dispatchRoute(route, agent);
//   → { nullifierHex, publicInputsPackedHex, instruction, signature?, summary }
```

The router is **deterministic and rule-based** — no model calls, no
network. It matches verbs in the input text and combines them with
explicit `ctx` overrides to pick the right action.

## Recognised intents

| Verb (regex) | Routed action | Required ctx |
|---|---|---|
| `attest`, `attestation`, `publish`, `publish_attestation` | `attestModel` | `modelHash`, `payloadCommitment`, `proofPath` |
| `commit`, `commit_state`, `encrypted state`, `ciphertext` | `commitEncryptedState` | `ciphertextCommitment`, `stateVersion`, `proofPath` |
| `verify`, `check`, `validate` | `verifyProof` | `proofPath` |
| `nullifier`, `derive`, `compute_nullifier` | `computeNullifier` | `context` |
| `inspect`, `config`, `status`, `show` | `describe` | — |
| `help`, `usage`, `how`, `what` | `help` | — |

If multiple verbs match, the highest-weight one wins. If nothing
matches, the router returns `help` with confidence 0.1.

## CLI

The package also ships a binary `clawd-zk-agent` with the same verbs
as subcommands. Useful for scripts, CI, and operators.

```bash
clawd-zk-agent inspect
clawd-zk-agent attest  <modelHash> <payloadCommitment> <proof.json> [--context "…"]
clawd-zk-agent commit  <ciphertextCommitment> <stateVersion> <proof.json> [--model <modelHash>]
clawd-zk-agent verify  <proof.json>
clawd-zk-agent nullifier "context-tag"
clawd-zk-agent ask    "natural language"
```

The proof JSON shape:

```json
{
  "a": "0x…",            // 64 bytes
  "b": "0x…",            // 128 bytes
  "c": "0x…",            // 64 bytes
  "verifyingKey": "0x…"  // optional, variable length
}
```

## When NOT to use this skill

- For perpetuals trading → use the `vulcan` skill family.
- For real-time voice → use the `voice-call` skill family.
- For a generic RPC query (balance, account info, transaction
  lookup) → use the `helius` skill family.
- For an action that needs the on-chain *verifier* (the real
  pairing check) → drive `clawd-zk` directly via the program; this
  skill only does off-chain preparation.

## Failure modes the agent should surface to the user

- `CLAWD_ZK_RPC_URL is not set` — tell the user to add it to
  `~/.clawd-code/.env` or pass `rpcUrl` explicitly.
- `Invalid CLAWD_ZK_PROGRAM_ID: …` — the value is not a base58 pubkey
  and not a known alias. List the valid aliases
  (`CLAWDZK_MAINNET` / `CLAWDZK_DEVNET` / `CLAWDZK_LOCALNET`).
- `proof.a expected 64 bytes, got 63` — the proof JSON is malformed;
  tell the user to re-export from the prover.
- `nullifier secret must be at least 16 bytes` — supply a real key.

## Cross-references

- The lower-level SDK is `@clawd/zk-client`
  (see `zk-primitives/client/`).
- The Anchor program is at `zk-primitives/programs/clawd-zk/`.
- The deep dive (cost model, security assumptions, instruction
  layouts) is in `zk-primitives/docs/ARCHITECTURE.md`.
- The full agent catalog is at the repo root `AGENTS.md`.
- The harness that drives every Clawd agent is `clawd-code/`
  (Grok-first).
