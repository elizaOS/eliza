# Issue 10692 - GitHub Device-Connect Backend Slice

Date: 2026-07-01

## Scope Proven

This evidence covers the backend/API slice added in this branch:

- `POST /api/v1/eliza/agents/[agentId]/github/device-code`
- Reuses the existing GitHub OAuth callback and managed-agent binding path:
  `/api/v1/eliza/github-oauth-complete`
- Returns a QR/tap-through payload and poll contract for the originating agent:
  `authorizeUrl`, `verificationUri`, `verificationUriComplete`, `qr`,
  `qrPayload`, `expiresIn: 600`, `interval: 2`, and
  `pollUrl: /api/v1/eliza/agents/{agentId}/github`
- Regenerated the Cloud API Hono router and Cloud SDK public route map.

The full issue is not closed by this slice. Dashboard/onboarding QR UI,
live two-device capture, live GitHub OAuth/API evidence, and the separate
agent-owned GitHub App/bot identity path still belong to #10692.

## Manual Review

- Reviewed #10692 and confirmed it asks for a device-code/QR connect flow for a
  fresh cloud agent.
- Inspected the existing managed GitHub flow:
  `github/oauth` initiates OAuth with `connectionRole: "agent"`,
  `github-oauth-complete` binds the encrypted OAuth connection to
  `__agentManagedGithub`, and `GET /github` is already the org-scoped poll
  endpoint.
- Inspected the existing CLI session routes and confirmed public initiate/poll
  endpoints already exist:
  `POST /api/auth/cli-session` and `GET /api/auth/cli-session/[sessionId]`.
- Checked the OAuth provider implementation and confirmed the existing OAuth
  state TTL is 600 seconds, which is why the device-connect response returns
  `expiresIn: 600`.
- Reviewed the response contract in the focused route test. It proves the QR
  payload is the short-lived GitHub authorize URL, not a bearer token, and that
  polling stays on the existing org-scoped managed GitHub status route.

## Focused Test Evidence

Command:

```bash
bun test 'packages/cloud/api/v1/eliza/agents/[agentId]/github/device-code/route.test.ts'
```

Result: PASS

- 5 tests passed.
- Covers happy path response contract, provider default scopes, GitHub OAuth
  not configured, agent not found outside the caller organization, and invalid
  body rejection before OAuth state is created.

## Generation Evidence

Commands:

```bash
bun run --cwd packages/cloud/api codegen
node packages/cloud/sdk/scripts/generate-public-routes.mjs
```

Results:

- PASS: Cloud API router generated with 592 mounted routes.
- PASS: Cloud SDK public routes generated with 470 endpoints.
- Confirmed `device-code` appears in both generated outputs.

## Validation Evidence

Commands:

```bash
bun install --frozen-lockfile --ignore-scripts
node packages/shared/scripts/generate-keywords.mjs --target ts
bunx @biomejs/biome check 'packages/cloud/api/v1/eliza/agents/[agentId]/github/connect-flow.ts' 'packages/cloud/api/v1/eliza/agents/[agentId]/github/oauth/route.ts' 'packages/cloud/api/v1/eliza/agents/[agentId]/github/device-code/route.ts' 'packages/cloud/api/v1/eliza/agents/[agentId]/github/device-code/route.test.ts' packages/cloud/api/src/_router.generated.ts packages/cloud/sdk/src/public-routes.ts
bun run --cwd packages/cloud/api lint
bun run --cwd packages/cloud/api build
bun run --cwd packages/cloud/sdk lint
bun run --cwd packages/cloud/sdk test
bun run --cwd packages/cloud/sdk typecheck
git diff --check
```

Results:

- PASS: install completed in the clean worktree.
- PASS: generated local keyword artifacts needed by TypeScript.
- PASS: touched-file Biome check.
- PASS: `packages/cloud/api` lint.
- PASS: `packages/cloud/api` build (`tsc --noEmit`).
- PASS: `packages/cloud/sdk` lint.
- PASS: `packages/cloud/sdk` test: 56 passed, 19 live e2e tests skipped by
  default.
- PASS: `packages/cloud/sdk` typecheck (`tsgo --noEmit`).
- PASS: `git diff --check`.

## Broader Gate Notes

Command:

```bash
bun run --cwd packages/cloud/api test
```

Result: FAIL outside this slice.

- The runner reported 28 of 53 files failed.
- Most failures start before route logic with:
  `Cannot find module '@elizaos/core' from 'plugins/plugin-sql/src/index.ts'`.
- One additional pre-existing failure was
  `__tests__/stripe-event-waifu.test.ts`, where the expected webhook fetch was
  not called because the endpoint hostname could not be resolved.

Command:

```bash
bun run verify
```

Result: FAIL outside this slice.

- The repo-wide gate stops at `audit:type-safety-ratchet`.
- Failure: `as unknown as: 108 current > 77 baseline`.
- Top reported offenders are in unrelated packages such as `packages/feed`,
  `packages/agent`, `packages/app-core`, `packages/cloud/services`, and
  `plugins/plugin-capacitor-bridge`.

## Screenshots, Video, Logs, Domain Artifacts

- Screenshots/video: N/A for this branch because it adds a backend/API endpoint
  and generated SDK route only. The issue-level two-device QR UI walkthrough is
  still required when the dashboard/onboarding surface is implemented.
- Frontend logs: N/A for this backend/API slice.
- Backend logs: N/A for live cloud stack because no GitHub OAuth credentials or
  live cloud instance were available in this worktree. The focused route test
  verifies the exact request/response contract without calling a live provider.
- DB/domain artifacts: No migration or DB row shape changed. The existing
  OAuth callback still owns the encrypted connection row and managed-agent
  config binding.
- Real LLM trajectory: N/A; no model behavior changed.
