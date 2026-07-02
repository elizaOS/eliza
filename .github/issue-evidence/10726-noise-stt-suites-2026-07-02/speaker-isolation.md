# Speaker-isolation benchmark — two real Kokoro voices, real diarizer + encoder (CPU)

Voices: af_bella (A) / am_michael (B), 8-turn dialogue, 600 ms gaps.

- encoder attribution: **6/6** (accuracy 1.000, margin 0.780)
- diarizer DER: **1.000** (missed 34580 ms, false-alarm 0 ms, confusion 0 ms, dropped-short 56073 ms)
- #9427 mean-MFCC attributor (model-free comparison): accuracy 0.500
- overlap probe: localSpeakerCount=3, hasOverlap=true

| turn | speaker | attributed | dist(own) | dist(other) | correct |
| --- | --- | --- | ---: | ---: | --- |
| turn-03 | A | A | 0.168 | 0.944 | ✓ |
| turn-04 | B | B | 0.159 | 1.005 | ✓ |
| turn-05 | A | A | 0.199 | 0.942 | ✓ |
| turn-06 | B | B | 0.167 | 0.964 | ✓ |
| turn-07 | A | A | 0.233 | 0.912 | ✓ |
| turn-08 | B | B | 0.143 | 0.982 | ✓ |
