# #10469 — PII/secret detectors + validity/fuzz/red-team/benchmark suites

Extends the foundation PR #10475 (opt-in `SecretSwapSession` at the `useModel`
boundary) with: a **comprehensive, validated detector registry**, an
**unforgeable session nonce**, and the **exhaustive test apparatus** the issue
requires. Scope of this slice: the **detection + verification** half. The
turn-scoped egress wiring across `useModel → action exec` remains the
foundation's next slice (per #10475's own note).

## What landed

### 1. `packages/core/src/security/pii-detectors.ts` — detector registry (16 classes)

Each detector is a global regex + an optional structural validator so false
positives are rejected, not just matched:

| class | validation |
|---|---|
| `credit-card` | **Luhn (mod-10)** + major-brand prefix (Visa/MC/Amex/Discover/Diners/JCB) |
| `iban` | **ISO-13616 mod-97** |
| `ssn` | SSA allocation rules (rejects area `000`/`666`/`≥900`, group `00`, serial `0000`) |
| `ipv4` | octet range 0–255 |
| `email`, `jwt`, `phone`, `mac-address`, `hex-secret` (0x64) | shape |
| `aws-access-key`, `stripe-key`, `google-api-key`, `github-token`, `openai-key`, `slack-token`, `private-key` (PEM) | shape |

`detectPii(text, {disabledKinds})` resolves overlaps (longest span wins) and
returns ordered spans. Wired into `SecretSwapSession.substituteText` (replacing
the prior 3 inline PII regexes) with a per-class opt-out (`disabledKinds`) on top
of the existing per-value opt-out (`exemptValues`).

### 2. `secret-swap.ts` — unforgeable per-session nonce

Placeholders are now `__ELIZA_SECRET_<random-nonce>_<n>__`. Restore + the
execution-boundary assert match **only this session's nonce**, so a user/model
cannot forge a placeholder that hijacks a real secret, and benign text that
happens to contain a placeholder-shaped substring is not falsely failed. A
this-session placeholder the model *fabricated* (`…_999__`) still fails loud.

## Verification (all green)

```
Test Files  5 passed (5)
     Tests  41 passed (41)
```

- **Validity** (`pii-detectors.test.ts`, 21): per-detector positives/negatives;
  Luhn/IBAN/SSN/IPv4 checksum edges; brand classification; overlap + ordering.
- **Fuzz** (`secret-swap.fuzz.test.ts`, 4): seeded mulberry32, **4000 iterations**
  of secret-bearing docs + **2000 random-unicode** docs. Invariants: round-trip
  identity, no-leak, deterministic placeholders, idempotence.
- **Red-team** (`secret-swap.redteam.test.ts`, 10): forged/legacy placeholders,
  model-reintroduced raw secret (egress guard), deep nesting, placeholder-shaped
  secret values, per-value/per-class opt-out, overlapping secrets, split-secret
  limitation (documented), fail-loud in structures.
- **Foundation + runtime integration** (6): nonce-tolerant; no raw secret in the
  prompt the handler receives or in streamed chunks.
- **Typecheck**: `tsc --noEmit -p packages/core` clean. **Biome**: clean.

## Benchmark (`secret-swap.bench.ts`, `vitest bench`)

| op | throughput | mean |
|---|---|---|
| `detectPii` — 100 KB benign (FP scan) | 74 hz | 13.4 ms |
| `detectPii` — 50 KB secret-dense | 140 hz | 7.2 ms |
| `substituteText` — 50 KB dense (ingress) | 270 hz | 3.7 ms |
| substitute + restore round-trip — 50 KB dense | 371 hz | 2.7 ms |

## Real bugs the fuzz/red-team caught and fixed

1. **Phone false-positive** — a bare 10-digit run (order id / timestamp) matched
   the phone detector. Tightened to require a separator or `+country`.
2. **Credit-card miss (leak)** — the prior `(?:\d[ -]?){12,18}\d` greedily
   consumed a leading stray digit (`"42 4768…"` → 18 digits), failed Luhn, and
   `matchAll` never retried the inner valid card → the card **leaked**. Fixed to
   match a 13–19 digit block or fixed card-style groups. (Caught by the fuzz
   no-leak property.)
3. **Placeholder collision / forgery** — fixed-format `__ELIZA_SECRET_1__`
   placeholders could collide with user/model text, hijacking restore. Fixed with
   the per-session nonce + session-scoped restore/assert. (Caught by the
   red-team.)

## Egress wired end-to-end (the execution boundary)

The same session created at `useModel` ingress is now reused at the true
execution boundary so a real secret is restored only there:

- **Turn-scoped session** (`trajectory-context.ts`): `secretSwapSession` rides the
  AsyncLocalStorage trajectory context that already spans ingress `useModel` →
  action exec. `useModel` (`runtime.ts`) mints it on the first call of a turn and
  reuses it on every later call so all share one nonce; outside a trajectory scope
  it falls back to a per-call session (no egress).
- **Single restore funnel** (`execute-planned-tool-call.ts`): every model-selected
  action (top-level planner, sub-planner, autonomy) funnels through
  `executePlannedToolCall`. Just before `action.handler`, the model-emitted args
  are `restoreInValue(..., { failOnUnresolved: true })` — the real secret reaches
  the handler; the model, transcripts, logs, and trajectory upstream kept the
  placeholder. A this-turn placeholder the model **fabricated** fails loud (the
  action fails; nothing is sent to a real endpoint).
- **Entirely gated** behind `ELIZA_SECRET_SWAP_ENABLED` (default off): with it off
  there is no turn session, so the egress restore is a zero-cost no-op everywhere.

`secret-swap-egress.test.ts` (3/3) proves it end-to-end: placeholder in a
tool-call arg → handler receives the **real** secret; fabricated placeholder →
fail loud, handler never runs; disabled → arg passes through untouched. Existing
`execute-planned-tool-call` + runtime secret-swap suites: **28/28 unchanged**.

## Remaining (live-model confirmation)

A live-model trajectory (a real provider call showing only placeholders left the
process while the real value reached execution) is the issue's closing-PR
artifact. The full ingress→reason→egress path is proven deterministically here
with a real `SecretSwapSession` (only the model handler is mocked); capturing it
against a live model requires booting the agent with a provider key + a scenario
where the model wires a placeholder into an action.
