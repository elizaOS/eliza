# Issue #15744 Pendant Performance and Soak Report

## Scope

Branch `perf/pendant-latency-soak` is based on `b9f707965de`. This lane adds
privacy-safe latency instrumentation, deterministic replay and soak harnesses,
bundle profiling, reconnect/ASR cleanup, and LP3 battery/thermal evidence
procedures. It does not edit integration-owned transcript, insight, or session
APIs.

## Implementation

### Latency contract

`performance/pendant-latency.ts` defines a versioned contract with numeric-only
correlation fields. The runtime marks BLE notification, reassembly, decode,
VAD speech/pending, WAV encode, ASR request/resolve, and segment dispatch. It
also reserves downstream follower, insight, renderer, pause, resume, and drop
marks for their owning lanes.

The trace emits these measured spans where both ends are available:

- BLE notification to reassembly
- reassembly to decoder entry
- decoder execution
- decode to first VAD speech
- WAV encode
- ASR request to resolve
- ASR resolve to segment dispatch
- BLE notification to segment dispatch
- VAD speech to pending
- VAD pending to ASR resolve

Marks contain only monotonic time, frame/utterance sequence, byte/sample counts,
codec, and numeric queue/drop data. Transcript text, audio bytes, device names,
addresses, and stable identifiers are excluded. Recent marks are bounded, and
per-frame/per-utterance state is released on completion or disconnect.

The user-visible hardware targets remain evidence targets, not synthetic gates:

- speech end to pending UI: at most 100 ms
- speech end to ASR transcript: at most 1,500 ms
- speech end to follower surface: at most 1,750 ms
- speech end to insight update: at most 2,500 ms

### Replay benchmark

The replay benchmark runs checked-in non-speech PCM fixtures and a checked-in
Opus silence fixture through the production reassembler, decoder, VAD, WAV,
collector, and dispatch timing path. Opus and PCM decoder numbers are separate.
The benchmark reports architecture/host metadata, raw p95 values, contract
metrics, budgets, packet drops, and corrupted Opus frames. Percentiles use the
nearest-rank definition, including for small samples.

### Soak, backpressure, and lifecycle checks

The soak harness keeps its audio queue bounded at 32 frames and uses drop-oldest
backpressure. CI deliberately overloads the consumer. The 30-minute profile
keeps sustainable steady-state production but injects one bounded overload
burst every 30 seconds, ensuring the long soak also exercises backpressure.
Both profiles inject accounted transport duplicates/drops, rotate codecs,
exercise pause/resume and visibility changes, reconnect repeatedly, and keep up
to three asynchronous utterances pending.

Gated invariants cover decoder create/free balance, listener add/remove balance,
timer cleanup, queue bounds, duplicate/drop accounting, unique gap-free segment
IDs, backpressure, concurrent pending work, reconnect, pause/resume, and
visibility. Heap, RSS, and event-loop stalls are recorded as evidence only,
because JavaScript GC scheduling makes a hard one-run memory delta gate noisy.

### Runtime reconnect cleanup

Disconnect now aborts in-flight ASR and invalidates queued finalizers so a late
ASR response cannot dispatch a transcript or move the UI out of idle after the
user disconnects. Remote disconnect releases the decoder, queued PCM, detector,
latency correlation state, and transport listeners, while retaining the
connection object for a clean reconnect. Intentional transport teardown first
detaches the remote-disconnect callback to prevent recursive cleanup or retry
generation invalidation.

### Lazy loading and startup

The Android native transport wrapper now loads only after native Android
transport selection. Disconnect during module load is cancellation-safe and the
underlying transport is torn down if loading/connection resolves late. The
barrel retains type-only native exports without statically importing the runtime
class.

The isolated split build moved the native transport out of the entry and reduced
that entry by 2,711 bytes. The full app graph was built for both this tree and an
exact `b9f707965de` baseline after building required workspace packages. The
current graph has zero Opus/native BLE classified bytes in the initial closure,
a 2,196-byte lazy native wrapper, and an 89,228-byte lazy Opus chunk. Net initial
graph delta is +6,878 bytes, below the 25 KiB budget. Baseline native-byte output
counts the complete initial chunk containing the native wrapper, not the
wrapper's isolated byte size.

## Validation results

### Targeted tests and static checks

- Pendant tests: 5 files, 49 tests passed.
- Biome check on changed pendant sources: passed.
- Android capture shell script `bash -n`: passed.
- `git diff --check`: passed.
- Full app production build: passed after prerequisite `@elizaos/cloud-routing`
  and `@elizaos/shared` workspace builds.
