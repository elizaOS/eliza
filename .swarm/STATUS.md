# H200-MONITOR-3 status — Task #65

## Last update
2026-05-12 14:32 PDT (21:32 UTC)

## v4 state
- Run: `eliza-1-0_8b-apollo-fullcorpus-h200-1778619044`
- VM: `eliza-train-h200-0_8b-v4` (Nebius project-e00kfz6cpr00q21z892vec)
- Driver PID 3652060 alive (~41m elapsed)
- Watcher PID 3652514 alive (~41m elapsed)
- Training progress: step 43/9615 at ~24 s/iter (healthy, past chat-template fix)
- Projected wall: ~65-67h. Watcher kills at 12h cap (2026-05-13T08:51Z).
- Expected at cap: ~1800 steps → checkpoints at 500/1000/1500.

## Plan
- Phase A (now): passive Monitor watching for driver/watcher death + sentinel + progress.
- Phase B/C: branch on outcome. With max 1500 steps (~16% of 1 epoch), gate likely will NOT clear `format_ok ≥ 0.70`. Most likely path is Case 2 (iterate) — need to write v5 plan if confirmed.

## Key files
- Driver log: /tmp/q35-0_8b-v4-launch.log
- Watcher log: /tmp/q35-0_8b-v4-watcher.log
- Watcher script: /tmp/nebius-finish-q35-0_8b-v4.sh
- Checkpoints will land: packages/training/checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/

## Auth
- `nebius iam whoami` confirmed OK at 14:32 PDT (Shaw / federation-e00google)

## v5 plan sketch (if Case 2)
- train_local.py has NO --max-steps; supports --epochs (float) and --max-samples
- To get ~1500 steps inside 12h: would need driver patch (train_nebius.sh hardcodes --epochs 1) OR set ELIZA1_FULLCORPUS_UPSAMPLE=1 + plumb a smaller epoch count
- Cleaner alternative: edit train_nebius.sh to read EPOCHS env var (default 1) and pass through

## Monitor
- bt6nuc7hc — every-10min progress + terminal events (driver_dead | watcher_dead | sentinel)

---

# CUDA-FINISH-3 status — Task #66 (append, 2026-05-12 ~14:50 PDT)

## What happened
- Picked up the in-flight `linux-x64-cuda-fused` build (PID 3658604, started ~13:58 PDT, `-j 6`).
- Build **failed at 52%** (~14:42 PDT, ~44 min in) — last line: `cmake --build ... failed with null`.
- `null` exit means the cmake child was killed by signal, not a normal non-zero exit. No `nvcc fatal` / `cc1plus: error` in the log — build was making linear progress (43%→52% in the last ~10 min) through `fattn-vec-instance-*.cu.o`.
- Root cause: environmental — CPU thermal throttle events at 14:43 + 11 GB free / 10.7 GB swap in use, plus a flapping docker container (`5deb1ecabff84…` restartCount 4112→4113 during the failure window) competing for scheduler attention. No kernel OOM-kill recorded for the build window in `journalctl -k` (host has `kernel.dmesg_restrict=1`, may be filtered).
- Per handoff guard ("Do not attempt a second build without diagnostic confirmation"): stopped. Did **not** start the vulkan-fused build (which was gated on cuda-fused finishing). Did **not** run e2e_loop_bench (publish gate `voice_rtf ≤ 0.5` unreachable without the fused install).

## Phases completed
- Phase 1: build failed; diagnosis + post-mortem written (this entry + `packages/inference/reports/porting/2026-05-12/cuda-fused-build-failure.md` + `.log`).
- Phases 2–7: blocked.

## Phases blocked
- Phase 2 (`make cuda-verify-fused` + `cuda-hardware` against the fused install) — blocked: install dir does not exist.
- Phase 3 (e2e_loop_bench cuda, the publish gate) — blocked: `discoverEngine` in `verify/e2e_loop_bench.mjs` requires `~/.eliza/local-inference/bin/dflash/linux-x64-cuda-fused/` for `--backend cuda`.
- Phase 4 (vulkan-fused build) — gated sequentially after cuda-fused (per handoff: "two heavy builds at once will OOM the 16 GB box" — but the box is 31 GB; the constraint is still serial-only).
- Phase 5 (e2e_loop_bench vulkan) — blocked.
- Phase 6 (master report + HF push of fused-build numbers) — blocked.
- Phase 7 (commit + final report) — partial: this STATUS + post-mortem will commit.

## Untouched
- `~/.eliza/local-inference/bin/dflash/linux-x64-cuda/` — reference-good non-fused install (forkCommit `a61c93aaa5`, `libggml-cuda.so.0.9.7` 473 MB, llama-bench numbers in `packages/training/reports/eliza1-harness-benchmark-2026-05-12.md`). Not modified.
- `~/.eliza/local-inference/bin/dflash/linux-x64-cpu-fused/` — also intact.
- `packages/inference/llama.cpp/build/linux-x64-cuda-fused/` — preserved (52% of `.o` files cached). A retry will resume incrementally in ~30 min, not the full ~90 min.
- H200 SFT siblings (PID 3652060 + watcher 3652514) — healthy, ~step 77/9615.

## Recommended next-agent action
- See `packages/inference/reports/porting/2026-05-12/cuda-fused-build-failure.md` §"Recommended next-agent action".
- Short version: stop the flapping docker container `5deb1ecabff84…`, wait for thermals to drop, then retry with `--jobs 3` + `nice -n 19 ionice -c idle`. The cmake incremental cache will pick up at ~52% and finish in ~30 min.
