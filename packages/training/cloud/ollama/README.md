# Ollama Modelfiles for the Eliza-1 series

Three Modelfiles, one per published size, all pulling from the
public `elizaos/eliza-1-Nb-gguf` sibling repos on HuggingFace.

| File | Size | Target GPU | Resident VRAM |
|------|-----:|-----------|--------------:|
| `Modelfile.eliza-1-2b-q4_k_m`  | 2B  | 16 GB consumer (RTX 5080 / 4080) | ~3 GB |
| `Modelfile.eliza-1-9b-q4_k_m`  | 9B  | 24-48 GB workstation (RTX 4090 / 5090) | ~8-10 GB |
| `Modelfile.eliza-1-27b-q4_k_m` | 27B | 32+ GB (RTX 5090 / RTX Pro 5000) | ~22 GB |

## Build

Each Modelfile ships with the canonical Eliza system prompt, the
ChatML stop tokens used by Eliza-1, and per-size context /
sampling defaults.

```bash
# 2B — local consumer GPU
ollama create eliza-1-2b -f Modelfile.eliza-1-2b-q4_k_m

# 9B — workstation
ollama create eliza-1-9b -f Modelfile.eliza-1-9b-q4_k_m

# 27B — high-VRAM card or datacenter
ollama create eliza-1-27b -f Modelfile.eliza-1-27b-q4_k_m
```

Ollama pulls the GGUF directly from HuggingFace on first build — no
intermediate `ollama pull` needed. Subsequent builds reuse the cached
blob.

## Run

```bash
ollama run eliza-1-9b
```

Or expose to Milady:

```bash
# .env
OLLAMA_API_ENDPOINT=http://localhost:11434/api
OLLAMA_LARGE_MODEL=eliza-1-9b
OLLAMA_SMALL_MODEL=eliza-1-2b
```

When the `@elizaos/plugin-ollama` plugin is enabled, Milady sends
`TEXT_LARGE` requests to the model named in `OLLAMA_LARGE_MODEL` and
`TEXT_SMALL` requests to the model named in `OLLAMA_SMALL_MODEL`.

## Updating to a newer release

When a new fine-tune ships (e.g. `eliza-1.1-9b`), update the `FROM`
line to the new HF repo and rebuild:

```bash
ollama create eliza-1-9b -f Modelfile.eliza-1-9b-q4_k_m   # picks up new FROM
```

Ollama replaces the local model in place; agents already pointing at
`eliza-1-9b` will use the new weights on the next request without any
config change.

## Why GGUF + Ollama (and not vLLM) for local

GGUF + llama.cpp is the canonical local-inference path:
- Cross-platform (CUDA, Metal, CPU).
- Runs on consumer GPUs without any FP8/PolarQuant kernel availability
  worries.
- Ollama exposes an OpenAI-compatible API on `:11434` that the
  `@elizaos/plugin-ollama` plugin already consumes.

For datacenter / multi-GPU serving, see the sibling vast-pyworker
manifests at `../vast-pyworker/` — those use the vLLM + PolarQuant /
fp8 path defined in `training/scripts/inference/serve_vllm.py`.
