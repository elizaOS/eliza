# Phase 2 Validation Deep Dive: App E2E Game Launch

Date: 2026-05-11
Worker: phase-2 deep-dive worker 3
Scope: `packages/app#test:e2e` failures in `packages/app/test/ui-smoke/game-apps.spec.ts`

## Summary

The reproducible blocker is that the game app smoke spec opens `/apps/defense-of-the-agents` and `/apps/clawville`, then waits for a visible launch button inside `data-testid="app-launch-panel"`. That launch panel is owned by the app details route/view, not the catalog grid.

The safest first fix is test-side determinism: stub `/api/catalog/apps` in `game-apps.spec.ts` alongside the existing `/api/apps` stub, or navigate directly to `/apps/<slug>/details` if the test is intended to validate the details launch panel rather than the deep-link redirect behavior. A product-side hardening fix is to unify app catalog merge precedence so static catalog and installed/server app descriptors cannot disagree between `AppsView` and `AppDetailsView`.

No source, config, or test files were edited during this investigation.

## Commands And Artifacts Checked

Targeted read-only inspection covered:

- `packages/app/test/ui-smoke/game-apps.spec.ts`
- `packages/app/test/ui-smoke/helpers.ts`
- `packages/app/playwright.ui-smoke.config.ts`
- `packages/app/scripts/run-ui-playwright.mjs`
- `packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs`
- `packages/ui/src/components/pages/AppsView.tsx`
- `packages/ui/src/components/pages/AppDetailsView.tsx`
- `packages/ui/src/components/pages/AppsPageView.tsx`
- `packages/ui/src/components/apps/load-apps-catalog.ts`
- `packages/ui/src/components/apps/useRegistryCatalog.ts`
- `packages/ui/src/components/apps/AppsCatalogGrid.tsx`
- `packages/ui/src/components/apps/GameView.tsx`
- `packages/ui/src/navigation/index.ts`
- app package descriptors and registry entries for Defense of the Agents and ClawVille
- available Playwright/test-result artifacts under `packages/app/test-results`, `packages/*/test-results`, and nearby reports

I did not run full root e2e. Existing artifacts did not contain retained `game-apps.spec.ts` failure screenshots or traces. `packages/app/test-results/.last-run.json` reported earlier passing state, so it was not useful for the current blocker.

## Relevant Test Behavior

`packages/app/test/ui-smoke/game-apps.spec.ts` installs per-test route stubs for:

- `**/api/apps`
- `**/api/apps/launch`
- `**/api/apps/runs`
- `**/api/apps/runs/*`
- `**/api/apps/runs/*/message`
- `**/api/apps/runs/*/heartbeat`
- the game viewer path

It does not stub `**/api/catalog/apps`.

The failing assertion waits for:

```ts
page
  .getByTestId("app-launch-panel")
  .getByRole("button", { name: "Launch" })
```

That selector belongs to `AppDetailsView`, not the catalog card grid. If the app remains on the browse/catalog surface, or if `/apps/<slug>` auto-launches without first routing to `/apps/<slug>/details`, the selector will never become visible.

## Route And Catalog Findings

`AppsView` handles `/apps/<slug>` deep links by loading app descriptors and auto-processing the matching app. For apps that need a details page, `handleLaunch(app)` sets `appsDetailsSlug` and pushes `/apps/<slug>/details`; otherwise it launches directly.

The details decision uses `appNeedsDetailsPage(app)`. Current source treats an app as details-backed when:

- it is an internal tool with `hasDetailsPage`
- it has `uiExtension.detailPanelId`
- it has `session`
- its normalized category is `game`

Defense of the Agents and ClawVille should therefore qualify as details-backed if the descriptor seen by `AppsView` has `category: "game"` or includes session/detail-panel metadata.

However, the app descriptor merge paths disagree:

- `loadAppsCatalog()` used by `AppsView` builds internal apps + catalog apps + overlays + server apps, then keeps the first descriptor for each `name`. This gives static catalog entries precedence over the `/api/apps` test fixture for duplicate names.
- `useRegistryCatalog()` used by `AppDetailsView` builds catalog apps + server apps, then keeps the later descriptor for each `name`. This gives the `/api/apps` test fixture precedence.

That mismatch means `/apps/<slug>` can make its routing/launch decision from one descriptor shape while the details page resolves from another. In the current test, `/api/apps` is tightly controlled but `/api/catalog/apps` is not, so a static catalog descriptor shape drift can change whether the app reaches the launch panel.

