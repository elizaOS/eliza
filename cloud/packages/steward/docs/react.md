# React Integration

`@stwd/react` provides embeddable wallet management UI components for React apps. Drop them into your app to give users a wallet overview, transaction history, approval queue, policy controls, and spend dashboard — all connected to your Steward instance.

## Installation

```bash
npm install @stwd/react @stwd/sdk
# or
bun add @stwd/react @stwd/sdk
```

Import the stylesheet:

```typescript
import "@stwd/react/styles.css";
```

## StewardProvider

Wrap your component tree with `StewardProvider`. It creates a context with the API client, feature flags, theme, and polling configuration.

```tsx
import { StewardProvider } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";

const client = new StewardClient({
  baseUrl: "https://your-steward-instance.com",
  apiKey: "stw_your_api_key",
  tenantId: "your-tenant",
});

function App() {
  return (
    <StewardProvider
      client={client}
      agentId="my-agent-id"
    >
      <WalletDashboard />
    </StewardProvider>
  );
}
```

### Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `client` | `StewardClient` | Yes | — | Initialized SDK client |
| `agentId` | string | Yes | — | Agent ID to display data for |
| `features` | `Partial<TenantFeatureFlags>` | No | Tenant config defaults | Override which features are visible |
| `theme` | `Partial<TenantTheme>` | No | Tenant config defaults | Override theme tokens |
| `pollInterval` | number | No | `30000` | How often to refresh data (ms) |

`StewardProvider` automatically fetches the tenant's control-plane config (`/tenants/config`) to load server-side feature flags and theme. Props passed directly override those server-side values.

---

## Components

### `<WalletOverview />`

Displays the agent's wallet address(es), balance, and optional funding QR.

```tsx
import { WalletOverview } from "@stwd/react";

function MyWallet() {
  return (
    <WalletOverview
      chains={["evm"]}          // Filter to specific chains (default: show all)
      showQR={true}             // Show funding QR (overrides feature flag)
      showCopy={true}           // Show copy button (default: true)
      onCopyAddress={(address, chain) => console.log("Copied", address, chain)}
    />
  );
}
```

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| `chains` | `("evm" \| "solana")[]` | Filter to specific chain families |
| `showQR` | boolean | Override the `showFundingQR` feature flag |
| `showCopy` | boolean | Show copy-to-clipboard button (default `true`) |
| `className` | string | Additional CSS class |
| `onCopyAddress` | `(address, chain) => void` | Callback when address is copied |

---

### `<TransactionHistory />`

Lists recent transactions with status, value, chain, and explorer links.

```tsx
import { TransactionHistory } from "@stwd/react";

function TxHistory() {
  return (
    <TransactionHistory
      limit={20}
      showChainBadge={true}
    />
  );
}
```

---

### `<PolicyControls />`

Shows the agent's active policies and allows viewing/editing policy configurations.

```tsx
import { PolicyControls } from "@stwd/react";

function Policies() {
  return <PolicyControls readOnly={false} />;
}
```

---

### `<ApprovalQueue />`

Lists pending approvals and provides approve/deny buttons.

```tsx
import { ApprovalQueue } from "@stwd/react";

function Approvals() {
  return (
    <ApprovalQueue
      onApprove={(txId) => console.log("Approved:", txId)}
      onDeny={(txId, reason) => console.log("Denied:", txId, reason)}
    />
  );
}
```

---

### `<SpendDashboard />`

Visualizes spending against limits for the current day and week.

```tsx
import { SpendDashboard } from "@stwd/react";

function Spend() {
  return <SpendDashboard showWeekly={true} />;
}
```

---

## Hooks

### `useSteward()`

Returns the full Steward context:

```typescript
import { useSteward } from "@stwd/react";

function MyComponent() {
  const { client, agentId, features, theme, isLoading } = useSteward();
  // ...
}
```

**Returns:** `StewardContextValue`

```typescript
interface StewardContextValue {
  client: StewardClient;
  agentId: string;
  features: TenantFeatureFlags;
  theme: TenantTheme;
  tenantConfig: TenantControlPlaneConfig | null;
  isLoading: boolean;
  pollInterval: number;
}
```

### `useWallet()`

Fetches agent identity, balance, and addresses.

```typescript
import { useWallet } from "@stwd/react";

function Balance() {
  const { agent, balance, addresses, isLoading, error } = useWallet();

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <p>Address: {agent?.walletAddresses?.evm}</p>
      <p>Balance: {balance?.balances.nativeFormatted} {balance?.balances.symbol}</p>
    </div>
  );
}
```

