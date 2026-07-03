# Stage 5 — GGUF conversion of the fine-tuned eliza-1-2b (local, M4 Max)

The Nebius pipeline skipped GGUF (`eliza1_bundle: skipped "fork not found"` — the
elizaOS/llama.cpp fork wasn't on the remote box). Produced it locally instead
from the fetched fine-tuned checkpoint.

## Result: WORKING deployable GGUF ✅

- **Converter:** the repo-vendored gemma-4-capable converter
  `plugins/plugin-local-inference/native/llama.cpp/convert_hf_to_gguf.py`
  (16 gemma-4 refs; no clone/build needed — the Metal binaries are prebuilt at
  `build-desktop-metal/bin/`).
- **Source:** `checkpoints/eliza1-2b-gpt55scenarios-apollo-1783053000/checkpoint-91/`
  (fine-tuned eliza-1-2b, base google/gemma-4-E2B).
- **Outputs (persistent, in `checkpoints/.../gguf/`):**
  - `eliza-1-2b-gpt55.f16.gguf` — 8.6 GB (541 tensors, `Model successfully exported`)
  - `eliza-1-2b-gpt55.q4_k_m.gguf` — 3.2 GB (mobile-deployable; llama-quantize 12.6s)

## Verified generating (Metal, M4 Max)

```
llama-cli -m eliza-1-2b-gpt55.q4_k_m.gguf -p "List three things a helpful assistant does:" -n 40 -ngl 99
→ | A helpful assistant can:
  1. Give concise, clear answers to questions.
  2. Perform simple tasks like searching the web or sending messages.
  3. Remind you of tasks or events
[ Prompt: 481.4 t/s | Generation: 157.3 t/s ]
```

Coherent, on-topic output at 157 tok/s decode on Metal → the conversion is valid,
not corrupt. The q4_k_m is directly loadable by the local-inference runtime.

## Reproduce

`packages/training/scripts/_gguf_local.sh` (uv venv w/ torch+gguf, vendored
converter → f16 → llama-quantize q4_k_m → llama-cli verify). The .gguf blobs are
gitignored (8.6G/3.2G); regenerate from checkpoint-91 with that script.
