# STT quant benchmark — eliza-1-asr (real weights, fused lib, CPU)

Host: linux-x64. Corpus: 12 fixed-transcript Kokoro utterances (55.5s). Absolute WER includes the TTS pronunciation floor; cross-quant deltas are the signal.

| variant | size (MB) | load (ms) | mean WER | median WER | mean ms/utt | 1st utt (ms) | RTF | × realtime |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bundle-2b (shipped) | 1019 | 1851 | 0.008 | 0.000 | 1213 | 1376 | 0.262 | 3.8× |
