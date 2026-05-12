# Contacts benchmark deep-dive — W5-ctc

> Scope: 33 STATIC contacts scenarios in
> `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/contacts.py`
> plus 10 lifeops.identity TS scenarios under
> `test/scenarios/lifeops.identity/`. No fresh bench was run.
>
> Source data: the W4-Z spot-rerun (one contacts scenario only,
> `docs/audits/lifeops-2026-05-11/eliza-tool-call-fix.md` line 121); the
> `LIFEOPS_BENCH_GAPS.md` runtime contract; the `_u_entity` dispatch in
> `runner.py`. No saved per-scenario JSON exists for any contacts scenario
> in `~/.eliza/runs/lifeops/`: every multiagent and baseline run we have
> on disk targeted mail/calendar/reminder/sleep/focus only. The
> contacts/identity surface is **untested by the multiagent corpus**.

---

## 1. What this benchmark tests

Two distinct test surfaces share the "contacts" concept, with different
canonical action names and different scoring contracts.

### 1.1 LifeOpsBench (Python) — `ENTITY` umbrella

33 STATIC scenarios in `contacts.py` exercise the `ENTITY` umbrella with
4 subactions (`runner.py::_u_entity` lines 697-751):

| Subaction | Count | Mutation? | Notes |
|---|---:|---|---|
| `add` | 15 | **yes** | Creates a `Contact` in `world.contacts`. Fields read: `name`, `email`, `phone`, `entityId` (optional, otherwise `_synthetic_id`). |
| `set_identity` | 5 | **yes** | Updates `phones[]` or `primary_email` on an existing `contact_*` id. |
| `log_interaction` | 8 | **no-op** | Returns `{subaction, ok, noop:True}` unconditionally — there is no interaction log entity in LifeWorld. |
| `list` | 5 | **no-op** | Same no-op return. |

Read-only:write-op split = **13 : 20**. Almost two-thirds (20/33) mutate
state and need the state hash to match.

Scoring (`scorer.py:251-299`, STATIC weighting):
`0.5 × state_match + 0.4 × action_score + 0.1 × substring_score`.

**Triviality guard at line 290**: `if scenario.ground_truth_actions and
action_component == 0.0: state_component = 0.0; substring_component = 0.0`.
Without that guard, all 13 read-only (`list`/`log_interaction`) scenarios
would be free 0.6 for a do-nothing agent because the world doesn't change
between predicted and replayed runs.

### 1.2 lifeops.identity TS scenarios — `RELATIONSHIP` / `LIFE`

10 scenario files under `test/scenarios/lifeops.identity/`:

| Scenario | Focus |
|---|---|
| `identity.merge-2-platforms-same-person` | gmail + telegram merge |
| `identity.merge-4-platforms-same-person` | gmail + signal + telegram + discord (manifest "4-platform" test) |
| `identity.merge-after-handle-rename` | confirmed rename → merge + audit history |
| `identity.detect-likely-rename` | propose rename, ask for confirmation |
| `identity.unmerge-conflict-detected` | split two real people accidentally merged |
| `identity.search-across-handles` | retrieval across platforms |
| `identity.set-relationship-mom-priority` | typed relationship edge |
| `identity.tag-entity-as-VIP` | tagging surface |
| `identity.list-relationships-by-tag` | filtered list |
| `identity.detect-impersonation-attempt` | spoof flagging |

All ten expect `acceptedActions: ["RELATIONSHIP", ...]` (sometimes also
`"LIFE"` or `"INBOX"`). Scoring is the scenario-runner's selectedAction +
memoryWriteOccurred + judgeRubric stack — not the LifeOpsBench formula.

## 2. Per-harness headline

**There is no per-harness data to report.** Every multiagent and
baseline run in `~/.eliza/runs/lifeops/` (37 directories) targets
mail/calendar/reminders/sleep/focus. The closest signal is one row from
the W4-Z per-domain sanity rerun:

