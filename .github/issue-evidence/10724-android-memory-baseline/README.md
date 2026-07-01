# #10724 — Android on-device memory/CPU baseline (Pixel 6a)

First **systematic profile with numbers** for the Android surface, per the epic's
"measure, then optimize — with numbers, not vibes." This is the *measure* step:
a reproducible on-device baseline of the debug app at first-run, so later
optimizations have a reference and a regression anchor. No code change here.

## Device / build under test

| | |
|---|---|
| Device | **Pixel 6a** (bluejay, Google Tensor), Android, physical (`adb -s 27051JEGR10034`) |
| RAM | `MemTotal 5.72 GB`, `MemAvailable 1.32 GB` at test time (device is memory-pressured) |
| App | `ai.elizaos.app` debug (`app-debug.apk`, built 2026-06-30) |
| State | fresh install, first-run onboarding (no agent started, no inference) |

> Device clock is skewed (~March); package `lastUpdateTime` reflects that, not the
> build date. The APK is the 2026-06-30 debug build.

## Numbers — `dumpsys meminfo ai.elizaos.app`, App Summary (onboarding, idle)

| Bucket | PSS (MB) | RSS (MB) |
|---|---:|---:|
| **TOTAL** | **220** | **318** |
| Graphics | 52 | 52 |
| System | 56 | — |
| Private Other | 42 | — |
| Native Heap | 29 | 30 |
| Code (mmap) | 25 | 160 |
| Java Heap | 14 | 30 |
| Stack | 2 | 2 |

- **App idle CPU: 0%** (`dumpsys cpuinfo` → `0% user + 0% kernel` for the pid at
  onboarding) — no idle burn on the first-run screen.
- **No crash / ANR / FATAL** in logcat across the onboarding walkthrough
  (`How should Eliza run?` → `Where should it think?`); PSS held 215–220 MB.

## Observations (candidates for the *optimize* phase — not yet fixes)

1. **Graphics is the single largest bucket (52 MB PSS)** for a near-static
   onboarding screen (solid background + two cards). Worth confirming whether the
   WebView GPU surface / compositing layers are larger than the content warrants,
   especially against `MemAvailable ~1.3 GB` on a 6 GB device.
2. **220 MB PSS before any agent or inference starts** is the frontend+shell
   floor; the local-LLM epic (C) load numbers stack on top of this, so the
   onboarding floor is the right thing to drive down first.
3. `Code` RSS 160 MB (25 MB PSS) reflects the large native lib set mapped early;
   a lazy-load audit (which `.so` are needed at onboarding vs after model pick)
   could defer some of it.

## Reproduce

```bash
D=27051JEGR10034
adb -s $D install -r -d app-debug.apk
adb -s $D shell monkey -p ai.elizaos.app -c android.intent.category.LAUNCHER 1
adb -s $D shell dumpsys meminfo ai.elizaos.app      # App Summary table
adb -s $D shell dumpsys cpuinfo | grep elizaos      # per-pid CPU
adb -s $D shell cat /proc/meminfo | grep MemAvail   # device pressure
```

## Artifacts

- `onboarding-step1.png` — "How should Eliza run?" (Cloud / This device)
- `onboarding-step2.png` — "Where should it think?" (Cloud / On-device inference)
- `onboarding-walkthrough.mp4` — screenrecording of the step-through (no crash)
