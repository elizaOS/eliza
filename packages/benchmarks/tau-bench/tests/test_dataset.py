"""Confirm the vendored upstream task corpus loads correctly."""

from elizaos_tau_bench.dataset import iter_sample_tasks, iter_tasks, load_domain_tasks, task_count
from elizaos_tau_bench.types import Task


def test_official_retail_corpus_has_115_tasks():
    assert task_count("retail", "test") == 115


def test_official_airline_corpus_has_50_tasks():
    assert task_count("airline", "test") == 50


def test_total_official_tasks_is_165():
    total = task_count("retail", "test") + task_count("airline", "test")
    assert total == 165


def test_iter_tasks_emits_domain_index_task():
    items = list(iter_tasks(["retail"], "test", max_per_domain=3))
    assert len(items) == 3
    for domain, idx, task in items:
        assert domain == "retail"
        assert isinstance(idx, int)
        assert isinstance(task, Task)
        assert task.user_id
        assert isinstance(task.actions, list)


def test_task_ids_filter_overrides_range():
    items = list(iter_tasks(["airline"], "test", task_ids=[0, 5, 10]))
    assert [i for _, i, _ in items] == [0, 5, 10]


def test_iter_sample_tasks_honors_max_per_domain():
    items = list(iter_sample_tasks(["retail", "airline"], "test", max_per_domain=1))
    assert [(domain, idx) for domain, idx, _ in items] == [("retail", 0), ("airline", 0)]


def test_retail_dev_and_train_splits_load():
    dev = load_domain_tasks("retail", "dev")
    train = load_domain_tasks("retail", "train")
    assert len(dev) > 0
    assert len(train) > 0
