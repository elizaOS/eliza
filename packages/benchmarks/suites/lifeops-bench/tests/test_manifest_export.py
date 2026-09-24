"""Contracts for the committed LifeOps action manifest."""

from __future__ import annotations

from collections import Counter
import json
import re
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PACKAGE_ROOT / "manifests" / "actions.manifest.json"
SUMMARY_PATH = PACKAGE_ROOT / "manifests" / "actions.summary.md"


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_manifest_has_in_tree_generator_metadata() -> None:
    manifest = _manifest()
    assert manifest["schemaVersion"] == 1
    assert manifest["generator"] == "suites/lifeops-bench/scripts/export-action-manifest.ts"
    assert manifest["sourcePlugins"] == [
        "@elizaos/plugin-contacts",
        "@elizaos/plugin-calendar",
        "@elizaos/plugin-personal-assistant",
        "@elizaos/plugin-phone",
        "bluebubbles",
        "imessage",
        "todos",
    ]
    assert manifest["filters"] == {
        "domains": [],
        "capabilities": [],
        "surfaces": [],
        "excludeRisks": [],
        "benchUmbrellaAugment": True,
    }


def test_manifest_actions_are_unique_sorted_and_augmented() -> None:
    actions = _manifest()["actions"]
    assert isinstance(actions, list)
    names = [entry["function"]["name"] for entry in actions]
    assert names == sorted(names)
    assert len(names) == len(set(names))
    assert "CALENDAR_SOURCES" in names

    bench_names = {
        entry["function"]["name"]
        for entry in actions
        if entry.get("_plugin") == "@elizaos/lifeops-bench"
    }
    assert {
        "LIFE_CREATE",
        "LIFE_COMPLETE",
        "HEALTH",
        "MONEY_DASHBOARD",
        "BOOK_TRAVEL",
        "SCHEDULED_TASK_CREATE",
    }.issubset(bench_names)


def test_scheduled_task_augments_cover_expanded_scenario_kwargs() -> None:
    actions = {
        entry["function"]["name"]: entry
        for entry in _manifest()["actions"]
    }
    create_properties = actions["SCHEDULED_TASK_CREATE"]["function"]["parameters"][
        "properties"
    ]
    update_properties = actions["SCHEDULED_TASK_UPDATE"]["function"]["parameters"][
        "properties"
    ]

    assert {
        "escalation",
        "metadata",
        "output",
        "pipeline",
        "respectsGlobalPause",
        "subject",
    }.issubset(create_properties)
    assert "updates" in update_properties


def test_plugin_action_overlays_cover_expanded_scenario_kwargs() -> None:
    actions = {
        entry["function"]["name"]: entry for entry in _manifest()["actions"]
    }
    block_properties = actions["BLOCK_BLOCK"]["function"]["parameters"][
        "properties"
    ]
    travel_properties = actions["BOOK_TRAVEL"]["function"]["parameters"][
        "properties"
    ]
    finance_properties = actions["MONEY_SUBSCRIPTION_CANCEL"]["function"][
        "parameters"
    ]["properties"]

    assert {"exceptions", "mode", "policy", "schedule"}.issubset(
        block_properties
    )
    assert {"approval", "calendarSync", "hotelCheckIn", "rebookReason"}.issubset(
        travel_properties
    )
    assert {schema["type"] for schema in travel_properties["passengers"]["anyOf"]} == {
        "array",
        "number",
    }
    assert "candidateId" in finance_properties


def test_summary_counts_match_manifest() -> None:
    actions = _manifest()["actions"]
    summary = SUMMARY_PATH.read_text(encoding="utf-8")

    total_match = re.search(r"^Total actions: (\d+)$", summary, re.MULTILINE)
    assert total_match is not None
    assert int(total_match.group(1)) == len(actions)

    by_plugin = Counter(entry["_plugin"] for entry in actions)
    for plugin, count in by_plugin.items():
        assert f"| {plugin} | {count} |" in summary
