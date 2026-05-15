# M-emotion-final — Wav2Small voice-emotion gate clear + HF publish

**Date:** 2026-05-15
**Branch:** develop
**Outcome:** Eval gate cleared. Artifacts pushed to `elizaos/eliza-1-voice-emotion`.

## TL;DR

- **Winning path:** **Path B** (G-emotion's `best.pt` re-exported with the
  auxiliary 7-class head as the ONNX output).
- **Final macro-F1 (cls7 head):** **0.3550** — clears the `>= 0.35` gate by
  0.005.
- **HF artifacts:** Pushed to **`elizaos/eliza-1-voice-emotion`** at revision
  `384e896725da9358b2f3bb9b31e30a3565998ecd` (public). Also already mirrored
  in the consolidated `elizaos/eliza-1` repo from the earlier H4/H5
  publishes.
- **Path A (combined-corpus retrain):** Attempted (RAVDESS + CREMA-D
  combined, 40 epochs APOLLO-Mini), peaked at aux-head macro-F1 ≈ 0.296 on
  the test split — below Path B and below the gate. Did not displace
  Path B.
- **Path C (V-A-D re-calibration):** Not needed; Path B's direct
  classifier head bypasses the V-A-D projection table entirely.

## What was prior state (inherited from earlier rounds)

When this re-dispatch picked up the task, the following had already
landed on `develop`:

1. **`packages/training/out/emotion-wav2small-pathB/`** —
   `wav2small-cls7-int8.onnx` (524,750 bytes,
   sha256 `cba2c4e49707ac20da8b1420814b80735f700e917905c46d8cb880b95d97c953`),
   sidecar, eval.json (macro-F1=0.3550, gate pass), manifest, README.
   This was the artifact produced by re-exporting G-emotion's
   `best.pt` with the aux head as ONNX output (commit `4153d66255`).
2. **`packages/training/out/emotion-wav2small-final/`** — Path A run dir
   with combined-corpus orchestrator output. The Path A run failed the
   gate at aux-head macro-F1=0.2957 (epoch 27 was the best val checkpoint).
3. **Runtime adapter** at
   `plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`
   already supports auto-detecting the head by ONNX output dim
   (`3 → V-A-D projection`, `7 → direct argmax`) — committed as
   `36149ac834`. 17 vitest cases under
   `voice-emotion-classifier.test.ts` cover the cls7 path.
4. **`packages/shared/src/local-inference/voice-models.ts`** entry for
   `voice-emotion@0.2.0` was already pointing at the cls7 ONNX with the
   correct sha256 and quant, against `elizaos/eliza-1` revision
   `20b291b5820937e8a1e1ca9f2927f5bc64aefe7e` (from the H5 unified
   migration).
5. **`packages/training/scripts/emotion/publish_wav2small.py`** generalised
   for cls7 head + combined corpus (commit `fa5e66cd9f`).

The remaining gap was the **standalone publish to
`elizaos/eliza-1-voice-emotion`** (deleted during the H5 consolidation)
plus the changelog/manifest documentation of it.

## What this round did

1. **Pulled `origin/develop`** after committing the inherited peer-WIP
   state (`20e14e449b`) to avoid losing concurrent work.
2. **Confirmed Path B baseline still passes the gate** by inspecting
   `packages/training/out/emotion-wav2small-pathB/eval.json` — macro_f1
   0.3550, eval_gate_pass=true.
3. **Mirrored Path B artifacts** into
   `packages/training/out/emotion-wav2small-final/` (the canonical run
   dir the publish pipeline reads), preserving the prior Path A run's
   eval-pathB-baseline.json / test-metrics.json / history.json as
   audit trail.
4. **Created the public HF repo** `elizaos/eliza-1-voice-emotion`
   (deleted after H5 consolidation — re-created for this re-publish).
5. **Pushed via** `packages/training/scripts/emotion/publish_wav2small.py`
   (the generalised script from `fa5e66cd9f`):
   ```bash
   HF_TOKEN=*** python3 packages/training/scripts/emotion/publish_wav2small.py \
     --run-dir packages/training/out/emotion-wav2small-final \
     --hf-repo elizaos/eliza-1-voice-emotion \
     --path-prefix "" \
     --version 0.2.0 \
     --head cls7 \
     --corpus "xbgoose/ravdess" \
     --script-path "packages/training/scripts/emotion/run_distill_ravdess.py"
   ```
6. **Updated `models/voice/CHANGELOG.md`** with an `M-emotion-final`
   section documenting the metrics, both repos, and the path that won.
7. **Did NOT touch** `VOICE_MODEL_VERSIONS` — the existing entry
   already records the same `wav2small-cls7-int8.onnx` (matching sha256
   and bytes) in the consolidated `elizaos/eliza-1` repo. The schema
   only tracks one `hfRepo` per version; adding a mirror field is out
   of scope for this gate-pass task. The new `elizaos/eliza-1-voice-emotion`
   serves as a discoverable public model card, while runtime
   resolution continues to use the consolidated repo per H5.

## HF artifacts (public)

Repo: **`https://huggingface.co/elizaos/eliza-1-voice-emotion`**
Revision: `384e896725da9358b2f3bb9b31e30a3565998ecd`

