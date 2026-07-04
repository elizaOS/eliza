# Issue 11916 — UI Design-System Consolidation Evidence

## Scope

Consolidated launcher/chat/settings/browser/wallet/app controls onto shared
`packages/ui` primitives, added `Button` `unstyled` support for custom chrome,
and fixed mobile-landscape continuous-chat clearance for browser and wallet
surfaces.

## Screenshots

Final `bun run --cwd packages/app audit:app` captures copied from
`packages/app/aesthetic-audit-output/`:

- `11916-ui-design-system-consolidation/browser-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/inventory-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/plugin-wallet-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/plugin-birdclaw-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/settings-desktop-after.png`
- `11916-ui-design-system-consolidation/chat-mobile-portrait-after.png`
- `11916-ui-design-system-consolidation/plugin-task-coordinator-desktop-after.png`
- `11916-ui-design-system-consolidation/plugin-training-desktop-after.png`
- `11916-ui-design-system-consolidation/plugin-training-mobile-after.png`
- `11916-ui-design-system-consolidation/plugin-model-tester-desktop-after.png`
- `11916-ui-design-system-consolidation/plugin-calendar-desktop-after.png`

Before screenshots: N/A - this change is a broad primitive consolidation and
the earlier failing audit captures were superseded by the final audit run.

Video walkthrough: N/A - no data-entry workflow, backend transaction, model
trajectory, or connector flow changed; verification is via full app screenshot
matrix and focused package tests.

## Verification

All commands were run from
`/Users/shawwalters/eliza-workspace/milady/eliza-ui-design-system-pr`.

- `bun run --cwd packages/core typecheck` — passed.
- `bun run --cwd packages/ui typecheck` — passed.
- `bun run --cwd packages/ui test -- src/genui/genui.test.tsx src/cloud-ui/__tests__/cloud-ui-stories-smoke.test.tsx` — passed, 380 tests.
- `bun run --cwd plugins/plugin-birdclaw typecheck` — passed.
- `bun run --cwd plugins/plugin-birdclaw test` — passed, 69 tests.
- `bun run --cwd plugins/plugin-wallet-ui typecheck` — passed.
- `bun run --cwd plugins/plugin-wallet-ui test` — passed, 39 tests.
- `bun run --cwd packages/app audit:app` — passed, 357 tests; summary:
  `broken=0 needs-work=0 needs-eyeball=25 good=331 minimalism-budget-failures=0 minimalism-ratchet-failures=0 hover-probe-failures=0 density-probe-failures=0`.
- `bun run verify` — passed; turbo typecheck/lint reported 485 successful tasks
  and `typecheck:dist` checked 28 dist-path consumer configs.

## Follow-up Verification — 2026-07-03

Expanded the conversion pass to app-visible React controls in additional
first-party plugin views: app control, calendar, contacts, facewear,
hyperliquid, model tester, native settings, personal assistant app blocker,
phone companion, polymarket, screenshare, shopify, task coordinator,
training/fine-tuning, trajectory logger, vector browser, and Wi-Fi.

Commands run from
`/Users/shawwalters/eliza-workspace/milady/eliza-ui-design-system-pr`:

- `bunx @biomejs/biome@2.5.1 check --write $(git diff --name-only)` —
  passed on the 32 edited source files after fixes.
- `git diff --check` — passed.
- `bun run --cwd plugins/plugin-task-coordinator typecheck` — passed.
- `bun run --cwd plugins/plugin-training typecheck` — passed.
- `bun run --cwd plugins/app-model-tester typecheck` — passed.
- `bun run --cwd plugins/plugin-personal-assistant typecheck` — passed.
- `bun run --cwd plugins/plugin-calendar typecheck` — passed.
- `bun run --cwd plugins/plugin-phone typecheck` — passed.
- `bun run --cwd plugins/plugin-wifi typecheck` — passed.
- `bun run --cwd plugins/plugin-native-settings typecheck` — passed.
- `bun run --cwd plugins/plugin-facewear typecheck` — passed.
- `bun run --cwd plugins/plugin-hyperliquid typecheck` — passed.
- `bun run --cwd plugins/plugin-polymarket typecheck` — passed.
- `bun run --cwd plugins/plugin-shopify typecheck` — passed.
- `bun run --cwd plugins/plugin-screenshare typecheck` — passed.
- `bun run --cwd plugins/plugin-contacts typecheck` — passed.
- `bun run --cwd plugins/plugin-trajectory-logger typecheck` — passed.
- `bun run --cwd plugins/plugin-app-control typecheck` — passed.
- `bun run --cwd plugins/plugin-vector-browser typecheck` — passed.
- `bun run verify` — passed; turbo typecheck/lint reported 485 successful
  tasks and `typecheck:dist` checked 28 dist-path consumer configs.
