# PR path: Cheshire elizaOS → Solizardking/eliza + agents

## Remotes (this checkout)

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `https://github.com/Solizardking/eliza.git` | **Your fork** — open PRs here first if contributing to the fork's develop, or use as PR head |
| `upstream` | `https://github.com/elizaOS/eliza.git` | Upstream elizaOS (optional contribute-to-core later) |

Agents catalog (separate repo):

| Repo | URL |
| --- | --- |
| Solizardking/agents | `https://github.com/Solizardking/agents` |
| Local path | `/Users/8bit/agents/agents` |
| Product surface | `https://cheshireterminal.ai/eliza-agents` (wire SPA route to catalog JSON) |

## What this branch adds

Under `plugins/`:

- `@elizaos/plugin-robinhood` — ERC-8004 register intent
- `@elizaos/plugin-solana-forging` — Metaplex mint intent
- `@elizaos/plugin-e2b-computer` — E2B sandbox computer
- `@elizaos/plugin-cheshire-memory` — `HERMES_API_KEY` + `HONCHO_API_KEY`
- `@elizaos/plugin-clawdbrowser` — official ClawdBrowser `tools.md` catalog (SEARCH/DESCRIBE/LIST)
- `@elizaos/plugin-dflow-trade` — DFlow + Helius Solana spot (DFLOW_API_KEY, HELIUS_RPC_URL; DeepSeek-ready)

Under `packages/cheshire-eliza/`:

- Solizard / Cheshire character
- Agent body + character generator
- This PR map

## Suggested git flow

```bash
# 1) eliza monorepo
cd /Users/8bit/agents/agents/eliza
git checkout -b feat/cheshire-eliza-plugins
git add plugins/plugin-robinhood plugins/plugin-solana-forging \
  plugins/plugin-e2b-computer plugins/plugin-cheshire-memory \
  plugins/plugin-clawdbrowser plugins/plugin-dflow-trade \
  packages/cheshire-eliza
git commit -m "feat(cheshire): forge, clawdbrowser tools, dflow solana trade"

# 2) push to Solizardking/eliza
git push -u origin feat/cheshire-eliza-plugins

# 3) open PR against Solizardking/eliza develop (or main)
gh pr create --repo Solizardking/eliza --base develop --head feat/cheshire-eliza-plugins \
  --title "feat: Cheshire Terminal eliza plugins (forge, E2B, memory)" \
  --body "$(cat packages/cheshire-eliza/docs/PR_PATH.md)"

# Optional: PR into upstream elizaOS/eliza once stable
# gh pr create --repo elizaOS/eliza --base develop --head Solizardking:feat/cheshire-eliza-plugins
```

## Agents catalog companion PR

```bash
cd /Users/8bit/agents/agents
git checkout -b feat/eliza-agents-surface
# eliza-agents/ is added next to this monorepo work
git add eliza-agents characters/
git commit -m "feat: eliza-agents catalog surface for cheshireterminal.ai/eliza-agents"
git push -u origin feat/eliza-agents-surface
gh pr create --repo Solizardking/agents --base main --head feat/eliza-agents-surface \
  --title "feat: eliza-agents surface for Solizard/Cheshire characters"
```

## Env matrix (production)

```bash
# Forge
ROBINHOOD_RPC_URL=
CHESHIRE_IDENTITY_REGISTRY=
SOLANA_RPC_URL=
METAPLEX_AGENT_COLLECTION=
ROBINHOOD_LIVE=false
SOLANA_FORGE_LIVE=false
CHESHIRE_OMNI_MINT=false

# Computer
E2B_API_KEY=

# Persistent memory
HERMES_API_KEY=
HONCHO_API_KEY=
HONCHO_PEER_ID=solizard
HONCHO_SESSION_ID=cheshire-prod

# ClawdBrowser tools.md catalog
CLAWDBROWSER_TOOLS_MD=/Users/8bit/ClawdBrowser/tools.md

# Solana NL trading
DEEPSEEK_API_KEY=
DFLOW_API_KEY=
HELIUS_RPC_URL=
SOLANA_PRIVATE_KEY=
SOLANA_TRADE_LIVE=false
```

## cheshireterminal.ai/eliza-agents

1. Serve `eliza-agents/catalog.json` from agents package or Fly API.
2. SPA route `/eliza-agents` lists characters + plugin bundle badges.
3. Deep-link install: `elizaos plugins add @elizaos/plugin-robinhood` (after publish).
