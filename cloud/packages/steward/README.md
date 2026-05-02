# Steward

Auth + wallet infrastructure for autonomous agents. Open source. Self-hostable. Policy-enforced at the signing layer.

[![npm](https://img.shields.io/npm/v/@stwd/sdk)](https://www.npmjs.com/package/@stwd/sdk)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![API](https://img.shields.io/badge/API-live-brightgreen)](https://api.steward.fi)
[![Docs](https://img.shields.io/badge/docs-steward.fi-blue)](https://docs.steward.fi)

---

## The Problem

AI agents need wallet keys, API keys, database credentials. Today these live as plaintext environment variables, one prompt injection away from exfiltration. No spending controls, no audit trail, no kill switch.

Auth platforms like Privy were built for consumer apps, not agents. They're closed source, can't be self-hosted, charge per-transaction fees, and have no concept of policy enforcement or autonomous operation.

## The Solution

Steward sits between agents and everything they access. Four pillars:

1. **Vault** — AES-256-GCM encrypted keys. EVM (7 chains) + Solana. Keys never exist in plaintext outside a signing operation.
2. **Policy Engine** — 6 composable rule types evaluated before every action. Spending limits, rate limits, address whitelists, time windows, auto-approve thresholds.
3. **Auth** — Passkeys, email magic links, SIWE, Google/Discord OAuth. JWT sessions with refresh token rotation.
4. **Proxy Gateway** — Credential injection for any third-party API. Agents never see raw keys. Full audit trail.

---

## Architecture

```
Agent / App              Steward                        External
┌─────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│ STEWARD_URL │───>│ Auth (JWT/passkey)   │    │ Chains (EVM/Sol) │
│ STEWARD_JWT │    │ Policy Engine        │───>│ OpenAI/Anthropic  │
│             │    │ Wallet Vault         │    │ Any API           │
│ No API keys │    │ Secret Vault         │    └──────────────────┘
│ No priv keys│    │ Proxy Gateway        │
└─────────────┘    │ Audit Log            │
                   └──────────────────────┘
```

---

## Quick Start

```bash
npm install @stwd/sdk
```

```typescript
import { StewardClient } from "@stwd/sdk";

const steward = new StewardClient({
  baseUrl: "https://api.steward.fi",
  apiKey: "stw_your_tenant_key",
  tenantId: "my-app",
});

// Create an agent with EVM + Solana wallets
const agent = await steward.createWallet("trading-bot", "Trading Bot");
console.log(agent.walletAddresses); // { evm: "0x...", solana: "..." }

// Sign a transaction (policy-enforced)
const result = await steward.signTransaction("trading-bot", {
  to: "0xRecipient",
  value: "10000000000000000", // 0.01 ETH
  chainId: 8453, // Base
});
```

See the full [Quickstart Guide](docs/quickstart.md) for auth setup, policies, and self-hosting.

---

## Auth Widget

Drop-in React components for login and wallet management:

```bash
npm install @stwd/react @stwd/sdk
```

```tsx
import { StewardProvider, StewardLogin, StewardAuthGuard } from "@stwd/react";
import "@stwd/react/styles.css";

function App() {
  return (
    <StewardProvider
      client={stewardClient}
      auth={{ baseUrl: "https://api.steward.fi" }}
    >
      <StewardAuthGuard fallback={<StewardLogin methods={["passkey", "email", "google"]} />}>
        <Dashboard />
      </StewardAuthGuard>
    </StewardProvider>
  );
}
```

Components: `StewardLogin`, `StewardAuthGuard`, `StewardUserButton`, `StewardTenantPicker`, `WalletOverview`, `PolicyControls`, `ApprovalQueue`, `SpendDashboard`, `TransactionHistory`.

---

## Packages

| Package | Version | Description |
|---|---|---|
| [`@stwd/sdk`](https://www.npmjs.com/package/@stwd/sdk) | ![npm](https://img.shields.io/npm/v/@stwd/sdk) | TypeScript client for browser + Node. Zero deps. |
| [`@stwd/react`](https://www.npmjs.com/package/@stwd/react) | ![npm](https://img.shields.io/npm/v/@stwd/react) | Drop-in React components: login, wallet, policies, approvals. |
| [`@stwd/eliza-plugin`](https://www.npmjs.com/package/@stwd/eliza-plugin) | ![npm](https://img.shields.io/npm/v/@stwd/eliza-plugin) | ElizaOS integration: sign, transfer, balance, approval evaluator. |
| `@stwd/api` | — | Hono REST API. 30+ endpoints, multi-tenant, dual auth. |
| `@stwd/vault` | — | Wallet + secret encryption. AES-256-GCM, EVM + Solana. |
| `@stwd/policy-engine` | — | Composable policy evaluation. 6 rule types, 1000+ lines of tests. |
| `@stwd/proxy` | — | API proxy with credential injection, alias system, audit trail. |
| `@stwd/auth` | — | Passkeys (WebAuthn), email magic links, SIWE, OAuth. |
| `@stwd/webhooks` | — | HMAC-signed event delivery with retries. |
| `@stwd/db` | — | Drizzle ORM schema, migrations, PGLite adapter. |
| `@stwd/shared` | — | Types, chain metadata, constants. |

---

## Self-Hosting

Steward runs anywhere. Two options:

**Docker (recommended for production):**

```bash
git clone https://github.com/Steward-Fi/steward.git && cd steward
cp .env.example .env
# Set STEWARD_MASTER_PASSWORD and POSTGRES_PASSWORD in .env
docker compose up -d
```

This starts the API (`:3200`), proxy (`:8080`), Postgres, and Redis.

**Embedded mode (no third-party dependencies):**

```bash
bun run start:local
```

Uses PGLite (in-process Postgres via WASM). Data persists to `~/.steward/data/`. Good for local development, CLI agents, and desktop apps.

**Required env vars:**

| Variable | Description |
|---|---|
| `STEWARD_MASTER_PASSWORD` | Derives all vault encryption keys. **No recovery if lost.** |
| `DATABASE_URL` | Postgres connection string (not needed in embedded mode) |
| `STEWARD_SESSION_SECRET` | JWT signing secret (defaults to master password) |
| `REDIS_URL` | Redis for rate limiting + token store (optional) |
| `RESEND_API_KEY` | For email magic link auth (optional) |
| `PASSKEY_RP_ID` | WebAuthn relying party domain (optional) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth (optional) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord OAuth (optional) |

Full list in [`.env.example`](.env.example). See [Deployment Guide](docs/deployment.md) for production setup.

---

## Features

- [x] **Vault**: AES-256-GCM encrypted wallets, EVM (7 chains) + Solana
- [x] **Policy Engine**: 6 composable types (spending-limit, approved-addresses, rate-limit, time-window, auto-approve-threshold, allowed-chains)
- [x] **Auth**: Passkeys (WebAuthn), email magic links, SIWE, Google OAuth, Discord OAuth
- [x] **JWT Sessions**: Access + refresh token rotation, revoke single/all sessions
- [x] **Cross-Tenant Identity**: One user, one wallet, multiple apps
- [x] **Multi-Tenant API**: Full tenant isolation at middleware + DB level
- [x] **Proxy Gateway**: Credential injection, alias system, spend tracking, audit trail
- [x] **React Components**: Login widget, wallet overview, policy controls, approval queue
- [x] **TypeScript SDK**: Typed client, browser + Node, all wallet/policy/auth ops
- [x] **ElizaOS Plugin**: Sign, transfer, balance, approval evaluator
- [x] **Embedded Mode**: PGLite, zero third-party dependencies, same API surface
- [x] **Docker**: Multi-stage Dockerfile, docker-compose with Postgres + Redis
- [x] **Webhooks**: HMAC-signed events (tx.signed, tx.pending, policy.violation, etc.)
- [x] **Per-Tenant CORS**: Configurable allowed origins per tenant

---

## Competitive Landscape

| | Steward | Privy (Stripe) | Vincent (Lit) | Turnkey | Crossmint | AgentKit (Coinbase) |
|---|---|---|---|---|---|---|
| **Open Source** | ✅ MIT | ❌ | ✅ | ❌ | ❌ | ✅ |
| **Self-Hostable** | ✅ | ❌ | ❌ (needs Lit network) | ❌ | ❌ | ✅ |
| **Auth** | ✅ Passkey/email/SIWE/OAuth | ✅ All methods | ❌ | ❌ | ❌ | ❌ |
| **Policy Enforcement** | ✅ 6 types, vault-level | Partial (app-layer) | ✅ On-chain | ❌ | ✅ | ❌ |
| **Agent-Native** | ✅ | Bolted on | ✅ | Partial | ✅ | ✅ |
| **Credential Proxy** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

Steward is the only platform that checks all six boxes. The proxy gateway (credential injection for any API, not just wallets) is unique.

---

## Supported Chains

Ethereum · Base · Polygon · Arbitrum · BSC · Base Sepolia · BSC Testnet · Solana

---

## Building With

[ElizaOS](https://elizaos.ai) · [Eliza](https://eliza.gg) · [Babylon](https://babylon.market) · [Hyperscape](https://hyperscape.ai) · [Strata Reserve](https://stratareserve.co)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR guidelines.

## Links

- **Website:** [steward.fi](https://steward.fi)
- **Docs:** [docs.steward.fi](https://docs.steward.fi)
- **API:** [api.steward.fi](https://api.steward.fi)
- **npm:** [@stwd/sdk](https://www.npmjs.com/package/@stwd/sdk) · [@stwd/react](https://www.npmjs.com/package/@stwd/react) · [@stwd/eliza-plugin](https://www.npmjs.com/package/@stwd/eliza-plugin)

## License

[MIT](LICENSE)
