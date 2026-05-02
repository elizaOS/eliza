# Steward × waifu.fun — Production Integration Plan

## Current Reality

**waifu.fun today:** agents don't sign their own transactions. The platform builds swap calldata via `@waifu/flap` and returns it to the frontend where a human user's wallet signs. Agents are characters with tokens, not autonomous economic actors.

**The gap:** For agents to "trade to survive," they need:
1. Their own wallets (with real keys, not user wallets)
2. Autonomous decision-making (when to buy/sell/rebalance)
3. Policy enforcement (so they can't drain themselves or go rogue)
4. Operator oversight (approve big moves, freeze if needed)

**Steward fills #1, #3, #4.** The waifu platform provides #2.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    waifu.fun                         │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ waifu-api│  │ waifu-worker │  │ waifu-indexer  │  │
│  └────┬─────┘  └──────┬───────┘  └───────────────┘  │
│       │               │                              │
│       │    ┌──────────┴──────────┐                   │
│       │    │  agent-trader       │  ← NEW SERVICE    │
│       │    │  (autonomous loop)  │                   │
│       │    └──────────┬──────────┘                   │
│       │               │                              │
└───────┼───────────────┼──────────────────────────────┘
        │               │
        │    ┌──────────▼──────────┐
        │    │   Steward API       │  api.steward.fi
        │    │                     │
        │    │  ┌──────────────┐   │
        │    │  │ Policy Engine│   │
        │    │  └──────┬───────┘   │
        │    │         │           │
        │    │  ┌──────▼───────┐   │
        │    │  │    Vault     │   │
        │    │  │ (sign / key) │   │
        │    │  └──────┬───────┘   │
        │    │         │           │
        │    └─────────┼───────────┘
        │              │
        │    ┌─────────▼───────────┐
        │    │   Base (L1/L2)      │
        │    │   Flap Portal       │
        │    │   DEX contracts     │
        │    └─────────────────────┘
        │
        │    ┌─────────────────────┐
        └───►│  Steward Dashboard  │  steward.fi/dashboard
             │  (operator view)    │
             └─────────────────────┘
```

## Implementation — 4 Workers

---

### Worker 1: `steward-agent-trader` — Autonomous Trading Service

**What:** New Node.js service that runs alongside waifu-worker on milady VPS. This is the brain that decides when agents trade.

**Path:** `/opt/waifu-core/apps/agent-trader/` (or standalone at `/opt/steward-trader/`)

**Responsibilities:**
- Poll waifu-api for agent state (treasury balance, token price, market data)
- Execute trading strategy per agent (configurable: DCA, rebalance, threshold-based)
- Submit trades through Steward SDK → policy check → sign → broadcast
- Handle Steward webhook callbacks (approval_required, tx_signed, tx_failed)
- Log all decisions for auditability

**Core loop:**
```typescript
// Every N minutes per agent:
async function tradeLoop(agent: WaifuAgent) {
  const state = await getAgentState(agent);       // treasury, token price, etc.
  const decision = strategy.evaluate(state);       // buy/sell/hold/rebalance
  
  if (decision.action === 'hold') return;
  
  // Build swap calldata using @waifu/flap
  const swapParams = await flapClient.prepareSwap({
    tokenAddress: agent.tokenAddress,
    side: decision.action,
    amount: decision.amount,
    slippageBps: 100,
    traderAddress: agent.stewardWalletAddress,
  });
  
  // Submit through Steward (policy enforcement happens here)
  const result = await steward.signTransaction(agent.stewardAgentId, {
    to: swapParams.call.contractAddress,
    value: swapParams.call.value,
    data: swapParams.call.calldata,
    chainId: 8453,  // Base for prod, 56 for BSC
  });
  
  // If pending_approval, wait for operator via webhook
  // If signed, log and continue
  // If rejected, log why and adjust strategy
}
```

**Config per agent:**
```json
{
  "strategy": "rebalance",
  "targetAllocation": { "bnb": 0.3, "ownToken": 0.5, "usdc": 0.2 },
  "rebalanceThreshold": 0.1,
  "maxTradeSize": "0.05",
  "tradingInterval": 300,
  "enabled": true
}
```

**Files to create:**
- `src/index.ts` — service entry, starts trade loops
- `src/loop.ts` — per-agent trading loop
- `src/strategies/rebalance.ts` — rebalancing strategy
- `src/strategies/dca.ts` — dollar-cost averaging
- `src/strategies/types.ts` — strategy interface
- `src/state.ts` — fetch agent state from waifu-api + chain
- `src/webhook-handler.ts` — receive Steward webhooks
- `src/config.ts` — load agent configs from DB or file

---

### Worker 2: `steward-waifu-bridge` — API Integration Layer

**What:** Extends steward API (or adds middleware to waifu-api) so agent creation on waifu automatically provisions a Steward wallet.

**Changes to waifu-api:**
- When a new agent is created → call `POST /agents` on Steward to create wallet
- Store `steward_agent_id` and `steward_wallet_address` in waifu DB
- New columns on `tokens` or `agents` table: `steward_agent_id`, `steward_wallet_address`
- Expose agent wallet balance in waifu-api responses

**Changes to steward API:**
- Add BSC chain support (chain ID 56) alongside Base (8453, 84532)
- Add `/agents/:id/balance` endpoint — queries on-chain balance
- Add batch agent creation endpoint for migrating existing agents

**Migration script for existing agents:**
```typescript
// For each existing waifu agent without a steward wallet:
for (const agent of existingAgents) {
  const wallet = await steward.createWallet(
    `waifu-${agent.id}`,
    agent.name,
    `waifu.fun:${agent.id}`
  );
  await waifuDb.update(agents)
    .set({ stewardAgentId: wallet.id, stewardWalletAddress: wallet.walletAddress })
    .where(eq(agents.id, agent.id));
}
```

**Default policy template for waifu agents:**
```typescript
const WAIFU_DEFAULT_POLICIES = [
  {
    type: 'spending-limit',
    config: {
      maxPerTx: parseEther('0.1'),   // Max 0.1 BNB per trade
      maxPerDay: parseEther('1.0'),   // Max 1 BNB daily
      maxPerWeek: parseEther('5.0'),  // Max 5 BNB weekly
    }
  },
  {
    type: 'approved-addresses',
    config: {
      mode: 'whitelist',
      addresses: [
        FLAP_PORTAL_ADDRESS,          // Only the Flap DEX portal
      ]
    }
  },
  {
    type: 'rate-limit',
    config: {
      maxTxPerHour: 6,
      maxTxPerDay: 24,
    }
  },
  {
    type: 'auto-approve-threshold',
    config: {
      threshold: parseEther('0.01'),  // Auto-approve trades under 0.01 BNB
    }
  }
];
```

**Files to create/modify:**
- `packages/api/src/routes/balance.ts` — new balance endpoint
- `packages/api/src/chains.ts` — add BSC chain config
- `waifu-core/apps/api/src/services/steward-bridge.ts` — bridge service
- `waifu-core/apps/api/src/routes/agents.ts` — modify to call steward on create
- `scripts/migrate-existing-agents.ts` — one-time migration

---

### Worker 3: `steward-dashboard-live` — Dashboard Wiring & Interactive Flows

**What:** Make every dashboard button actually work. Create agent, approve, reject, set policies — all hitting the live API.

**Current state:** Dashboard displays data from API but interactive forms may not work.

**Verify and fix:**
1. **Create Agent** (`/dashboard/agents` → "New Agent" button)
   - Form: agent ID, name, platform ID
   - Calls `POST /agents` → creates wallet → shows new agent in list
   
2. **Approve/Reject** (`/dashboard/approvals`)
   - "Approve" → `POST /vault/:agentId/approve/:txId` → signs and broadcasts
   - "Reject" → `POST /vault/:agentId/reject/:txId` → marks rejected
   - UI updates immediately (optimistic or refetch)
   
3. **Set Policies** (`/dashboard/agents/[id]`)
   - Edit policy form → `PUT /agents/:agentId/policies`
   - Policy types: spending-limit, approved-addresses, rate-limit, time-window, auto-approve-threshold
   - Show current policies with edit capability

4. **Agent Detail** (`/dashboard/agents/[id]`)
   - Show wallet balance (new endpoint)
   - Transaction history with BaseScan links for real tx hashes
   - Policy status visualization

5. **Settings** (`/dashboard/settings`)
   - Show SDK quickstart code with real credentials
   - Webhook URL config
   - Tenant info

6. **Real-time updates**
   - Add polling or SSE for pending approval count badge
   - Auto-refresh transaction list

**Files to modify:**
- `web/src/app/dashboard/agents/page.tsx` — create agent form
- `web/src/app/dashboard/agents/[id]/page.tsx` — agent detail + policies
- `web/src/app/dashboard/approvals/page.tsx` — approve/reject actions
- `web/src/app/dashboard/settings/page.tsx` — SDK docs
- `web/src/lib/steward-client.ts` — add missing methods if needed

---

### Worker 4: `steward-submission` — README, Docs, Polish

**What:** Production-grade README, architecture docs, SDK examples, and cleanup.

**README.md (root):**
- Problem statement (30 seconds)
- Architecture diagram (the ASCII art above, cleaned up)
- Quick start (docker-compose up, create agent, set policies, sign tx)
- SDK usage examples (JavaScript, curl)
- Live demo links (steward.fi, api.steward.fi, basescan tx)
- Policy types reference
- Webhook events reference
- Contributing guide

**SDK README (`packages/sdk/README.md`):**
```typescript
import { StewardClient } from '@stwd/sdk';

const steward = new StewardClient({
  baseUrl: 'https://api.steward.fi',
  apiKey: 'your-api-key',
  tenantId: 'your-tenant',
});

// Create an agent wallet
const agent = await steward.createWallet('my-agent', 'Trading Bot');

// Set policies
await steward.setPolicies(agent.id, [
  { type: 'spending-limit', config: { maxPerTx: '100000000000000000' } },
  { type: 'approved-addresses', config: { addresses: ['0x...'] } },
]);

// Sign a transaction (policy-enforced)
const result = await steward.signTransaction(agent.id, {
  to: '0x...',
  value: '50000000000000000',
  chainId: 8453,
});
```

**Additional polish:**
- `docker-compose.yml` — working compose for API + postgres
- `.env.example` — all required vars documented
- LICENSE (MIT)
- GitHub Actions CI (build + lint)
- Clean up workspace: remove stale files, fix all TS errors

---

## Deployment Order

1. **Worker 3** (dashboard) + **Worker 4** (docs) can start immediately — no deps
2. **Worker 2** (bridge) needs steward API running — it is
3. **Worker 1** (trader) needs bridge + chain support — goes last

## Chain Decision

waifu.fun runs on BSC (chain 56). Steward currently supports Base (8453, 84532).

**Options:**
- A) Add BSC to Steward vault (just a viem chain config + RPC URL)
- B) Keep demo on Base, add BSC support post-hackathon
- C) Both — demo on Base (we have funded wallet), production on BSC

**Recommendation:** C — demo continues on Base with the funded wallet, Worker 2 adds BSC chain support for production waifu integration.
