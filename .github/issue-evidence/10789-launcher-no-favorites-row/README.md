# Issue #10789 — Launcher No Favorites Row

Manual review: good.

What changed:
- The app launcher renders no `launcher-dock` / top favorites row.
- Favorited ids remain normal page-grid tiles; edit affordances stay inline on each tile.
- The real `/views` app path keeps a uniform launcher grid and does not create a favorites row during a long press.

Artifacts:
- `app-launcher-desktop-grid.png` — full app `/views` launcher grid, no top favorites row.
- `app-launcher-no-row-hold.webm` + `app-launcher-no-row-hold-trace.zip` — Playwright recording/trace for the app-path assertion that a long press does not create `launcher-dock` or `launcher-fav-*`.
- `standalone-desktop-rest.png` / `standalone-mobile-rest.png` — standalone launcher desktop and mobile rest states.
- `standalone-desktop-edit.png` / `standalone-mobile-edit.png` — edit states showing per-tile favorite buttons with no separate row.
- `standalone-launcher-walkthrough.webm` — standalone launcher walkthrough covering launch, edit toggle, paging, and swipe.

Verification run:
- `bun run --cwd packages/ui test src/state/launcher-layout.test.ts src/state/launcher-layout.property.test.ts src/components/pages/Launcher.test.tsx src/components/pages/Launcher.gestures.test.tsx` — 54 passed.
- `E2E_RECORD=1 bun run --cwd packages/app test:e2e -- test/ui-smoke/launcher-interaction.spec.ts` — 4 passed.
- `bun run --cwd packages/ui test:launcher-e2e` — passed; produced desktop/mobile screenshots and walkthrough video.
- `bun run --cwd packages/app audit:app` — 349 passed; report summary `broken=0`, `needs-work=236`, `good=112`, strict mode false.

N/A:
- Real LLM trajectories: not applicable; this is launcher UI/layout behavior.
- Backend logs: not applicable; no backend code path changed.
