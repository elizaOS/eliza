# Steward Vision

## Mission

Every agent deserves a bank account it can't be robbed of.

AI agents are managing real money, signing real transactions, calling paid APIs. The infrastructure securing those operations is a `.env` file with plaintext keys. One prompt injection, one leaked log, one compromised dependency, and everything is gone.

Steward exists to make that impossible. Not through trust, through architecture: encrypted vaults, policy enforcement at the signing layer, credential isolation at the proxy layer. Agents operate autonomously within constraints their operators define. No exceptions, no workarounds.

---

## Architecture

Four pillars. Each solves a distinct problem. Together they form a complete security and auth layer for any agent platform.

### Vault
AES-256-GCM encrypted key storage. Per-agent encryption keys derived from master password + agent ID via PBKDF2. Private keys are decrypted ephemerally for signing and never returned to callers. Supports EVM (7 chains) and Solana (Ed25519).

### Policy Engine
Composable rules evaluated synchronously before every signing operation. Six types: spending limits (per-tx, daily, weekly), approved address lists, rate limits, time windows, auto-approve thresholds, and allowed chains. Hard policies reject. Soft policies (auto-approve-threshold) queue for human review. All policies must pass for a transaction to be signed. The engine is stateless; spend and rate context are pre-fetched and injected.

### Auth
User authentication with passkeys (WebAuthn), email magic links, Sign-In With Ethereum, and OAuth (Google, Discord). JWT sessions with refresh token rotation. Users are global identities that can belong to multiple tenants. On first login, users get an auto-provisioned embedded wallet.

### Proxy Gateway
Sits between agents and any third-party API (OpenAI, exchanges, RPC providers). Agents send requests to the proxy. Steward authenticates the agent, decrypts the right credential from the vault, injects it into the outbound request, and streams the response back. The agent never touches the raw key. Full audit trail, rate limiting, and spend tracking on every call.

---

## Positioning

The agent wallet market has fragmented into closed platforms and low-level primitives. Nobody occupies the quadrant Steward targets:

**High abstraction + open source + self-hostable.**

Six capabilities define the space. Most platforms cover two or three:

| Capability | What it means |
|---|---|
| **Open source** | Audit the code. Fork it. No black boxes. |
| **Self-hostable** | Run it on your infra. No vendor dependency. No token required. |
| **Auth** | User login (passkeys, email, OAuth, SIWE). Not just API keys. |
| **Policy enforcement** | Rules enforced at the vault, not the application layer. |
| **Agent-native** | Built for autonomous operation, not retrofitted from consumer auth. |
| **Credential proxy** | Manages all sensitive credentials, not just wallet keys. |

Steward checks all six. The closest competitors each miss critical boxes: Privy is closed and hosted-only. Vincent requires the Lit MPC network. Turnkey has no auth or policies. Coinbase AgentKit is open but low-abstraction (signing primitives only, no auth/policies/proxy).

---

## Two Deployment Modes

**Hosted** (steward.fi / your cloud): Multi-tenant, production-grade. Drop-in replacement for Privy. Your app is a tenant. Zero infra overhead.

**Embedded** (PGLite): Local-first, runs in-process. Same vault, same policies, same SDK. For desktop apps, CLI agents, self-hosted deployments. No third-party database, no network dependency.

Same API surface. Same guarantees. Write the integration once.

---

## Roadmap

### Shipped
- Vault with AES-256-GCM encryption, EVM + Solana
- Policy engine with 6 composable rule types
- Multi-tenant API with full tenant isolation
- Auth: passkeys, email magic links, SIWE, Google OAuth, Discord OAuth
- JWT sessions with refresh token rotation
- Cross-tenant user identity
- TypeScript SDK (`@stwd/sdk`)
- React components (`@stwd/react`): login, wallet, policies, approvals
- ElizaOS plugin (`@stwd/eliza-plugin`)
- Proxy gateway with credential injection
- Embedded mode (PGLite)
- Production Docker setup (API + proxy + Postgres + Redis)
- Webhook system with HMAC-signed delivery

### Next
- Eliza Cloud integration (replace Privy as auth + wallet layer)
- Dashboard self-service (tenant creation, policy configuration, API key management)
- Production hardening (security audit, token store persistence, monitoring)
- Babylon integration
- Pluggable key storage backends (AWS KMS, Hashicorp Vault)
- Strata Reserve deployment

---

## Values

**Open source.** MIT license. The code is the documentation. If you don't trust it, read it.

**Developer-first.** `npm install @stwd/sdk` and you're building. No sales calls, no onboarding decks, no "contact us for pricing."

**No vendor lock-in.** Self-host the entire stack. Export your data. Switch providers. Your keys, your infra, your choice.

**No token required.** Steward is infrastructure, not a protocol. No governance token, no staking requirement, no on-chain dependency for basic operations.

**Policy is architecture, not advice.** Rules are enforced at the cryptographic signing layer. Not in middleware. Not in application code. Not as suggestions. If the policy says no, the vault won't sign it.
