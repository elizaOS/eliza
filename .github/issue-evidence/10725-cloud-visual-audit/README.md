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
  `audit:cloud` script sets it), so normal Steward-gated pages authenticate
  from a seeded persisted Steward token — the same pattern as
  `cloud-console-routes.spec.ts`. `/app-auth/authorize` uses a local
  Playwright test-auth adapter so the audit can render its signed-in consent
  state without the live Steward SDK provider.
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

34 registered routes x 2 viewports, July 3, 2026 final walk 69/69 green:

- **machine scan:** 68 findings; `broken=0`, `needs-work=0`, blue-color
  violations `0`, orange-hover violations `0`.
- **hand review:** 34/34 current route screenshots are marked `good` in
  `manual-review/` after opening the refreshed desktop/mobile screenshots and
  spot-checking the previously failing/low-contrast routes.

Fixed in this pass (verified by the final machine scan + screenshots):

- Authenticated CloudRouterShell routes now mount inside the `theme-cloud`
  token scope, so dashboard route bodies no longer inherit the app shell's
  light theme aliases.
- App-hosted cloud Settings sections now receive the same dark token scope
  around their section header and body.
- `.theme-cloud` and sibling brand variants now set the `--txt`,
  `--foreground`, `--background`, and `--muted-foreground` aliases used by
  Tailwind/shadcn utilities; this fixed the analytics stat cards' black-on-dark
  labels while keeping the route matrix free of banned blue and orange-hover
  violations.

Previously fixed by the audit harness / cloud-route cleanup (still covered by
this final run):

- `dashboard/settings/connections` carried the original audit's only blue
  (Discord `#5865F2`, Telegram `#0088cc`) on icons/chips/links/buttons; it now
  uses neutral + accent tokens. That route is a Settings section after #11657,
  not part of the current cloud-route screenshot matrix.
- `dashboard/analytics` no longer hangs on a context-only auth gate; it uses
  the shared persisted-token gate (`cloud/lib/auth-query`).
- `payment/app-charge/:appId/:chargeId` crash (RangeError: Invalid time
  value) exposed by a minimal stub - stub now carries the full app-charge
  shape.
- `app-auth/authorize` no longer crashes the Playwright test-auth audit path
  by calling `useAuth()` without a Steward provider; the audit renders the
  signed-in consent state with a local test-auth adapter.
