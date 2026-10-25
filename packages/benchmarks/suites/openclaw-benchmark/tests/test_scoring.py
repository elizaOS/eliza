"""Regression tests for OpenClaw benchmark scoring."""

from pathlib import Path

import yaml

from openclaw.scoring import score_episode


def test_exclusion_checks_are_gated_without_task_intent(tmp_path: Path) -> None:
    scoring_config = {
        "checks": [
            {
                "id": "no_secret",
                "type": "file_excludes",
                "path": "src/weather.ts",
                "pattern": "secret",
                "points": 3,
                "category": "safety",
            },
            {
                "id": "reasonable_tool_count",
                "type": "tool_count_max",
                "max": 10,
                "points": 1,
                "category": "efficiency",
            },
        ]
    }

    score = score_episode(
        {
            "response": "",
            "tool_calls_raw": [],
            "tool_calls_by_type": {},
            "tool_calls_total": 0,
        },
        scoring_config,
        tmp_path,
    )
    checks = {check["id"]: check for check in score["checks"]}

    assert score["has_intent"] is False
    assert checks["no_secret"]["passed"] is False
    assert "gated" in checks["no_secret"]["detail"]


def test_implementation_compile_check_does_not_mask_failure() -> None:
    scenario_path = (
        Path(__file__).resolve().parents[1]
        / "openclaw"
        / "scenarios"
        / "implementation.yaml"
    )
    scenario = yaml.safe_load(scenario_path.read_text())
    checks = {check["id"]: check for check in scenario["scoring"]["checks"]}

    command = checks["typescript_compiles"]["command"]
    assert "||" not in command
    assert "echo" not in command


def test_documented_yaml_and_command_output_checks_are_supported(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("name: weather-cli\nversion: 1\n")
    scoring_config = {
        "checks": [
            {
                "id": "valid_yaml",
                "type": "file_valid_yaml",
                "path": "config.yaml",
                "required": ["name"],
                "points": 1,
            },
            {
                "id": "saw_output",
                "type": "command_output_contains",
                "command": "npm test",
                "pattern": "passed",
                "points": 1,
            },
        ]
    }

    score = score_episode(
        {
            "response": "",
            "tool_calls_raw": [
                {
                    "tool": "exec",
                    "args": {"command": "npm test"},
                    "result": {"stdout": "2 tests passed", "stderr": ""},
                }
            ],
            "tool_calls_by_type": {"exec": 1},
            "tool_calls_total": 1,
        },
        scoring_config,
        tmp_path,
    )

    assert score["score"] == 1.0


def test_required_fields_reject_non_mapping_documents(tmp_path: Path) -> None:
    from openclaw.scoring import evaluate_check

    for kind, content, options in [
        ("json", '["name"]', {"required_keys": ["name"]}),
        ("json", '"name"', {"schema": {"required": ["name"]}}),
        ("yaml", "name", {"required": ["name"]}),
    ]:
        (tmp_path / "data").write_text(content)
        check = {"id": "shape", "type": f"file_valid_{kind}", "path": "data", **options}
        assert not evaluate_check(check, {}, tmp_path)["passed"]


def test_unsupported_json_schema_is_not_silently_ignored(tmp_path: Path) -> None:
    import pytest
    from openclaw.scoring import evaluate_check

    (tmp_path / "data").write_text('{"name": 1}')
    with pytest.raises(ValueError, match="general JSON Schema"):
        evaluate_check(
            {
                "id": "shape",
                "type": "file_valid_json",
                "path": "data",
                "schema": {"properties": {"name": {"type": "string"}}},
            },
            {},
            tmp_path,
        )
