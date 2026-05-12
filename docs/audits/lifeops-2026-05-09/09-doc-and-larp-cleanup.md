# Doc + LARP Cleanup — 2026-05-09

Status: shipped on `shaw/more-cache-toolcalling`. Changes scoped to `eliza/`
working tree only.

## Workstream A — Doc rectification

### A.1 Ghost docs landed

Three docs that the audit at `01-doc-inventory.md` flagged as missing were
copied from the sibling `eliza-merge-into-develop` tree into the main tree:

- `eliza/packages/docs/prd-lifeops-executive-assistant.md` (32 KB).
- `eliza/packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md`
  (16 KB).
- `eliza/packages/docs/lifeops-production-runbook.md` (5.5 KB).

The PRD's `## Source` block had one absolute path local to the original
author's workspace (`/Users/shawwalters/Desktop/chat-exports/...`); replaced
with a generic description (the new line at
`prd-lifeops-executive-assistant.md:10`). The other two had no
sibling-tree-specific paths.

`eliza/plugins/app-lifeops/coverage-matrix.md:20-21` already pointed at
`packages/docs/{prd-lifeops-executive-assistant,plan-lifeops-executive-assistant-scenario-matrix}.md`
— these are now real paths.

### A.2 Closed P1 + P2 in launchdocs/14-lifeops-qa.md

Both bugs are fixed in source. Marked resolved in
`eliza/packages/docs/docs/launchdocs/14-lifeops-qa.md`:

- **P1 follow-up tracker**: verified at
  `eliza/plugins/app-lifeops/src/plugin.ts:42` (import),
  `:44` (worker registration), `:450` (`registerFollowupTrackerWorker`),
  `:456` (`await ensureFollowupTrackerTask`).
- **P2 OAuth channel mismatch**: verified at
  `eliza/plugins/app-lifeops/src/routes/lifeops-routes.ts:802-813`
  (BroadcastChannel dual-publish to both `elizaos:` and `eliza:` keys) and
  `:817-820` (localStorage dual-write).

The corresponding "Codex-fixable work" entries were also marked done.

### A.3 SUPERSEDED banners on Wave-1 audits

Added `> [!NOTE]` SUPERSEDED banners at the top of:

- `eliza/plugins/app-lifeops/docs/audit/HARDCODING_AUDIT.md`
- `eliza/plugins/app-lifeops/docs/audit/GAP_ASSESSMENT.md`
- `eliza/plugins/app-lifeops/docs/audit/IMPLEMENTATION_PLAN.md`
- `eliza/plugins/app-lifeops/docs/audit/JOURNEY_GAME_THROUGH.md`

Each banner points at this audit corpus' `REPORT.md` for current state.

### A.4 Catalog entry removed

Dropped the `ea.schedule.recurring-relationship-block` entry (was lines
19-41) from
`eliza/plugins/app-lifeops/test/scenarios/_catalogs/executive-assistant-transcript.catalog.json`
because the corresponding `.scenario.ts` file was never landed. Added an
explanatory note in the catalog's `notes` field. Catalog now has 21
scenarios (was 22). JSON validates.

### A.5 Auto-generated REST docs

Wrote `eliza/scripts/generate-lifeops-rest-docs.mjs`. The script parses all
`RouteSpec[]` declarations in
`eliza/plugins/app-lifeops/src/routes/plugin.ts` and the
`SCHEDULED_TASKS_ROUTE_PATHS` export in `scheduled-tasks.ts`, groups them by
domain (Calendar, Gmail, Sleep, Scheduled tasks, Knowledge graph, Connectors
— Telegram, etc.), and emits a Mintlify markdown table per group.

Ran the script. Regenerated `eliza/packages/docs/rest/lifeops.md` with
**188 routes** (up from 17). The frontmatter and a hand-written intro
paragraph are preserved; the body is now a generated index plus a "Notes"
section covering cadence kinds, reminder channels, and where to find handler
shape definitions.

To refresh: `node eliza/scripts/generate-lifeops-rest-docs.mjs`.

## Workstream B — LARP / dead-code deletion

### B.1 Deleted `lifeops-deterministic-llm.ts`

Confirmed zero in-tree consumers of `createLifeOpsDeterministicLlm` (excluding
the helper file itself, `node_modules`, `dist/`, and the `.claude/worktrees/`
worktrees). The two stale references in
`eliza/test/mocks/helpers/provider-coverage.ts` were to a sibling
`.test.ts` that does not exist in the main tree (it lives only in worktrees);
removed both.

Files changed:

- Deleted: `eliza/plugins/app-lifeops/test/helpers/lifeops-deterministic-llm.ts`.
- Edited: `eliza/test/mocks/helpers/provider-coverage.ts:67` and `:95` —
  removed the dangling validation entries.

### B.2 Strengthened 4 LARP scenarios

