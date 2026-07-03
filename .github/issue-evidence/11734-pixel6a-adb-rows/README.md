# #11734 — Pixel 6a adb-measurable benchmark rows (TTFT / prefill / thermal / 4b tier)

Captures the four rows of #11734 that are measurable from a dev host over adb
**without** a hardware lab. Battery/power draw and iOS remain genuinely
lab-gated (a tethered device charges over the adb cable — discharge cannot be
measured; there is no physical iOS device on this host).

## Device / build under test

| | |
|---|---|
| Device | Pixel 6a (`bluejay`), serial `27051JEGR10034`, Tensor GS101, Mali-G78 MP20, Android 16 |
| RAM | MemTotal 5589 MB → runtime RAM class `CONSTRAINED` (`nCtx=4096`, `idleUnloadMs=300000`) |
| Build | policy build @ merge `35f61d1f` (PR #11822), `app-debug.apk` md5 `b260d860…` — same install the #11908 acceptance soak passed on |
| Model | eliza-1-2b Q4 (`eliza-1-2b-q4.gguf`, 1,270,808,512 B) via the in-process bionic Vulkan host |
| Path | `POST /v1/chat/completions` (stream) through `adb forward tcp:31337`; replies carry `localInference.provider=mobile-local-direct-reply` |
| Charging | USB powered the whole session (why battery rows are not measurable here) |

## Method

- **Turn driver** (`raw/turn-driver.mjs`): streaming SSE request; records
  time-to-first-byte, time-to-first-content-chunk (client TTFT), total wall.
- **Leg 1a (TTFT distribution)**: 12 back-to-back turns with *identical-length*
  48-char questions (two-digit-math phrasing) → identical 294-char prompts.
- **Leg 1b (prefill isolation)**: 8 turns with the same tail question and a
  neutral filler prefix growing 0→630 chars (fast-path cap is 700 user chars),
  i.e. prompts 294→920 chars. The bionic host decodes a **constant 256 tokens
  per turn** on this build (see "transport findings"), so the per-turn native
  window is `K + promptTokens / prefillRate`; the slope isolates prefill.
- **Prompt tokens**: exact per-prompt token counts from the model's own
  tokenizer. The on-device `eliza-1-2b-q4.gguf` header reports
  `general.architecture=qwen35` / base `Qwen/Qwen3.5-2B-Base`
  (`tokenizer.ggml.model=gpt2`, `tokenizer.ggml.pre=qwen35`, add_bos=false) —
  see "artifact findings" below — so counts use the Qwen3.5 `tokenizer.json`
  (verified 0/50 vocab mismatches against the published
  `bundles/4b/text/eliza-1-4b-256k.gguf` GGUF vocab) —
  `analysis/prompt-tokens.json`.
- **Per-turn native window**: `ElizaBionicInfer` logcat pairs
  (`GENERATE_STREAM from agent` → `GENERATE_STREAM done`), plus
  `releasing resident inference state` events to classify warm vs
  transparent-reload turns (`raw/session-logcat.log`).
- **Thermal (leg 2)**: `dumpsys thermalservice` (Current temperatures from HAL)
  + battery temp + cooling-device states sampled every 15 s for the whole
  session (`raw/thermal-monitor.sh` → `raw/thermal-timeline.tsv`).
  `/sys/class/thermal` is permission-blocked on this user build; the HAL dump
  is the only shell-visible source.
- **Leg 4 (4b tier)**: see `raw/leg4-runbook.md`; memory sampled by
  `raw/leg4-mem-monitor.sh` (pid + MemAvailable every 5 s, full
  `dumpsys meminfo` every 30 s).

## Transport + artifact findings (context for reading TTFT)

1. **The mobile fast path delivers the whole reply as ONE SSE chunk.** The
   fast path calls `useModel(TEXT_SMALL, {stream: true, onStreamChunk})`, but
   the bionic host's first `nativeLlmStreamNext` step returns the entire
   decode (`nout=256`, one `token` frame) — every turn logs
   `GENERATE_STREAM done: 256 tok` and every client stream has
   `chunkEvents=1`. Client-observed TTFT therefore equals full-turn latency
   on this build. (This also means `maxTokens=20` is not enforced: the Java
   `produced < cap` loop exits only after the first step has already decoded
   256 tokens — every ~9-token reply pays a full 256-token decode.)
2. **The historical "decode 4.8 tok/s warm" baseline (#11352 / PR #11717) is a
   combined window rate**, `256 tok / (full prefill + 256-token decode)` — not
   isolated decode. The leg-1b regression below separates the two.
3. **Prefix-KV reuse never engages on this build** (no
   `resident prefill reuse` lines in any run or in the #11908 soak logcat) —
   every turn re-prefills the full prompt.
4. **The shipped device-tier eliza-1 text artifacts are Qwen3.5, not Gemma-4.**
   The on-device `eliza-1-2b-q4.gguf` (byte-identical in size to HF
   `bundles/2b/text/eliza-1-2b-256k.gguf`) reports
   `general.architecture=qwen35`, base `Qwen/Qwen3.5-2B-Base`; the published
   `bundles/4b/text/eliza-1-4b-256k.gguf` is `Qwen3.5 4B` Q4_K_M. Only the
   8.0 GB `…-128k` files are the Gemma-4 E2B/E4B cutover. The catalog comment
   (`packages/shared/src/local-inference/catalog.ts`) says "the Gemma-4
   cutover only landed for the 2b and 4b tiers", but on-device tiers still
   serve Qwen3.5. Consequently the fast path's hardcoded Gemma
   `<start_of_turn>`/`<think>` template tags are plain text to this model —
   it never emits a matching stop, so the native 256-token decode buffer
   always fills.
5. **Background agent jobs share the resident model and serialize with chat
   turns.** During the first leg-1b attempt an autonomous job fired
   `GENERATE_STREAM 11169 prompt chars, maxTokens=8192` 0.4 s after a sweep
   turn completed; at device prefill speed that call would monopolize the
   resident lock for tens of minutes. The attempt was aborted
   (`raw/prefill-runs-attempt1.jsonl`), the app force-stopped and relaunched,
   and the sweep rerun (attempt 2 is the dataset below).

## Results

_(filled from `analysis/` after the runs)_

### Leg 1a — TTFT distribution (12 identical 294-char prompts, eliza-1-2b Q4)

Client-observed TTFT = time to first SSE content chunk = full-turn latency on
this build (single-chunk transport, finding 1).

| set | n | p50 | p90 | min | max |
|---|---:|---:|---:|---:|---:|
| **all turns** | 12 | **54.3 s** | **57.7 s** | 52.9 s | 58.8 s |
| warm only | 9 | 54.3 s | 54.5 s | 52.9 s | 55.0 s |
| transparent-reload turns | 3 | 57.7 s | — | 57.3 s | 58.8 s |

- 3 of 12 turns were **transparent reloads**: the #11760 memory policy
  released the resident state between turns (`memory-pressure availMem≈610–730 MB`)
  and the next turn transparently reloaded (+ ~3.5 s vs the warm median) —
  same behavior the #11908 soak measured. The distribution deliberately
  includes them; they are what a user gets on this RAM class.
- Native window (`GENERATE_STREAM from→done`, tid-paired): p50 54.2 s /
  p90 57.5 s — client-side overhead is only **~136 ms** mean; the turn cost is
  entirely in the native prefill+decode.
- Per-turn table: `analysis/joined-runs.json`; raw: `raw/ttft-runs.jsonl`.

### Leg 1b — isolated prefill (8-rung prompt-length ladder)

Method: per-rung app relaunch (attempts 1–2 were poisoned by the self-queueing
background job, finding 5; each fresh boot's self-test generation pre-warms the
model before the rung turn). The regressed quantity is the device's own
in-lock work window `W = producedTok / tokS` from each `GENERATE_STREAM done`
line — it excludes model load and lock queue-wait (verified: 54038 ms
from→done wall vs 54008 ms from tokS on an unqueued turn), so even
queue-delayed rungs yield clean points.

| promptTokens (Qwen3.5, exact) | 92 | 110 | 127 | 146 | 164 | 182 | 201 | 219 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| W (s) | 54.1 | 53.8 | 52.8 | 65.0 | 59.7 | 61.0 | 76.9 | 77.1 |

- Linear fit: `W = 32.4 s + 0.1945 s/tok × P` (r² = 0.78) →
  **marginal prefill ≈ 5.1 tok/s**, effective decode ≤ 7.9 tok/s (intercept
  = 256-token decode + fixed overhead).
- The response is **batch-quantized, not linear**: the boot log shows
  `ELIZA_LLM_N_BATCH=128` — prompts ≤ 127 tokens sit flat at ~53.7 s
  (one prefill batch; decode-dominated), and the window steps up ~23 s once a
  second 128-token batch is needed (P ≥ 146), settling at ~77 s for P ≥ 201.
- Independent cross-check, same GGUF + Vulkan lib family, app stopped
  (`raw/llama-bench-2b.md`): **pp128 3.88 ± 0.27, pp512 8.86 ± 0.01,
  tg128 6.78 ± 0.02 tok/s** (and pp16 0.51 — per-dispatch overhead dominates
  small batches; the historical pp32 = 2.6 sits on the same curve).
- Leg-1a warm anchor agrees across processes: W median 54.07 s (n = 10) at
  P = 92. Fit artifacts: `analysis/prefill-fit.json`.

### Leg 2 — thermal timeline (91.4 min sustained session, 15 s cadence, 363 samples)

Full session span 05:46:35→07:18:00 covering probe + leg 1a + all leg-1b
attempts + leg 4 (`raw/thermal-timeline.tsv`, summary
`analysis/thermal-summary.txt`).

| zone | start | peak | peak at |
|---|---:|---:|---|
| skin_therm1 | 25.9 °C | **42.9 °C** | 06:59:18 (mid v3 sweep) |
| skin_therm2 | 26.5 °C | 42.2 °C | 06:59:18 |
| VIRTUAL-SKIN | 25.3 °C | 38.1 °C | 06:59:18 |
| charger_skin | 27.4 °C | 47.9 °C | 06:59:18 |
| TPU | 30.0 °C | 68.0 °C | 06:56:17 |
| battery | 22.6 °C | 29.2 °C | 07:04:52 |

- **`Thermal Status` stayed 0 for the entire 91-minute session — the OS
  throttling ladder never engaged** under sustained ~55 s/turn Vulkan
  inference. The #11352 "thermally-throttled run" caveat does not reproduce
  under this workload on a cool-start device.
- Cooling devices: `thermal-cpufreq-2` (big cores) engaged briefly in 5/363
  samples (levels 1–7, incl. at 07:13:58 — the leg-4 kill moment);
  GPU cooling never engaged.
- Battery bonus observation: level fell **76% → 70%** by 06:58 *while USB
  powered* (sustained inference outdraws the adb-cable supply), then
  recharged to 76% by session end. This bounds — but does not replace — the
  power-meter row: true discharge rates remain unmeasurable on a tethered
  device.

### Leg 4 — eliza-1-4b tier: **lowmemorykiller kills the foreground app mid-load** (predicted)

Artifact: published device-class 4b Q4_K_M
(`bundles/4b/text/eliza-1-4b-256k.gguf`, 2.95 GB, sha256-verified; header
says `Qwen3.5 4B`, Q4_K_M). Staged as the only `text/*.gguf`, registry +
assignments switched to `eliza-1-4b`, app relaunched, one turn driven while
sampling memory every 5 s (`raw/leg4-runbook.md`, `raw/leg4-meminfo-timeline.tsv`).

Timeline (07:13, `raw/leg4-*`):

| t | event |
|---|---|
| 07:13:13 | boot: policy `ramClass=CONSTRAINED availMem=2387MB`, bionic host up |
| 07:13:36 | 4b load in flight; MemAvailable 1670 MB |
| 07:13:41 | **PSS 3507 MB / RSS 3343 MB / GL mtrack 3220 MB**; MemAvailable 382 MB |
| 07:13:48 | MemAvailable 217 MB (== the policy's own 216 MB lmk threshold) |
| 07:13:58 | **process killed — `ApplicationExitInfo reason=3 (LOW_MEMORY), rss=3.4GB, importance=100 (foreground)`**; MemAvailable rebounds to 3227 MB |
| 07:14:04 | Android auto-restarts the app (which would retry the 4b — kill loop) |

- **The 4b tier does not fit this device class.** 2.95 GB of weights uploaded
  to GPU (GL mtrack 3.22 GB) + app baseline blows past the ~3.2–3.4 GB
  foreground kill line on 5.59 GB RAM — exactly the E2B-4.9GB→lmk finding
  (#11352) and the #11506 forensics, now with the kill captured end-to-end.
- The #11760 pressure-release policy cannot help here: release triggers after
  a load completes, but the kill lands **during** the load, which holds the
  resident lock. A too-big tier dies before any lever can fire.
- The catalog already encodes this: `eliza-1-4b` `minRamGb: 6` vs this
  device's 5.59 GB (5589 MB) — the experiment confirms the floor is real.
- No client reply: the turn's HTTP connection died with the process
  (ECONNRESET). The 2b was restored afterward and verified with a real turn
  ("The capital of Italy is Rome.", `raw/restore-verify.json`); the device
  ends the session in its original state.

## Files

- `raw/turn-driver.mjs`, `raw/leg1-runner.mjs`, `raw/leg1b-v3.sh` — drivers
- `raw/ttft-runs.jsonl` — leg 1a per-turn client captures
- `raw/prefill-runs.jsonl` (v3, the dataset), `raw/prefill-runs-attempt{1,2}.jsonl`
  (aborted attempts, kept for the background-job finding)
- `raw/session-logcat.log.gz` — device logcat for the whole session
  (analyzers read it transparently)
- `raw/thermal-monitor.sh`, `raw/thermal-timeline.tsv`, `raw/thermal-summary.py` — leg 2
- `raw/llama-bench-2b.md` — independent pp/tg cross-check
- `raw/leg4-runbook.md`, `raw/leg4-mem-monitor.sh`, `raw/leg4-meminfo-timeline.tsv`,
  `raw/leg4-exit-info-{before,after}.txt`, `raw/leg4-turn.err`,
  `raw/restore-verify.json` — leg 4 + restore proof
- `raw/analyze.py`, `raw/analyze-prefill.py` → `analysis/` (joined per-turn
  table, prefill fit, thermal summary, exact prompt-token counts)
