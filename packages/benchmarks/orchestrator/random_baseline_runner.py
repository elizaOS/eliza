"""Run synthetic calibration agents for a benchmark.

When the orchestrator request has a synthetic ``agent`` such as
``random_v1``, ``perfect_v1``, ``wrong_v1``, or ``half_v1``, normal
harness dispatch (Eliza / OpenClaw / Hermes subprocess) is short-circuited
and replaced with this in-process synthesis path:

1. Look up the benchmark's ``BaselineStrategy`` from
   ``lib.random_baseline.BENCHMARK_STRATEGIES``.
2. ``random_v1`` still honors ``is_meaningful`` and reports
   ``incompatible`` for benchmarks where random behavior is not
   interpretable.
3. Calibration harnesses are always meaningful. They inject expected
   aggregate scores so benchmark scoring can be sanity-checked:
   ``perfect_v1`` -> 1.0, ``wrong_v1`` -> 0.0, ``half_v1`` -> 0.5.
4. When a benchmark has a known result-file template, generate the
   minimal JSON shape the score extractor expects. Otherwise the
   runner records the score directly via metrics.
5. The runner's existing ``score_extractor`` then reads this file and
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

SYNTHETIC_HARNESSES: tuple[str, ...] = (
    "random_v1",
    "perfect_v1",
    "wrong_v1",
    "half_v1",
)
CALIBRATION_SPEC_VERSION = "calibration_v1"
CALIBRATION_HARNESSES: tuple[str, ...] = (
    "perfect_v1",
    "wrong_v1",
    "half_v1",
)


# Per-benchmark result-file templates. Each entry is
# ``(filename, payload_factory)``. The factory takes the expected score
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


def _action_calling_payload(score: float) -> dict[str, Any]:
    return {
        "generation_source": "synthetic_calibration",
        "n": 1,
        "metrics": {
            "score": score,
            "native_tool_calls_ok": score,
            "tool_name_match": score,
            "args_parse_ok": score,
            "required_keys_ok": score,
            "arguments_match": score,
        },
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


def _generic_payload(benchmark_id: str, harness: str, score: float) -> dict[str, Any]:
    return {
        "benchmark_id": benchmark_id,
        "agent": harness,
        "calibration": {
            "harness": harness,
            "expected_score": score,
            "synthetic": True,
        },
        "metrics": {
            "overall_score": score,
            "score": score,
            "overall_success_rate": score,
            "overall_accuracy": score,
            "accuracy": score,
        },
    }


# Filename-with-timestamp keys point to result_locator glob patterns;
# adapters use ``find_latest_file`` against them. Picking a fixed
# canonical name with a timestamp suffix matches what the real
# benchmark CLIs emit.
_RESULT_TEMPLATES: dict[str, tuple[str, Any]] = {
    "bfcl": ("bfcl_results_random_v1.json", _bfcl_payload),
    "action-calling": ("action_calling_results_random_v1.json", _action_calling_payload),
    "realm": ("realm_results_random_v1.json", _realm_payload),
    "scambench": ("scambench-results.json", _scambench_payload),
    "app-eval": ("summary.json", _app_eval_payload),
}


# Sentinel return shape so the runner can branch cleanly.
class RandomBaselineOutcome:
    """Result of running one synthetic harness for one benchmark.

    Attributes:
        status: ``"succeeded"``, ``"incompatible"``, or ``"failed"``.
        score: Expected score for meaningful synthetic harnesses;
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
        "harness",
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
        harness: str,
        status: str,
        score: float | None,
        result_path: Path | None,
        strategy_name: str,
        is_meaningful: bool,
        note: str | None,
    ) -> None:
        self.harness = harness
        self.status = status
        self.score = score
        self.result_path = result_path
        self.strategy_name = strategy_name
        self.is_meaningful = is_meaningful
        self.note = note


def is_synthetic_harness(harness: str) -> bool:
    return harness.strip().lower() in SYNTHETIC_HARNESSES


