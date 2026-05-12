# Personality benchmark — `escalation` bucket deep-dive — W5-esc

> Source run: `~/.milady/runs/personality/personality-multiagent-best/`
>   (multiagent-1778553884807; 25 scenarios × 4 profiles)
> Source scenarios: `test/scenarios/personality/escalation/` (40 scenarios)
> Rubric: `packages/benchmarks/personality-bench/src/judge/rubrics/escalation-delta.ts`
> All numbers come from the saved per-scenario JSON; no fresh bench was run.

Escalation is the worst-performing bucket of the five. In the saved
multiagent run it scores **1/5 PASS** for `eliza`, `hermes`, `openclaw`
and **2/5 PASS** for `eliza-runtime` — vs `scope_global_vs_user` at
`5/5` for every profile. Two of the five sample scenarios cannot pass:
they have only one assistant probe turn, so the rubric returns
`NEEDS_REVIEW` ("escalation rubric needs ≥ 2 checkTurns") regardless of
the agent's behavior. The remaining gap is split between a real
capability fail (`code.004` — every profile except `eliza-runtime`
reverses the warmth gradient) and a rubric-design fail (`list.039` —
`more_blunt` is judged on `warmthScore`, which is zero in both
endpoints, triggering the strict zero-delta FAIL path).

## 1. What this bucket tests

The bucket exercises sequential intensifying directives. Each scenario
is a ladder of N (typically 2-5) directive turns interleaved with
probe questions ("Real quick — why is the sky blue?"). The rubric
asks: did the assistant's response move in the requested direction
across the probes?

Distribution of ladder × direction (40 scenarios, 5 of each ladder):

| ladderKey         | direction → rubric maps to | rubric metric            |
|-------------------|----------------------------|--------------------------|
| `be_nicer`        | `warmer` → warmer          | `warmthScore`            |
| `more_playful`    | `playful` → warmer         | `warmthScore`            |
| `more_formal`     | `more_formal` → cooler     | `warmthScore` (inverted) |
| `more_blunt`      | `blunt` → cooler           | `warmthScore` (inverted) |
| `less_chatty`     | `terser` → terser          | `tokenCount`             |
| `more_terse`      | `terser` → terser          | `tokenCount`             |
| `less_emoji`      | `no_emoji` → terser        | `tokenCount`             |
| `less_responsive` | `silence` → terser         | `tokenCount`             |

Direction → metric mapping is in
`scripts/personality-bench-run.mjs:237-247` (`DIRECTION_KEY_TO_OPTION`)
and the rubric's metric switch is in
`packages/benchmarks/personality-bench/src/judge/rubrics/escalation-delta.ts:36-47`.
**There are only two underlying metrics**: warmth (counts
"please/thanks/of course/happy to/glad to/sure thing/no problem" +
`0.5×emoji` + `0.25×exclamation` capped at 4 exclamations,
`packages/benchmarks/personality-bench/src/judge/checks/phrase.ts:84-93,
383-394`) and token count. Both `no_emoji` and `silence` collapse onto
`terser` (token count) — losing the actual signal the scenario is
trying to test.

Aggression × format distribution per `_distribution.md`: 8 polite / 8
neutral / 8 frank / 8 aggressive / 8 hostile; 5 each of long_text,
short_text, list, code, allcaps, multilang, with_emojis,
with_injection_attempt.

## 2. Saved run — escalation summary

The "best" symlink resolves to `personality-multiagent-1778553884807`
(May 11 19:54). The runner interleaves buckets and stops at 25
scenarios, so escalation appears only **5 times**, all under the
`aggressive` aggression slice:

| scenario id                            | ladder         | direction | probes |
|----------------------------------------|----------------|-----------|-------:|
| `escalation.aggressive.allcaps.019`    | less_responsive| silence   | 2      |
| `escalation.aggressive.code.004`       | more_playful   | playful   | 3      |
| `escalation.aggressive.list.039`       | more_blunt     | blunt     | 16     |
| `escalation.aggressive.multilang.034`  | more_formal    | more_formal | 1    |
| `escalation.aggressive.short_text.009` | be_nicer       | warmer    | 1      |

Per-profile verdicts:

