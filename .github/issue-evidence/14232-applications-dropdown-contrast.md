# Evidence for #14232 — Applications token contrast follow-up (rendered proof + dropdown tokens)

Branch: `fix/14232-applications-contrast-evidence` (off `origin/develop`).
Reviewed 2026-07-05.

This lane closes the two gaps #14232 called out: (1) the missing rendered app
audit proof that #14219 / #14236 could not produce, and (2) the remaining
hard-dark dropdown tokens — which turned out to hide a **new** regression that
#14236's `bg-neutral-800 -> bg-popover` retokenization introduced.

## 1. Unblocked the app/cloud aesthetic audit (the evidence gate)

`bun run --cwd packages/app audit:app` / `audit:cloud` had been failing "before
screenshot capture" on three PRs in a row:

- `plugins/plugin-phone`: unresolved `@elizaos/capacitor-phone`
- `plugins/plugin-messages`: unresolved `@elizaos/capacitor-messages`
- `plugins/plugin-task-coordinator`: unresolved `@xterm/addon-fit`

Root cause: these are a **missing dependency install** on a fresh checkout, not a
code problem. `@elizaos/capacitor-phone` / `@elizaos/capacitor-messages` are
workspace packages (`plugin-native-phone` / `plugin-native-messages`) and
`@xterm/addon-fit` is a normal npm dep; all resolve after `bun install`. After a
clean install the shared view prebuild (`packages/scripts/build-views.mjs`)
builds all plugin view bundles green, including the three that were failing.

A second, later blocker also had to be cleared for the cloud audit to reach
Playwright: the renderer `build:web` failed resolving
`@elizaos/import-conversations/browser` (and other workspace `/browser` exports)
because those workspace dists were not built. Building the app's upstream
dependency graph (`turbo run build --filter=@elizaos/app^...`, 113 packages
green) materializes every dist the renderer imports.

With both unblocked, `audit:cloud` ran end-to-end and produced the
`aesthetic-audit-output-cloud/` artifact set the issue asked for.

### audit:cloud result

```
68 passed, 1 skipped, 1 failed (7.3m)
```

The single failure is **pre-existing on develop and unrelated to this change**
(this branch has zero source edits to the cloud route table): the
`coverage matches the registered cloud routes` guard trips because 8 cloud
routes were registered since the audit table was last synced
(`dashboard/billing`, `dashboard/api-keys`, `dashboard/account`,
`dashboard/security`, `dashboard/security/permissions`,
`dashboard/monetization`, `dashboard/connectors`, `dashboard`). All 39 route
cases × desktop/mobile — including the touched `dashboard-apps`,
`dashboard-apps-detail` (renders app-analytics + app-earnings), and
`dashboard-mcps` — captured and passed.

Rest screenshots for the touched surfaces are attached under
`cloud-audit-apps-mcps/` (desktop + mobile). These render on the always-dark
`theme-cloud` cloud-console surface by design (see
`NativeAppsStudio.tsx` StudioSurface).

## 2. Found + fixed a real regression in #14236's retokenization

The issue asked to fix or justify the remaining hard-dark dropdown tokens.
#14236 already replaced `bg-neutral-800` with `bg-popover` in the Applications
select/tooltip popovers. But **`--popover` is undefined across the entire UI
token set** — grep the built renderer CSS: there is no `--popover:` rule in any
theme (`.theme-cloud`, root light/dark, brand-gold, …). `bg-popover` therefore
resolves to `background-color: var(--popover)` == transparent `rgba(0,0,0,0)`.

Verified at runtime: the opened analytics `SelectContent` (`role=listbox`)
computed `background-color` was `rgba(0, 0, 0, 0)` — a transparent popover, which
on the dark cloud console is worse than the original opaque dark surface (menu
items float over whatever is behind them).

Fix (scoped to the flagged Applications surfaces only): retokenize the four
`bg-popover` popovers to `bg-card`, which **is** defined in every theme
(`.theme-cloud` `--card = brand-black`) and already backs the matching
`SelectTrigger` plus most sibling working cloud dropdowns (EarningsPageClient,
create-eliza-agent-dialog, eliza-agents-table, …):

