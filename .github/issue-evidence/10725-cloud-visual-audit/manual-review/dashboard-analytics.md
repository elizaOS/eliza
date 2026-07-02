# dashboard-analytics

- **route:** `dashboard/analytics`
- **path:** `/dashboard/analytics`

## desktop

- **verdict:** good
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 736
- **screenshot quality issues:** none

## mobile

- **verdict:** good
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 736
- **screenshot quality issues:** none

## Hand review

Data pipeline works end-to-end (this PR fixed the analytics auth gate: the context-only gate hung on the loading skeleton whenever the Steward runtime was not mounted; it now shares cloud/lib/auth-query with persisted-token fallback). Stat cards, series, cost outlook render real values. 'Filters' card heading/labels and the Usage / Cost outlook section headings are washed white-on-cream. Systemic dark-port debt (#10725): the page carries dark-frontend hardcoded `text-white*` classes while the app-hosted shell renders the LIGHT theme (body launch-bg `#ef5a1f`, tokenized cream `BrandCard` bg-bg-elevated) — white copy lands on cream/white surfaces. ~895 `text-white` usages across 93 files under packages/ui/src/cloud; fixing is a theme-token sweep, out of scope for this evidence pass.

_Reviewed by hand from the committed desktop + mobile screenshots (rebased 69/69 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page unless noted above._
