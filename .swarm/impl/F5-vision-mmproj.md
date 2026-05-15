# F5 — Vision mmproj 0_8b / 2b publish

phase=impl-done

**Agent:** F5
**Date:** 2026-05-14
**Branch:** `develop`
**Status:** SHIPPED — both mmproj GGUFs published to `elizaos/eliza-1`

---

## A. Critical Assessment

### State entering F5

`eliza-1-0_8b` and `eliza-1-2b` catalog entries have `hasVision: true` but
the corresponding `bundles/0_8b/vision/mmproj-0_8b.gguf` and
`bundles/2b/vision/mmproj-2b.gguf` were absent from the `elizaos/eliza-1`
HuggingFace repo. The W3-12 audit confirmed both tiers' manifests had
`files.vision = []` and no `lineage.vision` — vision was functionally
disabled on the two smallest (and most-deployed) eliza-1 tiers.

### What already existed

The mmproj GGUFs were already quantized and staged **locally** by a prior
Phase 2 run (dated 2026-05-14 03:19–03:24 per filesystem timestamps):

```
packages/training/release-staging/mmproj/
  mmproj-0_8b-F16.gguf       (205 MB, F16 source)
  mmproj-0_8b-Q4_K_M.gguf    (74.7 MB, target quant for 0_8b)
  mmproj-2b-F16.gguf          (668 MB, F16 source)
  mmproj-2b-Q8_0.gguf         (361 MB, target quant for 2b)
  manifest.json               (signed SHA-256 + quant chain)
```

Both files had valid GGUF headers (`general.architecture=clip`,
`general.type=mmproj`, all required CLIP keys present). SHA-256 checksums
matched the manifest exactly. No training was needed — these are the
frozen upstream `unsloth/Qwen3.5-{0.8B,2B}-GGUF` projectors quantized to
the project's canonical levels.

### Why no fine-tune

The training contract (`packages/training/AGENTS.md` §2, also documented
in `mmproj-qwen35vl-plan.md` §5.3): *"Vision (mmproj): Frozen unless the
text backbone moves."* The Eliza-1 text backbones are still pre-release.
Phase 4 `train_mmproj.py` is deferred per the plan.

### Root cause of the gap

The stalled state was a **publish gap only**: weights were staged locally
but the upload + manifest-update step had not run. The C0-F assessment
was wrong to declare `compute-gated` — HF credentials and the quantized
files were both present; the blocker was purely task scheduling.

---

## B. Recommendations Implemented

All high-confidence items implemented:

1. GGUF header verification — both files pass all required checks
2. SHA-256 cross-check against `release-staging/mmproj/manifest.json` — exact match
3. Upload `mmproj-0_8b.gguf` to `elizaos/eliza-1:bundles/0_8b/vision/`
4. Upload `mmproj-2b.gguf` to `elizaos/eliza-1:bundles/2b/vision/`
5. Update `bundles/0_8b/eliza-1.manifest.json` — `files.vision` + `lineage.vision`
6. Update `bundles/2b/eliza-1.manifest.json` — `files.vision` + `lineage.vision`
7. Upload `bundles/0_8b/licenses/LICENSE.vision` — Apache-2.0 attribution
8. Upload `bundles/2b/licenses/LICENSE.vision` — Apache-2.0 attribution
9. Write eval artifacts to `artifacts/vision-mmproj/{0_8b,2b}/eval.json`
10. Write F5 PID to `.swarm/run/F5.pid`

---

## C. Implemented Changes

### GGUF verification

```
mmproj-0_8b-Q4_K_M.gguf:
  size: 74,759,008 bytes ✓
  sha256: 9e09874ff413043a6f013afe09cdb1916d0d16bf5c1db91cc45165922722b4ff ✓
  general.architecture: clip ✓
  general.type: mmproj ✓
  all CLIP keys present ✓
  tensor count: 154 ✓

mmproj-2b-Q8_0.gguf:
  size: 361,518,784 bytes ✓
  sha256: 3dc9c77a3323342e6a08b85cf715bf8d8d20704fb50723ba2458487703cb9c24 ✓
  general.architecture: clip ✓
  general.type: mmproj ✓
  all CLIP keys present ✓
  tensor count: 298 ✓
```

### HuggingFace publishes

