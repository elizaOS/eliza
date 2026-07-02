# Noise-rejection suite — WER vs SNR (real eliza-1-asr, fused lib, CPU)

clean mean WER: 0.008

| noise kind \ SNR (dB) | 20 | 10 | 5 | 0 | -5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| white | 0.008 | 0.038 | 0.040 | 0.094 | 0.310 |
| pink (traffic surrogate) | 0.008 | 0.030 | 0.040 | 0.117 | 0.355 |
| music | 0.008 | 0.008 | 0.008 | 0.008 | 0.016 |
| babble | 0.029 | 0.039 | 0.119 | 0.585 | 0.926 |

Gate: PASS
