# Eliza-1 eval suite — first runnable harness + live run (2026-05-11)

Harness: `packages/training/scripts/eval/eliza1_eval_suite.py`. Gate engine:
`packages/training/benchmarks/eliza1_gates.py` (now consumes the v2
`eliza1_gates.yaml`). Publish gate: `packages/training/scripts/publish/orchestrator.py`
stages 3 (eval gates) + 4 (manifest assembly) — already reads
`<bundle>/evals/aggregate.json`, refuses to publish unless `GateReport.passed`
and sets `defaultEligible` only when every required gate passes and every
supported backend is verified.

## What was run on this host (24-core x86, Intel Arc/Xe iGPU, 30 GB RAM)

The suite was run against **stand-in bundles** (15-byte placeholder GGUFs — no
real Eliza-1 0_6b / 1_7b weights are on this machine yet; the sibling E4 agent
is producing them). The text eval used a real off-bundle Qwen3 GGUF as a stand-in
text model (`--text-eval-model`) so at least one gate produced a real number.

| Gate | 0_6b | 1_7b | Status |
| --- | --- | --- | --- |
| text_eval (perplexity → 0..1 score) | **0.3206** (ppl 44.4, Qwen3-0.6B base Q8) | **0.3392** (ppl 36.7, Qwen3-1.7B base Q8) | measured (stand-in text model, not the Eliza-1 fine-tune → below the 0.55 / 0.60 gate, as expected) |
| dispatch (per-backend kernel) | **pass** | **pass** | measured — `make -C packages/inference/verify kernel-contract reference-test` green (turbo3/turbo4/turbo3_tcq/qjl/polar fixture self-test all finite, kernel-contract OK) |
| voice_rtf (TTS RTF) | not-run | not-run | bundle TTS artifacts are stand-ins; `llama-omnivoice-server` present but the linux fused build fails ABI verification (`OMNIVOICE_FUSE_VERIFY.json` ok == false — missing `eliza_inference_asr_stream_*` symbols) |
| asr_wer | not-run | not-run | ASR artifact is a stand-in; no ASR runtime + labelled speech corpus |
| vad_latency_ms | not-run | not-run | VAD onnx is a stand-in; onnxruntime is available but no labelled speech-segment corpus (coordinate with `packages/app-core/scripts/voice-vad-smoke.ts`) |
| e2e_loop_ok / thirty_turn_ok | not-run | not-run | needs real text+TTS+ASR weights + an ABI-verified fused build |
| dflash_acceptance | not-run | not-run | bundle drafter is a stand-in; `llama-speculative-simple` exists but the real `qwen3.5-4b-dflash-drafter` GGUF has `architecture: dflash-draft` which the shipped CPU build doesn't load (`unknown model architecture: 'dflash-draft'`) |
| expressive_* | not-run | not-run | needs an ABI-verified fused build + the expressive graders |
| peak_rss_mb / thermal_throttle_pct | needs-hardware | needs-hardware | mobile-only — recorded as `null` (skipped by the gate engine, not faked); CI runs these on real iOS/Android devices |

`defaultEligible` stays **false** for both tiers (gate verdict `passed: false` —
every required voice/ASR/VAD/loop gate has no measurement, and `text_eval` is
below the gate because it was measured on a base model, not the Eliza-1 fine-tune).

## Re-running against E4's real bundles

Once the real `eliza-1-0_6b.bundle` / `eliza-1-1_7b.bundle` land under
`~/.eliza/local-inference/models/` (or `~/.milady/...`):

```bash
cd packages/training
uv run --extra train python scripts/eval/eliza1_eval_suite.py \
  --bundle-dir ~/.eliza/local-inference/models/eliza-1-0_6b.bundle --tier 0_6b
```

The text eval will then run against the bundle's own quantized text GGUF (no
`--text-eval-model` override needed); voice/ASR/VAD/loop/dflash become runnable
once the fused build is rebuilt against `packages/app-core/scripts/omnivoice-fuse/ffi.h`
so its ABI verification passes. Mobile RSS/thermal stay CI-on-device only.

## Files in this directory

`0_6b-*.json` / `1_7b-*.json` are the per-eval JSON blobs + `aggregate.json`
the suite wrote into each stand-in bundle's `evals/` dir, copied here verbatim
as the run record.
