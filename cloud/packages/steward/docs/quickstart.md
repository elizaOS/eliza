# Quickstart

Three paths depending on how you're integrating Steward.

---

## Path A: SDK Auth Quickstart

Use the TypeScript SDK to add Steward auth and wallets to any app.

### 1. Install

```bash
npm install @stwd/sdk
```

### 2. Initialize the Client

```typescript
import { StewardClient } from "@stwd/sdk";

const steward = new StewardClient({
  baseUrl: "https://api.steward.fi", // or your self-hosted URL
  apiKey: "stw_your_tenant_key",
  tenantId: "my-app",
});
```

### 3. Passkey Login

```typescript
// Register a new passkey
const regOptions = await steward.auth.startPasskeyRegistration({
  email: "user@example.com",
});
// Browser prompts biometric/security key
const credential = await navigator.credentials.create({ publicKey: regOptions });
const session = await steward.auth.finishPasskeyRegistration(credential);
// session = { accessToken, refreshToken, user: { id, email, walletAddress } }

// Log in with existing passkey
const authOptions = await steward.auth.startPasskeyLogin({ email: "user@example.com" });
const assertion = await navigator.credentials.get({ publicKey: authOptions });
const session = await steward.auth.finishPasskeyLogin(assertion);
```

### 4. Email Magic Link Login

```typescript
// Send magic link
await steward.auth.sendMagicLink({ email: "user@example.com" });
// User clicks the link in their email, which hits your callback URL
// On callback:
const session = await steward.auth.verifyMagicLink({ token: callbackToken });
```

### 5. Use the Wallet

Every authenticated user gets an auto-provisioned embedded wallet:

```typescript
// Get wallet info
const wallet = await steward.getWallet(session.user.walletAddress);
console.log(wallet.walletAddresses); // { evm: "0x...", solana: "..." }

// Sign a transaction (policy-enforced)
const result = await steward.signTransaction(session.user.walletAddress, {
  to: "0xRecipient",
  value: "10000000000000000", // 0.01 ETH
  chainId: 8453, // Base
});

if ("signedTx" in result) {
  console.log("Signed:", result.signedTx);
} else if (result.status === "pending_approval") {
  console.log("Queued for human approval");
}
```

### 6. Set Policies

```typescript
await steward.setPolicies(agentId, [
  {
    id: "spend-cap",
    type: "spending-limit",
    enabled: true,
    config: { maxPerTx: "100000000000000000", maxPerDay: "500000000000000000" },
  },
  {
    id: "auto-approve-small",
    type: "auto-approve-threshold",
    enabled: true,
    config: { threshold: "50000000000000000" },
  },
  {
    id: "safe-addresses",
    type: "approved-addresses",
    enabled: true,
    config: { addresses: ["0xTrustedDEX", "0xTrustedBridge"] },
  },
]);
```

---

## Path B: React Widget Quickstart

Drop-in React components for login, wallet display, and policy management.

### 1. Install

```bash
npm install @stwd/react @stwd/sdk
```

### 2. Wrap Your App

```tsx
import { StewardProvider } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";
import "@stwd/react/styles.css";

const client = new StewardClient({
  baseUrl: "https://api.steward.fi",
  apiKey: "stw_your_tenant_key",
  tenantId: "my-app",
});

function App() {
  return (
    <StewardProvider
      client={client}
      auth={{ baseUrl: "https://api.steward.fi" }}
    >
      <MyApp />
    </StewardProvider>
  );
}
```

### 3. Add Login

```tsx
import { StewardLogin, StewardAuthGuard } from "@stwd/react";

function MyApp() {
  return (
    <StewardAuthGuard
      fallback={
        <StewardLogin
          methods={["passkey", "email", "google", "discord"]}
          onSuccess={(session) => console.log("Logged in:", session.user.email)}
        />
      }
    >
      <Dashboard />
    </StewardAuthGuard>
  );
}
```

`StewardAuthGuard` renders the `fallback` when no session exists. Once authenticated, it renders children.

### 4. Show Wallet and Controls

```tsx
import {
  StewardUserButton,
  WalletOverview,
  PolicyControls,
  ApprovalQueue,
  TransactionHistory,
  SpendDashboard,
} from "@stwd/react";

function Dashboard() {
  return (
    <div>
      <StewardUserButton />        {/* User avatar + dropdown with logout */}
      <WalletOverview showQR />     {/* Balances, addresses, QR code */}
      <PolicyControls />            {/* View and edit policies */}
      <ApprovalQueue />             {/* Pending transactions needing review */}
      <TransactionHistory />        {/* Past transactions with status */}
      <SpendDashboard />            {/* Spend tracking charts */}
    </div>
  );
}
```

### 5. Multi-Tenant Apps

