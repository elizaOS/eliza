# PWA Session Persist - 2026-07-18

## Flow

Eliza Cloud opens a hosted dedicated agent at `/pair?token=<one-time-token>`.
The agent-side pairing route exchanges that short-lived token with Cloud for the
agent-local `ELIZA_API_TOKEN`, returns a no-store HTML handoff page, stores the
token in browser storage, seeds the boot-config singleton for the current page,
and redirects to `/`. The app boot code then adopts the stored token, configures
the API client, and persists the active cloud agent profile.

## Root Cause

The long-lived per-agent API token was stored only in `sessionStorage` under
`eliza:cloud-pair:api-token`. iOS standalone PWA sessions can lose
`sessionStorage` when the PWA process is terminated, so a previously paired
agent relaunched without the bearer token and fell back to the Cloud-hosted auth
notice.

## Secret And Deploy Analysis

The paired token is the container's existing `ELIZA_API_TOKEN`; this change does
not mint, transform, shorten, or lengthen it. The pairing-token exchange and its
existing expiry/validation remain unchanged.

Blue/green image upgrades preserve the same token. In
`packages/cloud/shared/src/lib/services/eliza-sandbox.ts`, `executeUpgrade`
decrypts the stored `environment_vars`, builds the blue container's
`environmentVars` as the decrypted env plus managed inference defaults, and the
inline comment explicitly records that `DATABASE_URL`, `ELIZA_API_TOKEN`,
`ELIZAOS_CLOUD_API_KEY`, and other non-inference values are preserved verbatim.
That path avoids the full provision merge that would mint a new API key.

## Fix

The pairing handoff now writes the same key,
`eliza:cloud-pair:api-token`, to both `sessionStorage` and `localStorage`.
`sessionStorage` remains for same-tab migration and compatibility; `localStorage`
is the durable PWA channel.

Updated paths:

- `packages/ui/src/components/auth/CloudPairRelay.tsx`
- `packages/agent/src/api/cloud-pair-route.ts`
- `packages/app-core/src/api/cloud-pair-route.ts`
- `packages/app/src/main.tsx`

`applyCloudPairSessionToken()` now resolves `localStorage` first, falls back to
`sessionStorage`, and migrates a legacy session token into durable storage when
possible. The Cloud-hosted auth notice now includes a tappable "Re-open from
Eliza Cloud" CTA. The CTA is environment-aware for staging dedicated-agent
hosts and uses the agent-specific detail URL when the subdomain identifies the
agent. It does not auto-navigate.

## Tests

Focused tests added or updated for:

- React relay durable token persistence.
- Server-generated HTML relay writes to both storage channels.
- App boot source guard for durable-first read, legacy fallback, and migration.
- Cloud-hosted notice CTA and staging/agent-aware URL resolution.

Local verification in this worktree:

- `bun test packages/app/test/cloud-pair-session-token.test.ts` passed.
- A direct source guard confirmed the UI relay, both HTML relays, and app boot
  resolver all contain the durable storage behavior.
- `git diff --check` passed.
- Package Vitest runners could not complete because dependencies are not
  installed in this worktree (`vitest`, React JSX runtime, and core transitive
  packages such as `handlebars`/`fs-extra`/`mammoth` are missing). The app
  package's `test` script also runs the broader `scripts` suite first, which is
  blocked here by missing optional deps and sandboxed loopback binds before the
  focused Vitest file runs.

## Staging Verification Status

Live staging PWA verification has not been run from this worktree. The intended
manual staging proof is: pair a staging dedicated agent, confirm
`localStorage["eliza:cloud-pair:api-token"]` equals the paired agent token,
terminate the iOS standalone PWA, relaunch it, and confirm authenticated API
requests continue without opening a new pairing link.
