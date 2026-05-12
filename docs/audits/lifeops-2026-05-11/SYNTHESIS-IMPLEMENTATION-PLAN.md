# Lifeops + Personality Benchmark Synthesis — Implementation Plan

> Author: sub-agent **W5-syn**. Read-only on code. Branch `develop`.
> Sources: the 15 deep-dive reports under
> `/Users/shawwalters/milaidy/eliza/docs/audits/lifeops-2026-05-11/benchmark-deep-dive-*.md`
> covering all 10 lifeops domains + 5 personality buckets.
>
> This document is the unified roadmap derived from those 15 audits. It is
> organized by cross-cutting architectural theme, not by domain. Each
> recommendation cites the deep-dive source(s) and specific file paths so
> the work can be picked up without re-reading the corpus.

---

## Section 1 — Executive summary

### 1.1 Headline numbers (rolled up from the 15 deep-dives)

| Slice | Source run | eliza | hermes | openclaw | eliza-runtime |
|---|---|---:|---:|---:|---:|
| Calendar (25 STATIC) | `lifeops-multiagent-best/` | 0.518 mean / 1 pass | 0.480 / 1 | 0.505 / 1 | — |
| Mail (25 STATIC) | `lifeops-*-baseline-*` (pre W1-9) | **0.000** / 0 | 0.494 / 0 | 0.562 / 0 | — |
| Messages (5 STATIC smoke) | `messages-w5-*` | — | 0.660 / 0 | 0.680 / 2 | — |
| Contacts | no on-disk run for the corpus | — | — | — | — |
| Reminders (1 STATIC) | `lifeops-multi-tier-2026-05-12/` | 0.30 | 0.00 | 0.30 | — |
| Finance | no on-disk run | — | — | — | — |
| Travel | no on-disk run | — | — | — | — |
| Health | no on-disk run | — | — | — | — |
| Sleep | no on-disk run | — | — | — | — |
| Focus (5 STATIC smoke) | `/tmp/w5-foc-*` | — | 0.060 / 0 | 0.800* / 4 | — |
| Personality `shut_up` (5 aggressive) | `personality-multiagent-best/` | 4P/0F/1NR | 2P/2F/1NR | 3P/1F/1NR | 4P/0F/1NR |
| Personality `hold_style` (5 aggressive) | same | 3P/1F/1NR | 2P/2F/1NR | 2P/2F/1NR | 3P/1F/1NR |
| Personality `note_trait_unrelated` (5) | same | 2P/0F/3NR | 3P/0F/2NR | 4P/0F/1NR | 2P/0F/3NR |
| Personality `escalation` (5) | same | 1P/2F/2NR | 1P/2F/2NR | 1P/2F/2NR | 2P/1F/2NR |
| Personality `scope_global_vs_user` (5) | same | 5P/0F/0NR | 5P/0F/0NR | 5P/0F/0NR | 5P/0F/0NR |

\* Focus openclaw 0.800 is a scorer artefact, not a real pass. See theme 2.

**Coverage gap**: 7 of 10 lifeops domains have **no saved run on disk**.
Only calendar, mail, and reminders have multi-agent baselines, and the
mail baseline predates W1-9. Every quantitative claim about these
domains in prior summaries is structurally unverifiable until the
domains are run.

### 1.2 The 5 highest-leverage fixes (ranked by impact-per-effort)

1. **Extend `scorer._UMBRELLA_SUBACTIONS` to cover every umbrella, not just CALENDAR + MESSAGE.**
   File: `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scorer.py:89-120`.
   Add `LIFE`, `HEALTH`, `BOOK_TRAVEL`, `BLOCK`, `ENTITY`, `MONEY`,
   `SCHEDULED_TASK(S)` and alias `OWNER_*` prefixes. This single change
   unblocks hermes/openclaw on focus, sleep, reminders, health, finance,
   contacts, travel — between **+0.10 and +0.30 mean lift per affected
   domain** with zero model change. Effort: ~50 LoC.

2. **Stop read-only `_u_*` ops from gifting `state_hash_match=true`.**
   Files: `runner.py:_u_message:532-539`, `_u_health`, `_u_block`,
   `_u_money_readonly`, plus most read paths in `_u_calendar`,
   `_u_entity`. Read-only ops currently return `{ok:true,noop:true}`
   without mutating LifeWorld, so 60-83% of corpora trivially pass the
   0.5×state component. Either (a) track a `read_marker` /
   `last_read_at` so wrong-target reads diverge, or (b) re-weight the
   scorer for read-only scenarios so the substring + action-score axes
   carry the full signal. This is the dominant reason every domain has a
   high score-floor that hides real bugs.

3. **Fix the personality scenario → judge `styleKey`/`traitKey` bridge.**
   File: `scripts/personality-bench-run.mjs:209-235`. W4-G shipped
   `checkLimerick`, `checkShakespearean`, `checkSecondPersonOnly`,
   `checkFirstNameOnly`, `checkMetricUnits`, `checkPrefersShort` but the
   bridge `STYLE_KEY_TO_STYLE` / `TRAIT_KEY_TO_OPTIONS` doesn't forward
   them, so 15/40 hold_style + 12/40 note_trait_unrelated scenarios fall
   to "unknown style/trait" NEEDS_REVIEW. Add 6 lines, unblock 27/120
   scenarios. Effort: 10 LoC.

4. **Repair the LLM-judge JSON-parse failure on personality buckets.**
   17-19 of 20 verdicts on shut_up / hold_style / escalation /
   note_trait_unrelated log "did not return parseable JSON". This nukes
   the LLM-judge layer entirely, leaving the phrase layer (which is
   often unreachable due to fix #3) as the only signal. Add
   `response_format: {type: "json_object"}` to the OpenAI-compatible
   judge request or wrap with a JSON-tolerant parser. File:
   `packages/benchmarks/personality-bench/src/judge/checks/llm-judge.ts`
   and `judge/index.ts:38-39` (`passes=2`). Effort: 20 LoC.

5. **Resolve manifest source-of-truth disagreements per umbrella.**
   Most domains have 3-4 disagreeing schemas (e.g. travel `passengers`:
   manifest=number / Python=`[{type:adult}]` / TS=`[{givenName,…}]`;
   finance MONEY verbs: 13 similes vs 9 tool descriptions vs 12 OWNER_*
   manifest entries; health subactions: TS=today/trend/by_metric/status
   vs runner+manifest=by_metric/summary/trends; passenger date range
   `'2026-05-20/2026-05-25'` vs runtime regex `^\d{4}-\d{2}-\d{2}$`).
   Adopt one canonical shape per domain, regenerate the other two from
   it. Without this, agents cannot win these domains regardless of
   capability. Effort: M, but unblocks every cross-stack run.

### 1.3 Single most important architectural observation

**The benchmark scoring formula `0.5×state_hash + 0.4×action_score + 0.1×substring`
combined with no-op read backends means most failures are invisible and
most successes are inflated. Every domain has a structural false-floor
that hides real bugs.**

Concretely: in mail / messages / health / focus / sleep / reminders /
finance / calendar, read-only scenarios are 45-80% of the corpus, and
the no-op `_u_*` handlers preserve the world state. A do-nothing agent
that happens to emit the right umbrella action gets 0.5 (state) + 0.5×0.4
(name-only) + 0 = 0.7 free. An agent that picks the WRONG action gets 0
via the triviality guard — but an agent that picks the right action with
nonsense kwargs gets 0.7 even when it accomplishes nothing.

Meanwhile, write-ops are the only scenarios that test real capability
(state_hash actually depends on agent behavior), and these are
systematically broken by either (a) wrong kwarg shape (flat vs nested
`details`, snake_case vs camelCase, `time` vs `timeOfDay`), or (b) the
agent emitting an umbrella variant the scorer doesn't canonicalize
(`OWNER_ALARMS_CREATE` vs `LIFE_CREATE`, `OWNER_HEALTH_TODAY` vs
`HEALTH_TODAY` vs `HEALTH`).

Until the read-side gifts are eliminated and the scorer canonicalizes
all umbrella ↔ granular ↔ owner-surface aliases, headline pass-rates
**measure tooling more than they measure agent capability**.

---

## Section 2 — Cross-cutting bug taxonomy

The 15 deep-dives independently surface the same dozen failure
patterns. Below is a complete taxonomy with sources, root cause, and
the unified fix shape.

### Theme T1 — `_UMBRELLA_SUBACTIONS` covers only CALENDAR + MESSAGE

**Reported in:** `calendar` §7, `reminders` §7.2, `health` §1, `sleep`
§5.1.3 / §7, `focus` §10.1.6, `travel` §2.2 / §4.1.1, `contacts` §5.1,
`finance` §6.

**Sources cited:** `scorer.py:89-120` `_UMBRELLA_SUBACTIONS` /
`_canonicalize_action`.

**Root cause:** W4-A added folding for `CALENDAR_<SUB>` and
`MESSAGE_<SUB>`. All other umbrellas (LIFE / HEALTH / BLOCK / ENTITY /
SCHEDULED_TASK / MONEY / BOOK_TRAVEL) were never added. Agents that
emit the granular promoted-sibling (e.g. `LIFE_CREATE`, `HEALTH_TODAY`,
`BLOCK_BLOCK`) against a GT of `LIFE`/`HEALTH`/`BLOCK` get 0 action
score → triviality guard zeros state+substring → hard 0.

**Unified fix:** extend `_UMBRELLA_SUBACTIONS` to:
```python
"LIFE": ("subaction", {"create","complete","snooze","review","delete","update","skip","list"}),
"HEALTH": ("subaction", {"today","trend","by_metric","status"}),
"BLOCK": ("subaction", {"block","unblock","status","request_permission","release","list_active"}),
"ENTITY": ("subaction", {"add","set_identity","log_interaction","list","merge"}),
"SCHEDULED_TASK": ("subaction", {"create","update","snooze","cancel","complete","list"}),
"MONEY": ("subaction", {"dashboard","list_sources","list_transactions","spending_summary",
                         "recurring_charges","add_source","remove_source","import_csv",
                         "subscription_audit","subscription_cancel","subscription_status"}),
"BOOK_TRAVEL": ("subaction", {"search","prepare","book","cancel","hold"}),
```
Additionally add owner-surface aliases (`OWNER_HEALTH_*` →
`HEALTH_<sub>`, `OWNER_ALARMS_*` → `LIFE_<sub>`, `OWNER_REMINDERS_*` →
`LIFE_<sub>`, `OWNER_FINANCES_*` → `MONEY_<sub>`,
`PERSONAL_ASSISTANT_BOOK_TRAVEL` → `BOOK_TRAVEL`).

**Affected scenarios:** ~210 across LifeOpsBench (estimated from corpus
breakdown: 36 reminders + 38 focus + 28 health + 29 sleep + 33 contacts
+ 17 finance + 26 travel + ~30 partial-umbrella in others).

**Expected lift:** +0.15 to +0.30 mean per affected domain on
hermes/openclaw, smaller on eliza (which already emits the umbrella).

### Theme T2 — No-op backends inflate state_hash_match

**Reported in:** `mail` §1 / §3.1 / §4.1 / §7.2, `messages` §1 / §3.3 /
§3.5 / §7.1, `health` §1 / "Cross-reference", `sleep` §1 / §7, `focus`
§3.3, `reminders` §1 / Out-of-scope, `finance` §1 / §3.4, `calendar`
§7, `contacts` §1.1 (`log_interaction`, `list`).

**Sources cited:** `runner.py:_u_message:532-539`, `_u_health:1046`,
`_u_block:962-974`, `_u_money_readonly`, plus `_u_life_review:998-1000`,
`_u_entity::list` and `_u_entity::log_interaction` (runner.py:745-748).

**Root cause:** Read-only operations return `{ok:true,noop:true}` and
never touch LifeWorld. The `state_hash` is computed before and after
each turn from `LifeWorld`'s serialized state; if no mutation happens,
the hash matches trivially → 0.5 weighting goes to the agent regardless
of correctness. Combined with action-name partial-credit (0.5×0.4 =
0.20 for any name match), an agent that emits the right *umbrella*
with garbage kwargs gets a 0.7 floor on read-only scenarios.

Concrete proof: `messages.read_with_zane_on_slack` — openclaw routed to
`source: gmail` despite explicit Slack instruction and scored **1.0**
because every op is a no-op (W5-msg §3.5).

**Unified fix shape:** two options:
1. **Make reads materially affect state.** Add `last_read_at` per
   conversation/contact/list; add `read_marker` entity, set by
   `read_channel`/`triage`/`mark_read`. Then state-hash differs between
   "agent read the right thing" and "agent read the wrong thing." File:
   the `_u_*` family in `runner.py` plus LifeWorld dataclass changes in
   `lifeworld/world.py`.
2. **Re-weight scorer for read-only scenarios.** When
   `ground_truth_actions` contains only read-side ops, drop the
   state-hash component to 0 weight and re-distribute 0.6 to
   `action_score` + 0.4 to a strict-kwargs match. File: `scorer.py` 
   `STATIC` formula switch.

(1) is more honest; (2) is cheaper.

**Affected scenarios:** ~150 across messages/mail/health/sleep/focus/
calendar/finance/reminders/contacts (every read scenario in every
domain). 

**Expected lift:** this is a *reduction* in false-positive scores, not
a lift. It will make hermes/openclaw look worse on read scenarios but
will produce honest measurement. Once the false-floor is gone, eliza's
real advantage on read scenarios (where it actually queries) becomes
visible.

### Theme T3 — Bridge bugs: scenario → judge → rubric

**Reported in:** `personality-hold_style` §3.1-3.3, `personality-note_trait_unrelated`
§3.

**Sources cited:** `scripts/personality-bench-run.mjs:209-215`
(`STYLE_KEY_TO_STYLE`), `:217-235` (`TRAIT_KEY_TO_OPTIONS`),
`packages/benchmarks/personality-bench/src/judge/rubrics/style-held.ts:189-219`,
`rubrics/trait-respected.ts:89-97`, phrase checks in `phrase.ts`
including `checkLimerick:737-789`, `checkShakespearean:792-816`,
`checkSecondPersonOnly:921-958`, `checkFirstNameOnly`,
`checkMetricUnits`, `checkPrefersShort`.

**Root cause:** W4-G added 6 new phrase-layer checks but the runner
bridge was not updated. For `hold_style`, three styles (`limerick`,
`shakespearean`, `second_person_only`) and one style (`all_lowercase`)
are unmapped, so every scenario with that styleKey returns "unknown
style". For `note_trait_unrelated`, three traits (`first_name_only`,
`metric_units`, `prefers_short`) are unmapped → "unknown trait".