| Run | Scenario | Agent | Score | state_hash_match | First tool call |
|---|---|---|---:|---|---|
| W4-Z sanity | `contacts.add_new_freelance_collaborator` | eliza | 0.80 | True | `CONTACT_CREATE(name=Priya, ...)` |

That score is **mathematically suspicious** (see §3.1) — pending a
fresh contacts run, this is the only data point we have.

The CORE suite (`suites.py`) only includes 2 contacts scenarios:
`contacts.add_new_freelance_collaborator` (the W4-Z spot-test) and
`contacts.update_phone_for_caleb_nguyen`. The full 33-scenario corpus
runs only in the `full` suite, which is dispatch-only.

## 3. Five representative scenarios

### 3.1 W4-Z's only contacts data point: `contacts.add_new_freelance_collaborator`

Ground truth (`contacts.py:39-52`):

```python
Action(name="ENTITY", kwargs={
    "subaction": "add",
    "name": "Priya Singh",
    "email": "priya@studiosingh.example",
    "phone": "+14155550199",
    "channel": "email",
    "handle": "priya@studiosingh.example",
    "notes": "freelance illustrator",
})
```

W4-Z reports `0.80` with `state_hash_match=True` and first tool call
`CONTACT_CREATE(name=Priya, ...)`. The math doesn't add up:

- `CONTACT_CREATE` is **not** in `_ACTION_HANDLERS` (only `CONTACTS.add`,
  `CONTACTS.update`, `CONTACTS.delete`, and the umbrella `ENTITY` are).
- `_canonicalize_action` (scorer.py:93) only folds `CALENDAR_*` and
  `MESSAGE_*` prefixes. `CONTACT_CREATE` does not canonicalize to
  `ENTITY`.
- If the agent's only action is `CONTACT_CREATE`, `action_component = 0`
  and the triviality guard zeroes state + substring → total 0.0.

Two ways the 0.80 figure could be real:
1. The W4-Z agent emitted **two** tool calls: a hallucinated
   `CONTACT_CREATE` *and* a real `ENTITY(subaction='add', name='Priya
   Singh', email=..., handle=..., phone=..., notes=...)`. The runner's
   `_extract_actions_from_turn` collects all `tool_calls` on a single
   assistant turn, so the legitimate `ENTITY` call would score
   `name+kwargs match = 1.0`, state_hash matches because `_u_entity` is
   deterministic on (name, email) for the synthetic id (line 709-711),
   substring `"Priya"` matches → 0.5 + 0.4 + 0.1 = **1.0**, not 0.80.
2. The agent emitted a single `ENTITY` call with a kwargs *near*-match
   (e.g. missing `notes` or `handle`): name matches → 0.5 partial-credit
   → 0.5 state + 0.4 × 0.5 + 0.1 = **0.80**.

Either way, the audit doc's "first tool call: `CONTACT_CREATE`" is the
hallucinated similes-name from action-docs.ts:4651 — the planner picked
the simile string, but the executor only matched on the second umbrella
call. **The W4-Z table miscredits the score to the wrong tool call.**

### 3.2 Identity update on an existing seeded contact: `contacts.update_phone_for_caleb_nguyen`

The other CORE contacts scenario. Ground truth:

```python
Action(name="ENTITY", kwargs={
    "subaction": "set_identity",
    "entityId": "contact_00001",
    "platform": "phone",
    "handle": "+14155550247",
    "displayName": "Caleb Nguyen",
    "evidence": "owner provided new number directly",
})
```

`_u_entity` `set_identity` branch (runner.py:723-744): when
`platform=="phone"`, prepends `handle` to the contact's `phones` list
and pushes any existing matching number behind it. Determinism is
preserved (no synthetic ID generation needed). For state_hash to match,
the agent MUST emit:
- `subaction=set_identity` (not `update`, not `set_phone`)
- `entityId=contact_00001` (exact ID — the planner has no way to look
  this up from the instruction text, which gives the ID inline)
- `platform=phone`
- `handle=+14155550247` (exact phone — string equality, no number
  normalization)

