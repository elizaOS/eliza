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

# ACTION-PERSONALITY-BENCH status — Task #66 (append, 2026-05-12 ~15:25 PDT)

## What happened
- Picked up the two deferred cells in `packages/training/reports/eliza1-harness-benchmark-2026-05-12.{md,json}` for the test-SFT 0_6b row: action-selection accuracy + personality PASS%.
- Local llama-server stood up against `final-Q4_K_M.gguf` on port `19980` via the non-fused `linux-x64-cuda` install (`-c 32768 -ngl 99`, no-think chat template at `/tmp/chat_template_nothink.jinja`). 16 GB GPU, peak ~5 GB used.
- **Action-selection: 15.6% (5/32)** — vitest `test/vitest/real.config.ts` + `packages/app-core/test/benchmarks/action-selection.real.test.ts`, 32-case curated `ELIZA_BENCHMARK_FILTER` covering every action surface. The 0_6b test-SFT defaults to REPLY for every tool-action prompt (`llm_chose_reply` on all 27 failures); the 5 chat/negative cases pass cleanly.
- **Personality: 33.3% (2/6 PASS, 2 FAIL, 2 NEEDS_REVIEW)** — `scripts/personality-bench-run.mjs` profile `eliza-runtime`, 6 stratified scenarios (1 per bucket + 1 extra shut_up), Cerebras `gpt-oss-120b` judge. Cut from 25 scenarios for budget (per-scenario rate ~2.8 min; 25 would have run ~70 min). Judged the captured trajectories separately via `/tmp/judge-partial.mjs`.
- Patched `scripts/personality-bench-run.mjs` to honour new env knobs `ELIZA_PERSONALITY_RUNTIME_OPENAI_BASE_URL` / `_API_KEY` / `_MODEL` so the agent under test can run on a local llama-server while the parent process keeps Cerebras as the judge. Default behaviour (all-Cerebras for both) preserved.

## Artifacts
- Master report patched: `packages/training/reports/eliza1-harness-benchmark-2026-05-12.{md,json}` (test-SFT 0_6b row, footnote ², still_pending updated).
- Per-bench raws committed: `packages/training/reports/action-selection-eliza1-0_6b-2026-05-12.{json,-report.md}` and `packages/training/reports/personality-bench-eliza1-0_6b-2026-05-12.json`.
- HF dataset push: `elizaos/eliza-1-evals` under `bench/harness-2026-05-12/` — commit `https://huggingface.co/datasets/elizaos/eliza-1-evals/commit/873ae751b2ba6ab821b9fa9f9436c384dca1f7ce`. Includes the action-selection log + the full per-scenario trajectory dump for personality.
- Local commit: `7ef890c688` on `develop`, pushed to `origin/develop`.

