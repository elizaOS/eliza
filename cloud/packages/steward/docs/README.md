# Steward

**Steward is a governance layer for autonomous AI agents.** It provides encrypted wallet management, policy enforcement, secret storage, credential injection, and embeddable React UI — so agents can transact on-chain and call external APIs without ever touching raw private keys or credentials.

## What It Does

Agents running inside containers typically get credentials injected as plain environment variables:

```bash
# Dangerous: raw credentials in the environment
EVM_PRIVATE_KEY=0xdeadbeef...
OPENAI_API_KEY=sk-proj-abc123...
```

Any code running in that container — including code triggered by prompt injection — can exfiltrate them. There's no spending control, no audit trail, no way to rotate without redeployment.

With Steward, agents only get two variables:

```bash
# Safe: Steward proxy + agent token
STEWARD_PROXY_URL=http://steward-proxy:8080
STEWARD_AGENT_TOKEN=stwd_jwt_...
```

Every transaction and every API call flows through Steward, where it is authenticated, policy-checked, logged, and metered before being forwarded with real credentials injected at the proxy.

## Core Primitives

| Primitive | What it does |
|-----------|-------------|
| **Wallet Vault** | AES-256-GCM encrypted key storage. Creates EVM + Solana keypairs per agent. Agents request signatures; private keys never leave the vault. |
| **Policy Engine** | Declarative rules evaluated before every signing request: spending limits, address whitelists, rate limits, time windows, chain filters, auto-approve thresholds. |
| **Secret Vault** | Encrypted credential storage. The proxy injects secrets at request time; agents never see the raw values. |
| **API Proxy** | Routes agent HTTP calls through Steward for credential injection, cost tracking, and audit logging. |
| **Approval Queue** | Large or unusual transactions queue for human review before execution. |
| **Webhooks** | Push notifications on `tx.pending`, `tx.signed`, `tx.approved`, `tx.denied`, `policy.violation`, `spend.threshold`. |

## Two Deployment Modes

**Embedded (local)** — Uses PGLite (Postgres-in-WASM). No external database. Ideal for desktop tools, local dev, and single-user deployments.

```bash
bun run start:local
```

**Hosted** — Backed by PostgreSQL, optional Redis for rate limiting and spend tracking. For production multi-tenant deployments.

```bash
docker compose up -d
```

## Packages

| Package | Description |
|---------|-------------|
| `packages/api` | Hono REST API server (Bun runtime) |
| `packages/auth` | Auth primitives: passkeys, email magic links, SIWE, JWT, API keys |
| `packages/db` | Drizzle ORM schema + PGLite/Postgres client |
| `packages/vault` | AES-256-GCM key management, EVM + Solana signing |
| `packages/policy-engine` | Stateless policy evaluator |
| `packages/sdk` | TypeScript client (`@stwd/sdk`) |
| `packages/react` | Embeddable React components (`@stwd/react`) |
| `packages/eliza-plugin` | ElizaOS plugin |
| `packages/proxy` | Credential injection proxy |
| `packages/webhooks` | Signed webhook dispatcher with retry queue |
| `packages/shared` | Shared types, chain constants, price oracle |

## Documentation

- [**Quickstart**](./quickstart.md) — Up and running in 5 minutes
- [**Architecture**](./architecture.md) — How the pieces fit together
- [**Authentication**](./auth.md) — Passkeys, magic links, SIWE, JWT, API keys
- [**Policy Engine**](./policies.md) — Spending limits, whitelists, rate limits, and more
- [**SDK Reference**](./sdk.md) — `@stwd/sdk` TypeScript client
- [**React Components**](./react.md) — `@stwd/react` embeddable UI
- [**Deployment Guide**](./deployment.md) — Docker, environment variables, database setup
- [**Migrate from Privy**](./migration-from-privy.md) — Drop-in replacement guide

## Who Uses Steward

- **Milady Cloud** — Production deployment managing 17+ AI agents across 6 nodes on Base mainnet
- **Agent developers** — Anyone building autonomous agents that need wallet access or API credential management
- **Platform operators** — Teams running multi-tenant agent hosting who need security, cost control, and compliance
- **Desktop apps** — Local mode with PGLite runs as an embedded sidecar with zero external dependencies
