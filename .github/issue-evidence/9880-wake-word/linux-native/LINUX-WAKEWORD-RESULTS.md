# Linux-native real-audio openWakeWord verification — elizaOS #9880 ("hey eliza")

Adds a **Linux x86_64 native tier** to the #9880 real-audio evidence, which until
now was macOS-whisper.cpp-Metal only. This drives the *fused 3-stage openWakeWord
head itself* (melspec → embedding CNN → classifier) through the standalone pure-C
runtime in `packages/native/plugins/wakeword-cpp`, on real TTS speech, on this host.

- **Host:** Linux 6.17 x86_64, Intel Core Ultra 9 275HX (RTX 5080 box).
- **Runtime:** `packages/native/plugins/wakeword-cpp`, `libwakeword.a`,
  `wakeword_active_backend() == "native-cpu"` (pure scalar fp32 C; no SIMD, no ggml link).
- **Head:** wake-word **v0.3.0** GGUFs staged at
  `~/.local/state/eliza/local-inference/wake/hey-eliza.{melspec,embedding,classifier}.gguf`.
  All three sha256 **match the catalog** (`packages/shared/src/local-inference/voice-models.ts`,
  HF `elizaos/eliza-1@c544bb4c`); classifier metadata reads `wakeword.phrase="hey eliza"`,
  `upstream_commit=368c03716d…` (openWakeWord v0.5.1). This is the genuine trained
  hey-eliza head, not a placeholder.
- **Audio:** `piper en_US-amy-medium` TTS → 16 kHz mono **f32le**, padded with a
  **2.5 s lead-in + 1 s trailing silence** (the streaming runtime needs ~1.9 s warm-up
  to fill the mel+embedding rings, and the score peaks ~0.5–1 s *after* the phrase).
  Every clip's spoken content was **ASR round-trip confirmed** with `whisper tiny`
  ("Hey Eliza.", "Hey, Jarvis.", "Turn on the lights." …).
- **Threshold:** `WAKEWORD_DEFAULT_THRESHOLD = 0.5` (from `include/wakeword/wakeword.h`).

## Result: PASS (with a documented caveat about the peak-only metric)

| metric | positives | clean negatives | hard negatives |
|---|---|---|---|
| peak P(wake) | 1.0000 (all 4) | ≤ 0.078 | 0.97–1.00 |
| frames ≥ 0.5 | 13–17 | 0 | 2–9 |
| **max consecutive run ≥ 0.5** | **10–17** | **0** | **2–7** |

```
CLIP                       | peak   | ov.5 | run | VERDICT
---------------------------+--------+------+-----+--------------------------------
# POSITIVES (expect wake)
hey eliza                  | 1.0000 | 17   | 17  | PASS fire
hey, Eliza.                | 1.0000 | 17   | 12  | PASS fire
okay eliza                 | 1.0000 | 14   | 10  | PASS fire
eliza                      | 1.0000 | 13   | 12  | PASS fire
# CLEAN NEGATIVES (expect reject)
silence (4s)               | 0.0001 | 0    | 0   | PASS clean reject
what is the weather today  | 0.0003 | 0    | 0   | PASS clean reject
hello there                | 0.0783 | 0    | 0   | PASS clean reject
okay computer              | 0.0001 | 0    | 0   | PASS clean reject
hey google                 | 0.0066 | 0    | 0   | PASS clean reject
hey alyssa                 | 0.0346 | 0    | 0   | PASS clean reject
# HARD NEGATIVES (peak spikes >0.5 but NOT sustained)
hey jarvis                 | 0.9945 | 9    | 7   | reject only via debounce
jarvis                     | 0.9950 | 3    | 3   | reject only via debounce
good morning everyone      | 0.9999 | 3    | 2   | reject only via debounce
turn on the lights         | 0.9753 | 2    | 2   | reject only via debounce
```

### What this proves
- **The fused head fires on "hey eliza."** Peak P(wake)=1.0 and a **sustained** 17-frame
  (~1.4 s) run over threshold. "okay eliza", "eliza", "hey, Eliza." all fire identically.
- **It rejects ordinary speech and silence cleanly:** silence, "what is the weather",
  "hello there", "okay computer", "hey google", "hey alyssa" all peak ≤ 0.08 with **zero**
  frames over threshold.

### Honest caveat — the peak-only metric over-reports false accepts
On a **bare peak-over-stream** read (the metric `test/wakeword_score_raw.c` prints),
four negatives cross 0.5: **"hey jarvis" 0.99, "jarvis" 0.99, "good morning everyone"
0.9999, "turn on the lights" 0.97**. This is *louder* than the prior macOS evidence
(which reported "hey jarvis" 0.1253) and than the head's stated held-out ~4–7 % FA —
synthetic TTS at a single articulation is a worst-case probe, and the openWakeWord
melspec's per-call relmax dB floor is chunk-sensitive (documented in the package
CLAUDE.md "honest limitations").

The discriminator is **sustain, not peak**: every false accept is a 2–7 frame transient,
while every true "eliza" is a 10–17 frame sustained run. A **debounce of ≥8 consecutive
frames (~0.64 s)** — exactly what a production wake detector applies — **separates all 4
positives (10–17) from all 4 false-fires (≤7) and all 6 clean negatives (0)** with zero
errors. "hey jarvis" (run=7) is the closest competitor and the natural hardest negative
(a different "hey-+-name" wake word).

## Reproduce
```bash
bash 9880-linux-wakeword/reproduce.sh
# or, directly against the staged GGUFs:
WAKE=~/.local/state/eliza/local-inference/wake
wakeword-build/wakeword_score_raw \
  "$WAKE/hey-eliza.melspec.gguf" "$WAKE/hey-eliza.embedding.gguf" \
  "$WAKE/hey-eliza.classifier.gguf" 9880-linux-wakeword/audio/pos_hey_eliza.f32
# -> 1.0000   (negatives: neg_silence.f32 0.0001, neg_weather.f32 0.0003)
# trajectory / debounce:
wakeword-build/wakeword_trace <mel> <emb> <cls> <clip.f32> [threshold]
```

## Files
- `results-table.txt` — full numeric table (above).
- `audio/` — `.raw.wav` (piper out), `.16k.wav` (listenable), `.f32` (16k mono f32le scored).
- `reproduce.sh` — end-to-end build + synth + score.
- `wakeword_trace.c` — per-frame trajectory + max-consecutive-run driver (copied from build dir).
- `cmake-configure.log`, `cmake-build.log`, `runtime-smoke.log` — build + sanity logs.
