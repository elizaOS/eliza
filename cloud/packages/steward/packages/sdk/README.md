# @stwd/sdk

TypeScript client for the [Steward](https://steward.fi) API. Use this in your agents, bots, or platform integrations to create wallets, set policies, and submit transactions for signing.

## Installation

```bash
npm install @stwd/sdk
# bun add @stwd/sdk
# pnpm add @stwd/sdk
```

## Quick Start

```typescript
import { StewardClient } from '@stwd/sdk';

const steward = new StewardClient({
  baseUrl: 'https://api.steward.fi',
  tenantId: 'my-platform',
  apiKey: 'sk-...',
});

const agent = await steward.createWallet('agent-1', 'My Trading Bot');
console.log(agent.walletAddress); // 0x...

const result = await steward.signTransaction(agent.id, {
  to: '0xSomeContract',
  value: '10000000000000000', // 0.01 ETH in wei
  chainId: 8453,
});

if ('txHash' in result) {
  console.log('Broadcast:', result.txHash);
} else {
  // result.status === 'pending_approval'
  console.log('Queued for human review');
}
```

---

## Constructor

```typescript
new StewardClient(config: StewardClientConfig)
```

### `StewardClientConfig`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | `string` | ✅ | Base URL of the Steward API (e.g. `https://api.steward.fi`) |
| `apiKey` | `string` | — | API key sent as `X-Steward-Key` header |
| `tenantId` | `string` | — | Tenant ID sent as `X-Steward-Tenant` header |

---

## Methods

### `createWallet`

Create a new agent wallet. Steward generates a keypair, encrypts it in the vault, and returns the agent identity.

```typescript
createWallet(agentId: string, name: string, platformId?: string): Promise<AgentIdentity>
```

| Param | Description |
|-------|-------------|
| `agentId` | Unique identifier for the agent within your tenant |
| `name` | Human-readable label (e.g. `"DeFi Scout Bot"`) |
| `platformId` | Optional external ID (e.g. your platform's agent UUID) |

**Returns:** [`AgentIdentity`](#agentidentity)

```typescript
const agent = await steward.createWallet('scout-1', 'DeFi Scout', 'ext-uuid-123');
// { id: 'scout-1', walletAddress: '0x...', tenantId: '...', name: '...', createdAt: Date }
```

---

### `getAgent`

Fetch an agent by ID.

```typescript
getAgent(agentId: string): Promise<AgentIdentity>
```

---

### `listAgents`

List all agents for the authenticated tenant.

```typescript
listAgents(): Promise<AgentIdentity[]>
```

---

### `signTransaction`

Submit a transaction for policy evaluation and signing.

```typescript
signTransaction(agentId: string, tx: SignTransactionInput): Promise<SignTransactionResult>
```

#### `SignTransactionInput`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | `string` | ✅ | Destination address |
| `value` | `string` | ✅ | Value in wei (as string to avoid BigInt issues) |
| `data` | `string` | — | Hex-encoded calldata |
| `chainId` | `number` | — | EVM chain ID (defaults to the server's configured chain) |

#### `SignTransactionResult`

The return type is a discriminated union:

```typescript
type SignTransactionResult =
  | { txHash: string }           // signed and broadcast
  | { status: 'pending_approval'; results: PolicyResult[] }  // queued
```

```typescript
const result = await steward.signTransaction('scout-1', {
  to: '0xDEX...',
  value: '50000000000000000', // 0.05 ETH
  chainId: 8453,
});

if ('txHash' in result) {
  // Transaction was auto-approved and broadcast
  console.log('tx:', result.txHash);
} else {
  // Value exceeded auto-approve threshold — needs human sign-off
  console.log('queued, policy results:', result.results);
}
```

**Throws:** [`StewardApiError`](#stearderAPIerror) with status `400` if a hard policy rejects the transaction. `error.data.results` contains per-policy details.

---

### `signMessage`

Sign an arbitrary message (EIP-191 personal sign) with the agent's key.

```typescript
signMessage(agentId: string, message: string): Promise<SignMessageResult>
```

```typescript
const { signature } = await steward.signMessage('scout-1', 'Hello Steward');
```

---

### `getPolicies`

Retrieve the current policy rules for an agent.

```typescript
getPolicies(agentId: string): Promise<PolicyRule[]>
```

---

### `setPolicies`

Replace the full policy set for an agent (PUT semantics — replaces all existing policies).

```typescript
setPolicies(agentId: string, policies: PolicyRule[]): Promise<void>
```

```typescript
await steward.setPolicies('scout-1', [
  {
    id: 'daily-cap',
    type: 'spending-limit',
    enabled: true,
    config: {
      maxPerTx:   '100000000000000000',  // 0.1 ETH
      maxPerDay:  '500000000000000000',  // 0.5 ETH
      maxPerWeek: '2000000000000000000', // 2 ETH
    },
  },
  {
    id: 'whitelist',
    type: 'approved-addresses',
    enabled: true,
    config: {
      mode: 'whitelist',
      addresses: [
        '0xUniswapRouter...',
        '0xAavePool...',
      ],
    },
  },
  {
    id: 'hours',
    type: 'time-window',
    enabled: true,
    config: {
      allowedHours: [{ start: 9, end: 17 }], // 09:00–17:00 UTC
      allowedDays: [1, 2, 3, 4, 5],           // Mon–Fri
    },
  },
  {
    id: 'rate',
    type: 'rate-limit',
    enabled: true,
    config: {
      maxTxPerHour: 10,
      maxTxPerDay: 50,
    },
  },
  {
    id: 'auto',
    type: 'auto-approve-threshold',
    enabled: true,
    config: {
      threshold: '10000000000000000', // auto-sign below 0.01 ETH, queue above
    },
  },
]);
```

---

### `getBalance`

Get the on-chain native balance for an agent wallet. Optionally pass a `chainId` to query a specific network (defaults to the server's active chain).

```typescript
getBalance(agentId: string, chainId?: number): Promise<AgentBalance>
```

```typescript
const balance = await steward.getBalance('scout-1');
// { balance: '1500000000000000000', formatted: '1.5', symbol: 'ETH', chainId: 8453 }

// Query a specific chain
const bscBalance = await steward.getBalance('scout-1', 56);
```

---

### `getHistory`

Retrieve signing history for an agent.

```typescript
getHistory(agentId: string): Promise<StewardHistoryEntry[]>
```

```typescript
interface StewardHistoryEntry {
  timestamp: number; // Unix ms
  value: string;     // wei
}
```

---

### `createWalletBatch`

Create multiple agent wallets in a single request. Optionally supply a shared policy set to apply to every created agent.

```typescript
createWalletBatch(
  agents: BatchAgentSpec[],
  policies?: PolicyRule[]
): Promise<BatchCreateResult>
```

#### `BatchAgentSpec`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✅ | Unique identifier for the agent |
| `name` | `string` | ✅ | Human-readable label |
| `platformId` | `string` | — | Optional external ID |

#### `BatchCreateResult`

```typescript
interface BatchCreateResult {
  created: AgentIdentity[];
  errors: Array<{ id: string; error: string }>;
}
```

```typescript
const result = await steward.createWalletBatch(
  [
    { id: 'agent-1', name: 'Scout Alpha' },
    { id: 'agent-2', name: 'Scout Beta' },
    { id: 'agent-3', name: 'Scout Gamma' },
  ],
  [
    {
      id: 'spend',
      type: 'spending-limit',
      enabled: true,
      config: { maxPerTx: '100000000000000000', maxPerDay: '500000000000000000' },
    },
  ]
);

console.log(`Created ${result.created.length} agents`);
if (result.errors.length) {
  console.warn('Failures:', result.errors);
}
```

---

## Types

### `AgentIdentity`

```typescript
interface AgentIdentity {
  id: string;
  tenantId: string;
  name: string;
  walletAddress: string;   // checksummed EVM address
  platformId?: string;     // your external agent ID, if provided
  erc8004TokenId?: string; // on-chain agent NFT ID, if registered
  createdAt: Date;
}
```

### `PolicyRule`

```typescript
interface PolicyRule {
  id: string;
  type: PolicyType;
  enabled: boolean;
  config: Record<string, unknown>; // see policy config types below
}

type PolicyType =
  | 'spending-limit'
  | 'approved-addresses'
  | 'auto-approve-threshold'
  | 'time-window'
  | 'rate-limit';
```

### Policy Config Types

```typescript
interface SpendingLimitConfig {
  maxPerTx: string;   // wei string
  maxPerDay: string;
  maxPerWeek: string;
}

interface ApprovedAddressesConfig {
  addresses: string[];
  mode: 'whitelist' | 'blacklist';
}

interface AutoApproveConfig {
  threshold: string; // wei — transactions at or below this are auto-signed
}

interface TimeWindowConfig {
  allowedHours: { start: number; end: number }[]; // UTC 24h
  allowedDays: number[]; // 0 = Sunday … 6 = Saturday
}

interface RateLimitConfig {
  maxTxPerHour: number;
  maxTxPerDay: number;
}
```

### `PolicyResult`

Returned in rejection errors and pending-approval responses so you can see exactly which policy blocked or queued the transaction.

```typescript
interface PolicyResult {
  policyId: string;
  type: PolicyType;
  passed: boolean;
  reason?: string; // human-readable explanation on failure
}
```

---

## Error Handling

All methods throw `StewardApiError` on failure.

```typescript
class StewardApiError<TData = unknown> extends Error {
  readonly status: number;  // HTTP status code (0 = network error)
  readonly data?: TData;    // parsed response body, if available
}
```

### Common Status Codes

| Status | Meaning |
|--------|---------|
| `0` | Network error / connection refused |
| `400` | Hard policy rejection — check `error.data.results` |
| `401` | Invalid or missing API key |
| `404` | Agent not found |
| `409` | Agent ID already exists |
| `500` | Server error |

### Example

```typescript
import { StewardClient, StewardApiError } from '@stwd/sdk';
import type { PolicyResult } from '@stwd/sdk';

try {
  const result = await steward.signTransaction('agent-1', tx);
} catch (err) {
  if (err instanceof StewardApiError) {
    if (err.status === 400) {
      const failed = (err.data as { results: PolicyResult[] })?.results
        ?.filter(r => !r.passed);
      console.error('Rejected by policies:', failed?.map(r => r.reason));
    } else if (err.status === 0) {
      console.error('Could not reach Steward API');
    } else {
      console.error(`API error ${err.status}:`, err.message);
    }
  }
}
```

---

## Request Headers

The SDK sets these headers automatically:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `X-Steward-Key` | Your `apiKey` |
| `X-Steward-Tenant` | Your `tenantId` |

---

## Policy Hard vs Soft Gates

Understanding how policies interact:

- **Hard policies** (`spending-limit`, `approved-addresses`, `rate-limit`, `time-window`) — any failure **rejects** the transaction immediately with HTTP 400
- **Soft policy** (`auto-approve-threshold`) — failure **queues** the transaction for manual approval (HTTP 202), but does not reject

This means you can set conservative limits that block dangerous transactions outright, while still letting moderately large (but in-policy) transactions go to a human reviewer rather than being auto-executed.

---

## License

MIT
