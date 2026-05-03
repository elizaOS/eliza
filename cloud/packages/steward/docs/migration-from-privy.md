# Migrate from Privy in 10 Minutes

Steward covers the core of what Privy does — embedded wallets, user auth, multi-tenant access — plus adds policy enforcement, approval queues, and a self-hostable architecture. This guide maps Privy concepts to Steward equivalents and walks through the migration step by step.

## Conceptual Comparison

| Privy Concept | Steward Equivalent | Notes |
|--------------|-------------------|-------|
| App ID | Tenant ID + API Key | Steward uses `tenantId` + `apiKey` pair instead of a single app ID |
| Embedded wallet | Agent wallet | AES-256-GCM encrypted, stored in Steward's vault |
| User | User (users table) | Same concept: human who authenticates |
| Linked accounts | accounts table | OAuth accounts linked on sign-in (Google, Discord) |
| `<PrivyProvider appId="...">` | `<StewardProvider client={...}>` | Steward's provider wraps wallet UI; auth UI is separate |
| `usePrivy()` | `useSteward()` | Similar hook, see mapping below |
| `login()` | Auth endpoints (`/auth/email/send`, `/auth/passkey/*`, `/auth/verify`, `/auth/oauth/:provider/authorize`) | Call directly or build a modal |
| `logout()` | `POST /auth/revoke` + discard tokens | Revokes the refresh token server-side; JWT expires after 24h |
| Wallet key recovery | Not needed — vault always holds the key | No export flow (by design) |
| Server wallets | Agents | Steward calls them "agents"; same concept |
| Privy API | Steward REST API | Full REST API with API key auth |

## Auth Method Comparison

| Auth Method | Privy | Steward |
|-------------|-------|---------|
| Email magic link | ✅ | ✅ |
| Passkeys (WebAuthn) | ✅ | ✅ |
| Sign-In with Ethereum | ✅ | ✅ |
| Google OAuth | ✅ | ✅ (requires GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) |
| Discord OAuth | ✅ | ✅ (requires DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET) |
| Twitter/X OAuth | ✅ | Not yet implemented |
| Apple Sign-In | ✅ | Not yet implemented |
| SMS / phone OTP | ✅ | Not yet implemented |
| Custom JWT | ⚠️ | `Authorization: Bearer` accepted |

Steward has the right primitives for all of these — the OAuth flows just need implementation.

---

## Step-by-Step Migration

### Step 1: Deploy Steward

Choose a mode:

**Self-hosted (recommended for production):**

```bash
git clone https://github.com/Steward-Fi/steward
cd steward
# Fix Dockerfile (remove non-existent packages/dashboard lines)
sed -i '/packages\/dashboard/d' Dockerfile
export STEWARD_MASTER_PASSWORD=$(openssl rand -hex 32)
docker compose up -d
# Run migrations
docker compose exec api bun packages/db/src/migrate.ts
psql $DATABASE_URL -f packages/db/drizzle/migration-auth-tables.sql
```

**Or use Eliza Cloud** (Steward hosted infrastructure).

### Step 2: Create a Tenant

This replaces Privy's "Create App" step:

```bash
curl -X POST https://your-steward-instance.com/tenants \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-app",
    "name": "My App",
    "apiKeyHash": "my-raw-api-key"
  }'
```

Save your tenant ID (`my-app`) and API key (`my-raw-api-key`). The API key is shown once.

### Step 3: Install the SDK

```bash
# Remove Privy
npm uninstall @privy-io/react-auth

# Install Steward
npm install @stwd/sdk @stwd/react
```

### Step 4: Replace PrivyProvider

**Before (Privy):**

```tsx
import { PrivyProvider } from "@privy-io/react-auth";

function App() {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}
      config={{ loginMethods: ["email", "wallet"], appearance: { ... } }}
    >
      <YourApp />
    </PrivyProvider>
  );
}
```

**After (Steward):**

