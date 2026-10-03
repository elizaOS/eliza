from types import SimpleNamespace

import pytest

from benchmarks.orchestrator.adapters import _agent_compatibility_for, _command_eliza_1
from benchmarks.orchestrator.types import RunRequest


def test_codex_decision_dispatch_preserves_settings(tmp_path):
    request = RunRequest(benchmarks=("eliza_1",), agent="codex", provider="codex-native", model="gpt-5.5", extra_config={"accounts": "account-one", "reasoning_effort": "low", "fixture_set": "manual", "codex_timeout_s": 120})
    command = _command_eliza_1(SimpleNamespace(request=request, output_root=tmp_path), None)
    assert "codex" in _agent_compatibility_for("eliza_1")
    for flag, value in (("--harness", "codex"), ("--model", "gpt-5.5"), ("--accounts", "account-one"), ("--fixture-set", "manual"), ("--reasoning-effort", "low"), ("--timeout-s", "120")):
        assert command[command.index(flag) + 1] == value
    assert "--limit" not in command


@pytest.mark.parametrize("provider,extra,error", [
    ("cerebras", {}, "requires provider codex-native"),
    ("codex-native", {"task":"planner"}, "only the native decision task"),
    ("codex-native", {"harness":"hermes"}, "recorded agent identity"),
])
def test_codex_cannot_run_a_different_path_under_its_label(tmp_path, provider, extra, error):
    request = RunRequest(benchmarks=("eliza_1",), agent="codex", provider=provider, model="gpt-5.5", extra_config=extra)
    with pytest.raises(ValueError, match=error):
        _command_eliza_1(SimpleNamespace(request=request, output_root=tmp_path), None)


@pytest.mark.parametrize('tamper', [None, 'missing', 'model', 'output', 'terminal'])
def test_codex_publication_requires_matching_native_receipts(tmp_path, tamper):
    import json
    from benchmarks.orchestrator.adapters import _score_from_eliza_1

    cases = []
    for index, label in enumerate(('RESPOND', 'IGNORE', 'STOP')):
        text = json.dumps({'shouldRespond': label})
        cases.append({'taskId': 'should_respond', 'caseId': f'case-{index}#0', 'expected_label': label, 'raw_output': text})
        receipt = {'benchmark': 'eliza_1', 'task_id': f'eliza-1-should-respond-case-{index}-0', 'model': 'fixture', 'status': 'succeeded', 'returncode': 0,
                   'response': {'text': text, 'params': {'events': [{'type': 'turn.completed'}]}}}
        if index == 0:
            if tamper == 'missing':
                continue
            if tamper == 'model':
                receipt['model'] = 'different'
            if tamper == 'output':
                receipt['response']['text'] = 'different'
            if tamper == 'terminal':
                receipt['response']['params']['events'] = [{'type': 'turn.failed'}]
        directory = tmp_path / 'codex/attempts' / str(index)
        directory.mkdir(parents=True)
        (directory / 'attempt.json').write_text(json.dumps(receipt))
    report = {"corpus": {"selected_case_ids": ["case-0", "case-1", "case-2"], "selected_case_count": 3, "repetitions": 1, "expected_result_count": 3}, 'execution': {'harness': 'codex', 'provider_label': 'codex-native', 'model_requested': 'fixture'}, 'cases': cases,
              'summaries': [{'taskId': 'should_respond', 'modeId': 'codex', 'cases': 3, 'label_match_rate': 1.0}]}
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(report))
    if tamper:
        with pytest.raises(ValueError, match='Codex'):
            _score_from_eliza_1(path)
    else:
        score = _score_from_eliza_1(path)
        assert score.score == 1.0
        assert score.metrics['native_receipts']['completed_turns'] == 3
        assert score.metrics['native_receipts']['provider_observed'] is None



def test_snapshot_gate_rejects_codex_without_native_case_evidence():
    from benchmarks.orchestrator.runner import _publication_quarantine_reason

    args = dict(benchmark_id="eliza_1", status="succeeded", agent="codex", provider="codex-native", model="fixture", score=1.0, token_metrics={})
    execution = {"harness": "codex", "model_requested": "fixture", "provider_label": "codex-native"}
    assert _publication_quarantine_reason(**args, metrics={}) == "codex_execution_identity_mismatch"
    assert _publication_quarantine_reason(**args, metrics={"execution": execution, "case_count": 3}) == "codex_missing_native_receipts"
    assert _publication_quarantine_reason(**args, metrics={"execution": execution, "case_count": 3, "native_receipts": {"attempt_count": 3, "completed_turns": 3}}) is None
