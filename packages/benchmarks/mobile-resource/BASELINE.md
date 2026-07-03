# Mobile Resource Workbench — Baselines

This file records the measured on-device baselines that back `budgets.json`.
Until a physical-device run lands, most budgets are `null` ("no baseline yet"):
the gate records them but never fails on them. Ratchet a budget in only after a
stable, repeated measurement on the named device class — never hand-fill a
fabricated number (AGENTS.md §3/§7).

## How a baseline becomes a budget

1. Run the workbench on the target device class for the tier:
   ```bash
   node packages/benchmarks/mobile-resource/run-workbench.mjs \
     --platform=android --tier=eliza-1-2b --device-class=android-phone
   ```
2. Repeat ≥3× on a quiet, thermally-cool device; take the conservative side
   (p50 floor for throughput, p90/peak for ceilings).
3. Write the measured number + device + commit into the table below.
4. Set the matching key in `budgets.json` with ~10–15% headroom, then ratchet it
   down as optimisations land (monotonic-improvement discipline, same as
   `loadperf`).

## Provisional ceilings (NOT measurements)

`maxPeakRssMb` / `maxSteadyRssMb` in `budgets.json` are **provisional limits**
derived from each tier's GGUF footprint plus runtime overhead and the device
memory ceiling — they are caps, not measured values:

| Tier            | GGUF footprint (≈) | Provisional peak-RSS cap |
| --------------- | ------------------ | ------------------------ |
| `eliza-1-2b`    | ~1.3–1.6 GB        | 2600 MB                  |
| `eliza-1-4b`    | ~2.6 GB (Q4_K_M)   | 3600 MB                  |

iOS jetsam kills a foreground app around ~3–4 GB `phys_footprint`; the `4b`
ceiling sits deliberately close to flag tiers that approach it.

## Measured baselines

First real device capture landed for `android-phone` / `eliza-1-2b` (Pixel 6a,
issue #11352). It is a **single, thermally-throttled run** — recorded here and
in `budgets.json → measuredBaselines` (a non-gating block), but deliberately
**not** promoted into the gating `deviceClasses` budgets (which stay `null`)
until ≥3 stable runs on a quiet, cool device land. Full method + gaps:
`.github/issue-evidence/11352-pixel6a-baseline/README.md`.

| Device class   | Tier           | Workload        | decode tok/s        | prefill tok/s | TTFT | peak RSS (chat) | steady RSS (idle) | battery drain | commit |
| -------------- | -------------- | --------------- | ------------------- | ------------- | ---- | --------------- | ----------------- | ------------- | ------ |
| ios-phone      | eliza-1-2b     | single-turn     | —                   | —             | —    | —               | —                 | —             | —      |
| ios-phone      | eliza-1-2b     | sustained-chat  | —                   | —             | —    | —               | —                 | —             | —      |
| android-phone  | eliza-1-2b     | single-turn     | 4.8 warm / 3.1 cold | not isolated  | —    | 2600 MB PSS     | 2500 MB PSS       | —             | #11352 |
| android-phone  | eliza-1-2b     | sustained-chat  | 4.8 warm ¹          | ~5.1 marginal ² | p50 54.3 s / p90 57.7 s ³ | 2600 MB PSS | 2500 MB PSS | — ⁴ | #11352, #11734 |
| android-phone  | eliza-1-4b     | single-turn     | — (killed mid-load) | —             | —    | 3507 MB PSS / GL 3220 MB at kill | n/a | — | #11734 |

Pixel 6a / eliza-1-2b Q4 (1.2 GB GGUF), bionic Vulkan host. Memory dominated by
resident weights (GL mtrack ~2.25 GB constant); per-turn delta only ~100 MB PSS
/ ~70 MB RSS. llama-bench on the same libs: pp32 2.60 t/s, tg32 6.85 t/s.

#11734 adb-measurable rows (Pixel 6a, 2026-07-03 — method + raw data in
`.github/issue-evidence/11734-pixel6a-adb-rows/`):

1. The "4.8 warm" decode figure is a **combined window rate** (256-token decode
   + full prompt prefill over the whole native window); the isolated effective
   decode is ≤ 7.9 t/s (fit intercept; llama-bench tg128 6.78 t/s).
2. Prefill is **batch-quantized** (`ELIZA_LLM_N_BATCH=128`): flat ≤127 prompt
   tokens, ~23 s per extra 128-token batch; 5.1 t/s is the marginal fit over
   92→219 tokens (r² 0.78). llama-bench: pp128 3.88 / pp512 8.86 t/s.
3. TTFT == full-turn latency on this build (the fast path emits the reply as a
   single SSE chunk). n=12 identical-length turns; 3/12 were transparent
   post-release reloads (57.3–58.8 s) — included in the distribution.
4. Battery stays power-meter-gated, but the #11734 thermal log bounds it:
   level fell 76%→70% over ~70 min of sustained inference *while USB-powered*.
   Thermal: Status 0 for the whole 91-min session; peak skin 42.9 °C,
   TPU 68 °C — the OS throttling ladder never engaged.
5. eliza-1-4b (2.95 GB Q4_K_M): **lowmemorykiller kills the foreground app
   during model load** (`ApplicationExitInfo reason=3 LOW_MEMORY`, RSS 3.4 GB)
   ~24 s after boot — the tier's `minRamGb: 6` floor is real on this 5.59 GB
   device. No throughput numbers exist because no turn ever completed.

## Notes / known gaps

- **iOS host-side live sampling** needs the in-app `ElizaIntent.getResourceSnapshot`
  bridge (WebView). The host runner pulls MetricKit (CPU/energy) post-run but
  cannot host-side sample RSS/thermal/battery on iOS — those come from the
  in-app bridge driven through the WebView, or are recorded as "not available".
- **Simulators cannot report real energy or thermal.** Sim runs cover
  RSS / tok-s / TTFT; battery + thermal are physical-device only.
- **Voice loop** (`--workloads=voice-loop`, `MOBILE_RESOURCE_VOICE=1`) depends on
  the on-device voice pipeline (#8785 / #8786) being reachable; otherwise it is
  recorded as skipped.
- **iOS streaming + per-token thermal throttle** (`ios-llama-streaming.ts`) is a
  separate dependency; the workbench profiles the current non-streaming
  Capacitor llama path first. The pure throttle policy is
  `thermalThrottleDecision()` in `@elizaos/plugin-local-inference/services`.
