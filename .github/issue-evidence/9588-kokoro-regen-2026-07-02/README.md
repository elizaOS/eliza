# #9588 Kokoro GGUF republish — independent verification addendum (2026-07-02)

Verification lane for the #9588 follow-through (feeds #10726). The republish
itself **already landed** on HF (2026-07-02T04:40Z) and is exercised by PR
#11238; this addendum independently verifies the published artifact and fixes
the last dead `-Q4_K_M` reference (the CI workflow env).

Host: Linux x86-64 desktop, CPU-only. Base: `origin/develop` @ `d49556682b`,
fork submodule pin `ba598f562` (post-#9684). Fused lib rebuilt via
`packages/app-core/scripts/stage-desktop-fused-lib.mjs --variant cpu` (ABI
v12), second configure with `libespeak-ng.so.1` + espeak-ng 1.51 headers
(`Kokoro G2P: libespeak-ng found — real IPA path enabled`).

## 1. Published artifact verification

`https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/2b/tts/kokoro/kokoro-82m-v1_0.gguf`

- **Live**: HTTP 302 → CDN, `x-linked-size: 162546720`,
  `x-linked-etag: 165acd9d2d9b6c2d71fa5bd52b92a2559be08567f58ed496bade076e3d9cb46c`.
  Full download re-hashed to the same sha256 (see `SHA256SUMS`).
- **Old filename dead**: `.../kokoro-82m-v1_0-Q4_K_M.gguf` → HTTP 404.
  Benign for runtime discovery (`CANDIDATE_MODEL_FILES` falls through to the
  canonical F16 name) but was still the pinned `KOKORO_GGUF_PATH` in
  `.github/workflows/kokoro-real-smoke.yml` — fixed in this PR.
- **Tensor check** (`tensor-check-remote.log`, gguf-py reader on the
  downloaded bytes): `general.architecture = kokoro`, **457 tensors**
  (252 F16 matrices + 205 F32 vectors), and the tensor whose absence produced
  the on-device `kokoro_synthesize failed: missing tensor
  'kokoro.bert.embd_proj.bias'` repro is present:
  `kokoro.bert.embd_proj.bias -> F32 [768]` (weight `F16 [128, 768]`).
  The pre-#9684 internal name `kokoro.bert.embd.tok.weight` is absent, as
  expected for the published schema.

## 2. Provenance proof — byte-identical regeneration

Before the course-correction to verification-only, this lane regenerated the
GGUF from scratch: `hexgrad/Kokoro-82M` `kokoro-v1_0.pth` (313 MB) through the
fork's `tools/kokoro/convert_kokoro_pth_to_gguf.py` at pin `ba598f562`. The
result is **byte-identical** to the published file (same sha256
`165acd9d…c46c`, see `SHA256SUMS`). The published artifact is provably the
canonical converter output on the canonical checkpoint — no mystery bytes.

## 3. Real smoke against the published file (`KOKORO_SMOKE_REQUIRE=1`)

`bun plugins/plugin-local-inference/scripts/kokoro-real-smoke.ts` with
`ELIZA_KOKORO_MODEL_DIR` staged from the **downloaded remote bytes** + the
republished `af_bella.bin` (522,240 B), `ELIZA_ASR_BUNDLE` staged for the WER
gate.

| Configuration | Result |
| --- | --- |
| develop as-is (espeak-less lib) — `smoke-develop-doubleg2p-wer1.00.log` | Loads (no missing-tensor error), 3.15 s speech-shaped audio, envelope-cv **1.736**, but ASR hears "Los Nevados said." → **WER 1.00 FAIL** — the #10726 IPA double-phonemization garble, independently reproducing PR #11238's diagnosis (same phrase, same transcript). |
| + PR #11238 raw-text fix + espeak-linked lib — `smoke-remote-espeak-pr11238-wer0.13.log` | Loads, 3.80 s audio, envelope-cv **1.250**, ASR: "Hello. This is a native Kakoro voice test." → **WER 0.13 PASS**. Lane exits 1 **only** on `TTFA 113529ms > 700ms` (mobile budget on a desktop-CPU build; #11238 saw 79.6 s on its host). |

**Verdict:** the #9588 blocker (missing tensor / noise) is closed by the
republish. Intelligibility requires PR #11238 (unmerged at capture time). The
only remaining smoke failure is the mobile TTFA budget applied to desktop CPU
— a perf-policy question, not an artifact defect.

## 4. Reference audit for the dead `-Q4_K_M` filename

- `.github/workflows/kokoro-real-smoke.yml` `KOKORO_GGUF_PATH` — **was the one
  hard break** (CI `curl -f` would 404). Fixed in this PR, plus the stale
  "expected RED until republished" header rewritten to the current state, plus
  `libespeak-ng-dev espeak-ng-data` added to the CI build deps so the lane
  links the real G2P path the artifact was verified with.
- `packages/shared/src/local-inference/catalog.ts:368` — already points at
  `tts/kokoro/kokoro-82m-v1_0.gguf`. No change needed.
- `packages/app-core/scripts/aosp/stage-default-models.mjs` — already uses the
  F16 name. No change needed.
- `kokoro-engine-discovery.ts` `CANDIDATE_MODEL_FILES` — keeps `-Q4_K_M` as a
  local-filename fallthrough (harmless; also covers previously-staged files).
  Left as-is.
- `voice-models.ts:506` (`missingAssets` in the 0.3.0 catalog record) and
  `.github/issue-evidence/10727-local-model-lifecycle-matrix.json` — historical
  ledger/evidence entries; intentionally not rewritten.
- Un-gating the workflow's push auto-trigger is deferred until #11238 merges
  and the TTFA budget is per-platform (see the workflow header note).

## Files

- `SHA256SUMS` — published + regenerated GGUF (identical) and `af_bella.bin`.
- `tensor-check-remote.log` — gguf-py tensor proof on the downloaded bytes.
- `smoke-develop-doubleg2p-wer1.00.log` — develop-as-is smoke (garble repro).
- `smoke-remote-espeak-pr11238-wer0.13.log` — smoke with #11238 + espeak.

The GGUFs themselves are NOT committed (162 MB each). Local copies at capture
time: `/home/shaw/eliza-worktrees/kokoro-src/kokoro-82m-v1_0.remote.gguf`
(published bytes) and `/home/shaw/eliza-worktrees/kokoro-src/kokoro-82m-v1_0.gguf`
(regenerated).