```tsx
import { StewardProvider } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";
import "@stwd/react/styles.css";

const stewardClient = new StewardClient({
  baseUrl: process.env.NEXT_PUBLIC_STEWARD_URL!,
  apiKey: process.env.NEXT_PUBLIC_STEWARD_API_KEY!,
  tenantId: process.env.NEXT_PUBLIC_STEWARD_TENANT!,
});

function App() {
  const { agentId } = useAuth(); // your auth state

  return (
    <StewardProvider
      client={stewardClient}
      agentId={agentId}
      theme={{ primaryColor: "#6366f1" }}
    >
      <YourApp />
    </StewardProvider>
  );
}
```

### Step 5: Replace the Login Flow

Privy gives you a pre-built login modal. Steward requires you to call the auth endpoints directly (or build your own modal around them).

**Before (Privy):**

```tsx
import { usePrivy } from "@privy-io/react-auth";

function LoginButton() {
  const { login, authenticated } = usePrivy();
  return <button onClick={login}>{authenticated ? "Logged in" : "Login"}</button>;
}
```

**After (Steward — Email Magic Link):**

```tsx
function LoginFlow() {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "verify">("email");
  const [token, setToken] = useState("");

  const sendLink = async () => {
    await fetch(`${STEWARD_URL}/auth/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setStep("verify");
  };

  const verify = async () => {
    const res = await fetch(`${STEWARD_URL}/auth/email/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email }),
    });
    const { token: jwt, user } = await res.json();
    localStorage.setItem("steward_token", jwt);
    // Store user.walletAddress and user.id in your app state
  };

  return step === "email" ? (
    <form onSubmit={sendLink}>
      <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
      <button type="submit">Send Magic Link</button>
    </form>
  ) : (
    <form onSubmit={verify}>
      <input value={token} onChange={e => setToken(e.target.value)} placeholder="Paste token from email" />
      <button type="submit">Verify</button>
    </form>
  );
}
```

**After (Steward — SIWE with wagmi):**

```tsx
import { useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";

function SiweLogin() {
  const { signMessageAsync } = useSignMessage();

  const login = async (address: string, chainId: number) => {
    // Get nonce
    const { nonce } = await fetch(`${STEWARD_URL}/auth/nonce`).then(r => r.json());

    // Build and sign SIWE message
    const message = new SiweMessage({
      domain: window.location.host,
      address,
      statement: "Sign in to My App",
      uri: window.location.origin,
      version: "1",
      chainId,
      nonce,
    });
    const signature = await signMessageAsync({ message: message.prepareMessage() });

    // Verify
    const { token, tenant } = await fetch(`${STEWARD_URL}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message.prepareMessage(), signature }),
    }).then(r => r.json());

    localStorage.setItem("steward_token", token);
    // tenant.apiKey is returned only on first sign-in
  };
}
```

### Step 6: Replace `usePrivy()` Hook

**Before (Privy):**

```tsx
const { user, authenticated, logout, signMessage } = usePrivy();
const wallet = user?.wallet;
```

**After (Steward):**

```tsx
import { useSteward, useWallet } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";

// Auth state — manage with your own auth context
function useAuth() {
  const jwt = localStorage.getItem("steward_token");
  const authenticated = !!jwt;

  const logout = () => {
    localStorage.removeItem("steward_token");
    // fetch(`${STEWARD_URL}/auth/logout`, { method: "POST" }); // optional
  };

  return { authenticated, logout, jwt };
}

// Wallet state — via Steward React hook
function WalletInfo() {
  const { agent, balance } = useWallet(); // inside <StewardProvider>
  return <div>{agent?.walletAddresses?.evm}</div>;
}
```

### Step 7: Replace Server Wallet Calls

**Before (Privy server wallets):**

```typescript
import { PrivyClient } from "@privy-io/server-auth";

const privy = new PrivyClient(appId, appSecret);
const { hash } = await privy.walletApi.ethereum.sendTransaction({
  walletId: "wallet-id",
  caip2: "eip155:1",
  transaction: { to, value, chainId },
});
```

**After (Steward SDK):**

```typescript
import { StewardClient } from "@stwd/sdk";

const steward = new StewardClient({
  baseUrl: process.env.STEWARD_URL!,
  apiKey: process.env.STEWARD_API_KEY!,
  tenantId: process.env.STEWARD_TENANT!,
});

