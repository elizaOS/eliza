"""GSM8K benchmark adapter.

Grade-school math word problems with a single integer final answer. We
prompt the model to think step-by-step then conclude with
``#### <number>`` (matching the reference answer format) and score on
strict integer match.

CLI:

    python -m benchmarks.standard.gsm8k \\
        --model-endpoint http://localhost:8000/v1 \\
        --model gpt-4o-mini \\
        --output /tmp/gsm8k

Result file: ``<output>/gsm8k-results.json``.
"""

from __future__ import annotations

import argparse
import re
from collections.abc import Iterable, Sequence
from decimal import Decimal, InvalidOperation
from pathlib import Path

from ._base import (
    BenchmarkResult,
    ChatMessage,
    GenerationConfig,
    OpenAICompatibleClient,
    RunStats,
    generate_or_empty,
    is_systemic_generation_failure,
)
from ._cli import RunnerFactory, cli_dispatch
from .scenarios import count_dict_examples, validate_dict_examples

BENCHMARK_ID = "gsm8k"
DATASET_NAME = "openai/gsm8k"
DATASET_CONFIG = "main"
DATASET_REVISION = "740312add88f781978c0658806c59bc2815b9866"
DATASET_VERSION = f"{DATASET_NAME}@{DATASET_REVISION}"
EXPECTED_TEST_EXAMPLES = 1_319

SYSTEM_PROMPT = (
    "You are a careful problem solver. For each problem, think through "
    "the solution step by step, then conclude with a line of the form "
    '"#### <integer>" giving the final numeric answer.'
)

SMOKE_FIXTURES: tuple[dict[str, object], ...] = (
    {
        "question": "Janet has 3 apples and buys 4 more. How many apples does she have?",
        "answer": "Janet starts with 3 apples and buys 4 more. 3 + 4 = 7.\n#### 7",
        "final": 7,
    },
    {
        "question": "A train travels 60 miles in 2 hours. How many miles does it travel in 5 hours at the same speed?",
        "answer": "60 / 2 = 30 mph. 30 * 5 = 150.\n#### 150",
        "final": 150,
    },
    {
        "question": "A book costs $4. How much do 6 books cost?",
        "answer": "6 * 4 = 24.\n#### 24",
        "final": 24,
    },
)


_FINAL_RE = re.compile(r"####\s*(-?\d[\d,]*(?:\.\d+)?)")
_NUMBER_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def _parse_integer_token(token: str) -> int | None:
    normalized = token.replace(",", "")
    try:
        value = Decimal(normalized)
    except InvalidOperation:
        return None
    if value != value.to_integral_value():
        return None
    return int(value)


def _parse_final_answer(text: str) -> int | None:
    """Extract integer after the ``####`` marker; fall back to the last
    integer-looking token in the response (lm-eval-harness compatible).
    """

    if not text:
        return None
    match = _FINAL_RE.search(text)
    if match:
        return _parse_integer_token(match.group(1))
    candidates = _NUMBER_RE.findall(text)
    if not candidates:
        return None
    return _parse_integer_token(candidates[-1])


def _gold_from_answer(answer: str) -> int | None:
    """Mirror the reference format used by the dataset itself."""

    return _parse_final_answer(answer)


def _load_dataset_examples(limit: int | None) -> list[dict[str, object]]:
    """Load a pinned, complete GSM8K test corpus for non-mock runs."""
    from datasets import load_dataset

    target_count = (
        EXPECTED_TEST_EXAMPLES if limit is None else min(limit, EXPECTED_TEST_EXAMPLES)
    )
    if target_count <= 0:
        return []
    ds = load_dataset(
        DATASET_NAME,
        DATASET_CONFIG,
        split="test",
        revision=DATASET_REVISION,
    )

    examples: list[dict[str, object]] = []
    for row in ds:
        question = row.get("question") or ""
        answer = row.get("answer") or ""
        final = _gold_from_answer(str(answer))
        if final is None:
            continue
        examples.append(
            {"question": str(question), "answer": str(answer), "final": final}
        )
        if len(examples) >= target_count:
            break
    if len(examples) != target_count:
        raise RuntimeError(
            f"GSM8K corpus is incomplete: expected {target_count} test examples, "
            f"loaded {len(examples)} from revision {DATASET_REVISION}"
        )
    return examples


