# Finance benchmark deep-dive — W5-fin

> Scope: 17 STATIC + 30 LIVE finance scenarios in `eliza_lifeops_bench`, plus
> 1 hand-authored TS scenario (`payments.plaid-mfa-fail`) in
> `test/scenarios/lifeops.payments/`.
> No saved per-scenario JSON exists for the finance domain in
> `~/.eliza/runs/lifeops/` — the multiagent-best run only covers calendar.
> This audit is sourced directly from scenarios + handler code + seed data.

## 1. What this benchmark tests

The finance benchmark exercises the elizaOS `OWNER_FINANCES` umbrella
(registered name; the scenario corpus and runner still use the legacy
`MONEY` / `MONEY_*` names — they are aliases via `MONEY_LEGACY_SIMILES` in
`plugins/app-lifeops/src/actions/money.ts`). The umbrella dispatches by
`subaction` to either the PAYMENTS handler or the SUBSCRIPTIONS handler:

| Family | Subactions |
|---|---|
| payments (read) | `dashboard`, `list_sources`, `list_transactions`, `spending_summary`, `recurring_charges` |
| payments (write) | `add_source`, `remove_source`, `import_csv` |
| subscriptions | `subscription_audit`, `subscription_cancel`, `subscription_status` |

Subaction names in the corpus use the literal `subaction` discriminator
(e.g. `subaction="dashboard"`, `subaction="cancel"`) — note that
`subscription_*` verbs are stripped by `money.ts` (`SUBSCRIPTION_PREFIX`)
before being handed to `runSubscriptionsHandler`, which then sees the bare
`audit` / `cancel` / `status` value. Scenarios pass the full
`subscription_cancel` name and the runtime is responsible for routing.

### Scoring path

Python LifeOpsBench scorer (STATIC) weights state-hash 0.5 + action-name
0.4 + substring 0.1. All finance `MONEY_*` verbs are read-only in the
runner except `MONEY_SUBSCRIPTION_CANCEL`:

- `_u_money_readonly` returns `noop=True` for every read verb (dashboard,
  list_transactions, list_sources, recurring_charges, spending_summary,
  subscription_status).
- `_u_money_subscription_audit` is also a no-op (the seed has 8
  pre-existing subscriptions; the audit only reads).
- `_u_money_subscription_cancel` is the **only mutation**: when
  `confirmed=true`, it resolves the subscription by `serviceSlug` first,
  then exact `serviceName`, then substring-match on name, and calls
  `world.cancel_subscription(target_id)`. Missing slug+name → `KeyError`.
  `confirmed=false` is a no-op with `reason="unconfirmed"`.

So out of 17 STATIC finance scenarios:

| Verb | Count | Mutates? |
|---|---:|---|
| `MONEY_DASHBOARD` (subaction=dashboard) | 5 | no |
| `MONEY_LIST_TRANSACTIONS` | 2 | no |
| `MONEY_SPENDING_SUMMARY` | 2 | no |
| `MONEY_RECURRING_CHARGES` | 1 | no |
| `MONEY_SUBSCRIPTION_AUDIT` | 3 | no |
| `MONEY_SUBSCRIPTION_STATUS` | 2 | no |
| `MONEY_SUBSCRIPTION_CANCEL` | 3 | yes (Netflix, Disney+, Spotify) |

Read:write split is **14 : 3** — far more skewed read-only than calendar.
14 of 17 scenarios trivially pass `state_hash_match` because they don't
mutate. The hard scoring signal lives in the 3 cancel scenarios + the
substring requirement on the 14 reads (`required_outputs` strings like
`"category"`, `"travel"`, `"recurring"`, `"Q2"`, `"365 days"`, `"income"`).

## 2. Per-harness headline

**No saved run data for finance.** The "best" multiagent run
(`~/.eliza/runs/lifeops/lifeops-multiagent-best/`) only contains 25
calendar scenarios across `eliza`, `hermes`, `openclaw`. No
`scenario_id.startswith("finance.")` entries exist in any saved JSON I
could scan in `~/.eliza/runs/lifeops/`. The Python finance corpus
(17 static + 30 live = 47 scenarios) appears to have never been executed
end-to-end and persisted under that run dir.

The single hand-authored TS scenario `payments.plaid-mfa-fail` lives at
`test/scenarios/lifeops.payments/payments.plaid-mfa-fail.scenario.ts` —
this is the W1-era scenario, the only TS-side finance scenario, and is
itself marked `BLOCKED-ON-MOCKOON` (see §3.1). Whether it has actually
been wired into a current bench harness is unverified within the scope of
this audit.