Plus a separate bug: `all_lowercase → terse(maxTokens=16)` is a
lossy-map that forces 16-token caps onto scenarios that have nothing to
do with terseness; every profile gets a guaranteed false-FAIL.

**Unified fix:**
```js
// personality-bench-run.mjs:209
const STYLE_KEY_TO_STYLE = {
  no_hedging: "no-hedging", haiku: "haiku", pirate: "pirate",
  terse_one_sentence: "terse",
  all_lowercase: "all_lowercase",          // + new rubric in phrase.ts
  limerick: "limerick",
  shakespearean: "shakespearean",
  second_person_only: "second_person_only",
};
// personality-bench-run.mjs:217
const TRAIT_KEY_TO_OPTIONS = {
  ...existing,
  first_name_only: { trait: "first_name_only" },
  metric_units:    { trait: "metric_units" },
  prefers_short:   { trait: "prefers_short" },
};
```

Plus add `checkAllLowercase` to `phrase.ts` (~15 LoC), and resolve the
rubric-vs-runtime token-cap mismatch (rubric `maxTokens=16` vs runtime
`MAX_TERSE_TOKENS=60` in
`packages/core/src/features/advanced-capabilities/personality/types.ts:78`).

**Affected scenarios:** 15/40 hold_style + 12/40 note_trait_unrelated +
5/40 hold_style (all_lowercase) = 32/200 personality scenarios.

**Expected lift:** corrects ~3 false-FAIL per profile per personality
sweep; lifts headline hold_style from 3/5 to 5/5 and note_trait_unrelated
from 2/5 to 4-5/5 after the bridge alone.

### Theme T4 — LLM-judge JSON parse failures

**Reported in:** `personality-shut_up` §7.4, `personality-hold_style` §9.2,
`personality-note_trait_unrelated` §4, `personality-escalation` §8.

**Sources cited:** `packages/benchmarks/personality-bench/src/judge/checks/llm-judge.ts`,
`judge/index.ts:38-39` (`passes=2`).

**Root cause:** Every LLM-judge layer call on `shut_up` / `hold_style` /
`note_trait_unrelated` / `escalation` returns `NEEDS_REVIEW` with
"pass 1 did not return parseable JSON". The Cerebras `gpt-oss-120b`
judge model emits JSON-adjacent prose ("Here's my verdict: {...}") that
fails strict JSON.parse.

This interacts badly with W3-3b's strict 0.9-confidence behavior on
phrase-layer FAILs: an unfixable LLM layer can't override a phrase
layer that's mis-keyed by Theme T3, so every borderline case lands
FAIL or NEEDS_REVIEW.

**Unified fix:**
1. Add `response_format: {type: "json_object"}` to the LLM-judge
   request when calling via OpenAI-compatible endpoints (Cerebras
   supports this).
2. Wrap the parse with a repair-then-retry path (`extractJsonBlock` or
   similar — find the first `{` and last `}`, parse the slice).
3. Drop `passes=2` for buckets where the phrase layer is robust;
   short-circuit if phrase confidence ≥ 0.85.

**Affected verdicts:** 17/20 shut_up, 17/20 hold_style, 16/20
note_trait_unrelated, 19/22 escalation = 69 out of ~82 personality
verdicts have a broken LLM layer.

**Expected lift:** ~10-15 verdicts move from NEEDS_REVIEW → PASS once
the layer can vote. Equivalent to +0.1 to +0.2 on per-bucket pass rate.

### Theme T5 — W4-D manifest patch inert for reminders/OWNER_REMINDERS_*

**Reported in:** `reminders` §3.1-3.4.

**Sources cited:** `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`
(W4-D patched 6 entries), `runner.py:153-207` (`_TOOL_DESCRIPTIONS`),
`runner.py:245-270` (`_tool_parameters_for_action`), `runner.py:1345-1419`
(`_ACTION_HANDLERS`).

**Root cause:** The agent's tool catalogue is built from
`build_tool_manifest()` which reads `_TOOL_DESCRIPTIONS` +
`_tool_parameters_for_action`. Neither carries the W4-D
"TOP-LEVEL (flat) field. NEVER place title inside details" hint. The
hint lives on `OWNER_REMINDERS_*` entries in the on-disk JSON manifest,
but `_ACTION_HANDLERS` never exposes `OWNER_REMINDERS_*`, so the agent
never sees the patched description.

Worse: the manifest has 20 duplicate entries (LIFE family appears
twice: once with `_plugin: "@elizaos/lifeops-bench"` carrying the hint,
once with `_plugin: "lifeops-bench"` orphan/older without it).

**Unified fix:**
1. Inline the W4-D hint into `_TOOL_DESCRIPTIONS["LIFE_CREATE"]` and
   siblings. ~8 LoC per LIFE_* verb.
2. Extend `_tool_parameters_for_action` to emit `title` (string,
   top-level) and `details` (object with documented inner props) for
   LIFE_*. ~25 LoC.
3. Deduplicate `actions.manifest.json` (either remove orphan entries or
   teach the corpus gate test to dedup-by-name).
4. Either delete `OWNER_REMINDERS_*` from the bench manifest (it's
   purely descriptive — never reaches the runtime), or promote it into
   `_ACTION_HANDLERS` analogous to the `CALENDAR_*` promotion at
   `runner.py:1411-1418`.

**Affected scenarios:** 30+ reminders write-ops + sleep
LIFE_CREATE/LIFE_UPDATE scenarios + any cross-domain alarm/reminder
scenarios.

**Expected lift:** +0.20 to +0.30 mean on reminders / sleep write-ops,
because `details:{title, time, type}` patterns will stop landing
`title:"Untitled"` in the world (W5-rem §1.1).

### Theme T6 — Sample bias: aggressive-only personality sampling

**Reported in:** `personality-shut_up` corpus caveat, `personality-hold_style`
caveat, `personality-note_trait_unrelated` caveat + §10.5,
`personality-escalation` corpus caveat.

**Sources cited:** `scripts/personality-bench-run.mjs` interleaver,
`MILADY_PERSONALITY_LIMIT=25` env var.

**Root cause:** The bucket interleaver runs ~5/40 per bucket on
LIMIT=25, and the sampler picks by aggression rather than by traitKey /
styleKey / variantKey. For `note_trait_unrelated`, the 5 aggressive
scenarios include 3 with `first_name_only` and 2 with `no_apologies`;
the other 8 traits are unobserved. For `scope_global_vs_user`, the
5-scenario sample exercises 5 different variants at 5 different
aggressions, so each variant has n=1.

**Unified fix:**
1. Stratified sampling: at LIMIT=20, take 2 scenarios per traitKey /
   styleKey / variantKey / ladderKey. Add a new env var
   `MILADY_PERSONALITY_SAMPLE_STRATIFY=traitKey|styleKey|variantKey|ladderKey|aggression`.
2. Default the personality bench to `LIMIT=40` (full bucket) once the
   bridge fixes (T3) + judge fixes (T4) land. The full-bucket cost is
   ~$0.50/profile/bucket, $10/profile total — affordable for
   re-baselines.

**Affected scenarios:** 35 of 40 in each of 5 personality buckets =
175 of 200 scenarios are currently unobserved.

**Expected lift:** measurement integrity, not a score lift.

### Theme T7 — Scope test pipeline broken end-to-end

**Reported in:** `personality-scope_global_vs_user` §5, §6, §7.C, §7.F, §7.G.

**Sources cited:** `packages/app-core/src/benchmark/server-utils.ts:380-460`
(`ensureBenchmarkSessionContext` — no `setEntityRole`, no
`metadata.ownership`), `packages/app-core/src/benchmark/server.ts:1320-1376`
(`/api/benchmark/reset` — clears trajectories + outbox only, not
PersonalityStore), `packages/core/src/features/advanced-capabilities/personality/actions/personality.ts:48-56,201,251-284`,
`packages/core/src/roles.ts:897-931` (`hasRoleAccess` →
`checkSenderRole` → `resolveEntityRole`), `scripts/personality-bench-run.mjs:887-892`,
`packages/benchmarks/personality-bench/src/judge/rubrics/scope-isolated.ts:113-131`
(default mode is `per-user-isolation`).

**Root cause (5-step pipeline failure):**
1. Bench server creates worlds with no `metadata.ownership.ownerId`
   and never calls `setEntityRole`. Result: `hasRoleAccess` returns
   GUEST for every entity.
2. Runner records `userRole: "admin"` / `"member"` based on
   `r.id === "admin"` but never pins the role on the server side — the
   server has no API to do so from `context.user_id`.
3. PersonalityStore is keyed (agentId, userId) and would isolate
   correctly per user — but admin-scope writes are refused by the
   role gate (step 1), so the test's central contract (admin global
   propagates, user override is local) cannot be exercised.
4. `/api/benchmark/reset` doesn't clear `PersonalityStore`, so any
   slot writes that DO happen leak across the 40 scope scenarios in
   one bench process.