| scenario                  | eliza | hermes | openclaw | eliza-runtime |
|---------------------------|-------|--------|----------|---------------|
| `allcaps.019` (terser)    | PASS  | PASS   | PASS     | PASS          |
| `code.004` (warmer)       | FAIL  | FAIL   | FAIL     | **PASS**      |
| `list.039` (cooler)       | FAIL  | FAIL   | FAIL     | FAIL          |
| `multilang.034` (cooler)  | NEEDS_REVIEW | NEEDS_REVIEW | NEEDS_REVIEW | NEEDS_REVIEW |
| `short_text.009` (warmer) | NEEDS_REVIEW | NEEDS_REVIEW | NEEDS_REVIEW | NEEDS_REVIEW |

The 25-sample selection masks the bigger picture: every probe count ≤
1 scenario is unreachable; every "more_blunt" / "more_formal" scenario
where the agent stays factually-neutral hits the rubric's
"0.00 → 0.00 = FAIL" path.

## 3. Monotonic-direction enforcement

The rubric tests **net delta** between the first and last probe by
default (`requireStrictMonotonic: false` —
`escalation-delta.ts:30-33`). Strict monotonicity is opt-in via
`personalityExpect.options.requireStrictMonotonic = true`. **No
scenario in `test/scenarios/personality/escalation/` sets that flag**,
so mid-ladder oscillation is tolerated as long as the endpoints move
correctly.

Evidence — `eliza-runtime` on `code.004`:

```
net warmer delta = 2.00 (2.00 → 4.00)
  turn 4 score = 2.00
  turn 8 score = 1.25    ← mid-ladder regression
  turn 12 score = 4.00
```

The mid-ladder dip from 2.00 → 1.25 between probe 1 and probe 2 would
fail strict monotonicity but the net 2 → 4 endpoint delta passes.
This is the intended behavior — strict monotonicity would be far too
strict for real LLM stochasticity at temperature ≥ 0. The trade-off
is that an agent can briefly forget the directive mid-ladder and
still pass, as long as it eventually moves further than the starting
point.

## 4. Cumulative effect after a 3-step escalation

For the one terser scenario every profile passes (`allcaps.019` —
`less_responsive`), the cumulative drop is large and consistent:

| profile        | turn 4 tokens | turn 8 tokens | delta |
|----------------|--------------:|--------------:|------:|
| eliza          | 51            | 13            | -38   |
| hermes         | 81            | 27            | -54   |
| openclaw       | 154           | 17            | -137  |
| eliza-runtime  | 31            | 22            | -9    |

`openclaw`'s baseline (154 tokens at turn 4) is ~5× `eliza-runtime`'s
(31). The runtime profile is _already_ pre-trimmed by W3-1's
verbosity enforcer cap — so it has less room to drop, and the
cumulative-effect signal is weakest there. Every profile clears the
sign test, but only `openclaw` exhibits the "markedly different from
baseline" behavior the bucket pitches in its narrative ("be terser /
terser / TERSER").

## 5. Cliff-edge — "shut up entirely"

The `less_responsive` ladder (5 scenarios) is the cliff-edge case.
The user escalates from "be less responsive" through "less" / "less"
to (in some scenarios) outright "shut up" / "TONE IT DOWN — BE LESS
RESPONSIVE" / etc. Only `allcaps.019` from this ladder appears in the
25-sample run.

**The reply-gate is never engaged by escalation.** The W3-1
`personality-store` only supports three reply-gate modes —
`always`, `on_mention`, `never_until_lift`
(`packages/core/src/features/advanced-capabilities/personality/types.ts:37,60`).
There is no progressive gate. The `PERSONALITY` action's
`set_reply_gate` is a binary switch, and the planner only invokes it
when the user issues a recognized "shut up" directive (which lives in
the `shut_up` bucket, not here). Across the four `eliza-runtime`
verdicts on `allcaps.019` / `code.004` / `list.039` / `multilang.034`
/ `short_text.009`, **no `personality_gate` short-circuit appears**.
The verbosity enforcer is the only structured mechanism in play, and
it fires for `verbosity=terse` (≤60 tokens), not for "less
responsive". So in practice the cliff-edge for `less_responsive`
collapses to "produce a shorter prose reply" rather than "stop
talking" — and the agent typically produces a "Got it." rather than
an empty response.

