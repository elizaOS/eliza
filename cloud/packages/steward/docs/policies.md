# Policy Engine

Steward's policy engine evaluates rules before every signing request. All enabled policies are evaluated and **all must pass** — there is no short-circuit OR logic. If any policy fails, the transaction is either rejected or queued for human approval (depending on the policy type and configuration).

## How Evaluation Works

```
signTransaction(agentId, tx)
  │
  ├── Load agent's policies from DB
  ├── Fetch context:
  │     ├── recentTxCount1h  (transactions in last hour)
  │     ├── recentTxCount24h (transactions in last 24h)
  │     ├── spentToday       (wei value of txns in last 24h)
  │     └── spentThisWeek    (wei value of txns in last 7 days)
  │
  ├── For each enabled policy:
  │     └── evaluatePolicy(rule, context) → { passed, reason }
  │
  ├── If all pass → sign and return { txHash } or { signedTx }
  └── If any fail:
        ├── auto-approve-threshold failure → 202 pending_approval (queued)
        └── other failures → 403 rejected (with policy results)
```

The policy engine is **stateless** — it receives spend totals and tx counts as input from the caller (the API route handler), which queries the DB. The engine itself does not make DB calls.

### USD vs. Wei Evaluation

Spending limits and auto-approve thresholds support both **wei-based** and **USD-based** limits. USD evaluation uses a DexScreener price oracle (free, no API key required) with a 60-second cache. If the price oracle is unavailable, the engine falls back to wei-based comparison with a warning.

---

## Policy Types

### `spending-limit`

Restricts the total value of transactions per-transaction, per-day, or per-week.

**Config:**

