#!/usr/bin/env python3
"""
Score stage-level ScamBench decisions against an arbitrary catalog JSON.

This mirrors the current TypeScript scorer so local ablation slices can be
scored without going through the full recorded-decision CLI path.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent

sys.path.insert(0, str(PYTHON_ROOT))

from src.training.scambench_scoring import (
    score_scenario,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Score stage decisions against a ScamBench catalog."
    )
    parser.add_argument("--catalog", required=True, help="Path to ScamBench catalog JSON.")
    parser.add_argument("--decisions", required=True, help="Path to stage-level decisions JSON.")
    parser.add_argument("--output", required=True, help="Path to write JSON report.")
    parser.add_argument("--handler", default=None, help="Optional handler/model label override.")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    decisions = json.loads(Path(args.decisions).read_text(encoding="utf-8"))
    scenarios = catalog.get("scenarios", [])

    decisions_by_scenario: dict[str, dict[str, dict[str, Any]]] = {}
    for entry in decisions:
        scenario_id = str(entry.get("scenarioId"))
        stage_id = str(entry.get("stageId"))
        decisions_by_scenario.setdefault(scenario_id, {})[stage_id] = entry

    results: list[dict[str, Any]] = []
    for scenario in scenarios:
        scenario_id = scenario["id"]
        score = score_scenario(scenario, decisions_by_scenario.get(scenario_id, {}))
        results.append(
            {
                "scenarioId": scenario_id,
                "suite": scenario["suite"],
                "category": scenario["category"],
                "score": score,
            }
        )

    overall_score = sum(item["score"]["overallScore"] for item in results) / max(len(results), 1)
    report = {
        "handler": args.handler or Path(args.decisions).stem,
        "scenariosRun": len(results),
        "stageCount": sum(len(scenario.get("stages", [])) for scenario in scenarios),
        "overallScore": overall_score,
        "results": results,
    }
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(output_path),
                "scenariosRun": report["scenariosRun"],
                "stageCount": report["stageCount"],
                "overallScore": report["overallScore"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
