from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import Any

if __package__ == "orchestrator":
    from bench_cli_types import ScoreExtraction
    from registry import get_benchmark_registry, load_benchmark_result_json
else:
    from benchmarks.bench_cli_types import ScoreExtraction
    from benchmarks.registry import get_benchmark_registry, load_benchmark_result_json

from .types import ScoreSummary


def _flatten_pairs(obj: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(obj, dict):
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            yield from _flatten_pairs(value, path)
    elif isinstance(obj, list):
        for idx, value in enumerate(obj):
            path = f"{prefix}[{idx}]"
            yield from _flatten_pairs(value, path)
    else:
        yield prefix, obj


def _coerce_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip().replace(",", "")
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


GENERIC_SCORE_KEYS: tuple[str, ...] = (
    "overall_score",
    "score",
    "overall_success_rate",
    "overall_accuracy",
    "resolve_rate",
    "success_rate",
    "task_success_rate",
    "overall_step_accuracy",
    "accuracy",
    "final_reward",
    "max_net_worth",
)


def generic_score_extractor(result_path: Path) -> ScoreSummary:
    data = load_benchmark_result_json(result_path)

    flat = dict(_flatten_pairs(data))
    for key in GENERIC_SCORE_KEYS:
        candidates = [v for p, v in flat.items() if p.endswith(key)]
        for candidate in candidates:
            number = _coerce_number(candidate)
            if number is None:
                continue
            unit = "ratio" if "rate" in key or "accuracy" in key or "score" in key else None
            return ScoreSummary(
                score=number,
                unit=unit,
                higher_is_better=True,
                metrics={"auto_score_key": key},
            )

    return ScoreSummary(score=None, unit=None, higher_is_better=None, metrics={})


class RegistryScoreExtractor:
    def __init__(self, workspace_root: Path):
        self._registry_map = {
            entry.id: entry for entry in get_benchmark_registry(workspace_root)
        }

    def for_benchmark(self, benchmark_id: str):
        if benchmark_id not in self._registry_map:
            return generic_score_extractor

        entry = self._registry_map[benchmark_id]

        def extractor(result_path: Path) -> ScoreSummary:
            data = load_benchmark_result_json(result_path)
            extraction: ScoreExtraction = entry.extract_score(data)
            return ScoreSummary(
                score=extraction.score,
                unit=extraction.unit,
                higher_is_better=extraction.higher_is_better,
                metrics=extraction.metrics,
            )

        return extractor
