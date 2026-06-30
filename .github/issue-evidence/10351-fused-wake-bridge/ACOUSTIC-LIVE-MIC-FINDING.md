# #10351 — live-microphone acoustic finding (the irreducible human step)

The merged work (`validate-fused-wake-e2e.mjs`) proves the **full real chain**
end-to-end, file-fed, on this Apple-Silicon Mac:

```
real libwakeword.dylib (bun:ffi) → OpenWakeWordGgmlModel.scoreFrame()
  → OpenWakeWordDetector → bridgeDetectorToFusedWake → eliza:fused-wake
  → wakeControllerReducer(head-fired) → bar opens + turn starts
```

Re-verified this session (cmake-built `libwakeword.dylib`, sha-pinned hey-eliza
GGUFs auto-downloaded): the committed `hey-eliza-16k-mono.f32` clip fires
**P(wake) = 1.0000**, `eliza:fused-wake fired=true`, controller `head-fast-path`
(confidence 0.775). Negative "what time is it" → P 0.0000. **2/2.**

## What I attempted on real hardware, and the honest result

The remaining device step is a **live microphone** "hey eliza" driving the bar.
I drove the chain with `WAKE_POS_CLIP` set to live-mic captures:

| positive source | native peak P(wake) | fired |
|-----------------|---------------------|-------|
| committed clip (file-fed, real human "hey eliza") | **1.0000** | ✅ |
| `say`-synthesized "hey eliza", captured via live mic | 0.0000 | ❌ |
| committed clip **played out speaker → recaptured via live mic** | 0.0000 | ❌ |
| …same, gain-normalized to −16 dB | 0.0002 | ❌ |

`hey-eliza-acoustic-loopback.wav` is the recaptured clip.

**Finding:** the openWakeWord "hey eliza" head will **not** fire on
(a) TTS-synthesized speech, or (b) audio recaptured through the MacBook's own
speaker → built-in mic. Gain normalization does not recover it (P stays ~0), so
this is **spectral/acoustic degradation, not a level problem** — the small
speaker + close self-mic colors the mel-spectral features the head keys on.

Note the contrast with #9958's Stage-B ASR, which **did** recognize the same
class of acoustic-loopback `say` audio (general ASR is far more robust than a
keyword-spotting head trained on real human utterances).

## Conclusion — the irreducible human step

A genuine green for "live-mic → bar" requires a **real human voice saying
"hey eliza" into the device microphone** with the app's voice session running.
It cannot be faked by TTS (doesn't trigger the head) or speaker-loopback
(acoustic self-coloration kills the trigger). This is the same human-in-the-loop
class as the locked iPhone: the code path is proven real and complete; only a
live human utterance + a running session remain, and those are not automatable
from this harness.
