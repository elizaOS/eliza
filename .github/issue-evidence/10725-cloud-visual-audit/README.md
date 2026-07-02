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
- `app-auth/authorize` cannot mount its Steward runtime under the test-auth
  build (`useAuth()` outside the provider) — recorded as a harness
  limitation, not a product break (production mounts the runtime; #9881).

## Verdict summary

See `manual-review/` for the per-page verdicts (filled by hand after opening
every screenshot) and the PR for the roll-up table.
