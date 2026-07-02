# Manual review — Applications detail tab bar (touched: 9th tab added)

File: `packages/ui/src/cloud/applications/components/app-details-tabs.tsx`.
Change: `hosting` TabValue + Rocket-icon tab between Earnings and Domains;
grid steps `sm:grid-cols-3 xl:grid-cols-9` so the 9 tabs stay balanced
(2-col phone / 3-col tablet / single row desktop).

## Verdict: good

- Tab set renders 9 entries with no overflow at 1280 or 390 wide (fixture page
  frames the same container widths; tab-bar geometry checked via the grid
  class math — 9 columns at xl, 3×3 at sm, 2-col stack on phones).
- Active-tab styling unchanged (accent underline/emphasis comes from the
  existing tab classes — no new colors introduced, no blue).
- Deep link `?tab=hosting` goes through the existing TabValue router — same
  pattern as the other 8 tabs, no special-casing.
- Slop check on the touched file: no dead branches, no commented-out code, no
  card chrome added; the only diff is the tab registration + grid columns.
