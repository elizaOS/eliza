# #11352 — Pixel 6a local-model resource baseline (eliza-1-2b Q4)

First **post-model-load** on-device resource capture for the epic #10724 Scope C
(local-model RAM / tok-s on real devices). The prior committed device numbers
(#10724 `android-memory-baseline`, PSS 220 MB) were the **shell floor** —
captured before any agent or inference loaded. This adds the numbers with the
model resident and during generation.

These are recorded as **documented baselines**, not PR-gating budgets. The
`deviceClasses.*` entries in `budgets.json` stay `null`; the numbers below live
in a non-gating `budgets.json → measuredBaselines` block plus `BASELINE.md`.
Reason: this is a **single, thermally-throttled run** — the issue itself says
gate only "until per-device baselines are stable," and one run is not stable
enough to fail a PR on. Promotion to a gate needs multi-run stability on a
quiet, cool device.

## Device / build under test

| | |
|---|---|
| Device | **Pixel 6a** (Google Tensor GS101, Mali-G78 MP20), Android 16, physical |
| RAM | ~5.7 GB usable (memory-constrained class) |
| Model | **eliza-1-2b Q4** — 1.2 GB GGUF |
| Inference host | **bionic Vulkan host** (native arm64, GPU-resident weights) |

## Memory — `adb shell dumpsys meminfo <pkg>`

`glMtrack` is the GL mtrack line = Vulkan model weights resident in GPU memory.

| State | TOTAL PSS | TOTAL RSS | GL mtrack | SWAP PSS |
|---|---:|---:|---:|---:|
| **Idle** (agent up, model resident, no active turn) | **2.50 GB** | 2.39 GB | 2.25 GB | 195 MB |
| **Chat-active** (during generation) | **2.60 GB** | 2.46 GB | 2.25 GB | 217 MB |
| **Delta** (active − idle) | ~100 MB | ~70 MB | 0 | +22 MB |

- Memory is **dominated by resident weights**, not per-turn work: GL mtrack holds
  ~2.25 GB constant idle→active, and the active-minus-idle delta is only
  ~100 MB PSS / ~70 MB RSS.
- Measured idle total RSS (2.39 GB / 2390 MB) **already exceeds** the provisional
  `maxSteadyRssMb` cap (2300 MB) for this class — concrete evidence that the
  provisional GGUF-derived ceilings must not be promoted to a gate before real
  multi-run baselines exist.

## Throughput — decode tokens/sec

| Source | Metric | tok/s |
|---|---|---:|
| bionic Vulkan host (`GENERATE_STREAM`) | decode, **warm** | **4.8** |
| bionic Vulkan host (`GENERATE_STREAM`) | decode, **cold** (first turn incl. model load) | ~3.1 |
| `llama-bench` (same libs) | pp32 (prefill) | 2.60 |
| `llama-bench` (same libs) | tg32 (decode) | 6.85 |

## Capture method

- **Memory:** `adb shell dumpsys meminfo <pkg>` at two states — idle (agent
  booted, model loaded, no in-flight turn) and chat-active (sampled during a
  live generation). TOTAL PSS/RSS + the GL mtrack and SWAP PSS lines read
  directly from App Summary.
- **Warm/cold decode tok/s:** timed `GENERATE_STREAM` round-trips through the
  bionic Vulkan host — cold = first turn (includes model load), warm = steady
  subsequent turns.
- **llama-bench:** run against the same Vulkan libs the host loads, `pp32` /
  `tg32`, as an independent throughput cross-check.

## Finding — model tier selection on the 6a class

The **eliza-1-2b E2B variant (4.9 GB)** tripped the Android **lowmemorykiller**
on this 5.7 GB device — the OS reclaimed the app under memory pressure. **Q4
(1.2 GB)** runs resident without being killed and is the correct 6a-class tier.
Larger tiers need a higher-RAM device class.

## Still hardware-gated (NOT captured here)

Everything below needs the self-hosted arm64 device pool and/or a power meter,
and is genuinely not represented above. The issue stays **open** for these:

- **Battery / power draw** for idle / chat / voice / background-scheduled-task —
  power-meter-gated (physical-device-only per the issue). This is the primary
  blocker to closing #11352.
- **TTFT distribution** — only a single run exists; no p50/p90 distribution.
- **Prefill tok/s (isolated)** — not separated from decode in this capture.
- **Thermal timeline** — no per-sample `getCurrentThermalStatus` log over a
  sustained run; the run was thermally throttled but not traced.
- **iOS** — no iPhone / iOS-sim numbers for either tier.
- **eliza-1-4b tier** — not captured on any device class.
- **Multi-run stability** — need ≥3 quiet, cool-device runs (p50 floor for
  throughput, p90/peak for ceilings) before any of these is promoted from the
  `measuredBaselines` block into a gating `deviceClasses` budget.

## Files touched

- `packages/benchmarks/mobile-resource/budgets.json` — added non-gating
  `measuredBaselines` block (gate `deviceClasses` unchanged, still `null`).
- `packages/benchmarks/mobile-resource/BASELINE.md` — measured-baselines table
  row for android-phone / eliza-1-2b.