This is **strictly harder than 3.1** because:
- It targets the bench-specific subaction name (`set_identity`) that
  doesn't appear in the runtime's CONTACT action ops (`create`, `read`,
  `search`, `update`, `delete`, `link`, `merge`, `activity`, `followup`
  per `packages/agent/src/actions/contact.ts:68`).
- It uses `entityId` not `contactId`/`id`.
- The runtime ENTITY action's `set_identity` op exists in the
  action-docs (4811) so the model has a path to the right name —
  provided it picks ENTITY over CONTACT.

Expected failure modes (no data to confirm): emit `CONTACT(op='update',
phone=...)`, `ENTITY(subaction='update_phone', phone=...)`, or
`set_identity` with `id=` instead of `entityId=`. All score 0.0 via the
triviality guard.

### 3.3 4-platform identity merge (lifeops.identity, not LifeOpsBench)

`identity.merge-4-platforms-same-person.scenario.ts` is the canonical
"manifest reads as 4-platform merge test" scenario. Seeds 4 rolodex
entities for one Jordan Kim (`gmail/jordan.kim@nova.io`,
`signal/+14155550199`, `telegram/@jkimnova`, `discord/jkim#4421`) and a
single user turn:

> "jordan.kim@nova.io, +14155550199 on Signal, @jkimnova on Telegram,
> and jkim#4421 on Discord are all Jordan Kim. Consolidate."

The assertion is `acceptedActions: ["RELATIONSHIP", "LIFE"]` (lines
80-91). But:

- The matcher `actionMatchesScenarioExpectation`
  (`packages/scenario-runner/src/action-families.ts:28-35`) is strict
  literal equality plus `<name>_*` underscore-prefix. It does **not**
  consult similes.
