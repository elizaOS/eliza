# Manual review — dashboard-security-permissions

Route: `/dashboard/security/permissions`  (auth-required)

Screenshots:
- desktop: `../desktop/dashboard-security-permissions.png`
- desktop hover: `../desktop/dashboard-security-permissions--hover.png`
- mobile: `../mobile/dashboard-security-permissions.png`

## Checklist

- [ ] Header / nav present and aligned
- [ ] Logo size + nav padding match other pages
- [ ] No blue colors anywhere (banned from palette)
- [ ] Hover states do not transition orange<->black on the same element
- [ ] Focus ring is visible on every interactive element (tab through)
- [ ] Empty state renders cleanly (no broken layout)
- [ ] Loading state renders cleanly (no layout jump on data arrival)
- [ ] Mobile layout: no horizontal scroll, no overflow, tap targets >= 44px
- [ ] Text contrast meets WCAG AA against background
- [ ] Border radius is 3px (xs) or pill — no other rounding values
- [ ] No console errors in DevTools at rest
- [ ] No 5xx network requests

## Visual issues

_List anything that looks wrong._

## Color / hover violations

_Cite the element + the rest/hover colors._

## Layout breaks

_Cite the viewport + the element._

## Interaction targets to add to e2e

_Buttons/links that need automated coverage._

## Verdict

`good` | `needs-work` | `broken`

_Pick one. Until verdict is `good`, redo the audit loop after each fix._