Conclusion: the entire finance corpus is **dark** — there is no headline
number to cite, only the static structure of the scenarios and the
implementation that would respond to them.

## 3. Five representative scenarios

### 3.1 `payments.plaid-mfa-fail` (TS hand-authored)

The only authored adversarial finance scenario. Seeds a row into
`app_lifeops.life_payment_sources` with `status='needs_reauth'` and
`metadata_json` carrying `error_code='ITEM_LOGIN_REQUIRED'`,
`provider='plaid'`. User message:
> "What's the status of my linked bank accounts? I tried connecting
> Chase yesterday but I'm not sure if it worked."

Expected action: `PAYMENTS` (now `OWNER_FINANCES`). Final checks:

1. `actionCalled name=PAYMENTS minCount=1`
2. Custom predicate (`checkAgentSurfacesActionableError`):
   - The PAYMENTS action's serialized result must contain one of
     `needs_reauth`, `mfa`, `item_login_required`, `login_required`,
     `requires re-auth`, …
   - The user-facing reply must mention one of `re-auth`, `re-link`,
     `verify`, `expired`, `failed`, `can't`, `unable`, …
   - The reply must NOT contain `successfully linked`, `all set`,
     `looks healthy`, `everything looks good`, `no issues`.
3. Judge rubric (threshold 0.7): score 0 if the agent claims success.

The scenario is correctly structured to catch the canonical failure mode
("LARPing success on a broken bank link"). But:

- **It is gated on Mockoon (`BLOCKED-ON-MOCKOON`).** There is no
  `plaid.json` mockoon environment, so the Plaid HTTP round-trip is
  never actually exercised. The scenario only verifies the
  database-read+report path, not the link-token-exchange code.
