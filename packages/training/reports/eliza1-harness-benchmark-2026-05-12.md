# Eliza-1 harness benchmark — comprehensive model + kernel comparison (2026-05-12)

One master comparison run across every Eliza-1 model + kernel artifact present on
this box. Source data: the test-SFT pipeline benchmarks
(`packages/training/benchmarks/eliza-1-0_6b-apollo-1778551769/`,
`checkpoints/.../{gate_report,evals/aggregate}.json`), the staged eliza1 bundles'
`evals/aggregate.json` (re-run 2026-05-12 02:21Z / 02:29Z by `eliza1_eval_suite.py`),
fresh CPU `llama-bench` d0 runs (2026-05-12, this report), and the inference-team
bench results (`packages/inference/verify/bench_results/*`, `verify/*-evidence.json`).

**Host:** Intel Core Ultra 9 275HX (24 cores, AVX2+AVX-VNNI, no AVX-512), RTX 5080
Laptop (16 GB, sm_120), 30 GB RAM. The RTX 5080 is held by an in-flight full-corpus
SFT (~12 GB) — **all benches here are CPU-only or re-used**; no GPU job was run that
would risk OOMing the SFT. CPU `llama-bench` figures are **lower bounds** (the SFT's
data-loader uses CPU too); the idle-host `-t16` 0_6b reference is pp512 227 / tg128 24.

---

## Master table

