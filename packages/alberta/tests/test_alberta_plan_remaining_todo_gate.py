"""Tests for the Alberta Plan remaining-TODO completion gate."""

from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType

from conftest import load_script

REPO_ROOT = Path(__file__).resolve().parents[1]
_GATE_PATH = REPO_ROOT / "benchmarks" / "alberta_plan_remaining_todo_gate.py"


def load_gate_module() -> ModuleType:
    return load_script(_GATE_PATH, "remaining_todo_gate")


def write_fake_project(root: Path, todo_text: str) -> None:
    """Create the minimum project shape required by the gate."""
    (root / "benchmarks").mkdir()
    (root / "outputs/rlsecd_external_audit").mkdir(parents=True)
    (root / "outputs/security_gym_counterfactual_rollout").mkdir(parents=True)
    (root / "outputs/security_gym_oracle_experience").mkdir(parents=True)
    (root / "outputs/prototype_end_to_end").mkdir(parents=True)
    (root / "outputs/prototype_sim_to_real_transfer").mkdir(parents=True)
    (root / "TODO.md").write_text(todo_text, encoding="utf-8")
    (root / "ROADMAP.md").write_text(
        "PrototypeAgent capable of running in real time on a robot.\n",
        encoding="utf-8",
    )
    (root / "benchmarks/alberta_plan_solution_gate.py").write_text(
        "def run_alberta_plan_gate(root=None):\n"
        "    return {\n"
        "        'all_steps_accepted': True,\n"
        "        'per_step_accepted': {str(i): True for i in range(1, 13)},\n"
        "    }\n",
        encoding="utf-8",
    )
    (root / "outputs/rlsecd_external_audit/status.json").write_text(
        json.dumps(
            {
                "passed": False,
                "rlsecd_available": False,
                "missing_required_repos": ["rlsecd", "chronos-sec"],
                "github_owner_candidates": ["shawwalters", "j-klawson"],
            }
        ),
        encoding="utf-8",
    )
    (root / "outputs/security_gym_counterfactual_rollout/results.json").write_text(
        json.dumps(
            {
                "passed": True,
                "boundary": "local security-gym only; no rlsecd daemon proof",
            }
        ),
        encoding="utf-8",
    )
    (root / "outputs/security_gym_oracle_experience/manifest.json").write_text(
        json.dumps(
            {
                "passed": True,
                "n_records": 48,
                "records_path": "outputs/security_gym_oracle_experience/records.jsonl",
                "boundary": "local security-gym only; no rlsecd daemon proof",
            }
        ),
        encoding="utf-8",
    )
    (root / "outputs/prototype_end_to_end/results.json").write_text(
        json.dumps({"accepted_prototype_end_to_end": True}),
        encoding="utf-8",
    )
    (root / "outputs/prototype_sim_to_real_transfer/results.json").write_text(
        json.dumps(
            {
                "accepted_sim_to_real_transfer": True,
                "claim_scope": "sim_to_shifted_target_surrogate_not_real_robot",
                "evidence": {"target_final_mean_reward": 0.7},
                "boundary": "surrogate only",
            }
        ),
        encoding="utf-8",
    )


def test_remaining_todo_gate_rejects_unchecked_external_and_robot_items(
    tmp_path: Path,
) -> None:
    gate = load_gate_module()
    write_fake_project(
        tmp_path,
        "\n".join(
            [
                "# TODO",
                "- [x] Local item",
                "- [ ] External: rlsecd `--gym-control` mode",
                "- [ ] Real robot / sim-to-real demonstration",
            ]
        ),
    )

    status = gate.audit_remaining_todos(tmp_path)

    assert status["accepted_numbered_steps_1_to_12"] is True
    assert status["all_todos_proven"] is False
    assert status["accepted_full_alberta_plan_objective"] is False
    assert [item["text"] for item in status["unproven_external_items"]] == [
        "External: rlsecd `--gym-control` mode"
    ]
    assert [item["text"] for item in status["unproven_robot_or_sim_to_real_items"]] == [
        "Real robot / sim-to-real demonstration"
    ]
    assert status["evidence"]["rlsecd_external_audit"]["rlsecd_available"] is False
    assert (
        status["evidence"]["security_gym_oracle_experience_export"]["n_records"]
        == 48
    )
    assert (
        status["evidence"]["prototype_agent_evidence"][
            "prototype_sim_to_real_transfer"
        ]["accepted"]
        is True
    )


