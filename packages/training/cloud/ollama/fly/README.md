# Fly Ollama for Clawd agents

Deploys a private [Ollama](https://ollama.com) server on Fly.io so elizaOS agents
can use the **8bit / ordlibrary** model roster without depending on a laptop.

## When to use Fly vs local vs Ollama Cloud

| Path | Use when |
| --- | --- |
| **Local** `localhost:11434` | Dev on this Mac; models already in `ollama list` |
| **Fly** (this dir) | Shared/staging agents, always-on endpoint, private tags |
| **Ollama Cloud** | Hosted public models; not for private 8bit finetunes |

## Prerequisites

- `fly` CLI logged in (`fly auth login`)
- Fly org with enough **volume** and (for 8B+) **GPU** quota
- Models available to import (local `ollama` or HF GGUF)

## One-time create

```bash
cd packages/training/cloud/ollama/fly

# Create app (name must match fly.toml `app` or pass -a)
fly apps create clawd-ollama

# Persistent model store (40GB fits 1.5B + 8B; bump for hauhau 11GB+)
fly volumes create ollama_data --size 40 --region ord

# Deploy
fly deploy
```

## Smoke test

```bash
fly status -a clawd-ollama
curl -sS https://clawd-ollama.fly.dev/api/tags | head
```

## Load models

Public embedding model:

```bash
./pull-models.sh
```

Private 8bit tags (multi-GB) — SSH and create/import:

```bash
fly ssh console -a clawd-ollama
# inside VM:
ollama list
# ollama create 8bit/solana-clawd-core-ai:latest -f Modelfile...
```

From a local machine that already has the tags, the practical options are:

1. **Rebuild on Fly** from GGUF/Modelfile (best for automation)
2. **ollama export/import** over SSH/SCP of blobs under `/root/.ollama`
3. Keep the **11GB** model local-only and only serve 1.5B/8B on Fly

## Point eliza agents at Fly

Repo root `.env` (or Fly secrets on the agent app):

```bash
OLLAMA_API_ENDPOINT=https://clawd-ollama.fly.dev/api
OLLAMA_BASE_URL=https://clawd-ollama.fly.dev
OLLAMA_SMALL_MODEL=8bit/solana-clawd-core-ai:latest
OLLAMA_MEDIUM_MODEL=8bit/solana-trading-factory:8b-lora-20260620
OLLAMA_LARGE_MODEL=8bit/hauhau-qwen36-onchain:latest
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

`@elizaos/plugin-ollama` auto-enables from those env keys.

### Agent also on Fly

Prefer private networking:

```bash
OLLAMA_BASE_URL=http://clawd-ollama.internal:11434
OLLAMA_API_ENDPOINT=http://clawd-ollama.internal:11434/api
```

## GPU for large models

Default `fly.toml` uses a **CPU performance** VM for cost control (good for 1.5B).
For `solana-trading-factory` (8B) and especially `hauhau-qwen36-onchain` (~35B),
edit `[[vm]]` to a GPU size and redeploy. Without GPU, large tags will time out
or thrash.

## Security

- Treat the public Fly URL as an **unauthenticated** LLM API unless you put
  Fly private networking or a proxy with auth in front.
- Do not commit API tokens. Use `fly secrets set` on consumer apps.

## Related

- Model roster: [`../CLAWD-MODELS.md`](../CLAWD-MODELS.md)
- Eliza-1 Modelfiles: [`../README.md`](../README.md)
- Plugin: `plugins/plugin-ollama`
