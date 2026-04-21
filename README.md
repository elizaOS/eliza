<div align="center">
  <img src="apps/elizaokbsc/assets/avatar.png" alt="elizaOK" width="120" height="120" style="border-radius:50%;" />
  <h1>elizaOK</h1>
  <p><em>Powered by <a href="https://github.com/elizaos/eliza">elizaOS v3.0</a></em></p>
  <p><strong>The Value Layer on BNB Chain</strong></p>
  <p>Alpha discovery, position building, and real value delivery through dedicated vaults &mdash; built on <a href="https://github.com/elizaos/eliza">elizaOS</a>.</p>
</div>

<p align="center">
  <a href="https://elizaok.com"><img src="https://img.shields.io/badge/Live-elizaok.com-F6E70F?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PHBhdGggZD0iTTIgMTJoMjAiLz48cGF0aCBkPSJNMTIgMmExNS4zIDE1LjMgMCAwIDEgNCAxMCAxNS4zIDE1LjMgMCAwIDEtNCAxMCAxNS4zIDE1LjMgMCAwIDEtNC0xMCAxNS4zIDE1LjMgMCAwIDEgNC0xMHoiLz48L3N2Zz4=&logoColor=black" alt="Live Site"></a>
  <a href="https://x.com/elizaok_bsc"><img src="https://img.shields.io/badge/Follow-@elizaok__bsc-000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X"></a>
  <a href="https://elizacloud.ai"><img src="https://img.shields.io/badge/ElizaCloud-Connect-00C7D2?style=for-the-badge" alt="ElizaCloud"></a>
</p>

<p align="center">
  <a href="https://github.com/elizaokbsc/eliza/blob/develop/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License"></a>
  <a href="https://github.com/elizaokbsc/eliza/commits/develop"><img src="https://img.shields.io/github/last-commit/elizaokbsc/eliza/develop?style=flat-square" alt="Last Commit"></a>
  <a href="https://github.com/elizaokbsc/eliza/stargazers"><img src="https://img.shields.io/github/stars/elizaokbsc/eliza?style=flat-square" alt="Stars"></a>
</p>

---

## What is elizaOK?

Built on the **elizaOS** framework, **elizaOK** is the **value layer** that automates alpha discovery, position building, and real value delivery through dedicated vaults on **BNB Smart Chain (BSC)**. It continuously discovers, evaluates, and manages memecoin opportunities using real-time on-chain data from GeckoTerminal.

Through its proprietary **Goo Protocol** (AI Acquiring AI), elizaOK runs a competitive arena of 8 agents with different strategies, automatically acquires the best performers, and absorbs their winning parameters — a self-evolving system that sharpens every trading decision.

All profits flow through a **Revenue Flywheel** that reinvests gains, buys back $elizaOK tokens, and reserves funds for holder airdrops.

### Live at [elizaok.com](https://elizaok.com)

---

## Key Features

### AI-Powered Token Discovery
- Scans BSC pools every 15 minutes via GeckoTerminal API
- Scores candidates 0–100 based on liquidity, volume, buy/sell ratio, market cap, pool age, KOL holdings, and holder distribution
- Threshold-based buy signals with configurable sensitivity

### Multi-Stage Portfolio Management
- **5-tier take-profit**: +20% at 30%, +25% at 60%, +30% at 100%, +35% at 200%, +40% at 400%
- **Hard stop-loss**: -18% automatic exit
- **Trailing stop**: Activates at +25% gain, triggers on 15% pullback
- **Smart Exit Signals**: Real-time decisions based on holder attrition, KOL exits, and whale dumps
- **KOL-Adaptive Take-Profit**: Reverse-engineers optimal exit points from KOL behavior

### Goo Protocol — AI Acquiring AI
The Goo Arena is elizaOK's strategy evolution engine. **8 agents** with distinct strategies compete simultaneously:

| Strategy | Description |
|----------|-------------|
| Conservative | Low-risk, strict filtering |
| Balanced | Equilibrium risk-reward |
| Aggressive | High-risk, high-reward |
| KOL Follower | Tracks KOL positions |
| Holder Watcher | Monitors holder changes |
| Momentum | Follows momentum signals |
| Contrarian | Counter-trend approach |
| Sniper | Quick in-and-out strikes |

When an agent reaches acquisition score ≥70, win rate >15%, and ≥5 trades, elizaOK **acquires it** — absorbing its parameters (stop-loss, take-profit, holder thresholds) into the main portfolio. Dead agents auto-respawn to maintain arena diversity.

### Revenue Flywheel

```
Profit → 70% Reinvest → 15% $elizaOK Buyback → 15% Airdrop Reserve
```

The flywheel ensures continuous capital growth while creating value for token holders through buybacks and periodic airdrops to eligible wallets.