- It seeds via `executeRawSql` directly into the lifeops schema rather
  than going through `service.addPaymentSource(...)`, which makes the
  seed brittle to schema migrations — if the column set changes, the
  scenario silently fails to seed and the predicate still runs against
  zero rows (and would presumably fail with "expected PAYMENTS to be
  invoked").
- The scenario is **W1-era** and the bench has moved on. The Python
  finance corpus doesn't include any Plaid-failure equivalent.

### 3.2 `finance.spending_summary_last_week` (STATIC, read-only)

> "how much did I spend in the last 7 days, broken down by category?"

Ground-truth action: `MONEY_DASHBOARD(subaction=dashboard, windowDays=7)`,
`required_outputs=["category"]`. This is the trivial happy path:

- State unchanged → `state_hash_match=true` → 0.5.
- Agent must emit a `MONEY` family action with the right subaction → 0.4
  if it routes correctly, less if it picks `MONEY_SPENDING_SUMMARY`
  (close but technically a different action name; the bench's exact-name
  comparison would treat that as partial).
- The reply must include the literal substring `"category"` → 0.1.

The score floor for an agent that emits any `MONEY*` call and returns a
plausible reply is high (0.5 from state alone). The signal in this
scenario is mostly substring presence — does the agent enumerate
categories in its reply?

### 3.3 `finance.cancel_disney_plus` (STATIC, write)

> "Cancel my Disney+ subscription (sub_004). Yes, I'm sure — please go
> ahead."

Ground truth:
```
MONEY_SUBSCRIPTION_CANCEL(
  subaction=cancel, serviceName="Disney+",
  serviceSlug="disney-plus", confirmed=true
)
```

The runner's `_u_money_subscription_cancel`:
1. Returns no-op `reason="unconfirmed"` if `confirmed` is falsy. **Agent
   must remember to pass `confirmed=true` — the persona pre-confirmed in
   the instruction.**
2. Resolves first by exact slug-match
   (`sub_name.replace(" ", "-").replace("+", "-plus")` so `disney+` →
   `disney-plus`), then by exact case-insensitive `serviceName`, then by
   substring fallback. Subscription `sub_004` (Disney+, active) matches.
3. Calls `world.cancel_subscription("sub_004")` and returns
   `status="cancelled"`.

State hash now changes. If the agent emits the wrong slug
(`disneyplus`, `disney`) it falls through to the substring path which
still resolves Disney+ — the matcher is permissive. But if the agent
forgets `confirmed=true`, the cancel is a silent no-op, state hash
matches the original (no cancellation), and the scorer falsely
**rewards** a non-cancellation because the world wasn't mutated and the
state hash trivially matches. This is a latent scoring bug in the
write-op pipeline: the action ran, returned `ok=true,noop=true`, the
world is unchanged, state-hash matches "the world after a successful
cancel" only if we compare against the *pre-cancel* hash — which is
what `state_hash_match` actually does for unconfirmed cancels. Without
running this it's not 100% provable, but the code path is concerning.

### 3.4 `finance.recurring_charges_last_180` (STATIC)

> "List any recurring charges I have incurred over the past six months."

Ground truth: `MONEY_RECURRING_CHARGES(subaction=recurring_charges,
windowDays=180)`, `required_outputs=["recurring"]`.

The runtime side calls `service.getRecurringCharges(...)`, which
ultimately routes to `detectRecurringCharges()` in
`plugins/app-lifeops/src/lifeops/payment-recurrence.ts`. The detector:

1. Filters to `direction=debit`.
2. Groups by `merchantNormalized` (a regex-based normalizer that
   collapses `"NETFLIX.COM 866-579-7172 CA"` → `"netflix"`). Heuristic
   only — it strips TLDs, phone numbers, `#refs`, dollar amounts, state
   codes, and clamps to the first 3 tokens.
3. For each group with ≥2 transactions, computes intervals between
   sorted `postedAt` timestamps and classifies cadence:
   `weekly` (5–9d), `biweekly` (12–16d), `monthly` (25–35d),
   `quarterly` (85–95d), `annual` (350–380d), else `irregular`.
4. Computes amount similarity (1 - stddev/mean) and a confidence score
   weighted: cadence baseline (0.55 for known cadence, 0.20 for
   irregular) + occurrence boost + interval-consistency + amount-similarity.
5. Skips groups where cadence is irregular AND amount similarity < 0.7
   (kills Amazon noise) — but keeps irregular groups with very similar
   amounts.

This is precisely the "weak" recurring detector the bench manifest
flagged. Concretely:

- A monthly subscription that bills on the 1st of one month, the 30th of
  the next, the 28th of the next would alternate intervals of ~30, ~29,
  ~29 days — stays inside the 25–35d monthly band, fine. But a
  subscription that bills on the 1st of Feb (28-day month) and the 28th
  of Feb the next year drifts; quarterly billers near the 95-day edge
  fall into `irregular`.
- Annual classification (350–380d) needs at least 2 occurrences spanning
  ≥350d — with `windowDays=180` set by the scenario, the detector
  receives a window of transactions that *cannot* contain two annual
  recurrences. Annual subscriptions are systematically invisible at
  windowDays=180 unless the service is re-fetching outside the window
  (it isn't — the service-side `windowDays` is honored for the query).
- The seed has 8 subscriptions but they live in the `subscription`
  store, not the `transaction` store. **There's a structural disconnect**:
  the bench `MONEY_RECURRING_CHARGES` no-ops at the LifeWorld layer and
  the only signal in the score is substring-`"recurring"` in the reply.
  The actual `detectRecurringCharges` function isn't even exercised by
  the static bench — it would only matter in a live integration test
  against a populated `transaction` store with the same merchant
  appearing multiple times. The 600 seed transactions span 11 categories
  but I haven't verified whether any single merchant recurs ≥2 times.

### 3.5 `finance.list_travel_spending_q1` (STATIC, read)

> "List every travel-category transaction posted between 2026-01-01 and
> 2026-03-31, grouped by merchant."

Ground truth: `MONEY_LIST_TRANSACTIONS(subaction=list_transactions,
merchantContains="", windowDays=120)`, `required_outputs=["travel"]`.
`first_question_fallback`: "All accounts, debits only."

The scenario tests transaction time-range queries. Two
implementation/spec mismatches stand out:

- The user asks for a date *range* (`2026-01-01 to 2026-03-31`), but the
  ground-truth kwargs translate that into a rolling-window `windowDays=120`.
  120 days backward from "now" (`now_iso` per scenario) is **not** Q1
  2026 unless `now_iso` happens to be ~late April 2026. Per the seed's
  date range (txn_000000 is dated `2026-02-16T01:00:00Z`, last txn
  presumably in May per the seed snapshot meta), the bench effectively
  ignores the date-range semantics and accepts any 120-day window. An
  agent that emits a precise `startDate`/`endDate` filter would *miss*
  the partial-name match.
- The handler-side `listTransactions` only supports `merchantContains`,
  `onlyDebits`, `sourceId`, `limit` — there's no `category` filter and
  no date-range filter. The agent must list everything in a 120-day
  window and then filter for `category=travel` in its reply (substring
  `"travel"` is the only check).

This is a category-filtering blind spot: 4 of 17 static scenarios
(`spending_summary_last_week`, `list_travel_spending_q1`,
`monthly_spending_breakdown_work`, `monthly_summary_13`) require the
agent to filter or break down by category in the *reply text* because
the underlying action returns the full list. The "weak" labeling on
recurring extends here: the action returns coarse data and the bench
scores on the agent's narration.

## 4. Failure modes

Patterns visible from the scenarios + handler code, even without per-run
scoring data:

### 4.1 Plaid MFA / re-auth: under-tested

Only the one TS scenario covers this, and it's gated on a Mockoon
environment that doesn't exist (`test/mocks/environments/plaid.json`
absent). The Python corpus has zero negative-path scenarios for Plaid
failures, expired tokens, rate-limit errors, or partial-account-sync
states. The MONEY umbrella exposes `add_source` with `kind=plaid` but
nothing in the static bench exercises a failure return.

### 4.2 Subscription cancel: silent-no-op on missing `confirmed`

`_u_money_subscription_cancel` returns `noop=True, reason="unconfirmed"`
when `confirmed != true`. The LifeWorld doesn't mutate, state hash
matches the pre-cancel hash, and the action name still partial-matches
`MONEY_SUBSCRIPTION_CANCEL` — so an agent that emits the cancel but
forgets `confirmed=true` likely **scores higher** than one that emits
the right call with `confirmed=true` and gets a real cancellation
(latter changes state hash; if scoring compares against post-cancel
ground-truth state, the silently-unconfirmed call still partial-credits
on action-name match). This bench-side scoring asymmetry rewards
*timidity* in the destructive path. Worth a follow-up to verify against
real run output.

### 4.3 Browser-flow cancel: real playbooks exist, bench never exercises them

`plugins/app-lifeops/src/lifeops/subscriptions-playbooks.ts` defines
~40 service playbooks (Netflix, Hulu, Disney+, Max, Peacock, Paramount+,
Apple TV+, Amazon Prime, YouTube Premium, Crunchyroll, ESPN+, Spotify,
Apple Music, Tidal, Pandora, SiriusXM, NYTimes, WSJ, WaPo, Atlantic,
Medium, Substack, Bloomberg, iCloud+, Google One, Dropbox, MS 365,
Adobe CC, Canva, Notion, Evernote, 1Password, Google Play, Apple
subscriptions, …). Only Google Play and Apple subscriptions have actual
browser-automation `steps` (open URL → wait for "Subscriptions" →
click "Cancel subscription" → confirm → screenshot). The other ~38
playbooks have `steps: undefined`, which causes the cancel flow to
return `unsupported_surface` with `error=PLAYBOOK_NOT_IMPLEMENTED:...`
and `needsHuman: true` — flagged as `requiresConfirmation` to surface
"I can open the page but I don't know the click-flow yet". This is the
**right** failure mode, but:

- The bench scenarios (`finance.cancel_netflix`, `cancel_disney_plus`,
  `cancel_spotify_subscription`) score on the no-op LifeWorld mutation,
  not on whether the real playbook actually executed. The agent gets
  full credit for emitting `MONEY_SUBSCRIPTION_CANCEL(confirmed=true)`
  even though, in a real runtime, that call would land on
  `PLAYBOOK_NOT_IMPLEMENTED` for Netflix/Disney+/Spotify (none have
  `steps`). The fixture-streaming / fixture-login-required /
  fixture-phone-only playbooks DO have steps and exist for unit-testing
  the browser flow, but the bench scenarios don't target them.

- The four "needs human" statuses (`needs_login`, `needs_mfa`,
  `retention_offer`, `phone_only`, `chat_only`, `awaiting_confirmation`,
  `blocked`) are detected by keyword markers (`loginMarkers`,
  `mfaMarkers`, `phoneOnlyMarkers`, …) that the playbook applies to
  page text after each step. No bench scenario exercises this branch.

### 4.4 Categorization: aggregation is correct, mapping is exogenous

`computeSpendingSummary` in `service-mixin-payments.ts` aggregates by
the raw `category` field on each transaction — it does NOT classify
anything itself. The category strings come from one of:

- Plaid's `personal_finance_category.detailed` (or `primary`, or first
  legacy `category` array entry) — see lines 1325–1340 of
  `service-mixin-payments.ts`.