If your users belong to multiple tenants:

```tsx
import { StewardTenantPicker } from "@stwd/react";

<StewardTenantPicker
  onSwitch={(tenantId) => {
    // SDK automatically switches context
    console.log("Switched to tenant:", tenantId);
  }}
/>
```

### Available Hooks

All components are built on public hooks you can use directly:

```typescript
import { useAuth, useWallet, usePolicies, useApprovals, useTransactions, useSpend } from "@stwd/react";

const { user, session, signOut } = useAuth();
const { wallet, balances, isLoading } = useWallet();
const { policies, updatePolicy } = usePolicies();
const { pending, approve, reject } = useApprovals();
const { transactions } = useTransactions();
const { daily, weekly, total } = useSpend();
```

---

## Path C: Self-Hosting Quickstart

Run the full Steward stack on your own infrastructure.

### Option 1: Docker (Production)

```bash
git clone https://github.com/Steward-Fi/steward.git
cd steward
cp .env.example .env
```

Edit `.env` with required values:

```bash
# Required
STEWARD_MASTER_PASSWORD=your-long-random-secret    # Derives all encryption keys. No recovery if lost.
POSTGRES_PASSWORD=your-db-password

# Optional (enable auth features)
RESEND_API_KEY=re_xxx                              # Email magic links
PASSKEY_RP_ID=yourdomain.com                       # WebAuthn relying party
PASSKEY_ORIGIN=https://yourdomain.com              # WebAuthn origin
GOOGLE_CLIENT_ID=xxx                               # Google OAuth
GOOGLE_CLIENT_SECRET=xxx
DISCORD_CLIENT_ID=xxx                              # Discord OAuth
DISCORD_CLIENT_SECRET=xxx
```

Start everything:

```bash
docker compose up -d
```

This launches four services:
- **steward-api** on `:3200` — REST API + vault
- **steward-proxy** on `:8080` — Credential injection proxy
- **postgres** — PostgreSQL 16 (internal)
- **redis** — Rate limiting + token store (internal)

Verify it's running:

```bash
curl http://localhost:3200/ready
# → {"ok":true,"mode":"postgres"}
```

### Option 2: Embedded Mode (Development / Local Agents)

No Docker, no Postgres, no Redis. Steward runs in-process with PGLite.

```bash
git clone https://github.com/Steward-Fi/steward.git
cd steward && bun install

export STEWARD_MASTER_PASSWORD="dev-secret"
bun run start:local
# → ✅ Steward API running on port 3200 (embedded/PGLite mode)
```

Data persists to `~/.steward/data/` by default. Set `PGLITE_DATA_DIR` to change location, or `STEWARD_PGLITE_MEMORY=true` for ephemeral mode.

### Create Your First Tenant

```bash
curl -s -X POST http://localhost:3200/tenants \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-app",
    "name": "My App",
    "apiKeyHash": "my-dev-api-key"
  }' | jq
```

### Create an Agent

```bash
curl -s -X POST http://localhost:3200/agents \
  -H "Content-Type: application/json" \
  -H "X-Steward-Tenant: my-app" \
  -H "X-Steward-Key: my-dev-api-key" \
  -d '{ "id": "trading-bot", "name": "Trading Bot" }' | jq
```

This auto-generates AES-256-GCM encrypted EVM and Solana keypairs. Private keys are never returned.

### Set Policies and Sign

```bash
# Set policies (default-deny: without policies, all signing is rejected)
curl -s -X PUT http://localhost:3200/agents/trading-bot/policies \
  -H "Content-Type: application/json" \
  -H "X-Steward-Tenant: my-app" \
  -H "X-Steward-Key: my-dev-api-key" \
  -d '[{
    "id": "spend-limit",
    "type": "spending-limit",
    "enabled": true,
    "config": { "maxPerTx": "100000000000000000" }
  }]' | jq

# Sign a transaction
curl -s -X POST http://localhost:3200/vault/trading-bot/sign \
  -H "Content-Type: application/json" \
  -H "X-Steward-Tenant: my-app" \
  -H "X-Steward-Key: my-dev-api-key" \
  -d '{
    "to": "0xRecipientAddress",
    "value": "10000000000000000",
    "chainId": 84532,
    "broadcast": false
  }' | jq
```

---

## Next Steps

- [Architecture](./architecture.md) — Two-mode design and package layout
- [Authentication](./auth.md) — Full auth integration guide
- [Policy Engine](./policies.md) — All 6 policy types with examples
- [React Components](./react.md) — Component API reference
- [SDK Reference](./sdk.md) — Full TypeScript SDK docs
- [Deployment](./deployment.md) — Production setup, TLS, monitoring
- [Privy Migration](./migration-from-privy.md) — Step-by-step migration guide
