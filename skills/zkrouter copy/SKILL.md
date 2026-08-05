---
name: zkrouter
sourcePath: zk-router/skills/zkrouter
description: Self-hosted OpenAI-compatible LLM router — smart tier-based routing, ZK-stamped routing decisions, mode overrides, free OpenRouter at install via the Birth bot. Save 60-80% on inference costs by routing to the cheapest capable model across 12+ OpenRouter models.
homepage: https://github.com/Solizardking/zk-router
tags: [zk-router, openrouter, llm-router, zero-knowledge, solana]
metadata:
  emoji: "🔀"
  requires:
    config: []
---

# zk-router

Self-hosted LLM router. Sits between your OpenAI-compatible client and OpenRouter. On every request, it:

1. **Classifies** the request with a 14-dimension weighted scoring engine (free, < 1ms)
2. **Detects mode overrides** (`/max`, `/complex`, `[simple]`, etc.)
3. **Stamps the routing decision** into a ZK compressed-state Merkle root
4. **Forwards** to the chosen model on OpenRouter
5. **Tracks** stats (requests, errors, savings, per-tier / per-model breakdown)

The killer feature: **the Birth bot** auto-provisions a sponsored OpenRouter key on first boot, so a fresh install needs zero configuration. No env vars. No signup. No credit card.

## Install

```bash
git clone https://github.com/Solizardking/zk-router.git
cd zk-router
npm install
npm run build
npm start
```

The first `npm start` will:

1. Load or create your Solana wallet at `~/.zk-router/wallet.json` (mode 0600)
2. Initialize the ZK journal at `~/.zk-router/zk/`
3. Call the x402.wtf control plane to mint a sponsored OpenRouter key
4. Bind that key to your wallet and persist it at `~/.zk-router/birth/receipt.json`
5. Start the proxy on `http://127.0.0.1:18800`

Subsequent boots reuse the cached receipt with no network call.

## Quick Start

```bash
# 1. Start the router
npm start
# 🌅 birth: provisioned key sk-or-v1-ab… (fresh)
# zk-router proxy listening on http://127.0.0.1:18800

# 2. Point any OpenAI-compatible client at it
curl http://127.0.0.1:18800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zkrouter/auto",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

## Routing Tiers

| Tier          | Example queries                                            | Default model                  | Cost (output / M) |
| ------------- | ---------------------------------------------------------- | ------------------------------ | ------------------ |
| **SIMPLE**    | "What is 2+2?", "Translate hello", "Yes or no"            | `google/gemini-2.5-flash`       | $2.50              |
| **MEDIUM**    | Summaries, explanations, simple code                     | `deepseek/deepseek-chat`        | $1.10              |
| **COMPLEX**   | Multi-step code, system design, agentic tasks             | `anthropic/claude-sonnet-4.5`  | $15.00             |
| **REASONING** | Proofs, math, multi-step logic                            | `openai/o3`                     | $40.00             |

Rules handle 100% of requests in < 1ms with zero LLM cost.

## Mode Overrides

Force a tier with a prefix — the LLM never sees it:

```bash
# Slash prefix
/simple What's 2+2?
/max Refactor this distributed system
/reasoning Prove sqrt(2) is irrational
/complex [simple]   # bracket prefix (alias names work too)

# Word prefix
deep mode: Why does this recursive CTE produce duplicates?
basic mode, What time is it in Tokyo?

