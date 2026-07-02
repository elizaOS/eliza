# 10725 — Cloud-surface visual audit (#11342)

Hand-reviewed visual audit of every cloud route registered by
`packages/ui/src/cloud/register-all.ts` (the app-hosted Eliza Cloud
surfaces), at desktop (1440×900) and mobile (390×844), against the #10725
brand rules: orange accent only, NO blue anywhere, orange-resting →
darker-orange hover (never orange→black/white), no layout breaks, no
empty/broken panes.

Produced by the `audit:cloud` harness added for #11342 (the `audit:app`
equivalent for the CloudRouterShell route space, which `audit:app` never
enters):

```bash
bun run --cwd packages/app audit:cloud
```

The walk writes `packages/app/aesthetic-audit-output-cloud/` (gitignored);
the reviewed screenshots + hand-filled `manual-review/<slug>.md` verdicts are
committed here. `report.json` carries the machine findings (blue-color scan,
orange-hover scan, console errors, paint/quality analysis) per page ×
viewport; `contact-sheet.html` is the grid index.

Harness notes:

- The renderer is built with `VITE_PLAYWRIGHT_TEST_AUTH=true` (the
  `audit:cloud` script sets it), so `StewardAuthProvider` renders the local
  test-auth shell and authed pages authenticate from a seeded persisted
  Steward token — the same pattern as `cloud-console-routes.spec.ts`.
- Cloud APIs are stubbed with shape-accurate fixtures (traced from each
  domain's data hooks; see the rule table in
  `packages/app/test/ui-smoke/cloud-surfaces-aesthetic-audit.spec.ts`) so
  pages render real zero/populated states. Unstubbed calls fall through to
  the deterministic 501 stub backend and the page's designed failure state is
  audited instead.
- Account-management surfaces (account, security, billing overview,
  connections, monetization, earnings, affiliates) are no longer standalone
  `CloudRouterShell` routes after #11657; their canonical home is the in-app
  Settings surface, with legacy `/dashboard/*` compat redirects. This evidence
  bundle now tracks the 34 routes still registered by `registerAllCloudSurfaces()`.

## Verdict summary

34 registered routes x 2 viewports, rebased final walk 69/69 green:

- **machine scan:** 68 findings; `broken=0`, `needs-work=0`, blue-color
  violations `0`, orange-hover violations `0`.
- **hand review:** 34/34 current route screenshots are marked `good` in
  `manual-review/` after opening the refreshed contact sheet generated from
  the July 2, 2026 rebased audit output.

Fixed in this PR (verified by the run-3 machine scan + screenshots):

- `dashboard/settings/connections` carried the original audit's only blue
  (Discord `#5865F2`, Telegram `#0088cc`) on icons/chips/links/buttons; it now
  uses neutral + accent tokens. That route is a Settings section after #11657,
  not part of the current cloud-route screenshot matrix.
- `dashboard/analytics` no longer hangs on a context-only auth gate; it uses
  the shared persisted-token gate (`cloud/lib/auth-query`).
- `payment/app-charge/:appId/:chargeId` crash (RangeError: Invalid time
  value) exposed by a minimal stub - stub now carries the full app-charge
  shape.
