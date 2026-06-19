from __future__ import annotations

from pathlib import Path

import yaml

from eliza_compactbench.scenarios import (
    EDGE_VARIANTS,
    build_expanded_suite,
    count_scenarios,
    validate_suite,
)


def _write_template(path: Path, key: str = "memory_template_v1") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(
            {
                "template": {
                    "key": key,
                    "family": "memory_template",
                    "version": "1.0.0",
                    "difficulty_policy": {
                        "distractor_turns": {"easy": 1, "medium": 2, "hard": 3},
                        "paraphrase_depth": {"easy": 0, "medium": 1, "hard": 2},
                    },
                    "variables": [{"name": "entity", "generator": "person_name"}],
                    "transcript": {
                        "turns": [
                            {"role": "user", "template": "Remember {{entity}} owns the launch."},
                            {"role": "assistant", "template": "Noted."},
                            {"role": "user", "template": "Who owns the launch?"},
                        ]
                    },
                    "ground_truth": {
                        "immutable_facts": ["owner: {{entity}}"],
                        "entity_map": {"{{entity}}": "owner"},
                    },
                    "evaluation_items": [
                        {
                            "key": "owner_recall",
                            "type": "entity_integrity",
                            "prompt": "Who owns the launch?",
                            "expected": {"check": "contains_normalized", "value": "{{entity}}"},
                        }
                    ],
                }
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )


def test_count_scenarios_reports_exact_10x_edges(tmp_path: Path) -> None:
    _write_template(tmp_path / "starter" / "one.yaml")
    _write_template(tmp_path / "starter" / "two.yaml", key="second_template_v1")

    assert count_scenarios(
        benchmarks_dir=tmp_path,
        suite="starter",
        case_count=3,
        include_edge_scenarios=True,
    ) == {
        "templates": 2,
        "base": 6,
        "edge": 60,
        "total": 66,
        "edge_multiplier": 10,
    }


def test_build_expanded_suite_writes_base_and_edge_templates(tmp_path: Path) -> None:
    _write_template(tmp_path / "public" / "starter" / "one.yaml")

    validate_suite(tmp_path / "public", "starter")
    expanded_root = build_expanded_suite(
        benchmarks_dir=tmp_path / "public",
        suite="starter",
        output_root=tmp_path / "expanded",
    )

    files = sorted((expanded_root / "starter").glob("*.yaml"))
    assert len(files) == 1 + len(EDGE_VARIANTS)
    edge = yaml.safe_load((expanded_root / "starter" / "one--edge-01.yaml").read_text())
    template = edge["template"]
    assert template["key"] == "memory_template_v1--edge-01"
    assert template["ground_truth"]["immutable_facts"] == ["owner: {{entity}}"]
    assert any("Edge memory note" in turn.get("template", "") for turn in template["transcript"]["turns"])
