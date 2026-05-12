# voice-duet bench — eliza-1-0_6b

- generated: 2026-05-12T14:59:01.317Z
- platform: linux-x64 / backend=(default) / two-process=false
- round-trips: 0/5
- sweep knobs: {"ringMs":200,"parallel":null,"draftMax":null,"draftMin":null,"ctxSizeDraft":null,"prewarmLeadMs":null,"chunkWords":null,"kvCacheType":null}

## Headline latency (p50 / p90 / p99, ms)

| metric | p50 | p90 | p99 | n |
|---|---|---|---|---|
| ttftFromUtteranceEndMs | — | — | — | 0 |
| firstAudioIntoPeerRingFromUtteranceEndMs | — | — | — | 0 |
| ttftMs | — | — | — | 0 |
| ttfaMs | — | — | — | 0 |
| ttapMs | — | — | — | 0 |
| envelopeToReplyTextMs | — | — | — | 0 |
| emotionTagOverheadMs | — | — | — | 0 |

## Run metrics

- DFlash accept-rate (token-weighted): — (drafted=0, accepted=0)
- structured-decode token-savings %: — (p50)
- tok/s: — (p50)
- server RSS: first=—MB last=—MB max=—MB leakSuspected=false

## Emotion fidelity

- perceiver: perceiver: fallback-classifier (unavailable — recorded as null)
- accuracy: — (recorded as null — needs an emotion-aware ASR / classifier) over 0 turns

emotionFidelity.accuracy is null — the GGUF-converted Qwen3-ASR did not surface an emotion label in this run and no fallback emotion-from-audio classifier was available; recorded as null per the honesty contract, not fabricated. structured-decode token-savings % is null when the running llama-server's /metrics did not expose the guided-decode counter.
