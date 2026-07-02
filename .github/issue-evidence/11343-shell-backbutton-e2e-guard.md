# Issue #11343 - ShellBackButton e2e guard restoration

Date: 2026-07-02
Branch: `codex/shell-backbutton-guard`

## What changed

- Restored the `/inbox` and `/relationships` first-chip hit-test guard in
  `packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts`.
- The guard checks `document.elementFromPoint` at the target chip center before
  clicking, so a ShellBackButton occlusion regression fails before interaction.
- Moved the relationships graph width assertion to the real
  `/apps/relationships` graph route.
- Kept the graph route viewport-contained by adding `min-w-0` to the shared
  relationships layout container/panel.

## Verification

```bash
bunx @biomejs/biome check \
  packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts \
  packages/ui/src/components/pages/relationships/RelationshipsWorkspaceView.tsx
```

Result: passed.

```bash
bun run --cwd packages/ui typecheck
```

Result: passed after the smoke/audit build prep generated the expected
workspace artifacts.

```bash
ELIZA_UI_SMOKE_DISABLE_VIDEO=1 bun run --cwd packages/app test:e2e \
  test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts \
  --project=chromium --project=mobile-chromium \
  -g "inbox decomposed view|relationships decomposed view|relationships graph"
```

Result: 6 passed.

```bash
bun run --cwd packages/app audit:app
```

Result: 349 passed. Summary: broken=0, needs-work=0,
minimalism-budget-failures=0, minimalism-ratchet-failures=0. Existing
non-blocking hover probe timeouts were limited to plugin-finances mobile
landscape and are unrelated to this branch.

Manual review completed for the touched/reachable surfaces:

- `plugin-inbox-*`: verdict set to `good`.
- `plugin-relationships-*`: verdict set to `good`.
- `builtin-relationships-*`: verdict set to `good`.

Reviewed screenshots show the first inbox/relationships chips are below and
clear of ShellBackButton, and the relationships graph route remains contained
within the viewport.

```bash
bun run verify
```

Result: failed before this branch's change paths in the existing
`audit:type-safety-ratchet` baseline:

- `as unknown as`: 80 current > 77 baseline
- ``?? {}`` in core/agent/app-core: 379 current > 377 baseline

## Visual artifacts

- `.github/issue-evidence/11343-plugin-inbox-mobile-portrait.png`
- `.github/issue-evidence/11343-plugin-inbox-desktop-landscape.png`
- `.github/issue-evidence/11343-plugin-relationships-mobile-portrait.png`
- `.github/issue-evidence/11343-plugin-relationships-desktop-landscape.png`
- `.github/issue-evidence/11343-builtin-relationships-mobile-portrait.png`
- `.github/issue-evidence/11343-builtin-relationships-desktop-landscape.png`

## N/A

- Real-LLM trajectories: N/A - no model, prompt, provider, action, or evaluator
  path changed.
- Backend logs/domain artifacts: N/A - UI smoke test and viewport containment
  change only; no backend state mutation.
- Video walkthrough: N/A - focused regression guard restoration; the Playwright
  run and committed audit screenshots cover the exercised UI path.
- Before screenshots: N/A - this restores a clobbered e2e guard from #11258 and
  keeps the current relationships graph layout contained; the issue body and
  test history document the prior workaround state.
