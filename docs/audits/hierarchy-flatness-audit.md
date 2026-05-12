# Action Hierarchy Flatness Audit

**Date:** 2026-05-10
**Branch:** `shaw/more-cache-toolcalling`
**Author:** Mechanical-cleanup pass (Agent A)

## Goal

Enforce a strict 1-layer Action hierarchy: each top-level Action either has
no subactions, or has a flat `subaction` enum that maps to handler branches.
Subactions must NOT themselves dispatch into further subactions.

This audit scans every Action file across the project (excluding examples,
benchmarks, and worktrees) for three nested-hierarchy patterns:

1. **Dotted-namespace action names** — actions named `<UMBRELLA>.<verb>`
   (literal dot in the `name:` field).
2. **Subactions whose handlers themselves dispatch into further subactions**
   — i.e. an umbrella whose `subaction = X` branch internally reads another
   discriminator and dispatches again.
3. **Zod / JSON Schema discriminated unions inside subactions** — schema
   shapes that imply the subaction value carries its own nested
   discriminator.

## Method

```
grep -rln 'name: "[A-Z_]*\.[a-z]' --include="*.ts"
grep -rln 'subActions:\s*\[' --include="*.ts"
```

Plus targeted reads of every action file using `subActions:` /
`subPlanner:` / `dispatchSubaction` / `readSubaction`.

## Findings

### Dotted-namespace action names — 1 finding (FLATTENED)

| File | Old name | New name |
|---|---|---|
| `plugins/app-lifeops/src/actions/message-handoff.ts` | `MESSAGE.handoff` | `MESSAGE_HANDOFF` |

`MESSAGE.handoff` was renamed to `MESSAGE_HANDOFF` in this commit. The old
name is preserved as a one-release simile so cached planner outputs continue
to route. No other dotted action names exist in the project.

### Two-layer subaction hierarchies — 4 findings

The `subActions: [...]` + `subPlanner` pattern remains in four places. This
pattern lets a parent umbrella point at child Actions that are themselves
registered separately; the sub-planner dispatches to one of them. By design,
each sub-action it points at IS a top-level Action, so the depth is still 1
relative to the planner — but the pattern hides hierarchy in a way that's
hard to reason about. Three of them are documented below.

#### 1. `CALENDAR` (lifeops) → `GOOGLE_CALENDAR` (PUNT)

- **File:** `plugins/app-lifeops/src/actions/calendar.ts` (line 538) +
  `plugins/app-lifeops/src/actions/lib/calendar-handler.ts`
- **Pattern:** `CALENDAR.subActions = [googleCalendarAction, ...]`. The child
  `GOOGLE_CALENDAR` itself reads an internal `subaction` from a subplanner
  prompt (feed, next_event, search_events, create_event, ...). That makes
  `CALENDAR → GOOGLE_CALENDAR → subaction` a 2-layer dispatch.
- **Punt rationale:** `GOOGLE_CALENDAR` is registered as a stand-alone
  top-level Action AND linked from `CALENDAR.subActions`. The CALENDAR
  subplanner gives the planner a coherent "here are the calendar surfaces"
  view; flattening would either inline GOOGLE_CALENDAR's whole subaction
  enum into CALENDAR (large, conflated with availability/preferences) or
  remove the link (loses the multi-step planner hint). Medium-confidence
  punt — needs a domain-aware refactor.

#### 2. `FILE` (plugin-coding-tools) → `READ` / `WRITE` / `EDIT` (PUNT)

- **File:** `plugins/plugin-coding-tools/src/actions/file.ts`
- **Pattern:** `FILE.subActions = [readAction, writeAction, editAction]`.
  Each sub is a separate top-level Action.
- **Punt rationale:** The three sub-actions have very different parameter
  shapes (`read` is path-only; `edit` is path + old + new + replace; `write`
  is path + content). Collapsing to one umbrella with a `subaction` enum
  would force a giant union schema. The current pattern keeps the schemas
  honest. Low risk because the three subs ARE flat themselves.

#### 3. `TODO` (advanced-capabilities, DELETED in this commit)

- **File:** `packages/core/src/features/advanced-capabilities/todos/actions/todo.ts`
- **Pattern:** `TODO.subActions = [CREATE_TODO, COMPLETE_TODO, LIST_TODOS,
  EDIT_TODO, DELETE_TODO]` with `subPlanner`. Each child was a separate
  top-level action.
