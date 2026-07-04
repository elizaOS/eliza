# Voice Workbench report

**Overall:** PASS — 18 ran, 0 skipped of 18

## Metrics

| Metric | Mean | Worst | n |
| --- | --- | --- | --- |
| WER | 0 | 0 | 44 |
| EOT false-trigger rate | 0 | 0 | 18 |
| EOT latency p50 (ms) | — | | |
| EOT latency p95 (ms) | — | | |
| Diarization DER | 0.0133 | 0.2394 | 18 |
| Respond accuracy | 1 | 1 | 18 |
| Entity F1 | 1 | 1 | 5 |
| Voice→entity match | 1 | 1 | 18 |
| First-audio (ms) | 250 | 250 | 38 |
| Echo rejection rate | 1 | 1 | 2 |
| Owner accuracy | 1 | 1 | 2 |
| Impostor-accept rate | 0 | 0 | 2 |

## Scenarios

| Scenario | Classes | Verdict | Cases | Failed |
| --- | --- | --- | --- | --- |
| multi-voice-greeting | multi-voice, diarization | pass | 8 | — |
| respond-vs-bystander | respond-no-respond, multi-speaker | pass | 9 | — |
| pauses-midutterance | pauses, eot | pass | 7 | — |
| entity-from-speech | entity-extraction, voice-recognition | pass | 7 | — |
| transcription-mode-dictation | transcription-mode, long-form-monologue | pass | 5 | — |
| multi-agent-room-address | multi-agent-room, respond-no-respond | pass | 8 | — |
| noisy-room-commands | robustness, respond-no-respond | pass | 8 | — |
| music-background-commands | robustness, respond-no-respond | pass | 8 | — |
| far-field-reverb | robustness, respond-no-respond | pass | 6 | — |
| background-talkers | robustness, overlapping-speech, multi-speaker | pass | 6 | — |
| echo-self-trigger | echo-rejection, respond-no-respond | pass | 10 | — |
| multi-speaker-name-capture | diarization, entity-extraction, multi-speaker, voice-recognition | pass | 13 | — |
| confusable-names-clean | entity-extraction, name-disambiguation, multi-speaker, voice-recognition, diarization | pass | 11 | — |
| confusable-names-noisy | entity-extraction, name-disambiguation, multi-speaker, voice-recognition, robustness | pass | 13 | — |
| confusable-name-garbled-transcript | entity-extraction, name-disambiguation, multi-speaker, voice-recognition | pass | 11 | — |
| echo-mistranscribed | echo-rejection | pass | 8 | — |
| owner-enrollment-inference | owner-security, voice-recognition | pass | 15 | — |
| owner-vs-intruder | owner-security, respond-no-respond, multi-speaker | pass | 10 | — |