## Registry And Plugin Findings

The plugin source descriptors are game apps:

- `plugins/app-defense-of-the-agents/src/index.ts`
- `plugins/app-clawville/src/index.ts`

ClawVille declares a `uiExtension` in source. Defense of the Agents has `uiExtension.detailPanelId` in its `package.json` app metadata.

The app-core registry entries exist:

- `packages/app-core/src/registry/entries/apps/defense-of-the-agents.json`
- `packages/app-core/src/registry/entries/apps/clawville.json`

Both registry entries use `subtype: "game"` and `launch.type: "server-launch"`. The JSON registry descriptors do not currently carry the richer runtime `session` shape, and the catalog route mapper only forwards selected launch fields such as `viewer` and `uiExtension`. Category should still map to `"game"`, which should be enough for current source, but the thinner static descriptor increases the impact of the merge-precedence mismatch.

## Dist / Build Artifact Note

The ui-smoke web server serves `packages/app/dist`. During investigation the dist tree changed while another worker process was active in the workspace. Earlier reads appeared to show the served app bundle did not contain `app-launch-panel`; after the concurrent rebuild, the bundle did contain `app-launch-panel` and `game-view-iframe`.

Because the workspace is shared and dist changed during the read-only investigation, this should be treated as a secondary hypothesis rather than proven root cause. Still, a stale renderer bundle can explain a failure where source contains the launch panel but Playwright cannot find it.

## Root Cause Hypotheses

1. Highest confidence: the test stubs `/api/apps` but leaves `/api/catalog/apps` unstubbed, while `AppsView` uses catalog descriptors before server descriptors. The deep link can therefore be driven by a descriptor that the test did not control.

2. High confidence hardening issue: `loadAppsCatalog()` and `useRegistryCatalog()` use opposite duplicate precedence. This can make `/apps/<slug>` and `/apps/<slug>/details` reason about different app shapes for the same `name`.

3. Medium confidence: a stale `packages/app/dist` bundle may have been served during the failing run. This is plausible because ui-smoke serves built dist and the dist tree changed during investigation, but no retained failure artifact proved it.

4. Low confidence for this blocker: the Vincent AI QA failure appears separate. The AI QA capture path writes screenshots and JSON reports under `reports/ai-qa/<run-id>` and disables trace/video. That supports the existing suspicion that the Vincent failure was intermittent artifact or disk related, not the same selector/routing failure.

## Safest Fix Shapes

Recommended narrow test fix:

- In `game-apps.spec.ts`, make `installGameRoutes()` also stub `**/api/catalog/apps` for the active fixture. Return the same `makeApp(fixture)` descriptor, or return an empty catalog and ensure the app loader path remains deterministic.
- This keeps the existing `/apps/<slug>` coverage while removing dependence on the live/static catalog stub.

Alternative narrow test fix:

- Navigate directly to `/apps/${fixture.slug}/details` for the launch-panel test.
- This is appropriate if the test's intent is only to validate the app details launch flow.
- If deep-link behavior matters, add a separate smaller assertion that `/apps/<slug>` transitions to the details route or renders the details panel.

Recommended product hardening:

- Share one app descriptor merge helper between `loadAppsCatalog()` and `useRegistryCatalog()`.
- Prefer installed/server `/api/apps` descriptors over static catalog descriptors for the same app `name`, because installed descriptors are the runtime source for launch/session/viewer capability.
- Preserve static catalog entries only when there is no installed/server descriptor.

Possible registry hardening:

- Include session/detail-panel launch metadata in app registry entries and ensure `catalog-routes.ts` forwards all fields required by the UI launch decision.
- This is broader than the immediate failure and should follow the merge-precedence fix.

Operational hardening:

- Make the ui-smoke startup path force a renderer rebuild when the consumed UI package/dist artifacts are newer than `packages/app/dist`, or provide a clean-build mode for CI e2e.
- This would reduce stale-dist false failures but does not replace the deterministic route stubbing fix.

## Current Blocker

`packages/app#test:e2e` can fail before launching Defense of the Agents or ClawVille because the test waits for a details-page launch button after opening `/apps/<slug>`, but the route/data path that decides whether to show that details page is not fully controlled by the test. The immediate blocker is therefore selector absence caused by app catalog/deep-link nondeterminism, with stale served dist as a secondary risk to rule out in CI.
