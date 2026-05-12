# Focus benchmark deep-dive (W5-foc)

Sub-agent: **W5-foc**. Read-only. No push. Companion to the calendar/messages
deep-dives. Scope: app + website blocking (BLOCK umbrella), focus-block
calendar overlap, vacation pause, device-intent broadcast, REMOTE_DESKTOP /
wipe overlap, friend allowlists, permission gates.

## 1. Surfaces — what the focus domain actually maps to today

### 1.1 BLOCK umbrella (live, registered)

- **Definition:** `plugins/app-lifeops/src/actions/block.ts` — single umbrella
  action that folds the legacy `APP_BLOCK` (phone apps, Family Controls /
  Usage Access) and `WEBSITE_BLOCK` (hosts file / SelfControl) actions into
  one action keyed by `target: "app" | "website"`. Subactions:
  - `app` accepts: `block`, `unblock`, `status`.
  - `website` accepts: `block`, `unblock`, `status`, `request_permission`,
    `release`, `list_active`.
- **Registration:** `plugins/app-lifeops/src/plugin.ts:631` —
  `...promoteSubactionsToActions(blockAction)`. This is what makes the
  granular siblings `BLOCK_BLOCK`, `BLOCK_UNBLOCK`, `BLOCK_LIST_ACTIVE`,
  `BLOCK_RELEASE`, `BLOCK_REQUEST_PERMISSION`, `BLOCK_STATUS` available to the
  planner as separate top-level entries.
- **Target inference** (block.ts:96–197): the resolver checks four signals in
  order — explicit `target`, param shape (`packageNames`/`appTokens` →
  `app`; `hostnames`/`ruleId`/`includeLiveStatus`/`includeManagedRules` →
  `website`), subaction-driven inference (`request_permission`/`release`/
  `list_active` → `website`-only), then a regex over message text
  (`/\bphone apps?\b/`, `/\bx\.com\b/`, etc.). Missing both explicit and
  inferable signals returns `MISSING_TARGET` with no fallback to a default.
- **Owner gate:** `appBlockValidate` and `websiteBlockValidate` both call
  `getAppBlockerAccess` / equivalent. Either gate passing is sufficient
  (`validate: appOk || webOk`) — handler-level then re-checks the gate for
  the chosen target. Backed by `plugins/app-lifeops/src/app-blocker/
  access.ts`, which combines `hasOwnerAccess(runtime, message)` and
  `checkSenderRole(...)`. Non-owners get
  `"App blocking is restricted to OWNER users."`.

### 1.2 LIST_ACTIVE_BLOCKS + RELEASE_BLOCK — orphaned standalone actions

- **Files:**
  `plugins/app-lifeops/src/website-blocker/chat-integration/actions/listActiveBlocks.ts:53`
  and `releaseBlock.ts:108` export `listActiveBlocksAction` and
  `releaseBlockAction` with `name: "LIST_ACTIVE_BLOCKS"` /
  `name: "RELEASE_BLOCK"`. They have full similes / context gates / parameter
  schemas.
- **Registration status:** **neither is imported anywhere in
  `plugins/app-lifeops/src` outside their own file** (verified via
  `git grep listActiveBlocksAction releaseBlockAction` — only the two
  definition-site lines match). They are not in `plugin.ts:actions`.
- **Action manifest impact:** since these aren't registered with the runtime,
  they don't appear in the live tool list. The bench manifest at
  `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`
  exposes `BLOCK_LIST_ACTIVE` and `BLOCK_RELEASE` (the umbrella-promoted
  siblings) as the canonical entries. There is overlap by name —
  `RELEASE_BLOCK` (dead) vs `BLOCK_RELEASE` (live promoted-subaction). The
  bench prompts the planner with `BLOCK_RELEASE`, so the orphan never gets a
  chance to mis-route the planner today, but the prompt-side artifacts at
  `docs/audits/lifeops-2026-05-11/prompts/action.RELEASE_BLOCK@…` are
  generated against the orphan source — the existence of these prompts is a
  trace bug, not a runtime bug.
- **Recommendation (out of W5 scope):** delete the two orphan Action exports
  to remove the silent name collision and remove the stale prompt artifacts.
  The umbrella's `subaction: list_active` and `subaction: release` cover
  every real call path.