- Package-wide UI typecheck remains blocked in unchanged
  `src/testing/e2e-runner/fixture-bundle.ts:143` by TS2321/TS2769. The exact
  `b9f707965de` base worktree reproduces the same error; no changed pendant file
  appears in that diagnostic.

### Replay, 100 iterations

Artifact: `15744-pendant-lightphone-performance-benchmark.json`

- Overall: pass
- reassembly p95: 0.003957 ms
- Opus decode p95: 0.046421 ms
- PCM decode p95: 0.004408 ms
- deterministic client pipeline p95: 5.050046 ms
- corrupted Opus frames: 0
- dropped packets: 0

These are host replay measurements on Linux x64. The ASR stage is a deterministic
local client delay in this harness, not physical LP3 speech-to-transcript time.

### CI soak

Artifact: `15744-pendant-lightphone-performance-soak-ci.json`

- Overall: pass
- duration: 15.06 seconds
- notifications: 104,046
- decoded frames: 11,114
- backpressure events: 92,833
- maximum queue depth: 32
- maximum pending utterances: 3
- duplicate/dropped segment IDs: 0/0
- decoders created/freed: 5/5
- listeners added/removed: 10/10
- timers started/cleared: 4/4
- reconnects: 4
- event-loop stalls over threshold: 0

### 30-minute soak

Artifact: `15744-pendant-lightphone-performance-soak-30m.json`

- Overall: pass
- duration: 1,800.053 seconds
- notifications / decoded frames: 711,505 / 709,349
- controlled overload bursts / backpressure events: 59 / 2,122
- maximum queue depth: 32
- maximum pending utterances: 3
- dispatched segments: 17,732
- duplicate/dropped segment IDs: 0/0
- decoders created/freed: 30/30
- listeners added/removed: 60/60
- reconnects / pause-resume cycles / visibility changes: 29 / 29 / 29
- timers started/cleared: 4/4
- event-loop stalls over threshold: 0
- heap delta / maximum heap: +5,852,792 / 35,992,736 bytes
- RSS delta / maximum RSS: +61,911,040 / 128,057,344 bytes

All gated lifecycle, accounting, backpressure, queue, and segment-integrity
checks passed. The positive process memory deltas are disclosed rather than
called leak-free: Node/V8 reserve and JIT behavior are not a physical Android
heap profile, and this harness does not force GC. Balanced decoder/listener/timer
counts and bounded queues show no retained resource-count growth in the modeled
pipeline; LP3 meminfo sampling remains required.

### Bundle profile

Artifacts:

- `15744-pendant-lightphone-performance-bundle.json`
- `15744-pendant-lightphone-performance-bundle-isolated.json`

Results:

- Overall full graph: pass
- initial graph delta: +6,878 bytes, budget +25,600 bytes
- current initial Opus bytes: 0
- current initial native BLE classified bytes: 0
- isolated transport entry: 9,298 to 6,587 bytes, delta -2,711 bytes

## Android, battery, and thermal status

The Android walk capture script records package paths/hashes plus periodic LP3
battery, meminfo, thermal, and CPU samples, then captures batterystats,
Bluetooth/radio state, filtered logcat, and an optional bugreport. Android
thermalservice describes LP3 sensors only. Pendant BAS percentage and pendant
case temperature must be recorded separately.

Known cell facts:

- installed cell: 651723, 1S 3.7 V, 150 mAh
- devkit firmware fast-charge comment: 100 mA, approximately 0.67 C
- devkit discharge profile comment: inherited 1S 250 mAh, not calibration proof
  for the installed cell

No physical full discharge was run in this lane because the physical LP3 and
pendant are owned by the device/E2E lane. The provisional estimate is 2.5-6.5
hours only if average load is 20-50 mA and a 15% capacity margin is applied.
Average load is not measured, so this is not a product claim. The dedicated
battery/thermal runbook requires at least three full discharges before replacing
that estimate with median/min/max observed runtime.

## Limitations and handoff

- Physical speech-end, ASR, follower, and insight latency on LP3 remains pending.
- No physical pendant battery runtime or pendant case temperature exists yet.
- BAS percentages remain trend evidence until the 150 mAh cell curve is
  calibrated by the firmware/device lane.
- The synthetic soak validates bounded queues, accounting, and lifecycle
  invariants. It does not prove Android BLE stack or RF behavior.
- The 10-minute LP3 walk and three-trial discharge should run only after the
  device lane hands over hardware. A read-only Bleak smoke still competes as a
  BLE central and must not run while LP3 owns the link.
- Downstream follower/insight/session instrumentation remains reserved for the
  integration owners; this branch intentionally does not modify those APIs.
