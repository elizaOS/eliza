# #13601 account/security 404 contract evidence

## What changed

- Added authenticated Cloud API route contracts for:
  - `GET /api/v1/me/mfa`
  - `GET /api/v1/sessions`
  - `DELETE /api/v1/sessions/:id`
- The read routes return `200` with `available: false` and a reason code while
  MFA enrollment and revocable session inventory are not backed by real services.
- The delete route returns `501` with `session_revocation_unavailable` instead
  of falling through to route 404.
- The account-security panels now render the explicit unavailable DTO and reject
  malformed DTOs instead of turning missing fields into healthy empty/disabled
  states.

## Verified

```bash
bun run --cwd packages/cloud/api codegen
```

Result: router generated with 640 mounted routes and 0 unconverted leaves.

```bash
bun test packages/cloud/api/__tests__/account-security-unavailable-routes.test.ts
```

Result: 3 tests passed.

```bash
bun run --cwd packages/ui test src/cloud/account-security/components/account-security-panels.test.tsx
```

Result: 4 tests passed.

```bash
bunx @biomejs/biome check packages/cloud/api/v1/me/mfa/route.ts packages/cloud/api/v1/sessions/route.ts 'packages/cloud/api/v1/sessions/[id]/route.ts' packages/cloud/api/__tests__/account-security-unavailable-routes.test.ts packages/ui/src/cloud/account-security/components/mfa-panel.tsx packages/ui/src/cloud/account-security/components/active-sessions-panel.tsx packages/ui/src/cloud/account-security/components/account-security-panels.test.tsx --no-errors-on-unmatched
```

Result: clean.

```bash
git diff --check
```

Result: clean.

## Wider checks

`bun run --cwd packages/ui typecheck` and `bun run --cwd packages/cloud/api build`
were attempted after `bun install`. Both failed before reaching this change due
to missing/generated workspace artifacts and unrelated package references:
`@elizaos/cloud-routing`, `./generated/validation-keyword-data`, and
`@elizaos/auth/*` imports from `packages/app-core`.

## N/A

- Screenshots/video: N/A. This change removes load-time network 404s through API
  route contracts and pins the React unavailable render with component tests; no
  visual redesign was made.
- Real-LLM trajectories: N/A. No model, prompt, action, provider, or planner
  behavior changed.
