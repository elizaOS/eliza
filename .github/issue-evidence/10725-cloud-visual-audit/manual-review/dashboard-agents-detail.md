# dashboard-agents-detail

- **route:** `dashboard/agents/:id`
- **path:** `/dashboard/agents/agent-smoke-1`

## desktop

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 710
- **screenshot quality issues:** none

## mobile

- **verdict:** needs-work
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 710
- **screenshot quality issues:** none

## Hand review

Header, status tiles, tabs, action buttons all render with real data. 'Agent Actions' / 'Backups & History' headings + section descriptions are white-on-cream (illegible); the active tab label is low-contrast orange-on-orange. Backups card shows the designed 'Failed to load backups' + Retry error state (endpoint deliberately unstubbed). Systemic dark-port debt (#10725): the page carries dark-frontend hardcoded `text-white*` classes while the app-hosted shell renders the LIGHT theme (body launch-bg `#ef5a1f`, tokenized cream `BrandCard` bg-bg-elevated) — white copy lands on cream/white surfaces. ~895 `text-white` usages across 93 files under packages/ui/src/cloud; fixing is a theme-token sweep, out of scope for this evidence pass.

_Reviewed by hand from the committed desktop + mobile screenshots (rebased 69/69 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page unless noted above._