### 1.3 Action description post W4-D fix

- **Before:** `block.ts:description` led with the merged-surface enumeration;
  the legacy `FOCUS_BLOCK` / `TIME_BLOCK` simile family was already stripped
  in earlier work. `smoke_static_calendar_01` still mis-routed.
- **After (W4-D, commit `d01f762c6` audit; underlying edit landed in
  `wave-5b/6ef80720a9`):** description now opens with
  `"Block or unblock specific phone apps (Family Controls / Usage Access)
  and desktop websites (hosts file / SelfControl). Scope: phone apps and
  websites only. NOT for blocking out time on the calendar / focus blocks /
  deep-work blocks / carving out hours — those route to CALENDAR
  (subaction=create_event). ..."`.
- **Compressed (`descriptionCompressed`) shown to the planner via
  `actionToTool → preferCompressedParamDescription`:**
  `"block/unblock phone apps + desktop websites only (NOT calendar
  time-blocks/focus-blocks — those go to CALENDAR create_event); actions
  block|unblock|status|request_permission|release|list_active; web
  requires confirmed:true"`.
- **CALENDAR side:** `plugins/app-lifeops/src/actions/calendar.ts:567-573`
  carries the time-block similes that pair with the scope-correction
  language above — `BLOCK_TIME`, `CREATE_TIME_BLOCK`, `TIME_BLOCK`,
  `DEEP_WORK_BLOCK`, `FOCUS_BLOCK`, `BLOCK_OUT`, `BLOCK_OUT_TIME`. So the
  planner is pointed both away from BLOCK and toward CALENDAR for the same
  set of phrasings.

## 2. Scenario / corpus inventory

### 2.1 Python LifeOpsBench focus suite

`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/focus.py` —
**38 STATIC scenarios** (verified via
`python3 -m eliza_lifeops_bench --list | grep -c '^  focus\.'`).

| Bucket                           | Ground-truth action      | Count |
|----------------------------------|--------------------------|------:|
| website block (hostnames)        | `BLOCK_BLOCK`            |    18 |
| app block (packageNames)         | `BLOCK_BLOCK`            |     9 |
| mixed (hostnames+packageNames)   | `BLOCK_BLOCK`            |     2 |
| unblock                          | `BLOCK_UNBLOCK`          |     4 |
| release                          | `BLOCK_RELEASE`          |     1 |
| request_permission               | `BLOCK_REQUEST_PERMISSION` | 1 |
| list_active                      | `BLOCK_LIST_ACTIVE`      |     1 |
| focus block on the calendar      | `CALENDAR.create_event`  |     1 |
| **TOTAL**                        |                          |    38 |

Personas span freelancer / student / parent / consultant / PM / founder /
night-owl / ops, so register breadth is adequate.

`focus.py:1-13` (module docstring) explicitly notes the Wave 4A collapse of
the legacy granular names into the BLOCK_* family. The corpus author
intentionally keeps `focus.schedule_morning_focus_block_tomorrow` mapped to
`CALENDAR.create_event` as a foil — this is the precise routing question
sharpened by W4-D.

### 2.2 TS lifeops.controls scenarios (gap-closure scenarios)

- `test/scenarios/lifeops.controls/lifeops.device-intent.broadcast-reminder.scenario.ts`
  — expects the planner to call `DEVICE_INTENT` with `target=mobile` on
  `"Broadcast a reminder to my phone titled 'Stretch'..."`.
- `test/scenarios/lifeops.controls/lifeops.pause.vacation-window.scenario.ts`
  — expects the planner to call `LIFEOPS` with `verb=pause` on
  `"Pause everything until next Sunday — I'm on vacation."`.

**Critical finding:** **neither `LIFEOPS` nor `DEVICE_INTENT` is a registered
action in the runtime today.**

