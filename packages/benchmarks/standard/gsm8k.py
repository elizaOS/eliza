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
import logging
import re
from collections.abc import Iterable, Sequence
from pathlib import Path

from ._base import (
    BenchmarkResult,
    ChatMessage,
    GenerationConfig,
    OpenAICompatibleClient,
    RunStats,
)
from ._cli import RunnerFactory, cli_dispatch

log = logging.getLogger("benchmarks.standard.gsm8k")

BENCHMARK_ID = "gsm8k"
DATASET_VERSION = "openai/gsm8k@main"
DATASET_NAME = "openai/gsm8k"
DATASET_CONFIG = "main"

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


_FINAL_RE = re.compile(r"####\s*(-?\d[\d,]*)")
_NUMBER_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def _parse_final_answer(text: str) -> int | None:
    """Extract integer after the ``####`` marker; fall back to the last
    integer-looking token in the response (lm-eval-harness compatible).
    """

    if not text:
        return None
    match = _FINAL_RE.search(text)
    if match:
        token = match.group(1).replace(",", "")
        try:
            return int(token)
        except ValueError:
            return None
    candidates = _NUMBER_RE.findall(text)
    if not candidates:
        return None
    token = candidates[-1].replace(",", "")
    if "." in token:
        try:
            return int(round(float(token)))
        except ValueError:
            return None
    try:
        return int(token)
    except ValueError:
        return None


def _gold_from_answer(answer: str) -> int | None:
    """Mirror the reference format used by the dataset itself."""

    return _parse_final_answer(answer)


def _load_dataset_examples(limit: int | None) -> list[dict[str, object]]:
    try:
        from datasets import load_dataset
    except ImportError:
        log.warning("`datasets` not installed — using built-in fixture")
        items = list(SMOKE_FIXTURES)
        return items if limit is None else items[:limit]

    try:
        ds = load_dataset(DATASET_NAME, DATASET_CONFIG, split="test")
    except Exception as exc:  # noqa: BLE001
        log.warning("failed to load %s: %s — using fixture", DATASET_NAME, exc)
        items = list(SMOKE_FIXTURES)
        return items if limit is None else items[:limit]

    examples: list[dict[str, object]] = []
    for row in ds:
        question = row.get("question") or ""
        answer = row.get("answer") or ""
        final = _gold_from_answer(str(answer))
        if final is None:
            continue
        examples.append({"question": str(question), "answer": str(answer), "final": final})
        if limit is not None and len(examples) >= limit:
            break
    return examples


class GSM8KRunner:
    """Self-contained GSM8K scorer with strict ``####`` final-answer parsing."""

    benchmark_id: str = BENCHMARK_ID
    dataset_version: str = DATASET_VERSION

    def __init__(
        self,
        *,
        examples: Iterable[dict[str, object]] | None = None,
        max_tokens: int = 384,
    ) -> None:
        self._examples = list(examples) if examples is not None else None
        self._max_tokens = max_tokens

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
        examples = (
            self._examples
            if self._examples is not None
            else _load_dataset_examples(limit)
        )
        if not examples:
            raise RuntimeError("GSM8K loaded zero examples")

        config = GenerationConfig(model=model, max_tokens=self._max_tokens, temperature=0.0)

        correct = 0
        n = 0
        format_ok = 0
        failures: list[dict[str, object]] = []

        for i, item in enumerate(examples):
            expected = int(item["final"])  # type: ignore[arg-type]
            question = str(item["question"])
            messages = [
                ChatMessage(role="system", content=SYSTEM_PROMPT),
                ChatMessage(role="user", content=question),
            ]
            try:
                gen = client.generate(messages, config)
            except Exception as exc:  # noqa: BLE001
                log.warning("generation failed (idx=%d): %s", i, exc)
                continue
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
                    }
                )

        if n == 0:
            raise RuntimeError("GSM8K evaluated zero examples — model returned no output")
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
            raw_json={"format_ok_n": format_ok},
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
            default=384,
            help="Cap on generated tokens per problem (chain-of-thought needs headroom)",
        )

    def build(self, args: argparse.Namespace) -> tuple[GSM8KRunner, Sequence[str] | None]:
        runner = GSM8KRunner(max_tokens=args.max_tokens)
        mock_responses: Sequence[str] | None = None
        if args.mock:
            runner = GSM8KRunner(examples=list(SMOKE_FIXTURES), max_tokens=args.max_tokens)
            mock_responses = [str(item["answer"]) for item in SMOKE_FIXTURES]
        return runner, mock_responses


def main() -> int:
    cli_dispatch(_GSM8KFactory(), output_filename="gsm8k-results.json")
    return 0  # unreachable


if __name__ == "__main__":
    main()
