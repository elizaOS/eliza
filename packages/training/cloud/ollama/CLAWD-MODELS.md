# Clawd / 8bit Ollama model roster

Maps local Ollama tags (from `ollama list`) into elizaOS `TEXT_*` roles via
`@elizaos/plugin-ollama`.

## Recommended defaults

| Role | Env key | Tag | Size | Role |
| --- | --- | --- | ---: | --- |
| Nano / Small | `OLLAMA_NANO_MODEL` / `OLLAMA_SMALL_MODEL` | `8bit/solana-clawd-core-ai:latest` | ~1 GB | Fast agent turns, routing |
| Medium / Planner | `OLLAMA_MEDIUM_MODEL` / `OLLAMA_ACTION_PLANNER_MODEL` | `8bit/solana-trading-factory:8b-lora-20260620` | ~4.9 GB | Trading + tool planning |
| Large / Mega | `OLLAMA_LARGE_MODEL` / `OLLAMA_MEGA_MODEL` | `8bit/hauhau-qwen36-onchain:latest` | ~11 GB | Deep on-chain reasoning |
| Embeddings | `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | small | Memory embeddings |

## Alternate tags on this machine

| Tag | Size | Suggested use |
| --- | ---: | --- |
| `8bit/solana-clawd-core-ai:preview` | ~1 GB | Staging small model |
| `ordlibrary/core-ai-clawd-1.5b:latest` | ~1 GB | Community 1.5B base |
| `ordlibrary/core-ai-clawd-1.5b:finetuned` | ~4.9 GB | Heavier 1.5B finetune path |
| `ordlibrary/clawd-trading-wallet:latest` | ~1 GB | Wallet-ops specialist nano |
| `hf.co/ordlibrary/hauhau-qwen36-uncensored:latest` | ~11 GB | Uncensored large alternate |
| `hf.co/ordlibrary/hauhau-qwen36-onchain:latest` | ~11 GB | HF-sourced onchain large |

## Local wiring

```bash
# Ensure Ollama is up
ollama serve

# Embeddings (if missing)
ollama pull nomic-embed-text

# .env (repo root)
OLLAMA_API_ENDPOINT=http://localhost:11434/api
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_SMALL_MODEL=8bit/solana-clawd-core-ai:latest
OLLAMA_MEDIUM_MODEL=8bit/solana-trading-factory:8b-lora-20260620
OLLAMA_LARGE_MODEL=8bit/hauhau-qwen36-onchain:latest
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

`@elizaos/plugin-ollama` auto-enables when any of `OLLAMA_BASE_URL`,
`OLLAMA_API_ENDPOINT`, or `OLLAMA_API_URL` is set.

## Remote: Fly Ollama

See [`fly/README.md`](./fly/README.md). Point agents at the private Fly URL:

```bash
OLLAMA_API_ENDPOINT=https://clawd-ollama.fly.dev/api
OLLAMA_BASE_URL=https://clawd-ollama.fly.dev
```

Or use a Fly private `.internal` hostname when the agent also runs on Fly.

## Ollama Cloud

If you push models to [ollama.com](https://ollama.com) and use cloud inference:

```bash
OLLAMA_API_ENDPOINT=https://ollama.com/api
OLLAMA_BASE_URL=https://ollama.com
# Auth is product-specific; set whatever token Ollama Cloud documents as
# OLLAMA_API_KEY when supported by the running Ollama client/version.
```

Prefer Fly for **private** finetunes that must not leave your account.

## Hardware notes

| Model class | Local | Fly CPU | Fly GPU |
| --- | --- | --- | --- |
| 1.5B (`solana-clawd-core-ai`) | laptop OK | OK | optional |
| 8B trading factory | 16+ GB RAM/VRAM preferred | slow | recommended |
| ~35B hauhau onchain | high VRAM / Metal | not practical | required |
