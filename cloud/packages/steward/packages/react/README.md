# @stwd/react

Embeddable React components for Steward agent wallet management. Drop-in UI for wallet overview, transaction history, policy controls, approval queues, and spend analytics.

## Install

```bash
npm install @stwd/react @stwd/sdk
```

## Quick Start

```tsx
import { StewardProvider, WalletOverview, PolicyControls, TransactionHistory } from "@stwd/react";
import "@stwd/react/styles.css";
import { StewardClient } from "@stwd/sdk";

const client = new StewardClient({
  baseUrl: "https://api.steward.fi",
  bearerToken: agentJwt,
});

function AgentWalletPage({ agentId }: { agentId: string }) {
  return (
    <StewardProvider client={client} agentId={agentId}>
      <WalletOverview showQR />
      <PolicyControls />
      <TransactionHistory pageSize={10} />
    </StewardProvider>
  );
}
```

## Components

| Component | Description |
|-----------|-------------|
| `<StewardProvider>` | Context provider — wraps all other components |
| `<WalletOverview>` | Wallet address, balance, chain info, funding QR |
| `<TransactionHistory>` | Paginated tx list with status badges and explorer links |
| `<PolicyControls>` | Human-friendly policy toggles (spending limits, address lists, etc.) |
| `<ApprovalQueue>` | Pending transaction review with approve/deny |
| `<SpendDashboard>` | Spend tracking with budget bars and charts |

## Hooks

All components use public hooks. Use them directly for custom UIs:

```tsx
import { useSteward, useWallet, useTransactions, usePolicies, useApprovals, useSpend } from "@stwd/react";
```

| Hook | Returns |
|------|---------|
| `useSteward()` | Client, agentId, features, theme, tenant config |
| `useWallet()` | Agent data, balance, addresses with auto-refresh |
| `useTransactions(opts?)` | Paginated tx history |
| `usePolicies()` | Policy CRUD + template support |
| `useApprovals(interval?)` | Pending approvals + approve/reject actions |
| `useSpend(range?)` | Spend analytics for time range |

## Theming

Components use CSS custom properties. Override any `--stwd-*` variable:

```css
.stwd-root {
  --stwd-primary: #8B5CF6;
  --stwd-accent: #A78BFA;
  --stwd-bg: #0F0F0F;
  --stwd-surface: #1A1A2E;
  --stwd-text: #FAFAFA;
  --stwd-muted: #6B7280;
  --stwd-success: #10B981;
  --stwd-error: #EF4444;
  --stwd-warning: #F59E0B;
  --stwd-radius: 12px;
  --stwd-font: Inter, system-ui, sans-serif;
}
```

Or pass theme overrides to the provider:

```tsx
<StewardProvider
  client={client}
  agentId={agentId}
  theme={{ primaryColor: "#FF6B35", colorScheme: "light" }}
>
```

## Wallet Login

