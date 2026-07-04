# Issue #13602 — Mobile 390px Analytics + Connectors Overflow

## Fix

- Hardened the shared cloud `ConnectionCard` shell so connector cards cannot
  push the dashboard pane wider than the viewport:
  - card root now uses `min-w-0 overflow-hidden`;
  - header stacks on narrow screens and only becomes row layout at `sm`;
  - connector names and descriptions wrap instead of forcing horizontal scroll;
  - status badges are isolated in a non-growing wrapper.
- Hardened `/dashboard/analytics` narrow layouts:
  - page/header/filter containers now propagate `min-w-0`;
  - range/granularity chips wrap long text;
  - the model breakdown table scrolls inside its card with an explicit inner
    minimum width, instead of widening the whole page.

## Verification

Commands run in a clean `fix/13602-mobile-overflow` worktree:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/ui test src/cloud-ui/components/connection-card.layout.test.tsx
bunx biome check packages/ui/src/cloud-ui/components/connection-card.tsx packages/ui/src/cloud-ui/components/connection-card.layout.test.tsx packages/ui/src/cloud/analytics/_components/analytics-page-client.tsx packages/ui/src/cloud/analytics/_components/filters.tsx packages/ui/src/cloud/analytics/_components/model-breakdown.tsx
```

Results:

- Vitest: 1 file passed, 1 test passed.
- Biome: 5 files checked, no fixes required.

## Evidence Matrix

- Unit/component regression: attached in
  `packages/ui/src/cloud-ui/components/connection-card.layout.test.tsx`.
- Browser screenshot/video: pending full app audit capture on the PR branch.
- Backend logs: N/A — CSS/layout-only UI containment change.
- Real LLM trajectory: N/A — no agent/action/model/prompt behavior changed.
