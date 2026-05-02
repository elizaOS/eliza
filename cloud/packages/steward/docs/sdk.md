# SDK Reference

`@stwd/sdk` is the TypeScript client for the Steward API. It works in any JS/TS runtime — browser, Node, Bun, Deno — with no native dependencies (pure `fetch`).

## Installation

```bash
npm install @stwd/sdk
# or
bun add @stwd/sdk
# or
pnpm add @stwd/sdk
```

## Initialization

```typescript
import { StewardClient } from "@stwd/sdk";

// API key auth (tenant services, backends, agents)
const steward = new StewardClient({
  baseUrl: "https://your-steward-instance.com",
  apiKey: "stw_your_api_key",
  tenantId: "your-tenant-id",
});

// JWT bearer token auth (after user login)
const steward = new StewardClient({
  baseUrl: "https://your-steward-instance.com",
  bearerToken: "eyJhbGciOiJIUzI1NiJ9...",
});
```

> **Security note — JWT storage:** By default, browser-side usage stores JWTs in `localStorage`, which is accessible to any JavaScript running on the page. This creates an XSS risk: if an attacker injects a script, they can exfiltrate the token.
>
> For server-rendered apps (Next.js, Remix, etc.), store the JWT in an `httpOnly` cookie instead. The cookie is never accessible to JavaScript and is automatically included in requests.
>
> `StewardAuth` (from `@stwd/sdk/auth`) accepts a custom `storage` parameter so you can bring your own token store:
>
> ```typescript
> import { StewardAuth } from "@stwd/sdk";
>
> // Example: memory-only storage (safest for SPAs — cleared on page unload)
> const memStore: Record<string, string> = {};
> const auth = new StewardAuth({
>   baseUrl: "https://your-steward-instance.com",
>   storage: {
>     getItem: (key) => memStore[key] ?? null,
>     setItem: (key, value) => { memStore[key] = value; },
>     removeItem: (key) => { delete memStore[key]; },
>   },
> });
>
> // For server-rendered apps: set JWT in httpOnly cookie server-side,
> // then pass bearerToken to StewardClient via SSR context.
> // Do not read tokens from document.cookie in browser JS.
> ```
>
> **Recommendation by app type:**
> - **SPAs (React, Vue):** Use memory-only storage or sessionStorage. Pair with refresh tokens to maintain sessions across navigations.
> - **Server-rendered (Next.js, Remix):** Store JWT in `httpOnly` cookie server-side; pass `bearerToken` to `StewardClient` via SSR.
> - **Backend / agents:** Store in environment variables or a secrets manager.

### `StewardClientConfig`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | string | Yes | API server URL (trailing slashes trimmed) |
| `apiKey` | string | No | Tenant API key. Sent as `X-Steward-Key` header |
| `bearerToken` | string | No | JWT from auth flow. Sent as `Authorization: Bearer`. Takes precedence over `apiKey` |
| `tenantId` | string | No | Sent as `X-Steward-Tenant` header. Required when using `apiKey` |

---

## Agent (Wallet) Operations

### Create a Wallet

Creates an agent with encrypted EVM and Solana keypairs.

```typescript
const agent = await steward.createWallet(
  "my-agent-id",   // unique ID within the tenant (alphanumeric, _ - . : allowed)
  "My Agent",      // display name
  "platform-id",   // optional: your platform's external ID for this agent
);

console.log(agent.walletAddresses);
// { evm: "0x...", solana: "..." }
```

**Returns:** `AgentIdentity`

```typescript
interface AgentIdentity {
  id: string;
  name: string;
  tenantId: string;
  walletAddress?: string;       // primary EVM address
  walletAddresses?: {
    evm?: string;
    solana?: string;
  };
  platformId?: string;
  createdAt: Date;
}
```

### Batch Create Wallets

Create multiple agents in a single request. Optionally apply a shared policy set.

```typescript
const result = await steward.createWalletBatch(
  [
    { id: "agent-1", name: "Agent One" },
    { id: "agent-2", name: "Agent Two", platformId: "ext-456" },
  ],
  [
    // Optional: policies applied to every created agent
    {
      id: "spend-limit",
      type: "spending-limit",
      enabled: true,
      config: { maxPerTxUsd: 100 },
    },
  ],
);

console.log(result.created);  // AgentIdentity[]
console.log(result.errors);   // [{ id, error }] for failed agents
```

### Get an Agent

