# #9649 item 2 — agent-silent AEC fast-path skip · evidence

Salvages the "agent-silent fast-path skip" idea from the stale
`opt/ios-mac-aec-9583` branch, forward-ported onto develop's **current**
`audio-frame-consumer.ts`. (The other two item-2 ideas already landed: the
per-platform delay seed via #9653, and the residual suppressor via a concurrent
PR — both confirmed on develop, so only this third idea remained.)

## What changed

`pushDecodedFrame` previously called `NlmsEchoCanceller.process(pcm, … ??
NO_ECHO_REFERENCE)` on **every** mic frame — even while the agent was silent,
running the full 256-tap × 320-sample inner loop against an empty far-end for
no benefit. It now calls a `cancelEcho()` helper that returns the mic frame
**verbatim** when the reference provider returns null/empty (agent not playing)
while still clearing cheap silent-reference state so stale playback history
cannot leak into the next active frame. A new `echoFramesCancelled` counter
exposes how often the canceller actually ran.

## Correctness (deterministic unit test, no audio tooling)

`audio-frame-consumer.test.ts` → "skips the canceller entirely while the agent
is silent (#9649 fast path)":
- Reference returns far PCM for the first 40 frames, then null.
- `echoFramesCancelled === 40` (only playback frames were processed).
- Every silent-era output frame is **bit-identical** to its input — proving
  `process()` was not invoked, so AEC can never subtract a stale echo estimate
  against a silent far-end once the filter has converged.
- A restart-boundary regression feeds `playback → null-reference silence →
  non-empty zero reference` and asserts the post-silence frame stays
  bit-identical zero, proving stale far-end samples were cleared before playback
  resumed.

## CPU avoided (micro-benchmark, `fastpath-bench.ts`, M-series)

```
Frames: 20000 silent 20 ms frames (6.7 min of audio); 256 taps × 320 samples
- OLD (process() with empty far-end every frame): 1409.5 ms, 70.47 µs/frame
- NEW (skip FIR — advance silent state):            15.7 ms,  0.79 µs/frame
- CPU avoided on the silent path:                   90× less work
Correctness: OLD empty-reference first-frame output is bit-identical to the mic (PASS).
```

On every device, whenever the agent is not speaking (the common case), the AEC
FIR inner loop is now skipped instead of burning ~70 µs per 20 ms frame.

## Reproduce
```bash
bun .github/issue-evidence/9649-aec-fast-path-skip-bench.ts
```
