# #11734 — Pixel 6a device-exact memory-policy acceptance soak (refs #11760)

Hardware-lab acceptance row for the on-device inference memory policy that
merged in PR #11822 (RAM-class caps + idle unload + pressure release of the
resident inference state). The parent evidence dir
(`../README.md`) proved the policy on an arm64 emulator with a forced
`constrained` profile; **this run is the device-exact soak on real Pixel 6a
hardware** — real Mali GL-mtrack residency, this device's real lmkd tables,
default policy knobs (no debug-prop overrides).

## Device + build

| | |
| --- | --- |
| Device | Pixel 6a (`bluejay`), serial `27051JEGR10034`, MemTotal 5589 MB → measured RAM class `CONSTRAINED` |
| Build | worktree `device-11760` @ merge commit `35f61d1f` (PR #11822 merge) |
| APK | `app-debug.apk`, 491398780 bytes, md5 `b260d86065624228abc5ddc6f16bbe53` |
| Install | `lastUpdateTime=2026-07-03 05:06:21`; on-device `base.apk` md5 verified **identical** to the worktree APK (`raw/run2-pkg-verify.txt`) |
| Process | pid 30062 for every sample of the entire window — the process never died |

Provenance note: before this run a sibling session had force-installed a
**foreign 413 MB APK** onto this device (md5 `8d4a34ff…`, installed 04:50:25).
That contamination was detected by md5 mismatch and evicted by reinstalling
this worktree's policy build; the md5 verification above is post-reinstall.

## Policy-active markers (fresh app relaunch, logcat from boot)

```
07-03 05:10:55.221 I ElizaAgent: inference memory policy: ramClass=CONSTRAINED totalMem=5589MB availMem=2371MB lmkThreshold=216MB nCtx=4096 idleUnloadMs=300000
07-03 05:10:55.228 I ElizaBionicInfer: bionic inference host listening on abstract UDS "eliza_bionic_infer_v1" (default bundle /data/user/0/ai.elizaos.app/files/eliza-1/bundle, ramClass=CONSTRAINED, nCtx=4096, idleUnloadMs=300000)
```

## Methodology

- App relaunched fresh (`am force-stop` → launcher intent), kept foregrounded
  on-screen the whole window (`topResumedActivity=ai.elizaos.app/.MainActivity`
  verified at leg boundaries; `svc power stayon usb`).
- Real local-inference turns via `POST /v1/chat/completions` through
  `adb forward tcp:31337` — every reply carries the
  `localInference.provider=mobile-local-direct-reply` block
  (`raw/run2-soak-driver.sh`, transcript in `raw/run2-soak-turns.log`).
- Memory timeline: pid + `/proc/meminfo` MemAvailable every 5 s; full
  `dumpsys meminfo` (TOTAL PSS / TOTAL RSS / GL mtrack / EGL mtrack /
  SWAP PSS) every 30 s (`raw/run2-mem-monitor.sh` →
  `raw/run2-meminfo-timeline.tsv`).
- Full logcat captured from app boot (`raw/run2-logcat-full.log.gz`), filtered
  slice in `raw/run2-logcat-relevant.txt`.
- `dumpsys activity exit-info ai.elizaos.app` snapshotted before (05:11:20)
  and after (05:34) the window.

### Legs

1. **Warmup** 05:11:58 — cold first load + reply: **95 s** (`latencyMs=95375`).
2. **Soak** 05:13:33 → 05:25:39 (**726 s ≈ 12.1 min**, ≥10 min required):
   10 real turns, all correct local replies, wall 52–58 s each (median 54 s).
3. **Idle leg** 05:25:39 → 05:32:39 (420 s, no turns, app foregrounded).
4. **Reload turn** 05:32:39 — reply arrived in **58 s**.
5. **Bonus idle-lever leg** ~05:34 → 05:37: model resident again after the
   reload turn, no further turns, watched for the next release.

## Results

### Release → reload cycles (4 releases, all logged by `ElizaBionicInfer`)

| # | release time | trigger (logcat) | resident before → released after (30 s samples) | next turn (transparent reload) |
| --- | --- | --- | --- | --- |
| 1 | 05:15:42 | `memory-pressure: availMem=614MB threshold=216MB` | GL 1.60 GB → (reload caught mid-flight: 05:16:02 PSS 2.55 GB, GL 1.05 GB) | turn 3, **58 s**, correct reply |
| 2 | 05:20:40 | `memory-pressure: availMem=721MB` | PSS 1.91→**0.29 GB**, GL 1.61→**0.05 GB**, MemAvailable 676→**2023 MB** | turn 7, **58 s**, correct reply |
| 3 | 05:25:40 | `memory-pressure: availMem=608MB` (1 s after last soak turn) | PSS 2.16→0.28 GB, GL 1.60→0.05 GB; **held released for the entire 7-min idle leg** (all 14 samples: PSS 0.28–0.29 GB, GL 0.05–0.06 GB, MemAvailable 1898–2009 MB) | RELOAD turn, **58 s**, correct reply; 05:33:10 sample restored to PSS 2.16 GB / GL 1.60 GB |
| 4 (bonus) | 05:36:40 | `memory-pressure: availMem=646MB` | PSS 1.78→0.28 GB, GL 1.49→0.05 GB, MemAvailable 646→**1943 MB** within 10 s (`raw/run2-idle-lever-timeline.tsv`) | n/a (end of window) |

### Numbers

- **Peak PSS 2.55 GB** (05:16:02, mid-reload); **peak GL mtrack 1.61 GB**;
  loaded steady state PSS 1.9–2.3 GB / GL mtrack 1.49–1.61 GB.
- **Release drop:** −1.87 GB PSS, −1.56 GB GL mtrack per release; device
  MemAvailable jumps ~0.7 GB → ~2.0 GB.
- **Reload cost:** turns immediately after a release ran **58 s** vs 52–58 s
  warm (median 54 s) — the transparent reload adds ≈ 4 s to a turn, vs the
  95 s cold first load.
- **Min device MemAvailable in window: 579 MB** — never approached the 216 MB
  lmkd threshold while the policy was releasing proactively.

### lmkd survival (device-exact)

During the window (05:11:20–05:32:42) this device's lmkd fired
**48 "low watermark is breached" kills across 27 distinct packages**
(Twitter, Photos, Gmail, Chrome subprocesses, carrier services, …) —
`ai.elizaos.app` was killed **0 times** (`raw/run2-logcat-relevant.txt`).

### exit-info acceptance

`raw/run2-exit-info-presoak.txt` vs `raw/run2-exit-info-postsoak.txt`:
**byte-identical** (modulo capture header) — **zero new process exits of any
kind** during the window. No `reason=3 (LOW_MEMORY)` of the main process
exists anywhere in the history; the only main-process exits are this
session's own `USER REQUESTED` force-stops and `PACKAGE UPDATED` installs.
The pre-existing WebView `sandboxed_process0` LOW_MEMORY entries
(2026-03-13, 2026-07-02 12:35) predate the window and are the documented
baseline — no new ones were added.

## Key device-exact finding

On real Pixel 6a hardware the **pressure lever dominates**: with the model
resident (~1.9–2.3 GB PSS), ambient MemAvailable sits at 580–1090 MB —
inside the CONSTRAINED pressure line of
`lmkThreshold + 512 MB = 728 MB` (`InferenceMemoryPolicy.shouldReleaseOnAvailMem`)
— so the 30 s policy tick releases the resident state between turns whenever
availMem dips below 728 MB. All four observed releases were
`memory-pressure`; the 300 s **idle lever never got to fire** because
pressure always preempted it (including in the bonus leg armed specifically
for it). The cost of this aggressiveness is measured and small (≈ +4 s per
turn after a release); the benefit is 1.9 GB PSS / 1.5 GB GL mtrack handed
back to the system between turns — which is exactly why lmkd reaped 27 other
packages and never ours.

## Verdict: PASS

- ≥10 min foregrounded soak of real local inference on device: **yes** (12.1 min, 10/10 correct replies).
- Release confirmed in logcat + GL-mtrack/RSS drop in the timeline: **yes, 4×** (release lines + correlated −1.56 GB GL mtrack drops).
- Transparent reload after release, reply arrives: **yes, 3×** (58 s turns, correct replies).
- No new LOW_MEMORY kill of the main process during the window: **yes** (exit-info byte-identical; pid 30062 the whole run; lmkd killed 48 other processes, ours 0).

## Honest limitations

- **The idle-unload lever (300 s) was not exercised device-exact** — the
  pressure lever structurally preempts it on this device profile (see key
  finding). Idle-unload firing is covered by the emulator soak in
  `../README.md` (forced 120 s timeout, real release observed) and the JVM
  unit tests around `ElizaBionicInferenceServer`/`InferenceMemoryPolicy`.
- A predecessor session's partial run (interrupted after ~6 min) produced the
  non-`run2-` files in `raw/` (03:23–03:54: `exit-info-before*.txt`,
  `meminfo-before-oldbuild.txt`, `pkg-before.txt`, `meminfo-timeline.tsv`,
  `soak-driver.log`, `soak-turns.log`, `logcat-full.log.gz`). They are
  supplementary; this run restarted the measurement cleanly and supersedes
  them. Its warmup (97.8 s) and turn latencies (58.8 s) match this run.
- Turn latencies are end-to-end API wall times (prompt processing + 20-token
  generation on Vulkan/Mali at nCtx=4096), driven via `/v1/chat/completions`
  rather than the chat UI; the render path is not part of this measurement.
- The 30 s meminfo cadence means release/reload edges are located to ±30 s in
  the TSV; the logcat lines give the exact timestamps.
- Host and device clocks agreed to within ~1 s during this window (checked at
  setup); timeline times are host time, logcat times are device time.

## Files

| file | what |
| --- | --- |
| `raw/run2-pkg-verify.txt` | build provenance: foreign-APK contamination + md5-verified reinstall |
| `raw/run2-soak-driver.sh`, `raw/run2-mem-monitor.sh` | the exact driver + sampler used |
| `raw/run2-soak-turns.log` | full turn transcript (every `localInference` block, timings, leg markers) |
| `raw/run2-meminfo-timeline.tsv` | 5 s pid/MemAvailable + 30 s PSS/RSS/GL-mtrack timeline, 05:11:53–05:34:18 |
| `raw/run2-idle-lever-timeline.tsv` | bonus-leg 10 s timeline around release #4 |
| `raw/run2-exit-info-presoak.txt` / `raw/run2-exit-info-postsoak.txt` | acceptance snapshots (byte-identical) |
| `raw/run2-logcat-relevant.txt` | filtered logcat: policy markers, all release lines, every lmkd kill |
| `raw/run2-logcat-full.log.gz` | full logcat from app boot through the reload turn |
| `raw/run2-logcat-idle-lever.log.gz` | full logcat of the bonus idle-lever leg |
| `raw/` (non-`run2-` files) | predecessor's interrupted partial run (supplementary) |