```typescript
const agent = await steward.getAgent("my-agent-id");
```

### List Agents

```typescript
const agents = await steward.listAgents();
```

### Get Wallet Addresses

Returns all wallet addresses across all chain families for an agent.

```typescript
const { agentId, addresses } = await steward.getAddresses("my-agent-id");
// addresses: [{ chainFamily: "evm", address: "0x..." }, { chainFamily: "solana", address: "..." }]
```

### Get Balance

```typescript
const balance = await steward.getBalance("my-agent-id");
// balance.balances: { native, nativeFormatted, symbol, chainId }

// Query a specific chain
const balance = await steward.getBalance("my-agent-id", 8453); // Base
```

### Get Transaction History

```typescript
const history = await steward.getHistory("my-agent-id");
// history: [{ timestamp, value }]
```

---

## Transaction Signing

### Sign an EVM Transaction

```typescript
const result = await steward.signTransaction("my-agent-id", {
  to: "0xRecipient",
  value: "10000000000000000",   // 0.01 ETH in wei
  data: "0x",                   // optional calldata
  chainId: 8453,                // Base
  broadcast: true,              // default true; set false for offline signing
});

// If policies pass and broadcast: true:
if ("txHash" in result) {
  console.log("Broadcasted:", result.txHash, result.caip2);
}

// If policies pass and broadcast: false:
if ("signedTx" in result) {
  console.log("Signed hex:", result.signedTx);
}

// If above auto-approve threshold:
if (result.status === "pending_approval") {
  console.log("Queued for approval");
  console.log("Policy results:", result.results);
}
```