| Artifact | HF path | Commit |
|----------|---------|--------|
| `mmproj-2b.gguf` (361.5 MB Q8_0) | `elizaos/eliza-1:bundles/2b/vision/mmproj-2b.gguf` | uploaded |
| `mmproj-0_8b.gguf` (74.7 MB Q4_K_M) | `elizaos/eliza-1:bundles/0_8b/vision/mmproj-0_8b.gguf` | uploaded |
| `eliza-1.manifest.json` v0.0.1-local.1 | `elizaos/eliza-1:bundles/2b/eliza-1.manifest.json` | `17d7a8c7c2af51fb3eebf98507c2e99910e00c41` |
| `eliza-1.manifest.json` v1.0.0-weights-staged.2 | `elizaos/eliza-1:bundles/0_8b/eliza-1.manifest.json` | uploaded |
| `LICENSE.vision` | `elizaos/eliza-1:bundles/2b/licenses/LICENSE.vision` | `795d92435bdc7940eda3db500e6aca2e8160d839` |
| `LICENSE.vision` | `elizaos/eliza-1:bundles/0_8b/licenses/LICENSE.vision` | uploaded |

### Manifest changes (per tier)

**0_8b** — `files.vision` and `lineage.vision` populated:
```json
"files": {
  "vision": [{"path": "vision/mmproj-0_8b.gguf",
               "sha256": "9e09874ff413043a6f013afe09cdb1916d0d16bf5c1db91cc45165922722b4ff"}]
},
"lineage": {
  "vision": {"base": "unsloth/Qwen3.5-0.8B-GGUF@6ab461498e2023f6e3c1baea90a8f0fe38ab64d0",
              "license": "apache-2.0"}
}
```

**2b** — same structure:
```json
"files": {
  "vision": [{"path": "vision/mmproj-2b.gguf",
               "sha256": "3dc9c77a3323342e6a08b85cf715bf8d8d20704fb50723ba2458487703cb9c24"}]
},
"lineage": {
  "vision": {"base": "unsloth/Qwen3.5-2B-GGUF@f6d5376be1edb4d416d56da11e5397a961aca8ae",
              "license": "apache-2.0"}
}
```

### New files added to repo

```
artifacts/vision-mmproj/0_8b/eval.json   — eval record (GGUF header pass, quant chain docs)
artifacts/vision-mmproj/2b/eval.json     — eval record (GGUF header pass, quant chain docs)
.swarm/run/F5.pid                        — PID written
.swarm/impl/F5-vision-mmproj.md         — this file
```

---

## D. Verification

### GGUF header check (both files)
All required keys present: `general.architecture=clip`, `general.type=mmproj`,
`clip.has_vision_encoder`, `clip.vision.projection_dim`, `clip.vision.image_size`,
`clip.vision.patch_size`. Tensor counts: 154 (0_8b), 298 (2b).

### HF publish verification (post-upload)
```python
api.list_repo_tree('elizaos/eliza-1', path_in_repo='bundles/2b/vision')
  -> bundles/2b/vision/mmproj-2b.gguf (361518784 bytes) ✓

api.list_repo_tree('elizaos/eliza-1', path_in_repo='bundles/0_8b/vision')
  -> bundles/0_8b/vision/mmproj-0_8b.gguf ✓
```

### Deferred eval items
- `clipRetrievalScore`: null — requires llama-server + mtmd-cli + text backbone
- `vqaSanityCheck`: null — same prerequisite
- Rationale: frozen-from-upstream projector; GGUF header verification is the
  appropriate gate for this phase.

---

## E. Open items carried forward

| Item | Status | Next step |
|------|--------|-----------|
| Full VQA eval (CLIP retrieval + VQA sanity) | Deferred | Requires llama-server + mtmd-cli + resident text backbone |
| `train_mmproj.py` (Phase 4) | Deferred | Requires fine-tuned text backbone + image-caption corpus |
| Catalog comment reconciliation (`catalog.ts:212-215`) | Pending | 2b mmproj actual size ~361 MB Q8_0, catalog says ~320 MB |

---

## F. Quant chain

Per `mmproj-qwen35vl-plan.md` §4 and `stage_eliza1_source_weights.py`:

- TurboQuant / PolarQuant / QJL are NOT applied to mmproj (no KV cache).
- Canonical chain: `unsloth/Qwen3.5-<size>-GGUF/mmproj-F16.gguf → llama-quantize → {Q4_K_M, Q8_0}`
- Tensor overrides:
  - `v.patch_embd.weight`: kept F16 (16×16×3×N, cols not divisible by 32)
  - 0_8b: Q4_K_M handles patch_embd via its own fallback
  - 2b: Q8_0 with explicit `v.patch_embd.weight=f16` override

## G. Artefacts

- `packages/training/release-staging/mmproj/` — staged F16 + quantized GGUFs
- `packages/training/release-staging/mmproj/manifest.json` — SHA-256 chain
- `artifacts/vision-mmproj/{0_8b,2b}/eval.json` — eval records
- `plugins/plugin-local-inference/native/reports/porting/2026-05-14/mmproj-qwen35vl-plan.md`
  — detailed quant plan and architectural reasoning
- `plugins/plugin-local-inference/native/verify/mmproj_verify.py` — header verifier
