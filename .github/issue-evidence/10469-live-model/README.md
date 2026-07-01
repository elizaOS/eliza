# #10469 — live-model trajectory + extended detectors

## Live-model trajectory (real provider, no mock/proxy)

`capture-live-trajectory.mjs` drives the **real `SecretSwapSession`** against the
**real Cerebras `gpt-oss-120b`** provider and writes `trajectory-report.json`.
It proves all four acceptance criteria:

| criterion | field | result |
|---|---|---|
| (a) no real secret in the prompt to the provider | `stage2_assert_noRawSecretInProviderRequest` | **true** |
| (b) model output keeps the placeholder (→ trajectory/logs/response) | `stage3_modelOutput_containsPlaceholder` / `…containsRawSecret` | **true / false** |
| (c) executed command gets the real value after restore | `stage4_restored_containsRealSecret` | **true** |
| (d) user-visible response shows the placeholder | `stage3_modelOutput_keepsPlaceholder` | placeholder kept |

The real `sk-ant-…` key is swapped to `__ELIZA_SECRET_<nonce>_1__` before the
POST to `api.cerebras.ai`; the model wires the placeholder into
`export ANTHROPIC_API_KEY="__ELIZA_SECRET_<nonce>_1__"`; restoring at the
execution boundary yields the real key. Re-run:
`CEREBRAS_API_KEY=… bun capture-live-trajectory.mjs`.

## Extended detector coverage (issue-named classes)

Added on top of the merged foundation (#10475/#10551): **seed-phrase** (BIP-39
wordlist + checksum, all windows in a run), **wif-private-key** (base58check),
**url-credentials** (DB connection strings + passwords in URLs), **anthropic-key**
(labelled before openai-key), **stripe-webhook-secret**, **slack-webhook-url**,
**basic-auth-header** (base64 user:pass), **google-oauth-refresh-token**,
**telegram-bot-token**, **pgp-private-key** (OpenSSH already covered by PEM). The
`redact.ts` assignment keywords now include `PASSPHRASE|MNEMONIC|SEED|CREDENTIAL`.

### Registry/config-derived catalog

`isSecretKey()` + `deriveKnownSecrets()` (canonical `CANONICAL_SECRET_KEYS` +
open-ended name regex) let `createSecretSwapSession` seed **every secret-bearing
env value** into the session — so a plugin's `FOO_API_KEY` is swapped even when
it never appears in a recognised inline token shape. This is the derived catalog
the issue requires, not a hand-copied list.

### Tests (all green)

- `pii-detectors-extended.test.ts` — validators (`mnemonicValid` checksum,
  `wifValid` base58check, `findMnemonicPhrase`), every new class positive +
  negative, and the catalog (`isSecretKey`/`deriveKnownSecrets`).
- `secret-swap.fuzz.test.ts` — the seeded fuzz now injects the new classes; the
  no-leak/round-trip invariants hold. The fuzz **caught a real bug**: two adjacent
  BIP-39 mnemonics in one word run left the second unswapped — fixed by
  `findAllMnemonicPhrases` + the detector `findSpans` hook (all windows emitted).
- `packages/core` typecheck + biome clean; gitleaks allowlist covers the fixture files.