**Input fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Recipient address |
| `value` | string | Yes | Value in wei (as string to avoid BigInt precision loss) |
| `data` | string | No | Calldata hex string (default `"0x"`) |
| `chainId` | number | No | Override chain (defaults to server's `CHAIN_ID`) |
| `broadcast` | boolean | No | Broadcast to chain (default `true`) |

### Sign a Message

```typescript
const { signature } = await steward.signMessage("my-agent-id", "Hello from Steward");
```

### Sign EIP-712 Typed Data

```typescript
const { signature } = await steward.signTypedData("my-agent-id", {
  domain: {
    name: "MyDApp",
    version: "1",
    chainId: 8453,
    verifyingContract: "0xContract",
  },
  types: {
    Transfer: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  primaryType: "Transfer",
  value: {
    to: "0xRecipient",
    amount: "1000000000000000000",
  },
});
```

### Sign a Solana Transaction

```typescript
const result = await steward.signSolanaTransaction("my-agent-id", {
  transaction: "base64-encoded-serialized-transaction",
  chainId: 101,       // 101 = mainnet, 102 = devnet
  broadcast: true,
});

console.log(result.signature);
```

### RPC Passthrough (Read-Only)

Proxy read-only RPC calls through Steward to the chain provider. Write/signing methods are blocked server-side.

```typescript
const result = await steward.rpcPassthrough("my-agent-id", {
  method: "eth_getBalance",
  params: ["0xAddress", "latest"],
  chainId: 8453,
});
```

---

## Policy Management

### Get Policies

```typescript
const policies = await steward.getPolicies("my-agent-id");
```

**Returns:** `PolicyRule[]`

### Set Policies (Replace All)

```typescript
await steward.setPolicies("my-agent-id", [
  {
    id: "spend-limit",
    type: "spending-limit",
    enabled: true,
    config: {
      maxPerTxUsd: 100,
      maxPerDayUsd: 1000,
    },
  },
  {
    id: "whitelist",
    type: "approved-addresses",
    enabled: true,
    config: {
      mode: "whitelist",
      addresses: ["0xUniswapRouter"],
    },
  },
]);
```

See [Policy Engine](./policies.md) for all policy types and config options.

---

## Approval Queue

### List Pending Approvals

```typescript
const approvals = await steward.listApprovals({ status: "pending" });
```

### Approve a Transaction

```typescript
const entry = await steward.approveTransaction("tx-id", {
  comment: "Reviewed and approved",
  approvedBy: "ops-team",
});
```

### Deny a Transaction

```typescript
const entry = await steward.denyTransaction("tx-id", "Amount too large for this period", "ops-team");
```

### Approval Statistics

```typescript
const stats = await steward.getApprovalStats();
// { pending, approved, denied, totalProcessed }
```

---

## Webhooks

### Create a Webhook

```typescript
const webhook = await steward.createWebhook({
  url: "https://your-app.com/webhook",
  events: ["tx.signed", "tx.pending", "policy.violation"],
  description: "Production webhook",
  maxRetries: 5,
  retryBackoffMs: 1000,
});
```

**Supported event types:**

| Event | Fires when |
|-------|-----------|
| `tx.pending` | Transaction queued for approval |
| `tx.approved` | Queued transaction approved |
| `tx.denied` | Queued transaction denied |
| `tx.signed` | Transaction successfully signed |
| `spend.threshold` | Spend limit approaching |
| `policy.violation` | Policy evaluation failed |

### List, Update, Delete Webhooks

```typescript
const webhooks = await steward.listWebhooks();

await steward.updateWebhook("webhook-id", {
  enabled: false,
});

await steward.deleteWebhook("webhook-id");
```

### Delivery History

```typescript
const deliveries = await steward.getWebhookDeliveries("webhook-id", { limit: 20 });

// Retry a failed delivery
await steward.retryDelivery("delivery-id");
```

---

## Tenant Configuration

### Get Tenant Config

```typescript
const config = await steward.getTenantConfig("my-tenant");
```

### Update Tenant Config

```typescript
await steward.updateTenantConfig("my-tenant", {
  theme: {
    primaryColor: "#6366f1",
    colorScheme: "dark",
  },
  features: {
    showApprovalQueue: true,
    showSecretManager: false,
  },
});
```

---

## Agent Dashboard

Get an aggregated snapshot of an agent: balance, spend stats, active policies, recent transactions, and pending approvals.

```typescript
const dashboard = await steward.getAgentDashboard("my-agent-id");
```

---

## Error Handling

All methods throw `StewardApiError` on failure:

```typescript
import { StewardApiError } from "@stwd/sdk";

try {
  await steward.signTransaction("my-agent", tx);
} catch (err) {
  if (err instanceof StewardApiError) {
    console.error(`HTTP ${err.status}: ${err.message}`);

    // Policy failures include detailed results
    if (err.data?.results) {
      for (const r of err.data.results) {
        if (!r.passed) {
          console.error(`  ${r.type}: ${r.reason}`);
        }
      }
    }
  }
}
```

**`StewardApiError` properties:**

| Property | Type | Description |
|----------|------|-------------|
| `message` | string | Human-readable error message |
| `status` | number | HTTP status code (0 for network errors) |
| `data` | unknown | Response body (may include `results` for policy failures) |

---

## Complete Example: Trading Bot Agent

```typescript
import { StewardClient, StewardApiError } from "@stwd/sdk";

const steward = new StewardClient({
  baseUrl: process.env.STEWARD_URL!,
  apiKey: process.env.STEWARD_API_KEY!,
  tenantId: process.env.STEWARD_TENANT!,
});

async function setupAgent(agentId: string) {
  // Create wallet
  const agent = await steward.createWallet(agentId, "Trading Bot");
  console.log(`EVM: ${agent.walletAddresses?.evm}`);

  // Configure policies
  await steward.setPolicies(agentId, [
    {
      id: "spend-limit",
      type: "spending-limit",
      enabled: true,
      config: { maxPerDayUsd: 5000 },
    },
    {
      id: "dex-whitelist",
      type: "approved-addresses",
      enabled: true,
      config: {
        mode: "whitelist",
        addresses: [process.env.DEX_ROUTER!],
      },
    },
    {
      id: "auto-approve",
      type: "auto-approve-threshold",
      enabled: true,
      config: { thresholdUsd: 500 },
    },
  ]);

  return agent;
}

async function executeTrade(agentId: string, to: string, value: string) {
  try {
    const result = await steward.signTransaction(agentId, {
      to,
      value,
      chainId: 8453,
      broadcast: true,
    });

    if ("txHash" in result) {
      console.log("Trade submitted:", result.txHash);
      return result.txHash;
    }

    if (result.status === "pending_approval") {
      console.log("Trade queued for approval — value exceeds auto-approve threshold");
      return null;
    }
  } catch (err) {
    if (err instanceof StewardApiError) {
      console.error("Trade rejected:", err.message);
      if (err.data?.results) {
        err.data.results
          .filter((r: { passed: boolean }) => !r.passed)
          .forEach((r: { type: string; reason: string }) =>
            console.error(`  Policy ${r.type}: ${r.reason}`)
          );
      }
    }
    throw err;
  }
}
```
