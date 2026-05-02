# Steward

**Agent wallet infrastructure with policy enforcement.**

Tracks: Agents that Pay (primary) / Agents that Trust (secondary)

---

## The Problem

Every agent framework is shipping wallets. Eliza, CrewAI, LangChain, the next ten that launch this month. The default implementation is the same everywhere: generate a private key, store it in an env var, let the agent sign whatever it wants.

No spending limits. No address restrictions. No human oversight. No audit trail.

One hallucination. One prompt injection. One bug in your tool-calling logic. The wallet is drained. There is no undo on a blockchain.

This is not a theoretical risk. This is the default architecture shipping today.

We think the fix is obvious: **don't give the agent the key.** Give it a wallet it can *operate* but never *possess*. Enforce policies on every transaction before the key is ever touched. Make the boundaries programmable, composable, and transparent.

That's Steward.

---

## What Steward Is

Steward is not an app. It is not a wallet. It is infrastructure.

It sits between agent frameworks and chains, enforcing composable policies on every transaction an agent attempts to sign. Spending limits, address whitelists, rate limits, time windows, auto-approve thresholds. All configurable per agent, evaluated statelessly, enforced before the key is ever touched.

Multi-tenant by design. One Steward instance serves an entire platform. Eliza Cloud runs one for all their agents. waifu.fun runs one for all theirs. Any framework, any scale.

The agent never sees the private key. The agent never holds the private key. The agent requests a transaction and Steward decides whether to sign it, reject it, or queue it for human review.

---

## Architecture

```
Agent / Platform
       │
       ▼
   Steward SDK          (3 calls: create wallet, set policies, sign)
       │
       ▼
   Policy Engine         (stateless, composable, 5 policy types)
       │
       ├── PASS ──────► Vault (AES-256-GCM) ──► sign ──► broadcast ──► chain
       │
       ├── SOFT FAIL ──► Approval Queue ──► Dashboard / Webhook ──► human decides
       │
       └── HARD FAIL ──► reject immediately ──► webhook fired
```

**Vault.** Each agent's private key is encrypted with AES-256-GCM. The encryption key is derived from a master password combined with the agent's unique ID. Keys never exist in plaintext outside of a signing operation. The raw key is never sent over the wire. It is decrypted in-process, used to sign, then discarded.

**Policy Engine.** Stateless evaluation. The engine receives a transaction request plus pre-fetched spend and rate context. It evaluates all enabled policies and returns a per-policy pass/fail result. Hard policies (spending limits, address restrictions, rate limits, time windows) reject immediately on failure. The auto-approve threshold is the only soft gate: failure queues the transaction for human review instead of rejecting it.

**Approval Queue.** Transactions that exceed the auto-approve threshold land in a queue. Humans approve or reject through the dashboard. Webhooks fire on every state change: `approval_required`, `tx_signed`, `tx_rejected`, `tx_failed`.

**Multi-tenant isolation.** Every API call is scoped to a tenant. Agents, policies, transactions, and keys are isolated. One tenant cannot access another tenant's data. Auth uses SHA-256 hashed API keys validated with `timingSafeEqual`.

---

## What We Built

This is not a pitch deck. Everything listed here is deployed, running, and processing real transactions on Base mainnet.

