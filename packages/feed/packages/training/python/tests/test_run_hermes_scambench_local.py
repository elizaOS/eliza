from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

PYTHON_ROOT = Path(__file__).resolve().parent.parent


def load_script_module(module_name: str, script_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


runner_script = load_script_module(
    "run_hermes_scambench_local_test_module",
    PYTHON_ROOT / "scripts" / "run_hermes_scambench_local.py",
)


def test_load_existing_decisions_indexes_by_stage(tmp_path: Path):
    output_path = tmp_path / "decisions.json"
    output_path.write_text(
        json.dumps(
            [
                {
                    "scenarioId": "scenario-a",
                    "stageId": "stage-1",
                    "chosenAction": "refuse",
                    "responseText": "no",
                },
                {
                    "scenarioId": "scenario-a",
                    "stageId": "stage-2",
                    "chosenAction": "audit",
                    "responseText": "check",
                },
            ]
        ),
        encoding="utf-8",
    )

    indexed = runner_script.load_existing_decisions(output_path)

    assert set(indexed) == {"scenario-a::stage-1", "scenario-a::stage-2"}
    assert indexed["scenario-a::stage-2"]["chosenAction"] == "audit"


def test_ordered_decisions_respects_catalog_order():
    scenarios = [
        {
            "id": "scenario-a",
            "stages": [{"id": "stage-1"}, {"id": "stage-2"}],
        },
        {
            "id": "scenario-b",
            "stages": [{"id": "stage-1"}],
        },
    ]
    decisions_by_key = {
        "scenario-b::stage-1": {"scenarioId": "scenario-b", "stageId": "stage-1"},
        "scenario-a::stage-2": {"scenarioId": "scenario-a", "stageId": "stage-2"},
        "scenario-a::stage-1": {"scenarioId": "scenario-a", "stageId": "stage-1"},
    }

    ordered = runner_script.ordered_decisions(scenarios, decisions_by_key)

    assert [(decision["scenarioId"], decision["stageId"]) for decision in ordered] == [
        ("scenario-a", "stage-1"),
        ("scenario-a", "stage-2"),
        ("scenario-b", "stage-1"),
    ]


def test_filter_scenarios_applies_id_filter_and_limit():
    scenarios = [
        {"id": "scenario-a"},
        {"id": "scenario-b"},
        {"id": "scenario-c"},
    ]

    filtered = runner_script.filter_scenarios(
        scenarios,
        allowed_ids={"scenario-a", "scenario-c"},
        limit=1,
    )

    assert filtered == [{"id": "scenario-a"}]
