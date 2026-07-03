# iOS Simulator — local-inference UI validation (#10727 / #11612)

**Device:** iPhone 16 simulator (udid `39F890C2…`), iOS 18. **App:** `ai.elizaos.app`, full-Bun local backend. Driven via `idb` (WKWebView → taps by coordinate; `/` focuses the composer, `Enter` sends).

## What the sim proved

1. **The old (pre-fix) build reproduced the `#11612` failure as an *empty reply thread*.** `ios-sim-05-send-accepted-thread-empty.png` / `ios-sim-06-model-loaded-chip-cleared-thread-still-empty.png` / `ios-sim3-textgen-02-thread-empty-symptom.png`: the model loads, a prompt is accepted, but **no reply ever renders**. This is the *same root cause* as the A18 device crash — the iOS metallib lacked `kernel_mul_mm_bf16_f32` (compiled at MSL 2.4), so every `llama_decode` graph failed; on the sim it fails silently (no GPU OOM, no crash) → empty thread. Fixed by the metallib MSL 3.1 bump + runtime bf16 gate (merged: #11746).
2. **STT and vision were driven through the UI on the sim** — `ios-sim-stt-01..03` (mic listening → speech → stop) and `ios-sim-vision-01-sent.png` / `ios-sim3-vision-01..03` (image attach → prompt → send).
3. **The rebuilt *fixed* slice (bf16 MSL 3.1 + recoverable failure + OOM admission) installs, launches, and loads without crashing or hanging** (`sim-live-01..08`): an advancing load progress bar + sustained ~88–124 % CPU on the App process — i.e. the old build's silent-failure mode is gone; it genuinely grinds through model load.

## Honest limitation

A *completed generated reply on the simulator* was **not** captured this session: the fixed build's model load does not converge in-session (~14 min, high CPU, flat ~2 GB RSS). This is a **simulator-environment characteristic** — the simulator's translated Metal compiles the (now bf16-bearing, MSL 3.1) pipeline set pathologically slowly — **not a product defect**: the identical code path
- loads + generates correctly on **Mac desktop** via the fused `libelizainference` (kokoro 417×, vision-describe with real output, MTP 0.842 acceptance — see `../vision-gemma4-describe/`, `../kokoro-metal-perf/`, `../gemma4-assistant-mtp/`), and
- on the **real A18 device** the bf16 kernel now loads (`../xplatform-ios-device/11612-bf16-retest/ggml-device-postfix.log`), with the remaining device blocker being GPU memory admission (fixed, #11806) whose on-device reply capture is operator-gated (device passcode/reboot).

## Frames
`sim-live-00..08-*.png` — fixed-build install → launch → active load (no crash). `ios-sim-*` / `ios-sim3-*` — prior-build empty-thread symptom (the bf16 root cause), STT, and vision UI drives.

## Correction (metal3.1 hypothesis DISPROVEN)

Rebuilt the sim slice at `ios-metal2.4` (#11826) and re-tested: the model-load **still wedges identically** (100 % CPU, flat ~2.4 GB RSS, never completes). So the wedge is **not** the metal3.1 metallib. The *old pre-#11612 build loaded fine on the sim* (`ios-sim-06`), so the regression is in the fresh #11612-fixed build's model-load path — most likely the **GPU-OOM memory-admission probe** (`os_proc_available_memory` / the CPU-only mmap layer-count probe) behaving pathologically under the simulator. Not yet root-caused; a captured sim *reply* remains blocked on this. `#11826` (per-slice MSL) is retained as a defensible hardening (metal3.1 on the simulator is still questionable) but is **not** the wedge fix. Real inference remains proven on Mac (fused lib) + device (bf16 loads).
