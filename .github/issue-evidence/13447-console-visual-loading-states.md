# #13447 console visual/loading-state evidence

Date: 2026-07-04

## Scope retained after syncing with develop

This PR was reduced to the still-unmerged #13447 UI-state fixes. Already-merged
or superseded work was intentionally dropped:

- Billing selected-state and disabled button styling: covered by #13437.
- Apps/Create App white-on-white CTA styling: covered by #13546.
- Console title/sidebar changes: covered by #13552.
- Account DTO and wallet callback type cleanup: covered by #13450.

## Changes verified in this branch

- `/dashboard/apps` renders stat-card skeletons while the session/app query is
  loading, instead of success-shaped zero stats.
- `/dashboard/apps` suppresses success stats when the apps query fails and shows
  the existing dashboard error state.
- `/dashboard/agents` renders the table skeleton before the pricing banner, so
  loading does not look like an empty/no-agent state.
- `/dashboard/agents` renders an explicit error state when the agents query
  fails, instead of collapsing to an empty table.

## Local checks

```bash
bunx @biomejs/biome check packages/ui/src/cloud/instances/AgentsPage.tsx packages/ui/src/cloud/instances/AgentsPage.test.tsx packages/ui/src/cloud/applications/ApplicationsPage.tsx packages/ui/src/cloud/applications/ApplicationsPage.test.tsx
```

Result: passed.

```bash
git diff --check
```

Result: passed.

## Focused tests

Added component regression tests:

- `packages/ui/src/cloud/instances/AgentsPage.test.tsx`
- `packages/ui/src/cloud/applications/ApplicationsPage.test.tsx`

Attempted command:

```bash
bun run --cwd packages/ui test -- src/cloud/instances/AgentsPage.test.tsx src/cloud/applications/ApplicationsPage.test.tsx
```

Result: blocked before test execution in the sparse checkout because the local
workspace install does not expose `react/package.json`. A fresh `bun install`
was not run because this machine was at the disk limit during the cleanup wave.

## Visual audit

Not rerun in this sparse checkout for the same disk/install reason. Required
before final merge if CI does not provide equivalent coverage:

```bash
bun run --cwd packages/app audit:app
bun run --cwd packages/app audit:cloud
```