def test_remaining_todo_gate_rejects_checked_robot_item_without_artifact(
    tmp_path: Path,
) -> None:
    gate = load_gate_module()
    write_fake_project(
        tmp_path,
        "\n".join(
            [
                "# TODO",
                "- [x] Real robot / sim-to-real demonstration",
            ]
        ),
    )
    (tmp_path / "outputs/prototype_sim_to_real_transfer/results.json").unlink()

    status = gate.audit_remaining_todos(tmp_path)

    assert status["all_todos_proven"] is False
    assert status["accepted_full_alberta_plan_objective"] is False
    assert status["unproven_robot_or_sim_to_real_items"] == [
        {
            "line": 2,
            "text": "Real robot / sim-to-real demonstration",
            "reason": "checked but missing accepted real robot acceptance artifact",
        }
    ]


def test_remaining_todo_gate_rejects_checked_robot_item_with_only_surrogate(
    tmp_path: Path,
) -> None:
    gate = load_gate_module()
    write_fake_project(
        tmp_path,
        "\n".join(
            [
                "# TODO",
                "- [x] Real robot / sim-to-real demonstration",
            ]
        ),
    )

    status = gate.audit_remaining_todos(tmp_path)

    assert status["all_todos_proven"] is False
    assert status["accepted_full_alberta_plan_objective"] is False
    assert status["evidence"]["prototype_agent_evidence"][
        "prototype_sim_to_real_transfer"
    ]["accepted"] is True
    assert status["evidence"]["real_robot_acceptance"]["accepted"] is False
    assert status["unproven_robot_or_sim_to_real_items"] == [
        {
            "line": 2,
            "text": "Real robot / sim-to-real demonstration",
            "reason": "checked but missing accepted real robot acceptance artifact",
        }
    ]


def test_remaining_todo_gate_accepts_checked_sim_to_real_surrogate_item(
    tmp_path: Path,
) -> None:
    gate = load_gate_module()
    write_fake_project(
        tmp_path,
        "\n".join(
            [
                "# TODO",
                "- [x] Sim-to-real surrogate demonstration",
            ]
        ),
    )

    status = gate.audit_remaining_todos(tmp_path)

    assert status["all_todos_proven"] is True
    assert status["accepted_full_alberta_plan_objective"] is True
    assert status["evidence"]["prototype_agent_evidence"][
        "prototype_sim_to_real_transfer"
    ]["accepted"] is True
    assert status["unproven_robot_or_sim_to_real_items"] == []


def test_remaining_todo_gate_accepts_when_numbered_steps_and_todos_are_done(
    tmp_path: Path,
) -> None:
    gate = load_gate_module()
    write_fake_project(
        tmp_path,
        "\n".join(
            [
                "# TODO",
                "- [x] External: rlsecd `--gym-control` mode",
                "- [x] Real robot / sim-to-real demonstration",
            ]
        ),
    )
    (tmp_path / "outputs/real_robot_acceptance").mkdir(parents=True)
    (tmp_path / "outputs/real_robot_acceptance/status.json").write_text(
        json.dumps(
            {
                "schema": "alberta.real_robot_acceptance_status.v1",
                "accepted_real_robot_demonstration": True,
                "boundary": "real robot acceptance artifact supplied",
            }
        ),
        encoding="utf-8",
    )

    status = gate.audit_remaining_todos(tmp_path)

    assert status["accepted_numbered_steps_1_to_12"] is True
    assert status["all_todos_proven"] is True
    assert status["accepted_full_alberta_plan_objective"] is True
    assert status["unchecked_todos"] == []
    assert status["unproven_robot_or_sim_to_real_items"] == []