### `usePolicies()`

Fetches and manages policies for the current agent.

```typescript
import { usePolicies } from "@stwd/react";

function Policies() {
  const { policies, isLoading, updatePolicies } = usePolicies();
  // ...
}
```

### `useApprovals()`

Fetches the approval queue and provides approve/deny actions.

```typescript
import { useApprovals } from "@stwd/react";

function Queue() {
  const { approvals, approve, deny, isLoading } = useApprovals();
  // ...
}
```

### `useTransactions()`

Fetches transaction history for the current agent.

```typescript
import { useTransactions } from "@stwd/react";

function History() {
  const { transactions, isLoading } = useTransactions();
  // ...
}
```

### `useSpend()`

Fetches spend totals and calculates against policy limits.

```typescript
import { useSpend } from "@stwd/react";

function SpendStatus() {
  const { spentToday, spentThisWeek, limit, isLoading } = useSpend();
  // ...
}
```

---

## Theming

`StewardProvider` applies theme tokens as CSS custom properties on a `div.stwd-root` wrapper. Override any token:

```tsx
<StewardProvider
  client={client}
  agentId="my-agent"
  theme={{
    primaryColor: "#6366f1",       // indigo
    accentColor: "#f59e0b",        // amber
    backgroundColor: "#0f172a",   // dark navy
    surfaceColor: "#1e293b",
    textColor: "#f1f5f9",
    mutedColor: "#64748b",
    successColor: "#22c55e",
    errorColor: "#ef4444",
    warningColor: "#f59e0b",
    borderRadius: 12,
    fontFamily: "Inter, sans-serif",
    colorScheme: "dark",
  }}
>
  {children}
</StewardProvider>
```

**Available CSS variables** (set on `.stwd-root`):

| Variable | Default |
|----------|---------|
| `--stwd-primary` | `#6366f1` |
| `--stwd-accent` | `#8b5cf6` |
| `--stwd-bg` | `#ffffff` |
| `--stwd-surface` | `#f8fafc` |
| `--stwd-text` | `#0f172a` |
| `--stwd-muted` | `#94a3b8` |
| `--stwd-success` | `#22c55e` |
| `--stwd-error` | `#ef4444` |
| `--stwd-warning` | `#f59e0b` |
| `--stwd-radius` | `8px` |

---

## Feature Flags

Control which UI sections are shown. These can be set server-side in the tenant control-plane config or overridden per-`StewardProvider` instance.

```tsx
<StewardProvider
  client={client}
  agentId="my-agent"
  features={{
    showFundingQR: true,
    showTransactionHistory: true,
    showSpendDashboard: true,
    showPolicyControls: false,    // hide policy editing
    showApprovalQueue: true,
    showSecretManager: false,     // hidden by default
    enableSolana: true,
    showChainSelector: false,
    allowAddressExport: true,
  }}
>
```

---

## Full Dashboard Example

```tsx
import { StewardProvider, WalletOverview, TransactionHistory, ApprovalQueue, SpendDashboard } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";
import "@stwd/react/styles.css";

const client = new StewardClient({
  baseUrl: process.env.NEXT_PUBLIC_STEWARD_URL!,
  bearerToken: userJwt,  // from your auth flow
});

export function AgentDashboard({ agentId }: { agentId: string }) {
  return (
    <StewardProvider
      client={client}
      agentId={agentId}
      theme={{ colorScheme: "dark", primaryColor: "#6366f1" }}
      pollInterval={15000}
    >
      <div className="dashboard-grid">
        <WalletOverview chains={["evm", "solana"]} showQR />
        <SpendDashboard showWeekly />
        <ApprovalQueue />
        <TransactionHistory limit={10} />
      </div>
    </StewardProvider>
  );
}
```

---

## Known Limitations

- **No SSR safety** — Components assume browser globals (`navigator`, `window`). Wrap in a client-only boundary when using with Next.js App Router:

  ```tsx
  "use client";
  import { WalletOverview } from "@stwd/react";
  ```

- **No built-in auth modal** — Components handle the wallet management UI, not the login flow. You need to implement your own login UI using the auth endpoints (see [Authentication](./auth.md)) and pass the resulting JWT to `StewardClient`.

- **No zero-state UI** — If an agent has no transactions or policies, components render empty. Implement empty-state messaging in your app layer.