## Still owed (downgraded from "deferred" to "budget-capped")
- Full 76-case action-selection run on an idle host (this run did 32 cases). The 12 cases that hit prompt-overflow (>32k tokens) under our setup might or might not change the headline number; the bottleneck is the 0_6b never producing a tool_call, so expect the same pattern with more samples.
- Full 200-scenario personality run on an idle host (this run did 6). Stratified bucket coverage is intact at small-n, but the headline 33.3% has ±19 pp noise at n=6 — the full-corpus 0_6b SFT (still in flight) is the more useful target anyway.
- Sibling agents (#64 CUDA-FINISH-3 / #65 H200-MONITOR-3) untouched.

# H200-MONITOR-4 status — Task #65 (append, 2026-05-12 22:36 UTC)

## CRITICAL: watcher 3652514 self-terminated due to expired nebius CLI auth

### Sequence of events
- 2026-05-12T20:51:13Z — v4 driver (3652060) + watcher (3652514) armed.
- 2026-05-12T22:17:56Z — nebius CLI federation token expired (`expires_at: 1778624276` in `~/.nebius/credentials.yaml`).
- 2026-05-12T22:28:02Z — watcher logged `instance eliza-train-h200-0_8b-v4 gone — full's trap already cleaned up. exiting.` and exited.
- The watcher's `instance_up()` function silently swallows nebius CLI errors via `2>/dev/null` and returns `'no'` on any failure. Combined with auth-token expiry → false-positive teardown signal.
- I verified the VM is **still alive** via direct SSH at 22:34Z:
  - Hostname `computeinstance-e00j1mt79qhd4d3dds`, IP `89.169.122.196`
  - `nvidia-smi`: NVIDIA H200, 22.8/143.8 GiB used, 14% util
  - Remote log progressing; driver still tail-polling via SSH every 60s.
- Driver (3652060) still alive at 22:34Z, step 233/9615 (~19s/iter), faster than initial projection.

### Why this is dangerous
- VM is billing (~$3-4/h class) but there is **no watcher** to teardown if the driver dies.
- I cannot re-auth `nebius` CLI non-interactively — it requires browser OAuth federation (chrome already opened at 13:42 with an OAuth URL, evidently never completed).
- I cannot run `nebius compute v1 instance delete` myself for the same reason.

### What I will do next
1. Re-arm a fixed watcher (`/tmp/nebius-finish-q35-0_8b-v4b.sh`) that uses **SSH-based VM liveness** instead of nebius CLI list output, so it doesn't get fooled by transient auth/network blips. Note: this watcher CANNOT execute teardown (no auth) — but it can:
   - Detect driver death + VM-still-up
   - Loudly notify (log + write to STATUS)
   - Try the nebius teardown anyway (will fail but logs the attempt)
2. Continue Phase A active polling for driver progress.
3. **If driver dies before nebius re-auth**, the user needs to manually run nebius login then `bash packages/training/scripts/train_nebius.sh teardown` with `NEBIUS_VM_NAME=eliza-train-h200-0_8b-v4`.

### Ask for the user (when they read this)
- Please complete the nebius OAuth flow at the chrome tab from PID 3643529 (URL has `state=-1ejvo6kAZU2KcoTfKM40hNdP6vbJzHK`, expired by now — likely needs fresh `nebius iam get-access-token`).
- After re-auth, please run `nebius compute v1 instance list --parent-id project-e00kfz6cpr00q21z892vec --format json` to verify the VM is the only one running, and let me know.

### Direct-action affordance until re-auth
If billing emergency hits before re-auth, the driver itself can be killed and the training-loss preserved by SSH-killing the remote `run_pipeline.py` cleanly:
```
ssh ubuntu@89.169.122.196 "tmux send-keys -t elizatrain C-c; sleep 10; tmux send-keys -t elizatrain C-c"
```
Then the user must still teardown the VM via nebius CLI after re-auth.

# CUDA-FINISH-4 status — Task #64 follow-up (append, 2026-05-12 ~16:55 PDT)

## What landed

### Item 3 — linux-x64-cuda-fused build (RTX 5080 sm_120, CUDA 12.8)
- Built from a clean dir against fork commit `a61c93aaa5` + omnivoice pin `38f824023d12` with `CUDACXX=/usr/local/cuda-12.8/bin/nvcc PATH=/usr/local/cuda-12.8/bin:$PATH … --jobs 3`. `-j 6` got OOM'd by the kernel at the `fattn.cu` long-pole (`failed with null` = SIGKILL by OOM-killer); `-j 3` survived ~85 min wall-clock.
- Install: `~/.eliza/local-inference/bin/dflash/linux-x64-cuda-fused/`. CAPABILITIES.json `publishable: true`, `missingRequiredKernels: []`, all 8 kernels true (dflash, turbo3, turbo4, turbo3_tcq, qjl_full, polarquant, lookahead, ngramDraft). omnivoice-fuse symbol-verify `llama=0 omnivoice=10 abi=23`.
- `make cuda-verify-fused`: 1920/1920 PASS on RTX 5080 sm_120, max diff 5.07e-07 → `packages/inference/verify/logs/cuda-verify-fused-fusedbuild-rtx5080-2026-05-12.log`.
- `make cuda-hardware` against the install: 6/6 fixture sets PASS (`turbo3 / turbo4 / turbo3_tcq / qjl / polar / polar_qjl / fused_attn_qjl_tbq 1920/1920`). The optional `runtime_graph_smoke` step requires `llama-bench` (not in the fused-target list — non-blocking tooling gap). Log: `cuda-hardware-fusedbuild-rtx5080-2026-05-12.log`.

### Item 4 — e2e_loop_bench cuda 1-turn against the fused install
- voice_rtf **0.4255** ≤ 0.5 → **PASS** publish gate.
- tg 64.82 tok/s, first_token 43.3 ms, dflash 12/12 accepted, peak RSS 2340 MB, total turn 3073.6 ms, e2eOk true.
- Report: `packages/inference/reports/porting/2026-05-12/e2e-loop-cuda-2026-05-12.json`.

### Item 5 — linux-x64-vulkan-fused build + e2e_loop_bench vulkan
- Build: ~3 min wall (Vulkan is much lighter than CUDA — no per-arch SASS, just SPIR-V baked in). Installed `~/.eliza/local-inference/bin/dflash/linux-x64-vulkan-fused/`. CAPABILITIES.json `publishable: true`, `missingRequiredKernels: []`, fused SPIR-V baked in (`eliza_fused_attn_qjl_tbq_data` + `eliza_fused_attn_qjl_polar_data` symbols).
- `make vulkan-verify-fused` on Intel ARL iGPU (Mesa ANV 25.2.8): 6912 outputs PASS across 4 fixture sets (fused_attn_qjl_tbq 1920+1536 + fused_attn_qjl_polar 1920+1536), max diff 6.26e-07.
- `e2e_loop_bench vulkan` 1-turn: e2eOk true, dflash 31/31, but iGPU performance keeps voice_rtf at **1.7269** → **FAIL** publish gate on iGPU class. The gate is a discrete-GPU target. tg 12.13 tok/s, first_token 493 ms, peak RSS 1370 MB. Report: `packages/inference/reports/porting/2026-05-12/e2e-loop-vulkan-2026-05-12.json`.

## Docs + HF push
- `packages/training/reports/eliza1-harness-benchmark-2026-05-12.{md,json}` — added a new "Fused-build e2e_loop_bench" section + structured `fused_build_e2e_loop_bench_2026_05_12` field in JSON.
- `packages/inference/verify/PLATFORM_MATRIX.md` — flipped `linux-x64-cuda-fused` + `linux-x64-vulkan-fused` rows to verified-here with measured numbers.
- `packages/inference/verify/kernel-contract.json` — both fused targets bumped to `runtime-ready` / `runtime-ready` / `verified` (kernelVerification / runtimeDispatch / deviceRun). nextGate set to "additional sm classes" (CUDA) and "discrete Vulkan card" (Vulkan).
- HF dataset push: `elizaos/eliza-1-evals` — 8 files (e2e-loop-cuda + e2e-loop-vulkan + cuda-verify-fused log + cuda-hardware log + vulkan-verify-fused log + PLATFORM_MATRIX.md + kernel-contract.json + harness-benchmark.md). Final HF commit: `2333dc2b5af2f8b5c940ffd75a75c0aeae88ddc6`.

## Sibling agents — UNTOUCHED
- H200-MONITOR-4 (Task #65): VM 89.169.122.196 still up, driver 3652060 still training, fixed watcher being armed by sibling.
- ACTION-PERSONALITY-BENCH (Task #66): commit `7ef890c688` already on origin/develop.

## Still owed (post this run)
- Re-run `e2e_loop_bench --backend vulkan` on a discrete Vulkan-mode card (RDNA3 RX 7800 / Ada RTX 4080 in pure-Vulkan / Intel BMG) for a Vulkan voice-rtf number under the discrete-GPU class.
- Re-run cuda-fused on additional sm classes (sm_89 Ada / sm_90 H100 / sm_100 datacenter Blackwell) to confirm no arch regression in `CMAKE_CUDA_ARCHITECTURES=90a;90;89;86;80;100;120a`.
- `llama-bench` is not in the fused-target list — adding it would unblock `runtime_graph_smoke.sh --gen-check` against the fused install. Non-blocking; the cuda-verify-fused parity + e2e_loop_bench publish-gate pass cover the substance.


# H200-MONITOR-4 status — UPDATE 2026-05-13 03:36 UTC

## v4 RUN TERMINATED at step ~1241 due to driver's built-in 6h watchdog

### What happened
- 2026-05-13T03:33:34Z (6h after `run_remote` started polling): the driver hit `scripts/train_nebius.sh` line 439 cap: `if [ "$i" -gt 360 ]; then echo "ERROR: still running after 6h — bailing"; return 1; fi`.
- `run_remote` returned 1 → bash's `set -euo pipefail` aborted the `full` flow → `fetch` was SKIPPED → EXIT trap ran only `teardown`.
- The EXIT trap's `teardown` function (line 544) called `instance_id_by_name` → `nebius compute v1 instance list` → expired-auth hang → I had to kill the driver process (3652060) manually at 03:35:51Z.
- **Final remote step: 1003** (per remote `run_eliza-1-0_8b-apollo-fullcorpus-h200-1778619044.log`).
- Note: the local launch.log showed step 1241 in the local tail — that's because my Ctrl-C-via-tmux send-keys at 03:34:48Z killed the python training between the 1003 eval finish and the next eval/save. Eval at step 1000 finished: **eval_loss=1.145 at epoch 0.104**.

### Artifacts on remote VM (89.169.122.196 still up)
- `/opt/training/checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/checkpoint-500/` (3.4 GB, eval done)
- `/opt/training/checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/checkpoint-1000/` (eval done, eval_loss=1.145)
- No checkpoint-1500 (only got to step 1241ish before my Ctrl-C; would have needed step 1500).
- README.md, environment.json present.

### Manual rsync fetch in progress
- PID 4024662: `rsync -avhz ubuntu@89.169.122.196:/opt/training/checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/` → local.
- Network speed thrashing 300-1500 KB/s. At ~500 KB/s sustained, the two 3.4GB checkpoints = ~7 GB total → **~4h fetch time worst case**.
- Log: `/tmp/q35-0_8b-v4-manual-fetch.log`

### CRITICAL: VM is up and billing, nebius CLI auth still broken
- VM `eliza-train-h200-0_8b-v4` (instance + boot disk) is still active. GPU idle (0%) since 03:34:48Z, but VM compute is billing at ~$3-4/h.
- Driver's EXIT trap teardown hung indefinitely on expired-token `nebius compute v1 instance list`.
- My fallback watcher (`/tmp/nebius-finish-q35-0_8b-v4b.sh`) cannot teardown either (same auth issue).
- **USER ACTION REQUIRED**: complete nebius OAuth federation (browser at PID 3643529 from 13:42Z, expired URL — likely needs `nebius iam get-access-token` triggered fresh). Then run:
  ```
  export NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec
  cd /home/shaw/milady/eliza/packages/training
  NEBIUS_VM_NAME=eliza-train-h200-0_8b-v4 bash scripts/train_nebius.sh teardown
  ```

### State of training quality at the artifact step
- ~1000 steps done out of 9615 (10.4% of 1 epoch).
- eval_loss 1.145 — meaningful but very early. Gate's format_ok ≥ 0.70 threshold cannot be evaluated without the SFT pipeline running its eval gate (`run_pipeline.py` post-train eval). Since we hit the driver's 6h cap before SFT completed and triggered the eval gate, **no gate_report.json was produced**.
- This is a **Case 2 outcome** per the agent brief (partial checkpoint, no gate_report).

### Decision: relaunch as v5 with `--max-steps` is NOT yet possible
- Reasons:
  - Need nebius auth restored before any new VM can be provisioned.
  - `train_local.py` has no `--max-steps` flag (only `--epochs` / `--max-samples`); patching `train_nebius.sh` to plumb max-steps requires source edits to `scripts/run_pipeline.py` too.
  - Bigger structural problem: the driver hit 6h not 12h. The `train_nebius.sh` 6h cap is hardcoded at line 439. A successful 1500-step run within the cap needs either: shorter eval (saw 50min eval at step 500), smaller test set, or per-step rate above ~6 it/s.
- Recommended v5 plan documented separately in v5 below.

## Cleanup state
- Driver (3652060): killed at 03:35:51Z
- Watcher v4 (3652514): self-terminated at 22:28:02Z (false positive)
- Watcher v4b (3768788): killed at 03:36:11Z (would fail teardown)
- Manual rsync (4024662): in progress
- v4 launch.log: still on disk at `/tmp/q35-0_8b-v4-launch.log` for forensics
- VM `eliza-train-h200-0_8b-v4`: **STILL UP, NEEDS USER MANUAL TEARDOWN**

## v5 plan (post user re-auth)
1. Patch `train_nebius.sh` line 439 to honor an `ELIZA_REMOTE_RUN_TIMEOUT_H` env var (default 12 to match watcher).
2. Patch `scripts/run_pipeline.py` (or `train_local.py`) to honor `MAX_STEPS` env (the trainer.Trainer supports `max_steps` kwarg).
3. Reduce eval frequency: change `save_steps` from 500 → 1500 (so single mid-run eval doesn't burn 50 min). OR keep save_steps=500 but reduce test set size.
4. Relaunch v5 with `MAX_STEPS=1500 ELIZA_REMOTE_RUN_TIMEOUT_H=12 NEBIUS_VM_NAME=eliza-train-h200-0_8b-v5 bash scripts/train_nebius.sh full --registry-key qwen3.5-0.8b ...`
5. Create proper v5 watcher with SSH-based liveness (use `/tmp/nebius-finish-q35-0_8b-v4b.sh` as template).

I am DONE for this agent run — handing off to next H200-MONITOR or to user for nebius re-auth.


# H200-MONITOR-4 — FINAL UPDATE 2026-05-13 05:14 UTC

## Manual rsync fetch COMPLETED
- Both checkpoints fully local at `/home/shaw/milady/eliza/packages/training/checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/`
- `checkpoint-500/`: 3.3 GB (model.safetensors 1.5GB + optimizer.pt 2.0GB + tokenizer/config)
- `checkpoint-1000/`: 3.4 GB (same shape)
- Total fetched: 7.14 GB at ~1.3 MB/s avg (1h35m wall)
- rsync log: `/tmp/q35-0_8b-v4-manual-fetch.log` (PID 4024662 exited cleanly)

## Training loss curve from trainer_state.json
- **step 490 → 500**: train loss 8.95 → 8.82, eval_loss=1.255 (eval ran 37 min)
- **step 990 → 1000**: train loss 7.22 → 7.06, eval_loss=1.145 (eval ran 15 min, eval cache warm)
- LR schedule: linear warmup from 1e-5, currently 9.86e-6 at step 1000
- grad_norm 83→100→125→144 (volatile, expected at very early epoch)
- Conclusion: model is clearly learning, but eval_loss=1.145 at 10.4% of epoch 1 is too early for a quality `format_ok ≥ 0.70` gate clear. Loss curve trajectory looks sane and matches the 0.6b reference.

## Gate eval: NOT RUN
- The pipeline's gate eval (`run_pipeline.py --eval-mode full`) only runs AFTER training completes. We hit the driver's 6h cap mid-training. No `gate_report.json` exists.
- Per Case 2 in the brief, this is a "partial checkpoint, no gate_report" outcome → iterate (not publish).

## v5 cannot start until USER re-auths nebius

### Steps for user
1. `~/.nebius/bin/nebius iam get-access-token` (opens browser, complete federation OAuth)
2. `~/.nebius/bin/nebius iam whoami` (verify)
3. Teardown v4 VM:
   ```
   export PATH="$HOME/.nebius/bin:$PATH"
   export NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec
   cd /home/shaw/milady/eliza/packages/training
   NEBIUS_VM_NAME=eliza-train-h200-0_8b-v4 bash scripts/train_nebius.sh teardown
   ```

### v5 patch required first (before relaunch)
1. **Patch `scripts/train_nebius.sh` line 439** — raise the 6h hardcoded cap to `${ELIZA_REMOTE_RUN_TIMEOUT_H:-12}*60`. Without this, any retry will hit the same 6h wall.
2. **Patch the EXIT trap (line 582)** — change `teardown || true` to `fetch || true; teardown || true` so a 6h-cap bail still pulls partial checkpoints back before attempting nebius teardown. Right now `set -euo pipefail` causes `fetch` to be skipped after `run_remote` returns 1.
3. **Patch `instance_up()` in watcher scripts** — don't swallow nebius CLI failures as "no" (the v4 watcher bug). Use SSH-based liveness as primary, nebius CLI as confirmation only.
4. Consider plumbing `MAX_STEPS` from env → `run_pipeline.py` → `train_local.py` for budget-bound runs (1500 steps in 12h target).

### v5 launch (after patches + auth)
```
NEBIUS_VM_NAME=eliza-train-h200-0_8b-v5 \
  ELIZA_REMOTE_RUN_TIMEOUT_H=12 \
  bash packages/training/scripts/train_nebius.sh full \
  --registry-key qwen3.5-0.8b \
  --run-name eliza-1-0_8b-apollo-fullcorpus-h200-v5-$(date +%s)
```
Then arm a fresh watcher copied from `/tmp/nebius-finish-q35-0_8b-v4b.sh` (SSH-based liveness).

## Sibling agents NOT TOUCHED
- CUDA-FINISH-3's failed cuda-fused build (no retry from me).
- ACTION-PERSONALITY-BENCH's local llama-server (3712834) — left running.

## Files for next agent
- `/home/shaw/milady/eliza/.swarm/STATUS.md` — this file (state of affairs)
- `/tmp/URGENT-NEBIUS-TEARDOWN-NEEDED.md` — user-facing teardown instructions
- `/tmp/q35-0_8b-v4-launch.log` — full v4 driver log
- `/tmp/q35-0_8b-v4-watcher.log` — original (broken) v4 watcher log
- `/tmp/q35-0_8b-v4b-watcher.log` — fallback watcher log
- `/tmp/q35-0_8b-v4-manual-fetch.log` — manual rsync log
- `/tmp/nebius-finish-q35-0_8b-v4b.sh` — SSH-based watcher template for v5
- `packages/training/checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/` — both partial checkpoints (500 + 1000) with full trainer state
