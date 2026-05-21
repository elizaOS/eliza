# Manual review — dashboard-home

Route: `/dashboard`

Screenshots: `../desktop/dashboard-home.png`, `../desktop/dashboard-home--hover.png`, `../mobile/dashboard-home.png`

## Verdict

`needs-work` — redesign landed and looks excellent on first glance (orange Add Credits accent + 4-up stat row + neutral cards). Two real issues to fix:

## Visual issues

- The Agents stat tile (first of the 4-up row) renders only a dot + skeleton bar instead of a count; the mock data must not be feeding the per-tile loader correctly.
- Bottom row of skeletons (4 narrow cards) never resolves to content in the audit — likely the "recent agents" section still waiting on a query the mock does not satisfy. Either supply a real fixture in the audit or make the empty state more graceful in source.
- "Dashboard" word in the top header bar is redundant with the "Welcome back" hero — drop the header label or replace with a breadcrumb.
- `0 / 0` notation on stat tiles ("Instances running", "Apps deployed") looks like a fraction. Either show just `0` or label the denominator (e.g. "0 of 3 quota").

## Color / hover violations

None — Add Credits orange tile rests at orange and (per --hover.png) hovers slightly darker. Compliant.

## Interaction targets for e2e

- Each stat tile arrow click → routes to the corresponding section.
- Add Credits orange CTA → routes to billing.
- Top-right Invite button → opens invite modal.
