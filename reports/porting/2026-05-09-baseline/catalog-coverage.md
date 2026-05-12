# Catalog field coverage (baseline 2026-05-09)

Source: `packages/app-core/src/services/local-inference/catalog.ts`

Total entries: 27

| id | category | bucket | params | contextLength | tokenizerFamily | kvCache? | dflash? | runtime? | hidden? |
|---|---|---|---|---|---|---|---|---|---|
| smollm2-360m | tiny | small | 360M | 8192 | smol | — | — | — | — |
| smollm2-1.7b | tiny | small | 1.7B | 8192 | smol | — | — | — | — |
| llama-3.2-1b | tiny | small | 1B | 131072 | llama3 | — | — | — | — |
| llama-3.2-3b | chat | small | 3B | 131072 | llama3 | — | — | — | — |
| qwen3.5-4b-dflash | chat | small | 4B | 131072 | qwen3 | — | →qwen3.5-4b-dflash-drafter-q4 | yes | — |
| qwen3.5-4b-dflash-drafter-q4 | drafter | small | 1B | — | qwen3 | — | — | — | yes |
| llama-3.1-8b | chat | mid | 8B | 131072 | llama3 | — | — | — | — |
| qwen3.5-9b-dflash | chat | mid | 9B | 131072 | qwen3 | — | →qwen3.5-9b-dflash-drafter-q4 | yes | — |
| qwen3.5-9b-dflash-drafter-q4 | drafter | small | 1B | — | qwen3 | — | — | — | yes |
| gemma-2-9b | chat | mid | 9B | 8192 | gemma2 | — | — | — | — |
| qwen2.5-coder-7b | code | mid | 7B | 131072 | qwen2.5 | — | — | — | — |
| hermes-3-llama-8b | tools | mid | 8B | 131072 | llama3 | — | — | — | — |
| bonsai-8b-1bit | chat | mid | 8B | 131072 | qwen3 | tbq4_0/tbq3_0 | — | yes | — |
| bonsai-8b-1bit-dflash | chat | mid | 8B | 131072 | qwen3 | tbq4_0/tbq3_0 | →bonsai-8b-dflash-drafter | yes | — |
| bonsai-8b-dflash-drafter | drafter | small | 1B | — | qwen3 | — | — | — | yes |
| qwen3-coder-30b-awq-q4 | code | large | 32B | 262144 | qwen3 | — | — | yes | — |
| deepseek-coder-v2-lite | code | large | 16B | 163840 | deepseek | — | — | — | — |
| qwen2.5-coder-14b | code | large | 14B | 131072 | qwen2.5 | — | — | — | — |
| mistral-small-3-24b | chat | large | 24B | 32768 | mistral | — | — | — | — |
| gemma-2-27b | chat | large | 27B | 8192 | gemma2 | — | — | — | — |
| qwen3.6-27b-dflash | chat | large | 27B | 131072 | qwen3 | — | →qwen3.6-27b-dflash-drafter-q8 | yes | — |
| qwen3.6-27b-dflash-drafter-q8 | drafter | small | 2B | — | qwen3 | — | — | — | yes |
| qwq-32b | reasoning | xl | 32B | 32768 | qwen2.5 | — | — | — | — |
| deepseek-r1-distill-qwen-32b | reasoning | xl | 32B | 131072 | qwen2.5 | — | — | — | — |
| eliza-1-2b | chat | small | 2B | 131072 | qwen3 | — | — | — | — |
| eliza-1-9b | chat | mid | 9B | 131072 | qwen3 | — | — | — | — |
| eliza-1-27b | chat | large | 27B | 131072 | qwen3 | — | — | — | — |

## Coverage summary

- contextLength set: 23 / 27
- tokenizerFamily set: 27 / 27
- runtime block present: 6 / 27
- runtime.kvCache present: 2 / 27
- runtime.dflash present: 4 / 27

## Missing field gaps (W2 should fix)

### Missing contextLength (4)

- qwen3.5-4b-dflash-drafter-q4
- qwen3.5-9b-dflash-drafter-q4
- bonsai-8b-dflash-drafter
- qwen3.6-27b-dflash-drafter-q8

### Missing tokenizerFamily (0)

(none)
