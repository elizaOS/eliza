# Issue #14385 - Home widget sweep evidence

Draft PR: https://github.com/elizaOS/eliza/pull/14428

## What changed

- Removed resident home declarations for non-MVP/autonomous cards:
  `agent-orchestrator.activity`, `agent-orchestrator.apps`,
  `feed.agent-activity`, `workflow.running`, `finances.alerts`,
  `relationships.attention`, and `inbox.unread`.
- Changed default home widget sinks into non-rendering participation records.
- Updated widget registry tests, launch-host tests, smoke helpers, stories, and
  docs for sparse home.
- Deleted dead home-card components/tests/stories for the removed resident cards.

## Checks run after rebase onto origin/develop

```bash
bun run --cwd packages/ui test -- src/widgets/WidgetHost.home-launch.test.tsx src/widgets/default-home-widget-sink-optins.test.ts src/widgets/home-priority-integration.test.ts src/widgets/registry.defaultWidget.test.ts src/widgets/registry.home.test.ts src/widgets/widget-coverage.test.ts
# 6 files passed, 34 tests passed
```

```bash
bunx @biomejs/biome check packages/app/test/ui-smoke/home-widget-priority.spec.ts packages/app/test/ui-smoke/onboarding-to-home.shared.ts packages/ui/src/components/shell/__e2e__/run-home-screen-e2e.mjs packages/ui/src/widgets/__fixtures__/home-widget-mock-data.ts packages/ui/src/widgets/WidgetHost.home-launch.test.tsx packages/ui/src/widgets/default-home-widget-sink-optins.test.ts packages/ui/src/widgets/default-home-widget-sink-optins.ts packages/ui/src/widgets/home-priority-integration.test.ts packages/ui/src/widgets/registry.defaultWidget.test.ts packages/ui/src/widgets/registry.home.test.ts packages/ui/src/widgets/registry.ts packages/ui/src/widgets/widget-coverage.test.ts
# Checked 11 files. No fixes applied.
```

```bash
git diff --check
# no whitespace errors
```

```bash
rg -n "from \"\\./(agent-activity|automations|finances-alerts|inbox-unread|relationships-attention)\"|from './(agent-activity|automations|finances-alerts|inbox-unread|relationships-attention)'|FINANCES_HOME_WIDGET|INBOX_HOME_WIDGET|RELATIONSHIPS_HOME_WIDGET|AgentActivityWidget|AutomationsWidget" packages/ui/src packages/app/test -g '!packages/ui/src/components/shell/__e2e__/output-home/**' -S
# no matches
```

## Blocked visual/browser evidence

`bun run --cwd packages/ui test:home-screen-e2e` currently fails before the
browser fixture bundles because this worktree has no local install for
`@tailwindcss/postcss`:

```text
error: ENOENT while resolving package '@tailwindcss/postcss' from
packages/ui/src/testing/e2e-runner/fixture-bundle.ts
```

`bun run --cwd packages/app audit:app` also cannot be completed in this local
state. Earlier in this worktree it failed before screenshots while building
workspace packages because the partial install could not resolve Node type
definitions. A frozen install cannot repair the worktree without lockfile churn,
and the disk has been near full during this lane.

## Evidence matrix

- Real LLM trajectory: N/A - home UI registry/component cleanup only.
- Backend logs: N/A - no backend path changed.
- Frontend screenshots/video: pending - blocked before browser bundle/audit by
  local install/disk state described above.
- Domain artifacts: N/A - no DB/memory/files produced by this change.