First-class EVM + Solana sign-in. Uses [wagmi](https://wagmi.sh) + [RainbowKit](https://rainbowkit.com) on EVM and [`@solana/wallet-adapter-react`](https://github.com/anza-xyz/wallet-adapter) on Solana.

**Imported from a subpath to keep wallet peer deps off the root entrypoint:**

```ts
import { WalletLogin, EVMWalletProvider, SolanaWalletProvider } from "@stwd/react/wallet";
```

Consumers that don't use wallet login can continue to import everything else from `@stwd/react` without installing wagmi / rainbowkit / @solana/*. The wallet entrypoint itself loads each chain's panel dynamically, so `chains="evm"` never resolves `@solana/*` at runtime (and vice versa).

### Install

```bash
bun add @stwd/react @stwd/sdk
# EVM
bun add wagmi viem @rainbow-me/rainbowkit @tanstack/react-query
# Solana
bun add @solana/wallet-adapter-react @solana/wallet-adapter-react-ui \
        @solana/wallet-adapter-wallets @solana/web3.js bs58
```

All wallet packages are declared as **optional peer dependencies**. Install only the families you need. `@tanstack/react-query` is required whenever you use `EVMWalletProvider` or anything wagmi downstream.

### Basic usage

```tsx
import { StewardProvider } from "@stwd/react";
import {
  EVMWalletProvider,
  SolanaWalletProvider,
  WalletLogin,
} from "@stwd/react/wallet";
import "@stwd/react/styles.css";
import "@rainbow-me/rainbowkit/styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { mainnet, base } from "wagmi/chains";

const wagmiConfig = getDefaultConfig({
  appName: "Steward",
  projectId: "YOUR_WC_PROJECT_ID",
  chains: [mainnet, base],
});

export function App() {
  return (
    <StewardProvider
      client={client}
      agentId="agent_abc"
      auth={{ baseUrl: "https://api.steward.fi" }}
    >
      <EVMWalletProvider config={wagmiConfig}>
        <SolanaWalletProvider endpoint="https://api.mainnet-beta.solana.com">
          <WalletLogin
            chains="both"
            onSuccess={(res, kind) => console.log(kind, res.token)}
          />
        </SolanaWalletProvider>
      </EVMWalletProvider>
    </StewardProvider>
  );
}
```

### Advanced: bring your own providers

`<EVMWalletProvider>` and `<SolanaWalletProvider>` are optional convenience wrappers. `<EVMWalletProvider>` also mounts a `QueryClientProvider` for wagmi v2 hooks; pass your own `queryClient` prop if your app already has one. If your app already mounts wagmi + RainbowKit + TanStack Query + Solana wallet-adapter providers elsewhere, `<WalletLogin />` will pick them up automatically.

```tsx
<WagmiProvider config={wagmiConfig}>
  <RainbowKitProvider theme={darkTheme()}>
    <ConnectionProvider endpoint={rpc}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <StewardProvider client={client} agentId="..." auth={{ baseUrl: "..." }}>
            <WalletLogin chains="both" />
          </StewardProvider>
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  </RainbowKitProvider>
</WagmiProvider>
```

### Props

| Prop              | Type                                           | Default  | Notes                                                    |
| ----------------- | ---------------------------------------------- | -------- | -------------------------------------------------------- |
| `chains`          | `"evm" \| "solana" \| "both"`                  | `"both"` | Two-column layout on desktop when `"both"`.              |
| `onSuccess`       | `(result, kind) => void`                       | -        | Fires after SIWE / SIWS exchange.                        |
| `onError`         | `(error, kind) => void`                        | -        | Fires on wallet reject, network errors, etc.             |
| `className`       | `string`                                       | -        | Appended to the root element.                            |
| `classes`         | `WalletLoginClassOverrides`                    | -        | Per-slot className overrides (root, column, button, …). |
| `evmLabel`        | `string`                                       | `"Ethereum"` | Column heading for EVM.                              |
| `solanaLabel`     | `string`                                       | `"Solana"`   | Column heading for Solana.                           |
| `evmSignLabel`    | `(walletName) => string`                       | -        | Override the sign button label.                          |
| `solanaSignLabel` | `(walletName) => string`                       | -        | Override the sign button label.                          |

### Styling

Dark first. Cream text (`#eaeaea`) on black (`#000`), sharp corners, JetBrains Mono font stack. Override any `--stwd-wallet-*` custom property on the root or pass a `classes` override per slot.

```css
.my-wallet {
  --stwd-wallet-bg: #0b0b0b;
  --stwd-wallet-accent: #ff6b35;
}
```

```tsx
<WalletLogin
  className="my-wallet"
  classes={{ signButton: "my-sign-btn" }}
/>
```

### FAQ

**Does it work without `<EVMWalletProvider>` / `<SolanaWalletProvider>`?**
Yes. They are optional convenience wrappers. `<WalletLogin />` only needs the ambient wagmi + RainbowKit context (for EVM) and the Solana wallet-adapter context (for Solana) to exist somewhere above it.

**Can I ship EVM only?**
Yes. Install only the EVM peer deps, pass `chains="evm"`, and skip the Solana providers entirely. The Solana panel is tree-shaken out when unused.

**How do errors surface?**
Inline under the relevant column (rejected signatures, wrong chain, server errors) and via `onError(error, kind)`.

**Does `<WalletLogin />` disconnect the wallet after sign-in?**
No. The wallet stays connected so the user can re-sign, sign transactions, etc. Call `useDisconnect()` / `useWallet().disconnect()` yourself if you want to drop the connection.

**Solana sign-in is disabled.**
This means either the connected wallet does not implement `signMessage`, or `@stwd/sdk` has not been upgraded to a version that exposes `signInWithSolana`. Upgrade to `@stwd/sdk >= 0.8.0`.

## Peer Dependencies

Required:
- `react >= 18`
- `react-dom >= 18`
- `@stwd/sdk >= 0.7.3`

Optional (install only what you use):
- `wagmi ^2.0.0` + `viem ^2.0.0` + `@rainbow-me/rainbowkit ^2.0.0` (EVM)
- `@solana/wallet-adapter-react ^0.15.0`, `@solana/wallet-adapter-react-ui ^0.9.0`, `@solana/wallet-adapter-wallets ^0.19.0`, `@solana/web3.js ^1.90.0`, `bs58 ^5.0.0` (Solana)

## License

MIT