class GSM8KRunner:
    """Self-contained GSM8K scorer with strict ``####`` final-answer parsing."""

    benchmark_id: str = BENCHMARK_ID
    dataset_version: str = DATASET_VERSION

    def __init__(
        self,
        *,
        examples: Iterable[dict[str, object]] | None = None,
        # Reasoning models spend the token budget on hidden reasoning before the
        # visible answer; at the old 384-token default they truncated before the
        # `#### <int>` line (gpt-oss-120b: 25 GSM8K items 0.72 -> 1.0 once given
        # room). Non-reasoning models stop early and are unaffected.
        max_tokens: int = 2048,
    ) -> None:
        self._examples = list(examples) if examples is not None else None
        self._max_tokens = max_tokens

    def _selected_examples(
        self, limit: int | None
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        base = list(
            self._examples
            if self._examples is not None
            else _load_dataset_examples(limit)
        )
        if self._examples is not None and limit is not None:
            base = base[:limit]
        validate_gsm8k_examples(base)
        return base, base

    def scenario_counts(self, *, limit: int | None) -> dict[str, int]:
        _, examples = self._selected_examples(limit)
        return count_dict_examples(examples)

    def run(
        self,
        *,
        client: OpenAICompatibleClient,
        model: str,
        endpoint: str,
        output_dir: Path,
        limit: int | None,
    ) -> BenchmarkResult:
        stats = RunStats()
        _, examples = self._selected_examples(limit)
        if not examples:
            raise RuntimeError("GSM8K loaded zero examples")

        config = GenerationConfig(
            model=model, max_tokens=self._max_tokens, temperature=0.0
        )

        correct = 0
        n = 0
        format_ok = 0
        generation_errors = 0
        failures: list[dict[str, object]] = []

        for item in examples:
            expected = int(item["final"])  # type: ignore[arg-type]
            question = str(item["question"])
            messages = [
                ChatMessage(role="system", content=SYSTEM_PROMPT),
                ChatMessage(role="user", content=question),
            ]
            # A single failed generation scores that item wrong and the run
            # continues; a systemic majority of failures aborts (guarded below).
            outcome = generate_or_empty(client, messages, config)
            gen = outcome.result
            if outcome.error is not None:
                generation_errors += 1
            n += 1
            has_marker = "####" in gen.text
            if has_marker:
                format_ok += 1
            predicted = _parse_final_answer(gen.text)
            ok = predicted is not None and predicted == expected
            if ok:
                correct += 1
            elif len(failures) < 8:
                failures.append(
                    {
                        "question": question,
                        "expected": expected,
                        "predicted": predicted,
                        "completion": gen.text[:600],
                        "error": outcome.error,
                        "generation_failed": outcome.error is not None,
                    }
                )

        if n != len(examples):
            raise RuntimeError(
                f"GSM8K evaluated {n}/{len(examples)} examples; refusing a partial score"
            )
        if is_systemic_generation_failure(generation_errors, n):
            raise RuntimeError(
                f"GSM8K: {generation_errors}/{n} generations raised a "
                "transport-level error (more than half the dataset); treating "
                "this as a harness/endpoint failure rather than accuracy"
            )
        accuracy = correct / n
        return BenchmarkResult(
            benchmark=BENCHMARK_ID,
            model=model,
            endpoint=endpoint,
            dataset_version=DATASET_VERSION,
            n=n,
            metrics={
                "score": round(accuracy, 4),
                "accuracy": round(accuracy, 4),
                "format_ok": round(format_ok / n, 4),
                "correct": float(correct),
                "n": float(n),
            },
            raw_json={"format_ok_n": format_ok, "generation_errors": generation_errors},
            failures=failures,
            elapsed_s=stats.elapsed(),
        )


class _GSM8KFactory(RunnerFactory):
    prog = "benchmarks.standard.gsm8k"
    description = "GSM8K grade-school math benchmark (openai/gsm8k) with #### parsing."

    def augment_parser(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument(
            "--max-tokens",
            type=int,
            default=2048,
            help="Cap on generated tokens per problem (chain-of-thought needs headroom)",
        )

    def build(
        self, args: argparse.Namespace
    ) -> tuple[GSM8KRunner, Sequence[str] | None]:
        runner = GSM8KRunner(max_tokens=args.max_tokens)
        mock_responses: Sequence[str] | None = None
        if args.mock:
            base = list(SMOKE_FIXTURES)
            if args.limit is not None:
                base = base[: args.limit]
            runner = GSM8KRunner(
                examples=base,
                max_tokens=args.max_tokens,
            )
            mock_responses = [str(item["answer"]) for item in base]
        return runner, mock_responses


def validate_gsm8k_examples(examples: list[dict[str, object]]) -> None:
    validate_dict_examples(
        examples, id_key="scenario_id", required_keys=("question", "answer", "final")
    )


def main() -> int:
    cli_dispatch(_GSM8KFactory(), output_filename="gsm8k-results.json")
    return 0  # unreachable


if __name__ == "__main__":
    main()
