# Issue #15744 Pendant Performance Evidence Runbook

Use these commands after building the current tree and installing the app build
under test. The harness artifacts are JSON and privacy-safe: no transcript,
audio bytes, device identifiers, or PII.

```bash
bun run --cwd packages/ui pendant:perf -- --out ../../.github/issue-evidence/15744-pendant-lightphone-performance-benchmark.json
bun run --cwd packages/ui pendant:soak:ci -- --out ../../.github/issue-evidence/15744-pendant-lightphone-performance-soak-ci.json
bun run --cwd packages/ui pendant:soak -- --minutes 30 --out ../../.github/issue-evidence/15744-pendant-lightphone-performance-soak-30m.json
bun run --cwd packages/ui pendant:bundle-profile -- --build --baseline-dist <develop-app-dist> --out ../../.github/issue-evidence/15744-pendant-lightphone-performance-bundle.json
```

`--baseline-dist` is optional but preferred. The profiler compares current
initial bytes against that baseline and gates only the delta, plus hard `0`
initial bytes for Opus and native BLE. If the current branch build fails, keep
the generated failure JSON; do not substitute a dist from another worktree.

## User-visible latency budget

The code proxy for physical speech end is `vad.pending`. Actual physical speech
end must be measured manually with synchronized video/audio during the LP3 walk.
The numeric `utteranceSeq` in the transcript event correlates downstream marks
without recording transcript, audio, device identifiers, or PII.

- physical speech end / `vad.pending` to pending UI: target `<= 100 ms`
- physical speech end / `vad.pending` to ASR-resolved transcript: target `<= 1,500 ms`
- physical speech end / `vad.pending` to follower surface: target `<= 1,750 ms`
- physical speech end / `vad.pending` to insight update: target `<= 2,500 ms`

The hardware targets are evidence-only until real LP3 samples establish stable
variance. Replay CI gates deterministic packet, decode, VAD/WAV, local client,
dispatch, lifecycle, queue, and integrity budgets instead.

For a real Light Phone III / Android 10-minute walk:

```bash
APP_ID=ai.elizaos.app \
OUT=.github/issue-evidence/15744-pendant-lightphone-performance-android-walk \
DURATION_SECONDS=600 \
SAMPLE_INTERVAL_SECONDS=60 \
bash .github/issue-evidence/15744-pendant-lightphone-performance-android-walk.sh
```

The full pendant-cell discharge, LP3 battery, and temperature procedure is in
`15744-pendant-lightphone-battery-thermal-runbook.md`. Physical hardware is
owned by the device/E2E lane. Do not flash, pair a competing BLE central, or
start a discharge until that lane hands the LP3 and pendant over.

Manual review checklist:

- Benchmark JSON: `pass: true`, Opus and PCM decode measurements are separate, `corruptedOpusFrames: 0`, host/arch present, budgets present, framing-dependent cases called out.
- Soak JSON: stable counters pass; `backpressureEvents > 0`, `maxPendingUtterances >= 2`, duplicate/dropped segment IDs are `0`, listener/decoder/timer lifecycles are balanced, heap/RSS and event-loop stalls are evidence-only.
- Bundle JSON: current build result only. Passing profile has `opusInitialBytes` and `nativeBleInitialBytes` at `0`, a baseline/current initial-byte delta within budget, and lazy Opus/native BLE chunk identification. A build-blocked profile must preserve `reason`, `knownBlocker`, and `buildOutputTail`.
- Android walk: package dump confirms current build; logcat shows pendant activity; meminfo, thermal, CPU, battery, and radio files are inspected.

Latest local validation run:

- Targeted pendant suite passed: 5 files, 49 tests. This includes reconnect
  teardown and suppression of transcripts from ASR that resolves after a user
  disconnect.
- `pendant:perf -- --iterations 100`: pass. Reassembly p95 `0.003957 ms`, Opus
  decode p95 `0.046421 ms`, PCM decode p95 `0.004408 ms`, deterministic
  pipeline p95 `5.050046 ms`, and corrupted Opus frames `0`.
- `pendant:soak:ci`: pass. Backpressure events `92,833`, maximum pending
  utterances `3`, duplicate/dropped segment IDs `0/0`, listener lifecycle
  `10/10`, decoder lifecycle `5/5`, reconnects `4`, and event-loop stalls `0`.
- Full app build/profile against a freshly built `b9f707965de` baseline: pass.
  Initial graph delta `+6,878 bytes`, under the `25 KiB` cap. Opus and native
  BLE bytes in the current initial graph are `0`; the native wrapper is a
  `2,196-byte` lazy chunk and Opus is an `89,228-byte` lazy chunk. The baseline
  initial chunk contained the native BLE wrapper. Chunk-level baseline byte
  classification counts the whole containing chunk, not just wrapper bytes.
- Isolated transport split: entry `9,298 -> 6,587 bytes` (`-2,711 bytes`) and
  native transport moved into a separate lazy chunk.
- The uninterrupted 30-minute soak passed: 711,505 notifications, 709,349
  decoded frames, 59 controlled overload bursts, 2,122 backpressure events,
  queue depth capped at 32, 17,732 gap-free unique dispatched segments,
  decoder lifecycle `30/30`, listener lifecycle `60/60`, reconnects `29`, and
  event-loop stalls `0`. Heap delta was `+5,852,792 bytes` and RSS delta was
  `+61,911,040 bytes`; those process-memory values are evidence-only and are
  not presented as an Android leak result.
