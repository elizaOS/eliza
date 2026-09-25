import json

import pytest

from benchmarks.orchestrator.adapters import _score_from_eliza_1


@pytest.mark.parametrize("harness", ["hermes", "openclaw"])
@pytest.mark.parametrize(
    "tamper,reason",
    [
        (None, None),
        ("missing", "native_decision_attempt_evidence_missing"),
        ("identity", "native_decision_attempt_identity_mismatch"),
        ("runtime", "native_decision_runtime_unverified"),
        ("output", "native_decision_output_mismatch"),
        ("interrupted", "native_decision_campaign_interrupted"),
        ("execution", "native_decision_execution_identity_missing"),
        ("summary_only", "native_decision_execution_identity_missing"),
    ],
)
def test_score_requires_native_attempt_provenance(tmp_path, harness, tamper, reason):
    cases = []
    for i, label in enumerate(("RESPOND", "IGNORE", "STOP")):
        text = json.dumps({"shouldRespond": label})
        meta = {"agent_runtime": harness, "publishable_native": True}
        if tamper == "runtime":
            meta["publishable_native"] = False
        params = {
            "_meta": {"openclaw_adapter": meta} if harness == "openclaw" else meta
        }
        attempt = {
            "task_id": f"eliza-1-should-respond-case-{i}-0",
            "response": {"text": text, "params": params},
        }
        case = {
            "taskId": "should_respond",
            "caseId": f"case-{i}#0",
            "expected_label": label,
            "raw_output": text,
            "native_attempts": [attempt],
        }
        if tamper == "missing":
            case.pop("native_attempts")
        if tamper == "identity":
            attempt["task_id"] = "different"
        if tamper == "output":
            attempt["response"]["text"] = "different"
        cases.append(case)
    data = {
        "corpus": {"selected_case_ids": ["case-0", "case-1", "case-2"], "selected_case_count": 3, "repetitions": 1, "expected_result_count": 3},
        "execution": {"harness": harness},
        "modes": [harness],
        "cases": cases,
        "summaries": [
            {
                "taskId": "should_respond",
                "modeId": harness,
                "cases": 3,
                "label_match_rate": 1.0,
            }
        ],
    }
    if tamper == "interrupted":
        data["execution"]["interrupted_campaign"] = True
    if tamper == "execution":
        data.pop("execution")
    if tamper == "summary_only":
        data.pop("execution")
        data.pop("modes")
    path = tmp_path / "report.json"
    path.write_text(json.dumps(data))
    score = _score_from_eliza_1(path)
    assert score.score == (1.0 if reason is None else None)
    assert score.metrics["label_match_rate"] == 1.0
    assert score.metrics["quality_exclusion_reason"] == reason
    assert score.metrics["comparison_eligible"] is (reason is None)
