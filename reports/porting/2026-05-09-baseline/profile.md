# On-device inference profile

- **Generated:** 2026-05-10T01:21:22.210Z
- **Started:** 2026-05-10T01:20:35.243Z
- **Target:** `http://localhost:31337`
- **Streaming mode:** yes
- **Label:** baseline-stub-2026-05-09
- **Config:** `/home/shaw/milady/eliza/scripts/benchmark/configs/aosp-default.json`
- **Iterations per combo:** 3 (+ 1 warmup)

## Summary table

Latencies are milliseconds. Tokens/s is estimated from response length (~4 chars/token).

| Model | KV cache | DFlash | Prompt | Load (ms) | First-token median | Total median | Total p95 | tok/s median | OK / total | Notes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| llama-3.2-1b | baseline-fp16 | no-dflash | short-q | 125 | 73 | 172 | 180 | 133.6 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | baseline-fp16 | no-dflash | med-reason | 122 | 95 | 201 | 203 | 129.2 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | baseline-fp16 | no-dflash | long-gen | 121 | 92 | 199 | 204 | 130.5 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | baseline-fp16 | no-dflash | context-heavy | 120 | 78 | 184 | 191 | 141.4 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | baseline-fp16 | dflash-bonsai | short-q | 122 | 76 | 174 | 192 | 131.9 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | baseline-fp16 | dflash-bonsai | med-reason | 121 | 65 | 172 | 198 | 151.1 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | baseline-fp16 | dflash-bonsai | long-gen | 121 | 67 | 173 | 200 | 150.1 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | baseline-fp16 | dflash-bonsai | context-heavy | 121 | 70 | 177 | 187 | 146.9 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | no-dflash | short-q | 121 | 68 | 167 | 169 | 138.0 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | no-dflash | med-reason | 121 | 63 | 170 | 184 | 153.1 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | no-dflash | long-gen | 121 | 82 | 189 | 193 | 137.5 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | no-dflash | context-heavy | 121 | 84 | 191 | 203 | 136.3 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | dflash-bonsai | short-q | 121 | 92 | 190 | 190 | 121.4 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | dflash-bonsai | med-reason | 121 | 74 | 182 | 198 | 142.7 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | dflash-bonsai | long-gen | 121 | 89 | 194 | 203 | 134.3 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | tbq4-tbq3 | dflash-bonsai | context-heavy | 121 | 91 | 197 | 199 | 131.8 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | no-dflash | short-q | 121 | 88 | 185 | 188 | 124.1 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | no-dflash | med-reason | 122 | 78 | 183 | 185 | 142.4 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | no-dflash | long-gen | 121 | 76 | 183 | 194 | 142.1 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | no-dflash | context-heavy | 121 | 77 | 183 | 189 | 142.0 | 3 / 3 | gaps: kv-cache-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | dflash-bonsai | short-q | 121 | 79 | 178 | 195 | 129.0 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | dflash-bonsai | med-reason | 121 | 74 | 181 | 181 | 144.0 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | dflash-bonsai | long-gen | 121 | 86 | 194 | 197 | 134.1 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| llama-3.2-1b | qjl-tbq3 | dflash-bonsai | context-heavy | 121 | 87 | 195 | 199 | 133.5 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | no-dflash | short-q | 351 | 81 | 179 | 179 | 128.8 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | no-dflash | med-reason | 352 | 87 | 195 | 203 | 133.3 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | no-dflash | long-gen | 351 | 72 | 179 | 200 | 145.1 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | no-dflash | context-heavy | 351 | 80 | 185 | 195 | 140.2 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | dflash-bonsai | short-q | 352 | 69 | 167 | 179 | 137.4 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | dflash-bonsai | med-reason | 351 | 86 | 192 | 201 | 135.6 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | dflash-bonsai | long-gen | 353 | 84 | 190 | 191 | 137.1 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | baseline-fp16 | dflash-bonsai | context-heavy | 351 | 73 | 180 | 199 | 144.8 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | no-dflash | short-q | 351 | 84 | 184 | 190 | 124.8 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | no-dflash | med-reason | 350 | 97 | 204 | 204 | 127.7 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | no-dflash | long-gen | 352 | 79 | 185 | 198 | 140.2 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | no-dflash | context-heavy | 351 | 78 | 185 | 199 | 140.9 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | dflash-bonsai | short-q | 351 | 86 | 184 | 196 | 125.3 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | dflash-bonsai | med-reason | 351 | 93 | 199 | 207 | 130.8 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | dflash-bonsai | long-gen | 351 | 92 | 197 | 199 | 131.9 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | tbq4-tbq3 | dflash-bonsai | context-heavy | 351 | 62 | 169 | 199 | 154.2 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | no-dflash | short-q | 352 | 88 | 186 | 189 | 123.9 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | no-dflash | med-reason | 351 | 73 | 179 | 194 | 145.2 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | no-dflash | long-gen | 351 | 90 | 194 | 198 | 134.3 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | no-dflash | context-heavy | 352 | 94 | 198 | 200 | 131.4 | 3 / 3 | gaps: kv-cache-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | dflash-bonsai | short-q | 350 | 85 | 183 | 187 | 125.7 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | dflash-bonsai | med-reason | 351 | 69 | 175 | 182 | 148.7 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | dflash-bonsai | long-gen | 351 | 86 | 191 | 194 | 136.2 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |
| bonsai-8b-1bit | qjl-tbq3 | dflash-bonsai | context-heavy | 351 | 76 | 184 | 184 | 141.5 | 3 / 3 | gaps: kv-cache-override-not-supported, drafter-override-not-supported |

## Config gaps

- **kv-cache-override-not-supported**: 48 runs affected. Workaround documented in profile.json.
- **drafter-override-not-supported**: 24 runs affected. Workaround documented in profile.json.

## Errors

No combination errored at the harness level.
