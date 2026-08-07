# @solana-clawd/clawd-plugin

Clawd agent plugin for **Clawd Code** — skills, MCP servers, and a monorepo bridge
into the sibling `plugins/clawd-code` checkout (not a second vendored tree).

## Clawd Code source of truth

`plugins/clawd-code` now comes from
[https://github.com/Solizardking/clawd-code](https://github.com/Solizardking/clawd-code),
not a vendored local tree.

| Item | Result |
| --- | --- |
| **Source of truth** | Git submodule at `plugins/clawd-code` → `https://github.com/Solizardking/clawd-code.git` |
| **Pinned commit** | `29e3a9dccf6433c1f47710d6dc0470ac0cbec7bc` (`main`) |
| **`.gitmodules`** | `[submodule "plugins/clawd-code"]` with that URL |
| **Package metadata** | `repository` / `homepage` → Solizardking/clawd-code |
| **`install.sh` default** | `CLAWD_CODE_REPO=https://github.com/Solizardking/clawd-code.git` |
| **This plugin** | MCP + skills live here; CLI is resolved from the sibling submodule |

### Verification

- Workspace resolve: `@solana-clawd/clawd-code@workspace:plugins/clawd-code`
- GitHub install smoke: clone + build of Solizardking/clawd-code produced `dist/cli.js`
- Bridge tests: `bun run --cwd plugins/clawd-plugin test`
- No monorepo-owned install links to `solana-clawd/tree/main/clawd-code` for this package

### Install (canonical CLI)

```bash
curl -fsSL https://raw.githubusercontent.com/Solizardking/clawd-code/main/install.sh | sh
```

## Monorepo communication map

```text
plugins/clawd-plugin          ← skills + .mcp.json (this package)
        │ run-clawd-code.mjs
        ▼
plugins/clawd-code            ← git submodule of Solizardking/clawd-code
        │ workspace package @solana-clawd/clawd-code
        ▼
packages/cheshire-eliza       ← characters + body generator
        ├── @elizaos/plugin-cheshire-memory
        ├── @elizaos/plugin-clawdbrowser
        └── @elizaos/plugin-dflow-trade
```

| Package | Role |
| --- | --- |
| `@solana-clawd/clawd-code` | CLI (code / trade / research / voice / arena) |
| `@solana-clawd/clawd-plugin` | Clawd runtime plugin: skills + MCP bridge to the CLI |
| `@elizaos/cheshire-eliza` | Solizard / Cheshire character + agent body generator |
| `@elizaos/plugin-cheshire-memory` | Hermes + Honcho durable memory |
| `@elizaos/plugin-clawdbrowser` | ClawdBrowser `tools.md` catalog actions |

## Install (marketplace)

```
/plugin marketplace add solizardking/clawd-plugins
/plugin install clawd-code@solizardking
```

## Local monorepo testing

```bash
# from repo root
git submodule update --init plugins/clawd-code
bun install

# bridge resolves sibling CLI
bun run --cwd plugins/clawd-plugin test
bun run --cwd plugins/clawd-plugin clawd-code -- --help

# agent runtime
clawd --plugin-dir ./plugins/clawd-plugin
```

Override the CLI binary if needed:

```bash
export CLAWD_CODE_BIN=/path/to/clawd-code
```

## What's included

**Clawd Code MCP** — starts the **sibling** monorepo CLI via
`scripts/run-clawd-code.mjs` (prefers `plugins/clawd-code/dist/cli.js`, then
workspace, then `npx @solana-clawd/clawd-code@latest`).

**Phoenix Rise / DFlow / zkcompression** — HTTP MCP endpoints for market and
compression tooling.

### Skills

| Skill | Invoke | What it does |
| --- | --- | --- |
| **Clawd Code** | `/clawd:code` | Expert use of the Clawd Code CLI |
| **Build** | `/clawd:build` | Solana + Helius development patterns |
| **DFlow** | `/clawd:dflow` | Spot + prediction markets |
| **Phantom** | `/clawd:phantom` | Wallet / frontend Connect |
| **Jupiter** | `/clawd:jupiter` | DeFi swaps and lending |
| **OKX** | `/clawd:okx` | OKX + Helius composition |
| **SVM** | `/clawd:svm` | Solana protocol internals |
| **Agent Arena** | `/clawd:arena` | On-chain identity + reputation |

## API keys

Set in `~/.clawd-code/.env` (shared with the CLI):

```bash
CLAWD_PROVIDER=zai
CLAWD_MODEL=glm-5.2
ZAI_API_KEY=
XAI_API_KEY=
HELIUS_API_KEY=
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=
LIVE_TRADING=false
OPERATOR_CONFIRMED=false
PERPS_SIM_ONLY=true
```

## License

MIT. See [LICENSE](./LICENSE).

## Links

- [Clawd Code on GitHub](https://github.com/Solizardking/clawd-code)
- [Cheshire eliza package](../../packages/cheshire-eliza/README.md)
- [x402 Protocol](https://x402.wtf)
