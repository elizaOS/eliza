# Desktop App Live Routes - 2026-07-18

## Scope

Focused child issue #16644 under App Live umbrella #16212. This lane covers only the packaged Electrobun launcher and Settings/Voice route drivers.

## Reproduction

App Live run [29636010630](https://github.com/elizaOS/eliza/actions/runs/29636010630), desktop packaged job `88058361276`, reproduced both signatures:

- `desktop-launcher-smoke.e2e.spec.ts`: `HomeLauncherSurface` remained absent for 30 seconds after the test attempted `/apps`.
- `electrobun-packaged-regressions.e2e.spec.ts`: `/settings#voice` reported `rootHtmlLength: 835`, empty `bodyText`, and no `[data-testid="settings-shell"]`, despite normal renderer API traffic.

The downloaded `app-live-e2e-desktop` failure contexts were inspected from the real packaged lane. No browser fixture replaced packaged execution.

## Root Cause

These were stale packaged route drivers, not missing product selectors.

1. `/apps` is intentionally the **My Apps** route. The launcher grid moved to canonical `/views`; this contract is documented in `navigation/index.ts` and guarded in `app-navigate-view.test.ts`. The packaged launcher smoke still asserted that `/apps` mounted `HomeLauncherSurface`.
2. The smoke changed routes with raw `window.history.pushState`. Since #15247/#15307, the active surface-realm guard intentionally denies path-changing raw History writes from an ungranted surface. The launcher helper swallowed that denial and returned success, leaving the old route mounted.
3. The packaged regression route script repeatedly re-dispatched Settings navigation on every poll and used raw History for general routes. Repeatedly pushing `/settings` stripped and restored `#voice` during the lazy route mount, so the poll sampled the transitional shell (`rootHtmlLength` about 835) rather than a settled Settings mount.

The existing selectors are current: `SettingsView.tsx` still owns `[data-testid="settings-shell"]`, and `HomeLauncherSurface.tsx` still owns `[data-testid="home-launcher-surface"]`.

## Fix

- Drive the launcher smoke to canonical `/views` through the public `eliza:navigate:view` shell event.
- Fail explicitly if the launcher navigation eval fails instead of swallowing the route error.
- Drive all packaged regression routes through the shell's public navigation events, which use the privileged shell navigation channel internally.
- Make Settings/Voice navigation idempotent so polling observes a settled route instead of re-triggering the transition each cycle.

No auth, voice runtime, voice latency, production route, selector, baseline, or check-suppression code changed.

## Verification

- `bunx @biomejs/biome check packages/app/test/electrobun-packaged/desktop-launcher-smoke.e2e.spec.ts packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts --no-errors-on-unmatched` passed.
- `git diff --check` passed.
- A local full Electrobun package build was attempted with `node packages/app-core/scripts/desktop-build.mjs build`. It reached runtime plugin bundling, then the shared `/mnt` volume exhausted space (`ENOSPC`) while generating `plugin-openai` declarations, before a launcher was produced. No baseline or test was changed to bypass that environmental failure.
- Exact packaged specs remain the required post-build verification and are unchanged as real packaged tests:
  - `desktop-launcher-smoke.e2e.spec.ts`
  - `electrobun-packaged-regressions.e2e.spec.ts`

## Evidence Rows

- Before screenshots: App Live artifact `app-live-e2e-desktop` from run 29636010630 contains the failing packaged contexts; launcher fails before its screenshot checkpoint and Settings reports an empty rendered body.
- After screenshots: pending the PR's packaged Electrobun CI artifact because local `/mnt` build failed with `ENOSPC` before packaging.
- Walkthrough video: N/A, route-driver-only correction with exact packaged screenshot tests as the acceptance surface.
- Backend logs: run 29636010630 shows normal packaged API bootstrap/config/status traffic, proving the renderer reached the real packaged API path.
- Frontend logs: failure diagnostics recorded `/settings`, `#voice`, `rootHtmlLength: 835`, empty body text, and absent settings shell.
- LLM trajectory: N/A, no model, prompt, provider, or agent behavior changed.
- Domain artifacts: this receipt plus the linked App Live run and its `app-live-e2e-desktop` artifact.

[sol-orch]