- `packages/ui/src/cloud/applications/components/app-analytics.tsx` (range Select)
- `packages/ui/src/cloud/applications/components/app-earnings-dashboard.tsx` (range Select)
- `packages/ui/src/cloud/applications/components/app-monetization-settings.tsx` (2 tooltip popovers)

No remaining `bg-neutral-800/900/950` or `bg-popover` in
`packages/ui/src/cloud/applications` or `packages/ui/src/cloud/mcps`.

> Scope note / follow-up: the dead `bg-popover` token is also used in
> `packages/ui/src/cloud/organization/*` and `api-keys/ApiKeysView.tsx` (9 more
> occurrences, several inside the settings token-guard scan set). Those are out
> of #14232's Applications scope, so they are left for a follow-up rather than
> expanded here (and are the reason `bg-popover` was not added to the settings
> token guard — that would flag the unfixed organization/api-keys surfaces).

## 3. Rendered proof: the touched dropdowns, OPEN, both app themes

The broad audit never opens the popovers, so a dedicated Playwright project
(`--project=audit-app-dropdown`,
`test/ui-smoke/applications-dropdown-contrast.spec.ts`) drives the exact fixed
surfaces: it deep-links the app-detail `?tab=analytics` / `?tab=earnings`,
opens the range Select, and captures rest + open in both `eliza:ui-theme-mode`
values. It reuses the cloud audit's auth + stub fixtures (extracted to
`test/ui-smoke/helpers/cloud-audit-fixtures.ts`) so the app-detail page reaches
its real tab instead of the session-not-ready spinner.

```
4 passed (audit-app-dropdown)
  - app-analytics-range-select (light)  ✓
  - app-earnings-range-select (light)   ✓
  - app-analytics-range-select (dark)   ✓
  - app-earnings-range-select (dark)    ✓
```

The spec asserts the opened popover is **opaque** (alpha > 0.9 — catches the
transparent `bg-popover` regression) and that its background **contrasts its own
menu-item text** (readable in whichever root theme the portalled popover
inherits).

Objective pixel readout of the opened-popover surface (top-right quadrant):

| shot | popover surface | verdict |
| --- | --- | --- |
| dark / analytics --open | `rgb(20,12,7)` (`#140c07`, opaque) | dark surface, white items — readable |
| dark / earnings --open | `rgb(20,12,7)` (opaque) | readable |
| light / analytics --open | `rgb(253,250,247)` (opaque) | light surface, dark items — readable |
| light / earnings --open | `rgb(253,250,247)` (opaque) | readable |

No shot shows `rgba(0,0,0,0)`: the transparent regression is gone in every
state. Screenshots under `light/` and `dark/` (`--rest` and `--open`).

Note on "light vs dark": the Applications page bodies are always the dark
`theme-cloud` console, but the Radix SelectContent **portals to document.body**
and so inherits the root app theme. That is why the popover is dark in app-dark
mode and light in app-light mode — both opaque and readable, which is the real
correctness invariant here (not a fixed color).

## Verification commands + results

```
# touched-component tests (vitest)
packages/ui $ vitest run --config ./vitest.config.ts \
  src/cloud/applications/components/app-analytics.test.tsx \
  src/cloud/applications/components/app-monetization-settings.test.tsx
=> Test Files 2 passed (2) ; Tests 6 passed (6)

# settings token regression guard
packages/ui $ bun test src/cloud/settings/cloud-settings-theme-tokens.test.ts
=> 2 pass, 0 fail

# client build
$ bun run build:client   (turbo build --filter=@elizaos/app)
=> Tasks: 104 successful, 104 total (5m13s)

# rendered dropdown proof
packages/app $ VITE_PLAYWRIGHT_TEST_AUTH=true node scripts/run-ui-playwright.mjs \
  --config playwright.ui-smoke.config.ts --project=audit-app-dropdown
=> 4 passed

# no residual dead/hard-dark tokens in the flagged surfaces
$ rg -n "bg-neutral-800|bg-neutral-900|bg-neutral-950|bg-popover" \
    packages/ui/src/cloud/applications packages/ui/src/cloud/mcps -g"*.tsx"
=> (no matches)
```
