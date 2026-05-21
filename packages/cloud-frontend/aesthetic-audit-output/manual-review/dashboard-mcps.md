# Manual review — dashboard-mcps

Route: `/dashboard/mcps`

Screenshots: `../desktop/dashboard-mcps.png`, `../desktop/dashboard-mcps--hover.png`, `../mobile/dashboard-mcps.png`

## Verdict

`good` — MCP catalogue page renders production-quality. "What is MCP?" callout, search + filter chips, 2x2 card grid with name/version/description/tags/pricing/View details.

## Visual issues

- The Weather MCP server card icon uses a teal/cyan brand colour from the MCP catalog itself (not from Tailwind classes). If the "no blue" rule is meant to extend to third-party brand colours, the catalog brand-tint should be muted; otherwise leave as content-owned.
- The status pill "live" uses green which is in-palette and correct.

## Interaction targets for e2e

- Filter chip click narrows the list (gap).
- Search input filters by name (gap).
- View details button → MCP detail page (gap).
- The "?" tooltip next to "MCP Servers (4)" — verify keyboard accessible.