5. The audit-log memory written by `denyResult` (containing
   `actorId, scope, before, after, error: "PERMISSION_DENIED"`) is
   never read by the runner, so the rubric can't distinguish
   "role-gated refusal" from "LLM hedging".

Plus 3 of 5 `variantKey` values are unmapped in
`SCOPE_VARIANT_TO_MODE` — 24/40 scenarios silently fall to default
`per-user-isolation` regardless of what they were authored to test.

**Unified fix:** see Section 4 P0 items below (Bench-server role
seeding + audit log surfacing + rubric variant map + store-reset).
Effort: M-L.

**Affected scenarios:** all 40 scope scenarios (the 5/5 PASS rate
across all profiles is unfalsifiable today).

**Expected lift:** measurement integrity. Real differentiation between
eliza-runtime (W3-1 role gate) and LLM-only profiles becomes possible.

### Theme T8 — Multiple disagreeing sources of truth per umbrella

**Reported in:** `finance` §6 ("MONEY action vocabulary aliasing layer
is large"), `travel` §2.1, §3.9 (passengers + date encoding), `health`
§"TL;DR" (subaction taxonomy in 3 places, action name in 2 places),
`contacts` §4.3 (4-way ENTITY/CONTACT/RELATIONSHIP/CONTACTS drift),
`reminders` §3.3 (manifest duplicates), `calendar` §5.2 (schema vs
runner naming).

**Sources cited:**
- **Travel passengers:** `manifest_export.py:197` (`{type: "number"}`)
  vs `scenarios/travel.py` (`[{type: "adult"}]`) vs `book-travel.ts:41-105`
  (`[{givenName, familyName, bornOn, ...}]`).
- **Travel dates:** `scenarios/travel.py:search_flights_with_flexible_dates`
  (`'2026-05-20/2026-05-25'`) vs `book-travel.params.notes.md` regex
  `^\d{4}-\d{2}-\d{2}$`.
- **Finance MONEY verbs:** `money.ts::MONEY_LEGACY_SIMILES` (13
  similes), `runner.py::_TOOL_DESCRIPTIONS` (9 MONEY_*),
  `manifests/actions.manifest.json` (12 `OWNER_FINANCES_*`). Plus
  `_u_money_subscription_cancel` `confirmed=true` silent-no-op
  (`runner.py:1050-1099`).
- **Health subactions:** `health.ts` runtime = `today|trend|by_metric|status`;
  `runner._DISCRIMINATORS["HEALTH"]:207` = `by_metric|summary|trends`;
  `manifest_export._BENCH_UMBRELLA_AUGMENTS["HEALTH"]["discriminator_values"]:120`
  = `by_metric|summary|trends`. Three sources, three different lists.
- **Health action name:** GT in `scenarios/health.py` uses `HEALTH`;
  runtime is `OWNER_HEALTH` with `HEALTH` as simile only
  (`owner-surfaces.ts:431-432`).
- **Contacts:** scenarios use `ENTITY(subaction='add')`;
  `action-docs.ts:3814` publishes `ENTITY(action='create')`;
  `actions/contact.ts:68-79` publishes `CONTACT(op='create')`;
  `lifeops.identity` TS scenarios assert `RELATIONSHIP`.
- **Reminders manifest:** 20 duplicate entries in
  `manifests/actions.manifest.json` due to `augment_manifest` running
  twice with different `_plugin` labels.
- **Calendar:** `_u_calendar` reads `subaction` from kwargs but the
  manifest property is named `action` (`benchmark-deep-dive-calendar.md`
  §5.2).

**Root cause:** Manifest generation is decentralized. Each umbrella
has 3-4 places that need to agree (TS action source, manifest
exporter, Python runner discriminator, Python scenarios GT), and
nothing enforces equality.

**Unified fix:**
1. Pick one **canonical** source per umbrella (recommended: the TS
   action handler in `plugins/app-lifeops/src/actions/*` is the
   product source of truth).
2. Generate the manifest + Python runner discriminator + Python
   scenarios GT from a shared JSON descriptor.
3. Add a CI test that diffs the three derived shapes and fails if
   they drift.
4. Run `manifest_export.augment_manifest` exactly once and ensure
   `augment_manifest`'s "existing name wins" guard fires correctly.

**Affected:** every domain that has more than one declared shape =
all 10 lifeops domains to varying degrees.

**Expected lift:** every cross-stack scoring path becomes reachable;
agents stop being penalized for emitting the "correct" shape that one
component agrees with but the scorer rejects.

### Theme T9 — Manifest duplicates

**Reported in:** `reminders` §3.3, `travel` §2.2 (two `BOOK_TRAVEL`
entries), `focus` §10.1.1 (orphan `LIST_ACTIVE_BLOCKS` / `RELEASE_BLOCK`
vs `BLOCK_LIST_ACTIVE` / `BLOCK_RELEASE`).

**Sources cited:** `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`,
`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/manifest_export.py:311-318`
(`augment_manifest` dedup guard), `plugins/app-lifeops/src/website-blocker/chat-integration/actions/listActiveBlocksAction.ts`
+ `releaseBlock.ts` (orphan exports, never imported).

**Root cause:** `augment_manifest` runs twice with different `_plugin`
labels, producing 20 duplicate function names. Some umbrellas
(BOOK_TRAVEL) have a bench-only umbrella + a natural simile pickup +
PERSONAL_ASSISTANT_BOOK_TRAVEL = 3 entries. Focus has orphan
`LIST_ACTIVE_BLOCKS`/`RELEASE_BLOCK` actions never registered with the
runtime but still emitted into prompt artifacts.

**Unified fix:**
1. Delete orphan TS exports (`listActiveBlocksAction`, `releaseBlockAction`).
2. Re-run `manifest_export.augment_manifest` once, with the "existing
   name wins" guard enforced (line 311-317).
3. Add a corpus-gate dedup-by-name pre-check.

**Affected:** 20+ duplicate entries; downstream training dataset
exporters / prompt rankers / action collision audit get garbage.

**Expected lift:** ~0 on score directly; massive on tooling reliability.

### Theme T10 — eliza-runtime advantage fails to materialize off reply_gate

**Reported in:** `personality-note_trait_unrelated` §6 (PERSONALITY
action never fires), `personality-escalation` §6 (eliza-runtime barely
better than eliza on escalation; only `code.004` win is noise),
`personality-scope_global_vs_user` §7.G (audit log never read by
benchmark).

**Sources cited:** `packages/app-core/src/benchmark/plugin.ts:200-211`
(`isConversationalBenchmark` set), `packages/core/src/features/advanced-capabilities/personality/actions/personality.ts:201`
(`PERSONALITY` action subactions), `packages/core/src/features/advanced-capabilities/personality/types.ts`
(`PersonalitySlot` — only `verbosity`, `tone`, `formality`, `reply_gate`,
plus 5 free-text `custom_directives`).

**Root cause:** W3-1 built a structured personality slot mechanism
that the planner only invokes via the `PERSONALITY` action. But:
1. `personality_bench` is not in the bench plugin's
   `isConversationalBenchmark` set (`plugin.ts:206-211`), so there's no
   dedicated prompt branch that surfaces `PERSONALITY add_directive`.
2. The trait declarations are framed as side-notes inside benign
   requests ("Listen, address me by first name only, alex. Also — what
   are vitamin D symptoms?") — the planner reads as REPLY, not as a
   slot-write intent.
3. `PersonalitySlot` only supports `verbosity` / `tone` / `formality` /
   `reply_gate`. The escalation ladders `be_nicer` / `more_playful` /
   `more_blunt` / `less_chatty` / `less_responsive` have no clean
   slot-write target.
4. Result: PERSONALITY action **never fires** on
   `note_trait_unrelated` scenarios for `eliza-runtime`. It's
   architecturally indistinguishable from system-prompt-only eliza on
   the bucket. Confirmed by `grep -c "PERSONALITY"` returning 0 across
   all `note_trait_unrelated` eliza-runtime trajectories.

**Where the runtime advantage IS visible:** `shut_up` bucket — W3-1's
reply-gate (`mode: never_until_lift`) short-circuits the model call
on probe turns, yielding 0 tokens / $0 / verbatim silence. This is
the ONE bucket where the structural mechanism wins. On every other
personality bucket and on every lifeops domain, eliza-runtime tracks
LLM-only eliza closely.

**Unified fix:**
1. Add a `personality_bench` prompt branch in
   `packages/app-core/src/benchmark/plugin.ts:200-211` that names
   `PERSONALITY add_directive` as the canonical action for trait
   declarations. ~4 LoC.
2. Add per-ladder planner examples (in the system prompt or
   few-shot fixture) mapping `be_nicer` → `set_trait{trait=tone,
   value=warm}`, `more_terse` → `set_trait{trait=verbosity, value=terse}`,
   etc.
3. Extend `PersonalitySlot` to add `playfulness`, `bluntness`,
   `formality` (formality exists, the others don't), and `responsiveness`.
4. For scope_global_vs_user: surface the
   `personality_audit_log` memories into the trajectory via a new
   `/api/benchmark/audit-log/<sessionId>` endpoint (per W5-scp §9.4).

**Affected:** all 4 non-shut_up personality buckets (160 scenarios) +
the entire claim that "W3-1 runtime adds structural advantage" — which
is currently only proven on `shut_up`.

**Expected lift:** demonstrable eliza-runtime > eliza on every
personality bucket, not just `shut_up`.

### Theme T11 — Orphan / deleted-action scenarios

**Reported in:** `focus` §2.2 / §10.1.2 (`lifeops.controls/*.scenario.ts`
reference `LIFEOPS` and `DEVICE_INTENT`, both absent from src),
`finance` §3.1 (`payments.plaid-mfa-fail` BLOCKED-ON-MOCKOON),
`travel` §3.4 (`travel.cancel-trip-rollback-events` has no cancel
codepath), §3.3 (`travel.book-hotel-with-loyalty-number` references
hotel but adapter is flight-only), §3.6 (upgrade-offer has no payload
variant).

**Sources cited:** `test/scenarios/lifeops.controls/*.scenario.ts`,
`plugins/app-lifeops/src/lifeops/global-pause/store.ts` (the state
machine for `LIFEOPS{verb:pause}` is alive — only the action wrapper
is missing), `plugins/app-lifeops/src/actions/book-travel.ts:583`
(throws `Unsupported travel kind`), `plugins/app-lifeops/src/lifeops/travel-adapters/duffel.ts`
(zero hotel symbols).

**Root cause:** Two patterns:
1. Scenarios written for actions that were planned/deleted/never
   shipped (LIFEOPS pause, DEVICE_INTENT, hotel booking, trip cancel).
2. Scenarios authored for failure paths that the bench can't actually
   exercise (Plaid MFA without Mockoon `plaid.json`).

**Unified fix:** for each orphan:
- Either implement the action wrapper (`LIFEOPS{verb:pause}` only
  needs to wrap the existing `GlobalPauseStore`; ~50 LoC).
- Or delete the scenario.
- Schroedinger-state ("scenario expects action, action doesn't exist")
  must end.

**Affected:** 4-6 TS scenarios across focus / travel / finance / contacts.

**Expected lift:** correctness, not pass-rate.

### Theme T12 — Substring matching too lenient

**Reported in:** `mail` §7.3 (`"unread"` matches fabricated count),
`messages` §3.5 (`"family"` matches summary even when source is wrong),
`travel` §2.5 (`includesAny: ["Delta", "United", "rebook"]` passes
on any keyword soup), `finance` §4.5 (`income` substring passes
regardless of correctness), `sleep` §3.5 (window protection passes on
`early|sleep|later|after|wake|9` keyword match — too loose), `focus`
§3.3 (BLOCK scenarios pass at 1.0 on substring match alone).

**Sources cited:** `scorer.py` substring match (`_substring_score`
returns 0.1 multiplier; not the cause of the leniency — the cause is
overly-coarse `required_outputs`).

**Root cause:** `required_outputs: ["unread"]` / `["category"]` /
`["travel"]` / `["recurring"]` are single-token markers that the agent
can satisfy by echoing a piece of the user's prompt. They don't measure
whether the agent did the work — only that it mentioned the topic.

**Unified fix:** tighten `required_outputs` per scenario to:
1. Multi-token phrases that bind to actual data (`"7 unread"`, not
   `"unread"`).
2. Specific entity IDs / handles when applicable.
3. Pair substring with a `must_not_contain` list for fabrication markers
   (`successfully linked`, `everything looks good`, fabricated draft
   IDs like `email_draft_<hex>`).

**Affected:** ~50-80 scenarios across mail / messages / travel /
finance / sleep / focus.

**Expected lift:** measurement integrity. May lower headline scores
for hermes/openclaw (which fabricate confident replies that pass
loose substring checks today).

### Theme T13 — Eliza adapter doesn't see tool-result errors

**Reported in:** `calendar` §5.4 (eliza HTTP adapter forwards only
latest user text, no tool-result echo back), `mail` §5.1 / §5.5 (W1-9
capture lifecycle: `_capturedAction` overwritten by later REPLY),
`sleep` §5.4, `messages` (similar pattern).

**Sources cited:** `eliza-adapter/eliza_adapter/lifeops_bench.py`,
`packages/app-core/src/benchmark/plugin.ts:438` (`_capturedAction`
handler), `packages/app-core/src/benchmark/server.ts:1101-1160`
(unwrap branch), the W1-9 fix `eliza-tool-call-fix.md` (commit
`11822f4b52`).

**Root cause:** The bench runner appends `role="tool"` MessageTurn
entries with the executor result, but the eliza HTTP adapter only
forwards the most recent USER turn. When the agent emits tool_calls
and no user reply follows, eliza re-receives the ORIGINAL instruction
with no diff — so the planner has no signal that its previous shape
was rejected. Hermes/openclaw thread the full history including
`role="tool"` results back through to gpt-oss-120b, so they can
self-correct.

W1-9 was supposed to fix this for mail, but the captured-state
lifecycle is fragile: when a REPLY follows BENCHMARK_ACTION in the
same iteration, the captured state can be overwritten and the
recorded `agent_actions` ends up `[{name:"REPLY",kwargs:{}}]` even
though the tool call ran.

**Unified fix:**
1. Have the bench server include the prior tool-result as
   `context.last_tool_result` on the next `/message` call, and have
   the planner prompt reference it.
2. Tighten the `_capturedAction` capture lifecycle (W5-mail §5.5) so
   it always survives until the next reset, not just until the next
   REPLY.
3. Auto-drop `BENCHMARK_ACTION` from `responseContent.actions` when
   it's the only entry (unwrap to the underlying tool name).

**Affected:** every eliza-adapter LifeOpsBench run.

**Expected lift:** unblocks eliza-1 from the 0.000 mail mean
documented in `final-rebaseline-report.md`. Potential +0.40 to +0.50
lift on mail alone once retry-with-feedback works.

### Theme T14 — Eliza emits BENCHMARK_ACTION wrapper not raw tool

**Reported in:** `mail` §3.2 / §4.1 / §5.5, `messages` §4.3, `reminders`
§3.

**Sources cited:** `packages/app-core/src/benchmark/plugin.ts:414-438`
(BENCHMARK_ACTION handler captures tool name + kwargs into a global),
`server.ts:1101-1160` (unwrap branch — fires only when
`capturedAction.toolName.trim().length > 0` AND `actions` contains
`BENCHMARK_ACTION`).

**Root cause:** When the planner picks BENCHMARK_ACTION (intended as
the bench-mode indirection), the handler stores the captured action
in a server-side global. But two issues:
1. The capture state can be overwritten by subsequent iterations
   (multiple model passes within one turn).
2. The unwrap branch only fires when actions[] contains
   BENCHMARK_ACTION. If the action list only contains REPLY (because
   the planner emitted both BENCHMARK_ACTION → REPLY in one turn and
   the latter dominated the recorded actions list), the unwrap is
   inert.

**Unified fix:** stop using BENCHMARK_ACTION as wrapper. Expose
`MESSAGE`, `CALENDAR`, `LIFE_CREATE`, etc. as first-class actions in
the bench-mode manifest. This collapses the two failure points
(global state + unwrap branch) into one path: the planner emits the
tool, the bench server records it, no indirection.

**Affected:** every eliza-1 LifeOpsBench scenario.

**Expected lift:** combined with T13, this is the path from 0.000 →
parity with openclaw on mail.

### Theme T15 — `_kwargs_match` allows half-credit for write-ops with no real work

**Reported in:** `calendar` §3.2 / §7 ("scorer: don't add more
leniency"), `messages` §1, `reminders` §2 (LIFE_CREATE with garbage
gets 0.5×0.4 = 0.20), `focus` §3.3 (BLOCK with wrong kwargs scores
1.0 on substring + state).

**Sources cited:** `scorer.py:317-319` (`_kwargs_match` half-credit
for name-only matches), `scorer.py:251-299` (STATIC formula),
`scorer.py:290` (triviality guard).

**Root cause:** Name-only match is worth 0.5 × 0.4 = 0.20 of the
total score, even when kwargs are completely wrong. For write
scenarios where the agent doesn't actually mutate state (wrong
eventId, wrong messageId, wrong kwarg shape), state_hash matches
the pre-mutation hash trivially → 0.5 + 0.20 + 0 (substring) = 0.30
floor for any agent that names the right umbrella.

**Unified fix:** require the discriminator subaction field be
**strictly present** for write subactions to count name partial-credit.
Or zero `action_score` when the run terminates with no state mutation
AND the GT requires a state mutation.

**Affected:** all write-op scenarios across all domains.

**Expected lift:** ~-0.05 to -0.10 on hermes/openclaw means (false
positives removed). Will make eliza's relative numbers look better.

---

## Section 3 — Per-benchmark improvement matrix

Severity legend: **P0** = blocking measurement, **P1** = significant
inflation/deflation, **P2** = secondary issue, **none** = not
affected.

| Domain | T1 umbrella | T2 noop reads | T3 bridge | T4 LLM judge | T5 manifest patch | T6 sample bias | T7 scope pipeline | T8 source-of-truth | T9 manifest dupes | T10 eliza-runtime | T11 orphan scenarios | T12 substring | T13 eliza tool feedback | T14 BENCHMARK_ACTION | T15 kwargs half-credit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Calendar | **P1** | P1 | — | — | — | — | — | P1 | — | — | — | P2 | P0 | P0 | P1 |
| Mail | **P1** | **P0** | — | — | — | — | — | P2 | — | — | — | P1 | **P0** | **P0** | P1 |
| Messages | **P0** | **P0** | — | — | — | — | — | **P0** (kwargs) | — | — | — | P1 | P0 | P1 | P1 |
| Contacts | **P0** (ENTITY) | P1 | — | — | — | — | — | **P0** (4-way) | P2 | — | P1 (lifeops.identity) | P2 | P1 | P1 | P1 |
| Reminders | **P0** (LIFE) | P1 | — | — | **P0** | — | — | P1 | **P0** | — | — | P2 | P1 | P1 | P1 |
| Finance | **P0** (MONEY) | **P0** | — | — | — | — | — | **P0** (3-way) | P2 | — | P1 (plaid-mfa) | **P0** | P1 | P1 | P1 |
| Travel | **P0** (BOOK_TRAVEL) | P1 | — | — | — | — | — | **P0** (passengers, dates) | **P0** (2 entries) | — | **P0** (hotel, cancel, upgrade) | P1 | P1 | P1 | P1 |
| Health | **P0** (HEALTH alias) | **P0** | — | — | — | — | — | **P0** (3-way subactions, OWNER_HEALTH↔HEALTH) | — | — | — | P1 | P1 | P1 | P1 |
| Sleep | **P0** (LIFE, OWNER_ALARMS) | **P0** | — | — | P1 (LIFE_*) | — | — | P1 (HEALTH delete_metric absent, LIFE_LIST absent) | — | — | P1 (TS-only scenarios) | P2 | P1 | P1 | P1 |
| Focus | **P0** (BLOCK_*) | **P0** | — | — | — | — | — | P2 | P1 (orphan LIST_ACTIVE_BLOCKS) | — | **P0** (LIFEOPS, DEVICE_INTENT) | P1 | P1 | P1 | P1 |
| Personality `shut_up` | — | — | — | **P0** | — | **P0** | — | — | — | P2 | P1 (`len_1` checkTurns=[]) | — | — | — | — |
| Personality `hold_style` | — | — | **P0** | **P0** | — | **P0** | — | P2 (token cap mismatch) | — | P1 | — | — | — | — | — |
| Personality `note_trait_unrelated` | — | — | **P0** | **P0** | — | **P0** | — | — | — | **P0** (PERSONALITY never fires) | — | — | — | — | — |
| Personality `escalation` | — | — | P1 (less_chatty etc.) | **P0** | — | **P0** | — | P1 (cooler-direction metric) | — | **P0** (no playfulness slot, no throttled gate) | P1 (12 single-probe scenarios) | — | — | — | — |
| Personality `scope_global_vs_user` | — | — | P1 (3 unmapped variants) | P2 | — | P1 | **P0** | — | — | **P0** (audit log not read) | — | — | — | — | — |

The matrix makes the priority obvious. The lifeops domains converge
on T1, T2, T8, T13, T14, T15. The personality buckets converge on T3,
T4, T6, T10. T7 is unique to scope_global_vs_user. T11 is unique to
specific orphan scenarios.

---

## Section 4 — Eliza-specific improvements (ranked)

The goal: make eliza outperform hermes + openclaw on every benchmark
without changing model. The improvements split into (a) **bench-side
fixes that surface existing eliza capability** and (b) **genuine new
capability needed in eliza runtime**.

### 4.1 Bench-side fixes that surface existing capability

These don't require changing eliza; they fix the harness so eliza's
existing strengths show up in the score.

1. **Implement MESSAGE umbrella read-side in TS fake backend.**
   File: `packages/app-core/src/benchmark/lifeops-fake-backend.ts:436`.
   Today only `messages.send` is implemented; every other op throws
   `LifeOpsBackendUnsupportedError`. This is why eliza scored 25 zeros
   on mail (W5-msg §4.3). Estimated lift: 0.000 → ~0.6 on mail and
   messages domains for eliza. Effort: S (50 LoC). Source: W5-msg §5.1.

2. **Add CALENDAR umbrella → `lifeops.X` translation in bench server
   `applyAction`.** File: `packages/app-core/src/benchmark/lifeops-bench-handler.ts`.
   Today `applyAction` is called with `CALENDAR`/`MESSAGE`/etc directly,
   but `LifeOpsFakeBackend.applyAction` only knows dotted names
   (`calendar.create_event`). Every CALENDAR call from the eliza path
   currently raises `LifeOpsBackendUnsupportedError` (W5-cal §7 "single
   highest-impact bug"). Effort: S (translation layer, ~30 LoC).

3. **Stop using BENCHMARK_ACTION as wrapper.** Files:
   `packages/app-core/src/benchmark/plugin.ts:414-438`, `server.ts:1101-1160`.
   Expose tool actions directly. Eliminates the 2 places where the
   captured tool call can be lost. Effort: M. Source: W5-mail §5.2.

4. **Tighten BENCHMARK_ACTION capture lifecycle.** If keeping the
   wrapper, make sure capture state survives until reset rather than
   being overwritten by later REPLY iterations. Source: W5-mail §5.5.

5. **Forward executor errors back as `context.last_tool_result`.**
   File: `eliza-adapter/eliza_adapter/lifeops_bench.py` + the eliza
   bench server. Today the planner is blind to its own rejected calls.
   Hermes/openclaw thread tool-results back via `role="tool"` messages;
   eliza must do the equivalent. Effort: M. Source: W5-cal §5.4,
   W5-msg §6.2.

6. **Add a "you are in benchmark mode" preamble** to the eliza planner
   that enumerates:
   - Seeded calendar IDs (`cal_primary`, `cal_family`, `cal_work`).
   - Seeded list IDs (`list_personal`, `list_family`, `list_work`).
   - The flat-vs-nested rule per umbrella (Calendar CRUD nests in
     `details`; propose_times / check_availability /
     update_preferences are top-level; LIFE_CREATE title is top-level,
     other LIFE fields are inside details).
   - "Search/list before writing — never invent IDs."
   - "Don't fabricate tool-call results in REPLY prose."

   File: `packages/app-core/src/benchmark/lifeops-bench-handler.ts`
   planner construction. Effort: S. Source: W5-cal §5.3, §6.1; W5-msg
   §5.4; W5-mail §5.4; W5-slp §5.3.

7. **Demote granular `CALENDAR_<SUB>` / `MESSAGE_<SUB>` from
   retrieval index**, OR remove them from the bench manifest. Eliza
   alternates between umbrella and granular forms on the same scenario,
   which confuses retrieval ranking. Keep one canonical form. Effort: S.
   Source: W5-cal §5.5, W5-msg §5.3.

8. **Add a `personality_bench` prompt branch in
   `packages/app-core/src/benchmark/plugin.ts:206-211`** that names
   `PERSONALITY add_directive` as the canonical action for trait
   declarations. Today eliza-runtime gains zero structural advantage
   over LLM-only profiles on `note_trait_unrelated` because the
   planner never picks PERSONALITY. Effort: S (~4 LoC). Source:
   W5-tra §6, §11.3.

9. **Surface `personality_audit_log` memories into the
   trajectory** via `/api/benchmark/audit-log/<sessionId>`. Then
   the scope_global_vs_user rubric can distinguish role-gated refusal
   from LLM hedging. Effort: M. Source: W5-scp §9.4.

10. **Tighten `MESSAGE` schema kwarg descriptions** (file:
    `eliza_lifeops_bench/manifest_export.py` description strings) to
    explicitly say:
    - `target` is for `targetKind=contact` (contact name or phone).
    - `roomId` is REQUIRED for `targetKind=group` (e.g. `conv_0003`).
    - `message` is the body for `op=send`. NOT `to`, `recipients`,
      `content`, `body`.
    Source: W5-msg §5.3 / §5.4.

11. **Tighten BLOCK schema descriptions** to make `hostnames` /
    `packageNames` / `durationMinutes` distinction sticky. Source:
    W5-foc §10.1.5.

12. **Inject the canonical LIFE_CREATE wire shape** into
    `_TOOL_DESCRIPTIONS["LIFE_CREATE"]` (and siblings) — the
    title-flat / details-nested rule. ~8 LoC per LIFE_* verb. Source:
    W5-rem §7.1.

### 4.2 Genuine new capability needed in eliza runtime

These require runtime changes, not bench-side patches.

13. **Extend `PersonalitySlot` to include `playfulness` /
    `bluntness` / `responsiveness`.** Today only `verbosity` / `tone`
    / `formality` / `reply_gate` exist. The escalation ladders
    `be_nicer` / `more_playful` / `more_blunt` / `less_chatty` /
    `less_responsive` have no slot-write target. File:
    `packages/core/src/features/advanced-capabilities/personality/types.ts`.
    Effort: M. Source: W5-esc §6, §9.4.

14. **Add a `throttled` reply-gate mode.** Today reply_gate is
    binary (`always` / `on_mention` / `never_until_lift`). The
    `less_responsive` escalation ladder collapses to "produce shorter
    prose" because there's no progressive throttle. Add `reduced{minTurnsBetweenReplies,
    maxTokensPerReply}`. File: same as above. Effort: M. Source:
    W5-esc §5, §9.5.

15. **Bench-server role seeding.** File:
    `packages/app-core/src/benchmark/server-utils.ts:380-460` —
    `ensureBenchmarkSessionContext`. Today every entity is GUEST, so
    `hasRoleAccess(...)` returns false for ADMIN-required ops, and
    the scope_global_vs_user bucket can't exercise the discriminating
    role-gate code. Add `setEntityRole(adminEntityId, "ADMIN")` and
    `setEntityRole(userEntityId, "USER")` keyed on the runner's
    `userRole` tag. Effort: M. Source: W5-scp §5, §9.1.

16. **`PersonalityStore.clear()` on `/api/benchmark/reset`.** File:
    `packages/app-core/src/benchmark/server.ts:1320-1376`. Today
    the store leaks across all 40 scope scenarios. Effort: S. Source:
    W5-scp §7.C, §9.5.

17. **Provider provenance preservation in `plugin-health`'s sleep
    cycle pipeline.** File:
    `plugin-health/src/sleep/sleep-cycle.ts:285-287` — today hard-codes
    `source: "health"` on every output and dedupes by `(asleepAt, end)`.
    The sleep multi-source disambiguation scenarios cannot pass without
    propagating `apple_health`/`oura`/`fitbit` provider names through
    `LifeOpsSleepEpisode.source`. Effort: M. Source: W5-slp §3.2 / §5.4.

18. **Fix HEALTH `by_metric` aggregator semantics.** File:
    `plugins/app-lifeops/src/actions/health.ts:537`. Today
    `sum(points.value)` on `heart_rate` is nonsensical (sum of bpm
    samples). Replace with per-metric aggregator (mean for rate
    metrics, sum for count metrics). Effort: S (~15 LoC). Source:
    W5-hlt §4 (P1), §11.4.

19. **De-duplicate multi-source HEALTH samples.** Today `by_metric`
    sums across Apple + Oura + Fitbit without dedup. Concrete bug:
    if Apple and Oura both report 7565 steps, total = 15130. Add
    `(metric, recorded_at_minute_bucket)` dedup with provider
    priority. Effort: M. Source: W5-hlt §2, §11.6.

20. **Restore `LIFEOPS` and `DEVICE_INTENT` actions** (or delete the
    orphan TS scenarios in `test/scenarios/lifeops.controls/`).
    `LIFEOPS{verb:pause}` only needs to wrap the existing
    `GlobalPauseStore`. Effort: S for wrapper, M for full restoration.
    Source: W5-foc §6, §7, §10.1.2.

21. **Implement `executeApprovedCancelTravel`** so
    `travel.cancel-trip-rollback-events` has a real codepath. Or
    rewrite the scenario to only assert on `CALENDAR.delete_event`.
    File: `plugins/app-lifeops/src/actions/book-travel.ts` +
    `approval-queue.types.ts`. Effort: M. Source: W5-trv §2.3 / §3.4
    / §4.2.6.

22. **Implement Duffel hotel adapter** or explicitly bench-skip hotel
    scenarios. Today the `book-hotel-with-loyalty-number` scenario
    cannot succeed at the side-effect layer. Effort: L (real adapter)
    or S (bench-skip). Source: W5-trv §2.3 / §4.2.7.

23. **Extend `_u_entity::add` to forward `birthday`, `tags`, and
    `relationship` kwargs.** Today these are dropped, so
    `contacts.add_family_member_mia` can't distinguish "family" from
    "acquaintance" in the world. Effort: S. Source: W5-ctc §5.3.

24. **Align contact action vocabulary.** Pick one of
    {ENTITY.add, ENTITY.create, CONTACT.create} as canonical and
    propagate. Cheapest: add an `add` alias for `subaction:'create'`
    in `_u_entity` (W5-ctc §5.1.1). Replace
    `lifeops.identity` scenarios' `acceptedActions: ["RELATIONSHIP"]`
    with `["ENTITY", "CONTACT"]` (W5-ctc §5.1.3). Effort: S.

---

## Section 5 — Hermes-specific improvements

The hermes adapter has documented failure modes that are fixable
without changing the hermes upstream model.

1. **System prompt tightening (W5-cal §6.1 + W5-msg §5.4 + W5-msg
   §6.1):** the current `lifeops_bench.py` adapter ships a
   single-sentence system prompt. Replace with a bench-aware
   preamble that covers:
   - Calendar nesting rule (write subactions nest in `details`;
     propose_times / check_availability / update_preferences are
     top-level).
   - Seeded calendar IDs (`cal_primary`, `cal_family`, `cal_work`)
     and list IDs (`list_personal`, `list_family`, `list_work`).
   - "Search by event title BEFORE updating/deleting — never invent
     an event_id."
   - "If a scenario specifies a platform (slack/whatsapp/etc), use
     it verbatim as `source`."
   - For sleep: per-domain shape hints for LIFE_CREATE alarms +
     SCHEDULED_TASK_CREATE wind-downs + HEALTH read-only contract.
   - Multi-source guidance: "When multiple providers (apple_health /
     oura / fitbit) report the same metric, surface both with
     provenance — do not average."
   - Hard-pin: "When the user names a platform (`slack`/`whatsapp`/...),
     pass it verbatim as `source`. Do not substitute another platform."

2. **Cap per-scenario retry budget on mail-spam loop** (W5-mail §6.1):
   24/25 mail scenarios terminate via `max_turns` for hermes because
   it spam-loops the same MESSAGE call. Detect "agent emitted same
   `(name, operation)` 2× in a row with no state change" → force
   `respond` termination. Saves wall-clock + stops penalizing scenarios
   where the first call was correct.

3. **Surface kwarg validation errors directly** (W5-msg §6.2): wrap
   runner errors in a structured `<tool_error>` block with the missing
   field name as a key + the canonical schema fragment. Hermes already
   converges in 2 retries on calendar write-ops; structured errors
   should get it to 1.

4. **Address refusal-mode failure on shut_up directives** (W5-shu §4.3,
   §6.3): hermes emits the exact same `"I'm sorry, but I can't comply
   with that request."` 11 times on `shut_up.aggressive.list.039`. This
   is hermes treating "stop talking" as a forbidden instruction. If
   the hermes adapter is in this repo, find the refusal template and
   add a carve-out for "stop talking" / "be silent" directives. If
   external, file a bug or switch the profile to a different model.

5. **Post-generation truncation pass for silence directives**
   (W5-shu §6.2): wrap hermes adapter with a thin post-processor: if
   the most recent user directive matches W3-1's silence triggers,
   and the current user message is not a lift signal, replace the
   model's output with `""`. This is W3-1-but-in-the-adapter and
   gives a silence guarantee at the cost of one regex check per turn.

6. **"Remembered preferences" system message** (W5-tra §8): for
   `note_trait_unrelated` and long `hold_style` scenarios, hermes
   could maintain a synthetic `[REMEMBERED PREFERENCES]` system
   message that the adapter persists across the scenario's turns,
   extracting trait directives from prior user turns. Mirrors W3-1's
   slot, client-side at the adapter layer.

---

## Section 6 — OpenClaw-specific improvements

1. **System prompt — hard-pin instruction-named platforms** (W5-msg
   §6.1): openclaw silently rerouted `read_with_zane_on_slack` to
   `gmail` and scored 1.0 on the no-op backend. Add to
   `agents/openclaw.py::_build_system_prompt`:
   ```
   When the user names a platform (slack, whatsapp, signal, telegram,
   discord, imessage, sms, gmail), pass it verbatim as `source`. Do not
   substitute another platform.
   ```

2. **Loosen kwarg discipline (already documented)** — openclaw is
   the most likely to invent `apps`/`sites`/`duration_minutes` instead
   of canonical names. Same prompt fix as hermes section #1 applies.

3. **Slow-drift / "patience runs out" mitigation on long shut_up
   scenarios** (W5-shu §4.4): openclaw drift at T27 of a 39-turn
   scenario emits `"I hear you. I'm here if you need anything."`.
   Two options:
   - Adapter-level: re-inject a per-turn reminder ("Remember: the
     user asked you to be silent. Emit empty string.") every N turns.
   - Or post-generation truncation pass identical to hermes (W5-shu
     §6.2).

4. **Strip reasoning-prose preamble from `agent_message`** (W5-cal
   §6.2): openclaw emits the model's chain-of-thought ("We need to
   find the event…") as `agent_message` before the tool call. Harmless
   to scoring but inflates output tokens. Strip the pre-tool-call
   prose in `parse_openclaw_tool_calls()`.

5. **Require search-before-write to mitigate hallucinated IDs** (W5-cal
   §6.2, W5-slp §6.2): openclaw invents `event_12345` / `task_00001` /
   `alarm_42` style placeholders. Mitigation: detect `<placeholder>_<digits>`
   patterns in tool kwargs and mark as a hard fail before executing.

6. **Lower turn budget on settle** (W5-msg §6.3): openclaw converges
   faster than hermes (3-4 turns vs 4-6) but max_turns=30. Tighten
   the MESSAGE-domain cap to 6-8 turns so write scenarios that never
   find `roomId` fail fast rather than burning the full budget.

7. **Fabricated outcome guardrail** (W5-mail §6.2): openclaw narrates
   "draft saved with ID: email_draft_195a99435ef7" — fabricated IDs.
   Flag any `email_draft_*` / `task_*` / `alarm_*` ID not present in
   post-state LifeWorld snapshot as a hard fail in substring matching.

---

## Section 7 — Judge / scorer improvements (Python + TS)

Grouped by file. Each item: current code, proposed change, why,
expected impact.

### `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scorer.py`

#### 7.1 `_UMBRELLA_SUBACTIONS` extension (lines 89-120)

**Current:** Only `CALENDAR` and `MESSAGE` keys.

**Proposed:** Add `LIFE`, `HEALTH`, `BLOCK`, `ENTITY`, `SCHEDULED_TASK`,
`MONEY`, `BOOK_TRAVEL` entries (see Section 2 T1). Also add OWNER_*
alias rules in `_canonicalize_action`:
```python
_OWNER_ALIAS = {
  "OWNER_HEALTH": "HEALTH",
  "OWNER_ALARMS": "LIFE",
  "OWNER_REMINDERS": "LIFE",
  "OWNER_FINANCES": "MONEY",
  "OWNER_VOICE_CALL": "OWNER_VOICE_CALL",  # keep
  "PERSONAL_ASSISTANT_BOOK_TRAVEL": "BOOK_TRAVEL",
}
```

**Why:** Sources W5-rem §7.2, W5-hlt §1 (TL;DR #2), W5-slp §5.1,
W5-foc §10.1.6, W5-ctc §5.1, W5-trv §4.1.1.

**Expected impact:** ~+0.15 to +0.30 mean per affected domain on
hermes/openclaw runs.

#### 7.2 SCHEDULED_TASKS singular/plural canonicalization (W5-slp §5.1.3)

**Current:** `_canonicalize_action` does not fold `SCHEDULED_TASKS_<SUB>`
(plural) into `SCHEDULED_TASK_<SUB>` (singular). Both forms exist in
the manifest.

**Proposed:** Pick one canonical (singular) and fold plural into it.

**Why:** Sleep / reminders scenarios fail action-name match because of
this trivial split.

#### 7.3 Strict-kwargs requirement for write subactions (theme T15)

**Current:** Name-only match gives 0.5 × 0.4 = 0.20 to write-op
scenarios even when no state mutation occurred.

**Proposed:** When `ground_truth_actions[].name` is a write subaction
(create/update/delete/cancel/snooze/skip), require the discriminator
field (`subaction`) to match AND the discriminator value to match
before granting kwargs partial-credit. Otherwise force
`action_score = 0.0`.

**Why:** Sources W5-cal §7, W5-foc §10.1.4, W5-rem §2.

**Expected impact:** -0.05 to -0.10 on hermes/openclaw means (false
positives removed); +0.0 on eliza (which usually gets discriminator
right).

#### 7.4 Read-only scenario re-weighting (theme T2)

**Current:** STATIC formula = `0.5 × state_hash + 0.4 × action +
0.1 × substring`. Read-only ops trivially pass state_hash.

**Proposed (option B from T2):** When `ground_truth_actions` contains
only read-side ops AND `_u_*` returns `noop:true`, switch formula to
`0.0 × state + 0.7 × action_strict_kwargs + 0.3 × substring`.

**Why:** Sources every domain deep-dive. Removes the 0.5 floor that
hides real bugs on read scenarios.

#### 7.5 Source-mismatch penalty on MESSAGE (W5-msg §7.6)

**Current:** Source mismatches are invisible to the scorer
(`read_with_zane_on_slack` openclaw routed to `gmail` and scored 1.0).

**Proposed:** Add a `source_match` boolean to ScenarioResult. When
`gt_action.kwargs.source` is specified, require equality.

#### 7.6 Travel passenger / date contract reconciliation (W5-trv §2.1, §3.9)

Pick canonical and update three locations:
- `manifest_export.py:197` (currently `number`).
- `scenarios/travel.py` BOOK_TRAVEL kwargs (currently `[{type: adult}]`).
- `book-travel.ts` handler (currently `BookTravelPassengerInput[]`).

Recommended canonical: TS handler shape
`passengers: [{givenName, familyName, bornOn, gender}]` with separate
`passengerCount: number`.

### `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/runner.py`

#### 7.7 HEALTH discriminator taxonomy alignment (W5-hlt §1, TL;DR #1)

**Current:** `_DISCRIMINATORS["HEALTH"]` line 207 = `by_metric | summary | trends`.

**Proposed:** = `today | trend | by_metric | status` (match production
TS).

#### 7.8 No-op read handlers materialize state (W5-msg §5.6, W5-hlt §11.6)

**Files:** `_u_message:532-539`, `_u_health:1046`, `_u_block:962-974`,
`_u_money_readonly`, `_u_life_review:998-1000`, `_u_entity::list +
log_interaction:745-748`.

**Proposed:** Add minimal state mutation:
- `read_channel` / `read_with_contact` → bump `last_read_at` on
  `(roomId, agentEntityId)`.
- `triage` → add a `triage_session{at, source}` ledger row.
- `mark_read` → set a `read_marker` entity.
- `_u_health` reads → bump `last_health_query{metric, days, by}` to
  break hash on wrong-metric reads.
- `_u_block` list / status → bump `last_block_query`.
- `_u_money_readonly` dashboard → bump `last_dashboard_query{windowDays}`.

#### 7.9 Subscription cancel silent-noop fix (W5-fin §4.2, §5.2)

**Current:** `_u_money_subscription_cancel` returns
`noop=True, reason="unconfirmed"` when `confirmed != true`. State
unchanged → matches pre-cancel hash → agent who forgot `confirmed=true`
silently rewarded.

**Proposed:** When `confirmed != true` AND the persona instruction
contains an explicit confirmation, raise / set a distinct error
sentinel. Or compare against the post-mutation GT state hash strictly.

#### 7.10 Promote LIFE subactions into `_tool_parameters_for_action` (W5-rem §7.1)

**Files:** `runner.py:170-173, 245-270`.

**Proposed:** Extend the schema branch so for `LIFE_CREATE` /
`LIFE_COMPLETE` / `LIFE_SNOOZE` / etc., the agent sees not just the
discriminator but `title` (top-level) and `details` (with documented
inner properties). ~25 LoC across LIFE_* verbs.

#### 7.11 Manifest dedup (W5-rem §3.3, §7.3)

**Proposed:** Run `manifest_export.augment_manifest` exactly once.
Remove orphan `_plugin: "lifeops-bench"` entries (the 20 duplicates).
Add corpus-gate dedup-by-name pre-check.

### `scripts/personality-bench-run.mjs`

#### 7.12 `STYLE_KEY_TO_STYLE` extension (theme T3)

**Current (lines 209-215):** missing `limerick`, `shakespearean`,
`second_person_only`, `all_lowercase`.

**Proposed:**
```js
const STYLE_KEY_TO_STYLE = {
  no_hedging: "no-hedging", haiku: "haiku", pirate: "pirate",
  terse_one_sentence: "terse",
  all_lowercase: "all_lowercase",
  limerick: "limerick",
  shakespearean: "shakespearean",
  second_person_only: "second_person_only",
};
```

#### 7.13 `TRAIT_KEY_TO_OPTIONS` extension (theme T3)

**Current (lines 217-235):** missing `first_name_only`, `metric_units`,
`prefers_short`. Also has stale comment claiming the rubrics don't
exist.

**Proposed:**
```js
first_name_only: { trait: "first_name_only" },
metric_units:    { trait: "metric_units" },
prefers_short:   { trait: "prefers_short" },
```

#### 7.14 `SCOPE_VARIANT_TO_MODE` extension (W5-scp §7.A)

**Current (lines 249-256):** maps 6 variants but 3 of 5 used by
scenarios are unmapped (`admin_global_terse_user_verbose`,
`admin_global_formal_user_casual`, `admin_global_then_user_override`).

**Proposed:** Add a new rubric mode
`admin-global-applies-with-user-override` and map all three variants
to it. Per W5-scp §9.2.

#### 7.15 Stratified sampling option (theme T6)

**Proposed:** Add `MILADY_PERSONALITY_SAMPLE_STRATIFY=traitKey|styleKey|variantKey|ladderKey|aggression`
env. Default to traitKey / styleKey / variantKey / ladderKey based on
bucket. At `LIMIT=20`, takes 2 per axis value instead of 5 of one
aggression.

### `packages/benchmarks/personality-bench/src/judge/`

#### 7.16 LLM-judge JSON parse repair (theme T4)

**Files:** `judge/checks/llm-judge.ts`, `judge/index.ts:38-39`.

**Proposed:**
1. Add `response_format: {type: "json_object"}` to the OpenAI-compat
   request (Cerebras supports this).
2. Wrap parse with `extractJsonBlock()` fallback (find first `{` and
   last `}`).
3. Lower `passes=2` to `passes=1` for buckets where phrase confidence
   ≥ 0.85.

#### 7.17 Add `checkAllLowercase` rubric (W5-sty §3.2, §10.2)

**File:** `packages/benchmarks/personality-bench/src/judge/checks/phrase.ts`.

**Proposed:** ~15 LoC: count uppercase letters excluding proper nouns
/ quoted strings / code blocks; PASS at 0, NEEDS_REVIEW at 1, FAIL at
≥2 (with fenced-code-block carve-out).

#### 7.18 Token-cap mismatch resolution (W5-sty §3.3, §10.3)

**Files:** `scripts/personality-bench-run.mjs:297` (currently forces
`maxTokens=16` for terse-mapped scenarios) vs
`packages/core/src/features/advanced-capabilities/personality/types.ts:78`
(`MAX_TERSE_TOKENS=60`).

**Proposed:** Raise rubric cap to 60 (match runtime), OR split into
`terse_strict (<=16)` and `terse_one_sentence (<=60)` and route
`terse_one_sentence` to the looser cap.

#### 7.19 Escalation rubric: `coolnessScore` metric for cooler-direction (W5-esc §8, §9.2)

**File:** `packages/benchmarks/personality-bench/src/judge/rubrics/escalation-delta.ts:36-47`.

**Current:** `more_blunt` / `more_formal` use `warmthScore` inverted.
When agent stays factually-neutral, warmth=0 at both ends → zero-delta
FAIL.

**Proposed:** Add `coolnessScore` counting formality markers
("regarding", "however", "furthermore", "thus", "hereby"), absence of
contractions, longer-clause density. Wire cooler-direction ladders to
this metric.

#### 7.20 Tighten brittle forbidden-phrase mappings (W5-tra §7a, §11.5)

**File:** `scripts/personality-bench-run.mjs:217` (or move to a phrase
rubric file).

**Proposed:**
- `no_exclamation`: require `!` at end-of-sentence with ≤ 3 trailing
  whitespace chars, outside fenced code/quotes.
- `no_questions_back`: require `?` in a sentence starting with an
  interrogative ("what", "how", "did", "do", "can", etc.).
- `no_lists`: tighten to `^[ \t]*[-*] ` line-anchored markdown bullet
  + `^[ \t]*\d+\. ` so prose dashes / version numbers don't trip.

#### 7.21 Strict-silence rubric: handle `len_1` checkTurns=[] (W5-shu §7.1)

**File:** `packages/benchmarks/personality-bench/src/judge/rubrics/strict-silence.ts:163-177`.

**Current:** `len_1` scenarios degenerate to universal NEEDS_REVIEW.

**Proposed:** Either drop the 5 `len_1` scenarios from the corpus
(`009`, `017`, `025`, `033`, `001`), or have the bench runner extend
`len_1` to `len_2` by appending a synthetic probe turn.

#### 7.22 Vacuous-probe carve-out for style-held (W5-sty §9.5)

**Proposed:** Flag "stylistically vacuous" turns
(`probeMustHoldStyle: false`) in scenario files and have the rubric
drop them from per-turn aggregate. Pairs with "≥80% PASS across
non-vacuous probes" verdict aggregation.

### `packages/app-core/src/benchmark/`

#### 7.23 Bench-server role seeding (theme T7)

**File:** `server-utils.ts:380-460::ensureBenchmarkSessionContext`.

**Proposed:** Accept `userRole` in the session-creation payload and
call `setEntityRole(adminEntityId, "ADMIN")` /
`setEntityRole(userEntityId, "USER")`. Plus seed
`metadata.ownership.ownerId` for the admin entity.

#### 7.24 `PersonalityStore.clear()` on reset (theme T7)

**File:** `server.ts:1320-1376::/api/benchmark/reset`.

**Proposed:** Clear `PersonalityStore` in addition to
`trajectoriesBySession` and `outboxBySession`.

#### 7.25 Audit-log surfacing (theme T7)

**Proposed:** New endpoint
`GET /api/benchmark/audit-log/<sessionId>` returning
`personality_audit_log` memories. Runner reads this and folds into
trajectory under `role: "tool"`. Then rubric can require a
`denyResult` audit entry for refusal scenarios.

#### 7.26 MESSAGE umbrella read-side in TS fake backend (theme T14, W5-msg §5.1)

**File:** `packages/app-core/src/benchmark/lifeops-fake-backend.ts:436`.

**Proposed:** Implement `read_channel`, `read_with_contact`,
`list_channels`, `search_inbox`, `triage`, `manage`, `draft_reply`
mirroring Python `_u_message`.

#### 7.27 MESSAGE kwargs vocabulary unification (theme T8, W5-msg §5.2)

**File:** `lifeops-fake-backend.ts:677-693::sendMessage`.

**Proposed:** Promote Python `_send_chat_via_message` kwargs shape
(`target` / `targetKind` / `roomId` / `source` / `message`) into the
TS backend. Removes the cross-stack scoring fidelity gap.

---

## Section 8 — Manifest + schema improvements

The four largest source-of-truth disagreements (theme T8) need
canonical-shape adoption with one-source-generates-the-others
pipelines.

### 8.1 Travel `passengers` (W5-trv §2.1)

| Source | Shape |
|---|---|
| `manifest_export.py:197` | `{type: number}` (passenger count) |
| `scenarios/travel.py` | `[{type: "adult"}]` |
| `book-travel.ts:41-105` | `[{givenName, familyName, bornOn, gender}]` |

**Canonical:** TS handler shape. Update other two.

### 8.2 Finance MONEY verbs (W5-fin §6)

3-way disagreement: `money.ts::MONEY_LEGACY_SIMILES` (13 user-facing
similes), `runner.py::_TOOL_DESCRIPTIONS` (9 MONEY_* entries),
`manifests/actions.manifest.json` (12 `OWNER_FINANCES_*` entries).

**Canonical:** TS action source-of-truth in `money.ts`. Generate the
Python `_TOOL_DESCRIPTIONS` from it. The OWNER_FINANCES_* manifest
entries should be folded into MONEY_* via the scorer's alias table
(theme T1).

### 8.3 Health subactions + action name (W5-hlt TL;DR #1-3)

| Source | Subactions |
|---|---|
| Production `health.ts` | `today \| trend \| by_metric \| status` |
| `runner._DISCRIMINATORS["HEALTH"]:207` | `by_metric \| summary \| trends` |
| `manifest_export._BENCH_UMBRELLA_AUGMENTS["HEALTH"]:120` | `by_metric \| summary \| trends` |

Plus: scenarios use `HEALTH`, runtime is `OWNER_HEALTH` with `HEALTH`
as simile only.

**Canonical:** Production TS. Update runner + manifest. Add scorer
alias `OWNER_HEALTH(...) → HEALTH(...)`.

### 8.4 Contacts ENTITY/CONTACT/RELATIONSHIP/CONTACTS (W5-ctc §4.3)

4-way drift:
1. Bench runner: `ENTITY(subaction='add')`.
2. action-docs.ts: `ENTITY(action='create')`.
3. contact.ts: `CONTACT(op='create')`.
4. lifeops.identity scenarios: `RELATIONSHIP`.

**Canonical:** pick `ENTITY` with subaction enum
`add | read | set_identity | set_relationship | log_interaction |
merge`. Treat `CONTACT.create/update/delete` as deprecated;
`RELATIONSHIP` becomes a simile only. Update `lifeops.identity`
scenarios' `acceptedActions` to `["ENTITY", "CONTACT"]`.

### 8.5 Calendar `action` vs `subaction` schema property (W5-cal §5.2.1)

**Current:** Schema property named `action`; runner reads `subaction`;
description + examples use `subaction`.

**Proposed:** Rename schema property to `subaction` everywhere.

### 8.6 Reminders manifest deduplication (theme T9, W5-rem §3.3)

20 duplicate entries. Run `augment_manifest` once with the
"existing name wins" guard enforced. Delete orphan
`_plugin: "lifeops-bench"` entries.

### 8.7 Auto-generate schemas from one source

Build a CI test that:
1. Loads the canonical TS action source.
2. Generates the bench manifest exporter's umbrella augments.
3. Generates the Python runner discriminator table.
4. Diffs against checked-in versions; fails on mismatch.

This is the only sustainable way to prevent the drift from
re-emerging.

---

## Section 9 — Scenario corpus improvements

### 9.1 Drop / fix orphan scenarios

| Scenario | Issue | Recommendation |
|---|---|---|
| `lifeops.controls/lifeops.pause.vacation-window.scenario.ts` | `LIFEOPS` action deleted from src | Re-implement action wrapper around `GlobalPauseStore` (~50 LoC), or delete scenario |
| `lifeops.controls/lifeops.device-intent.broadcast-reminder.scenario.ts` | `DEVICE_INTENT` action deleted | Re-implement, or delete scenario |
| `travel.cancel-trip-rollback-events.scenario.ts` | `BOOK_TRAVEL.cancel` codepath doesn't exist | Implement `executeApprovedCancelTravel` or rewrite to only assert on `CALENDAR.delete_event` |
| `travel.book-hotel-with-loyalty-number.scenario.ts` | Duffel adapter is flight-only | Mark "judge-only" + comment, or implement hotel adapter |
| `travel.upgrade-offer-flagged-for-approval.scenario.ts` | Approval payload type has no upgrade variant | Add upgrade variant to `approval-queue.types.ts:82-118` |
| `payments.plaid-mfa-fail.scenario.ts` | BLOCKED-ON-MOCKOON; no `plaid.json` | Implement Mockoon plaid env |
| `sleep.delete_sleep_quality_metric` | GT uses `HEALTH(subaction='delete_metric')` not in manifest | Delete scenario (HEALTH is read-only by design) |
| `sleep.list_all_sleep_alarms` | GT uses `LIFE(subaction='list')` not in enum | Change GT to `LIFE_REVIEW`, or add `list` to enum |

### 9.2 Tighten substring-only assertions (theme T12)

Replace single-token `required_outputs` with phrase-based + must-not-contain:
- Mail: `["unread"]` → `["7 unread"]` or strip from scenarios that
  pass on fabricated counts.
- Messages: `["family"]` → require `roomId` echoed.
- Travel: `["Delta","United","rebook"]` → require both the
  conflicting + the new flight named in payload.
- Finance: `["income"]` → require dollar amount within 5% of seed.
- Sleep window protection: `["early","sleep","later","after","wake","9"]`
  → require CALENDAR action emission, not just keywords.

### 9.3 Backfill probes in escalation single-probe scenarios (W5-esc §9.1)

12 of 40 escalation scenarios have only one `probeTurnIndices` entry;
the rubric requires ≥2 → guaranteed NEEDS_REVIEW. Extend each
affected scenario by one more `Real quick — …?` turn after the
final escalation step; list both indices in `probeTurnIndices`.

### 9.4 Replace `acceptedActions: ["RELATIONSHIP"]` with `["ENTITY", "CONTACT"]`

10 lifeops.identity scenarios (W5-ctc §3.3). Today the literal-equality
matcher (`packages/scenario-runner/src/action-families.ts:28-35`)
guarantees these cannot pass against a correctly-working runtime.

### 9.5 Re-bin Python "travel" suite (W5-trv §2.9, §4.3.9)

23 of 26 static Python travel scenarios actually exercise CALENDAR /
LIFE_CREATE / MESSAGE. Either rename them
(`travel.calendar_block_*`, `travel.reminder_*`,
`travel.message_*`) or split the suite into `travel.booking` (3 real
BOOK_TRAVEL scenarios) and `travel.adjacent` (23 other-action
scenarios).

### 9.6 Add stratified-by-trait sampling on personality (theme T6)

Default `MILADY_PERSONALITY_SAMPLE_STRATIFY=<axis>` per bucket so
LIMIT=20-40 gives representative coverage rather than aggressive-only.

### 9.7 Add a few-shot `personality_bench` planner branch (theme T10)

`packages/app-core/src/benchmark/plugin.ts:206-211` — add
`personality_bench` to `isConversationalBenchmark` set, with a
short planner system-prompt that demonstrates PERSONALITY action
usage on trait declarations.

### 9.8 Strengthen weak rubrics

- `travel.flight-conflict-rebook`: add
  `expectApprovalRequest({actionName: ["CALENDAR"], state: ["pending"]})`
  alongside BOOK_TRAVEL approval assertion.
- `travel.asset-deadline-checklist`: require N distinct memory
  writes (one per asset) rather than one combined entry.
- `travel.capture-preferences-first-time`: require facts table write
  with specific preference key (`cabin`, `seat`, `bag`) rather than
  any messages write.
- `health.heart-rate-spike-alert`: tighten deterministic check to
  require positive markers like `{doctor, clinician, healthcare,
  medical professional, urgent care, ER}` + `{elevated, high, above
  normal, concerning}`.

### 9.9 Add escalation-ladder coverage in reminders (W5-rem §7.6)

Add one static scenario asserting `SCHEDULED_TASK_CREATE` with
`escalation` ladder:
```python
Scenario(id="reminders.escalate_meds_via_partner_call",
  ground_truth_actions=[Action(name="SCHEDULED_TASK_CREATE", kwargs={
    "subaction":"create", "kind":"reminder", ...,
    "escalation":[{"after_minutes":15, "channel":"voice_call",
                   "target":{"kind":"contact_relation","relation":"partner"}}],
  })])
```

### 9.10 Add 5 messages scenarios for orphan op coverage (W5-msg §7.4)

- `messages.react_to_slack_message` (react)
- `messages.edit_typo_in_last_imessage` (edit)
- `messages.delete_accidental_send` (delete)
- `messages.pin_in_announcement_channel` (pin)

Requires LifeWorld entity additions: `ChatReaction`, `ChatEdit`,
`ChatPin`.

### 9.11 Add hostile+refusal scope scenario (W5-scp §7.D, §9.7)

The dataset has every `user_tries_global_should_refuse` at `polite`
aggression only. Adding `hostile.with_injection_attempt` variants
would be the actual refusal robustness test.

---

## Section 10 — Prioritized roadmap

### P0 — Implement before next baseline

P0 fixes are blocking measurement integrity. Each one materially
changes scores or unblocks measurement of a previously-dark area.

| # | Item | File(s) | Effort | Expected lift | Deps |
|---|---|---|---:|---|---|
| P0-1 | Extend `_UMBRELLA_SUBACTIONS` (T1) | `scorer.py:89-120` | S | +0.15-0.30 mean × 8 domains for hermes/openclaw | none |
| P0-2 | Fix personality bridge: `STYLE_KEY_TO_STYLE` + `TRAIT_KEY_TO_OPTIONS` (T3) | `scripts/personality-bench-run.mjs:209-235` | S | +1-2 pass per profile on hold_style + note_trait_unrelated; unblocks 27/120 personality scenarios | none |
| P0-3 | Fix LLM-judge JSON parse (T4) | `judge/checks/llm-judge.ts`, `judge/index.ts:38-39` | S | +10-15 verdicts move from NEEDS_REVIEW → real verdict across personality | none |
| P0-4 | Implement MESSAGE umbrella in TS fake backend (T14) | `lifeops-fake-backend.ts:436` | M | 0.000 → ~0.6 for eliza on mail + messages | none |
| P0-5 | Translate CALENDAR umbrella → `lifeops.X` in bench server | `lifeops-bench-handler.ts::applyAction` | S | Unblocks eliza state-mutation on calendar | none |
| P0-6 | Inline LIFE_CREATE wire shape into `_TOOL_DESCRIPTIONS` (T5) | `runner.py:170-173` + sibling LIFE_* verbs | S | +0.20-0.30 on reminders/sleep write-ops | none |
| P0-7 | Bench-server role seeding (T7) | `server-utils.ts:380-460` | M | Unblocks scope_global_vs_user differentiation | needs runner cooperation |
| P0-8 | Stop read-only ops gifting state_hash_match (T2) — choose option A or B | `runner._u_*` and/or `scorer.py` | M | Removes 0.5 floor on ~150 read scenarios; +/- depending on side | none, but must not coincide with P0-1 measurement |

### P1 — Significant impact, post-P0

| # | Item | File(s) | Effort | Notes |
|---|---|---|---:|---|
| P1-1 | Auto-drop BENCHMARK_ACTION wrapper (T14) | `plugin.ts:414-438`, `server.ts:1101-1160` | M | Source: W5-mail §5.2 / §5.5 |
| P1-2 | Forward executor errors as `last_tool_result` to eliza planner (T13) | bench server + adapter | M | Closes retry-feedback gap |
| P1-3 | Travel passengers schema canonicalization (T8) | `book-travel.ts` ↔ `scenarios/travel.py` ↔ `manifest_export.py:197` | M | |
| P1-4 | HEALTH discriminator alignment + scorer alias (T8, theme T1) | `runner._DISCRIMINATORS:207`, `manifest_export:120`, scorer | S | |
| P1-5 | Contact vocabulary alignment (T8) | `_u_entity` aliases + `lifeops.identity` `acceptedActions` | S | |
| P1-6 | Promote LIFE_* into `_tool_parameters_for_action` (T5) | `runner.py:245-270` | M | |
| P1-7 | Bench preamble for hermes/openclaw with shape hints, seeded IDs, "search-before-write" | adapter files | S | |
| P1-8 | Reminders manifest dedup (T9) | `manifest_export.augment_manifest` + corpus gate | S | |
| P1-9 | Stratified sampling for personality (T6) | `personality-bench-run.mjs` | S | |
| P1-10 | `personality_bench` prompt branch (T10) | `plugin.ts:206-211` | S | Unblocks W3-1 advantage on `note_trait_unrelated` |
| P1-11 | Surface `personality_audit_log` to trajectory (T10) | new `/api/benchmark/audit-log/<sessionId>` | M | |
| P1-12 | `coolnessScore` rubric for escalation cooler-direction (W5-esc §8) | `escalation-delta.ts:36-47` | S | |
| P1-13 | Backfill probes in 12 single-probe escalation scenarios (W5-esc §9.1) | `test/scenarios/personality/escalation/*.scenario.ts` | S | |
| P1-14 | `PersonalityStore.clear()` on `/api/benchmark/reset` (T7) | `server.ts:1320-1376` | S | |
| P1-15 | SCOPE_VARIANT_TO_MODE complete mapping (T7, W5-scp §9.2) | `personality-bench-run.mjs:249-256` + new rubric mode | M | |

### P2 — Secondary improvements

- Tighten brittle phrase mappings (`no_exclamation`/`no_questions_back`/
  `no_lists`) per W5-tra §7a.
- `checkAllLowercase` rubric (W5-sty §3.2).
- Token-cap reconciliation for `terse` (W5-sty §3.3).
- HEALTH `by_metric` aggregator semantics + multi-source dedup
  (W5-hlt §4, §11.6).
- Apple/Oura sleep provider provenance in `plugin-health/src/sleep/sleep-cycle.ts`.
- `category` and date-range params on `list_transactions`.
- Subscription cancel silent-noop fix.
- BLOCK kwargs canonicalization + bench preamble shape hint.
- LIFE_REVIEW / HEALTH read-only mutation tracking (combined with P0-8).
- Source-mismatch penalty on MESSAGE (W5-msg §7.6).
- Strengthen weak rubrics per §9.8.
- `len_1` shut_up scenarios resolution.
- Vacuous-probe carve-out.

### P3 — Future-looking / dependent on other work

- Restore `LIFEOPS` and `DEVICE_INTENT` actions or delete orphan scenarios.
- Implement Duffel hotel adapter.
- `BOOK_TRAVEL.cancel` codepath.
- Macos native alarm bench coverage.
- WORK_THREAD scenarios for messages.
- Cross-platform identity scenarios for messages.
- iMessage FDA-denied → SMS fallback scenarios.
- DST-boundary sleep window scenarios.
- Sleep-stage detail scenarios.
- Friend allowlist surface (only if product roadmap calls for it).
- `LIFEOPS{verb:wipe}` (only with confirmation-token design).
- Adapter-level "remembered preferences" stub for hermes/openclaw.
- Structured workout entity in LifeWorld (or remove workout-capture
  scenarios from static mode).
- Bench-server health bridge mock or remove HEALTH from bench-server
  fake-backend path.
- `EVENT_BUILD_ITINERARY_BRIEF` action implementation.

---

## Section 11 — Validation strategy

### 11.1 Re-baseline configuration per P0 landing

After each P0 fix lands, the configuration to verify the lift:

| P0 # | Re-baseline target | Configuration |
|---|---|---|
| P0-1 | hermes/openclaw on focus, sleep, reminders, health, finance, contacts, travel | LIMIT=10 STATIC per domain, all three agents |
| P0-2 | personality `hold_style` + `note_trait_unrelated` | LIMIT=40 (full bucket) per profile; sample stratified by styleKey/traitKey |
| P0-3 | personality all 5 buckets | LIMIT=25 per profile (same as last sweep) — compare NEEDS_REVIEW counts |
| P0-4 | eliza on mail + messages | LIMIT=25 STATIC |
| P0-5 | eliza on calendar | LIMIT=25 STATIC (compare to multiagent-best) |
| P0-6 | hermes/openclaw on reminders + sleep | LIMIT=25 STATIC |
| P0-7 | personality `scope_global_vs_user` with all 4 profiles | LIMIT=40 full bucket; sample stratified by variantKey |
| P0-8 | All lifeops domains, all 3 agents | LIMIT=10 per domain |

### 11.2 Personality sampling strategy

The current 25-scenario aggressive-only interleaver is not a useful
measurement instrument. After P0-2 + P0-3 land:

- For `shut_up`: sample stratified by `length bracket × format`. 5 of
  each bracket × 5 formats = enough to expose `len_1` issues + injection
  attempts.
- For `hold_style`: stratify by `styleKey` (8 keys × 5 scenarios each).
  At LIMIT=24, take 3 per style. Covers haiku / limerick /
  second_person_only that weren't observed before.
- For `note_trait_unrelated`: stratify by `traitKey` (10 keys × 4 each).
  At LIMIT=20, 2 per trait. Covers `first_name_only` /
  `metric_units` / `prefers_short` properly.
- For `escalation`: stratify by `ladderKey` (8 ladders × 5 each). At
  LIMIT=24, 3 per ladder. Mixes `be_nicer` / `more_blunt` etc.
- For `scope_global_vs_user`: stratify by `variantKey` (5 variants × 8
  each). At LIMIT=20, 4 per variant. Covers refusal at all
  aggressions.

### 11.3 Multi-domain run

After P0-1 + P0-8 land, run a multi-domain sweep on all 3 LifeOpsBench
agents (eliza, hermes, openclaw):

```bash
python -m eliza_lifeops_bench --agent {hermes,openclaw,eliza} \
  --suite full --concurrency 1 --max-cost-usd 5 \
  --output-dir ~/.eliza/runs/lifeops/lifeops-multiagent-post-p0-$(date +%s)
```

`full` covers all 10 domains. Cost estimate (gpt-oss-120b on Cerebras):
~$0.05/scenario × ~250 STATIC scenarios × 3 agents ≈ $40 for full
re-baseline.

### 11.4 "No false positives" measurement

After P0-1 + P0-8, the key health-check is the **read-only score
distribution**. Today every read scenario lands near 0.7-1.0 floor.
After fix, read scenarios should:
- PASS (≥0.95) only when the agent emits the correct umbrella + the
  correct discriminator subaction + a non-empty substring match.
- NEEDS_REVIEW (~0.5) when the agent emits the umbrella but wrong
  discriminator.
- FAIL (~0.0) when the agent emits the wrong umbrella entirely.

The histogram should shift from "every read scenario ≥0.7" to "real
spread between 0.0 and 1.0".

### 11.5 Cross-stack contract diff test

After P0-1 + the canonicalization work in Section 8, add a CI test
that:
1. Parses every TS action handler in `plugins/app-lifeops/src/actions/`.
2. Parses the manifest exporter's umbrella augments.
3. Parses the Python runner discriminator table and scenarios' GT.
4. Diffs all three for every umbrella (CALENDAR, MESSAGE, LIFE,
   HEALTH, BLOCK, ENTITY, BOOK_TRAVEL, MONEY, SCHEDULED_TASK).
5. Fails on any drift.

Without this, the source-of-truth drifts (theme T8) will re-emerge.

### 11.6 Definition of done per bucket / domain

A domain or bucket is "really measured" when:

- **No-op handlers don't gift state_hash** (P0-8 fixed) OR scenarios
  are explicitly tagged "read-only" with re-weighted scoring.
- **Canonical action vocabulary** — every emitted action name + kwargs
  shape has exactly one path that scores it (no 3-way disagreements).
- **Phrase-layer reachability for personality** — every styleKey /
  traitKey / variantKey is wired through the bridge.
- **LLM-judge JSON-parse rate ≥80%** on the bucket.
- **Stratified sampling** at the right axis for the bucket.
- **No orphan scenarios** referencing deleted actions.
- **CI gates** on manifest dedup + source-of-truth diff.
- **Headline pass-rates reflect real agent behavior**, not tooling
  artifacts.

Until those hold per benchmark, headline numbers stay tooling-bound.
