# Cloud Frontend — Manual Visual Review Protocol

Any coding agent that touches UI in `packages/cloud-frontend/` MUST follow this
protocol before declaring work complete. The protocol exists because automated
e2e specs catch only what they assert — hover-state regressions, palette drift,
broken empty states, and mobile layout breaks slip through. A visual audit +
human-style page-by-page review is the only reliable gate.

## Run the audit

```bash
bun run --cwd packages/cloud-frontend audit:cloud
```

This runs `tests/e2e/aesthetic-audit.spec.ts` headless against the local
preview server and opens `aesthetic-audit-output/contact-sheet.html` in your
default browser when finished.

The audit walks every route in `src/App.tsx` (public + dashboard, including
parameterized routes hit with an invalid `e2e-fixture` id so the empty/error
state is captured) at desktop (1440x900) and mobile (390x844) viewports.

## Where outputs land

```
packages/cloud-frontend/aesthetic-audit-output/
  desktop/<slug>.png            full-page screenshot at rest
  desktop/<slug>--hover.png     full-page screenshot with first primary button hovered
  mobile/<slug>.png
  mobile/<slug>--hover.png
  manual-review/<slug>.md       human-authored review notes (REQUIRED for every route)
  contact-sheet.html            grid view of every screenshot + flagged issues
  report.json                   machine-readable per-page audit data
```

Stub `manual-review/<slug>.md` files are auto-generated for every route the
first time the audit runs. Existing files are never overwritten — the human
notes are the source of truth.

## The manual review loop

For every UI change, run this loop until verdict is `good` for every page you
touched (and every page your change can reach transitively — global header,
footer, layout, theme, button primitives, etc.):

1. Run `bun run --cwd packages/cloud-frontend audit:cloud`.
2. Open `aesthetic-audit-output/contact-sheet.html`. Walk every page that
   could be affected.
3. For each affected page, open `manual-review/<slug>.md` and fill in:
   - **Visual issues** — anything that looks wrong, broken, or off-brand.
   - **Color / hover violations** — quote the element + rest/hover colors.
     Project rules: brand orange (#ff8a00-ish) is accent only, never a hover
     destination from neutral; orange<->black hover transitions are banned;
     blue is banned from the palette entirely.
   - **Layout breaks** — viewport + element.
   - **Interaction targets to add to e2e** — buttons/links that should have
     automated coverage.
   - **Verdict** — `good`, `needs-work`, or `broken`.
4. Fix the issues.
5. Commit screenshots + manual-review markdown + code fixes together (one
   commit per loop iteration is fine).
6. Re-run the audit and repeat. Allow up to 5 loops per page. If a page is
   still not `good` after 5 loops, escalate — do not declare done.

## Rules

- **Every page must have a screenshot AND a `manual-review/<slug>.md`** with
  a verdict checked into the repo. A page with no review markdown is a page
  that was never reviewed.
- **Do not mark a UI task complete with any page at verdict `needs-work` or
  `broken`.** Either fix it or document why it is acceptable in the markdown.
- **Never overwrite an existing `manual-review/<slug>.md`** — the human notes
  are load-bearing. The audit only writes stubs for new routes.
- **The contact sheet is not the review.** It is the index. The review lives
  in the per-page markdown.

## Checklist template (mirrored in every stub)

- [ ] Header / nav present and aligned
- [ ] Logo size + nav padding match other pages
- [ ] No blue colors anywhere (banned)
- [ ] Hover states do not transition orange<->black on the same element
- [ ] Focus ring visible on every interactive element (tab through)
- [ ] Empty state renders cleanly
- [ ] Loading state renders cleanly (no layout jump)
- [ ] Mobile layout: no horizontal scroll, tap targets >= 44px
- [ ] Text contrast meets WCAG AA
- [ ] Border radius is 3px (xs) or pill — no other values
- [ ] No console errors at rest
- [ ] No 5xx network requests

## What the spec auto-flags

You don't need to eyeball these — the spec already detects them and lists
them on each contact-sheet card and in `report.json`:

- console errors and `pageerror` events
- non-401/403/404 failed network responses
- border-radius values outside {0, 3px, pill}
- palette violations: orange<->black hover transitions, neutral->orange
  hover destinations, any blue color on buttons (rest, hover, or focus ring)

Your job in the manual review is to catch what the spec can't: spacing,
typography rhythm, contrast, empty/loading state quality, mobile breaks,
keyboard navigation, and overall brand fit.
