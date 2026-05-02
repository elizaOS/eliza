# Steward Status Report — April 6, 2026

## Positioning

**Steward = high abstraction + open source + self-hostable.**

The agent wallet market has split into two tiers:
- **Full-stack platforms** (Crossmint, Coinbase AgentKit, thirdweb) — wallet + payments, but closed, hosted-only
- **Signing infrastructure** (Turnkey, Privy, Dynamic, Alchemy) — lower-level, also closed

Nobody occupies the quadrant Steward is targeting: **high abstraction (auth + wallets + policies + proxy, not just signing primitives) + open source + self-hostable.** Vincent (Lit Protocol) is the closest comparison — open source agent wallets with on-chain policy registry — but it requires the Lit MPC/TEE network, can't self-host, and is decentralized-infra-first rather than developer-experience-first.

Steward's edge: you can `npm install @stwd/sdk`, point at a hosted instance OR run your own, and get auth + wallets + policies + credential proxy in one package. No TEE dependency, no token required, no vendor lock-in.

---

## What's Built (production-ready core)

| Component | Status | Notes |
|---|---|---|
| **Vault** (AES-256-GCM) | ✅ Solid | EVM + Solana signing, 7 chains, key import, well-tested |
| **Policy Engine** | ✅ Solid | 6 composable types, 1028 lines of tests, stateless evaluation |
| **Multi-tenant API** | ✅ Solid | Hono, dual auth (JWT + API key), tenant isolation at middleware + DB |
| **Auth: Passkeys** | ✅ Works | WebAuthn via simplewebauthn v13, register + login flows |
| **Auth: Email magic links** | ✅ Works | Resend provider, 10min TTL, magic link callback |
| **Auth: SIWE** | ✅ Works | Nonce generation, signature verification, JWT session |
| **Auth: OAuth (Google, Discord)** | ✅ Works | Authorization code flow, token exchange, accounts table linked |
| **Auth: Refresh tokens** | ✅ Works | 30-day tokens, rotation on use, revoke single/all sessions |
| **Per-tenant CORS** | ✅ Wired | tenant-cors middleware reads allowed_origins from DB, falls back to * |
| **SDK** (`@stwd/sdk`) | ✅ Published | npm, typed, browser + Node, all wallet/policy/approval ops |
| **React components** (`@stwd/react`) | ✅ Built | WalletOverview, PolicyControls, ApprovalQueue, SpendDashboard, hooks |
| **ElizaOS plugin** | ✅ Built | sign-transaction, transfer, balance, approval evaluator |
| **Proxy gateway** | ✅ Built | Credential injection, alias system, audit trail, rate limiting |
| **Embedded mode** (PGLite) | ✅ Works | Zero-dependency local mode, auto-migrations |
| **Dashboard** (steward.fi) | ✅ Deployed | Passkey + email login, agent management, policy config |
| **Docs** | ✅ Just rewritten | 9 docs covering quickstart → deployment → privy migration |
| **P0 deployment fixes** | ✅ Just merged | Dockerfile, migration ordering, .env.example, /ready endpoint |

---

## What's Needed — For Milady

Milady currently uses Steward for **agent wallets only**. Auth is separate (ElizaCloud OAuth for cloud, pairing codes for local). The integration is through a custom bridge layer (6 files, ~2000 lines) and 14 compat HTTP endpoints.

### Current state in milady
- Steward sidecar spawns alongside desktop milady (embedded PGLite)
- Cloud containers get STEWARD_* env vars injected at provisioning
- Agent gets wallet auto-provisioned on first steward-status check
- Wallet UI (InventoryView) shows balances, policies, approvals, trade panel
- Policy CRUD works through dialog popups (just shipped on sym/ui-cleanup)

### Gaps for milady

| Gap | Impact | Effort |
|---|---|---|
| **User auth through steward** | Users don't authenticate via steward. Cloud uses ElizaCloud OAuth, local uses pairing codes. Steward's auth is unused. | Large — need to wire passkey/email/SIWE into milady's login flow, replace or supplement ElizaCloud OAuth |
| **User wallets** | Only agent wallets exist. No user-facing wallets for players/users. `provisionUserWallet` exists in steward but milady never calls it. | Medium — endpoint exists, need UI + flow |
| **Sidecar reliability** | Spawning steward as child process is fragile (entry point detection, no fallback, breaks in containers/electron). | Medium — needs auto-start, graceful fallback, health monitoring |
| **Tenant bootstrap** | Bridge tries wrong endpoint (`POST /tenants` instead of `/platform/tenants`), uses master password in client env. | Small — we partially fixed this, needs clean-up |
| **Custom UI vs @stwd/react** | Milady rebuilt all wallet components (InventoryView, trade panel, approval queue) instead of using `@stwd/react` embeddable components. 2000+ lines of custom code. | Large to migrate, but optional. Custom UI works fine. |
| **Proxy gateway unused** | Milady doesn't use steward's credential proxy for external API calls (OpenAI, etc.). Keys are in plaintext env vars. | Medium — wire agent's API calls through proxy |