def synthetic_score_for_harness(harness: str) -> float:
    harness = harness.strip().lower()
    if harness in {"random_v1", "wrong_v1"}:
        return 0.0
    if harness == "perfect_v1":
        return 1.0
    if harness == "half_v1":
        return 0.5
    raise ValueError(f"unknown synthetic harness: {harness}")


def _filename_for_harness(filename: str, harness: str) -> str:
    if harness == "random_v1":
        return filename
    if "random_v1" in filename:
        return filename.replace("random_v1", harness)
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    return f"{stem}-{harness}{suffix}"


def run_synthetic_baseline(
    *,
    benchmark_id: str,
    output_dir: Path,
    harness: str,
    score: float | None = None,
) -> RandomBaselineOutcome:
    """Produce a synthetic result for ``benchmark_id`` and ``harness``.

    ``random_v1`` remains a chance-level baseline and may be incompatible
    when chance behavior is not interpretable. ``perfect_v1``, ``wrong_v1``,
    and ``half_v1`` are calibration harnesses used to test whether a
    benchmark scorer can represent the expected endpoints and midpoint.
    They do not claim to execute task-level tool calls.
    """
    harness = harness.strip().lower()
    if not is_synthetic_harness(harness):
        raise ValueError(f"unknown synthetic harness: {harness}")

    strategy = get_strategy(benchmark_id)
    expected_score = synthetic_score_for_harness(harness) if score is None else float(score)
    if harness == "random_v1" and not strategy.is_meaningful:
        return RandomBaselineOutcome(
            harness=harness,
            status="incompatible",
            score=None,
            result_path=None,
            strategy_name=strategy.name,
            is_meaningful=False,
            note="random baseline uninterpretable for this benchmark",
        )

    template = _RESULT_TEMPLATES.get(benchmark_id)
    if template is None:
        output_dir.mkdir(parents=True, exist_ok=True)
        result_path = output_dir / f"{benchmark_id}-{harness}-calibration.json"
        result_path.write_text(
            json.dumps(
                _generic_payload(benchmark_id, harness, expected_score),
                indent=2,
                sort_keys=True,
                ensure_ascii=True,
            ),
            encoding="utf-8",
        )
        return RandomBaselineOutcome(
            harness=harness,
            status="succeeded",
            score=expected_score,
            result_path=None,
            strategy_name=strategy.name,
            is_meaningful=(strategy.is_meaningful or harness in CALIBRATION_HARNESSES),
            note=f"no result template registered; wrote generic payload at {result_path.name} and recorded expected aggregate score directly",
        )

    filename, payload_factory = template
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / _filename_for_harness(filename, harness)
    payload = payload_factory(expected_score)
    if isinstance(payload, dict):
        payload.setdefault("calibration", {})
        calibration = payload["calibration"]
        if isinstance(calibration, dict):
            calibration.update(
                {
                    "harness": harness,
                    "expected_score": expected_score,
                    "synthetic": True,
                }
            )
    result_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
        encoding="utf-8",
    )

    return RandomBaselineOutcome(
        harness=harness,
        status="succeeded",
        score=expected_score,
        result_path=result_path,
        strategy_name=strategy.name,
        is_meaningful=(strategy.is_meaningful or harness in CALIBRATION_HARNESSES),
        note=None,
    )


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
    return run_synthetic_baseline(
        benchmark_id=benchmark_id,
        output_dir=output_dir,
        harness="random_v1",
        score=score,
    )


def known_random_baseline_benchmarks() -> set[str]:
    """Return the set of benchmark ids that have a ``BaselineStrategy`` registered."""
    return set(BENCHMARK_STRATEGIES.keys())


__all__ = [
    "CALIBRATION_HARNESSES",
    "CALIBRATION_SPEC_VERSION",
    "RandomBaselineOutcome",
    "SYNTHETIC_HARNESSES",
    "is_synthetic_harness",
    "run_random_baseline",
    "run_synthetic_baseline",
    "synthetic_score_for_harness",
    "known_random_baseline_benchmarks",
]
