"""Publication checks require the full pinned lifecycle corpus and transcripts."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import pytest

import benchmarks.orchestrator_lifecycle.contract as lifecycle_contract
import benchmarks.registry.scores as scores_module
from benchmarks.orchestrator_lifecycle.dataset import LifecycleDataset
from benchmarks.orchestrator_lifecycle.evaluator import LifecycleEvaluator
from benchmarks.orchestrator_lifecycle.reporting import save_report
from benchmarks.orchestrator_lifecycle.runner import _simulate_turn
from benchmarks.orchestrator_lifecycle.types import LifecycleConfig
from benchmarks.registry.scores import _score_from_orchestrator_lifecycle_json


def _full_report(tmp_path: Path) -> dict[str, object]:
    dataset = LifecycleDataset("benchmarks/orchestrator_lifecycle/scenarios")
    evaluator = LifecycleEvaluator()
    results = []
    transcripts: dict[str, list[dict[str, object]]] = {}
    for scenario in dataset.load():
        records = []
        transcript: list[dict[str, object]] = []
        for turn in scenario.turns:
            assert turn.actor == "user"
            record = _simulate_turn(turn)
            records.append(record)
            transcript.extend(
                [
                    {"actor": "user", "message": turn.message},
                    {
                        "actor": "assistant",
                        "message": record.reply_text,
                        "actions": list(record.actions),
                        "params": dict(record.params),
                        "events": list(record.events),
                    },
                ]
            )
        results.append(evaluator.evaluate_scenario(scenario, records))
        transcripts[scenario.scenario_id] = transcript
    metrics = evaluator.compute_metrics(results)
    path = save_report(
        config=LifecycleConfig(output_dir=str(tmp_path), strict=True),
        results=results,
        metrics=metrics,
        transcripts=transcripts,
        mode="bridge",
    )
    return json.loads(path.read_text(encoding="utf-8"))


def test_full_bridge_report_is_publishable(tmp_path: Path) -> None:
    report = _full_report(tmp_path)

    extraction = _score_from_orchestrator_lifecycle_json(report)

    assert extraction.score == report["metrics"]["overall_score"]
    assert extraction.metrics["total_scenarios"] == 132


def _point_scorer_at_temp_lifecycle_sources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    contract_source: str | None = None,
    tasks_tool: object | None = None,
) -> None:
    registry_dir = tmp_path / "installed" / "registry"
    lifecycle_dir = tmp_path / "installed" / "orchestrator_lifecycle"
    registry_dir.mkdir(parents=True)
    lifecycle_dir.mkdir(parents=True)
    canonical_contract_path = Path(lifecycle_contract.__file__)
    canonical_tool_path = canonical_contract_path.with_name("tasks-tool.json")
    if contract_source is None:
        contract_source = canonical_contract_path.read_text(encoding="utf-8")
    if tasks_tool is None:
        tasks_tool = json.loads(canonical_tool_path.read_text(encoding="utf-8"))
    (lifecycle_dir / "contract.py").write_text(contract_source, encoding="utf-8")
    (lifecycle_dir / "tasks-tool.json").write_text(
        json.dumps(tasks_tool), encoding="utf-8"
    )
    monkeypatch.setattr(scores_module, "__file__", str(registry_dir / "scores.py"))


def test_publication_rejects_loaded_system_hint_monkeypatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = _full_report(tmp_path / "report")
    monkeypatch.setattr(
        lifecycle_contract,
        "LIFECYCLE_SYSTEM_HINT",
        "A monkeypatched lifecycle instruction.",
    )

    with pytest.raises(ValueError, match="loaded lifecycle system hint drifted"):
        _score_from_orchestrator_lifecycle_json(report)


def test_publication_rejects_loaded_tasks_contract_monkeypatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = _full_report(tmp_path / "report")
    drifted_tool = deepcopy(lifecycle_contract.LIFECYCLE_TASKS_TOOLS[0])
    function = drifted_tool["function"]
    assert isinstance(function, dict)
    function["description"] = "A monkeypatched TASKS contract."
    monkeypatch.setattr(
        lifecycle_contract,
        "LIFECYCLE_TASKS_TOOLS",
        (drifted_tool,),
    )

    with pytest.raises(ValueError, match="loaded TASKS tool contract drifted"):
        _score_from_orchestrator_lifecycle_json(report)


def test_publication_rejects_installed_system_hint_source_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = _full_report(tmp_path / "report")
    _point_scorer_at_temp_lifecycle_sources(
        tmp_path,
        monkeypatch,
        contract_source='LIFECYCLE_SYSTEM_HINT = "A drifted source instruction."\n',
    )

    with pytest.raises(ValueError, match="installed lifecycle system hint drifted"):
        _score_from_orchestrator_lifecycle_json(report)


def test_publication_rejects_installed_tasks_contract_source_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = _full_report(tmp_path / "report")
    canonical_tool_path = Path(lifecycle_contract.__file__).with_name("tasks-tool.json")
    drifted_tool = json.loads(canonical_tool_path.read_text(encoding="utf-8"))
    function = drifted_tool["function"]
    assert isinstance(function, dict)
    function["description"] = "A drifted installed TASKS contract."
    _point_scorer_at_temp_lifecycle_sources(
        tmp_path,
        monkeypatch,
        tasks_tool=drifted_tool,
    )

    with pytest.raises(ValueError, match="installed TASKS tool contract drifted"):
        _score_from_orchestrator_lifecycle_json(report)


def _first_assistant(report: dict[str, object]) -> dict[str, object]:
    transcripts = report["transcripts"]
    assert isinstance(transcripts, dict)
    transcript = next(iter(transcripts.values()))
    assert isinstance(transcript, list)
    assistant = transcript[1]
    assert isinstance(assistant, dict)
    return assistant


def _forge_first_scenario_check_counts(report: dict[str, object]) -> None:
    scenarios = report["scenarios"]
    assert isinstance(scenarios, list)
    scenario = scenarios[0]
    assert isinstance(scenario, dict)
    checks_total = scenario["checks_total"]
    assert isinstance(checks_total, int)
    scenario.update(
        checks_total=checks_total + 1,
        checks_passed=0,
        score=0.0,
        passed=False,
        violations=["missing:forged@turn0"],
    )


def _remove_first_lifecycle_evidence(report: dict[str, object]) -> None:
    assistant = _first_assistant(report)
    params = assistant["params"]
    assert isinstance(params, dict)
    params.pop("lifecycle_results")


def _forge_first_event(report: dict[str, object]) -> None:
    _first_assistant(report)["events"] = ["spawn"]


def _change_first_user_message(report: dict[str, object]) -> None:
    transcripts = report["transcripts"]
    assert isinstance(transcripts, dict)
    transcript = next(iter(transcripts.values()))
    assert isinstance(transcript, list)
    user = transcript[0]
    assert isinstance(user, dict)
    user["message"] = "A substituted user turn"


@pytest.mark.parametrize(
    ("mutation", "match"),
    [
        (lambda report: report.update(mode="simulate"), "scored bridge"),
        (
            lambda report: report["metadata"].update(max_scenarios=1),
            "max_scenarios",
        ),
        (
            lambda report: report["metadata"].update(scenario_filter="cancel"),
            "scenario_filter",
        ),
        (
            lambda report: report["metadata"].update(strict=False),
            "strict",
        ),
        (
            lambda report: report["metadata"].update(provider=""),
            "metadata.provider",
        ),
        (lambda report: report["scenarios"].pop(), "exactly 132"),
        (
            lambda report: report["transcripts"].pop(next(iter(report["transcripts"]))),
            "transcript scenario manifest",
        ),
        (_change_first_user_message, "does not match the pinned corpus"),
        (_forge_first_scenario_check_counts, "does not match transcript evidence"),
        (_remove_first_lifecycle_evidence, "forged lifecycle events"),
        (_forge_first_event, "forged lifecycle events"),
        (
            lambda report: report["workload"].update(corpus_sha256="0" * 64),
            "corpus_sha256",
        ),
        (
            lambda report: report["workload"].update(
                measurement_scope="lifecycle_execution"
            ),
            "measurement_scope",
        ),
        (
            lambda report: report["workload"].update(side_effects_executed=True),
            "side_effects_executed",
        ),
        (
            lambda report: report["workload"].update(tool_contract_sha256="0" * 64),
            "tool_contract_sha256",
        ),
        (
            lambda report: report["workload"].update(system_hint_sha256="0" * 64),
            "system_hint_sha256",
        ),
        (
            lambda report: report["metrics"].update(overall_score=0.123),
            "overall_score is inconsistent",
        ),
        (
            lambda report: _first_assistant(report).pop("params"),
            "lacks action/params/event evidence",
        ),
    ],
)
def test_incomplete_or_inconsistent_reports_are_rejected(
    tmp_path: Path,
    mutation: object,
    match: str,
) -> None:
    report = deepcopy(_full_report(tmp_path))
    assert callable(mutation)
    mutation(report)

    with pytest.raises(ValueError, match=match):
        _score_from_orchestrator_lifecycle_json(report)


def test_missing_and_nonfinite_metrics_are_rejected(tmp_path: Path) -> None:
    missing = _full_report(tmp_path)
    del missing["metrics"]["status_accuracy_rate"]
    with pytest.raises(ValueError, match="status_accuracy_rate"):
        _score_from_orchestrator_lifecycle_json(missing)

    nonfinite = _full_report(tmp_path)
    nonfinite["metrics"]["scenario_pass_rate"] = float("nan")
    with pytest.raises(ValueError, match="finite"):
        _score_from_orchestrator_lifecycle_json(nonfinite)