- `git grep` shows no `actions/device-intent.ts` and no `actions/
  lifeops-pause.ts` in `plugins/app-lifeops/src/actions`. Earlier audits
  (`docs/audits/action-inventory-2026-05-09.md`,
  `plugins/app-lifeops/docs/audit/action-hierarchy-final-audit.md`) list
  both files, but they're absent from the current `git ls-files
  plugins/app-lifeops/src/actions/`.
- The pause window state machine itself is alive
  (`plugins/app-lifeops/src/lifeops/global-pause/store.ts` — `GlobalPauseStore`
  is real, queried by `scheduled-task/runtime-wiring.ts:376`, and respected by
  the scheduler `respectsGlobalPause: true`). The user-facing action that
  *sets* a window is the missing piece.
- Result: both scenarios will reliably fail when actually executed — the
  planner has no `LIFEOPS` / `DEVICE_INTENT` tool in its action list, so the
  `acceptedActions` assertTurn predicate cannot match. The
  `lifeops.controls` directory is currently aspirational coverage for
  surfaces the audit dossier called out as ACTION GAPS but which haven't been
  re-implemented.

### 2.3 Saved run coverage for focus

Filter `^focus\.` across every JSON under `~/.milady/runs/lifeops/**/*.json`:

```
hits = 0 across 60+ run directories.
```

No multi-agent baseline run has executed the focus domain. The W2-9 and
W4-D runs both ran the calendar slice. The W4-D smoke
(`lifeops-multiagent-1778549433787`) ran 5 calendar scenarios only —
specifically including `smoke_static_calendar_01` (the BLOCK vs CALENDAR
foil), which is calendar-domain not focus-domain.

The W2-9 rebaseline-report.md "Real action gaps" section already flagged
the BLOCK confusion on `smoke_static_calendar_01`; W4-D verified the fix on
the same scenario. Neither pass touched any actual `focus.*` scenario.

## 3. Smoke runs (this audit)

Per W5 constraint — saved-run data for focus is empty, so two small smokes
were run.

### 3.1 Openclaw — 5 focus scenarios, post-W4-D

```
agent      = openclaw (Cerebras gpt-oss-120b, in-process)
domain     = focus, mode = static, limit = 5
output     = /tmp/w5-foc-smoke/lifeops_gpt-oss-120b_20260511_201906.json
pass@1     = 0.800, mean score (focus) = 0.800, total cost = $0.014
```

| scenario_id | score | actions emitted |
|---|---:|---|
| `focus.block_distracting_apps_25min` | 1.00 | `BLOCK_BLOCK{app:'twitter',duration_minutes:25}`, `BLOCK_BLOCK{app:'instagram',duration_minutes:25}` |
| `focus.block_distracting_websites_2hr` | 1.00 | `BLOCK_BLOCK{apps:[hackernews.com,reddit.com],duration_minutes:120}`, `BLOCK_REQUEST_PERMISSION{...}`, `BLOCK_LIST_ACTIVE{}`, `BLOCK{...}` |
| `focus.list_active_blocks` | 1.00 | `BLOCK_LIST_ACTIVE{}` |
| `focus.schedule_morning_focus_block_tomorrow` | 0.00 | none (terminated `respond`, model emitted prose only) |
| `focus.block_social_media_30min` | 1.00 | `BLOCK_BLOCK{apps:[facebook,snapchat],duration_minutes:30}` |

### 3.2 Hermes — 5 focus scenarios, post-W4-D

```
agent      = hermes (Cerebras gpt-oss-120b, in-process)
domain     = focus, mode = static, limit = 5
output     = /tmp/w5-foc-hermes/lifeops_gpt-oss-120b_20260511_201955.json
pass@1     = 0.000, mean score (focus) = 0.060
```

| scenario_id | score | actions emitted |
|---|---:|---|
| `focus.block_distracting_apps_25min` | 0.00 | `BLOCK{apps:[twitter.com,instagram.com],duration_minutes:25}` |
| `focus.block_distracting_websites_2hr` | 0.00 | 5× `BLOCK{...}` until `max_turns` |
| `focus.list_active_blocks` | 0.00 | 4× `BLOCK{}` until `max_turns` |
| `focus.schedule_morning_focus_block_tomorrow` | 0.30 | `CALENDAR{subaction:create_event,title:'Focus Block',start,end,calendar:'work'}` |
| `focus.block_social_media_30min` | 0.00 | `BLOCK{apps:[facebook,snapchat],duration_minutes:30}` |

### 3.3 What the smokes actually say

1. **Routing post W4-D is correct on the calendar foil.** Hermes routed
   `focus.schedule_morning_focus_block_tomorrow` to `CALENDAR.create_event`
   (not BLOCK) and scored 0.30 — the residual is wire-shape (`calendar:
   "work"` rather than `details.calendarId: cal_work`) and matches Bug B in
   `planner-disambiguation-fix.md`. Openclaw skipped the action entirely
   (terminated `respond` after one turn of model self-talk). This is an
   openclaw tool-emission failure mode, not a routing failure.

2. **Openclaw's 0.800 is a scorer artefact, not a real pass.** Inspecting
   the `_u_block` handler in `eliza_lifeops_bench/runner.py:962-974` —
   "Focus-block sessions are not yet modeled in LifeWorld — every BLOCK_*
   is a read-only no-op for state-hash purposes." So both ground-truth and
   agent leave LifeWorld unchanged → `state_hash_match = True` → the
   action-component drops to 0 (kwargs don't match) but the state component
   pays 0.4 and the substring component pays 0.4. The 1.0 scores happen
   when the substring check (`"block"`, `"25"`, `"facebook"`, etc.) also
   passes. **None of the openclaw kwargs in the 1.0-scoring runs match the
   GT shape** — `apps` instead of `hostnames`/`packageNames`,
   `duration_minutes` instead of `durationMinutes`, no `subaction` field at
   all on `BLOCK_BLOCK`. The pass is meaningless beyond "the model named the
   right verb".

3. **Hermes routes to the canonical `BLOCK` (not granular `BLOCK_BLOCK`).**
   `BLOCK` is registered, but ground truth scenarios pin the granular
   sibling. The scorer requires exact `action.name` match — same judge bug
   #1 from `rebaseline-report.md` (granular vs umbrella). State-hash still
   matches because of the no-op handler, but the action-name mismatch zeros
   the action component and the triviality guard double-penalizes →
   action.name mismatch on a write-shaped scenario yields a hard 0. **This
   is a scorer/canonicalization gap, not an agent gap** — hermes' tool
   selection is semantically correct.

4. **kwargs canonicalization is the bigger latent problem.** Both agents
   freely invent `apps`, `duration_minutes`, `duration:'2h'`, `sites`,
   `calendar:'work'`. Manifest descriptions are not making the
   `hostnames`/`packageNames`/`durationMinutes`/`details.calendarId`
   distinction stick. W4-D fixed the title/details-shape rule for CALENDAR;
   the parallel BLOCK rule isn't called out as strongly. **The BLOCK action
   parameter descriptions are correct** (block.ts:341-419 lists
   `hostnames`, `packageNames`, `durationMinutes` with target-scoped
   guidance), but the planner is ignoring the schema's casing and
   field-name conventions under both Hermes-template and OpenClaw
   parser paths.

## 4. Routing — BLOCK vs CALENDAR (W4-D verification)

W4-D's `planner-disambiguation-fix.md` reports Bug A fixed in the calendar
foil. Cross-checking from the focus side:

- `focus.schedule_morning_focus_block_tomorrow` is the focus suite's calendar
  foil. Post-fix:
  - Hermes routed to `CALENDAR.create_event` correctly (smoke 3.2).
  - Openclaw emitted no action (model self-talk, smoke 3.1). Not BLOCK
    either — so no regression, but also no positive evidence of correct
    routing.
- `smoke_static_calendar_01` (calendar suite) post-fix routes to
  `CALENDAR_CREATE_EVENT` on eliza (W4-D run
  `lifeops-multiagent-1778549433787`). Confirmed via inspecting the saved
  JSON — eliza emits a mix of `CALENDAR_CREATE_EVENT` / `CALENDAR` /
  `REPLY` across turns, **no BLOCK at all**. Score 0.30 (residual is
  time-fields-nested-in-details shape, not routing).

**Verdict:** Bug A regression risk is low. BLOCK and CALENDAR both have
explicit scope language. The next regression vector is the calendar-side
shape (W4-D Bug B) — already known and out of W5-foc scope.

## 5. Friend allowlists

`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_authoring/
spec.md:30` describes domain coverage. For `focus` it has:

| Strong support           | Weak support           |
|--------------------------|------------------------|
| app + website blocks     | per-friend allowlists  |

`spec_live.md:30` says `focus | block-design across goals, app-allowlist
judgment, exception flow`.

**Implementation status:** there is no friend-scoped allowlist in the
focus surfaces. Verified by `git grep`:

- `autofill-whitelist.ts` is a credential-domain feature (a list of brand
  domains exempted from the autofill safety check). It is not
  per-friend, and it does not feed BLOCK.
- `cross-channel-search.ts` carries a `channel allowlist` for owner
  message search, not for block rules.
- No code under `app-blocker/` or `website-blocker/` references `friend`,
  `allowlist`, `whitelist`, or per-contact bypass rules.

The "weak support" call-out in the spec is accurate — the corpus author
explicitly told scenario generators **not** to write friend-allowlist
focus scenarios, and none exist in `focus.py`. Implementing per-friend
allowlists would require new state (a contact-scoped block-exception
table, joined to `EntityStore`), a new BLOCK subaction (`add_exception` /
`list_exceptions`?), and a new evaluation path during block enforcement
(`isHostNameBlocked(host, callerContactId)`). None of that exists today.

**Recommendation:** keep the call-out as "weak support" and leave the
scenarios out of corpus. Premature implementation here would invent
product surface area not explicitly requested in any other audit
deliverable.

## 6. Vacation pause window

State surface (live): `plugins/app-lifeops/src/lifeops/global-pause/store.ts`.

- `GlobalPauseStore.set/clear/current` — one pause window at a time,
  optional `endIso`, optional `reason`. Single canonical cache key
  `eliza:lifeops:global-pause:v1`.
- `current()` returns `{ active, startIso, endIso, reason }`. The
  `scheduled-task` runner consults `current()` pre-fire and skips tasks
  with `respectsGlobalPause: true` (see
  `lifeops/scheduled-task/types.ts:355`). Skipped tasks are rescheduled
  for `endIso` when set.
- **No action sets it.** `git grep "globalPauseStore.set\|globalPauseStore.clear\|name: \"LIFEOPS\""`
  returns no hits in `plugins/app-lifeops/src/actions/`. The store is
  exported via `plugin.ts:1003` (`createGlobalPauseStore`) and constructed
  by `runtime-wiring.ts:376` for the scheduler, but no user-facing planner
  tool wraps it.
- The historical `actions/lifeops-pause.ts` (`LIFEOPS` action with verbs
  `pause`, `resume`, `wipe`) referenced by
  `plugins/app-lifeops/docs/audit/action-hierarchy-final-audit.md:25` and
  `IMPLEMENTATION_PLAN.md:232` is **not in the current source tree**. The
  TS scenario `lifeops.pause.vacation-window.scenario.ts` expects it.

**Impact:** the scheduler will honor a global pause window if one is set
(e.g. via direct cache write or a future action), but the only path to set
one through chat is via a custom-coded helper outside the action layer.
Saying "pause everything until next Sunday" today routes to no action —
the planner has no `LIFEOPS` verb to pick.

**Recommendation (out of W5 scope, but flagged):** re-implement the
`LIFEOPS` action wrapper around `GlobalPauseStore` to close the
`lifeops.pause.vacation-window` gap. This is the action that the audit
dossier called for but which was removed from src without removing the
scenario.

## 7. Device-intent broadcast

State surface: `plugins/app-lifeops/docs/audit/HARDCODING_AUDIT.md:237`
documented `actions/device-intent.ts` (199 LOC). Same status as
`lifeops-pause.ts`:

- `git ls-files plugins/app-lifeops/src/actions/ | grep -i device` → empty.
- `git grep DEVICE_INTENT plugins/app-lifeops/src` → no source matches
  (only doc references).
- `test/scenarios/lifeops.controls/lifeops.device-intent.broadcast-reminder.scenario.ts`
  references it.
- `actions.manifest.json` does **not** list `DEVICE_INTENT`.

**Impact:** `"Broadcast a reminder to my phone titled 'Stretch'..."` cannot
route to any current action. The scenario is dead until the action is
re-implemented or the scenario is rewritten to target an existing surface
(e.g. `OWNER_REMINDERS_CREATE` + a phone-targeted `details.deliverVia`
field, if that wire exists).

## 8. Wipe with confirmation token vs REMOTE_DESKTOP

The W5 brief calls out REMOTE_DESKTOP overlap with `wipe` (the third verb
in the historical `LIFEOPS{verb:pause|resume|wipe}` plan).

- **REMOTE_DESKTOP** (`plugins/app-lifeops/src/actions/remote-desktop.ts`):
  registered, owner-gated, subactions `start | status | end | list |
  revoke`. `start` requires `confirmed: true` AND, in cloud mode, a
  6-digit pairing code (`block` validate at line ~94). It does **not**
  have a `wipe` subaction.
- **`wipe`** (data-destructive, sensitive) is not implemented anywhere in
  `plugins/app-lifeops/src/actions`. The original plan put it on
  `LIFEOPS{verb:wipe}` with a confirmation token. That plan is unrealized.
- **Overlap risk** with the current state: zero. There is no path that can
  route a "wipe" intent to REMOTE_DESKTOP — the action's subactions enum
  doesn't accept it, the description doesn't mention destruction, and the
  similes list (`REMOTE_SESSION`, `VNC_SESSION`, `REMOTE_CONTROL`,
  `PHONE_REMOTE_ACCESS`, `CONNECT_FROM_PHONE`) doesn't include any
  destruction phrasing.

**Verdict:** no current ambiguity. If `LIFEOPS{verb:wipe}` is ever
re-added, the design must carry a confirmation token distinct from
`confirmed:true` to avoid accidental triggers; REMOTE_DESKTOP's
`confirmed:true` only protects session-start, which is a comparatively
benign side effect (opens a VNC session) vs a wipe.

## 9. Permission gates summary

| Subaction (target) | Gate |
|---|---|
| `BLOCK{target:app}` | `appBlockValidate` → `getAppBlockerAccess` → owner-only |
| `BLOCK{target:website,*}` | `websiteBlockValidate` → owner-only |
| website `request_permission` | runs through the same owner gate, then proxies to host OS prompt (SelfControl / hosts file) |
| website `release` | `confirmed: true` required at parameter layer |
| website `block` | `confirmed: true` required when writing (drafts first otherwise) |
| `LIST_ACTIVE_BLOCKS` (orphan) | role gate via `roleGate: minRole OWNER` (per file inspection); dead path |
| `RELEASE_BLOCK` (orphan) | dead path |
| REMOTE_DESKTOP `start` | `confirmed: true` + pairing code |

No regression vs previous waves — gates are unchanged. The owner-gate path
is consistent. No bypass found.

## 10. Critical findings (ranked)

### 10.1 High confidence

1. **`LIST_ACTIVE_BLOCKS` and `RELEASE_BLOCK` are orphaned actions.**
   `listActiveBlocksAction` and `releaseBlockAction` are defined in
   `plugins/app-lifeops/src/website-blocker/chat-integration/actions/`, exported,
   referenced nowhere in src. The umbrella `BLOCK{subaction: list_active|
   release}` (auto-promoted to `BLOCK_LIST_ACTIVE` / `BLOCK_RELEASE`) is the
   live path. Delete the orphans and stale prompt files
   (`docs/audits/lifeops-2026-05-11/prompts/action.RELEASE_BLOCK@...`).

2. **`lifeops.controls/*.scenario.ts` reference deleted actions.** Both
   `LIFEOPS` (pause) and `DEVICE_INTENT` (broadcast) actions are absent
   from the current source tree but the TS scenarios still pin them.
   These scenarios will hard-fail when run, not because of planner bugs
   but because the actions don't exist. Either re-implement the actions
   or delete the scenarios.

3. **Focus domain has zero saved-run coverage.** Across 60+ run directories
   under `~/.milady/runs/lifeops/`, no JSON contains a `focus.*` scenario.
   Every multi-agent baseline (W2-9 / W4-D) ran the calendar slice. We are
   shipping action changes (block.ts description, calendar similes) with
   no representative focus benchmark history.

4. **State-hash-match scoring inflates focus scores.** `_u_block` is a
   no-op handler in LifeWorld — state_hash is always True regardless of
   what the agent did. The smoke run shows openclaw passing 4/5 at 1.00
   even though every kwarg is wrong shape (`apps`, `duration_minutes`,
   `duration:'2h'`). The bench cannot distinguish a correct BLOCK call
   from a malformed one. Modeling focus-block sessions in LifeWorld (or
   wiring kwarg-shape into the scorer) would surface real failures.

5. **BLOCK kwargs canonicalization is weak under both adapters.**
   `hostnames` / `packageNames` / `durationMinutes` are clearly documented
   in the manifest, but planners emit `apps` / `sites` / `duration_minutes`
   / `duration:'2h'` instead. W4-D fixed the title/details rule for
   CALENDAR; an analogous "hostnames is flat; durationMinutes is camelCase
   integer" rule on the BLOCK descriptionCompressed would likely help.

### 10.2 Medium confidence

6. **Hermes routes to umbrella `BLOCK` instead of granular `BLOCK_BLOCK`.**
   Both forms are registered (umbrella + promoted siblings). The bench's
   ground-truth uses the granular form. Until the scorer canonicalizes
   `BLOCK_BLOCK ↔ BLOCK{subaction:block}` (judge bug #1 in
   rebaseline-report.md), Hermes will score 0 on every BLOCK_* scenario
   even when its intent is correct. **Scorer fix, not agent fix.**

7. **`focus.schedule_morning_focus_block_tomorrow` is the only focus
   scenario testing the BLOCK-vs-CALENDAR routing call.** A single
   discrimination test is thin — more focus-domain scenarios should be
   foils (e.g. "schedule a 90-minute deep-work block on Friday" → CALENDAR
   not BLOCK) so the routing is exercised at corpus scale.

### 10.3 Low confidence

8. **Friend allowlists are correctly out-of-scope.** Don't implement until
   asked. The "weak support" classification in `spec.md` is accurate and
   matches CLAUDE.md scope-discipline rule.

9. **Wipe / confirmation-token surface is currently absent and not
   needed.** Re-introducing requires careful confirmation-token design
   that is distinct from REMOTE_DESKTOP's `confirmed:true`.

## 11. Verification

| Check | Result |
|---|---|
| `block.ts` description and similes match W4-D | yes — block.ts:262-294 |
| Promoted BLOCK_* siblings registered | yes — plugin.ts:631 via `promoteSubactionsToActions` |
| `_authoring/spec.md` lists per-friend allowlists as weak | yes — line 30 |
| `LIST_ACTIVE_BLOCKS`/`RELEASE_BLOCK` not registered | confirmed via `git grep` |
| `LIFEOPS`/`DEVICE_INTENT` actions absent from src | confirmed via `git ls-files` |
| `GlobalPauseStore` is live | yes — store.ts present, wired into scheduler |
| Smoke openclaw 5×focus pass@1 | 0.800 (artifact, see 3.3) |
| Smoke hermes 5×focus pass@1 | 0.000 (scorer/canonicalization, see 3.3) |
| W4-D fix unbroken on focus calendar foil | yes — `focus.schedule_morning_focus_block_tomorrow` did not regress; agent emitted CALENDAR or no action, never BLOCK |
| Total tool calls in this audit | ≤60 |

## 12. Run artifacts

- `/tmp/w5-foc-smoke/lifeops_gpt-oss-120b_20260511_201906.json` —
  openclaw × 5 focus, $0.014, pass@1 0.800.
- `/tmp/w5-foc-hermes/lifeops_gpt-oss-120b_20260511_201955.json` —
  hermes × 5 focus, $0.0093, pass@1 0.000.
- Both written outside repo per scratch-path conventions.

## 13. Wave-handoff notes

- **W6/W7 (if scorer ownership):** canonicalize granular ↔ umbrella name
  pairs (`BLOCK_BLOCK ↔ BLOCK{subaction:block}`, every BLOCK_* sibling)
  before action-name match in `compare_actions`. Same fix unblocks hermes
  + openclaw on every focus scenario.
- **W6/W7 (if scenario corpus ownership):** mark kwargs that bench treats
  as load-bearing vs cosmetic. `intent` is correctly soft today (see
  judge bug #2). Same treatment for `confirmed` on `BLOCK_BLOCK` when
  `target=app` (the app target doesn't require it, only website does).
- **W6/W7 (if runtime ownership):** restore `actions/lifeops-pause.ts` and
  `actions/device-intent.ts` (or delete the orphan
  `test/scenarios/lifeops.controls/` scenarios). Don't leave the
  schroedinger state — both audits and corpus pretend they exist.
- **W6/W7 (if LifeWorld ownership):** add a minimal focus-block model
  (set of active rule ids, with `release()` and `list_active()`)
  so `_u_block` can mutate state and the scorer can distinguish correct
  from malformed BLOCK calls.
