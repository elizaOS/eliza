# `@elizaos/app-core`

Shared React state, first-run setup, API client, and shell helpers used by all Eliza app shells (desktop, mobile, web).

## What's in here

| Subdir                              | Contains                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `src/api/`                          | API client, auth bootstrap, first-run routes, pairing routes.                  |
| `src/first-run/`                    | First-run config and runtime-target resolution shared across shells.           |
| `src/platform/`                     | Per-platform bootstrap (Capacitor for mobile, browser for web).                |
| `src/components/`                   | Shared React components used by app shells.                                    |
| `src/config/branding.ts`            | `DEFAULT_APP_DISPLAY_NAME`, branding interpolation vars for `{{appName}}` in locale JSON. White-label shells override `BrandingContext`; copy must not hardcode "Eliza." |
| `src/runtime/`                      | Runtime entry points exported to consumers.                                    |

## Desktop-only behavior

Native menus and IPC are not in this package; the Electrobun app forwards certain actions (e.g. **Reset Eliza…**) to the renderer so `handleReset` stays the single source of truth.

## End-user docs

The end-user first-run flow is documented at `packages/docs/guides/first-run-flow.md`. The agent-app track in the docs site covers shipping app shells: [`/tracks/agent-app/overview`](../docs/tracks/agent-app/overview.mdx).
