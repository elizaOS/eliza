"""MMLU benchmark adapter.

Wraps lm-evaluation-harness when available; otherwise runs a
self-contained implementation that talks to an OpenAI-compatible
endpoint directly. Either path emits the same result shape so the
registry's score extractor doesn't care which mode produced it.

CLI:

    python -m benchmarks.standard.mmlu \\
        --model-endpoint http://localhost:8000/v1 \\
        --model gpt-4o-mini \\
        --output /tmp/mmlu

Result file: ``<output>/mmlu-results.json``.
"""

from __future__ import annotations

import argparse
import logging
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Iterable

from ._base import (
    BenchmarkResult,
    ChatMessage,
    GenerationConfig,
    OpenAICompatibleClient,
    RunStats,
)
from ._cli import RunnerFactory, cli_dispatch

log = logging.getLogger("benchmarks.standard.mmlu")

BENCHMARK_ID = "mmlu"
DATASET_VERSION = "cais/mmlu@2023-09-15"
DATASET_NAME = "cais/mmlu"


SYSTEM_PROMPT = (
    "You are an expert taking a multiple-choice exam. For each question, "
    "respond with a single letter (A, B, C, or D) corresponding to the "
    "correct answer. Do not include any explanation."
)

# Tiny built-in fixture covers the mock smoke test. The real benchmark
# loads ``cais/mmlu`` via ``datasets`` when the package is installed.
SMOKE_FIXTURES: tuple[dict[str, object], ...] = (
    {
        "subject": "high_school_mathematics",
        "question": "What is 12 + 7?",
        "choices": ["17", "18", "19", "20"],
        "answer_index": 2,
    },
    {
        "subject": "world_history",
        "question": "In what year did World War II end?",
        "choices": ["1942", "1945", "1948", "1950"],
        "answer_index": 1,
    },
    {
        "subject": "elementary_mathematics",
        "question": "Which of the following is a prime number?",
        "choices": ["4", "6", "9", "11"],
        "answer_index": 3,
    },
)


_LETTER_RE = re.compile(r"\b([A-D])\b")
_LETTER_OPTIONS = ("A", "B", "C", "D")


def _format_question(item: dict[str, object]) -> str:
    question = str(item["question"])
    choices = item["choices"]
    if not isinstance(choices, list) or len(choices) != 4:
        raise ValueError(f"MMLU item has bad choices: {choices!r}")
    body = [f"Question: {question}"]
    for letter, choice in zip(_LETTER_OPTIONS, choices):
        body.append(f"{letter}. {choice}")
    body.append("Answer:")
    return "\n".join(body)


def _extract_letter(text: str) -> str | None:
    if not text:
        return None
    stripped = text.strip().upper()
    match = _LETTER_RE.search(stripped)
    return match.group(1) if match else None


def _load_dataset_examples(limit: int | None) -> list[dict[str, object]]:
    """Load real MMLU via ``datasets``; fall back to the fixture set.

    The fallback is deliberate — the smoke test must run with no
    internet and no datasets install.
    """

    try:
        from datasets import load_dataset
    except ImportError:
        log.warning("`datasets` not installed — using built-in fixture")
        items = list(SMOKE_FIXTURES)
        return items if limit is None else items[:limit]

    try:
        ds = load_dataset(DATASET_NAME, "all", split="test")
    except Exception as exc:  # noqa: BLE001
        log.warning("failed to load %s: %s — using fixture", DATASET_NAME, exc)
        items = list(SMOKE_FIXTURES)
        return items if limit is None else items[:limit]

    examples: list[dict[str, object]] = []
    for row in ds:
        examples.append(
            {
                "subject": row.get("subject") or "",
                "question": row.get("question") or "",
                "choices": list(row.get("choices") or []),
                "answer_index": int(row.get("answer") or 0),
            }
        )
        if limit is not None and len(examples) >= limit:
            break
    return examples


