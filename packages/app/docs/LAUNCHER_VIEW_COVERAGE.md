# Launcher view coverage inventory (#10719)

Checked-in inventory of every **default-launcher view** — the tiles the `/views`
launcher grid renders — and its automated + manual test-coverage status. This
doc is the human-readable companion to the enforced gate
[`packages/app/test/launcher-view-coverage.test.ts`](../test/launcher-view-coverage.test.ts).

**The gate is what keeps this honest.** Adding a new launcher view to
`BUILTIN_VIEWS` ([`packages/agent/src/api/builtin-views.ts`](../../agent/src/api/builtin-views.ts))
without a coverage entry **fails CI**. This doc is a table a reviewer can read;
the gate is the assertion a CI run enforces. Keep them in sync — the gate's
`covers a stable, non-empty set of launcher views` test pins the exact roster
below, so a drift in either surface is caught.

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
excluded from this inventory and the gate.

## Two evidence lanes

| Lane | Produced by | Enforced by the gate? |
| --- | --- | --- |
| **Automated smoke** | `builtin-views-visual.spec.ts` (desktop + mobile boot-smoke: view mounts, renders content, no uncaught page error) | ✅ Yes — every launcher view's path must be in the smoke matrix, and its spec/runner files must exist. |
| **Dedicated e2e** | The `run-*-e2e.mjs` runners (real view → esbuild → headless Chromium, real interactions, video) | ✅ Existence of the referenced runner file is asserted; running it is a CI lane, not this vitest gate. |
| **Manual / on-device capture** | `bun run --cwd packages/app audit:app` (live full-page audit), `capture:ios-sim` / `capture:android-emu` / `capture:linux-desktop` / `capture:windows-desktop`, video walkthroughs | ❌ No — needs a booted renderer / device; tracked here, produced in the PR-evidence lane per [`AGENTS.md`](../../../AGENTS.md). |

The vitest gate is deliberately **boot-free** (file reads + set diffs), like its
sibling [`route-coverage.test.ts`](../test/route-coverage.test.ts), so it runs on
every PR in the cheap `test:client` lane instead of behind a ~12-min cold-renderer
Playwright boot.

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

### Coverage gaps

**None.** Every default-launcher view has automated smoke coverage (cross-checked
by the gate: each view's `path` is asserted present in
`builtin-views-visual.spec.ts`'s `BUILTIN_VIEW_CASES`). `chat` and `background`
additionally have dedicated interaction e2e runners, and the chat-native
tutorial is interaction-covered by `test/ui-smoke/tutorial-chat.spec.ts` (the
tour is transcript turns, not a view of its own). The remaining views are
`smoke-only`: boot-smoke is their automated floor, and the manual/CI capture lane
(`audit:app` + on-device captures) supplies the full-page-screenshot / video /
device evidence per `AGENTS.md`.

If a launcher view is ever added with **no** smoke case, the gate's "every
launcher view's smoke spec actually covers its declared path" assertion fails —
so a real gap can never land silently.

## How to add coverage for a new launcher view

When you add a view to `BUILTIN_VIEWS` that is a default-launcher view (the gate
tells you if it is), do all three:

1. Add a `{ id, path }` case for the view's route to `BUILTIN_VIEW_CASES` in
   [`packages/app/test/ui-smoke/builtin-views-visual.spec.ts`](../test/ui-smoke/builtin-views-visual.spec.ts).
   (Add a dedicated `run-*-e2e.mjs` runner too if the view has real interactions
   worth driving.)
2. Add a `LAUNCHER_VIEW_COVERAGE` entry in
   [`packages/app/test/launcher-view-coverage.test.ts`](../test/launcher-view-coverage.test.ts)
   and update the pinned roster in its "stable set" test.
3. Add a row to the inventory table above.

Then capture the manual-lane evidence (`audit:app`, on-device where relevant) for
the PR per `AGENTS.md`.
