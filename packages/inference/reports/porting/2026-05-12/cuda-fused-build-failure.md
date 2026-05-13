# cuda-fused build failure — post-mortem (2026-05-12)

Author: CUDA-FINISH-3 (follow-up agent, #66)
Host: BEAST — Intel Core Ultra 9 275HX (24 cores), RTX 5080 Laptop (16 GB, sm_120), 31 GB RAM, 40 GB swap
Build script: `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda-fused --jobs 6`
Build PID: `3658604`
Started: 2026-05-12 ~13:58 PDT (per `ELAPSED` at handoff)
Failed: 2026-05-12 ~14:42 PDT (~44 min elapsed)
Last % reported: **[52%]** (template-instance compile of `fattn-vec-instance-tbq4_0-tbq4_0.cu.o`)
Build log: [`cuda-fused-build-failure.log`](./cuda-fused-build-failure.log) (358 lines, 35 KB)

## What failed

The cmake build worker died mid-template-instance grind. The build script
[`build-llama-cpp-dflash.mjs`](../../../../packages/app-core/scripts/build-llama-cpp-dflash.mjs)
wraps `spawnSync("cmake", [...])` and reports `result.status` in the error
message; `status === null` means the child exited via signal (not a normal
exit code). The final line of the build log:

```
[ 52%] Building CUDA object ggml/src/ggml-cuda/CMakeFiles/ggml-cuda.dir/template-instances/fattn-vec-instance-tbq4_0-tbq4_0.cu.o
[dflash-build] cmake --build /home/shaw/milady/eliza/packages/inference/llama.cpp/build/linux-x64-cuda-fused --target llama-server llama-cli llama-speculative-simple llama-mtmd-cli omnivoice-core elizainference llama-omnivoice-server -j 6 failed with null
```

No `nvcc fatal`, `cc1plus: error`, or `Killed` line appears in the build
log itself — i.e. the failure was not a compilation diagnostic. The child
process was signaled and the parent recorded a `null` exit code.

## Why (best diagnosis)

- **CPU thermal throttling.** From `/var/log/syslog` around 14:43 PDT, several
  `CPU0/3/5: Package temperature is above threshold, cpu clock is throttled`
  events fired. Loadavg at the time was ~5–6.4; the box was hot.
- **Memory pressure but no kernel OOM-kill.** `free -m` at 14:45 PDT showed
  31 GB total, 9.5 GB used, 11 GB free, 13 GB buff/cache, 10.7 GB swap in use
  (out of 40 GB), 22 GB MemAvailable. `journalctl -k` shows no `Out of memory:
  Killed process` lines for the build window (14:40–14:45). Earlier OOMs
  (08:21, 08:28) targeted `cursor`/`chrome` — not our build.
- **Concurrent docker container `5deb1eca…` restart-looping every 60 s**
  (containerd restart events at 14:43:50 + 14:44:50, restartCount 4112→4113).
  Each restart is short, but it pulls scheduler attention and inflates
  context-switch overhead; combined with `-j 6` nvcc workers (each holding
  ~7 arch codegen passes for the Blackwell fat-binary `90a;90;89;86;80;100;120`
  list), one of the nvcc subprocess trees likely got signaled by something
  outside the build (best guess: a transient memory squeeze inside one of
  the nvcc passes that the kernel OOM ranking did not record at the level
  visible to user-mode `journalctl`, since the host has `kernel.dmesg_restrict=1`).
- **Concurrent H200 SFT does not share the GPU.** PIDs 3652060 (`bash
  scripts/train_nebius.sh full`) and 3652514 (watcher) run remotely on
  Nebius H200; they only tail logs locally. No local GPU contention.

Net: the build was making linear progress through `fattn-vec-instance-*.cu.o`
files (43%→52% across the visible portion of the log, ~10 percentage points
in the last ~10 minutes); failure was environmental, not a build-script or
source-tree bug. The non-fused `linux-x64-cuda` target built clean from the
same fork earlier today (`a61c93aaa5`, v1.2.0-eliza, install verified
8/8 + 1920/1920), which corroborates that the source tree is sound.

## Why NOT a second build now

Per the handoff contract ("Do not attempt a second build without diagnostic
confirmation"):

1. The root cause is **not** in the source tree or build script — both produced
   a clean non-fused install today; the fused-graft hook (`prepareOmnivoiceFusion()`,
   `appendCmakeGraft()`) compiled through the first 35% (omnivoice-core +
   ggml-base + ggml-cpu) and then through 35–52% of the ggml-cuda template
   instances.
2. The root cause **is** environmental: thermal throttle + memory pressure +
   a flapping docker container competing for scheduler attention.
3. A second `-j 6` retry under the same conditions would most likely fail in
   the same way. A retry should:
   - Reduce parallelism (`--jobs 3` or `--jobs 4`) to fit within thermal +
     swap headroom.
   - Pause the flapping docker container `5deb1eca…` (or `systemctl restart
     docker` once) so it isn't restarting every 60 s.
   - Use `nice -n 19` + `ionice -c idle` to deprioritize the build vs the
     interactive shell.
4. The cmake build dir `packages/inference/llama.cpp/build/linux-x64-cuda-fused`
   is **preserved** (52% of `.o` files retained); a future `cmake --build`
   invocation will resume incrementally rather than restarting from scratch,
   so a retry under better conditions costs <30 min, not the full 90 min.

## Phases blocked

All downstream phases from the handoff are blocked on this build:

- Phase 2 (`cuda-verify-fused` + `cuda-hardware` against the **fused** install) —
  blocked (the fixture-parity `make cuda-verify-fused` is environment-only and
  would run today, but the contract says "against the **fused** install (the
  Makefile picks the right one)"; the install does not exist).
- Phase 3 (e2e_loop_bench cuda, the **publish gate** `voice_rtf ≤ 0.5`) —
  blocked (`discoverEngine` in `verify/e2e_loop_bench.mjs` requires a
  `linux-x64-cuda-fused` build dir under `~/.eliza/local-inference/bin/dflash/`,
  exact match for `--backend cuda`).
- Phase 4 (vulkan-fused build) — gated to run **sequentially after** cuda-fused
  per the handoff ("Do not start the vulkan-fused build until cuda-fused is
  fully installed AND verified"). Blocked.
- Phase 5 (e2e_loop_bench vulkan) — blocked (depends on Phase 4).
- Phase 6 (master report + HF push of new fused-build numbers) — blocked (no
  new numbers to push).
- Phase 7 (commit + final report) — partial: this post-mortem + STATUS.md
  update will commit; the bench-number commit cannot.

## Recommended next-agent action

1. Stop or `docker stop 5deb1ecabff84` the flapping container.
2. Wait for CPU package temperature to drop below threshold (`watch
   sensors | grep -E "Core|Package"`).
3. Re-run with reduced parallelism:
   ```
   nice -n 19 ionice -c idle node packages/app-core/scripts/build-llama-cpp-dflash.mjs \
     --target linux-x64-cuda-fused --jobs 3 2>&1 | tee /tmp/cuda-fused-build-2.log
   ```
   (the preserved 52% of `.o` files will reduce wall-clock to ~30 min).
4. Then resume Phase 2 of the original CUDA-FINISH-3 handoff.

## Evidence preserved

- `cuda-fused-build-failure.log` — full build log (35 KB, 358 lines, last
  line shows the `failed with null` failure).
- `packages/inference/llama.cpp/build/linux-x64-cuda-fused/` — incremental
  cmake build dir (52% of `.o` files, CMakeCache.txt intact). Not deleted.
- Non-fused install at `~/.eliza/local-inference/bin/dflash/linux-x64-cuda/`
  is **untouched** (reference-good, the handoff guard explicitly forbids
  touching it).
- H200 SFT siblings (PID 3652060 + watcher 3652514) still healthy at step
  ~77 / 9615; not affected.
