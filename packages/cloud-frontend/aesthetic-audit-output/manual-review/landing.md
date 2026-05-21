# Manual review — landing

Route: `/`

Screenshots:
- desktop: `../desktop/landing.png`
- desktop hover: `../desktop/landing--hover.png`
- mobile: `../mobile/landing.png`

## Checklist

- [x] Header / nav present and aligned (small "elizacloud" wordmark left, "Developer Dashboard" CTA right)
- [x] Logo size + nav padding match other pages
- [x] No blue colors anywhere — palette = sky background photo + black CTA + white text
- [x] Hover states do not transition orange<->black on the same element
- [ ] Focus ring is visible on every interactive element — not verified
- [x] Empty state renders cleanly (n/a — marketing page)
- [x] Loading state renders cleanly (no skeleton flash observed)
- [ ] Mobile layout — not yet reviewed (mobile screenshot exists, needs eyeball pass)
- [x] Text contrast meets WCAG AA against background (the sky photo bottom-right has lighter clouds — "Your agent always online" tagline gets close)
- [x] Border radius is 3px (xs) or pill — confirmed for "Launch Eliza" button
- [x] No console errors at rest
- [x] No 5xx network requests

## Visual issues

- The "Developer Dashboard" button (top-right) is confusing for unauthenticated users — it implies a destination they cannot access. Either hide for anon users or relabel to "Sign in".
- Footer is minimal (Privacy / Terms / Docs / Github) — fine for now.
- The sky cloud background has a faint sunburst column in the centre that draws the eye away from the headline. Consider reducing its opacity.

## Color / hover violations

None observed. The "Launch Eliza" button is `bg-black` with no hover destination captured in `--hover.png` (button does not change colour on hover) — verify this isn't a regression vs the previous `hover:bg-white hover:text-black` inversion.

## Layout breaks

None on desktop. Mobile pending.

## Interaction targets to add to e2e

- "Launch Eliza" hero CTA → routes to `/login` (or `/dashboard` if authed).
- "Developer Dashboard" header CTA → routes to `/dashboard`.
- Footer links: Privacy → `/privacy-policy`, Terms → `/terms-of-service`, Docs → `/docs/`, Github → external (assert `target="_blank"` + `rel="noopener"`).

## Verdict

`needs-work` — page is clean and on-brand, but the "Developer Dashboard" button labelling is wrong for anon users and the hero hover state may have regressed.