- **Resolution:** The advanced-capabilities `todoAction` was a 49-line stub
  duplicating the canonical 571-line `TODO` umbrella in
  `plugins/plugin-todos/src/actions/todo.ts`. Both registered as `TODO`,
  causing silent shadow at load time. Deleted the stub; canonical TODO is
  now a flat op-dispatch action with `subaction: write|create|update|...`.
  The leaf actions (CREATE_TODO etc.) remain registered for direct dispatch
  in `advanced-capabilities` consumers that don't depend on plugin-todos.

#### 4. `CODE` (packages/agent, DELETED in this commit)

- **File:** `packages/agent/src/actions/code-umbrella.ts` (deleted)
- **Pattern:** `CODE.subActions = [CREATE_WORKSPACE, SUBMIT_WORKSPACE,
  ARCHIVE_CODING_TASK, REOPEN_CODING_TASK]` with subplanner. The handler
  was a "Pick a sub-action" placeholder. The actual ops live as subactions
  on TASKS in `@elizaos/plugin-agent-orchestrator`.
- **Resolution:** Deleted. CODE was an exported but unregistered stub. It
  duplicated TASKS umbrella functionality (which is the canonical surface)
  without adding anything new.

### Subaction handlers that dispatch into further subactions — 1 finding

#### MUSIC_LIBRARY: `subaction=playlist` → `playlistOp` (FLATTENED)

- **File:** `plugins/plugin-music/src/actions/musicLibrary.ts`
- **Pattern (before):** `op = playlist | play-query | play_query |
  search-youtube | search_youtube | download` (kebab + snake duplicates)
  + a nested `subaction = save | load | delete | add` consumed when
  `op = playlist`.
- **Pattern (after):** `subaction = playlist | play_query | search_youtube |
  download` (snake_case only) + nested `playlistOp = save | load | delete |
  add`. The kebab-case enum entries were redundant — the `normalizeSubaction`
  helper already collapses `-` to `_`. The nested `subaction` parameter was
  renamed to `playlistOp` so the umbrella's primary discriminator is named
  consistently with the rest of the project.

The final shape is still a 2-call dispatch (top-level subaction first, then
inside `playlist` the handler reads `playlistOp`), but the discriminators
are now uniquely named so the schema is unambiguous. Fully flattening to
e.g. `playlist_save | playlist_load | ...` is a candidate for the same kind
of mechanical sweep `plugin-music/src/actions/music.ts` already did with
its flat-op pattern, but doing it here would require duplicating param
schemas across 4 playlist-op variants. **Medium-confidence punt.**

### Discriminated unions inside subactions — 0 findings

Reading the parameter schemas of every umbrella with a flat subaction enum
turned up no `oneOf` / discriminated-union shapes that imply nested
discriminators. The only schemas with branching are the playlist case
above (now made explicit via `playlistOp`) and the GOOGLE_CALENDAR internal
subaction prompt (an LLM-decided routing rather than a schema-encoded one).

## Summary

| Finding | Count | Action |
|---|---|---|
| Dotted-namespace action names | 1 | flattened (`MESSAGE_HANDOFF`) |
| Two-layer subaction hierarchies | 4 | 2 deleted (`TODO` stub, `CODE` stub), 2 punted (CALENDAR→GOOGLE_CALENDAR, FILE→READ/WRITE/EDIT) |
| Subaction-handler nested dispatch | 1 | flattened discriminator names (`MUSIC_LIBRARY` `subaction` + `playlistOp`); fully-flat enum punted |
| Zod discriminated unions inside subactions | 0 | n/a |

**Total flattened:** 4 high-confidence (handoff rename + CODE delete + TODO
stub delete + MUSIC_LIBRARY rename).
**Total punted:** 3 medium-confidence (CALENDAR→GOOGLE_CALENDAR, FILE
read/write/edit, MUSIC_LIBRARY full-flatten).

## Post-fix (2026-05-10)

Two of the three medium-confidence punts above are now closed. The
MUSIC_LIBRARY full-flatten remains punted (it is the only legitimate
2-discriminator umbrella in the project, and the schemas justify it).

### CALENDAR → GOOGLE_CALENDAR — CLOSED (Option A: flatten)