| Package | What it does | Lines |
|---------|-------------|-------|
| `@stwd/api` | Hono REST API. Agents, policies, approvals, signing, health checks. Multi-tenant middleware. | 1,074 |
| `@stwd/vault` | AES-256-GCM encrypted keystore. Key derivation from master password + agent ID. Transaction signing via viem. Supports Base, Base Sepolia, BSC, BSC Testnet. | 391 |
| `@stwd/policy-engine` | 5 composable policy types. Stateless evaluation. Hard/soft failure modes. | 207 |
| `@stwd/sdk` | TypeScript HTTP client ([npm](https://npmjs.com/package/@stwd/sdk)). `createWallet`, `signTransaction`, `signMessage`, `setPolicies`, `getPolicies`, `getAgent`, `listAgents`, `getHistory`, `getBalance`, `createWalletBatch`. | 412 |
| `@stwd/db` | Drizzle ORM + PostgreSQL. Tenants, agents, policies, transactions, approval queue tables. Migration support. | 402 |
| `@stwd/auth` | SHA-256 + `timingSafeEqual` API key validation. Tenant-scoped middleware. | 100 |
| `@stwd/webhooks` | Fire-and-forget event dispatcher. Retry queue. 4 event types. | 291 |
| `@stwd/shared` | Shared types, interfaces, constants across all packages. | 144 |
| `@stwd/seed` | Database seeding with realistic demo data. Multi-tenant setup, agent provisioning, transaction history generation. | 752 |
| `web` (dashboard) | Next.js 15. Overview stats, agent list with create flow, pending approvals with approve/reject, transaction history with BaseScan links, settings with SDK quickstart. | 2,965 |
| `agent-trader` | Autonomous trading agent example. 3 strategies: rebalance, DCA, threshold. All transactions signed through Steward SDK. Dry-run mode. | 1,754 |
| `waifu-integration` | Full integration example for waifu.fun. Tenant registration, batch agent provisioning, webhook listener, policy-enforced trading with USDC/Uniswap. | 474 |

**Total: ~8,966 lines of TypeScript across 12 packages in a Bun/Turborepo monorepo.**

### Policy Types

| Type | Behavior | Mode |
|------|----------|------|
| `spending-limit` | Cap per transaction, per day, per week (wei) | Hard |
| `approved-addresses` | Whitelist or blocklist destination addresses | Hard |
| `rate-limit` | Max transactions per hour, per day | Hard |
| `time-window` | Only allow transactions during defined UTC hours | Hard |
| `auto-approve-threshold` | Auto-sign below threshold, queue above for human review | Soft |

Policies are composable. Stack any combination per agent. Hard policies reject immediately. The auto-approve threshold is the only soft gate, routing to human review on failure.

### Tech Stack

Bun runtime. Hono framework. TypeScript. viem for signing. Drizzle ORM. PostgreSQL. Next.js 15. Framer Motion. Tailwind CSS. Vercel (dashboard). systemd + cloudflared (API).

---

## Live Demo

This runs on real ETH. Base mainnet. Not testnet.

| What | Link |
|------|------|
| On-chain transaction (Base mainnet) | [basescan.org/tx/0x8d7592b...](https://basescan.org/tx/0x8d7592b93cad0983b481451c6d0c05900a1c6d74ee7eadbcdc7533a77ae45dc0) |
| Dashboard | [steward.fi/dashboard](https://steward.fi/dashboard) |
| Landing page | [steward.fi](https://steward.fi) |
| API health | [api.steward.fi/health](https://api.steward.fi/health) |
| npm package | [npmjs.com/package/@stwd/sdk](https://npmjs.com/package/@stwd/sdk) |
| GitHub | [github.com/Steward-Fi/steward](https://github.com/Steward-Fi/steward) |

### Demo Walkthrough

Here's what to try:

1. **Visit [steward.fi](https://steward.fi)** → Landing page explains the problem and the architecture.
2. **Click "Launch Dashboard"** → See live agents, transaction history, pending approvals. This is seeded with realistic data from the waifu.fun integration.
3. **Click any agent** → See its policies (spending limits, whitelists, rate limits), wallet balance, and full transaction history with BaseScan links.
4. **Check the approval queue** → Transactions above the auto-approve threshold are queued here. Approve or reject them with one click.
5. **Try the SDK yourself:**
   ```bash
   npm i @stwd/sdk
   ```
   ```typescript
   import { StewardClient } from '@stwd/sdk';

   const steward = new StewardClient({
     baseUrl: 'https://api.steward.fi',
     tenantId: 'my-platform',
     apiKey: 'my-key',
   });

   const agent = await steward.createWallet('my-agent', 'My Agent');
   console.log(agent.walletAddress); // 0x...
   ```
6. **Verify on-chain** → [View the proof transaction on BaseScan](https://basescan.org/tx/0x8d7592b93cad0983b481451c6d0c05900a1c6d74ee7eadbcdc7533a77ae45dc0). This is a real ETH transfer on Base mainnet, signed through Steward's vault after passing policy evaluation.

---

## SDK

Three calls. That is the entire integration surface.

```typescript
import { StewardClient } from '@stwd/sdk';

const steward = new StewardClient({
  baseUrl: 'https://api.steward.fi',
  tenantId: 'my-platform',
  apiKey: 'my-key',
});

// 1. Create a wallet for an agent
const agent = await steward.createWallet('trading-bot-1', 'Trading Bot');
// => { id: 'trading-bot-1', walletAddress: '0x...' }

// 2. Set policies
await steward.setPolicies(agent.id, [
  {
    id: 'spend',
    type: 'spending-limit',
    enabled: true,
    config: {
      maxPerTx: '100000000000000000',   // 0.1 ETH
      maxPerDay: '1000000000000000000',  // 1 ETH
    },
  },
  {
    id: 'addrs',
    type: 'approved-addresses',
    enabled: true,
    config: { mode: 'whitelist', addresses: ['0xDEX...'] },
  },
  {
    id: 'approval',
    type: 'auto-approve-threshold',
    enabled: true,
    config: { threshold: '50000000000000000' }, // 0.05 ETH
  },
]);

// 3. Sign a transaction
const result = await steward.signTransaction(agent.id, {
  to: '0xDEX...',
  value: '30000000000000000', // 0.03 ETH, under threshold
  chainId: 8453,
});
// => { txHash: '0x...' }  (auto-approved, signed, broadcast)

// If the value were 0.08 ETH (above threshold):
// => { status: 'pending_approval' }  (queued for human review)
```

The agent never sees a private key. The platform defines the boundaries. Steward enforces them.

---

## Track Alignment

### Agents that Pay

Steward is purpose-built for this track.

- **Policy-enforced spending.** Agents do not get unrestricted access to funds. Every transaction passes through configurable policies before a key is touched.
- **Managed wallets.** Platforms create wallets for agents through the SDK. The agent operates the wallet. It never possesses the wallet.
- **Audit trail.** Every transaction, every policy evaluation, every approval decision is logged. Full history queryable through the API and visible in the dashboard.
- **Multi-tenant architecture.** One instance serves an entire platform's worth of agents. Designed for infrastructure scale, not single-agent demos.
- **Real money, real chain.** Live on Base mainnet with verified on-chain transactions.

### Agents that Trust

Trust requires guarantees, not promises.

- **Cryptographic key isolation.** AES-256-GCM encryption at rest. Key derivation per agent. Keys never exist in plaintext outside signing. The agent cannot exfiltrate its own key.
- **Composable policies.** Trust boundaries are not binary. Platforms define granular, composable rules that express exactly how much trust each agent has earned.
- **Human-in-the-loop approvals.** The auto-approve threshold creates a trust gradient. Small transactions flow automatically. Large ones require human sign-off. The boundary is configurable.
- **Transparent decision logging.** Every policy evaluation result is recorded. When a transaction is rejected, the agent and the platform know exactly which policy failed and why.
- **Webhook notifications.** Async notification on every state change. Platforms can build their own monitoring, alerting, and compliance layers on top.

---

## Why This Matters

The question is not whether agents will control money. They already do.

The question is whether they will do it with guardrails or without them. Right now, the answer is without. The default in every major agent framework is a raw private key with no restrictions. The agent is trusted completely or not at all.

That is not how trust works. Trust is graduated, scoped, and earned. A new agent gets a small spending limit and a tight address whitelist. A proven agent gets higher thresholds and broader permissions. A critical transaction gets human review. This is how organizations already manage human spending authority. Cards have limits. Employees have approval workflows. Wire transfers require sign-off.

Steward brings that same model to agents. Not by restricting what agents can do, but by defining the boundaries within which they operate. The agent is autonomous within its policy envelope. The human defines the envelope.

The future is not agents OR humans controlling money. It is agents spending within human-defined boundaries. Steward is the infrastructure that makes that possible.

---

## What's Next

- **ERC-8004 identity.** On-chain agent identity tied to Steward wallets. Verifiable agent credentials for cross-platform trust portability.
- **Cross-chain expansion.** Arbitrum, Optimism, Polygon, Solana. The policy engine is chain-agnostic by design — the vault needs signing adapters per chain.
- **Eliza Cloud integration.** Native Steward plugin for Eliza. Every Eliza agent gets a policy-enforced wallet out of the box. We're in conversations.
- **Policy marketplace.** Pre-built policy templates for common use cases: DeFi trading, NFT minting, payment processing, treasury management. Import, customize, deploy.
- **Session keys.** Temporary, scoped signing authority for specific operations. Time-bound, operation-bound, revocable. Think OAuth for transaction signing.

---

## Team

Built by [Steward-Fi](https://github.com/Steward-Fi). Solo builder. ~9,000 lines of TypeScript. Everything deployed. Everything real.

---

*Steward. The missing layer between agents and chains.*
