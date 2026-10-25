from __future__ import annotations

from pathlib import Path
from functools import wraps

from benchmarks.bench_cli_types import ScoreExtraction
from benchmarks.registry import get_benchmark_registry, load_benchmark_result_json


from .types import ScoreSummary


class RegistryScoreExtractor:
    def __init__(self, workspace_root: Path):
        self._registry_map = {
            entry.id: entry for entry in get_benchmark_registry(workspace_root)
        }

    def for_benchmark(self, benchmark_id: str):
        if benchmark_id not in self._registry_map:
            raise KeyError(f"No declared scorer for benchmark {benchmark_id!r}")

        entry = self._registry_map[benchmark_id]

        @wraps(entry.extract_score)
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
