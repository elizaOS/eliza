# Model-Boundary Privacy — Secret Swap & PII Pseudonymization

elizaOS can keep secrets and personal data **out of the LLM provider** entirely.
Two complementary, **opt-in** layers sit at the single model-call funnel
(`AgentRuntime.useModel`): they rewrite the prompt on the way *in* so the provider
sees only masked values, and restore the real values on the way *out* only at the
boundary where they are actually needed (a tool call, the reply shown to the user).
When both are off (the default) there is **zero** behavior change.

| Layer | Covers | Replacement | Restored where | Setting |
| --- | --- | --- | --- | --- |
| **Secret swap** (#10469) | API keys, private keys, seed phrases, DB creds, tokens, and validated PII shapes (email, card, SSN, IBAN, …) | Opaque, per-turn-nonce placeholder `__ELIZA_SECRET_<nonce>_<n>__` | Execution boundary **only** (the reply keeps the placeholder) | `ELIZA_SECRET_SWAP_ENABLED` |
| **PII pseudonymization** (#10769) | Named-entity PII — person, organization, location, street address | A **realistic surrogate** of the same type ("Dana Whitfield" → "Marco Hoffman") | Execution boundary **and** the reply/stream shown to the user | `ELIZA_PII_SWAP_ENABLED` |

The two compose: run together, a secret becomes an opaque placeholder and a name
becomes a fluent surrogate, and neither leaks. The PII pass runs *after* the secret
pass, so the NER model reads secret placeholders, never a raw key.

---

## Why two shapes

A secret (an API key) is something the model must never *reason about* — an opaque
placeholder is correct, and the real value is reinserted only when a tool actually
runs. Named-entity PII is different: the model genuinely needs a *coherent* value to
reason ("draft an email to my manager Dana at Acme about the Rushmore contract") —
so it gets a realistic, consistent surrogate instead. The provider sees a fluent,
plausible prompt containing zero real names/employers/places; the user sees their
real contacts; the executed connector call carries the real recipient.

---

## PII pseudonymization

### What it guarantees

- **Provider, trajectory, and logs see only surrogates** — never a real person,
  organization, location, or street address, on any model call (text, structured,
  streaming, or image-generation prompts).
- **Bijective and reversible.** The same real value maps to the same surrogate for
  the whole turn (a per-session random salt makes the mapping *unlinkable* across
  turns), and restore is exact. The value and surrogate namespaces are kept
  mutually exclusive across the turn, so two contacts can never collapse onto one
  surrogate.
- **Blocklist-aware.** Framework/brand identity (`elizaOS`, `Eliza`, provider
  names) and the agent's own name are never swapped, plus any values you add.
- **Best-effort restore at the boundary.** A surrogate the model rewrote, or a
  genuinely new name it invented, is left as-is rather than mis-restored.

### How detection works

Detection is pluggable behind an async recognizer interface:

- A dependency-free **regex recognizer** ships in core and catches US-style street
  addresses (emails/phones are opt-in there — the secret layer already masks them).
- A local **NER model** — [`dslim/distilbert-NER`](https://huggingface.co/dslim/distilbert-NER)
  (Apache-2.0), covering person / organization / location — is supplied by the
  optional `@elizaos/plugin-pii-guard`
  ([source](https://github.com/elizaOS/eliza/tree/main/plugins/plugin-pii-guard)) via
  `@huggingface/transformers` on `onnxruntime` (native CPU). `@elizaos/core` never
  hard-depends on an ONNX runtime; when the plugin is absent the layer runs
  regex-only (addresses) — degraded coverage, but it never leaks what it *does*
  detect.

The recognizer runs once per model call on the assembled prompt; its inference is
offloaded to the ONNX threadpool so it overlaps the event loop rather than blocking
other turns.

### Enabling it

1. Add the **PII Guard** plugin so the NER model is available (find it in the plugin
   registry as `pii-guard`, or add `@elizaos/plugin-pii-guard`). The model
   (~260 MB fp32) downloads on first use and caches under
   `<stateDir>/local-inference/models`.
2. Set `ELIZA_PII_SWAP_ENABLED=true`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `ELIZA_PII_SWAP_ENABLED` | `false` | Master switch (read by core). |
| `ELIZA_PII_SWAP_EXEMPT_VALUES` | — | Comma-separated exact values to never swap (false-positive opt-out). |
| `ELIZA_PII_SWAP_DISABLED_KINDS` | — | Comma-separated entity kinds to skip, e.g. `location,address`. |
| `ELIZA_PII_NER_MODEL` | `dslim/distilbert-NER` | Override the token-classification model. |
| `ELIZA_PII_NER_SCORE_THRESHOLD` | `0.5` | Minimum model confidence to swap. |

`TEXT_EMBEDDING` calls are intentionally **excluded**: a per-turn-random surrogate
would embed the same real text differently every turn and destabilize semantic
memory retrieval, so embeddings run on the real text. Binary-input modalities
(transcription, audio, video) are skipped too — there is nothing to swap on the way
in.

---

## Secret swap

When enabled, secret-bearing env values (from the character/registry catalog) and
inline secret shapes (keys, PEM blocks, seed phrases, DB URLs with passwords,
validated PII like cards/SSN/IBAN/email) are replaced with an opaque, per-turn-nonce
placeholder before the provider call. The model reasons on placeholders and can wire
one into a tool argument; the **real** value is reinserted only at
`executePlannedToolCall`, and a fabricated placeholder the layer never minted
**fails loud** rather than reaching a real endpoint. The reply and the trajectory
keep the placeholder.

| Setting | Purpose |
| --- | --- |
| `ELIZA_SECRET_SWAP_ENABLED` | Master switch. |
| `ELIZA_SECRET_SWAP_EXEMPT_VALUES` | Comma-separated values to never swap. |

---

## Scope — what this is and is not

These layers cover the **LLM provider boundary**. They are *not* a general data-loss
prevention system:

- They mask what is sent to the **model provider** (and kept out of trajectories and
  logs). They do **not** scrub PII from local memory/knowledge storage, from
  connector payloads sent to non-model services, or from arbitrary application logs
  — those are separate surfaces with their own controls
  (see [`../security.md`](../security.md) and the redaction utilities in
  `@elizaos/core`).
- Detection completeness is bounded by the recognizer. The engine swaps exactly what
  the recognizer reports; a name the NER model misses (recall) is a model-quality
  limit, not a round-trip bug. Raise recall with a lower
  `ELIZA_PII_NER_SCORE_THRESHOLD`, or force-protect a known contact roster via a
  gazetteer recognizer.
- If you point `TEXT_EMBEDDING` at a **remote** embedding provider, that provider
  sees the real text (embeddings are excluded from the swap for retrieval stability).
  Keep embeddings local if that matters for your threat model.

---

## Verification

The layers are covered by unit tests, a 3000- + 1500-iteration seeded property
fuzz (round-trip identity, no-leak, bijection, idempotency, determinism,
boundary-safety), runtime ingress/egress tests, an adversarial review pass, and a
**live-model** trajectory (Cerebras `gpt-oss-120b`) proving the provider received
only surrogates while the executed tool call got the real recipient
(`.github/issue-evidence/10469-pii-ner/`). The local `dslim/distilbert-NER` model is
exercised by a real-model test in the plugin.
