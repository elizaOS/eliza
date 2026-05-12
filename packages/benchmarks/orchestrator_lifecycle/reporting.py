"""Reporting helpers for orchestrator lifecycle benchmark."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from .types import LifecycleConfig, LifecycleMetrics, ScenarioResult


def save_report(
    *,
    config: LifecycleConfig,
    results: list[ScenarioResult],
    metrics: LifecycleMetrics,
    transcripts: dict[str, list[dict[str, str]]],
) -> Path:
    output_dir = Path(config.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = output_dir / f"orchestrator-lifecycle-{timestamp}.json"
    payload = {
        "metadata": {
            "timestamp": datetime.now().isoformat(),
            "model": config.model,
            "provider": config.provider,
            "strict": config.strict,
            "max_scenarios": config.max_scenarios,
            "scenario_filter": config.scenario_filter,
        },
        "scenarios": [asdict(result) for result in results],
        "metrics": asdict(metrics),
        "transcripts": transcripts,
    }
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    return output_path
