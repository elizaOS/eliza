# Manual review — Applications detail › Hosting tab (new, #10690)

Route: `dashboard/apps/:id?tab=hosting` (9th tab on the Applications detail page).
Captures: `../screenshots/01…13-*.png`, `../walkthrough.webm` (all from the REAL
component against the REAL mock cloud stack — PGlite + in-memory R2 + real SIWE key).

## Verdict: good

## Checklist (hand-reviewed on the actual pixels)

- **Empty state** (`01-desktop-empty.png`): dashed-border `EmptyState`, rocket
  glyph on accent-subtle, copy legible. No card chrome. ✓
- **Selection + hover** (`02`): file summary "1 files · 47 B", Publish is the
  accent (orange) button; runner-asserted rest `rgb(255,138,36)` → hover
  `rgb(229,79,0)` — darker orange, never orange→black. ✓
- **Populated list** (`03`,`04`): flat divide-y list rows (no cards), orange
  `live` badge only on the active row, neutral `superseded` badge, per-row
  Preview/Roll back/Delete affordances only where valid (active row has no
  delete). ✓
- **Rollback confirm** (`05`): AlertDialog copy states the consequence
  ("replaced immediately on all app domains… stays available for rollback"). ✓
- **After rollback** (`06`): v1 shows `live`, v2 superseded — matches the
  server state asserted over raw HTTP in the same run. ✓
- **Delete confirm + after** (`07`,`08`): permanent-removal copy; v2 gone from
  the list and (asserted) from the server. ✓
- **Mobile 390×844** (`09`,`10`): rows wrap cleanly, controls reachable, no
  horizontal overflow. ✓
- **Cloud-inactive** (`11` desktop, `12` mobile): API unreachable → dashed
  error panel + Retry; `13` proves Retry recovers to the populated list once
  the cloud is reachable again. ✓
- **No blue**: runner walks every element's computed color/background/border —
  0 blue offenders. ✓

## Known issue observed (NOT this page's bug)

Rows show "about 5 hours ago" for a just-published deployment on the local
mock stack: the server's `created_at` (DB `defaultNow()`) arrives TZ-skewed
(`03:05Z` when the true instant is `08:05Z`) while `activated_at` (set in JS)
is correct — a `packages/cloud/shared` schema/PGlite-harness defect, verified
by raw JSON (`logs/mockstack-smoke.log`). The UI renders the wire value
faithfully (clients display, never compute); fix belongs in the cloud schema
layer, outside this leg's ownership.
