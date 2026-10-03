import json

import pytest

from benchmarks.orchestrator.adapters import _score_from_eliza_1


@pytest.mark.parametrize('tamper,reason', [
    (None, None),
    ('missing_case', 'decision_results_incomplete'),
    ('duplicate_case', 'decision_case_identity_invalid'),
    ('unexpected_case', 'decision_case_identity_invalid'),
    ('missing_selection', 'decision_selection_evidence_missing'),
    ('boolean_count', 'decision_selection_evidence_missing'),
    ('inconsistent_count', 'decision_selection_evidence_invalid'),
    ('duplicate_selection', 'decision_selection_evidence_invalid'),
    ('interrupted', 'native_decision_campaign_interrupted'),
    ('failed_case', None),
    ('mixed_task', 'native_decision_task_identity_mismatch'),
    ('renamed_task', 'native_decision_task_identity_mismatch'),
    ('top_level_task', 'native_decision_task_identity_mismatch'),
    ('top_level_mode', 'native_decision_execution_identity_mismatch'),
    ('missing_execution', 'native_decision_execution_identity_missing'),
    ('mixed_identity', 'native_decision_execution_identity_mismatch'),
])
def test_native_score_requires_complete_selected_repetitions(tmp_path, tamper, reason):
    cases = [
        {'taskId': 'should_respond', 'caseId': f'{label}#{iteration}',
         'expected_label': label, 'raw_output': json.dumps({'shouldRespond': label})}
        for label in ('RESPOND', 'IGNORE', 'STOP') for iteration in range(2)
    ]
    corpus = {'selected_case_ids': ['RESPOND', 'IGNORE', 'STOP'], 'selected_case_count': 3,
              'repetitions': 2, 'expected_result_count': 6}
    report = {'execution': {'harness': 'eliza'}, 'corpus': corpus, 'cases': cases,
              'summaries': [{'taskId': 'should_respond', 'modeId': 'eliza', 'cases': 6, 'label_match_rate': 1.0}]}
    if tamper == 'missing_case':
        cases.pop()
    elif tamper == 'duplicate_case':
        cases[-1] = dict(cases[-2])
    elif tamper == 'unexpected_case':
        cases[-1]['caseId'] = 'unselected#1'
    elif tamper == 'missing_selection':
        corpus.pop('selected_case_ids')
    elif tamper == 'boolean_count':
        corpus['repetitions'] = True
    elif tamper == 'inconsistent_count':
        corpus['expected_result_count'] = 5
    elif tamper == 'duplicate_selection':
        corpus['selected_case_ids'][-1] = 'IGNORE'
    elif tamper == 'interrupted':
        report['execution']['interrupted_campaign'] = True
    elif tamper == 'missing_execution':
        report.pop('execution')
    elif tamper == 'mixed_identity':
        report['summaries'][0]['modeId'] = 'codex'
    elif tamper == 'mixed_task':
        report['summaries'].append({'taskId': 'planner', 'modeId': 'eliza', 'label_match_rate': 1.0})
    elif tamper == 'renamed_task':
        report['summaries'][0]['taskId'] = 'planner'
    elif tamper == 'top_level_task':
        report['tasks'] = ['planner']
    elif tamper == 'top_level_mode':
        report['modes'] = ['codex']
    elif tamper == 'failed_case':
        cases[0]['error'] = 'Provider unavailable'
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(report))
    result = _score_from_eliza_1(path)
    assert result.metrics['quality_exclusion_reason'] == reason
    assert result.metrics['comparison_eligible'] is (reason is None)
    assert result.score == (None if reason else 5 / 6 if tamper == 'failed_case' else 1.0)