All four use `judgeTextWithLlm` from
`eliza/plugins/app-lifeops/test/helpers/lifeops-live-judge.ts` (Cerebras
gpt-oss-120b judge, separate model from the agent under test) for content
rubrics where appropriate. The judge `provider` arg was dropped at the call
sites because the helper documents it as ignored, and passing a non-matching
provider type would fail typecheck.

#### `signature-deadline.e2e.test.ts:165-170`

Replaced the `expect(...).toBeGreaterThanOrEqual(0)` no-op with a real
assertion: the agent must EITHER enqueue a `sign_document` approval whose
payload references the NDA, OR draft a reply that the Cerebras judge
confirms (a) flags the deadline / meeting and (b) describes initiating the
signing step. If neither happens, the test fails. (The `it.todo` for
4-hour-before SMS escalation is unchanged — that's still
not-yet-implemented.)

#### `flight-rebook.e2e.test.ts:148-187`

Removed the test-side self-enqueue (was lines 148-187). The test now
asserts: the agent must EITHER enqueue a `book_travel` approval whose
payload references SFO/JFK/flight, OR draft a reply judged by Cerebras to
acknowledge the timing conflict and propose at least one alternative. If
the agent does nothing, the test fails (which is the correct outcome).

#### `assistant-user-journeys.followup-repair.e2e.test.ts:363-378`

Removed the test-side `?? approvalQueue.enqueue(...)` fallback. The test
now requires the agent to enqueue the repair-note approval itself; the
test then approves and dispatches it. Replaced the
`dispatch.text.includes("walkthrough")` hardcoded keyword with a small
regex (`/frontier|walkthrough|missed|reschedul|sorry/`) so the assertion
covers semantically equivalent agent drafts. The downstream
`service.completeFollowUp` call is left unchanged — it tests the
follow-up service, not the agent.

#### `assistant-user-journeys.morning-brief.e2e.test.ts:307-343`

Replaced the `not.toMatch(/something went wrong/i)` reply check + the
`containsAllFragments(digestText, [...])` self-seed assertion with: (1) a
length floor (>120 chars), (2) a Cerebras judge rubric that requires the
brief to reference at least one pending draft, at least one overdue
follow-up, AND visible section structure. The seeded `pendingDraftRequestId`
remaining in the queue and the seeded follow-up still being on the daily
queue are both retained as side checks (the agent should not silently
approve or close them). Removed the now-unused `containsAllFragments`
import.

### B.3 Stale references cleaned

Scanned for stray references to deleted files. Only artifacts found:

- The catalog note we added in A.4 (intentional).
- Historical mentions in audit docs under
  `eliza/plugins/app-lifeops/docs/audit/` and
  `eliza/docs/audits/lifeops-2026-05-09/` (left intact — these are history,
  and the SUPERSEDED banners now point readers at current state).
- Comments in `seed-test-user-profile.ts:10`,
  `client-lifeops.ts:150`, `default-packs/habit-starters.ts:6`,
  `seed-routine-migration/migrator.ts:26` that reference the deleted
  `seed-routines.ts` for context. Left intact — they explain why those
  files exist and they document a real migration boundary.
- `migrate-seed-routines.mjs` is the migration script for users coming from
  legacy data. Still required.

## Verification

- `bun run --cwd eliza/plugins/app-lifeops build:types` — clean (the
  package's typecheck script).
- `bun run --cwd eliza/plugins/app-lifeops lint:default-packs` — `clean — 0
  findings across default packs.`
- `bun x vitest run --config vitest.config.ts test/contracts.test.ts
  test/default-packs.smoke.test.ts test/default-packs.lint.test.ts` from
  inside `eliza/plugins/app-lifeops/` — 39 passed across 3 files.
- `node /Users/shawwalters/milaidy/eliza/scripts/generate-lifeops-rest-docs.mjs`
  — `Wrote rest/lifeops.md with 188 routes.`
- The 4 strengthened LARP tests are gated by `ELIZA_LIVE_TEST=1` + provider
  key (unchanged); they still skip in default CI but are no longer LARP
  when the gate is set.

## What's NOT in this batch

- **REST doc enrichment per route**: the generator produces an indexed
  table only. Per-route request/response schemas are still TBD; readers are
  pointed at the handler files. Future work: extend the generator to parse
  the Zod schemas at the top of each handler module.
- **W2-A: legacy `seed-routines` migration alias deletion** — deferred per
  IMPLEMENTATION_PLAN.md.
- **Coverage gap fixes** — the LARP audit's "Coverage Cliff — categories
  with 0 SOLID end-to-end coverage" matrix at
  `02-scenario-larp-audit.md:289-314` is still live; this batch only
  strengthened the 4 named scenarios.
- **`UX_JOURNEYS.md` doc updates** (RELATIONSHIP→ENTITY rename, CHECKIN
  removal, suite-anchor cleanup) — still pending; they are doc-only edits
  the audit at `01-doc-inventory.md §H, §C, §G` describes in detail.
