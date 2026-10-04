import pytest

from eliza_training.lib.dataset_splits import isolate_success_splits


def row(identity, trajectory, content, split='train', requested=None):
    return {'id': identity, 'source': {'trajectoryId': trajectory}, 'metadata': {'contentHash': content, 'requestedSplit': requested}, 'split': split}


def test_transitive_duplicates_and_trajectory_stay_together():
    splits = {'train': [row('1', 'a', 'x'), row('2', 'a', 'y'), row('3', 'b', 'y')], 'val': [row('4', 'b', 'z', 'val')], 'test': []}
    isolate_success_splits(splits, val_ratio=.1, test_ratio=.1)
    assert sorted(len(rows) for rows in splits.values()) == [0, 0, 4]


def test_balancing_moves_whole_groups_and_preserves_explicit_train():
    splits = {'train': [row('1', 'a', 'x', requested='train'), row('2', 'b', 'y'), row('3', 'b', 'z'), row('4', 'c', 'w')], 'val': [], 'test': []}
    isolate_success_splits(splits, val_ratio=.1, test_ratio=.1)
    assert [r['id'] for r in splits['train']] == ['1']
    assert sorted(len(rows) for rows in splits.values()) == [1, 1, 2]


def test_conflicting_explicit_splits_are_rejected():
    splits = {'train': [row('1', 'a', 'x', requested='train')], 'val': [row('2', 'a', 'y', 'val', 'val')], 'test': []}
    with pytest.raises(ValueError, match='Conflicting explicit splits'):
        isolate_success_splits(splits, val_ratio=.1, test_ratio=.1)