- CSV import `categoryColumn`.
- Manual user entry.

So "categorization quality" in the bench is really "what strings did
the seed put on each transaction." The seed uses 11 fixed buckets
(travel/utilities/groceries/transit/fuel/pharmacy/coffee/entertainment/
dining/shopping/tech) — none of which match Plaid's actual category
taxonomy. The bench is **not testing categorization**; it's testing
whether the agent's reply mentions one of these strings.

### 4.5 Income vs spending: shared `dashboard` verb is overloaded

`finance.list_monthly_income` asks for an income summary but maps to
`MONEY_DASHBOARD(windowDays=30)` — the same action as the spending
summary scenarios. The dashboard returns both income and spend; the
agent has to narrate income-only. No dedicated income/payroll verb
exists. With a substring requirement of `"income"`, an agent that
responds "Here's your 30-day summary: $X spent across…" without ever
mentioning income would fail; an agent that just echoes "income" once
in the reply passes the substring check regardless of correctness.

### 4.6 Time-range queries: no first-class date-range support

`listTransactions` only accepts `limit`, `sourceId`, `merchantContains`,
`onlyDebits`. No `since`, `until`, `startDate`, `endDate`. Scenarios
like Q1 / Q2 / last-month / last-365-days are translated to rolling
`windowDays` by ground-truth kwargs — but the *user* asks in
absolute-date terms ("Q1 2026 (Jan-Mar)"). The agent can either:

- Emit `windowDays=N` matching ground truth (lucky alignment), or
- Emit no window (defaults), or
- Try to use a non-existent date filter and fail the schema validation.

The "spending on coffee last month" intent specifically can't be
satisfied by the current MONEY action set — there's no `category=`
parameter on `list_transactions`. Coffee-substring on merchant might
partly work (Starbucks, Blue Bottle, etc.) but it's brittle.

## 5. Recommendations

### 5.1 High confidence: implement Plaid mockoon environment

`test/mocks/environments/plaid.json` is referenced by the existing TS
scenario but doesn't exist. Until it lands, the only authored adversarial
finance scenario is half-mocked (DB seed only) and never exercises the
real `link/token/exchange` failure path. Mockoon stub should at minimum
return `ITEM_LOGIN_REQUIRED`, `RATE_LIMIT_EXCEEDED`, and
`INSTITUTION_DOWN` responses for the same input shape. Add a sibling
scenario per failure code.

### 5.2 High confidence: fix the silent-noop-rewards-cancel scoring path

`_u_money_subscription_cancel` should raise (or set a distinct error
sentinel) when `confirmed != true` AND the persona's instruction
contains an explicit confirmation ("Yes, I'm sure"). Otherwise the
scorer treats "forgot to confirm" identically to "successfully
cancelled" because both leave LifeWorld unchanged. Alternatively, the
scorer can compare against the **post-mutation** ground-truth state
hash, which it claims to do — verify by inspecting one cancel
scenario's `state_hash_match` field once finance is actually run.

### 5.3 High confidence: add `category` and date-range params to `list_transactions`

The handler at `payments.ts:177-189` only filters by `sourceId`,
`merchantContains`, `onlyDebits`, `limit`. Add `category`,
`categoryContains`, `since`, `until`. Update the bench scenarios for
Q1/Q2/category-list to use these directly. This collapses 4 scenarios
that currently rely on the agent's reply-time narration to real
action-level filtering, which is what the scorer should measure.

### 5.4 Medium confidence: schedule a real finance bench run

The 17 static + 30 live scenarios have never been run-and-saved. Even
one run of the `perfect` agent (which mechanically emits ground-truth
actions) would surface schema mismatches, missing handlers, and
substring-check brittleness. Cost is bounded: 17 STATIC scenarios at
≤6 turns each, no judge model needed for the action-emitter agent.

### 5.5 Medium confidence: tighten recurring-charge detection contract

`detectRecurringCharges()` is solid as a heuristic but the bench never
exercises it because the recurring-charges scenarios pass through the
LifeWorld no-op layer. To actually score recurring detection:

- Seed the `transaction` store with at least three monthly-recurring
  merchants (Netflix at $15.99 on the 6th, Spotify at $9.99 on the
  4th, Disney+ at $13.99 on the 19th — matching the seed's
  `subscription` rows but materialized as actual charges).
- Add a `finance.recurring_detection_accuracy` scenario whose
  `required_outputs` include all three merchant names and whose
  scoring inspects the action's `data.charges` array length and
  confidence values, not just a substring match.

### 5.6 Medium confidence: collapse playbook-not-implemented services

37 of the playbooks have `steps: undefined`. They're effectively
"management URL only" entries dressed up as playbooks. Either:

- Implement real `steps` for the top 5 (Netflix, Hulu, Disney+,
  Spotify, Amazon Prime) so the cancel flow can actually run, or
- Move them to a separate `LIFEOPS_SUBSCRIPTION_KNOWN_URLS` constant
  with no `cancellationCapability` field — they're not playbooks, they
  are URL hints. The current shape encourages an agent to call
  `subscription_cancel` for Netflix and assume it will work, when in
  fact every such call returns `unsupported_surface` /
  `PLAYBOOK_NOT_IMPLEMENTED`.

### 5.7 Low confidence: split MONEY into PAYMENTS + SUBSCRIPTIONS umbrellas again

The umbrella collapse (`MONEY` → `OWNER_FINANCES` with prefix-based
routing in `money.ts`) was driven by similes/registry hygiene, but the
two backends share zero state or types. A planner that emits
`OWNER_FINANCES_SUBSCRIPTION_CANCEL` has to know the `subscription_`
prefix is magic. Splitting back would clarify the bench manifest and
let `subscription_*` use its own subaction enum without prefix-stripping.
This is a code-readability concern, not a bench correctness issue.

## 6. Cross-cutting notes

- **No baseline finance score exists.** All quantitative claims in the
  W5 audit cycle about "finance pass rate" or "recurring detection
  accuracy" would be fabricated unless backed by a real run. The
  bench-results corpus I scanned (~25 multiagent + ~10 single-agent
  runs in `~/.eliza/runs/lifeops/`) contained 0 finance scenarios.
- **The MONEY action vocabulary aliasing layer is large.**
  `MONEY_LEGACY_SIMILES` in `money.ts` lists 13 user-facing similes
  (`PAYMENTS`, `SUBSCRIPTIONS`, `SPENDING`, `ROCKET_MONEY`, `BUDGET`,
  `EXPENSES`, `CANCEL_NETFLIX`, `CANCEL_HULU`, …). The runner's
  `_TOOL_DESCRIPTIONS` has 9 MONEY_* tool entries. The manifest export
  surfaces 12 `OWNER_FINANCES_*` entries. There are at least three
  source-of-truth lists for "what verbs exist in the finance domain"
  and they don't agree edge-to-edge. Pick one and have the others
  generate from it.
- **Seed data is sane.** 600 transactions, 8 subscriptions (1 paused,
  1 cancelled, 6 active), 11 categories, dates in early-to-mid 2026.
  This is fine for the existing scenarios.

## 7. Files touched / referenced

- `plugins/app-lifeops/src/actions/money.ts` — umbrella dispatcher,
  legacy similes, parameter schema.
- `plugins/app-lifeops/src/actions/payments.ts` — payment subaction
  handler (dashboard/list_sources/add_source/remove_source/import_csv/
  list_transactions/spending_summary/recurring_charges).
- `plugins/app-lifeops/src/actions/subscriptions.ts` — subscription
  subaction handler (audit/cancel/status), in-handler LLM planner
  fallback, browser-task envelope.
- `plugins/app-lifeops/src/lifeops/payment-recurrence.ts` —
  `detectRecurringCharges` with merchant normalization, cadence
  classification, confidence scoring.
- `plugins/app-lifeops/src/lifeops/service-mixin-payments.ts` —
  spending-summary aggregation, Plaid transaction ingestion,
  category extraction.
- `plugins/app-lifeops/src/lifeops/service-mixin-subscriptions.ts` —
  subscription cancel orchestration, playbook execution,
  browser-result classification.
- `plugins/app-lifeops/src/lifeops/subscriptions-playbooks.ts` — 40+
  service playbooks, only 2 (Google Play, Apple subscriptions) with
  real `steps`; rest are URL hints.
- `test/scenarios/lifeops.payments/payments.plaid-mfa-fail.scenario.ts`
  — only TS-side finance scenario; blocked on Mockoon.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/finance.py`
  — 17 STATIC scenarios.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/finance.py`
  — 30 LIVE scenarios (open-ended, judge-scored).
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/runner.py:1050-1099`
  — `_u_money_readonly`, `_u_money_subscription_audit`,
  `_u_money_subscription_cancel`.
- `packages/benchmarks/lifeops-bench/data/snapshots/medium_seed_2026.json`
  — 600 transactions, 8 subscriptions.
- `packages/benchmarks/lifeops-bench/LIFEOPS_BENCH_GAPS.md` — calls out
  the MONEY rename, no-op semantics for read verbs.

