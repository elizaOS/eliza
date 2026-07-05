# #13598 views audit-sweep — loop 2 (post-knowledge-hub verification)

Ran `bun run --cwd packages/app audit:app` (the sanctioned all-views aesthetic
audit, #8796) against a freshly-built renderer + live stack, on top of
`origin/develop` after the merges that landed since loop 1: the Knowledge
multimedia hub fold (#13976/#13594), knowledge slice 3 (#13974/#13595), the
Character redesign + bio autosave (#14123/#14156), browser folded tabs
(#14149/#13596), the ContinuousChatOverlay mobile-landscape clearance fix
(#14198/#14173), chat history (#14300), and the taste fixes #14294/#14282/#14293.

## Result

```
368 findings — broken=0  needs-work=9  needs-eyeball=21  good=338
```

368 specs (built-in tabs + plugin views × {mobile-portrait, mobile-landscape,
desktop-landscape, ipad-portrait}). One non-blocking CI failure: the "Her-minimal
ratchet" gate on the 3 dense trading views (same soft baseline signal as loop 1);
`EXIT_CODE=1` comes from that ratchet, not from any crash or broken render.
Zero views with console errors, blue colors, quality issues, hover *violations*,
or blank screens.

**broken=0 — no integration breakage** from the knowledge-hub / character /
browser / chat-history merges stacking on top of each other. Every touched view
was hand-reviewed from its screenshots.

## Loop-1 needs-work resolution (the headline)

Loop 1 had 10 `needs-work`: 6 overlay-clearance + 4 trading-ratchet.

**The 6 ContinuousChatOverlay mobile-landscape overlaps — 5 RESOLVED by #14198:**

| loop-1 needs-work page | loop-2 |
| --- | --- |
| `builtin-inventory` (/wallet)     | **good** (overlayClear 0) |
| `plugin-documents-gui`            | **good** (overlayClear 0) |
| `plugin-lifeops-live-test-gui`    | **good** (overlayClear 0) |
| `plugin-wallet-gui`               | **good** (overlayClear 0) |
| `plugin-cockpit-gui`              | **good** (overlayClear 0) |
| `builtin-browser`                 | **needs-work** — improved 3→1 overlap, one residual |

#14198's short-landscape compact-landing shrinks the resting composer to a
bottom-corner affordance. Five of the six pages have no bottom-anchored control
row, so they clear cleanly. `/browser` is the exception: its bridge-connectivity
fallback row (`sm:grid-cols-3`) has a rightmost "Refresh Browser Bridge" cell
that still lands under the corner affordance (4888px²). Filed as **#14320**.

**The 4 trading-ratchet needs-work — unchanged (as expected):** `hyperliquid`
+ `polymarket` remain marginally over the divider-density whitespace ratchet;
not touched by these merges (`hyperliquid` mobile-landscape softened to
`needs-eyeball`).

## New loop-2 needs-work — both heuristic false-positives (#14320)

- **`builtin-tutorial` (all 4 viewports)** — the tutorial view is a thin launcher
  that *deliberately* opens the chat overlay to run the tour ("The tour runs in
  the chat — it's open below."). The heuristic flags the open overlay covering
  the "Reopen the tour" fallback button; that button only matters when the tour
  is closed, so the overlap is the intended interaction. NEW vs loop 1 only
  because #14300 made the auto-opened tour render expanded at capture time.
  **Hand verdict: good.** No source defect.
- **`builtin-background` mobile-landscape** — 288px² graze (right at the 160px²
  floor) of the corner affordance against the centered "Background image file"
  upload icon. Fractional sliver; control fully tappable. **Hand verdict:
  needs-eyeball.**

## Touched-view verdicts (hand-reviewed GOOD)

- **Knowledge multimedia hub (#13976)** — single uniform "Knowledge" ViewHeader
  (no double header); media-format FACETS with whole-store per-facet counts
  (All / Docs / Images / Audio / Video / Transcripts — Transcripts+Files folded
  in); scope filter (All / Global / Owner / User / Agent); designed
  `PagePanel.Empty` states; orange "Add". See
  `desktop-landscape-builtin-documents.png`.
- **Character redesign (#14123 + #14156)** — uniform "Character" ViewHeader;
  section STRIP via CharacterSectionNav (Personality / Relationships / Skills /
  Experience); About Me + bio autosave; designed empty states for Style Rules /
  Chat Examples / Post Examples; CTA grid + dual render path removed. See
  `desktop-landscape-builtin-character.png`.
- **Browser folded tabs (#14149)** — uniform "Browser" ViewHeader ABOVE the
  toolbar; folded "No tab N" switcher replaces the old User/Agent/App Tabs
  sidebar; designed empty state. See `desktop-landscape-builtin-browser.png`.
- **Chat history (#14300)** — search (MessageSearchPanel) + reachable clear +
  infinite scroll source-confirmed; topic-label leak fix (#14294); shared-
  background lockscreen surface renders clean, no overflow at 375px. See
  `mobile-portrait-builtin-chat.png`.

Confirmed by hand across the sweep:
- **Uniform ViewHeader** on every normal view; **no double headers** (Knowledge
  hub single header; Browser puts ViewHeader above the toolbar).
- **Folded tab switcher renders** (#14149) — no permanent tab strip.
- **Character section strip** (#14123).
- **Designed empty states** everywhere (three-state rule); **no page-view
  suggestion chips** (chat-home suggestions are by-design).
- **No wallpaper bleed** on opaque routes; shared-background routes (chat, apps,
  background) show it intentionally.
- **No blue** anywhere; **orange accent only**.
- **No mobile-portrait horizontal overflow** (375px).

## Contents

- `report.json` — machine-readable findings for all 368 specs.
- `contact-sheet.html` — grid index of every capture.
- `manual-review/<slug>.md` — per-view verdict stubs (368); the touched views,
  the resolved loop-1 pages, and every non-good page carry hand-written verdicts.
- `<viewport>-<slug>.png` — curated screenshots of the headline merged views and
  every non-good page.

_Note (#14320 filed):_ the audit clearance heuristic could exempt views that
intentionally auto-open the overlay (e.g. `builtin-tutorial`) from the clearance
check, the way `OVERLAY_NATIVE_OR_CANVAS_SLUGS` already exempts canvas surfaces.