```json
{
  "id": "my-spend-limit",
  "type": "spending-limit",
  "enabled": true,
  "config": {
    "maxPerTx": "100000000000000000",
    "maxPerDay": "500000000000000000",
    "maxPerWeek": "2000000000000000000",
    "maxPerTxUsd": 100,
    "maxPerDayUsd": 500,
    "maxPerWeekUsd": 2000
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `maxPerTx` | string (wei) | Maximum value per single transaction |
| `maxPerDay` | string (wei) | Maximum cumulative value in the last 24 hours |
| `maxPerWeek` | string (wei) | Maximum cumulative value in the last 7 days |
| `maxPerTxUsd` | number | Maximum per transaction in USD (requires price oracle) |
| `maxPerDayUsd` | number | Maximum per day in USD |
| `maxPerWeekUsd` | number | Maximum per week in USD |

You can use native (wei) limits, USD limits, or both. When both are present and the oracle is available, USD limits take precedence. Fields you omit default to unlimited.

**Simplified format** (also accepted):

```json
{
  "config": {
    "maxAmount": "100000000000000000",
    "period": "day"
  }
}
```

Valid `period` values: `"tx"`, `"transaction"`, `"day"`, `"daily"`, `"week"`, `"weekly"`.

---

### `approved-addresses`

Restricts which addresses an agent can send to (whitelist) or blocks specific addresses (blacklist).

**Config:**

```json
{
  "id": "address-whitelist",
  "type": "approved-addresses",
  "enabled": true,
  "config": {
    "mode": "whitelist",
    "addresses": [
      "0xUniswapRouterV3",
      "0xAaveLendingPool"
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"whitelist"` or `"blacklist"` | Whitelist: only allow listed addresses. Blacklist: block listed addresses. |
| `addresses` | string[] | EVM addresses (case-insensitive comparison) |

If `mode` is omitted, whitelist behavior is the default.

---

### `auto-approve-threshold`

Transactions below the threshold are automatically signed. Transactions above it are queued in the approval queue for human review instead of being rejected outright.

```json
{
  "id": "auto-approve",
  "type": "auto-approve-threshold",
  "enabled": true,
  "config": {
    "threshold": "50000000000000000",
    "thresholdUsd": 50
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `threshold` | string (wei) | Transactions at or below this value auto-approve |
| `thresholdUsd` | number | USD threshold (preferred when oracle is available) |

When a transaction exceeds the threshold, the API returns `HTTP 202` with:

```json
{
  "status": "pending_approval",
  "results": [
    {
      "policyId": "auto-approve",
      "type": "auto-approve-threshold",
      "passed": false,
      "reason": "Value 100000000000000000 exceeds auto-approve threshold 50000000000000000"
    }
  ]
}
```

The transaction is stored in the approval queue. Use `POST /approvals/{txId}/approve` or `POST /approvals/{txId}/deny` to resolve it.

---

### `rate-limit`

Limits the number of transactions per hour and per day.

```json
{
  "id": "rate-limit",
  "type": "rate-limit",
  "enabled": true,
  "config": {
    "maxTxPerHour": 10,
    "maxTxPerDay": 50
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `maxTxPerHour` | number | Maximum transactions in the last 60 minutes |
| `maxTxPerDay` | number | Maximum transactions in the last 24 hours |

---

### `time-window`

Restricts transactions to specific hours and days of the week (UTC).

```json
{
  "id": "trading-hours",
  "type": "time-window",
  "enabled": true,
  "config": {
    "allowedDays": [1, 2, 3, 4, 5],
    "allowedHours": [
      { "start": 9, "end": 17 }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `allowedDays` | number[] | Day-of-week (0=Sunday, 1=Monday, ..., 6=Saturday). Empty array means all days allowed. |
| `allowedHours` | `{start, end}[]` | UTC hour ranges (24-hour). `start` is inclusive, `end` is exclusive. Empty array means all hours. |

---

### `allowed-chains`

Restricts transactions to specific blockchain networks.

```json
{
  "id": "chain-filter",
  "type": "allowed-chains",
  "enabled": true,
  "config": {
    "chains": ["eip155:8453", "eip155:42161"]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `chains` | string[] | CAIP-2 chain identifiers |

Common chain identifiers:

| Network | CAIP-2 |
|---------|--------|
| Ethereum | `eip155:1` |
| Base | `eip155:8453` |
| Base Sepolia | `eip155:84532` |
| Arbitrum | `eip155:42161` |
| Polygon | `eip155:137` |
| BNB Chain | `eip155:56` |
| Solana Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |

---

## Managing Policies via API

### Get Policies

```http
GET /agents/{agentId}/policies
X-Steward-Tenant: my-tenant
X-Steward-Key: stw_abc123...
```

**Response:**

```json
{
  "ok": true,
  "data": [
    {
      "id": "spend-limit",
      "type": "spending-limit",
      "enabled": true,
      "config": { "maxPerTx": "100000000000000000" }
    }
  ]
}
```

### Set Policies (replace all)

```http
PUT /agents/{agentId}/policies
X-Steward-Tenant: my-tenant
X-Steward-Key: stw_abc123...
Content-Type: application/json

[
  {
    "id": "spend-limit",
    "type": "spending-limit",
    "enabled": true,
    "config": { "maxPerTx": "100000000000000000" }
  }
]
```

This replaces the agent's entire policy set. Send all policies you want active, not just the changed ones.

---

## Policy Results

When a signing request fails policy evaluation, the response includes per-policy results:

```json
{
  "ok": false,
  "error": "Transaction rejected by policy",
  "results": [
    {
      "policyId": "spend-limit",
      "type": "spending-limit",
      "passed": false,
      "reason": "Transaction value 200000000000000000 exceeds per-tx limit 100000000000000000"
    },
    {
      "policyId": "auto-approve",
      "type": "auto-approve-threshold",
      "passed": false,
      "reason": "Value 200000000000000000 exceeds auto-approve threshold 50000000000000000"
    }
  ]
}
```

In the SDK, catch `StewardApiError` and inspect `error.data.results`:

```typescript
import { StewardApiError } from "@stwd/sdk";

try {
  const result = await steward.signTransaction("my-agent", tx);
} catch (err) {
  if (err instanceof StewardApiError && err.data?.results) {
    for (const result of err.data.results) {
      if (!result.passed) {
        console.error(`Policy ${result.policyId} failed: ${result.reason}`);
      }
    }
  }
}
```

---

## Use-Case Examples

### Trading Bot

An autonomous DeFi trading bot that can interact with DEX contracts within daily limits:

```json
[
  {
    "id": "whitelist-dex",
    "type": "approved-addresses",
    "enabled": true,
    "config": {
      "mode": "whitelist",
      "addresses": ["0xUniswapV3Router", "0x1InchRouter", "0xCurvePool"]
    }
  },
  {
    "id": "daily-limit",
    "type": "spending-limit",
    "enabled": true,
    "config": {
      "maxPerDayUsd": 10000
    }
  },
  {
    "id": "auto-approve-small",
    "type": "auto-approve-threshold",
    "enabled": true,
    "config": {
      "thresholdUsd": 1000
    }
  },
  {
    "id": "rate-limit",
    "type": "rate-limit",
    "enabled": true,
    "config": {
      "maxTxPerHour": 20,
      "maxTxPerDay": 100
    }
  },
  {
    "id": "base-only",
    "type": "allowed-chains",
    "enabled": true,
    "config": {
      "chains": ["eip155:8453"]
    }
  }
]
```

### Treasury / Multisig Replacement

A treasury agent that queues all large transactions for human approval:

```json
[
  {
    "id": "require-approval",
    "type": "auto-approve-threshold",
    "enabled": true,
    "config": {
      "thresholdUsd": 100
    }
  },
  {
    "id": "weekly-cap",
    "type": "spending-limit",
    "enabled": true,
    "config": {
      "maxPerWeekUsd": 50000
    }
  },
  {
    "id": "business-hours",
    "type": "time-window",
    "enabled": true,
    "config": {
      "allowedDays": [1, 2, 3, 4, 5],
      "allowedHours": [{ "start": 8, "end": 20 }]
    }
  }
]
```

### Game Economy Agent

An in-game economy agent that pays out small rewards automatically:

```json
[
  {
    "id": "small-tx-only",
    "type": "spending-limit",
    "enabled": true,
    "config": {
      "maxPerTxUsd": 5,
      "maxPerDayUsd": 500
    }
  },
  {
    "id": "auto-approve-all",
    "type": "auto-approve-threshold",
    "enabled": true,
    "config": {
      "thresholdUsd": 5
    }
  },
  {
    "id": "high-frequency",
    "type": "rate-limit",
    "enabled": true,
    "config": {
      "maxTxPerHour": 100,
      "maxTxPerDay": 1000
    }
  }
]
```
