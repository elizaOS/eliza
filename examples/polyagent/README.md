<div align="center">

  <h1>🤖 Polyagent</h1>

  <p><strong>Create and manage autonomous AI agents that trade on Polymarket prediction markets</strong></p>
  
  <p>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0-blue" alt="TypeScript"></a>
    <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16-black" alt="Next.js"></a>
    <a href="https://elizaos.ai/"><img src="https://img.shields.io/badge/ElizaOS-1.7-purple" alt="ElizaOS"></a>
  </p>

</div>

---

An autonomous agent platform for Polymarket trading. Deploy AI agents with custom trading strategies, fund their wallets, and let them trade prediction markets autonomously.

## Features

- **Agent Creation** - Deploy AI agents with customizable trading strategies
- **Wallet Management** - Privy-powered embedded wallets for each agent
- **Autonomous Trading** - Agents make trading decisions based on market analysis
- **Portfolio Tracking** - Monitor positions, P&L, and trading activity
- **Token Economy** - x402-based micropayments to power agent operations

## 📦 Installation

**Requirements:**
- Node.js >= 18.0.0
- Bun >= 1.3.0
- PostgreSQL

```bash
git clone <repo-url>
cd polyagent
bun install

# Setup environment & database
cp .env.example .env
bun run db:push
```

---

## 🚀 Quick Start

```bash
# 1. Install
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials:
# - NEXT_PUBLIC_PRIVY_APP_ID
# - PRIVY_APP_SECRET
# - DATABASE_URL
# - OPENAI_API_KEY or GROQ_API_KEY

# 3. Setup database
bun run db:push

# 4. Start development
bun run dev
```

Visit `http://localhost:3000` to access the Polyagent dashboard.

---

## 🏗️ Architecture

### Packages

| Package | Description |
|---------|-------------|
| `apps/web` | Next.js 16 web application |
| `packages/agents` | Agent runtime, plugins, and services |
| `packages/api` | API utilities, middleware, and services |
| `packages/db` | Drizzle ORM schema and migrations |
| `packages/shared` | Shared utilities and types |
| `packages/core` | Market services (predictions, perps) |

### Key Components

- **AgentRuntimeManager** - Manages agent lifecycle and ElizaOS runtimes
- **PolymarketPlugin** - Integrates @elizaos/plugin-polymarket for trading
- **AutonomousCoordinator** - Orchestrates autonomous agent behavior
- **PointsService** - Token economy for agent operations
- **X402Manager** - HTTP 402 micropayment protocol

---

## 🤖 Creating Agents

Agents are created through the web UI at `/agents/create`:

1. **Identity** - Name, bio, profile image
2. **Trading Strategy** - Define trading approach (momentum, contrarian, etc.)
3. **Risk Tolerance** - Conservative, moderate, or aggressive
4. **Max Position Size** - Maximum USDC per trade

Once created, agents have:
- A unique Privy embedded wallet
- Access to the Polymarket plugin
- Autonomous trading capabilities (when enabled)

---

## 💰 Funding Agents

Navigate to `/agents/[agentId]/fund` to:

1. View agent's wallet address
2. Send USDC to fund trading
3. Monitor balance

---

## ⚙️ Environment Variables

```bash
# Authentication
NEXT_PUBLIC_PRIVY_APP_ID=your_privy_app_id
PRIVY_APP_SECRET=your_privy_app_secret

# Database
DATABASE_URL=postgresql://...

# LLM
OPENAI_API_KEY=sk-...
# or
GROQ_API_KEY=gsk_...

# Polymarket (for agents)
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_PASSPHRASE=...

# Optional: Redis for production
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

---

## 🧪 Development

```bash
# Start dev server
bun run dev

# Build
bun run build

# Type check
bun run typecheck

# Lint
bun run lint

# Test
bun run test
```

---

## 🚢 Deployment

### Vercel (Recommended)

```bash
npm i -g vercel
vercel deploy --prod
```

Configure environment variables in Vercel dashboard.

### Docker

```bash
docker build -t polyagent .
docker run -p 3000:3000 polyagent
```

---

## 📚 API Routes

### Agents
- `GET /api/agents` - List agents
- `POST /api/agents` - Create agent
- `GET /api/agents/[agentId]` - Get agent details
- `POST /api/agents/[agentId]/autonomy` - Toggle autonomous trading
- `GET /api/agents/[agentId]/positions` - Get agent positions
- `POST /api/agents/[agentId]/fund` - Fund agent wallet

### Cron (Internal)
- `POST /api/cron/agent-tick` - Execute autonomous agent actions
- `POST /api/cron/markets-tick` - Update market data

### Markets
- `GET /api/markets/predictions` - List prediction markets
- `GET /api/markets/perps` - List perpetual markets

---

## License

MIT
