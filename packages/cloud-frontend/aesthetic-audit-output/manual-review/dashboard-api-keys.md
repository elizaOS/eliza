# Manual review — dashboard-api-keys

Route: `/dashboard/api-keys`

Screenshots: `../desktop/dashboard-api-keys.png`, `../desktop/dashboard-api-keys--hover.png`, `../mobile/dashboard-api-keys.png`

## Verdict

`good` — clean empty state. 4-up stat row, centered "No API keys yet" message with orange key icon, white "Create API Key" CTA. The header has a second "Create API Key" pill top-right which is good for non-empty state but slightly redundant when empty.

## Visual issues

- Two "Create API Key" CTAs visible simultaneously (top-right pill + centred white button). The top-right pill should be hidden when the empty state is showing, or the empty-state button should be hidden.
- "MONTHLY USAGE" tile shows "0 Requests this month - 1,000 rpm" — the dash is an em-dash and the unit "rpm" might be misread as RPM (revolutions per minute) for a non-technical audience. Use "/min" or write out "requests per minute".

## Interaction targets for e2e

- Create API Key happy path → already covered by api-key-flow.spec.ts.
- Revoke key (gap).
- Copy plaintext key after create → already covered.
