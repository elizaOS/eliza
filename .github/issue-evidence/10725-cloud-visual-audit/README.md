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

42 pages x 2 viewports, final walk 85/85 green. Hand verdicts (desktop +
mobile agree on every page; details + per-page notes in `manual-review/`):

- **good - 25 pages:** my-agents, billing-success, settings-connections
  (blue fixed in this PR), payment-request, payment-success (redirector),
  payment-app-charge (stub-shape fixed), approve, sensitive-request,
  public-character-chat, invite-accept, accept-invitation, login,
  auth-success, auth-error, auth-cli-login, auth-callback-email, terms,
  privacy, bsc, apps, apps-detail, approvals, admin, admin-redemptions,
  admin-rpc-status, mcps.
- **needs-work - 16 pages:** agents, agents-detail, account, security,
  security-permissions, analytics, billing, invoice-detail, organization,
  join, ballot, api-explorer, monetization, earnings, affiliates.
  **One systemic root cause:** the cloud dashboard was ported from the
  dark-only cloud-frontend and carries ~895 hardcoded `text-white*` usages
  across 93 files under `packages/ui/src/cloud/`, while the app-hosted
  shell renders the light theme (body launch-bg `#ef5a1f`, tokenized cream
  `BrandCard`), so headings/copy land white-on-cream. Concrete citation:
  `instances/components/eliza-agent-pricing-banner.tsx:58`. The fix is a
  theme-token sweep (parent #10725 scope), not a per-page patch.
- **needs-eyeball - 1 page:** app-auth-authorize - with the test-auth
  build the Steward runtime never mounts so `useAuth()` throws into the
  error boundary; production mounts the runtime (#9881). Needs a
  runtime-backed capture.

Fixed in this PR (verified by the run-3 machine scan + screenshots):

- `dashboard/settings/connections` carried the audit's ONLY blue (Discord
  `#5865F2`, Telegram `#0088cc` on icons/chips/links/buttons) -> neutral +
  accent tokens; zero blue across all 84 findings in run 3.
- `dashboard/analytics` hung on its skeleton behind a context-only auth
  gate -> now uses the shared persisted-token gate (`cloud/lib/auth-query`).
- `payment/app-charge/:appId/:chargeId` crash (RangeError: Invalid time
  value) exposed by a minimal stub - stub now real-shaped; page-side
  formatDate robustness noted for #10725.
