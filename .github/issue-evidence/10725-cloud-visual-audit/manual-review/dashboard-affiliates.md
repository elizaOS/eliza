# dashboard-affiliates

- **route:** `dashboard/affiliates`
- **path:** `/dashboard/affiliates`

## desktop

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** "Save Config" hover probe failed: locator.hover: Timeout 1000ms exceeded.
- **readable content chars:** 1769
- **screenshot quality issues:** none

## mobile

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** "Save Config" hover probe failed: locator.hover: Timeout 1000ms exceeded.
- **readable content chars:** 1769
- **screenshot quality issues:** none

## Hand review

Worst offender of the dark-port debt: program description, invite-friends copy, affiliate-link fields, and fee-markup copy are ALL white-on-cream illegible; only the orange accents (20.00%, Earnings link, Save Config) are readable. Systemic dark-port debt (#10725): the page carries dark-frontend hardcoded `text-white*` classes while the app-hosted shell renders the LIGHT theme (body launch-bg `#ef5a1f`, tokenized cream `BrandCard` bg-bg-elevated) — white copy lands on cream/white surfaces. ~895 `text-white` usages across 93 files under packages/ui/src/cloud; fixing is a theme-token sweep, out of scope for this evidence pass.

_Reviewed by hand from the committed desktop + mobile screenshots (run 3, 85/85 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page unless noted above._