- **Before:** `calendarAction` declared `subActions: [googleCalendarAction,
  proposeMeetingTimesAction, checkAvailabilityAction,
  updateMeetingPreferencesAction]` plus a `subPlanner` block.
  `googleCalendarAction` (name `GOOGLE_CALENDAR`) had its own internal
  subaction enum that the umbrella's `route()` set via `forwardedOptions`.
  This was a 2-layer dispatch (CALENDAR → GOOGLE_CALENDAR → subaction).
- **After:** `calendarAction` is a flat-subaction umbrella. The `subActions`
  array and `subPlanner` block were removed entirely. The umbrella's
  `parameters[subaction].schema.enum` already lists all 11 verbs (`feed`,
  `next_event`, `search_events`, `create_event`, `update_event`,
  `delete_event`, `trip_window`, `bulk_reschedule`, `check_availability`,
  `propose_times`, `update_preferences`). `promoteSubactionsToActions`
  promotes each verb to a top-level virtual (`CALENDAR_FEED`,
  `CALENDAR_CREATE_EVENT`, `CALENDAR_PROPOSE_TIMES`, etc.). The internal
  `googleCalendarAction`, `proposeMeetingTimesAction`,
  `checkAvailabilityAction`, and `updateMeetingPreferencesAction` stay as
  imported-but-not-registered private dispatch targets — they were never
  in `plugin.actions` to begin with, so the punt rationale's premise
  ("`GOOGLE_CALENDAR` is registered as a stand-alone top-level Action") was
  inaccurate.
- **Rationale (Option A vs B):** All 11 verbs share the same parameter
  envelope (`intent`, `details`, `timeZone`, `query`, etc.) plus a few
  per-verb extras (`durationMinutes`, `slotCount`, `blackoutWindows`).
  Splitting per-backend (Option B) would have duplicated the umbrella
  param schema 11 times for marginal gain. Option A keeps one schema and
  one routing function while still giving the planner a discoverable
  top-level entry per verb via `promoteSubactionsToActions`.
- **Similes preserved:** umbrella similes (`SCHEDULE`, `MEETING`) plus the
  per-virtual similes generated by `promoteSubactionsToActions` (e.g.
  `FEED`, `CREATE_EVENT`, `PROPOSE_TIMES`).

### FILE → READ / WRITE / EDIT — CLOSED (Option B: split)

- **Before:** `fileAction` (name `FILE`) was a thin umbrella with
  `subActions: [readAction, writeAction, editAction]` and a `subPlanner`
  but no real handler logic — it just dispatched to the named child.
  Children had divergent param shapes (`READ`: `file_path` + offset/limit;
  `WRITE`: `file_path` + content; `EDIT`: `file_path` + old/new + replace).
- **After:** `fileAction` was deleted. `readAction`, `writeAction`, and
  `editAction` are registered directly in `codingToolsPlugin.actions`.
  Each keeps its own param shape, no umbrella.
- **Rationale (Option B):** For coding tools, separate top-level Actions
  are conventional (Claude Code itself models Read, Write, Edit as
  separate tools). The umbrella added one extra hop without adding any
  routing or shared state. Option B is simpler and more aligned with
  "max-easy for tool search, tool calling, 1-layer hierarchy".
- **Similes preserved:** `READ` gained `FILE`, `FILE_OPERATION`, and
  `FILE_IO` as similes for one release so cached planner outputs that
  selected `FILE` still resolve. `READ_FILE`, `WRITE_FILE`, `EDIT_FILE`
  similes were already on the per-action definitions.

### Risk note: planner cache invalidation

Both folds change the action surface that the planner sees:

- CALENDAR keeps the same `name: "CALENDAR"` and the same enum, so cached
  tool calls of the form `{name: "CALENDAR", arguments: {subaction:
  "feed", ...}}` continue to route. The new virtuals (`CALENDAR_FEED`,
  etc.) are additive — old cache entries still match the umbrella.
- FILE removes the `name: "FILE"` action. Cached tool calls of the form
  `{name: "FILE", arguments: {...}}` will fail to match a registered
  Action and fall through to the simile resolver. `FILE` is now a simile
  on `READ`, so cached `FILE` calls with READ-shaped params (just
  `file_path`) resolve correctly. Cached `FILE` calls with WRITE- or
  EDIT-shaped params (`content`, `old_string`, etc.) will land on `READ`
  and fail validation — the planner will retry, but with one wasted call
  on first miss. The simile resolver should ideally inspect param shape
  to disambiguate, but a one-release retry penalty is acceptable.
