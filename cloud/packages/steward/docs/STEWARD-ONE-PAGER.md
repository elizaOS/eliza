# Steward

**Auth + wallet infrastructure for autonomous agents and apps. Open source. Self-hostable. Policy-enforced at the signing layer.**

---

## What It Is

Steward is the auth and embedded wallet layer your apps and agents should have been running on from day one. It handles user authentication (passkeys, magic links, SIWE), non-custodial wallet creation, and cryptographically-enforced transaction policies — all in one API. It was built for the agent era: apps and agents get wallets that can act autonomously, but only within rules you define. Every signing request hits the policy engine before it hits the chain. No exceptions.

---

## The Problem

Privy was the go-to for embedded wallets. Then Stripe acquired them in June 2025. Developers are anxious — and reasonably so. Privy takes 1% of transaction volume, is fully closed source, can't be self-hosted, and was architected for consumer apps, not agents. It has no concept of autonomous operation, policy enforcement, or embedded-first deployment. You're locked in, paying a tax on every transaction, and wholly dependent on a Stripe-owned black box that was never designed for what you're building.

---

## Two Modes, One API

**Hosted** (`steward.fi` / elizacloud) — Multi-tenant, cloud-deployed. Drop-in Privy replacement for web apps. Your users are global, your app is a tenant. Zero infra overhead.

**Embedded** (PGLite) — Local-first, runs in-process. Same vault, same policy engine, same SDK — for desktop apps, CLI agents, and self-hosted deployments. No network dependency, no external service.

Same API surface. Same guarantees. Same policy enforcement. You write the integration once.

---

## Auth

Passkeys, email magic links, Sign-In With Ethereum, and Google and Discord social logins. Users are first-class global identities. Apps are tenants. Sessions are portable across both deployment modes.

---

## Policy Engine

This is the thing Privy can't do. Policies are defined at the wallet level and enforced at the signing layer — not in your application code. Rules include: spending limits, approved address allowlists, rate limiting, time windows, auto-approve thresholds, and custom evaluator functions.

The implication: even if your agent code is compromised, it cannot exceed its policy limits. The vault won't sign it. Policy isn't advice — it's a hard constraint at the cryptographic signing layer.

Note: Privy now has server wallet policies, but they operate at the application layer — if the Privy server is compromised, those rules can be bypassed. Steward's policies are enforced inside the vault itself, regardless of what calls it.

---

## Proxy Gateway — Credential Injection

Steward doesn't just manage wallet keys. The proxy gateway sits between agents and any external API (OpenAI, exchanges, RPC providers). Agents send requests to the proxy; Steward authenticates the agent, decrypts the right API key from the vault, injects it into the outbound request, and streams the response back. The agent never sees the raw credential. Full audit trail, rate limiting, and spend tracking on every call.

This means one Steward instance manages all sensitive credentials for all your agents — wallet keys, API keys, exchange secrets — with the same policy and audit layer across everything.

---

## Building With

ElizaLabs, Milady, Babylon, Hyperscape, Strata Reserve.

---

## Stack

TypeScript / Hono, Postgres, AES-256-GCM vault, EVM + Solana, React SDK, ElizaOS plugin.

---

## What's Shipped

Vault ✅ Policy engine ✅ Multi-tenant API ✅ Passkey + email auth ✅ Social login (Google, Discord) ✅ Refresh tokens ✅ SDK ✅ React components ✅ ElizaOS plugin ✅ Embedded mode (PGLite) ✅ Production Docker image ✅

---

## What's Next

Security audit, public docs site, Babylon integration, Strata deployment.

---

*steward.fi*
