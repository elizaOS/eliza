# 12061 — UI/UX polish evidence (PR #12062)

Captured live from dev stacks on 2026-07-03. "Before" = origin/develop tip
(e0256ba54c3) in a separate worktree; "after" = feat/ui-ux-polish. Both stacks
booted with `bun run dev` and screenshotted with Playwright at 390×844
(mobile) and 1440×900 (desktop).

## before/ vs after/

| Pair | Bug on develop | Fix on this branch |
|---|---|---|
| `memories-mobile-orphan-sidebar-button` → `memories-mobile-clean-header` | Orphan sidebar-switcher strip floats above the Memories header (the "bad button" above/below the back arrow) | `AppWorkspaceChrome` strip removed; sidebar access via PageLayout's labeled inline trigger |
| `knowledge-mobile-bordered-scope-chips` → `knowledge-mobile-borderless-scope-chips` | Upload scope chips are bordered pills; view breached the border-density ratchet (60.76 > 45) | Borderless text tabs matching the filter chips; audit ratchet passes |
| `transcripts-desktop-header-overlap` → `transcripts-desktop-header-aligned` | "Transcripts" title overlaps the back arrow on desktop (responsive position utilities don't compile; back button stayed `absolute`) | ViewHeader rebuilt as a 3-column grid — no position utilities |
| `transcripts-mobile-deep-link-hijack` → `transcripts-mobile-deep-link-honored` | Fresh load of a deep link intermittently rewrites the URL to `/character/select` (2 of 4 before-captures hijacked; check the `final-url` note below) | Deep links win over the post-first-run character-select landing (`startup-phase-hydrate.ts`) |

Deep-link final URLs observed during capture — before (develop):
`/apps/memories` → `/character/select`, `/apps/transcripts` (desktop) →
`/character/select`; after (this branch): all four routes keep their URL.

## audit/

Key frames from the repo visual audit (`bun run --cwd packages/app audit:app`),
which passed 365/365 checks on this branch across mobile-portrait,
mobile-landscape, ipad-portrait, and desktop-landscape:

- `mobile-portrait-views.png` — launcher: **Messages** tile (renamed from
  Chat) plus Wallet, Tasks, Character, Relationships, Knowledge, Skills,
  Experience, Transcripts, Memories, Help as top-level tiles.
- `mobile-portrait-settings.png` / `ipad-portrait-settings.png` — "Settings"
  centered in the header on the same line as the chromeless back arrow
  (white in light mode; `bg-bg` follows the theme in dark mode).
- `mobile-portrait-character.png` — "Character" heading with chromeless back.
- `mobile-portrait-character-skills.png` / `-experience.png` — promoted
  top-level views with headers (duplicated in-body titles removed).
- `mobile-portrait-documents.png` — Knowledge view, header + borderless chips.
- `mobile-portrait-transcripts.png` / `-memories.png` / `-help.png` — header
  titles present on each view.
- `mobile-portrait-inventory.png` — Wallet tile opens the real wallet.
- `mobile-portrait-tasks.png` — Tasks tile opens the Tasks orchestrator view.
- `mobile-landscape-views.png` — launcher in landscape.
- `desktop-landscape-transcripts.png` — desktop header, aligned.

Sibling lane evidence (desktop tray, iOS simulator, Android, live-LLM
trajectories) lands under `../ui-ux-polish/` lane directories from the
parallel verification lanes.
