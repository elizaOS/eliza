"""MT-Bench benchmark adapter.

Multi-turn open-ended conversation benchmark introduced by lmsys
(80 prompts across 8 categories: writing, roleplay, reasoning, math,
coding, extraction, stem, humanities). The candidate model answers each
prompt across two turns; a strong "judge" model scores each response on
a 1-10 scale. Reported metric is the mean judge score.

This is a *custom* runner (no widely-installable upstream wrapper). We
implement the standard single-turn-then-followup protocol and the
single-answer LMSYS judge prompt. The judge is also called over an
OpenAI-compatible endpoint, so the same plumbing applies to either
strong-model judge (GPT-4, Claude, eliza-1-70b, …).

CLI:

    python -m benchmarks.standard.mt_bench \\
        --model-endpoint http://localhost:8000/v1 \\
        --model eliza-1-9b \\
        --judge-endpoint https://api.openai.com/v1 \\
        --judge-model gpt-4o \\
        --output /tmp/mt-bench

Result file: ``<output>/mt-bench-results.json``.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
from collections.abc import Iterable, Sequence
from pathlib import Path

from ._base import (
    BenchmarkResult,
    ChatMessage,
    GenerationConfig,
    HTTPOpenAICompatibleClient,
    OpenAICompatibleClient,
    RunStats,
    make_client,
    resolve_api_key,
    resolve_endpoint,
)
from ._cli import RunnerFactory, cli_dispatch

log = logging.getLogger("benchmarks.standard.mt_bench")

BENCHMARK_ID = "mt_bench"
DATASET_VERSION = "lmsys/mt_bench_human_judgments@v1"

# Built-in question set used for the smoke test and as a fallback when
# the lmsys dataset can't be fetched. Each entry is one MT-Bench
# question pair: a primary turn + a follow-up turn.
SMOKE_QUESTIONS: tuple[dict[str, object], ...] = (
    {
        "question_id": 81,
        "category": "writing",
        "turns": (
            "Compose an engaging travel blog post about a recent trip to Hawaii.",
            "Rewrite your previous response. Start every sentence with the letter A.",
        ),
    },
    {
        "question_id": 91,
        "category": "math",
        "turns": (
            "What is the cube root of 27?",
            "Now, what is the cube root of 125?",
        ),
    },
    {
        "question_id": 101,
        "category": "reasoning",
        "turns": (
            "Imagine you are in a race and you overtake the person in second place. What place are you in?",
            "What if you instead overtake the last person?",
        ),
    },
)


# LMSYS single-answer judge prompt (single-turn variant). We always
# render the multi-turn variant for follow-ups.
JUDGE_SYSTEM_PROMPT = (
    "You are a careful, impartial judge. Rate the assistant's response to the "
    "user question on a scale of 1 (worst) to 10 (best). Consider helpfulness, "
    "relevance, accuracy, depth, and creativity. After explaining briefly, "
    "output the final rating on its own line in the exact form: "
    '"Rating: [[<integer>]]" — e.g. "Rating: [[7]]".'
)

_RATING_PATTERNS = (
    re.compile(r"\bRating:\s*\[\[(\d{1,2})\]\]", re.IGNORECASE),
    re.compile(
        r"\b(?:final\s+rating|rating|score)\s*[:=]\s*"
        r"(?:\[\[|\[)?\s*(\d{1,2})(?:\s*/\s*10)?\s*(?:\]\]|\])?",
        re.IGNORECASE,
    ),
)


def _extract_rating(text: str) -> float | None:
    match = None
    for pattern in _RATING_PATTERNS:
        match = pattern.search(text or "")
        if match:
            break
    if not match:
        return None
    try:
        v = int(match.group(1))
    except ValueError:
        return None
    if not (1 <= v <= 10):
        return None
    return float(v)


def _build_judge_prompt(question: str, answer: str, turn: int) -> str:
    return (
        f"[Question (turn {turn})]\n{question}\n\n"
        f"[Assistant Response]\n{answer}\n\n"
        f'Provide the rating as "Rating: [[N]]" where N is an integer 1-10.'
    )


def _load_dataset_questions(limit: int | None) -> list[dict[str, object]]:
    """Load real MT-Bench from the HF mirror; fall back to the fixture set.

    The community mirror at ``lmsys/mt_bench_human_judgments`` exposes
    each question with ``turns`` (list of turn-1 + turn-2 strings).
    """

    try:
        from datasets import load_dataset
    except ImportError:
        log.warning("`datasets` not installed — using built-in fixture")
        items = list(SMOKE_QUESTIONS)
        return items if limit is None else items[:limit]

    try:
        ds = load_dataset("lmsys/mt_bench_human_judgments", split="human")
    except Exception as exc:  # noqa: BLE001
        log.warning("failed to load mt_bench dataset: %s — using fixture", exc)
        items = list(SMOKE_QUESTIONS)
        return items if limit is None else items[:limit]

    seen: dict[int, dict[str, object]] = {}
    for row in ds:
        question = row.get("question") or {}
        qid_raw = question.get("question_id")
        if not isinstance(qid_raw, int):
            continue
        if qid_raw in seen:
            continue
        turns_field = question.get("turns")
        if not isinstance(turns_field, list) or len(turns_field) < 2:
            continue
        seen[qid_raw] = {
            "question_id": qid_raw,
            "category": question.get("category") or "unknown",
            "turns": (str(turns_field[0]), str(turns_field[1])),
        }
        if limit is not None and len(seen) >= limit:
            break
    if not seen:
        log.warning("mt_bench dataset schema yielded zero questions — using fixture")
        items = list(SMOKE_QUESTIONS)
        return items if limit is None else items[:limit]
    return list(seen.values())


class MTBenchRunner:
    """Custom MT-Bench runner with pluggable judge.

    Per question:
      1. Send turn 1 to candidate; collect answer.
      2. Send turn 2 to candidate (with turn-1 in conversation history).
      3. For each turn, ask the judge for a 1-10 rating.

    Score is the mean judge rating, normalized to ratio [0,1].
    """

    benchmark_id: str = BENCHMARK_ID
    dataset_version: str = DATASET_VERSION

    def __init__(
        self,
        *,
        judge: OpenAICompatibleClient,
        judge_model: str,
        questions: Iterable[dict[str, object]] | None = None,
        max_tokens: int = 1024,
        judge_max_tokens: int = 384,
    ) -> None:
        self._judge = judge
        self._judge_model = judge_model
        self._questions = list(questions) if questions is not None else None
        self._max_tokens = max_tokens
        self._judge_max_tokens = judge_max_tokens

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
        questions = (
            self._questions
            if self._questions is not None
            else _load_dataset_questions(limit)
        )
        if not questions:
            raise RuntimeError("MT-Bench loaded zero questions")

        cand_cfg = GenerationConfig(model=model, max_tokens=self._max_tokens, temperature=0.7)
        judge_cfg = GenerationConfig(
            model=self._judge_model,
            max_tokens=self._judge_max_tokens,
            temperature=0.0,
        )

        ratings: list[float] = []
        per_category: dict[str, list[float]] = {}
        per_turn: dict[str, list[float]] = {"turn_1": [], "turn_2": []}
        failures: list[dict[str, object]] = []

        for item in questions:
            turns_obj = item["turns"]
            if not isinstance(turns_obj, (list, tuple)) or len(turns_obj) < 2:
                continue
            turn_1, turn_2 = str(turns_obj[0]), str(turns_obj[1])
            category = str(item.get("category") or "unknown")

            # Turn 1.
            history = [ChatMessage(role="user", content=turn_1)]
            try:
                gen_1 = client.generate(history, cand_cfg)
            except Exception as exc:  # noqa: BLE001
                log.warning("candidate turn-1 failed: %s", exc)
                continue

            # Turn 2 (multi-turn — include candidate's turn-1 answer).
            history_t2 = [
                ChatMessage(role="user", content=turn_1),
                ChatMessage(role="assistant", content=gen_1.text),
                ChatMessage(role="user", content=turn_2),
            ]
            try:
                gen_2 = client.generate(history_t2, cand_cfg)
            except Exception as exc:  # noqa: BLE001
                log.warning("candidate turn-2 failed: %s", exc)
                continue

            # Judge each turn separately.
            rating_1 = self._judge_turn(turn_1, gen_1.text, turn=1, cfg=judge_cfg)
            rating_2 = self._judge_turn(turn_2, gen_2.text, turn=2, cfg=judge_cfg)

            for r, key in ((rating_1, "turn_1"), (rating_2, "turn_2")):
                if r is None:
                    continue
                ratings.append(r)
                per_turn[key].append(r)
                per_category.setdefault(category, []).append(r)

            if (rating_1 is None or rating_2 is None) and len(failures) < 8:
                failures.append(
                    {
                        "question_id": item.get("question_id"),
                        "category": category,
                        "rating_1": rating_1,
                        "rating_2": rating_2,
                        "answer_1": gen_1.text[:200],
                        "answer_2": gen_2.text[:200],
                    }
                )

        n = len(ratings)
        if n == 0:
            raise RuntimeError("MT-Bench produced zero valid ratings")
        mean_rating = sum(ratings) / n
        score = mean_rating / 10.0

        def _mean(xs: list[float]) -> float:
            return round(sum(xs) / len(xs), 4) if xs else 0.0

        return BenchmarkResult(
            benchmark=BENCHMARK_ID,
            model=model,
            endpoint=endpoint,
            dataset_version=DATASET_VERSION,
            n=n,
            metrics={
                "score": round(score, 4),
                "mean_rating": round(mean_rating, 4),
                "turn_1_mean": _mean(per_turn["turn_1"]),
                "turn_2_mean": _mean(per_turn["turn_2"]),
                "n": float(n),
            },
            raw_json={
                "judge_model": self._judge_model,
                "category_mean": {
                    cat: round(sum(xs) / len(xs), 4) for cat, xs in per_category.items()
                },
            },
            failures=failures,
            elapsed_s=stats.elapsed(),
        )

    def _judge_turn(
        self,
        question: str,
        answer: str,
        *,
        turn: int,
        cfg: GenerationConfig,
    ) -> float | None:
        msgs = [
            ChatMessage(role="system", content=JUDGE_SYSTEM_PROMPT),
            ChatMessage(role="user", content=_build_judge_prompt(question, answer, turn=turn)),
        ]
        try:
            judgement = self._judge.generate(msgs, cfg)
        except Exception as exc:  # noqa: BLE001
            log.warning("judge failed (turn %d): %s", turn, exc)
            return None
        return _extract_rating(judgement.text)


class _MTBenchFactory(RunnerFactory):
    prog = "benchmarks.standard.mt_bench"
    description = "MT-Bench multi-turn open-ended benchmark with judge model (LMSYS-style)."

    def augment_parser(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument(
            "--judge-endpoint",
            default=None,
            help="OpenAI-compatible endpoint for the judge (defaults to --model-endpoint)",
        )
        parser.add_argument(
            "--judge-provider",
            default=None,
            help="Shortcut for --judge-endpoint",
        )
        parser.add_argument(
            "--judge-model",
            default="gpt-4o",
            help="Model id for the judge (recommend a strong model)",
        )
        parser.add_argument(
            "--judge-api-key-env",
            default="OPENAI_API_KEY",
            help="Env var holding the judge's API key",
        )
        parser.add_argument(
            "--max-tokens",
            type=int,
            default=1024,
            help="Cap on candidate generation per turn",
        )
        parser.add_argument(
            "--judge-max-tokens",
            type=int,
            default=384,
            help="Cap on judge generation per rating",
        )

    def build(self, args: argparse.Namespace) -> tuple[MTBenchRunner, Sequence[str] | None]:
        candidate_endpoint = resolve_endpoint(
            model_endpoint=args.model_endpoint,
            provider=args.provider,
        )
        judge_endpoint_input = args.judge_endpoint or args.model_endpoint
        judge_provider = args.judge_provider or args.provider
        try:
            judge_endpoint = resolve_endpoint(
                model_endpoint=judge_endpoint_input,
                provider=judge_provider,
            )
        except ValueError:
            judge_endpoint = candidate_endpoint
        judge_api_key = resolve_api_key(args.judge_api_key_env)

        judge: OpenAICompatibleClient
        mock_responses: Sequence[str] | None = None
        if args.mock:
            # Mock both candidate and judge. Candidate emits something
            # short; judge emits a deterministic 8.
            mock_responses = ["Mock answer." for _ in range(len(SMOKE_QUESTIONS) * 2)]
            judge = make_client(
                endpoint=judge_endpoint,
                api_key=judge_api_key,
                mock_responses=["Reasoning... Rating: [[8]]"]
                * (len(SMOKE_QUESTIONS) * 2),
            )
            runner = MTBenchRunner(
                judge=judge,
                judge_model=args.judge_model,
                questions=list(SMOKE_QUESTIONS),
                max_tokens=args.max_tokens,
                judge_max_tokens=args.judge_max_tokens,
            )
            return runner, mock_responses

        judge = HTTPOpenAICompatibleClient(endpoint=judge_endpoint, api_key=judge_api_key)
        runner = MTBenchRunner(
            judge=judge,
            judge_model=args.judge_model,
            max_tokens=args.max_tokens,
            judge_max_tokens=args.judge_max_tokens,
        )
        return runner, None


def main() -> int:
    cli_dispatch(_MTBenchFactory(), output_filename="mt-bench-results.json")
    return 0  # unreachable


if __name__ == "__main__":
    main()
