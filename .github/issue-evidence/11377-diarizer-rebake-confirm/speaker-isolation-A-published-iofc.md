# Speaker-isolation benchmark — two real Kokoro voices, real diarizer + encoder (CPU)

Voices: af_bella (A) / am_michael (B), 8-turn dialogue, 600 ms gaps.

- encoder attribution: **6/6** (accuracy 1.000, margin 0.818)
- diarizer DER: **0.209** (missed 7240 ms, false-alarm 0 ms, confusion 0 ms, dropped-short 358 ms)
- #9427 mean-MFCC attributor (model-free comparison): accuracy 0.500
- overlap probe: localSpeakerCount=2, hasOverlap=true

| turn | speaker | attributed | dist(own) | dist(other) | correct |
| --- | --- | --- | ---: | ---: | --- |
| turn-03 | A | A | 0.207 | 1.002 | ✓ |
| turn-04 | B | B | 0.148 | 0.979 | ✓ |
| turn-05 | A | A | 0.167 | 1.007 | ✓ |
| turn-06 | B | B | 0.137 | 0.974 | ✓ |
| turn-07 | A | A | 0.195 | 0.963 | ✓ |
| turn-08 | B | B | 0.116 | 0.954 | ✓ |
