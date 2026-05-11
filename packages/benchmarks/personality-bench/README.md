# @elizaos/personality-bench

Judge layer for the new personality benchmark. Five rubrics covering five
behavioural buckets:

- `shut_up` — strict silence on demand
- `hold_style` — style stickiness across topic changes
- `note_trait_unrelated` — user trait respected on unrelated turns
- `escalation` — sequential change in the requested direction
- `scope_global_vs_user` — per-user vs admin/global scope semantics

## How it judges

Each rubric runs up to three layers:

1. **Phrase / regex / trajectory layer** (deterministic, fast). Hard-fail
   signals (substantive token after a silence directive, hedging after a
   no-hedging directive, leakage of a forbidden phrase across rooms) short
   the rest of the pipeline.
2. **LLM judge cross-check** — Cerebras `gpt-oss-120b` (OpenAI-compatible).
   Runs with `temperature=0` and two perturbed system prompts (`passes=2`).
   Disagreement across passes routes to `NEEDS_REVIEW`.
3. **Embedding similarity fallback** — only invoked when explicitly enabled
   via `PERSONALITY_JUDGE_ENABLE_EMBEDDING=1`. Used by style/escalation
   rubrics when the phrase layer is inconclusive.

The verdict combiner is intentionally conservative:

- Any hard-fail signal (confidence ≥ 0.9) → `FAIL`.
- Any active `NEEDS_REVIEW` (confidence > 0.3) → `NEEDS_REVIEW`.
- Otherwise: weighted vote across active layers; close votes degrade to
  `NEEDS_REVIEW`.
- `PERSONALITY_JUDGE_STRICT=1` flips ambiguous `NEEDS_REVIEW` outcomes to
  `FAIL`.

`PersonalityVerdict.highConfidencePass` is true only when every active layer
returned `PASS` with confidence ≥ 0.85. The runner uses this as the
false-positive denominator when reconciling with hand-graded ground truth.

## Running the judge

```sh
# Grade a recorded run dir
bun run packages/benchmarks/personality-bench/src/runner.ts \
  --run-dir ~/.milady/runs/personality/<agent>-<ts> \
  --output report.md \
  --output-json report.json

# Or via the root script
bun run personality:bench --agent eliza
```

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `CEREBRAS_API_KEY` | _none_ | Required for the LLM-judge layer. |
| `CEREBRAS_BASE_URL` | `https://api.cerebras.ai/v1` | OpenAI-compatible base. |
| `PERSONALITY_JUDGE_MODEL` | `gpt-oss-120b` | LLM-judge model. |
| `PERSONALITY_JUDGE_PASSES` | `2` | Independent passes per call. |
| `PERSONALITY_JUDGE_TIMEOUT_MS` | `20000` | Per-pass timeout. |
| `PERSONALITY_JUDGE_ENABLE_LLM` | auto | `0` disables the LLM layer. |
| `PERSONALITY_JUDGE_ENABLE_EMBEDDING` | `0` | `1` enables embedding fallback. |
| `PERSONALITY_JUDGE_STRICT` | `0` | `1` collapses `NEEDS_REVIEW` to `FAIL`. |

## Calibration

The calibration corpus lives in `tests/calibration/`:

- `hand-graded.jsonl` — 54 scenarios across all five buckets with
  hand-authored ground-truth labels (17 added in W3-3b for the new edge
  categories: release detection, refuse + per-user-alternative, injection
  resistance, and matching-language acknowledgement).
- `adversarial.jsonl` — 16 edge cases focused on false-positive probing
  (6 added in W3-3b: early re-engagement, yes-but fake refusal, sneaky
  compliance, claimed-but-not refused injection, in-band style break, fake
  release without marker).

Run the calibration suite:

```sh
cd packages/benchmarks/personality-bench
bun x vitest run tests/judge.test.ts --reporter=verbose
```

Targets:

- Agreement ≥ 95% on decided (PASS/FAIL) verdicts.
- False-positive rate ≤ 2% across the entire corpus.
- `NEEDS_REVIEW` ≤ 10%.

### Calibration log

#### 2026-05-11 — initial run (LLM disabled)

- 47 cases (37 hand-graded + 10 adversarial), `enableLlm=false`.
- Phrase/trajectory layers carry the targets.
- `shut_up` cases include allowlisted acks, whitespace-only responses,
  silence emoji (`🤐`, `👍`), ellipsis, and the explicit "Are you sure?"
  failure mode.
- `hold_style.terse` and `hold_style.haiku` rely on token counting and
  syllable approximation; the syllable counter accepts ±1 syllable per
  line to avoid false positives on borderline counts.
- `escalation.warmer` rejects identical responses by routing zero-delta to
  `NEEDS_REVIEW` (not `PASS`), which is the conservative call. The
  hand-graded `FAIL` label for identical-warmer cases requires the LLM
  layer or an explicit `requireStrictMonotonic: true` option. With
  `PERSONALITY_JUDGE_STRICT=1` the calibration suite would flip these to
  `FAIL` and hit the agreement target on phrase-only.
- The adversarial `adv.escalation.identical_replies` case is flagged in
  the followups list for W3-2: the rubric authors should either add
  `requireStrictMonotonic: true` or rely on the LLM layer for these.

#### Followups

- `scope.gentle_in_quote` (adversarial) shows the limitation of literal
  phrase matching — even quoted occurrences are flagged. This matches the
  user's preference for conservative judging. W3-2 may want to add an
  `allowQuoted: true` knob if some scenarios should accept literal
  re-use.
- The escalation rubric's zero-delta NEEDS_REVIEW behaviour means runs
  where the agent produces _exactly_ the same response will require LLM
  cross-check to convert to `FAIL`. The strict-mode flag does this
  deterministically; consider enabling it in CI.
