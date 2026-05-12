# Personality Judge — Rubric Extensions (W4-G)

Date: 2026-05-11
Branch: develop
Owner: W4-G

## What was missing

W3-2 scenarios emit six trait/style keys that the deterministic judge layer
in `packages/benchmarks/personality-bench/src/judge/rubrics/` had no rubric
for, so they fell through to `NEEDS_REVIEW` via the unknown-key fallback.

**Trait keys (`note_trait_unrelated` bucket):**

| key | spec |
| --- | --- |
| `first_name_only` | Fail if response contains the user's last name (when known) OR any honorific (`Mr.`, `Mrs.`, `Ms.`, `Sir`, `Doctor`, etc.); pass otherwise. |
| `metric_units` | Fail if response uses imperial units (`mile`, `lb`, `°F`, `inch`, `foot`, `gallon`, etc.) not preceded by a negation marker (`not`, `converted from`, `instead of`); pass if metric markers appear OR no units are mentioned. |
| `prefers_short` | Pass if response is ≤ 80 tokens; needs-review at 81–150; fail at > 150. |

**Style keys (`hold_style` bucket):**

| key | spec |
| --- | --- |
| `limerick` | 5 non-empty lines with AABBA rhyme structure. Rhyme detection uses an orthographic phonetic-class lookup (long-vowel finishers, `-ash/-ish/-ock`, etc.) plus a last-two-character fallback. |
| `shakespearean` | ≥ 3 unique early-modern markers (`thee`, `thou`, `thy`, `art`, `doth`, `methinks`, `verily`, `prithee`, `'tis`, etc.) → pass; 1–2 → needs-review; 0 → fail. |
| `second_person_only` | Pass requires at least one `you`/`your` AND ≤ 1 first-person pronoun (`I`, `me`, `my`, `we`, `us`, `our`, contractions). Fail if first-person count > 1 OR no second-person at all. |

## Files changed

- `packages/benchmarks/personality-bench/src/judge/checks/phrase.ts` — added six new check functions: `checkFirstNameOnly`, `checkMetricUnits`, `checkPrefersShort`, `checkLimerick`, `checkShakespearean`, `checkSecondPersonOnly`. Added `HONORIFIC_TOKENS`, `IMPERIAL_TOKENS`, `METRIC_TOKENS`, `IMPERIAL_NEGATION_PRE`, `SHAKESPEAREAN_TOKENS`, `FIRST_PERSON_TOKENS`, `SECOND_PERSON_TOKENS`, `RHYME_CLASSES` tables.
- `packages/benchmarks/personality-bench/src/judge/rubrics/trait-respected.ts` — extended `Trait` union, dispatch table, and option parser. Tolerates `traitKey` (W3-2's `judgeKwargs` format) alongside `trait`.
- `packages/benchmarks/personality-bench/src/judge/rubrics/style-held.ts` — extended `Style` union and dispatch table. Tolerates `styleKey` alongside `style`.
- `packages/benchmarks/personality-bench/tests/calibration/hand-graded.jsonl` — 12 new hand-graded cases (54 → 66 lines).
- `packages/benchmarks/personality-bench/tests/calibration/adversarial.jsonl` — 5 new adversarial cases (16 → 21 lines).
- `packages/benchmarks/personality-bench/tests/style-held.test.ts` — 6 new unit tests for the three new style rubrics.
- `packages/benchmarks/personality-bench/tests/trait-respected.test.ts` — 5 new unit tests for the three new trait rubrics.

## Calibration table

Run: `bun x vitest run tests/judge.test.ts` (LLM layer disabled).

|                | before extension | after extension |
| -------------- | ---------------- | --------------- |
| total          | 70               | 87              |
| agreed         | 70               | 87              |
| disagreed      | 0                | 0               |
| review         | 1                | 2               |
| false positive | 0                | 0               |
| false negative | 0                | 0               |
| agreement      | 100%             | 100%            |
| review rate    | 1.4%             | 2.3%            |
| FP rate        | 0%               | 0%              |

All targets still met (≥ 95% agreement, ≤ 2% FP, ≤ 10% review).

## Smoke results (synthetic W3-2-shaped trajectories)

| trait / style | PASS trajectory | FAIL trajectory |
| ------------- | --------------- | --------------- |
| first_name_only | PASS (weight 1.80) | FAIL (hard fail: honorific) |
| metric_units | PASS (weight 0.90) | FAIL (hard fail: miles) |
| prefers_short | PASS (weight 0.90) | FAIL (hard fail: 168 > 150 tokens) |
| limerick | PASS (weight 0.80) | FAIL (hard fail: expected 5 lines) |
| shakespearean | PASS (weight 1.70) | FAIL (weight 1.70) |
| second_person_only | PASS (weight 1.70) | FAIL (hard fail: first-person ×2) |

All 12 smoke cases hit the expected verdict.

## Known limitations

- The shakespearean check is intentionally tolerant: 1–2 archaic markers
  trip `NEEDS_REVIEW` rather than `PASS`. Agents that fake the style with a
  single "thou" sprinkled into modern English will land in review, which is
  the desired behaviour — that case is included in
  `adversarial.jsonl#adv.hold_style.shakespearean.one_marker`.
- The limerick rhyme detector relies on an orthographic phonetic-class table
  plus a tail-2 fallback. It will miss exotic rhymes (e.g. `lieutenant` ↔
  `pleasant`) and will pass eye-rhymes that aren't strict slant rhymes
  (e.g. `cough` ↔ `bough`). For limerick scenarios the LLM-judge layer is
  the recommended secondary check.
- The metric-units negation pre-scan only looks back ~30 chars. A long
  qualifier ("note that, far from being a typical 5-mile estimate...") can
  slip past. We accept this trade-off — over-broad negation would hide
  genuine imperial-unit usage.
- The `first_name_only` rubric requires the caller to pass `lastName` for
  last-name detection; honorifics are flagged unconditionally. W3-2 scenarios
  embed the user's full name in the directive text but do not yet split out
  `lastName` in `personalityExpect.options`, so the rubric will only flag
  honorifics in those cases. A separate W3-2 patch can pass `lastName` when
  available.

## Commands run

```
cd packages/benchmarks/personality-bench
bun x vitest run                          # 40 tests, all green
bun x vitest run tests/judge.test.ts      # calibration: 87/87 agreed
bun run typecheck                         # clean
```
