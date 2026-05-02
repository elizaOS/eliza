# Billing Infrastructure Audit — Eliza Cloud Agents

> **Date:** 2026-03-16
> **Auditor:** Sol (subagent lane2-billing-audit)
> **Scope:** Map existing billing infrastructure, define pricing, identify gaps for Eliza agent billing

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Existing Billing Infrastructure](#existing-billing-infrastructure)
3. [Current Billing Flow](#current-billing-flow)
4. [Agent Agent Billing Gap Analysis](#agent-agent-billing-gap-analysis)
5. [Pricing Proposal](#pricing-proposal)
6. [Implementation TODOs](#implementation-todos)
7. [Architecture Diagrams](#architecture-diagrams)

---

## Executive Summary

Eliza Cloud has a **mature, production-ready billing system** with Stripe integration, crypto payments (OxaPay), credit packs, auto-top-up, and a daily container billing cron. However, **Agent sandbox agents are NOT connected to this billing system at all**. Agents can be created, provisioned, and run indefinitely without any credit checks or charges. This is the critical gap.

### What Exists ✅
- Stripe checkout + webhook for credit purchases
- Crypto payments via OxaPay (USDC, BTC, ETH, etc.)
- Credit balance per organization (`organizations.credit_balance`)
- Daily container billing cron (`$0.67/day per AWS container`)
- Auto-top-up (threshold-based, Stripe auto-charge)
- Low-credit email warnings + 48h shutdown grace period
- Credit transaction audit trail
- Affiliate/referral revenue splits
- Invoice generation (Stripe + crypto)

### What's Missing ❌
- **No credit check before Eliza agent provisioning** — anyone can spin up agents for free
- **Container billing cron only queries `containers` table** — Eliza agents live in `agent_sandboxes` (separate table)
- **No billing fields on `agent_sandboxes` schema** — no `billing_status`, `last_billed_at`, `total_billed`, etc.
- **No per-agent cost calculation for Docker-hosted agents** — pricing constants assume AWS ECS
- **No usage dashboard for Eliza agents** — billing UI only shows credit packs + balance

---

## Existing Billing Infrastructure

### 1. Credit System

**Location:** `packages/lib/services/credits.ts`

Credits are USD-denominated, stored as `organizations.credit_balance` (numeric string). The system supports:

| Operation | Method | Details |
|-----------|--------|---------|
| Add credits | `creditsService.addCredits()` | Atomic, idempotent via `stripe_payment_intent_id` |
| Deduct credits | `creditsService.deductCredits()` | Row-level locking (`FOR UPDATE`), prevents negative balance |
| Reserve + deduct | `creditsService.reserveAndDeductCredits()` | Atomic check-and-deduct, prevents TOCTOU race |
| Refund | `creditsService.refundCredits()` | Restores balance + creates refund transaction |
| Reserve (high-level) | `creditsService.reserve()` | Estimates cost, deducts with buffer, returns `reconcile()` callback |

**Key constants:**
- `COST_BUFFER = 1.5` (50% buffer on AI cost estimates)
- `PLATFORM_MARKUP_MULTIPLIER = 1.2` (20% markup on all provider costs)

### 2. Credit Packs

**Schema:** `packages/db/schemas/credit-packs.ts`

Pre-defined purchase amounts with Stripe price IDs. Stored in `credit_packs` table.

| Field | Type | Description |
|-------|------|-------------|
| `name` | text | Pack name |
| `credits` | numeric(10,2) | Credit amount in USD |
| `price_cents` | integer | Stripe price in cents |
| `stripe_price_id` | text | Stripe Price ID |
| `stripe_product_id` | text | Stripe Product ID |
| `is_active` | boolean | Whether pack is available |

Custom amounts also supported ($1-$1000 range).

### 3. Stripe Integration

**Key files:**
- `app/api/stripe/create-checkout-session/route.ts` — Creates Stripe Checkout sessions
- `app/api/stripe/webhook/route.ts` — Handles `checkout.session.completed` + `payment_intent.succeeded`
- `packages/lib/services/payment-methods.ts` — Payment method management
- `packages/lib/services/auto-top-up.ts` — Automatic balance replenishment

**Flow:** User → Checkout Session → Stripe Payment → Webhook → `creditsService.addCredits()` → Balance updated

### 4. Crypto Payments (OxaPay)

**File:** `packages/lib/services/crypto-payments.ts`

Full crypto payment flow via OxaPay redirect. Supports USDC, BTC, ETH, and other currencies. Creates invoice → user pays → webhook confirms → credits added. Same `creditsService.addCredits()` endpoint.

### 5. Auto-Top-Up

**File:** `packages/lib/services/auto-top-up.ts`

When balance drops below threshold, automatically charges the default Stripe payment method:
- Min amount: $1, Max: $1000
- Min threshold: $0, Max: $1000
- Uses Stripe `off_session` payment with idempotency key
- Disables itself on payment failure (sends email notification)

### 6. Container Billing Cron

**File:** `app/api/cron/container-billing/route.ts`

**Schedule:** Daily at midnight UTC

**What it does:**
1. Queries `containers` table for `status = 'running'` and `billing_status IN ('active', 'warning', 'shutdown_pending')`
2. Calculates daily cost per container: **$0.67/day** base (with 20% markup over $0.56 AWS cost)
3. Deducts from `organizations.credit_balance`
4. Creates `credit_transactions` record (type: `debit`)
5. Creates `container_billing_records` entry
6. If insufficient credits: sends 48h shutdown warning email
7. After 48h warning period: stops container, marks `billing_status = 'suspended'`

**Pricing formula:**
```
baseCost = $0.67/day per container
+ CPU premium if > 1 vCPU (linear multiplier)
+ Memory premium if > 2GB (sub-linear sqrt multiplier)
× number of instances
```

**Monthly equivalent:** ~$20/month per standard container (1 vCPU, 2GB RAM)

### 7. Old Credits Bridge (eliza-cloud legacy)

**File:** `/home/shad0w/projects/eliza-cloud/backend/services/eliza-credits-client.ts`

The old eliza-cloud Express backend had a client that called Eliza Cloud's API to check credit balances:
- `GET /api/v1/credits/balance` with `Bearer <eliza_api_key>`
- `checkSufficientCredits(apiKey, estimatedCost)` — checks balance >= cost

This was the **intended integration point** but was never wired into the provisioning flow. The old backend is being superseded by Eliza Cloud's native Agent API routes.

---

## Current Billing Flow

### How Credits Are Purchased

```
User clicks "Add Funds" in /dashboard/billing
  ├── Credit Pack → Stripe Checkout (pre-defined price)
  ├── Custom Amount → Stripe Checkout ($1-$1000, dynamic line item)
  └── Crypto → OxaPay redirect → webhook confirms payment

Stripe/OxaPay Webhook fires
  → creditsService.addCredits(orgId, amount, paymentIntentId)
  → organizations.credit_balance += amount (atomic, row-locked)
  → credit_transactions record created (type: 'credit')
  → invoice record created
  → Discord payment notification (fire-and-forget)
```

### How Credits Are Consumed

| Consumer | Billing Method | Connected? |
|----------|---------------|------------|
| AI inference (text gen) | Per-request, reserve + reconcile | ✅ Yes |
| Image generation | Per-image ($0.01) | ✅ Yes |
| Video generation | Per-video ($0.05) | ✅ Yes |
| TTS / STT | Per-1K chars / per-minute | ✅ Yes |
| AWS ECS Containers | Daily cron ($0.67/day) | ✅ Yes |
| Blockchain API proxy | Per-call ($0.0003-$0.001) | ✅ Yes |
| **Agent sandbox agents** | **NOT BILLED** | ❌ **NO** |

### Container Billing Cron vs Agent Sandboxes

The container billing cron queries the **`containers`** table — this is for AWS ECS deployments.
Eliza agents live in the **`agent_sandboxes`** table — a completely separate schema.

**`agent_sandboxes` has NO billing columns:**
- No `billing_status`
- No `last_billed_at` / `next_billing_at`
- No `total_billed`
- No `shutdown_warning_sent_at` / `scheduled_shutdown_at`

The cron will never find Eliza agents. They run for free.

---

## Agent Agent Billing Gap Analysis

### 1. No Pre-Provisioning Credit Check

**Where provisioning happens:** `packages/lib/services/agent-sandbox.ts` → `provision()`

**What happens:**
1. Finds sandbox record in DB
2. Sets status to `provisioning`
3. Creates Neon DB
4. Creates Docker container on remote node
5. Health check
6. Marks `running`

**What should happen:**
1. **CHECK: Does org have sufficient credits for at least 1 day of agent hosting?**
2. **DEDUCT: Charge deployment fee**
3. Proceed with provisioning

**Also missing from agent creation:** `app/api/v1/eliza/agents/route.ts` POST handler creates agents with no credit check.

### 2. No Ongoing Billing

No cron or mechanism charges for running Eliza agents. They run indefinitely without consuming credits.

### 3. No Billing-Driven Lifecycle

No mechanism to:
- Warn users when credits are low (specific to their running agents)
- Suspend agents when credits run out
- Resume agents when credits are added

### 4. Schema Gap

`agent_sandboxes` table needs billing columns to match `containers` table capabilities.

### 5. Pricing Model Mismatch

Container billing assumes AWS ECS costs ($0.56/day base → $0.67/day with markup).
Eliza agents run on **dedicated Hetzner servers** with very different cost structure.

---

## Pricing Proposal

### Infrastructure Costs

| Item | Monthly Cost | Notes |
|------|-------------|-------|
| Hetzner AX42 (dedicated) | ~€40-50/mo (~$44-55) | 32GB RAM, 8-core Ryzen, 2×512GB NVMe |
| Neon DB per agent | ~$0/mo (free tier) | Each agent gets a free-tier Neon project |
| Cloudflare tunnel | $0 | Already configured |
| Headscale/Tailscale | $0 | Self-hosted coordination |

### Capacity per Server

From handoff context: **~8 agents per 32GB RAM server** at comfortable capacity.

```
Server cost: $50/month
Per-agent infra cost: $50 / 8 = $6.25/month
Per-agent-day infra cost: $6.25 / 30 = ~$0.21/day
```

### Suggested Pricing Tiers

| Tier | Daily Cost | Monthly Cost | Margin | Target User |
|------|-----------|-------------|--------|-------------|
| **Basic Agent** | $0.50/day | $15/mo | 140% | Personal projects, testing |
| **Standard Agent** | $0.67/day | $20/mo | 220% | Production agents, businesses |
| **Power Agent** | $1.00/day | $30/mo | 380% | High-memory, priority support |

**Recommendation:** Start with **Standard Agent at $0.67/day ($20/mo)** to match existing container pricing. This:
- Provides familiar pricing (same as AWS containers already in the system)
- Gives ~220% margin over infra costs at capacity (good for covering overhead, support, underutilization)
- Can adjust later as we understand real utilization patterns

### Deployment Fee

| Action | Cost | Rationale |
|--------|------|-----------|
| Agent deployment | $0.50 (one-time) | Covers Neon DB provisioning + Docker setup |
| Re-deployment | $0.25 | Lighter operation (reuse existing DB) |
| Image upload | $0.00 | N/A for Agent (pre-built images) |

### Free Trial Proposal

**Option A (Recommended):** First agent free for 24 hours
- Low friction for new users
- Enough time to evaluate the platform
- Auto-stop at 24h mark if no credits added
- Cost: ~$0.21 infra cost per trial

**Option B:** $5 credit bonus on first signup
- User gets to experience billing flow
- ~7 days of a basic agent
- More expensive but stickier

### AI Inference Costs (Pass-Through)

When agents use AI features (via `cloudProvider: "elizacloud"` + `ELIZAOS_API_KEY`), those costs are already billed through the existing AI billing system:
- Text gen: per-token with 20% markup
- Image/video gen: flat rate per generation
- Blockchain API proxy: per-call

These are **separate from hosting costs** and already working. The agent's `ELIZAOS_API_KEY` ties inference to the org's credit balance.

---

## Implementation TODOs

### Phase 1: Schema + Basic Enforcement (P0 — Do First)

- [ ] **2.A** Add billing columns to `agent_sandboxes`:
  ```sql
  ALTER TABLE agent_sandboxes ADD COLUMN billing_status TEXT DEFAULT 'active';
  ALTER TABLE agent_sandboxes ADD COLUMN last_billed_at TIMESTAMPTZ;
  ALTER TABLE agent_sandboxes ADD COLUMN next_billing_at TIMESTAMPTZ;
  ALTER TABLE agent_sandboxes ADD COLUMN total_billed NUMERIC(10,2) DEFAULT '0';
  ALTER TABLE agent_sandboxes ADD COLUMN shutdown_warning_sent_at TIMESTAMPTZ;
  ALTER TABLE agent_sandboxes ADD COLUMN scheduled_shutdown_at TIMESTAMPTZ;
  ```

- [ ] **2.B** Add Agent pricing constants to `packages/lib/constants/pricing.ts`:
  ```typescript
  export const AGENT_PRICING = {
    DAILY_RUNNING_COST: 0.67,        // $0.67/day per agent
    DEPLOYMENT_COST: 0.50,            // $0.50 per deployment
    REDEPLOYMENT_COST: 0.25,          // $0.25 per re-deployment
    MIN_BALANCE_FOR_PROVISION: 1.00,  // Minimum $1 to start an agent
    SHUTDOWN_WARNING_HOURS: 48,
    LOW_CREDITS_WARNING_DAYS: 3,
  };
  ```

- [ ] **2.C** Add credit check before provisioning in `agent-sandbox.ts` → `provision()`:
  ```typescript
  // Before provisioning, check org has sufficient credits
  const org = await organizationsRepository.findById(orgId);
  const balance = Number(org.credit_balance);
  if (balance < AGENT_PRICING.MIN_BALANCE_FOR_PROVISION) {
    return { success: false, error: 'Insufficient credits' };
  }
  // Deduct deployment fee
  await creditsService.deductCredits({
    organizationId: orgId,
    amount: AGENT_PRICING.DEPLOYMENT_COST,
    description: `Agent deployment: ${agentName}`,
  });
  ```

- [ ] **2.D** Add credit check in API route `app/api/v1/eliza/agents/[agentId]/provision/route.ts`

### Phase 2: Billing Cron (P0 — Do With Phase 1)

- [ ] **2.E** Create `app/api/cron/agent-billing/route.ts`:
  - Query `agent_sandboxes WHERE status = 'running'`
  - Calculate daily cost per agent ($0.67/day)
  - Deduct from org balance (atomic transaction)
  - Create credit transaction record
  - Handle insufficient credits: send warning → 48h → shutdown
  - Mirror the pattern from `container-billing/route.ts` exactly

- [ ] **2.F** Add wrangler cron trigger for agent-billing (daily at midnight UTC)

### Phase 3: Billing UI (P1 — After Core Billing Works)

- [ ] **2.G** Show per-agent costs in the Agent Instances dashboard:
  - Daily cost column
  - Total billed column
  - Billing status badge (active / warning / suspended)

- [ ] **2.H** Add "Agent Agent Hosting" line items to credit transaction history

- [ ] **2.I** Billing notification emails:
  - Low credits warning (template exists: `email/templates/low-credits.html`)
  - Shutdown warning (48h notice)
  - Agent suspended notification

### Phase 4: Free Trial (P2 — Nice to Have)

- [ ] **2.J** Implement free trial logic:
  - Track `has_used_trial` flag on organization
  - First agent gets 24h free hosting
  - Auto-stop cron after trial expires
  - Prompt to add credits for continued service

### Phase 5: Crypto Billing Path (P2 — Already Working)

The crypto payment path via OxaPay is **already functional** for buying credits. No Agent-specific work needed here — once credits are in the org balance, they work identically whether purchased via Stripe or crypto. The billing cron doesn't care how credits were obtained.

### Future Considerations

- [ ] **Usage-based pricing** — charge per AI inference token consumed by the agent (already happening via `ELIZAOS_API_KEY`)
- [ ] **Tiered pricing** — different daily rates for different resource allocations
- [ ] **Volume discounts** — reduced rate for 3+ agents in same org
- [ ] **Pre-paid plans** — monthly subscription at discount ($15/mo instead of $20 pay-as-you-go)
- [ ] **USDC on-chain billing** — direct smart contract payments (longer term, not in scope now)

---

## Architecture Diagrams

### Current State (No Billing)

```
User → Create Agent → POST /api/v1/eliza/agents (no credit check)
                          ↓
User → Provision Agent → POST /api/v1/eliza/agents/:id/provision (no credit check)
                          ↓
     Docker container starts on Hetzner node
                          ↓
     Agent runs indefinitely... (no billing)
```

### Target State (With Billing)

```
User → Create Agent → POST /api/v1/eliza/agents
                          ↓
User → Provision Agent → POST /api/v1/eliza/agents/:id/provision
                          ↓
                    ┌── Credit Check ──┐
                    │ balance >= $1.00?│
                    └──┬──────────┬───┘
                       │ YES      │ NO → 402 "Insufficient credits"
                       ↓
              Deduct $0.50 deployment fee
                       ↓
              Docker container starts
                       ↓
              Agent runs...
                       ↓
         ┌── Daily Billing Cron (midnight UTC) ──┐
         │ For each running agent_sandbox:       │
         │   balance >= $0.67?                    │
         │   YES → deduct $0.67, log transaction  │
         │   NO  → send 48h warning email         │
         │   48h expired → stop agent, suspend    │
         └────────────────────────────────────────┘
```

### Billing System Integration Map

```
                    ┌─────────────────────────┐
                    │     Credit Balance       │
                    │  organizations.credit_   │
                    │        balance           │
                    └──────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
     │ Stripe        │ │ OxaPay      │ │ Auto-Top-Up  │
     │ credit packs  │ │ crypto      │ │ threshold    │
     │ custom amount │ │ payments    │ │ charge       │
     └───────────────┘ └─────────────┘ └──────────────┘
              ↑ ADD                        ↑ ADD
              
              │ DEDUCT                     │ DEDUCT
     ┌────────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
     │ AI Inference  │ │ Container   │ │ Agent       │
     │ (per-token)   │ │ Billing     │ │ Agent        │
     │ ✅ WORKING    │ │ (daily AWS) │ │ Billing      │
     │               │ │ ✅ WORKING  │ │ ❌ MISSING   │
     └───────────────┘ └─────────────┘ └──────────────┘
```

---

## Files Referenced

| File | Purpose |
|------|---------|
| `app/api/cron/container-billing/route.ts` | Daily AWS container billing cron |
| `packages/lib/constants/pricing.ts` | Container pricing constants ($0.67/day) |
| `packages/lib/services/credits.ts` | Core credit management service |
| `packages/lib/services/auto-top-up.ts` | Automatic balance replenishment |
| `packages/lib/services/crypto-payments.ts` | OxaPay crypto payment flow |
| `app/api/stripe/create-checkout-session/route.ts` | Stripe checkout creation |
| `app/api/stripe/webhook/route.ts` | Stripe webhook handler |
| `app/api/v1/eliza/agents/route.ts` | Eliza agent CRUD (no credit check) |
| `app/api/v1/eliza/agents/[agentId]/provision/route.ts` | Provisioning endpoint (no credit check) |
| `packages/lib/services/agent-sandbox.ts` | Sandbox lifecycle management |
| `packages/lib/services/agent-managed-launch.ts` | Managed agent launch + onboarding |
| `packages/db/schemas/agent-sandboxes.ts` | Schema (missing billing columns) |
| `packages/db/schemas/containers.ts` | Container schema (has billing columns) |
| `eliza-cloud/backend/services/eliza-credits-client.ts` | Legacy credit bridge (unused) |