### ElizaCloud Integration
- **One-click login** via [elizacloud.ai](https://elizacloud.ai)
- **Chat with the Agent** in real-time for trade advice and market analysis
- **Cloud Agent Management** with AI inference credits
- **Multi-Agent Orchestration** across the platform

---

## Dashboard

The elizaOK dashboard provides a full-stack trading interface:

| Panel | Description |
|-------|-------------|
| **Token Explorer** | AI-scored token tile grid, ≥60 score filter, direct DEX links |
| **Top Candidates** | Ranked leaderboard with scores and recommendations |
| **Portfolio Ledger** | Active positions, cumulative P&L charts, trade timeline |
| **Revenue Flywheel** | Live profit distribution breakdown |
| **Strategy Absorption** | AI acquisition history and parameter blending |
| **Market Intel** | Real-time signals: holder drops, KOL exits, whale dumps |
| **Goo Intelligence** | Arena agent evaluation and comparison |
| **Execution Desk** | Risk controls, trade ledger, execution mode toggle |
| **Airdrop Distribution** | Holder snapshots and distribution planning |
| **Event Timeline** | Live event stream: buys, sells, acquisitions, respawns |

---

## Architecture

```
elizaOK
├── apps/elizaokbsc/          # Main application
│   ├── src/
│   │   ├── memecoin/
│   │   │   ├── server.ts         # Dashboard + API server (all pages)
│   │   │   ├── portfolio.ts      # Position management & P&L
│   │   │   ├── goo-paper-engine.ts   # Goo Arena simulation engine
│   │   │   ├── worker.ts         # Main loop: discovery, Goo cycles, absorption
│   │   │   ├── distribution.ts   # Airdrop distribution planning
│   │   │   ├── config.ts         # Discovery & scoring configuration
│   │   │   └── store.ts          # In-memory state management
│   │   └── index.ts          # Entry point
│   └── assets/               # Logo, avatar, video, audio
├── packages/
│   ├── core/                 # elizaOS core runtime
│   ├── plugin-sql/           # PGLite database integration
│   └── server/               # Express.js backend
└── ...
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun + TypeScript |
| Framework | elizaOS 2.0 |
| Data Source | GeckoTerminal API (real-time BSC on-chain) |
| Chain | BNB Smart Chain (BSC) |
| DEX | PancakeSwap V2, Four.Meme |
| Database | PGLite (in-process PostgreSQL) |
| AI Inference | OpenAI / ElizaCloud models |
| Deployment | PM2 + nginx on Ubuntu VPS |

---

## API Reference

| Endpoint | Description |
|----------|-------------|
| `GET /api/elizaok/candidates` | Current candidate tokens with scores |
| `GET /api/elizaok/portfolio` | Portfolio positions and P&L |
| `GET /api/goo/agents` | All Goo agent data and rankings |
| `GET /api/notifications` | Live event notifications |
| `GET /api/absorption/status` | Strategy absorption state |
| `GET /api/market-intel/signals` | Market intelligence signals |
| `GET /api/elizaok/distribution` | Airdrop distribution status |
| `POST /api/goo/agents/spawn` | Launch new Goo agent |
| `POST /api/goo/agents/:id/acquire` | Acquire specific agent |

---

## Pages

| URL | Page |
|-----|------|
| `/` | Landing page with immersive video background |
| `/dashboard` | Full trading dashboard with all panels |
| `/goo` | Goo Arena — agent competition and rankings |
| `/docs` | Documentation (English & Chinese) |
| `/airdrop` | Airdrop eligibility checker and distribution |

---

## Team

<table>
  <tr>
    <td align="center" width="280">
      <a href="https://x.com/baogerbao">
        <img src="https://img.shields.io/badge/-@baogerbao-000?style=for-the-badge&logo=x&logoColor=white" />
      </a>
      <br/><br/>
      <strong>Baoger</strong><br/>
      <sub>Founder & Product</sub><br/>
      <sub>Vision, product strategy, and ecosystem partnerships. Architecting the value layer for on-chain alpha discovery and delivery.</sub>
    </td>
    <td align="center" width="280">
      <a href="https://x.com/spaceodili">
        <img src="https://img.shields.io/badge/-@spaceodili-000?style=for-the-badge&logo=x&logoColor=white" />
      </a>
      <br/><br/>
      <strong>Odili</strong><br/>
      <sub>Head of Engineering</sub><br/>
      <sub>Core architecture, Goo Protocol engine, scoring algorithms, and full-stack infrastructure. elizaOS framework integration lead.</sub>
    </td>
    <td align="center" width="280">
      <a href="https://x.com/friesmakesfries">
        <img src="https://img.shields.io/badge/-@friesmakesfries-000?style=for-the-badge&logo=x&logoColor=white" />
      </a>
      <br/><br/>
      <strong>Fries</strong><br/>
      <sub>Operations & Growth</sub><br/>
      <sub>Community building, social strategy, and go-to-market execution. Driving adoption across the BNB Chain ecosystem.</sub>
    </td>
  </tr>
</table>

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (latest)
- Node.js v23+

### Local Development

```bash
git clone https://github.com/elizaokbsc/eliza.git
cd eliza
bun install

# Configure environment
cp apps/elizaokbsc/.env.example apps/elizaokbsc/.env
# Edit .env with your API keys

# Start the server
bun run apps/elizaokbsc/src/index.ts
```

Dashboard will be available at `http://localhost:4048`.

### Production Deployment

```bash
pm2 start "bun --env-file=apps/elizaokbsc/.env run apps/elizaokbsc/src/index.ts" \
  --name elizaok --cwd /path/to/eliza
```

---

## License

This project is built on [elizaOS](https://github.com/elizaos/eliza) and licensed under the [MIT License](LICENSE).

---

<div align="center">
  <strong>elizaOK</strong> &mdash; AI that evolves. Value that compounds.<br/>
  <sub>Built on BNB Chain &middot; Powered by elizaOS &middot; Accelerated by ElizaCloud</sub>
</div>