class MMLURunner:
    """Self-contained MMLU scorer for OpenAI-compatible endpoints.

    Loads ``cais/mmlu`` (or fixture in mock mode), prompts the model for
    a single-letter answer, scores accuracy.
    """

    benchmark_id: str = BENCHMARK_ID
    dataset_version: str = DATASET_VERSION

    def __init__(
        self,
        *,
        examples: Iterable[dict[str, object]] | None = None,
        max_tokens: int = 8,
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
        examples = self._examples if self._examples is not None else _load_dataset_examples(limit)
        if not examples:
            raise RuntimeError("MMLU loaded zero examples")

        config = GenerationConfig(model=model, max_tokens=self._max_tokens, temperature=0.0)

        correct = 0
        per_subject: dict[str, list[int]] = {}
        failures: list[dict[str, object]] = []

        for i, item in enumerate(examples):
            subject = str(item.get("subject") or "unknown")
            expected_idx = int(item["answer_index"])  # type: ignore[arg-type]
            expected_letter = _LETTER_OPTIONS[expected_idx]
            messages = [
                ChatMessage(role="system", content=SYSTEM_PROMPT),
                ChatMessage(role="user", content=_format_question(item)),
            ]
            try:
                gen = client.generate(messages, config)
            except Exception as exc:  # noqa: BLE001
                log.warning("generation failed (idx=%d): %s", i, exc)
                continue
            predicted = _extract_letter(gen.text)
            is_correct = predicted == expected_letter
            if is_correct:
                correct += 1
            slot = per_subject.setdefault(subject, [0, 0])
            slot[1] += 1
            if is_correct:
                slot[0] += 1
            if not is_correct and len(failures) < 8:
                failures.append(
                    {
                        "subject": subject,
                        "question": item.get("question"),
                        "expected": expected_letter,
                        "predicted": predicted or gen.text[:120],
                    }
                )

        n = sum(c[1] for c in per_subject.values())
        if n == 0:
            raise RuntimeError("MMLU evaluated zero examples — model returned no output")

        accuracy = correct / n
        subject_accuracy: dict[str, float] = {
            subject: round(slot[0] / slot[1], 4) for subject, slot in per_subject.items()
        }

        return BenchmarkResult(
            benchmark=BENCHMARK_ID,
            model=model,
            endpoint=endpoint,
            dataset_version=DATASET_VERSION,
            n=n,
            metrics={
                "score": round(accuracy, 4),
                "accuracy": round(accuracy, 4),
                "correct": float(correct),
                "n": float(n),
            },
            raw_json={"subject_accuracy": subject_accuracy},
            failures=failures,
            elapsed_s=stats.elapsed(),
        )


class _MMLUFactory(RunnerFactory):
    prog = "benchmarks.standard.mmlu"
    description = "MMLU 4-way multiple-choice benchmark (cais/mmlu) over an OpenAI-compatible endpoint."

    def augment_parser(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument(
            "--max-tokens",
            type=int,
            default=8,
            help="Cap on generated tokens per question (single letter is enough)",
        )

    def build(self, args: argparse.Namespace) -> tuple[MMLURunner, Sequence[str] | None]:
        runner = MMLURunner(max_tokens=args.max_tokens)
        mock_responses: Sequence[str] | None = None
        if args.mock:
            # Drive the runner against the built-in fixture deterministically.
            runner = MMLURunner(
                examples=list(SMOKE_FIXTURES),
                max_tokens=args.max_tokens,
            )
            # Echo the correct letter so a mock smoke run scores 100%.
            mock_responses = [
                _LETTER_OPTIONS[int(item["answer_index"])]  # type: ignore[arg-type]
                for item in SMOKE_FIXTURES
            ]
        return runner, mock_responses


def main() -> int:
    cli_dispatch(_MMLUFactory(), output_filename="mmlu-results.json")
    return 0  # unreachable; cli_dispatch sys.exits.


if __name__ == "__main__":
    main()
