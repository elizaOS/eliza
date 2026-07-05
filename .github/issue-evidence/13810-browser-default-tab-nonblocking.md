# #13810 browser default-tab startup non-blocking follow-up

## Scope

Follow-up to merged PR #13825 / issue #13810. The default browser search-tab
seed was annotated, but desktop bridge mode still awaited the optional seed from
`BrowserService.start()`. Since desktop bridge requests use the workspace HTTP
request timeout, that could delay service startup and agent browser actions.

This patch keeps web-mode seeding awaited for crisp local failures, but starts
desktop bridge seeding in the background and logs failures through the existing
best-effort startup warning path.

## Verification

Run from `/Users/shawwalters/milaidy/eliza-pr13825-fix` on rebased head
`9551de9751`.

- `bun install --frozen-lockfile --ignore-scripts` - pass
- `bun run --cwd packages/cloud/routing build` - pass
- `bun run --cwd packages/shared build:i18n` - pass
- `bun run --cwd plugins/plugin-browser test -- src/workspace/__tests__/browser-workspace-default-tab.test.ts --coverage.enabled=false` - 9/9 pass
- `bunx biome check plugins/plugin-browser/src/browser-service.ts plugins/plugin-browser/src/workspace/browser-workspace.ts plugins/plugin-browser/src/workspace/__tests__/browser-workspace-default-tab.test.ts` - pass
- `git diff --check` - pass

## Evidence N/A

- Screenshots/video: N/A - plugin-browser service startup behavior only; no UI
  rendering changed.
- Live LLM trajectory: N/A - no prompt/model/action behavior changed.
- DB/domain artifacts: N/A - no persistence or schema change.