// The "walletId" is the agentId in Steward
const result = await steward.signTransaction("agent-id", {
  to,
  value,
  chainId: 1,
  broadcast: true,
});
```

### Step 8: Map User Wallets

When migrating existing Privy users, you need to create corresponding Steward agents:

```typescript
// For each existing Privy user, create a Steward agent
for (const user of privyUsers) {
  const agentId = `user-${user.id}`;
  try {
    const agent = await steward.createWallet(agentId, user.email || user.id);
    console.log(`Created agent ${agentId}: ${agent.walletAddresses?.evm}`);
    // Store the mapping: privyUserId -> stewardAgentId in your DB
  } catch (err) {
    // Agent already exists — fine for re-runs
  }
}
```

Note: Steward generates **new keypairs** for each agent. Privy embedded wallet private keys cannot be imported (they're non-exportable by design). You'll need to either:
1. Generate new wallets and have users migrate funds, or
2. Only migrate new users going forward and maintain both systems during a transition period.

---

## API Endpoint Mapping

| Privy API | Steward Equivalent |
|-----------|-------------------|
| `POST /api/v1/apps/{appId}/users/{userId}/wallets` | `POST /agents` |
| `GET /api/v1/apps/{appId}/users/{userId}/wallets` | `GET /agents/{agentId}` |
| `POST /api/v1/apps/{appId}/wallets/{walletId}/rpc` | `POST /vault/{agentId}/sign` |
| `POST /api/v1/apps/{appId}/wallets/{walletId}/sign` | `POST /vault/{agentId}/sign-message` |
| `GET /api/v1/apps/{appId}/users` | `GET /agents` (agents ≈ users in the Steward model) |
| Privy auth tokens | JWT from `/auth/email/verify`, `/auth/passkey/login/verify`, `/auth/verify`, `/auth/oauth/:provider/token` |
| Privy token refresh | `POST /auth/refresh` (one-time-use token rotation) |
| Sign out | `POST /auth/revoke` (single session) or `DELETE /auth/sessions` (all sessions) |

---

## What Steward Adds That Privy Doesn't

Once you've migrated, you get:

1. **Policy enforcement at the cryptographic signing layer** — spending limits, address whitelists, rate limits, time windows. Privy now has server-side wallet policies, but these operate at the application layer: if the Privy server or your integration code is compromised, those rules can be bypassed. Steward enforces policies inside the vault — the vault won't sign a transaction that violates policy, regardless of what calls it. Even compromised application code can't exceed the limits.
2. **Approval queue** — large transactions queue for human review before execution.
3. **Webhook events** — real-time push notifications on `tx.signed`, `tx.pending`, `policy.violation`.
4. **Secret vault + credential injection proxy** — agents can call external APIs without ever seeing API keys.
5. **Full self-hostability** — run the entire stack on your own infrastructure. No vendor lock-in.
6. **Embedded mode** — run as a local sidecar with PGLite; no cloud dependencies.
7. **Multi-chain Solana support** — EVM + Solana keypairs generated atomically per agent.

---

## Migration Checklist

- [ ] Deploy Steward (self-hosted or Eliza Cloud)
- [ ] Create tenant (replaces Privy App ID)
- [ ] Run database migrations (including `migration-auth-tables.sql`)
- [ ] Replace `@privy-io/react-auth` with `@stwd/sdk` + `@stwd/react`
- [ ] Replace `<PrivyProvider>` with `<StewardProvider>`
- [ ] Implement login UI using Steward auth endpoints
- [ ] Replace `usePrivy()` with `useSteward()` + `useWallet()`
- [ ] Migrate server-side wallet calls from Privy server-auth SDK to `@stwd/sdk`
- [ ] Create Steward agents for existing users (new keypairs, fund migration required)
- [ ] Remove `PRIVY_APP_ID` / `PRIVY_APP_SECRET` from environment
- [ ] (Optional) Add policies to agents to enforce spending controls
- [ ] (Optional) Set up webhooks for transaction events
