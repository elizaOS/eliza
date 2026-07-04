# #13447 console visual loading-state evidence

Date: 2026-07-04

## Changes verified

- `/dashboard/apps` renders loading stat skeletons before app data resolves, so the page no longer shows success-shaped zero stats or a blank light rectangle during load/error transitions.
- `/dashboard/agents` no longer renders the pricing/empty banner while the agents table query is still loading, and renders a real error state when the query fails.
- Billing disabled buy-credit states use explicit dark styling instead of inherited blank/gray button states; invoice fetch failures render an error row rather than silently looking empty.
- Account UI consumes the shared linked-account DTO exported by `@elizaos/shared`, and `useWalletState` has an explicit `WalletEntry` callback annotation so the console typecheck remains clean.

## Commands

```bash
bunx @biomejs/biome check --write packages/ui/src/api/client-agent.ts packages/ui/src/hooks/useAccounts.ts packages/ui/src/components/accounts/AddAccountDialog.tsx packages/ui/src/state/useWalletState.ts packages/ui/src/cloud/applications/ApplicationsPage.tsx packages/ui/src/cloud/instances/AgentsPage.tsx packages/ui/src/cloud/billing/components/billing-tab.tsx
```

Result: passed.

```bash
bun run --cwd packages/contracts build
bun run --cwd packages/cloud/routing build
bun run --cwd packages/shared build:i18n
bun run --cwd packages/ui typecheck
```

Result: passed. This first reproduced the linked-account and wallet type errors in a fresh worktree; after the fix, `packages/ui` typecheck exits cleanly.

```bash
bun run --cwd packages/app audit:app
```

Result: passed, `373 passed (13.5m)`. Summary: `broken=0`, `needs-work=0`, `needs-eyeball=25`, `good=347`, `minimalism-budget-failures=0`.

```bash
bun run --cwd packages/app audit:cloud
```

Result: passed, `69 passed (3.2m)`. Summary: `broken=0`, `needs-work=0`, `needs-eyeball=68`.

## Manual review targets

Generated cloud-audit artifacts were written under `packages/app/aesthetic-audit-output-cloud/`.

- `desktop/dashboard-agents.png`, `mobile/dashboard-agents.png`, plus hover captures: no console errors, no blue-color hits, no hover violations, no screenshot quality issues.
- `desktop/dashboard-apps.png`, `mobile/dashboard-apps.png`, plus hover captures: no console errors, no blue-color hits, no hover violations, no screenshot quality issues.
- `desktop/dashboard-billing-success.png`, `mobile/dashboard-billing-success.png`: no console errors, no blue-color hits, no hover violations, no screenshot quality issues.
- `desktop/dashboard-invoice-detail.png`, `mobile/dashboard-invoice-detail.png`, plus hover captures: no console errors, no blue-color hits, no hover violations, no screenshot quality issues.

The full cloud report is `packages/app/aesthetic-audit-output-cloud/report.json`; the contact sheet is `packages/app/aesthetic-audit-output-cloud/contact-sheet.html`.
