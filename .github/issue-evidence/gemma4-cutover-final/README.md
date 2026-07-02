# Gemma-4 cutover — final HF `elizaos/eliza-1` arch matrix + hub repair (2026-07-02)

Non-training finalization pass. Everything below was verified live against the
HF hub (`HfApi.get_paths_info` LFS object metadata + downloaded bytes) and
against the **current-source** downloader validator
(`plugins/plugin-local-inference/src/services/manifest/` `validateManifest` /
`parseManifestOrThrow` — the exact function `downloader.ts:258` calls at
install time).

## 1. Text-weight arch matrix (final)

| HF path | size | sha256 (12) | arch | status |
|---|---|---|---|---|
| `bundles/2b/text/eliza-1-2b-128k.gguf` | 4,967,494,592 | `e049411c01fb` | **gemma4** | **SHIPPING** — sole `files.text` entry in the 2b manifest; catalog `eliza-1-2b` textFile |
| `bundles/2b/text/eliza-1-2b-256k.gguf` | 1,270,808,512 | `a511452ec932` | qwen35 (pre-republish bytes; size matches the qwen35 1211 MB 2b documented in `faee4148d9d`) | KEPT — legacy, referenced (see §2) |
| `bundles/2b/text/eliza-1-2b-32k.gguf` | 1,270,808,512 | `a511452ec932` (byte-identical to 2b-256k) | qwen35 | KEPT — legacy, referenced (see §2) |
| `bundles/4b/text/eliza-1-4b-128k.gguf` | 8,031,240,160 | `fb8f0c032de0` | **gemma4** | **SHIPPING** — sole `files.text` entry in the 4b manifest; catalog `eliza-1-4b` textFile |
| `bundles/4b/text/eliza-1-4b-256k.gguf` | 2,952,939,488 | `798092229ce8` | qwen35 | KEPT — legacy, referenced (see §2) |
| `bundles/4b/text/eliza-1-4b-64k.gguf` | 2,871,743,520 | `68c9c6bfeece` | qwen35 | KEPT — legacy, referenced (see §2) |
| 9b / 27b / 27b-256k text | — | — | qwen35 (no `bundles/9b|27b*` trees on HF at all) | catalog-gated `pending` — Gemma fine-tunes are training-gated, out of scope |
| `candidates/gemma-2b-base-v1/text/eliza-1-2b-128k.gguf` | — | — | gemma4 candidate | KEPT — candidate staging tree |

Vision pairing (verified via LFS metadata): `bundles/2b/vision/mmproj-2b.gguf`
`8a82e0fd831b` and `bundles/4b/vision/mmproj-4b.gguf` `51d4b7fd825e` are the
manifest-pinned gemma4v projectors.

## 2. Orphan check for the qwen35 variants — verdict: NOT orphans, NOT deleted

Deletion required "referenced by NO code path", doubly confirmed. The grep
sweep found live references, so **no HF files were deleted**:

- `packages/training/cloud/ollama/Modelfile.eliza-1-2b-q4_k_m:20` —
  `FROM hf.co/elizaos/eliza-1:bundles/2b/text/eliza-1-2b-32k.gguf` pulls the
  32k file **directly from the hub** (and `packages/core/src/testing/inference-provider.ts:260`
  tells operators to `ollama create` from that Modelfile).
- `plugins/plugin-local-inference/native/verify/eagle3_drafter_runtime_smoke.mjs:33`
  — `eliza-1-2b-256k.gguf` is a `DEFAULT_TARGET` fallback candidate.
- dflash provenance chain on the hub binds to the qwen35 bytes:
  `bundles/2b/dflash/target-meta.json` `targetCheckpointSha256 = a511452e…`
  (= 2b-256k/32k) and `bundles/4b/dflash/target-meta.json`
  `targetCheckpointSha256 = 68c9c6bf…` (= 4b-64k).
- `packages/training/scripts/manifest/audit_hf_eliza1_release.py` expects
  `expectedContexts == ["128k", "256k"]` and a `text_artifact_name(tier, "256k")`
  dflash target per tier (asserted by its tests).
- Docs/examples: `packages/examples/autonomous/` (`LOCAL_SMALL_MODEL=eliza-1-2b-32k.gguf`),
  `packages/docs/guides/local-models.md`.

Stale doc strings that mention `eliza-1-2b-32k.gguf` as the *embedding default*
(`packages/agent/src/config/schema.ts:742`, `packages/app-core/src/benchmark/server.ts:2054`)
are **not** live download paths — the real embedding preset is
`gte-small_fp16.gguf` from `ChristianAzinn/gte-small-gguf`
(`plugins/plugin-local-inference/src/runtime/embedding-presets.ts`).

## 3. Manifest verification + repair (the actual blocker found)

Before this pass, **the current-source downloader could not install either
shipping bundle**: `parseManifestOrThrow` (downloader.ts:258) rejected both
live manifests.