### What to do for milady (priority order)
1. **Fix sidecar to auto-start seamlessly** — detect embedded mode, auto-generate master password, persist to ~/.milady/steward/, no manual config
2. **Wire user auth through steward** — passkey/email login on milady produces a steward JWT, auto-provisions user wallet
3. **Expose user wallet in UI** — "Your Wallet" section alongside "Agent Wallet"
4. **Clean up tenant bootstrap** — use platform API properly, don't leak master password to client

---

## What's Needed — For ElizaCloud

ElizaCloud needs steward as the **central auth + wallet service** replacing Privy. All products (babylon, milady cloud, hyperscape) become tenants.

### Current state in elizacloud
- ElizaCloud has its own auth (Privy for cloud users)
- Steward is used only for container agent wallets during provisioning
- Each Docker node runs a shared steward instance
- Provisioning injects STEWARD_API_URL + STEWARD_AGENT_ID + STEWARD_AUTH_TOKEN into containers

### Gaps for elizacloud

| Gap | Impact | Effort |
|---|---|---|
| **Replace Privy for user auth** | The whole point. Steward needs to handle cloud user signup/login. Passkeys + email + social (Google, Discord). | Large — auth backend ready, need: social login providers, React auth widget (`<StewardLogin />`), session management integration |
| **Cross-tenant user identity** | Users should be global. Sign up on babylon, same wallet on milady. Current model creates `personal-{userId}` tenant per user. Need `user_tenants` join table for multi-app identity. | Medium — DB schema change + auth flow update |
| ~~Social login (Google, Discord)~~ | ✅ Shipped | Google + Discord OAuth complete; wire GOOGLE_CLIENT_ID / DISCORD_CLIENT_ID env vars to enable |
| **React auth widget** | `<StewardLogin />` drop-in component. Email input, passkey button, social buttons, handles the full flow. This is what odi needs for babylon. | Medium — UI component + SDK auth methods |
| **Production deployment** | Dockerfile just fixed but needs testing at scale. Need: proper docker-compose for hosted mode, Redis for sessions/rate-limiting, monitoring, backup strategy for encrypted keys. | Medium |
| **Tenant self-service** | Apps need to create their own tenant, configure CORS origins, set default policies, get API keys. Currently requires platform API key (admin-only). | Medium — dashboard UI + API |
| **SDK auth methods** | `@stwd/sdk` has wallet ops but no auth flow (signInWithPasskey, signInWithEmail, etc.). Need these for non-React integrations. | Small-medium |
| **Token store persistence** | Challenge stores (passkey, magic link) are in-memory. Multi-instance breaks passkeys, restart loses active magic links. Need Redis or DB-backed store. | Small |
| ~~JWT refresh tokens~~ | ✅ Shipped | 30-day tokens, rotation, POST /auth/refresh + POST /auth/revoke + DELETE /auth/sessions |
| ~~Per-tenant CORS~~ | ✅ Shipped | tenant-cors middleware live; reads allowed_origins from tenant_configs, falls back to * |

### What to do for elizacloud (priority order)
1. **`<StewardLogin />` React component** — drop-in auth widget (passkey + email). This unblocks babylon.
2. **SDK auth methods** — `signInWithPasskey()`, `signInWithEmail()` in `@stwd/sdk`
3. **Google + Discord OAuth** — add to auth routes, wire into login widget
4. **Cross-tenant user identity** — schema migration, auth flow update
5. **Token store → Redis/DB** — persist challenges, survive restarts
6. **Per-tenant CORS config** — tenant config table already has fields, wire to middleware
7. **Production docker-compose** — steward API + Redis + Postgres, ready to deploy on elizacloud infra
8. **Tenant self-service dashboard** — create tenant, configure, get keys

---

## Competitive Landscape (April 2026)

| Platform | Open Source | Self-Host | Auth | Policies | Agent-Native | Credential Proxy |
|---|---|---|---|---|---|---|
| **Steward** | ✅ | ✅ | ✅ (passkey/email/SIWE/Google/Discord) | ✅ (6 types) | ✅ | ✅ |
| Privy (Stripe) | ❌ | ❌ | ✅ (all methods) | Partial | Bolted on | ❌ |
| Vincent (Lit) | ✅ | ❌ (needs Lit network) | ❌ | ✅ (on-chain) | ✅ | ❌ |
| Turnkey | ❌ | ❌ | ❌ | ❌ | Partial | ❌ |
| Crossmint | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Coinbase AgentKit | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Dynamic | ❌ | ❌ | ✅ | ❌ | Developing | ❌ |

**Steward is the only platform that checks all six boxes.** The proxy gateway (credential injection for any API, not just wallets) is unique in the market.

---

## Timeline

**Week 1-2: Babylon unblock**
- `<StewardLogin />` react component
- SDK auth methods
- Google OAuth
- Publish `@stwd/react` to npm

**Week 3-4: ElizaCloud integration**
- Discord OAuth
- Cross-tenant user identity
- Token store persistence (Redis)
- Production docker-compose
- Per-tenant CORS

**Week 5-6: Milady migration**
- Seamless sidecar auto-start
- User auth through steward
- User wallet UI
- Clean up tenant bootstrap

**Week 7-8: Polish + launch**
- Tenant self-service dashboard
- Security audit
- Public announcement
- Privy migration campaign (target high-star GitHub repos)