# Aliases
simple, basic, cheap              → SIMPLE
medium, balanced                  → MEDIUM
complex, advanced                 → COMPLEX
max, reasoning, think, deep      → REASONING
```

See `GET /v1/mode-aliases` for the full list.

## ZK-Stamped Routing

Every routing decision is appended to a Merkle tree in the ZK journal:

```bash
curl http://127.0.0.1:18800/v1/relay/zk | jq .
```

Each chat completion response includes:

```
X-ZK-Router-Model:       google/gemini-2.5-flash
X-ZK-Router-Tier:         SIMPLE
X-ZK-Router-Savings:      97%
X-ZK-Router-Reasoning:    score=-0.050 | short (8 tokens)
X-ZK-Router-Root:         0x…
X-ZK-Router-Index:        42
```

The root is the Merkle root after appending this call's receipt. Auditors can verify the chain by replaying the routing decisions against the local classifier.

## Endpoints

| Endpoint                       | Auth   | Description                                              |
| ------------------------------ | ------ | -------------------------------------------------------- |
| `POST /v1/chat/completions`    | -      | OpenAI-compatible chat (model = `zkrouter/auto` or alias) |
| `GET  /v1/models`              | -      | List available models + aliases                         |
| `GET  /v1/mode-aliases`        | -      | List mode-override aliases                              |
| `GET  /v1/relay/zk`            | -      | ZK primitives snapshot                                  |
| `GET  /health`                  | -      | Health + uptime + stats                                 |
| `GET  /stats`                   | -      | Full request statistics (per-tier, per-model, costs)   |
| `GET  /config`                  | -      | Sanitized config + routing version                      |
| `POST /reload-config`           | -      | Hot-reload `zkrouter.config.json`                       |
| `GET  /v1/admin/status`        | admin  | Operator status: kill switch, tier override, audit queue |
| `POST /v1/admin/kill-switch`   | admin  | Toggle the kill switch (refuse all `/v1/chat`)         |
| `GET  /v1/admin/audit`         | admin  | Last 100 routing decisions (incl. blocked)              |
| `POST /v1/admin/force-birth`   | admin  | Wipe receipt and re-provision a fresh OpenRouter key   |
| `POST /v1/admin/set-tier-override` | admin | Pin a tier for the next N requests                    |
| `POST /v1/admin/reload-config` | admin  | Re-read `zkrouter.config.json` + reload env secret     |

### Admin auth

All `/v1/admin/*` endpoints require `Authorization: Bearer <CLAWDROUTER_ADMIN_SECRET>`.
If the env var is unset, all admin endpoints return **503 not_configured** (defense in depth).

```bash
# Status
curl -H "Authorization: Bearer $CLAWDROUTER_ADMIN_SECRET" \
  http://localhost:18800/v1/admin/status

# Activate kill switch with 60s TTL
curl -X POST -H "Authorization: Bearer $CLAWDROUTER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"reason":"investigating abuse","ttlSec":60}' \
  http://localhost:18800/v1/admin/kill-switch

# Force the next 10 requests to use the REASONING tier
curl -X POST -H "Authorization: Bearer $CLAWDROUTER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tier":"REASONING","requests":10}' \
  http://localhost:18800/v1/admin/set-tier-override

# Audit the last 100 routing decisions
curl -H "Authorization: Bearer $CLAWDROUTER_ADMIN_SECRET" \
  http://localhost:18800/v1/admin/audit

# Rotate the admin secret without a restart
export CLAWDROUTER_ADMIN_SECRET=new-secret
curl -X POST -H "Authorization: Bearer $CLAWDROUTER_ADMIN_SECRET" \
  http://localhost:18800/v1/admin/reload-config
```

## Configuration

`zkrouter.config.json` is looked up in this order:

1. `$ZKROUTER_CONFIG` env var
2. `./zkrouter.config.json` (cwd)
3. `~/.config/zk-router/config.json`

If no file is found, built-in defaults apply. Edit to override the tier→model mapping:

```json
{
  "port": 18800,
  "host": "127.0.0.1",
  "logLevel": "info",
  "openRouterBaseUrl": "https://openrouter.ai/api/v1",
  "tiers": {
    "SIMPLE":  { "primary": "google/gemini-2.5-flash",     "fallback": ["deepseek/deepseek-chat"] },
    "MEDIUM":  { "primary": "deepseek/deepseek-chat",      "fallback": ["anthropic/claude-haiku-4.5"] },
    "COMPLEX": { "primary": "anthropic/claude-sonnet-4.5", "fallback": ["openai/gpt-4o-mini"] },
    "REASONING": { "primary": "openai/o3",                "fallback": ["anthropic/claude-opus-4.5"] }
  }
}
```

## Environment Variables

| Variable                          | Default | Description                                  |
| --------------------------------- | ------- | -------------------------------------------- |
| `OPENROUTER_API_KEY`              | -       | Skip the Birth bot; use this key directly.   |
| `CLAWDROUTER_ADMIN_SECRET`        | -       | Bearer secret for `/v1/admin/*` (kill switch, force-birth, audit). Required for admin ops. |
| `ZKROUTER_PORT`                   | `18800` | Server port                                  |
| `ZKROUTER_HOST`                   | `127.0.0.1` | Bind address                              |
| `ZKROUTER_LOG_LEVEL`              | `info`  | `debug` / `info` / `warn` / `error` / `silent` |
| `ZKROUTER_BIRTH_ENABLED`          | `true`  | Master switch for the Birth bot             |
| `ZKROUTER_BIRTH_CONTROL_PLANE_URL` | `https://x402.wtf` | Control plane base URL             |
| `ZKROUTER_BIRTH_VAULT_DIR`        | `~/.zk-router/birth` | Receipt directory                |
| `ZKROUTER_BIRTH_AUTO_TRIGGER`     | `true`  | Run Birth on startup                       |
| `ZKROUTER_BIRTH_TIMEOUT_MS`       | `8000`  | HTTP timeout for the control plane         |
| `ZKROUTER_ZK_ENABLED`             | `true`  | Master switch for ZK                        |
| `ZKROUTER_ZK_STORAGE_DIR`         | `~/.zk-router/zk` | ZK journal directory                  |
| `ZKROUTER_ZK_TREE_DEPTH`          | `20`    | Merkle tree depth (8 / 16 / 20 / 26)        |

## The 14-Dimension Classifier

| Dimension            | Weight | Detection                                |
| -------------------- | ------ | ---------------------------------------- |
| Reasoning markers    | 0.25   | "prove", "theorem", "step by step"       |
| Technical terms      | 0.18   | "algorithm", "kubernetes", "distributed" |
| Code presence        | 0.12   | "function", "async", "import", "```"     |
| Multi-step patterns  | 0.12   | "first...then", "step 1"                 |
| Domain specificity   | 0.12   | "quantum", "fpga", "zero-knowledge"     |
| Simple indicators    | 0.10   | "what is", "define", "translate"         |
| Imperative verbs     | 0.06   | "build", "create", "implement"           |
| Token count          | 0.04   | short (< 50) vs long (> 500)             |
| Agentic task         | 0.04   | "read file", "edit", "run", "test"       |
| Creative markers     | 0.05   | "story", "poem", "brainstorm"            |
| Question complexity  | 0.05   | Multiple question marks                  |
| Constraint count     | 0.04   | "at most", "maximum", "limit"            |
| Output format        | 0.03   | "json", "yaml", "schema"                 |
| Reference complexity | 0.02   | "above", "the docs", "the api"           |
| Negation complexity  | 0.01   | "don't", "avoid", "without"              |

The weighted score maps to a tier via configurable boundaries. Confidence is calibrated using a sigmoid function. **> 2 reasoning markers** forces the REASONING tier at high confidence.

## Cost Impact

| Tier             | % of Traffic | Output $/M   | Savings         |
| ---------------- | ------------ | ------------ | --------------- |
| SIMPLE           | 40%          | $2.50        | **97% cheaper** |
| MEDIUM           | 30%          | $1.10        | **99% cheaper** |
| COMPLEX          | 20%          | $15.00       | best quality    |
| REASONING        | 10%          | $40.00       | **47% cheaper** |
| **Weighted avg** |              | **~$11.50/M** | **~70% savings** |

(Calculated against Claude Opus 4.5 baseline at $75/M output tokens.)

## What makes this different

| Feature                    | OpenRouter | LiteLLM | zk-router     |
| -------------------------- | ---------- | ------- | ------------- |
| Open source                | ❌         | ✅      | ✅            |
| Smart tier routing         | ❌         | ❌      | ✅            |
| Mode overrides             | ❌         | ❌      | ✅            |
| **Free OpenRouter at install** | ❌   | ❌      | ✅ (Birth)    |
| **ZK-stamped routing decisions** | ❌ | ❌   | ✅            |
| Zero-config startup         | ❌         | ❌      | ✅            |
| Multilingual classifier    | ✅         | ❌      | ✅            |
| External config hot-reload | ❌         | ✅      | ✅            |
| Agentic auto-detection     | ❌         | ❌      | ✅            |
| Context-length-aware routing | ❌        | partial | ✅            |

## Credits

- **Smart router** — adapted from [BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter) → [FreeRouter](https://github.com/openfreerouter/freerouter) (MIT)
- **ZK primitives** — ported from [clawdrouter](https://github.com/Solizardking/clawd-router) (MIT)
- **Birth bot** — ported from [clawdrouter](https://github.com/Solizardking/clawd-router) (MIT)
- **OpenRouter integration** — uses the [OpenRouter Chat Completions API](https://openrouter.ai/docs)
- **Sponsored key provisioning** — powered by [x402.wtf](https://x402.wtf) control plane

## License

MIT
