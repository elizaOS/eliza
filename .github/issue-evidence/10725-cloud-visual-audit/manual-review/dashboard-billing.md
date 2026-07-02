# dashboard-billing

- **route:** `dashboard/billing`
- **path:** `/dashboard/billing`

## desktop

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** "Buy credits" hover probe failed: locator.hover: Timeout 1000ms exceeded.; "Save" hover probe failed: locator.hover: Timeout 1000ms exceeded.
- **readable content chars:** 972
- **screenshot quality issues:** none

## mobile

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** "Buy credits" hover probe failed: locator.hover: Timeout 1000ms exceeded.; "Save" hover probe failed: locator.hover: Timeout 1000ms exceeded.
- **readable content chars:** 972
- **screenshot quality issues:** none

## Hand review

Balance card, auto-top-up copy, and the no-saved-payment-method notice are legible; 'Add credits to your account' heading + amount label, the 'Use my app earnings…' row title, and the top-up form labels are washed white-on-cream; the amount input floats right oddly at desktop width. (Runs 1-2 crashed on the harness's minimal billing-settings stub; the stub now carries the real autoTopUp/limits shape.) Systemic dark-port debt (#10725): the page carries dark-frontend hardcoded `text-white*` classes while the app-hosted shell renders the LIGHT theme (body launch-bg `#ef5a1f`, tokenized cream `BrandCard` bg-bg-elevated) — white copy lands on cream/white surfaces. ~895 `text-white` usages across 93 files under packages/ui/src/cloud; fixing is a theme-token sweep, out of scope for this evidence pass.

_Reviewed by hand from the committed desktop + mobile screenshots (run 3, 85/85 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page unless noted above._