| Defect (live HF manifest, before) | Effect | Fix (uploaded) |
|---|---|---|
| `files.vision` was an **object**, schema requires an array | schema parse failure → every 2b/4b install throws `Invalid Eliza-1 manifest` | `files.vision` → 1-element array (same path + sha) |
| 4b `files.mtp[0]` = `text/eliza-1-4b-128k.gguf` with the **qwen35 4b-256k sha `79809222…`** while `files.text` pins the gemma4 sha `fb8f0c03…` for the same path | `collectBundleFiles` throws `Conflicting sha256 entries`; the stale qwen35 sha would also defeat the `faee4148d9d` stale-partial detection | dropped (see below) |
| 2b `files.mtp[0]` = `dflash/drafter-2b.gguf` — a drafter distilled against the **Qwen3.5-2B checkpoint `a511452e…`**, not the shipped gemma4 text; validator requires `mtp/drafter-<tier>.gguf` | validator error; drafter unusable against gemma4 target | dropped `files.mtp` + `lineage.drafter` on both tiers — matches the code gate `ELIZA_1_HOSTED_MTP_TIER_IDS = []` (catalog.ts: dflash files are documented legacy; MTP is off until real Gemma drafters are published, training-gated) |
| 5 manifest-pinned files were **missing from the bundle trees** (404 at download): `tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf` (both tiers), `vad/silero-vad-int8.onnx` (both tiers), 4b `tts/kokoro/model_q4.onnx` | bundle install fails mid-download | restored **byte-exact to the already-pinned shas**: kokoro Q4_K_M `cb5440c3…` from the local 0_8b bundle copy; silero int8 `90b026c9…` from upstream `onnx-community/silero-vad` `onnx/model_int8.onnx` (sha match confirmed before upload); `model_q4.onnx` `04cf570c…` server-side `CommitOperationCopy` from `bundles/2b` |

`files.text` was already correct on both tiers (gemma4 128k only) and was not
touched: 2b `text/eliza-1-2b-128k.gguf` `e049411c…`, 4b
`text/eliza-1-4b-128k.gguf` `fb8f0c03…` — both byte-verified against the hub
LFS objects.

## 4. `checksums/SHA256SUMS` regeneration

The old SUMS predated the gemma4 re-publish and were globally stale — worst
offenders (each of these is exactly the "stale sha defeats the re-publish
detection" failure mode):

- `text/eliza-1-2b-128k.gguf` listed the **qwen35** sha `a511452e…` (actual gemma4 `e049411c…`)
- `text/eliza-1-4b-128k.gguf` **and** `-256k` both listed the 4b-64k qwen35 sha `68c9c6bf…` (actual `fb8f0c03…` / `79809222…`)
- `vision/mmproj-{2b,4b}.gguf`, the `eliza-1.manifest.json` self-hash, and most
  evidence/eval JSON lines no longer matched hosted bytes; several lines pointed
  at files no longer hosted.

Both files were regenerated from the live tree (one line per hosted file under
`bundles/<tier>/`, LFS-metadata sha for LFS files, downloaded-byte sha
otherwise): 86 lines (2b), 94 lines (4b).

## 5. HF commits (repo `elizaos/eliza-1`)

1. `1a7c0c7b8b4ffdc70f938c4b993b909f23b1b652` — restore 5 manifest-referenced files (byte-exact to pinned shas)
2. `c6d9d5cb16d27ae35bfdafa46a79dd31216a81b2` — regenerated `bundles/{2b,4b}/eliza-1.manifest.json`
3. `27ca133883b6893d712c8ad88146f59a7b9773c5` — regenerated `bundles/{2b,4b}/checksums/SHA256SUMS`

## 6. Post-repair verification (live, current source)

- `validateManifest` (plugin-local-inference @ this tree): **both live manifests OK** (previously: schema rejection).
- Every `files.*` entry (21 on 2b, 24 on 4b) exists on the hub and its LFS/byte
  sha256 **matches the manifest exactly** (0 missing, 0 mismatches).
- New manifest self-hashes match the SUMS lines
  (2b `17cd4872…`, 4b `c6074245…`).

## 7. Honest residuals (all training/model-production, tracked in #9033)

- 9b / 27b / 27b-256k tiers stay catalog-gated `pending` — need Gemma-4 fine-tunes.
- MTP: no Gemma drafters hosted (`mtp/drafter-<tier>.gguf` absent; candidates tree ships `mtp/MISSING.txt`); `files.mtp` and the catalog gate stay empty until they exist.
- ASR gguf on the hub is the frozen qwen3vl-lineage artifact; Gemma ASR is training-gated.
- Kokoro TTS audio-quality defect (native decoder/vocoder path) is unchanged by this pass — the restored Q4_K_M bytes are the exact bytes the manifest already pinned (tracked in the kokoro epic / #10727).