- `bun run --cwd packages/app audit:app` — passed, 357 tests; summary:
  `356 findings — broken=0 needs-work=0 needs-eyeball=25 good=331 minimalism-budget-failures=0 minimalism-ratchet-failures=0 hover-probe-failures=0 density-probe-failures=0`.

Manual screenshot review:

- Opened generated audit screenshots for task coordinator desktop, training
  desktop/mobile, model tester desktop, smartglasses mobile, and calendar
  desktop. No clipping, overlap, broken native file inputs, or chat-overlay
  clearance regressions were observed.
- Generated manual-review records for touched views report `verdict: good`,
  `console errors: 0`, and no blue-color, border-radius, orange-hover,
  hover-probe, density-probe, or screenshot-quality failures.

## Static Scans

- `packages/ui/src` raw-control scan found only doc-comment examples.
- `plugins/plugin-wallet-ui/src` raw-control scan found no production
  `button/input/select/textarea` matches.
- Follow-up production React scan over `packages/ui/src packages/app/src plugins`
  found no remaining app-visible React TSX raw controls from the expanded
  conversion set. Remaining matches were triaged as design-system primitive
  internals, doc comments, benchmark/static HTML fixtures, standalone route
  templates, generated/export HTML bundles, script evidence HTML, and
  `packages/app/src/model-tester-entry.tsx` / `plugins/app-model-tester/src/routes.ts`
  static model-tester shells.
- `git diff --cached --check` — passed.

## Follow-up Verification — 2026-07-03 post-rebase

Rebased the branch onto `origin/develop`
(`a747ced4097 fix(ui): restore macOS swipe-back overscroll behavior`) and
reviewed related open UI/design-system PRs. PR #11816 is still draft, so no
related branch was merged into this PR.

Additional consolidation in this pass:

- `AppearanceSettingsSection` accent tiles now use shared `Button` instead of a
  raw native `button`.
- Chat analysis-mode action and callback panels now use semantic/accent tokens
  instead of hard-coded purple/blue utilities.
- Custom action `code` badges now use the accent token instead of hard-coded
  purple utilities.
- Task-coordinator GitHub token link now uses `text-accent` instead of
  hard-coded blue.

Commands run from
`/Users/shawwalters/eliza-workspace/milady/eliza-ui-design-system-pr`:

- `git fetch origin && git rebase origin/develop` — passed.
- `bun install` — passed.
- `bunx @biomejs/biome@2.5.1 check --write
  packages/ui/src/components/settings/AppearanceSettingsSection.tsx
  packages/ui/src/components/chat/MessageContent.tsx
  packages/ui/src/components/custom-actions/CustomActionsPanel.tsx
  plugins/plugin-task-coordinator/src/GitHubConnectionCard.tsx` — passed.
- `bun run --cwd packages/ui typecheck` — passed.
- `bun run --cwd plugins/plugin-task-coordinator typecheck` — passed.
- `git diff --check` — passed.
- `bun run verify` — passed; turbo typecheck/lint reported 485 successful
  tasks and `typecheck:dist` checked 28 dist-path consumer configs.
- `bun run --cwd packages/app audit:app` — passed, 357 tests; summary:
  `356 findings — broken=0 needs-work=0 needs-eyeball=25 good=331 minimalism-budget-failures=0 minimalism-ratchet-failures=0 hover-probe-failures=0 density-probe-failures=0`.

Static scans after the post-rebase fixes:

- Production React raw-control scan over `packages/app/src`,
  `packages/ui/src/components`, and plugin `*.tsx` found no remaining
  app-visible raw controls outside design-system primitive internals and the
  documented standalone no-build model-tester shell.
- `rg -n "\b(blue|purple|indigo|violet)-[0-9]" packages/ui/src/components` —
  no matches.
- `rg -n "\b(blue|purple|indigo|violet)-[0-9]" packages/app/src` —
  no matches.
- `rg -n "\b(blue|purple|indigo|violet)-[0-9]" plugins -g '*.tsx' ...` —
  no matches.

Manual screenshot review:

- Opened current audit screenshots for desktop settings, desktop chat, mobile
  chat, desktop task coordinator, and mobile task coordinator. No clipping,
  overlap, off-token blue/purple accents, or composer-clearance regressions were
  observed.
- Generated manual-review records for chat, settings, task coordinator, and
  orchestrator report `verdict: good`, `console errors: 0`, no banned blue
  colors, and no hover-probe, density-probe, or screenshot-quality failures.
- Custom actions did not receive a dedicated audit screenshot in this suite; it
  is covered by static token scan, lint, typecheck, full verify, and shared UI
  app audit.

## N/A Evidence

- Real LLM trajectories: N/A - no prompt, provider, model, action, evaluator, or
  runtime agent behavior changed.
- Backend logs: N/A - no server route or backend side effect changed.
- Domain artifacts: N/A - no memory, database, scheduler, wallet transaction,
  generated file workflow, or chain state changed.
