# #13598 views audit-sweep — loop 1 (post-merge integration baseline)

Ran `bun run --cwd packages/app audit:app` (the sanctioned all-views aesthetic
audit, #8796) against the freshly-built renderer + stub-backed server, on top of
`origin/develop` after the ~20 views-redesign merges of the last 24h (uniform
ViewHeader, Settings/Tasks/Browser section-nav, chip/CTA removal #14098, launcher
zones #13883, surface-manifest wallpaper gating #14068, chat activity feedback
#13739, PWA safe-area floor #14067).

## Result

```
372 findings — broken=0  needs-work=10  needs-eyeball=20  good=342
minimalism-budget-failures=1  minimalism-ratchet-failures=4  hover-probe-failures=75
undebted-broken=0  undebted-needs-work=10
```

373 specs (built-in tabs + plugin views × {mobile-portrait, mobile-landscape,
desktop-landscape, ipad-portrait}); 1 non-blocking spec failure:
`plugin-smartglasses-tui ipad-portrait` (same as the loop-0 #13904 baseline).

**`broken=0` — no integration breakage from the merges landing on top of each
other.** Every touched view was hand-reviewed from its screenshots.

## Touched-view verdicts (all GOOD)

`chat`, `messages`, `tasks`, `browser` (desktop/ipad/portrait), `settings`,
`documents`, `transcripts`, `files`, `inventory`, `character`, `help`,
`relationships`, `database`, `skills`, `trajectories`, `memories`, `automations`,
`character-skills`, `fine-tuning`, `apps` — all GOOD.

Confirmed by hand:
- **Uniform ViewHeader** present with icon-only back on every normal view; no
  double headers (Browser #14074 puts ViewHeader ABOVE the toolbar; Settings/Tasks
  headers de-duped).
- **No leftover page-view suggestion chips** (#14098) — designed empty states
  render instead (`PagePanel.Empty` / `TaskEmptyState`). Functional controls kept:
  Browser "Open a website", Logs "Clear filters", Documents "Upload".
- **Designed empty states render** (not blank).
- **No wallpaper bleed** on opaque routes (#14068) — Settings/Tasks/Browser paint
  opaque `bg-bg`; only shared-background routes (chat, apps) show the wallpaper.
- **No blue** in UI chrome; **orange accent only** (app-icon artwork is decorative
  and correctly excluded from the blue scan).
- **No mobile-portrait horizontal overflow.**

## Findings that are NOT merge regressions

- **`needs-work` × mobile-landscape overlay-clearance** (browser, inventory/wallet,
  documents, lifeops-test, cockpit): the shared `ContinuousChatOverlay` overlaps
  bottom-row view controls in the 844×390 landscape viewport. Pre-existing overlay
  geometry, filed as **#14173**. Portrait/desktop/ipad are clear.
- **`needs-work` × minimalism whitespace** (hyperliquid, polymarket plugin views):
  dense trading UIs marginally under the whitespace ratchet (0.55 vs 0.62). Not
  touched by these merges; soft baseline signal.
- **`needs-eyeball` × off-token border-radius** (runtime, logs, skills, plugins,
  calendar, goals, inbox, relationships, screenshare): soft radius signals only,
  non-blocking.

## Contents

- `report.json` — full machine-readable findings (372).
- `contact-sheet.html` — grid index of all verdicts.
- `desktop-landscape-*.png`, `mobile-portrait-*.png` — curated touched-view shots.
- `mobile-landscape-*-overlay-clearance.png` — #14173 defect evidence.
- `manual-review/*.md` — hand-written per-view loop-1 verdicts.

## Environment note

This ran in a fresh `.claude/worktrees/*` worktree with no `node_modules`. The
`audit:app` prerequisites (logger typecheck, plugin view builds, renderer
`build:web`) needed the worktree's `node_modules` materialized with the
`@elizaos` scope pointed at the WORKTREE packages (fresh dists incl. #14068's new
`surfaceGrants` core export), third-party deps symlinked to the root `.bun` store.
No product code was changed to satisfy the tool. Full recipe in the durable
memory note `reference_audit_app_fresh_worktree_needs_nested_node_modules_and_elizaos_scope`.