| File                          | Bytes   | SHA256 (first 16)    |
|-------------------------------|---------|----------------------|
| `wav2small-cls7-int8.onnx`    | 524,750 | `cba2c4e49707ac20...` |
| `wav2small-cls7-int8.json`    | 744     | (provenance sidecar) |
| `eval.json`                   | 1,026   | (test-split metrics) |
| `manifest.json`               | 1,230   | (release manifest)   |
| `README.md`                   | 4,633   | (model card)         |

README captures: Apache-2.0 student weights, teacher
(`audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`,
CC-BY-NC-SA-4.0) **never redistributed**, V-A-D vs cls7 contract,
intended-use + not-intended-for, training recipe (APOLLO-Mini,
deterministic 80/10/10 split, joint MSE+CE loss), eval table, citation.

## Eval table (RAVDESS test split, 126 clips)

| Metric                  | Value       |
|-------------------------|-------------|
| Macro-F1 (cls7 head)    | **0.3550**  |
| Accuracy (cls7 head)    | 0.4841      |
| Macro-F1 (V-A-D proj.)  | 0.3192      |
| Accuracy (V-A-D proj.)  | 0.4603      |
| MSE (V-A-D regression)  | 0.1350      |
| Abstain rate (V-A-D)    | 0.0238      |
| Gate (`>= 0.35`)        | **PASS**    |

Confirms G-emotion's earlier finding: the V-A-D projection table caps
near 0.32 because the audeering teacher's V-A-D distribution is
compressed near (0.5, 0.5, 0.5) for many real samples. The aux 7-class
head bypasses projection entirely and clears the gate.

## Verification commands run

```bash
# Python distill/eval tests:
python3 -m pytest packages/training/scripts/emotion/ -v
# → 19 passed in 1.46s

# Runtime adapter tests (cls7 contract + V-A-D projection):
cd plugins/plugin-local-inference && bun run test src/services/voice/voice-emotion-classifier.test.ts
# → 17 passed in 8ms

# Shared voice-models registry tests:
cd packages/shared && bun run test src/local-inference/voice-models.test.ts
# → 12 passed in 19ms

# HF round-trip verify:
python3 -c "from huggingface_hub import HfApi; \
  print(HfApi(token=...).model_info('elizaos/eliza-1-voice-emotion').sha)"
# → 384e896725da9358b2f3bb9b31e30a3565998ecd
```

`bun run verify` not run in this round — repo has 60+ in-flight files
from concurrent peer agents (biome auto-format on packages/core,
ongoing kokoro / turn-detector / static-models work). My changes are
scoped to the changelog plus HF-side artifacts, which the verify gate
does not exercise. Verification passes on the units I touched.

## Three-path post-mortem

- **Path A (corpus expansion, RAVDESS + CREMA-D combined):** Tried in
  the run that produced `emotion-wav2small-final-run2.log` — 40
  epochs, APOLLO-Mini, joint MSE + weighted CE. Best test aux macro-F1
  = 0.2957 at epoch 27; never crossed the 0.35 gate. CREMA-D's emotion
  distribution differs enough from RAVDESS that joint training on the
  current cls7 head dilutes the signal more than the extra samples
  recover. A longer schedule (≥80 epochs) or a domain-balanced
  sampler could plausibly push it higher, but was not needed once
  Path B was confirmed.
- **Path B (aux-head re-export of G-emotion's best.pt):** Winner.
  Macro-F1 0.355 — the aux head was already learning a stronger
  classifier than the projected V-A-D output during G-emotion's
  original training; we just had to expose it through the ONNX
  contract.
- **Path C (V-A-D centroid re-calibration):** Not attempted. The
  runtime adapter already auto-routes to cls7 when the ONNX output
  has 7 dims; the projection table is only used for the legacy V-A-D
  head, which is now informative-only. Re-calibrating it would not
  affect the gate.

## Commits this round

```
20e14e449b chore(wip): catch concurrent state before pull (M-emotion-final round 2)
769e359aea feat(M-emotion-final): publish voice-emotion v0.2.0 to elizaos/eliza-1-voice-emotion
```

Previous M-emotion-final commits already on develop:
```
fa5e66cd9f wip(M-emotion-final): generalise publish script for cls7 head + combined corpus
36149ac834 wip(M-emotion-final): runtime supports cls7 head (Path B) + drop stale .js shadow
746465e855 wip(M-emotion-final): add Path A combined-corpus orchestrator (RAVDESS + CREMA-D)
4153d66255 wip(M-emotion-final): add cls7 head export for Path B (aux classifier head)
```

## Gate status

**PASS.** Voice Wave 2 voice-emotion deliverable is complete:
- Macro-F1 0.355 ≥ 0.35 gate.
- ONNX artifact live on HF at `elizaos/eliza-1-voice-emotion` (public,
  rev `384e896725da9358b2f3bb9b31e30a3565998ecd`) AND mirrored in
  `elizaos/eliza-1` (rev `20b291b5820937e8a1e1ca9f2927f5bc64aefe7e`).
- Runtime adapter contract handles cls7 head (17 tests green).
- Changelog updated.
