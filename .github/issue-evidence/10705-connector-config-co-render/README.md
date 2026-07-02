# #10705 — connector config co-renders with a companion setup panel

Rendered before/after proof for the `plugin-view-connectors.tsx` predicate fix
(PR #10705): when a connector mode delegates its setup panel to a **different**
plugin id (`setupPanelPluginId !== plugin.id`), the plugin's own config form
must stay mounted next to the panel instead of being dropped.

## How these pixels were produced (and why not a full-app audit)

`ConnectorPluginGroups` currently has **no live mount in the shipped app**: it
renders only under `PluginsView mode="social"`, and the only live consumer is
`PluginsPageView` with `mode="all-social"`. The in-app Settings → Connectors
surface is a separate component (`components/settings/ConnectorsSection.tsx`)
that co-renders its panel independently of this file. A full
`audit:app` walk or a dev-server screenshot of Settings → Connectors would
therefore capture a *different* component and prove nothing about this change
— identical pixels before and after. Faking that would be worse than useless.

Instead the captures come from the repo's established real-browser fixture
harness (same pattern as `run-launcher-e2e.mjs` / `run-home-screen-e2e.mjs`):

```
bun run --cwd packages/ui test:connectors-e2e -- --with-baseline
```

(`packages/ui/src/components/pages/__e2e__/run-connectors-e2e.mjs`, committed
with the PR.) It esbuild-bundles `connectors-fixture.tsx`, which mounts the
**real** `ConnectorPluginGroups` → `ConnectorPluginCard` →
`PluginConfigForm`/`ConfigRenderer` → `ConnectorSetupPanel` →
`ConnectorAccountList` chain with the real Tailwind v4 theme
(`styles/base.css` + `styles/tailwind-theme.css`) and the real English
translator, in headless Chromium via Playwright. Only two seams are stubbed:
the `state` barrel (a plain selector-backed store object) and the `api` barrel
(`client.listConnectorAccounts` serves one canned connected Signal account).
The `before-*` captures bundle the **pre-fix component straight from
`origin/develop`** (via `git show`); `after-*` captures the PR tree. The
runner *asserts* the DOM either way — config field `#field-signal-…` present
in `after`, absent in `before`, delegated panel present in both — and exits
non-zero on mismatch, so the screenshots cannot silently drift from the claim.

The scenario: the **Signal** connector's default mode is `plugin-managed`,
whose setup panel is delegated to
`connector-account-management:signal:signal` — a different plugin id than the
card's own `signal`. This is the exact regression case, reachable with zero
interaction.

## Files

| File | Shows |
| --- | --- |
| `before-desktop.png` / `before-mobile.png` | `origin/develop` code: the Signal card renders **only** the delegated "Signal accounts" setup panel — the Phone Number / Device Name config form is dropped (`setupPanelPluginId === plugin.id` clause fails). |
| `after-desktop.png` / `after-mobile.png` | PR code: the config form (required Phone Number field, configured Device Name field) **and** the delegated Signal-accounts panel (connected "Owner device" account card) co-render, followed by Test connection / Save settings. |

## Companion tests (committed with the PR)

- `plugin-view-connectors.render.test.tsx` — jsdom render tests asserting the
  co-render for signal (default delegated mode) and discord→local (interaction
  driven), plus the negative controls (managed Discord, slack cloud-OAuth
  still hide the form). 3 of the 4 tests fail against the develop predicate.
- `plugin-view-connectors.test.ts` — predicate matrix extended with the
  no-params row and the both-exclusions row.
- `run-connectors-e2e.mjs` — the real-browser assertion + capture harness
  described above (`bun run --cwd packages/ui test:connectors-e2e`).