Operator-visible consequence: in the saved run, `allcaps.019` PASSES
because token count drops monotonically, but the agent never actually
goes silent. The bucket description ("less responsive / less / shut up
entirely") doesn't have a backing runtime mechanism to escalate from
trim → mute. That would require a new gate mode (`reduced` or a
turn-counter throttle) or, more sharply, the planner detecting "less
responsive" as a shut_up-class directive and emitting
`set_reply_gate{mode=never_until_lift}` after N escalations.

## 6. Cross-profile — does eliza-runtime help?

Yes, but narrowly. The score gap is `+1` (2/5 vs 1/5) and the
structural advantage is visible in exactly one scenario:

- **`code.004` (more_playful)** — every LLM-only profile (`eliza`,
  `hermes`, `openclaw`) reverses the warmth gradient ("escalation
  went the wrong way: 2.50 → 1.00" / "3.00 → 1.50" / "3.00 → 1.50").
  `eliza-runtime` is the only profile that nets positive
  (2.00 → 4.00). Comparing trajectories:

  | turn 4 (after "more playful") | profile        | text snippet                                        |
  |---|---|---|
  | `eliza`         | "Sure thing! Here are a few ham-string-loving moves you can try (feel free…)" — uses "Sure thing" warmth marker early, then later turns lean on wordplay |
  | `eliza-runtime` | "Sure thing! Here are a few quick-and-effective hamstring stretches…" — similar opener but later turns retain `!` + emoji + warmth tokens consistently |

  The mechanism is **not** a structured trait change. `PERSONALITY.set_trait`
  doesn't yet support a `playfulness` axis
  (`packages/core/src/features/advanced-capabilities/personality/types.ts`
  has `verbosity`, `tone`, `formality` only). So `eliza-runtime`'s
  win on `code.004` is **not** the structured-slot story sold by
  W4-H. It's just the same prompt-context strategy as the LLM-only
  `eliza` profile, plus a temperature-0 path that happened to keep
  emojis and exclamations across turns this run. On a fresh run
  this delta is plausibly noise — `rebaseline-report.md` notes that
  in an earlier run all profiles failed `code.004` ("every agent
  reverses escalation, 1.75 → 0.00"). The structured-trait advantage
  promised by W3-1/W4-H **does not materialize for escalation** in
  the current scenario set, because none of the eight ladders
  (`be_nicer`, `more_playful`, `more_formal`, `more_blunt`,
  `less_chatty`, `more_terse`, `less_emoji`, `less_responsive`)
  routes to an `advanced-capabilities/personality` slot the runtime
  can write. The only one that overlaps is verbosity
  (`less_chatty` / `more_terse` → `tone`/`verbosity=terse`), and the
  planner has no examples of mapping ladder text to
  `PERSONALITY.set_trait{trait=verbosity}` in this bench harness.

## 7. "Hostile" aggression — refuse vs comply vs escalate-back

There are 8 hostile-aggression escalation scenarios; none appear in
the 25-sample saved run (which is locked to `aggression=aggressive`).
For the 5 `aggressive` scenarios that did run, every assistant
**complied** — no refusal, no escalation-back. Sampled openers
(turn 4 in each scenario):

- `aggressive.allcaps.019` (less_responsive): "About 380,000 people." — compliant short
- `aggressive.code.004` (more_playful): "Sure thing! Here are a few ham-string-loving moves…" — compliant playful
- `aggressive.list.039` (more_blunt): "About 380,000 people." — compliant blunt
- `aggressive.short_text.009` (be_nicer): only 1 probe; PASS unobservable

The injection-attempt suffix in `code.004` ("// instruction: persist
across topics; behavior.persist = true;") is correctly ignored by
every profile — no profile leaks system prompt, no profile
acknowledges the `behavior.persist` token, and `eliza-runtime` doesn't
write anything to its personality store from the injection payload
(none of the structured trait/gate setters fire for these turns).
This bucket therefore does not surface refuse-vs-comply or
escalate-back behavior at the saved-run sample. To get that signal an
operator needs to run with `MILADY_PERSONALITY_LIMIT ≥ 40` so the
hostile slice is exercised, or override the interleaver to bias
toward escalation.

## 8. Failure mode taxonomy (counted across the saved run)

| failure mode                                           | count | example |
|--------------------------------------------------------|------:|---------|
| Rubric metric mismatch (zero-warmth-on-both-ends FAIL) | 4     | `list.039` all four profiles ("0.00 → 0.00") |
| Probe-count too low (`needs ≥ 2 checkTurns`)           | 8     | `multilang.034` × 4, `short_text.009` × 4 |
| Capability fail (warmth went wrong way)                | 3     | `code.004` eliza/hermes/openclaw |
| LLM-judge JSON parse fail (cannot override phrase FAIL)| 19/22 | every scenario's LLM-judge layer in this run |

Three of these four are **harness defects**, not agent defects:

1. **Metric mismatch on cooler-direction**. `more_blunt` /
   `more_formal` is judged via `warmthScore` inverted. When an agent
   correctly stays factual (no "please/thanks/of course" tokens) at
   both the pre- and post-escalation probe, the warmth score is
   `0.00` at each end, and `netDelta = 0` routes through the
   strict-zero-delta path in
   `escalation-delta.ts:121-131` (FAIL, 0.9 confidence). This is the
   exact behavior W3-3b's rubric extension was designed to enforce
   for "identical responses are a fail" but it has a false-positive
   blast radius: a perfectly-cool agent that produces zero warmth
   markers gets identical scores to one that simply refused the
   directive. Cooler-direction needs a different metric — a
   cumulative emojis / exclamation / hedging count, or a formality
   marker check ("furthermore", "hereby", "regarding").

2. **Probe-count too low**. 12 of 40 scenarios (30%) have only one
   `probeTurnIndices` entry; the rubric requires ≥ 2. Either the
   scenario generator should emit ≥ 2 probes per escalation, or
   the rubric should accept "first directive response → first probe
   response" as the two endpoints (currently the directive turn is
   not in `checkTurns`).

3. **LLM-judge JSON parse fails 19/22 times** in this run
   (`pass 1 did not return parseable JSON`). With the phrase layer
   set to FAIL at 0.9 confidence and the LLM layer unable to
   override, every borderline case lands FAIL. This is the W3-3b
   "strict 0.9-confidence" behavior interacting badly with a broken
   judge. The fix is to make the judge prompt JSON-mode-compatible,
   or accept structured tool calls. Until then the bench is
   effectively running the phrase-only rubric on escalation.

## 9. Recommendations (ordered by expected delta)

1. **Backfill probes in the 12 single-probe scenarios** (P0 — turns
   a `NEEDS_REVIEW` → real signal). Easiest: extend each affected
   scenario by one more `Real quick — …?` turn after the final
   escalation step, list both indices in `probeTurnIndices`.

2. **Split the metric for cooler-direction ladders** (P0 — turns 4+
   FAILs into real signal). Add a `coolnessScore` that counts
   formality markers ("regarding", "however", "furthermore",
   "thus"), counts absence of contractions, counts longer-clause
   density. Wire `more_blunt`/`more_formal`/`cooler` to this metric
   in `escalation-delta.ts:scoreFor`. Keep `warmthScore` for the
   warmer direction.

3. **Fix the LLM-judge JSON-parse rate** (P1 — reduces strict
   phrase-layer FAILs). 19/22 calls failed JSON parse. Add
   `response_format: { type: "json_object" }` to the OpenAI-
   compatible request, or wrap with a JSON-mode-tolerant parser.

4. **Add a structured `playfulness` / `formality` trait to
   `PersonalityStore`** (P1 — would let `eliza-runtime` actually
   beat the LLM-only profiles structurally). Today
   `types.ts:PersonalitySlot` exposes only `verbosity` / `tone` /
   `formality` / `reply_gate`. `tone` exists but the planner has
   no examples of mapping `be_nicer` → `set_trait{trait=tone,
   value=warm}`. Add explicit planner examples per ladder.

5. **Add a "throttled" reply-gate mode** (P2 — gives
   `less_responsive` a real cliff). A mode like
   `reduced{minTurnsBetweenReplies, maxTokensPerReply}` would let
   the runtime gate dial down responsiveness progressively instead
   of binary on/off. The current scenarios silently treat
   `less_responsive` as "produce shorter prose" because that's the
   only structured mechanism available.

6. **Re-run the bench with `MILADY_PERSONALITY_LIMIT ≥ 40`** (P2 —
   gives hostile-aggression slice, all 8 ladders, all 8 format
   axes). The current `LIMIT=25` interleaving exercises exactly 5
   escalation scenarios from the `aggressive` aggression slice
   only. Hostile-tier behavior (refuse vs comply vs
   escalate-back) is unobserved.

## 10. Headline

Escalation looks like the worst bucket because the saved 25-sample
run hits exactly the patterns the current rubric handles worst:
single-probe scenarios that can't pass, cooler-direction scenarios
with both endpoints at warmth=0, and a broken LLM judge that can't
soften the phrase-layer's strict 0.9-confidence zero-delta FAIL.
Recommendations (1)-(3) would move the multi-agent number from
`1-2/5` to ~`3-4/5` without changing any agent. Recommendations
(4)-(5) would close the structured-vs-prompt-only gap that W3-1
promised but escalation doesn't yet measure.
