import json

import pytest

from eliza_training.rl.trajectory_source import local_trajectories, has_minimum_usable_action_steps


def test_local_source_preserves_full_rows_from_json_and_jsonl(tmp_path):
    row = {'windowId': 'window', 'steps': [{'action': {'actionType': 'trade'}, 'llmCalls': [{'response': 'long response ' * 10000}]}], 'metadata': {'custom': [1, 2]}, 'extra': 'retained'}
    (tmp_path / 'a.json').write_text(json.dumps([row]))
    (tmp_path / 'b.jsonl').write_text(json.dumps(row) + '\n')
    assert list(local_trajectories(str(tmp_path))) == [row, row]
    assert has_minimum_usable_action_steps(row['steps'], min_actions=1) == (True, 1)


def test_invalid_export_is_not_silently_skipped(tmp_path):
    path = tmp_path / 'bad.jsonl'
    path.write_text('{}\n')
    with pytest.raises(ValueError, match='window ID'):
        list(local_trajectories(str(path)))


def test_missing_source_is_not_reported_as_empty(tmp_path):
    with pytest.raises(FileNotFoundError):
        list(local_trajectories(str(tmp_path / 'missing')))


def test_grouping_preserves_zero_balance_metadata_and_unknown_fields():
    from eliza_training.rl.trajectory_source import group_trajectories
    row = {'windowId': 'w', 'trajectoryId': 't', 'steps': [{'action': {'actionType': 'trade'}}], 'finalBalance': 0, 'finalPnL': -10, 'metadata': {'full': 'context'}, 'extra': 'kept'}
    groups = group_trajectories([row], min_actions=1)
    result = groups[0]['trajectories'][0]
    assert result['final_balance'] == 0
    assert result['starting_balance'] == 10
    assert result['steps'] == row['steps']
    assert result['metadata'] == row['metadata']
    assert result['extra'] == 'kept'


@pytest.mark.parametrize('field,value', [('stepsJson', 'invalid'), ('metadata', 'invalid')])
def test_grouping_rejects_corrupt_export(field, value):
    from eliza_training.rl.trajectory_source import group_trajectories
    row = {'windowId': 'w', 'stepsJson': '[{"action":{"actionType":"trade"}}]', field: value}
    with pytest.raises(ValueError, match='Malformed'):
        group_trajectories([row], min_actions=1)
