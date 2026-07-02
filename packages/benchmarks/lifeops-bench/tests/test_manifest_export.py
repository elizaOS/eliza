"""Contracts for the committed LifeOps action manifest."""

from __future__ import annotations

from collections import Counter
import json
import re
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[2]
MANIFEST_PATH = PACKAGE_ROOT / "manifests" / "actions.manifest.json"
SUMMARY_PATH = PACKAGE_ROOT / "manifests" / "actions.summary.md"
ROOT_PACKAGE_JSON = REPO_ROOT / "package.json"


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_root_manifest_regeneration_script_is_registered() -> None:
    root_package = json.loads(ROOT_PACKAGE_JSON.read_text(encoding="utf-8"))
    command = root_package["scripts"]["lifeops-bench:manifest"]
    assert "scripts/lifeops-bench/export-action-manifest.ts" in command
    assert "--conditions=eliza-source" in command
    assert "--conditions=development" in command
    assert "--import tsx" in command


def test_manifest_has_in_tree_generator_metadata() -> None:
    manifest = _manifest()
    assert manifest["schemaVersion"] == 1
    assert manifest["generator"] == "scripts/lifeops-bench/export-action-manifest.ts"
    assert manifest["sourcePlugins"] == [
        "@elizaos/plugin-contacts",
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


def test_summary_counts_match_manifest() -> None:
    actions = _manifest()["actions"]
    summary = SUMMARY_PATH.read_text(encoding="utf-8")

    total_match = re.search(r"^Total actions: (\d+)$", summary, re.MULTILINE)
    assert total_match is not None
    assert int(total_match.group(1)) == len(actions)

    by_plugin = Counter(entry["_plugin"] for entry in actions)
    for plugin, count in by_plugin.items():
        assert f"| {plugin} | {count} |" in summary
