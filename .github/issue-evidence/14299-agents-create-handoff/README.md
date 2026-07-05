Issue: #14299
PR: pending at capture time

Scope reviewed:
- `packages/ui/src/cloud-ui/components/data-list/dashboard-data-list.tsx`
- `packages/ui/src/cloud-ui/components/data-list/dashboard-data-list.test.tsx`
- `packages/ui/src/cloud/instances/components/eliza-agents-table.tsx` from merged PR #14253

Change:
- Fixed `DashboardDataListDesktop` so desktop list/table surfaces hide only below `md`.
- The prior `hidden md:block` class combination was masked in the built app by a later `.hidden { display: none }` rule, which left the populated Agents desktop table invisible while the toolbar remained visible.

Rendered proof:
- `desktop-empty.png` — `/dashboard/agents`, zero agents, visible `Open Eliza app`.
- `desktop-populated.png` — `/dashboard/agents`, one agent, visible table row and toolbar `Open Eliza app`.
- `mobile-empty.png` — `/dashboard/agents`, zero agents, visible `Open Eliza app`.
- `mobile-populated.png` — `/dashboard/agents`, one agent card and visible toolbar `Open Eliza app`.
- Matching `*-console.log` and `*-network.log` files are included for each capture.

Verification:
- `bun run --cwd packages/ui test src/cloud-ui/components/data-list/dashboard-data-list.test.tsx` — passed, 2 tests.
- `bunx @biomejs/biome@2.5.1 check packages/ui/src/cloud-ui/components/data-list/dashboard-data-list.tsx packages/ui/src/cloud-ui/components/data-list/dashboard-data-list.test.tsx` — passed.
- Focused Playwright rendered evidence run against the real app shell/cloud route with deterministic cloud API responses — passed, 4 tests.
- `bun run --cwd packages/app audit:app` — ran full audit; 368 passed, 1 failed on unrelated existing minimalism budget threshold: `builtin-phone @ mobile-portrait` whitespace ratio `0.30 < 0.30`. No broken pages were reported.
- `bun run --cwd packages/app audit:cloud` — dashboard Agents desktop/mobile passed; all 68 page screenshots passed with `broken=0 needs-work=0 needs-eyeball=68`. Command failed only on pre-existing coverage-table drift: registered routes `dashboard`, `dashboard/billing`, `dashboard/api-keys`, `dashboard/account`, `dashboard/security`, `dashboard/security/permissions`, `dashboard/monetization`, `dashboard/connectors` are missing from the cloud audit table.

Manual review:
- Opened and inspected all four focused screenshots. Empty and populated states are visually distinct on desktop and mobile, and the populated desktop table row is visible after the shared data-list fix.
