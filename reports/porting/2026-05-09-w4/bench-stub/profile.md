# On-device inference profile

- **Generated:** 2026-05-10T05:05:28.379Z
- **Started:** 2026-05-10T05:05:24.948Z
- **Target:** `http://127.0.0.1:31339`
- **Streaming mode:** yes
- **Label:** w4-final
- **Config:** `scripts/benchmark/configs/host-cpu.json`
- **Iterations per combo:** 3 (+ 1 warmup)

## Summary table

Latencies are milliseconds. Tokens/s is estimated from response length (~4 chars/token).

| Model | KV cache | DFlash | Prompt | Load (ms) | First-token median | Total median | Total p95 | tok/s median | OK / total | Notes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| llama-3.2-1b | baseline-fp16 | no-dflash | short-q | 126 | 65 | 165 | 174 | 139.5 | 3 / 3 | — |
| llama-3.2-1b | baseline-fp16 | no-dflash | med-reason | 122 | 79 | 187 | 195 | 138.9 | 3 / 3 | — |
| llama-3.2-1b | tbq4-tbq3 | no-dflash | short-q | 122 | 95 | 193 | 198 | 119.3 | 3 / 3 | — |
| llama-3.2-1b | tbq4-tbq3 | no-dflash | med-reason | 121 | 80 | 185 | 190 | 140.3 | 3 / 3 | — |

## Config gaps

None — every kvCache/dflash combination matched the catalog defaults.

## Errors

No combination errored at the harness level.
