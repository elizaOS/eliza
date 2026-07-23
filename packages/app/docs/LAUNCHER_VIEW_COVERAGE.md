# Launcher view test map (#10719)

This human-maintained map records the automated and manual tests for the
default-launcher views rendered by `/views`. It is not a merge gate or a pinned
view inventory.

## What "default-launcher view" means

A `BUILTIN_VIEWS` entry appears in the launcher grid when the launcher filter
(`mergeViewCatalog` in [`packages/ui/src/hooks/view-catalog.ts`](../../ui/src/hooks/view-catalog.ts),
plus the native-OS strip in [`useAvailableViews`](../../ui/src/hooks/useAvailableViews.ts))
would ever place it there:

- `visibleInManager !== false` (internal views are hidden from the grid), **and**
- the id is **not** a native-OS-fork-only surface (`phone` / `messages` /
  `contacts` / `camera` are stripped on web, desktop, iOS, and stock Play-Store
  Android — they only exist on the AOSP ElizaOS fork).

`viewKind` / `developerOnly` do **not** exclude a view from the launcher:
`developer`- and `preview`-kind views render in the grid when the matching
Settings toggle is on (`isViewVisible` gates them per-toggle). They still need
coverage, so they are in the table below.

`camera` (`viewKind: preview`, `platforms: ["android"]`, native-OS) is the one
`BUILTIN_VIEWS` entry that is **not** a default-launcher view; it is intentionally
excluded from this map.

## Two evidence lanes

| Lane | Produced by | Validation |
| --- | --- | --- |
| **Automated smoke** | `builtin-views-visual.spec.ts` (desktop + mobile boot-smoke: view mounts, renders content, no uncaught page error) | Behavioral failures fail the browser test. |
| **Dedicated e2e** | The `run-*-e2e.mjs` runners (real view → esbuild → headless Chromium, real interactions, video) | Behavioral failures fail the runner. |
| **Manual / on-device capture** | `bun run --cwd packages/app audit:app` (live full-page audit), `capture:ios-sim` / `capture:android-emu` / `capture:linux-desktop` / `capture:windows-desktop`, video walkthroughs | Produced in the PR-evidence lane per [`AGENTS.md`](../../../AGENTS.md). |

## Inventory

Every default-launcher view id from `BUILTIN_VIEWS`, its route, its kind, and its
coverage. "Smoke" = covered by the desktop+mobile boot-smoke in
`builtin-views-visual.spec.ts`. "Dedicated e2e" = a `run-*-e2e.mjs` runner that
drives the real view. "Manual capture lane" = the on-device / audit-screenshot /
video evidence that only the manual/CI lane produces.

| View id | Path | Kind | Smoke | Dedicated e2e | Manual capture lane |
| --- | --- | --- | --- | --- | --- |
| `tutorial` | `/tutorial` | system | ✅ smoke | `test/ui-smoke/tutorial-chat.spec.ts` (chat-native tour) | `audit:app` + video |
| `chat` | `/chat` | system | ✅ smoke | `packages/ui/src/components/shell/__e2e__/run-chat-sheet-e2e.mjs` | `audit:app` + video + on-device |
| `character` | `/character` | system | ✅ smoke | smoke-only | `audit:app` |
| `documents` | `/character/documents` | system | ✅ smoke | smoke-only | `audit:app` |
| `automations` | `/automations` | system | ✅ smoke | smoke-only | `audit:app` |
| `plugins-page` | `/apps/plugins` | system | ✅ smoke | smoke-only | `audit:app` |
| `trajectories` | `/apps/trajectories` | developer | ✅ smoke | smoke-only | `audit:app` (developer toggle on) |
| `transcripts` | `/apps/transcripts` | system | ✅ smoke | smoke-only | `audit:app` + audio |
| `memories` | `/apps/memories` | system | ✅ smoke | smoke-only | `audit:app` |
| `database` | `/apps/database` | developer | ✅ smoke | smoke-only | `audit:app` (developer toggle on) |
| `logs` | `/apps/logs` | developer | ✅ smoke | smoke-only | `audit:app` (developer toggle on) |
| `settings` | `/settings` | system | ✅ smoke | smoke-only | `audit:app` + video |
| `background` | `/background` | preview | ✅ smoke | `packages/ui/src/components/pages/__e2e__/run-background-e2e.mjs` | `audit:app` + video (preview toggle on) |

### Test gaps

At the time of this map, every listed default-launcher view has an automated
smoke case in `builtin-views-visual.spec.ts`. `chat` and `background`
also have dedicated interaction e2e runners, and the chat-native
tutorial is interaction-covered by `test/ui-smoke/tutorial-chat.spec.ts` (the
tour is transcript turns, not a view of its own). The remaining views are
`smoke-only`: boot-smoke is their automated test, and the manual/CI capture lane
(`audit:app` + on-device captures) supplies the full-page-screenshot / video /
device evidence per `AGENTS.md`.

## How to add coverage for a new launcher view

When you add a default-launcher view to `BUILTIN_VIEWS`:

1. Add a `{ id, path }` case for the view's route to `BUILTIN_VIEW_CASES` in
   [`packages/app/test/ui-smoke/builtin-views-visual.spec.ts`](../test/ui-smoke/builtin-views-visual.spec.ts).
   (Add a dedicated `run-*-e2e.mjs` runner too if the view has real interactions
   worth driving.)
2. Add a row to the map above.

Then capture the manual-lane evidence (`audit:app`, on-device where relevant) for
the PR per `AGENTS.md`.
