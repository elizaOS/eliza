# dashboard-invoice-detail

- **route:** `dashboard/invoices/:id`
- **path:** `/dashboard/invoices/invoice-smoke-1`

## desktop

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 306
- **screenshot quality issues:** none

## mobile

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 306
- **screenshot quality issues:** none

## Hand review

Invoice renders from the stubbed camelCase payload (status PAID, transaction table). The 'Invoice details' / 'Payment information' card labels and values are washed white-on-cream; the dark transaction-summary table is fully legible. Systemic dark-port debt (#10725): the page carries dark-frontend hardcoded `text-white*` classes while the app-hosted shell renders the LIGHT theme (body launch-bg `#ef5a1f`, tokenized cream `BrandCard` bg-bg-elevated) — white copy lands on cream/white surfaces. ~895 `text-white` usages across 93 files under packages/ui/src/cloud; fixing is a theme-token sweep, out of scope for this evidence pass.

_Reviewed by hand from the committed desktop + mobile screenshots (rebased 69/69 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page unless noted above._
