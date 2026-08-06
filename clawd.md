<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&height=180&color=0:14F195,40:9945FF,100:00D4FF&text=Clawd&fontColor=0B1020&fontSize=64&animation=twinkling&fontAlignY=32&desc=Solana-native%20agentic%20labor%20%C2%B7%20elizaOS%20%C2%B7%20Cheshire%20Terminal&descAlignY=58&descSize=16" alt="Clawd animated banner" />

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=22&duration=2600&pause=800&color=14F195&center=true&vCenter=true&width=980&lines=curl+-fsSL+install.sh+%7C+sh;intent+%E2%86%92+route+%E2%86%92+reason+%E2%86%92+verify+%E2%86%92+execute;clawd-code+%C2%B7+clawd-plugin+%C2%B7+cheshire-eliza;paper-first+perps+%C2%B7+wallets+%C2%B7+MCP+%C2%B7+arena" alt="Animated Clawd install and routing loop" />

[![npm clawd-code](https://img.shields.io/badge/npm-%40x402solana%2Fclawd--code-14F195?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@x402solana/clawd-code)
[![npm clawd-plugin](https://img.shields.io/badge/npm-%40x402solana%2Fclawd--plugin-9945FF?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@x402solana/clawd-plugin)
[![npm cheshire-eliza](https://img.shields.io/badge/npm-%40x402solana%2Fcheshire--eliza-00D4FF?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@x402solana/cheshire-eliza)
[![License: MIT](https://img.shields.io/badge/License-MIT-00D4FF?style=for-the-badge)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-18%2B-14F195?style=for-the-badge&logo=nodedotjs&logoColor=white)](#install)
[![Solana](https://img.shields.io/badge/Solana-mainnet--beta-9945FF?style=for-the-badge&logo=solana&logoColor=white)](#stack)
[![PR](https://img.shields.io/badge/PR-Solizardking%2Feliza-00D4FF?style=for-the-badge&logo=github)](https://github.com/Solizardking/eliza/pull/1)

**Clawd** is the Solana-native agent stack on this fork: coding CLI, plugin/MCP bridge,
Cheshire elizaOS characters, memory, browser tool catalog, and paper-gated perps.

</div>

---

## Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Solizardking/clawd-code/main/install.sh | sh
```

The installer checks for **Node.js 18+**, installs the `clawd-code` binary, and creates
`~/.clawd-code/.env` if missing.

> **Voice agent note:** `clawd-code voice --agent` needs **Node.js 22+** for native WebSockets
> and an `XAI_API_KEY`.

### npm (published under `@x402solana`)

```bash
# CLI (bin: clawd-code)
npm install -g @x402solana/clawd-code

# Plugin bridge (skills + MCP runner)
npm install -g @x402solana/clawd-plugin

# Cheshire character / body generator (TypeScript source package)
npm install @x402solana/cheshire-eliza
```

> **Note:** npm user `x402solana` owns the `@x402solana/*` scope.  
> Names `@solana-clawd/*` / `@elizaos/*` need those npm orgs before they can be published.

### From this monorepo

```bash
git clone https://github.com/Solizardking/eliza.git
cd eliza
git submodule update --init plugins/clawd-code
bun install

# bridge → sibling CLI
bun run --cwd plugins/clawd-plugin clawd-code -- --help

# agent runtime plugin dir
clawd --plugin-dir ./plugins/clawd-plugin
```

### Manual (upstream CLI repo)

```bash
git clone https://github.com/Solizardking/clawd-code.git
cd clawd-code
cp .env.example ~/.clawd-code/.env
npm install
npm run build
npm link
```

---

## Quick start

```bash
clawd-code code "Build a Jupiter swap bot in TypeScript"
clawd-code wallet create
clawd-code wallet list
clawd-code perps
clawd-code funding
clawd-code trade "funding rate on SOL perps"
clawd-code research --agents 16 "Solana perps funding arb"
clawd-code repl
clawd-code arena status
clawd-code verify
```

Slash aliases such as `clawd-code /wallet create` and `clawd-code /perps` still work.

---

## Stack

```text
                    ┌─────────────────────────────┐
                    │   cheshireterminal.ai       │
                    │   eliza-agents · arena      │
                    └──────────────┬──────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
┌─────────────────┐    ┌───────────────────┐    ┌────────────────────┐
│  clawd-code     │◄───│  clawd-plugin     │    │  cheshire-eliza    │
│  CLI submodule  │    │  skills + MCP     │    │  characters/body   │
│  Solizardking/  │    │  run-clawd-code   │    │  @elizaos/*        │
│  clawd-code     │    └───────────────────┘    └─────────┬──────────┘
└─────────────────┘                                       │
         ▲                        ┌───────────────────────┼──────────┐
         │                        ▼                       ▼          ▼
         │              plugin-cheshire-memory   plugin-clawdbrowser  plugin-dflow-trade
         │              Hermes + Honcho          tools.md catalog     DFlow + Helius
         └──────────────── paper-first perps · wallets · verify · arena ─────────────┘
```

| Package / path | npm name | Role |
| --- | --- | --- |
| `plugins/clawd-code` | `@solana-clawd/clawd-code` | Curl-installable Solana AI coding CLI |
| `plugins/clawd-plugin` | `@solana-clawd/clawd-plugin` | Skills + MCP bridge to the sibling CLI |
| `packages/cheshire-eliza` | `@elizaos/cheshire-eliza` | Solizard / Cheshire character + body generator |
| `plugins/plugin-cheshire-memory` | `@elizaos/plugin-cheshire-memory` | Hermes + Honcho durable memory |
| `plugins/plugin-clawdbrowser` | `@elizaos/plugin-clawdbrowser` | ClawdBrowser `tools.md` catalog actions |
| `plugins/plugin-dflow-trade` | `@elizaos/plugin-dflow-trade` | Spot quote/swap via DFlow + Helius |

---

## Clawd Code source of truth

`plugins/clawd-code` comes from
**[https://github.com/Solizardking/clawd-code](https://github.com/Solizardking/clawd-code)**,
not a vendored local tree.

| Item | Result |
| --- | --- |
| **Source of truth** | Git submodule `plugins/clawd-code` → `https://github.com/Solizardking/clawd-code.git` |
| **Pinned commit** | `29e3a9dccf6433c1f47710d6dc0470ac0cbec7bc` (`main`) |
| **`.gitmodules`** | `[submodule "plugins/clawd-code"]` with that URL |
| **Package metadata** | `repository` / `homepage` → Solizardking/clawd-code |
| **`install.sh` default** | `CLAWD_CODE_REPO=https://github.com/Solizardking/clawd-code.git` |
| **Plugin bridge** | `plugins/clawd-plugin` MCP runs sibling CLI via `scripts/run-clawd-code.mjs` |

### Verification

- Workspace resolve: `@solana-clawd/clawd-code@workspace:plugins/clawd-code`
- Bridge tests: `node --test plugins/clawd-plugin/scripts/resolve-clawd-code.test.mjs`
- Cheshire tests: `bunx vitest run --config packages/cheshire-eliza/vitest.config.ts` (from package dir)
- `node plugins/clawd-plugin/scripts/run-clawd-code.mjs --help` → sibling `dist/cli.js`

---

## Commands

| Command | Purpose |
| --- | --- |
| `clawd-code code "<prompt>"` | Generate TypeScript/Solana code (`--stream`) |
| `clawd-code trade "<intent>"` | Perps market, paper trade, positions |
| `clawd-code wallet create [name]` | Create local Solana keypair |
| `clawd-code wallet list` | List local wallet public keys |
| `clawd-code perps` | Perps dashboard |
| `clawd-code funding` | Funding-rate dashboard |
| `clawd-code research "<prompt>"` | Multi-agent research (`--stream`) |
| `clawd-code image "<prompt>"` | Image generation when configured |
| `clawd-code voice "<text>"` | TTS or xAI Voice Agent |
| `clawd-code voice --agent` | Real-time Solana voice agent (Node 22+) |
| `clawd-code repl` | Interactive multi-turn REPL |
| `clawd-code arena <subcommand>` | Agent Arena — identity, discovery, reputation |
| `clawd-code verify` | Environment preflight |

---

## Configuration

Runtime config lives in `~/.clawd-code/.env`.

| Variable | Description | Default |
| --- | --- | --- |
| `CLAWD_PROVIDER` | `zai`, `xai`, `anthropic`, `openrouter`, `deepseek` | `zai` |
| `CLAWD_MODEL` | Model for the selected provider | `glm-5.2` |
| `ZAI_API_KEY` | Z.AI / GLM keys | empty |
| `XAI_API_KEY` | xAI Grok + Voice Agent | empty |
| `ANTHROPIC_API_KEY` | Claude (streaming) | empty |
| `OPENROUTER_API_KEY` | OpenRouter (free models OK) | empty |
| `DEEPSEEK_API_KEY` | DeepSeek | empty |
| `SOLANA_RPC_URL` | Solana RPC | mainnet-beta |
| `HELIUS_API_KEY` | Optional Helius / DAS | empty |
| `VULCAN_MCP_URL` | Vulcan MCP | `http://localhost:3001` |
| `LIVE_TRADING` | Live trading path | `false` |
| `OPERATOR_CONFIRMED` | Operator ack for live | `false` |
| `PERPS_SIM_ONLY` | Keep perps simulated | `true` |

Never commit `.env`, wallet files, API keys, or private keys.

---

## Wallets

```bash
clawd-code wallet create
clawd-code wallet create trader-1
clawd-code wallet list
```

Keypairs are Solana CLI-compatible JSON under `~/.clawd-code/wallets` with `0600`
permissions. Treat them like private keys.

---

## Perps safety

Perps default to **paper**. Live requires all of:

```bash
LIVE_TRADING=true
OPERATOR_CONFIRMED=true
PERPS_SIM_ONLY=false
```

Local preflight also enforces allowed symbols, max notional, max leverage, and max
spread. Review config before live execution.

---

## Clawd plugin (MCP + skills)

```bash
# monorepo
clawd --plugin-dir ./plugins/clawd-plugin

# marketplace-style
/plugin marketplace add solizardking/clawd-plugins
/plugin install clawd-code@solizardking
```

MCP starts the **sibling** CLI through `scripts/run-clawd-code.mjs` (not a second
vendored copy). Skills cover code, build, DFlow, Phantom, Jupiter, OKX, SVM, and
Agent Arena.

---

## Cheshire elizaOS

```ts
import {
  solizardCheshireCharacter,
  generateAgentBody,
  CLAWD_CODE_GITHUB,
  clawdStackSummary,
} from "@elizaos/cheshire-eliza";

const body = generateAgentBody({
  name: "ClawdScout",
  archetype: "trader",
  rails: ["solana", "robinhood"],
});
```

Domain plugins on the character:

- `@elizaos/plugin-cheshire-memory` — Hermes + Honcho
- `@elizaos/plugin-clawdbrowser` — search / describe / list tools
- `@elizaos/plugin-dflow-trade` — Solana spot (preview-first)
- forge / E2B plugins as configured

---

## Agent Arena

```bash
clawd-code arena health
clawd-code arena mint --wallet <PUBKEY> --name "My Agent"
clawd-code arena register --wallet <PUBKEY> --a2a <url> --mcp <url>
clawd-code arena fetch <assetAddress>
clawd-code arena status
```

Identity is stored at `~/.clawd-code/arena-identity.json` (`0600`).  
Scheme: `svm://solana-mainnet/<metaplex-core-asset-address>`.

$CLAWD mint: `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump`

---

## Publish (npm)

**Live now (as of publish):**

| Package | Version | Install |
| --- | --- | --- |
| [`@x402solana/clawd-code`](https://www.npmjs.com/package/@x402solana/clawd-code) | `1.0.1` | `npm i -g @x402solana/clawd-code` |
| [`@x402solana/clawd-plugin`](https://www.npmjs.com/package/@x402solana/clawd-plugin) | `1.1.0` | `npm i -g @x402solana/clawd-plugin` |
| [`@x402solana/cheshire-eliza`](https://www.npmjs.com/package/@x402solana/cheshire-eliza) | `0.1.1` | `npm i @x402solana/cheshire-eliza` |

Republish helper (isolates packages from monorepo workspaces):

```bash
# dry-run
node scripts/publish-clawd-packages.mjs --npm-scope=x402solana

# real publish
node scripts/publish-clawd-packages.mjs --apply --npm-scope=x402solana
```

`@elizaos/plugin-cheshire-memory` and `@elizaos/plugin-clawdbrowser` need an
`@elizaos` npm org token (or republish under `@x402solana/*` with a name rewrite).

---

## Development

```bash
bun install
git submodule update --init plugins/clawd-code
node --test plugins/clawd-plugin/scripts/resolve-clawd-code.test.mjs
bunx vitest run --config packages/cheshire-eliza/vitest.config.ts  # from packages/cheshire-eliza
```

Layout (Clawd surface):

```text
plugins/
  clawd-code/           # submodule → github.com/Solizardking/clawd-code
  clawd-plugin/         # skills + MCP bridge
  plugin-cheshire-memory/
  plugin-clawdbrowser/
  plugin-dflow-trade/
packages/
  cheshire-eliza/       # characters, body generator, clawd-bridge
clawd.md                # this file
```

---

## Links

| Resource | URL |
| --- | --- |
| Clawd Code repo | https://github.com/Solizardking/clawd-code |
| This monorepo fork | https://github.com/Solizardking/eliza |
| Bridge PR | https://github.com/Solizardking/eliza/pull/1 |
| Cheshire Terminal | https://cheshireterminal.ai |
| Install script | https://raw.githubusercontent.com/Solizardking/clawd-code/main/install.sh |
| elizaOS upstream | https://github.com/elizaOS/eliza |

---

## License

MIT. See [LICENSE](./LICENSE).

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&height=100&color=0:00D4FF,50:9945FF,100:14F195&section=footer&text=born%20to%20verify%20%C2%B7%20built%20to%20execute&fontColor=0B1020&fontSize=18&animation=fadeIn" alt="Clawd footer wave" />

</div>