Rows = the six model/kernel artifacts. `—` = not applicable; `n/r` = not run (reason
below). All "format_ok / parse-errors / eliza_bench / claude_distill" columns are from
HF-transformers CPU runs on `data/final/test.jsonl` (35-row smoke buckets); "text-eval
score" is the GGUF-perplexity → 0..1 gate metric; tok/s is CPU `llama-bench -t12 -p512
-n128` (and the Vulkan/RTX5080 column where available).

| model / kernel | text format_ok | reply parse-errs | claude_distill format% | eliza_bench tps_gen | native_tool_call | action-sel acc | personality PASS% | text-eval score (ppl→0..1) | gen tps CPU d0 (pp512 / tg128) | gen tps RTX5080 CUDA d0 (pp512 / tg128) | gen tps RTX5080-Vulkan d0 (pp512 / tg128) | gen tps RTX5080 CUDA d16000 (pp512 / tg128) | voice RTF (CPU) | ASR WER | dflash accept% | guided-decode forced-token % | kernel-verify |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **base Qwen3-0.6B-Q8_0** (no SFT, stand-in base) | 0.0857 | 8 | 27.3% | 68.5 | n=0¹ | n/r² | n/r² | — | n/r³ | **20979 / 356.3**¹⁰ | n/r | **1968 / 107.0**¹⁰ | — | — | — | — | n/a |
| **test-SFT 0_6b** (`apollo-1778551769`, 8k slice, 1ep, Q4_K_M) | **0.20** | **0** | **63.6%** | **90.9** | n=0¹ | n/r² | n/r² | — | **500 / 75.6** | n/r¹¹ | n/r | n/r¹¹ | — | — | — | — | n/a (no sidecars) |
| **eliza1-bundle 0_6b** (Qwen3-0.6B Q3_K_M re-host + PolarQuant/QJL/TurboQuant sidecars; GPU GGUF body **Q8_0**, q4_polar deferred) | n/r⁴ | n/r⁴ | n/r⁴ | n/r⁴ | n/r⁴ | n/r² | n/r² | **0.2779** (ppl 71.4) | 331 / 77.7 (Q3KM); 432 / 61.1 (Q8 body) | **19932 / 345.5**¹⁰ (Q3KM, ngl 99) | **3421 / 194** | **1956 / 108.5**¹⁰ | 8.62⁶ | 1.0⁷ | **0.87**⁸ | 28% (static) | **CPU pass / CUDA verified-here⁹ / Vulkan pass / Metal needs-hw** |
| **1_7b base Q8_0** (Qwen3-1.7B, SFT in progress @ seq2048 — no fine-tune artifact) | — | — | — | — | — | — | — | — | — | **12414 / 158.7**¹⁰ | — | **1790 / 80.0**¹⁰ | — | — | — | — | — |
| **eliza1-bundle 1_7b** (Qwen3-1.7B Q4_K_M re-host + sidecars; GGUF body Q4_K_M) | n/r⁴ | n/r⁴ | n/r⁴ | n/r⁴ | n/r⁴ | n/r² | n/r² | **0.328** | 219 / 39.6 | **11931 / 194.7**¹⁰ (Q4KM, ngl 99) | **1317 / 112** | **1797 / 84.9**¹⁰ | 5.91⁶ | 1.0⁷ | 0.55⁸ | 28% (static) | same as 0_6b |
| **full-corpus SFT 0_6b** (`apollo-fullcorpus-1778563093`, 68,297 rows, 1ep) | **🔄 in flight** | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 | 🔄 (auto-chained at tail) |

¹ `data/final/test.jsonl` has no native-tool-call rows → the bench's `response` bucket is empty (n=0) for every model; not a failure, a corpus gap.
² action-selection accuracy and personality PASS% need a **live LLM provider + a judge model**; neither is wired in this headless context → not run (`ELIZA_RUN_ACTION_BENCHMARK=1` + a provider, and `personality-bench` `src/runner.ts` needs trajectory run dirs + a judge LLM).
³ base Qwen3-0.6B has no GGUF in the HF cache (safetensors only); the bundle GGUF (row below) IS the base re-hosted, so its tok/s stands in.
⁴ eliza_bench / native_tool_call / format_ok are HF-transformers checkpoint runs (only the test-SFT checkpoint has them, freshly); they were not re-run against the GGUF bundles — the bundle's **text-eval perplexity score** is the GGUF text-quality datapoint.
⁵ d16k CPU `llama-bench` (`-pg 16384,128`) took >15 min/model under SFT CPU contention before I aborted it; the CUDA `-DGGML_CUDA=ON` build OOM'd earlier. Re-run on an idle host or after the SFT finishes. e2e-loop decode tps (CPU, 1-turn): **17.4 (0_6b) / 12.0 (1_7b)**; first-token ms 209 / 87; 1_7b 30-turn decode 24.2 tps.
⁶ Voice RTF >> 1.0: the bundle's omnivoice **stand-in** TTS GGUF on CPU through `llama-server /v1/audio/speech`; the ≤0.5 gate is a GPU/Metal target. ASR RTF (content-independent, meaningful) ≈ **0.76 CPU on 0_6b**.
⁷ ASR WER = 1.0 everywhere: the stand-in ASR GGUF + the stand-in TTS that synthesizes the clips both have near-zero quality on this corpus — WER reflects stand-in quality, not eventual fused-ASR accuracy. Needs real WAV+.txt pairs **and** the tokenizer-fused Qwen3-ASR weights.
⁸ dflash acceptance is measured with the **stamp-only same-size** bundled "drafter" (essentially the target model) → an **upper bound** on acceptance / lower bound on the eventual real-drafter speedup. The 0_6b clears the 0.6 floor (0.87); the 1_7b (0.55) is **below** its 0.65 floor — the larger target makes each rejected round costlier.
⁹ CUDA verified-here = `make cuda-verify cuda-verify-fused` 8/8 + 1920/1920 fused on the RTX 5080 (Blackwell sm_120, driver 580.142, CUDA 12.8 nvcc V12.8.93 → **real `sm_120a` cubins**, no PTX JIT). `cuda-verify` max diff 7.6e-6; `cuda-verify-fused` max diff 4.47e-7 (1920/1920 across 4 n_heads/n_kv cases). Re-verified 2026-05-12 against the just-installed `linux-x64-cuda` build (forkCommit `a61c93aaa5`, fork v1.2.0-eliza, builtAt `2026-05-12T17:16:58Z`) — `libggml-cuda.so.0.9.7` 473 MB, `llama-bench` + `llama-server` ldd-clean via `$ORIGIN` rpath. **`llama-server` smoke verified**: 4 GPU slots loaded, `/health → ok`, `POST /completion` returns 32 tokens at 420.6 tps decode / 1092.7 tps prefill on the 0_6b bundle.

¹⁰ CUDA `llama-bench` on the **non-fused linux-x64-cuda** install (`-ngl 99`, default thread count). d0 = no prefill prior context; d16000 = `-d 16000` (16k-token prefill context, then pp512/tg128 to measure long-context regression). Numbers from this re-run on the freed-up RTX 5080 (no SFT contention) on 2026-05-12 ~13:50 PDT, build_id `a61c93a (1)`.

¹¹ test-SFT 0_6b GGUF (`final-Q4_K_M.gguf`) is at `checkpoints/eliza-1-0_6b-apollo-1778551769/milady-optimized-gpu/final-Q4_K_M.gguf` — same Qwen3-0.6B arch as the bundle row above; CUDA tg/pp would be within noise of the Q4 bundle numbers. CUDA on this GGUF was not re-run (no new info vs the bundle Q4 row).

Memory: eliza1-bundle 0_6b peak RSS **957 MB** (phone-class) vs 1_7b **2334 MB**.
Embedding (Matryoshka, dim 1024): single-text 14.4 ms on Metal/M4Max; dim-128 keeps
Pearson 0.96 vs full at 1/8 the bytes. (Linux/CPU embedding bench was skipped.)

---

## Who wins on what

- **Text quality (fine-tune effect):** test-SFT 0_6b is the only model trained on real
  data — `format_ok` 0.0857 → **0.20** (2.3×), `claude_distill` format 27.3% → **63.6%**,
  `reply`-bucket parse-errors 8 → **0**, `message_handler` content 100%, eliza_bench
  gen-tps 68 → 91. Regressed nothing. The full-corpus run (in flight) is the real number.
- **CPU decode (tg128):** eliza1-bundle 0_6b Q3_K_M (**77.7 t/s**) ≈ test-SFT Q4_K_M
  (75.6) > q4_polar/Q8-body (61.1) > 1_7b (39.6).
- **CPU prefill (pp512):** test-SFT Q4_K_M (**500 t/s**) > q4_polar/Q8-body (432) >
  bundle Q3_K_M (331) > 1_7b (219). The Q8_0 body's better prefill / worse decode vs
  Q4_K_M is the expected bpw tradeoff (the eliza1-bundle-gpu GGUF ships Q8_0 because
  the fork's converter can't emit q4_polar yet — sidecars carry the PolarQuant config).
- **GPU (RTX 5080 Vulkan):** eliza1-bundle 0_6b pp512 **3421** / tg128 **194** —
  10–40× CPU; 1_7b 1317 / 112. (CUDA llama-bench numbers still owed — build OOM'd.)
- **Speculative decode:** 0_6b dflash accept **0.87** (clears 0.6); 1_7b **0.55** (misses
  0.65). Both upper bounds (stamp-only drafter).
- **Perplexity gate:** 1_7b (0.328) > 0_6b (0.2779) — bigger stand-in base. Neither
  clears the gate (0.55 / 0.6) — expected, stand-in weights.
- **Memory:** 0_6b (957 MB peak RSS) is the only tier that fits a phone budget.

## Gates: pass / fail

- **test-SFT 0_6b:** `format_ok_floor` (≥0.5) **FAIL** (0.20); `format_ok_not_regressed`
  **PASS** (0.20 ≥ 0.0857) → **conditional-go** — the absolute floor is calibrated for a
  full-corpus run, which is what's in flight.
- **eliza1-bundle 0_6b:** `text_eval`≥0.55 **FAIL** (0.2779, stand-in); `voice_rtf`≤0.5
  **FAIL** (8.62, stand-in TTS on CPU); `asr_wer`≤0.1 **FAIL** (1.0, stand-in ASR);
  `dflash_acceptance`≥0.6 **PASS** (0.87); `e2e_loop` **PASS**; `30_turn` **PASS**;
  `dispatch` **PASS** → overall **FAIL** (stand-in weights — expected; the structural /
  kernel gates pass).
- **eliza1-bundle 1_7b:** `text_eval`≥0.6 **FAIL** (0.328); `voice_rtf`≤0.45 **FAIL**
  (5.91); `asr_wer`≤0.08 **FAIL** (1.0); `dflash_acceptance`≥0.65 **FAIL** (0.55) →
  overall **FAIL**.
- **Kernel verify:** CPU dispatch **PASS** (kernel-contract + reference-test;
  turbo3/turbo4/qjl/polarquant/dflash), CUDA **runtime-ready** (cuda-verify 8/8 RTX 5080),
  Vulkan dispatch **PASS** (incl. multiblock + fused), Metal **source-complete /
  needs-hardware**.
- **full-corpus SFT 0_6b:** **pending** — `run_pipeline.py --eval-mode full` auto-chains
  the gate bench + PolarQuant/QJL/TurboQuant quant + eliza1 sidecar bundle at the tail.

## Honest caveats

All Eliza-1 text/TTS/ASR weights are **documented stand-ins** (text = upstream
Qwen3-0.6B/1.7B GGUF re-hosted; the published Qwen3.5-x.xx checkpoints don't exist;
TTS = off-the-shelf omnivoice; ASR = ggml-org Qwen3-ASR-0.6B-GGUF, not tokenizer-fused).
The `elizaos/eliza-1-*` HF **model** repos are not created yet (PUBLISH agent #46).
PolarQuant Q4_POLAR is deferred in the GGUF body (Q8_0 fallback, sidecars present;
runtime kernels exist). The test-SFT is an 8k-slice / 1-epoch run. ASR WER 1.0 is the
stand-in chain, not the eventual fused ASR. Voice RTF >> 1 is CPU-only stand-in TTS.

## Still pending

- **full-corpus SFT 0_6b** — ~28 h remaining (ETA ~2026-05-13), then gate_report /
  Q4_K_M GGUF / eliza1 bundle auto-generated.
- **1_7b SFT** — re-running at seq 2048 (seq 4096 OOM'd on the CE step).
- **action-selection accuracy + personality PASS%** — need a live LLM provider + judge model.
- **d16k CPU/CUDA llama-bench sweep** — CPU 16k-prompt too slow under SFT contention; CUDA build OOM'd. Needs an idle host or post-SFT.
- **real ASR WER** — needs real recorded WAV+.txt pairs AND the tokenizer-fused Qwen3-ASR weights.
- **Linux/CPU embedding bench** — only the Metal/M4Max run exists.

Machine-readable: [`eliza1-harness-benchmark-2026-05-12.json`](./eliza1-harness-benchmark-2026-05-12.json).
Raw `llama-bench` JSON: `/tmp/eliza1-bench/*_d0.json` (also pushed to the HF dataset under `bench/`).
