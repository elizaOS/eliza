# Eliza-1 HF Release Readiness Audit - 2026-05-12

Scope: final Eliza-1 HF weights, checksums, licenses, evals, and upload evidence that can be verified locally in `/Users/shawwalters/eliza-workspace/milady/eliza`.

## Local bundle inventory

No final staged release bundle was found under the expected local release roots:

- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-0_6b.bundle`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-1_7b.bundle`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-27b.bundle`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-27b-256k.bundle`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-27b-1m.bundle`

Because those roots are absent, every required bundle-relative path in `ELIZA_1_GGUF_READINESS.md` is missing locally under the matching root. Examples of the exact missing payload paths for the 9B tier are:

- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/text/eliza-1-9b-64k.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/text/eliza-1-9b-128k.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/tts/omnivoice-base-Q8_0.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/tts/omnivoice-tokenizer-Q8_0.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/asr/eliza-1-asr.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/asr/eliza-1-asr-mmproj.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/vad/silero-vad-v5.1.2.ggml.bin`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/vision/mmproj-9b.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/dflash/drafter-9b.gguf`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/dflash/target-meta.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/cache/voice-preset-default.bin`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/aggregate.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/metal_verify.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/vulkan_verify.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/cuda_verify.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/rocm_verify.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/cpu_reference.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/metal_dispatch.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/vulkan_dispatch.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/cuda_dispatch.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/rocm_dispatch.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evals/cpu_dispatch.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/licenses/LICENSE.text`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/licenses/LICENSE.voice`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/licenses/LICENSE.asr`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/licenses/LICENSE.vad`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/licenses/LICENSE.dflash`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/licenses/LICENSE.eliza-1`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/licenses/LICENSE.vision`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/checksums/SHA256SUMS`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/evidence/release.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/quantization/turboquant.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/quantization/fused_turboquant.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/quantization/qjl_config.json`
- `/Users/shawwalters/eliza-workspace/milady/eliza/eliza-1-9b.bundle/quantization/polarquant_config.json`

The same root-plus-relative-path rule applies to every other tier section in `ELIZA_1_GGUF_READINESS.md`. No local hash or upload claim was made for any absent payload.

## Placeholder repo drafts

The only local HF-oriented directories found are under `reports/porting/2026-05-10/eliza-1-repos/`. These are README/manifest placeholders, not final release bundles. Their manifests record `status: "placeholder"`, `gguf.sha256: null`, and `gguf.sizeBytes: 0`. They remain useful upload command scaffolds, but they are not evidence of uploaded weights or checksums.

## HF CLI/auth check

Local dry-run/listing of target `elizaos/*` repos was not possible in this environment:

- `hf`: not found on `PATH`
- `huggingface-cli`: not found on `PATH`
- `huggingface_hub`: not importable in system Python
- `HF_TOKEN` / `HUGGINGFACE_HUB_TOKEN`: not present in the environment
- `uv`: not found on `PATH`, so the documented `uv run --extra train ...` path could not be used here

## Validation changes made locally

- `packages/training/scripts/publish/orchestrator.py` now rejects checksum manifests that reference missing files or mismatched bytes, not just missing required upload paths.
- `packages/training/scripts/publish/orchestrator.py` now requires `evidence/release.json.evalReports` to enumerate every shipped file in `evals/`.
- `packages/training/scripts/publish/orchestrator.py` now requires `hf.uploadEvidence.uploadedPaths` to cover the actual payload commit paths: `eliza-1.manifest.json`, `README.md`, weights, licenses, evals, evidence, and checksums.
- `packages/training/scripts/manifest/finalize_eliza1_evidence.py` now computes `final.hashes` from parseable checksum entries that reference real files and match the local bytes.

## Verification attempted

- `python3 -m py_compile packages/training/scripts/publish/orchestrator.py packages/training/scripts/manifest/finalize_eliza1_evidence.py`: passed.
- Focused pytest under system `python3`: blocked because system Python is 3.9, `yaml` is not installed, and the manifest modules require Python dataclass `slots`.
- Focused pytest under the documented `uv run --extra train ...`: blocked because `uv` is not installed in this environment.
