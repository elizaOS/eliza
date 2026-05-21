# Manual review — dashboard-apps

Route: `/dashboard/apps`

Screenshots: `../desktop/dashboard-apps.png`, `../desktop/dashboard-apps--hover.png`, `../mobile/dashboard-apps.png`

## Verdict

`needs-work` — onboarding tooltip ("Apps Overview — Track your apps performance...") is overlapping the "No apps yet" empty-state text behind it. The first stat tile has a saturated orange border which makes it look like an error/alert state when actually it is a tour-step highlight.

## Visual issues

- Tour-step orange border on the Total Apps tile is too saturated — looks like an error state. Use a thinner border or a different highlight treatment (subtle outer ring).
- The orange "Next" button in the tour popover has no visible label in the screenshot — text colour may be same as button colour.
- Tour popover obscures the empty-state primary CTA ("Create App"); the tour should not block the action the user just landed on.
- "1 of 4" tour-step pagination — confirm it is dismissible and that the X button reliably closes it.

## Interaction targets for e2e

- Skip tour (X button) on first land.
- Create App from empty state → /dashboard/apps/create.
- Advanced filter toggle.
