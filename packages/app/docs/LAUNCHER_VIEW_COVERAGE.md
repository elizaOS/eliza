# Launcher view test map (#10719)

This human-maintained map records the automated and manual tests for the
default-launcher views rendered by `/views`. It is not a merge gate or a pinned
view inventory.

## What "default-launcher view" means

A `BUILTIN_VIEWS` entry appears in the launcher grid when the launcher filter
(`mergeViewCatalog` in [`packages/ui/src/hooks/view-catalog.ts`](../../ui/src/hooks/view-catalog.ts),
plus the native-OS strip in [`useAvailableViews`](../../ui/src/hooks/useAvailableViews.ts))
would ever place it there:

- `visibleInManager !== false`, and
- the id is not a native-OS-fork-only surface (`phone`, `messages`, `contacts`,
  or `camera`).

Developer and preview views render when their matching Settings toggle is on,
so they remain represented here. `camera` is intentionally excluded because it
exists only on the AOSP elizaOS fork.

## Evidence lanes

| Lane | Produced by | Validation |
| --- | --- | --- |
| Automated smoke | `builtin-views-visual.spec.ts` on desktop and mobile | Behavioral failures fail the browser test. |
| Dedicated e2e | The `run-*-e2e.mjs` runners | Behavioral failures fail the runner. |
| Manual / on-device capture | `audit:app`, simulator/device captures, and walkthrough videos | Produced with PR evidence per [`AGENTS.md`](../../../AGENTS.md). |

## Current map

| View id | Path | Kind | Smoke | Dedicated e2e | Manual capture lane |
| --- | --- | --- | --- | --- | --- |
| `chat` | `/chat` | system | ✅ | `packages/ui/src/components/shell/__e2e__/run-chat-sheet-e2e.mjs` | `audit:app` + video + on-device |
| `character` | `/character` | system | ✅ | smoke-only | `audit:app` |
| `documents` | `/character/documents` | system | ✅ | smoke-only | `audit:app` |
| `automations` | `/automations` | system | ✅ | smoke-only | `audit:app` |
| `plugins-page` | `/apps/plugins` | system | ✅ | smoke-only | `audit:app` |
| `trajectories` | `/apps/trajectories` | developer | ✅ | smoke-only | `audit:app` |
| `memories` | `/apps/memories` | system | ✅ | smoke-only | `audit:app` |
| `database` | `/apps/database` | developer | ✅ | smoke-only | `audit:app` |
| `logs` | `/apps/logs` | developer | ✅ | smoke-only | `audit:app` |
| `settings` | `/settings` | system | ✅ | smoke-only | `audit:app` + video |
| `background` | `/background` | preview | ✅ | `packages/ui/src/components/pages/__e2e__/run-background-e2e.mjs` | `audit:app` + video |

At the time of this map every listed view has a smoke case in
`builtin-views-visual.spec.ts`. The browser spec itself—not a second source-map
test—is the authority for whether that behavior works.

When adding a launcher view, add its route to `BUILTIN_VIEW_CASES`, add a
dedicated interaction runner when the view has meaningful controls, update this
map, and capture the relevant manual evidence.
