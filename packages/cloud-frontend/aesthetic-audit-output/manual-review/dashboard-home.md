# Manual review — dashboard-home

Route: `/dashboard`

Screenshots: `../desktop/dashboard-home.png`, `../desktop/dashboard-home--hover.png`, `../mobile/dashboard-home.png`

## Verdict

`good` — after loop-4 JWT fix and the `0/0` → `0` + caption fix, the dashboard renders cleanly: "Welcome back, Test User" greeting, neutral credit balance card next to orange "Add credits" CTA, 4-up stat row showing single-digit counts, "My Agent (0)" empty state with orange "Launch Instance" button. No blue, no orange→black hover.

## Loop-4 fixes landed

- Stat tiles for "Instances running" and "Apps deployed" no longer show `0 / 0`. They show `0` with an optional "of N total" caption when N > 0.
- JWT injection in the audit harness means the page now renders content instead of skeleton.

## Remaining cosmetic items

- "Dashboard" header label is redundant with the "Welcome back" hero. Consider dropping the header title for this one route.
- Credit balance card placeholder underscore visible before balance loads — confirm it does not flash on real usage.

## Interaction targets for e2e

- Each stat tile arrow → corresponding route.
- "Add credits" orange CTA → /dashboard/billing.
- "Launch Instance" empty-state CTA → /dashboard/agents/create or wizard.
- Top-right Invite button → invite modal open.