- The runtime's canonical merge action is `ENTITY(action=merge,
  sourceEntityIds=[...], entityId=<target>)` per action-docs.ts:3814,
  4622-4634. `RELATIONSHIP` is only listed as a *simile* on ENTITY
  (action-docs.ts:4651).
- If the planner emits the canonical `ENTITY`, the strict-literal
  matcher returns false → `selectedAction` final-check fails → scenario
  fails regardless of how well the agent merged.

So this scenario asserts on a name (`RELATIONSHIP`) that the runtime
does not produce. The only way to pass is to emit the simile string
literally — possible only if the planner happens to surface the simile
verbatim, which it usually doesn't.

The same gap applies to all 10 scenarios in `lifeops.identity/`. None
of them have been observed passing in any saved run on disk.

### 3.4 Partial-name disambiguation: `contacts.find_contact_by_partial_name_carter`

Ground truth: `ENTITY(subaction='list', intent='list contacts whose
family name is Carter', name='Carter')`. The snapshot seeds 8 Carters
across family/friend/acquaintance per the docstring (contacts.py:118-121).

`list` is a no-op (runner.py:745-748) — the world doesn't change.
Required output substring: `"Carter"`. Triviality guard fires unless the
agent emits a name-matching `ENTITY` action. If the agent emits anything
plausible (`ENTITY(subaction='list', name='Carter')`,
`ENTITY(subaction='search', name='Carter')`), name matches → 0.5 partial
credit → 0.5 × 1 (state, since list is no-op) + 0.4 × 0.5 + 0.1 × 1 =
**0.80**. Score is gated entirely by:

- Emitting `ENTITY` (not `CONTACT`, not `SEARCH_CONTACTS`, not
  `RELATIONSHIP`).
- Including the partial-name substring `"Carter"` in the reply.

The "did the agent actually disambiguate among 8 Carters" semantics is
**not scored** — the bench gives full credit for the right action name +
a substring, even if the model replies "I found 0 Carters" with no
disambiguation prose.

### 3.5 Family/work/friend tagging: `contacts.list_family_contacts` + `add_family_member_mia`

Two scenarios cover the family tag surface:

- `contacts.list_family_contacts` (line 124-144): ground truth
  `ENTITY(subaction='list', intent='list contacts where relationship is
  family')`. No `relationship` kwarg in the GT — only an `intent`
  string, which is a `_SOFT_KWARG` (scorer.py:47) and contributes
  nothing. The world's snapshot has `~6 family rows` per the docstring,
  but the Contact dataclass's `relationship` field accepts
  `"acquaintance" | "family" | ...` from a literal type that isn't
  enumerated here.
- `contacts.add_family_member_mia` (line 302-331): ground truth
  `ENTITY(subaction='add', name='Mia Reed', email='mía.reed@...',
  phone='+14155559876', channel='email', handle='mía.reed@...',
  notes='sister', intent='add family contact')`. The `notes='sister'`
  encodes the relationship, but `_u_entity::add` (line 712-720) only
  reads `relationship=kw.get("relationship", "acquaintance")` — and the
  GT does **not** pass `relationship`. So the contact is created with
  the default `"acquaintance"`, not `"family"`, even when the GT is
  replayed. The `notes` and `channel` kwargs are accepted by the runner
  but never persisted onto the `Contact` dataclass (entities.py:62-75
  has no `notes`, `channel`, `handle`, or `tags=['family']` derived
  from notes).

**This is the manifest's "weak support" line item for birthdays/photos
made manifest**: the seeded `Contact` has a `birthday: str | None`
field (entities.py:75) and the generator fills it for ~40% of contacts
(generators.py:377), but `_u_entity::add` (line 712-720) does **not**
forward `birthday` from kwargs. Photos don't exist anywhere on
`Contact`. Family-tag semantics partially exist on the dataclass
(`relationship`, `tags`) but the `add` subaction does not surface
either to scenarios — only `relationship` via an explicit `relationship`
kwarg that no contacts scenario currently emits.

## 4. Harness behavior patterns (predicted, not measured)

Without saved per-scenario JSON for contacts, this section is a
prediction informed by the calendar/mail patterns documented in
`benchmark-deep-dive-calendar.md` and the action-docs.ts surface.

### 4.1 Eliza

The action-docs.ts file lists **both** `ENTITY` and `CONTACT` as
top-level actions:

- `ENTITY` (line 3814) with subactions `create | read | log_interaction
  | set_identity | set_relationship | merge`. **Uses `create`, NOT
  `add`** — directly contradicting the bench's `_u_entity` which
  requires `subaction='add'`.
- `CONTACT` (`packages/agent/src/actions/contact.ts:68-79`) with ops
  `create | read | search | update | delete | link | merge | activity |
  followup`. The bench does **not** route `CONTACT` calls — only the
  fine-grained `CONTACTS.add` / `CONTACTS.update` / `CONTACTS.delete`
  (with the trailing `S`, runner.py:1044) and the umbrella `ENTITY`.

So eliza's planner will emit `ENTITY(action='create')` or
`CONTACT(op='create')`. Neither matches the GT
`ENTITY(subaction='add')`:
- `ENTITY(action='create')` — name matches, kwargs miss
  (`action` vs `subaction`, `create` vs `add`). Partial credit 0.5 →
  score 0.30 at best.
- `CONTACT(op='create')` — name does not match `ENTITY` → 0.0 via
  triviality guard.

**Predicted eliza pattern:** mid-0.20 to mid-0.30 mean on the 20
write-op scenarios, mid-0.80 on the 13 read-op scenarios *if* eliza
happens to call `ENTITY` at all.

### 4.2 Hermes / OpenClaw

Both share the OpenAI-compat tool surface, so they see the same tool
manifest. Per `benchmark-deep-dive-calendar.md` §4.2/4.3, both tend
toward single-shot tool calls with snake_case args. Predicted same
behavior here — likely 0.20 floor on write-ops because they don't
multi-turn the `subaction` discriminator.

### 4.3 Cross-harness assessment

No harness has a structural advantage for contacts because the
fundamental problem is **vocabulary drift** between four code paths:

1. Bench runner expects `ENTITY(subaction='add')`.
2. action-docs.ts publishes `ENTITY(action='create')`.
3. `contact.ts` publishes `CONTACT(op='create')`.
4. lifeops.identity scenarios assert `RELATIONSHIP`.

The planner picks (2) or (3) → bench scores (1) → result is consistent
sub-0.50 across all harnesses.

## 5. Eliza improvement plan

### 5.1 Vocabulary alignment (highest ROI, low risk)

The four-way mismatch in §4.3 is the single biggest score lever for
contacts. Concrete moves:

1. **Either rename `_u_entity` to accept `subaction='create'` as a
   simile for `add` (and `update` for `set_identity`'s rolodex
   semantics)**, OR align action-docs.ts's `ENTITY.action` enum to
   `add | read | set_identity | set_relationship | log_interaction |
   merge`. The runtime is the system of record, so the runner should
   accept what the runtime emits — flip `_u_entity` not the runtime.
2. **Merge the `CONTACT` action's `create/update/delete` ops into the
   `ENTITY` umbrella.** `packages/agent/src/actions/contact.ts`
   currently exposes a CRUD action surface that does the same work as
   `ENTITY` from the bench's perspective. Keep `CONTACT` for `read`,
   `search`, `activity`, `followup` (genuinely different surfaces) but
   delete the duplicate `create/update/delete/merge/link` ops or have
   them dispatch to the same handlers as `ENTITY`. Today the planner
   sees both and picks inconsistently.
3. **lifeops.identity scenarios: replace `acceptedActions:
   ["RELATIONSHIP", "LIFE"]` with `["ENTITY", "CONTACT"]`** to match
   the actually-emitted action names. The current literal-equality
   match guarantees these scenarios cannot pass against a correctly
   working runtime.

Estimated mean lift on the 33-scenario contacts corpus: **+0.20 to
+0.30** for eliza, mostly on write-op scenarios. None of these moves
require a model change.

### 5.2 Manifest description tightening

The `ENTITY` action description in `runner.py:132-135` is:

> "Manage people and identity records. Use subaction=add, set_identity,
> log_interaction, or list."

`add` is unusual phrasing. Most CRUD APIs use `create`. The model's
prior is biased toward `create`. Two safe edits:

- Add an explicit "use `add` NOT `create`" sentence in the description.
- In `action-docs.ts:3815` revise: replace the "Subactions: create,
  read, set_identity, ..." line with "Subactions: add (create new
  contact), read, set_identity, set_relationship, log_interaction,
  merge".

### 5.3 Birthday / photo / tag persistence (medium ROI, requires LifeWorld extension)

The manifest reads "contacts: people, family/work/friend tags / Weak:
birthdays, photos" (spec.md:139). Today:

- `birthday` field exists on the `Contact` dataclass but is dropped
  from kwargs by `_u_entity::add` (line 712-720). Add `birthday=kw.get
  ("birthday")` to the constructor call. Zero-cost.
- No `photo` field on `Contact`. Either add it as `photo_url: str |
  None = None` and accept `photo_url` kwarg, or remove the "photos"
  claim from the spec.
- `tags` field exists on `Contact` (line 74) but `_u_entity::add` does
  not read it. The `add_family_member_mia` scenario relies on
  `notes='sister'` for relationship — flimsy. Pass `tags=kw.get("tags",
  [])` and write a scenario that asserts `tags=['family']`.

These three together unlock writing **scoreable** birthday/photo/tag
scenarios. Currently the closest test is `add_family_member_mia` and
it cannot distinguish "agent added Mia as family" from "agent added Mia
as acquaintance" because the relationship discriminator never reaches
the world.

### 5.4 Identity merge surface (LifeOpsBench has zero coverage)

The 10 lifeops.identity TS scenarios (merge-2/4-platforms, unmerge,
rename, search-across-handles, set-relationship, tag-VIP,
list-by-tag, detect-impersonation) are entirely outside LifeOpsBench.
Three options:

1. Port them to LifeOpsBench: needs `_u_entity::merge` (currently
   absent) plus a `Contact.handles[{platform, handle}]` field. Largest
   bench coverage win possible — the merge surface is high-stakes and
   currently unmeasured.
2. Fix the `RELATIONSHIP` → `ENTITY`/`CONTACT` matcher gap (§5.1.3)
   and run them through the scenario-runner harness. Cheapest fix.
3. Both. The scenario-runner path measures judge-rubric prose quality
   ("did you enumerate all 4 handles"); the LifeOpsBench port would
   measure deterministic state correctness (one entity with 4
   identities post-merge). They're complementary.

### 5.5 Handle-rename survival (`identity.merge-after-handle-rename`)

This is the only existing scenario that tests the "handle rename"
edge case. It seeds a `rolodex-entity` with `oldHandle` and `newHandle`
on the same `platform`, asks for confirmation + merge. To make it
scoreable in LifeOpsBench, the world needs:

- A `rename_events` ledger or an `identity_history[{old, new, at}]`
  list on `Contact`.
- A `_u_entity::merge` handler that consumes the rename and writes the
  audit row.

Without those, the only signal is the scenario-runner's judge rubric
— which is good for catching "did the model preserve the old handle"
but doesn't anchor the test to deterministic state.

## 6. Cross-cutting observations

- **No saved data**: the multiagent corpus on disk has zero contacts
  rows. The W4-Z one-shot sanity row is the only data point and (per
  §3.1) appears miscredited. Running CORE (which includes 2 contacts
  scenarios) against the rebaseline set should be priority-zero for any
  contacts work — we're flying blind right now.
- **Triviality guard makes contacts especially fragile**: 13 of 33
  scenarios are pure no-ops at the world level. If the agent fails to
  emit `ENTITY` (i.e. emits `CONTACT`, `SEARCH_CONTACTS`, etc.), all 13
  collapse to 0.0 via the guard rather than the trivial 0.6 free pass.
  Vocabulary alignment (§5.1) recovers them all simultaneously.
- **The fine-grained `CONTACTS.add/.update/.delete` handlers exist in
  `_ACTION_HANDLERS` (runner.py:1044-1046) but no contacts scenario
  uses them.** They are dead code for the contacts.py corpus. Either
  delete them or migrate some scenarios to the granular form to test
  both vocabularies.
- **`LifeOpsFakeBackend` (the TS-side fake backend used by the eliza
  benchmark plugin) does NOT implement `contacts.create` /
  `contacts.update` / `contacts.delete`** — see
  `lifeops-bench-handler.gaps.md:37`. Only `contacts.search` is wired.
  This is fine today because the bench runner uses the Python
  `_u_entity` path, not `LifeOpsFakeBackend.applyAction()`. But if the
  bench server's lifeops-fake-backend route is ever wired up for
  contact-creating scenarios, it will throw `LifeOpsBackendUnsupportedError`.

## 7. Recommended actions (priority order)

1. **Run `--suite core` against the rebaseline corpus to get actual
   contacts numbers.** Two scenarios is barely a signal but it's
   non-zero and lets us calibrate predictions in §4.
2. **Align the vocabulary**: pick one of {ENTITY.add, ENTITY.create,
   CONTACT.create} and propagate. Cheapest: add an `add` alias for
   `subaction:'create'` in `_u_entity`. (§5.1.1)
3. **Fix the `RELATIONSHIP` matcher gap** for the 10 lifeops.identity
   scenarios by changing `acceptedActions` to the runtime-canonical
   `["ENTITY", "CONTACT"]`. (§5.1.3)
4. **Forward `birthday`, `tags`, and `relationship` kwargs through
   `_u_entity::add`** so the spec's "weak support" line stops being
   weak. (§5.3)
5. **Port the merge scenarios to LifeOpsBench** once `_u_entity::merge`
   exists. (§5.4)
6. **Delete dead code**: `CONTACTS.add/.update/.delete` handlers in
   `_ACTION_HANDLERS` that no scenario references. (§6)
