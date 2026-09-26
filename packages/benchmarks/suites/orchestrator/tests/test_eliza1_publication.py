import json
from pathlib import Path

import pytest

from benchmarks.orchestrator.adapters import _score_from_eliza_1


@pytest.mark.parametrize("labels,eligible,reason", [
    (["RESPOND", "IGNORE", "STOP"], True, None),
    (["RESPOND"] * 59, False, "decision_classes_incomplete"),
    (["RESPOND"], False, "decision_classes_incomplete"),
    ([None, None, None], False, "decision_class_evidence_missing"),
    (["RESPOND", [], "STOP"], False, "decision_class_evidence_missing"),
])
def test_decision_quality_requires_observed_class_coverage(tmp_path: Path, labels, eligible, reason):
    report = {
        "corpus": {"decision_class_coverage": 3},  # Full-corpus claims cannot stand in for selected cases.
        "cases": [{"taskId": "should_respond", "raw_output": '{"shouldRespond":"RESPOND"}', "expected_label": label} for label in labels],
        "summaries": [{"taskId": "should_respond", "modeId": "synthetic-calibration", "cases": len(labels), "label_match_rate": 1.0, "parse_success_rate": 1.0, "schema_valid_rate": 1.0}],
    }
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report))
    result = _score_from_eliza_1(path)
    assert result.score == (1 / 3 if eligible else None)
    assert result.metrics["comparison_eligible"] is eligible
    assert result.metrics["quality_exclusion_reason"] == reason
    assert result.metrics["reported_label_match_rate"] == 1.0
    if eligible:
        assert result.metrics["label_match_rate"] == 1 / 3


def test_simulated_constant_responder_keeps_baseline_but_cannot_publish(tmp_path, monkeypatch):
    import importlib.util
    from types import SimpleNamespace

    script = Path(__file__).resolve().parents[3] / 'scripts/eliza-1/harness_runner.py'
    spec = importlib.util.spec_from_file_location('decision_runner', script)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    client = SimpleNamespace(send_message=lambda *args, **kwargs: SimpleNamespace(
        text='{"shouldRespond":"RESPOND"}', actions=[], params={}))
    monkeypatch.setattr(runner, '_build_client', lambda *args: (client, None))
    path = tmp_path / 'report.json'
    assert runner.main(['--harness', 'hermes', '--out', str(path)]) == 0
    report = json.loads(path.read_text())
    selection = report['corpus']
    assert selection['selected_case_count'] == len(selection['selected_case_ids']) == 32
    assert selection['expected_result_count'] == 32
    assert {case['caseId'] for case in report['cases']} == {f"{case_id}#0" for case_id in selection['selected_case_ids']}
    result = _score_from_eliza_1(path)
    assert result.score is None
    assert result.metrics["label_match_rate"] == 19 / 32
    assert result.metrics["comparison_eligible"] is False
    assert result.metrics["quality_exclusion_reason"] == "native_decision_runtime_unverified"
    assert result.metrics['decision_label_counts'] == {'RESPOND': 19, 'IGNORE': 10, 'STOP': 3}
    assert result.metrics['case_count'] == 32
