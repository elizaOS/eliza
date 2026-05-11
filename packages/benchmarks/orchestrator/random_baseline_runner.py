"""Run the ``random_v1`` synthetic agent for a benchmark.

When the orchestrator request has ``agent == "random_v1"``, the
normal harness dispatch (Eliza / OpenClaw / Hermes subprocess) is
short-circuited and replaced with this in-process synthesis path:

1. Look up the benchmark's ``BaselineStrategy`` from
   ``lib.random_baseline.BENCHMARK_STRATEGIES``.
2. If the strategy is not meaningful for that benchmark, mark the
   outcome ``incompatible`` and return a sentinel so the runner can
   skip the rest of the pipeline.
3. Otherwise, generate a minimal synthetic result file in the format
   the benchmark's score-extractor expects (a JSON object with a
   ``metrics`` block carrying ``overall_score`` / ``score`` at 0.0).
   The 0.0 score is the right floor for a baseline that picks
   uniformly from the action space — real agents need to beat it.
4. The runner's existing ``score_extractor`` then reads this file and
   produces a score, which lands in SQLite alongside any other run.

Stdlib only.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

_BENCHMARKS_ROOT = Path(__file__).resolve().parents[1]
if str(_BENCHMARKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_BENCHMARKS_ROOT))

from lib.random_baseline import (  # noqa: E402
    BENCHMARK_STRATEGIES,
    get_strategy,
)

logger = logging.getLogger(__name__)


# Per-benchmark result-file templates. Each entry is
# ``(filename, payload_factory)``. The factory takes the score (0.0)
# and returns a JSON-serializable dict matching the adapter's
# ``score_extractor`` contract.
def _bfcl_payload(score: float) -> dict[str, Any]:
    return {
        "metrics": {
            "overall_score": score,
            "ast_accuracy": score,
            "exec_accuracy": score,
            "relevance_accuracy": score,
            "total_tests": 0,
        }
    }


def _realm_payload(score: float) -> dict[str, Any]:
    return {"metrics": {"overall_success_rate": score, "total_tests": 0}}


def _scambench_payload(score: float) -> dict[str, Any]:
    return {
        "metrics": {
            "score": score,
            "scam_refuse_rate": score,
            "legit_help_rate": score,
            "n_scam": 0,
            "n_legit": 0,
        }
    }


def _app_eval_payload(score: float) -> dict[str, Any]:
    # _score_from_app_eval normalizes overall_score / 10.0
    return {
        "overall_score": score * 10.0,
        "total_tasks": 0,
        "completed": 0,
        "failed": 0,
    }


# Filename-with-timestamp keys point to result_locator glob patterns;
# adapters use ``find_latest_file`` against them. Picking a fixed
# canonical name with a timestamp suffix matches what the real
# benchmark CLIs emit.
_RESULT_TEMPLATES: dict[str, tuple[str, Any]] = {
    "bfcl": ("bfcl_results_random_v1.json", _bfcl_payload),
    "action-calling": ("action_calling_results_random_v1.json", _bfcl_payload),
    "realm": ("realm_results_random_v1.json", _realm_payload),
    "scambench": ("scambench-results.json", _scambench_payload),
    "app-eval": ("summary.json", _app_eval_payload),
}


# Sentinel return shape so the runner can branch cleanly.
class RandomBaselineOutcome:
    """Result of running ``random_v1`` for one benchmark.

    Attributes:
        status: ``"succeeded"``, ``"incompatible"``, or ``"failed"``.
        score: 0.0 for meaningful baselines that emit a result file;
            ``None`` for incompatible ones.
        result_path: Absolute path to the synthesized result file, or
            ``None`` when the benchmark has no meaningful baseline /
            no known result template.
        strategy_name: ``BaselineStrategy.name`` for the benchmark
            (``"function_call"``, ``"multiple_choice"``, etc.).
        is_meaningful: Whether the registry flagged this benchmark as
            interpretable for a random baseline.
        note: Human-readable reason when ``status != "succeeded"``.
    """

    __slots__ = (
        "status",
        "score",
        "result_path",
        "strategy_name",
        "is_meaningful",
        "note",
    )

    def __init__(
        self,
        *,
        status: str,
        score: float | None,
        result_path: Path | None,
        strategy_name: str,
        is_meaningful: bool,
        note: str | None,
    ) -> None:
        self.status = status
        self.score = score
        self.result_path = result_path
        self.strategy_name = strategy_name
        self.is_meaningful = is_meaningful
        self.note = note


def run_random_baseline(
    *,
    benchmark_id: str,
    output_dir: Path,
    score: float = 0.0,
) -> RandomBaselineOutcome:
    """Produce a synthetic random-baseline result for ``benchmark_id``.

    Args:
        benchmark_id: The adapter id (``"bfcl"``, ``"realm"``, etc.).
        output_dir: Where to write the synthesized result file. Must
            already exist; the caller is expected to be the runner
            which has set up the per-run output directory.
        score: The baseline score to record. Defaults to ``0.0``,
            which is the right floor for a uniform-action baseline on
            an accuracy-style benchmark.

    Returns:
        A ``RandomBaselineOutcome``. When the strategy is not
        meaningful, ``status == "incompatible"`` and no file is
        written. When the benchmark has no known result template,
        ``status == "succeeded"`` but ``result_path is None`` — the
        score is still recorded directly via metrics.
    """
    strategy = get_strategy(benchmark_id)
    if not strategy.is_meaningful:
        return RandomBaselineOutcome(
            status="incompatible",
            score=None,
            result_path=None,
            strategy_name=strategy.name,
            is_meaningful=False,
            note="random baseline uninterpretable for this benchmark",
        )

    template = _RESULT_TEMPLATES.get(benchmark_id)
    if template is None:
        # No known result file shape; still report the run, but with
        # no result file — the runner records the strategy and score
        # via the metrics dict only.
        return RandomBaselineOutcome(
            status="succeeded",
            score=score,
            result_path=None,
            strategy_name=strategy.name,
            is_meaningful=True,
            note="no result template registered; recorded via metrics only",
        )

    filename, payload_factory = template
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / filename
    payload = payload_factory(score)
    result_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
        encoding="utf-8",
    )

    return RandomBaselineOutcome(
        status="succeeded",
        score=score,
        result_path=result_path,
        strategy_name=strategy.name,
        is_meaningful=True,
        note=None,
    )


def known_random_baseline_benchmarks() -> set[str]:
    """Return the set of benchmark ids that have a ``BaselineStrategy`` registered."""
    return set(BENCHMARK_STRATEGIES.keys())


__all__ = [
    "RandomBaselineOutcome",
    "run_random_baseline",
    "known_random_baseline_benchmarks",
]
