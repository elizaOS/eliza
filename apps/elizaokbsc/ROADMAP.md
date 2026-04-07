# ElizaOK roadmap (apps/elizaokbsc)

This roadmap lists **intended next steps** and **why** they matter. It is not a commitment or release calendar; priorities shift with hackathons, ops load, and upstream ElizaOS/ElizaCloud changes.

## Near term (integration hardening)

| Item | Why |
|------|-----|
| **Optional refresh for app-auth** (e.g. store rotated API key or server-side token exchange) | Today, sessions without `apiKey` skip `refreshElizaCloudSession`; credits can go stale until re-login. A deliberate token strategy would improve UX without weakening security. |
| **Structured logging for Cloud 401/403/429** (behind `LOG_LEVEL` or env flag) | Easier production debugging than guessing why credits show “syncing”; avoid logging raw tokens. |
| **Respect `Retry-After` HTTP-date** | Spec allows non-integer values; we only parse seconds today. Low incidence, better spec compliance. |
| **Cancel or drain 429 response bodies** before retry | Defensive for keep-alive edge cases. |

## Medium term (product / ops)

| Item | Why |
|------|-----|
| **Collapse redundant parallel calls** when profile already includes balance | Fewer requests, less rate-limit surface; must not break “fresh balance” semantics after top-up. |
| **Explicit user-facing error** when credits return 403 (no org) | Reduces support confusion vs generic “credits syncing”. |
| **Dashboard E2E smoke** (Playwright or similar) against staging Cloud | Catches auth/header regressions before demos. |

## Longer term (architecture)

| Item | Why |
|------|-----|
| **Typed OpenAPI or zod schemas** for Cloud v1 responses | Safer evolution when Cloud adds fields or stricter validation. |
| **Optional Redis cache** for summary/balance per session | Protect Cloud and ElizaOK when many operators refresh dashboards; needs TTL and invalidation policy. |

## Explicit non-goals (for now)

- **Forking or vendoring ElizaCloud** — we integrate via public API contracts; Cloud changes belong in the Cloud repo.
- **Storing Privy JWT in ElizaOK cookies long-term** without threat modeling — session length and refresh are product/security decisions.

## How to propose changes

Open an issue or PR in the monorepo describing **user impact** and **why** the change is worth the maintenance cost. Link to `docs/elizacloud-integration.md` when touching Cloud auth or credits.
