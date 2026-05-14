from elizaos_tau_bench.pass_k import calculate_pass_hat_k
from elizaos_tau_bench.types import TaskRunResult


def _make(domain: str, task_id: int, trial: int, success: bool) -> TaskRunResult:
    return TaskRunResult(
        task_id=task_id, trial=trial, domain=domain,  # type: ignore[arg-type]
        reward=1.0 if success else 0.0, success=success,
    )


def test_pass_hat_k_all_successes():
    results = [_make("retail", 0, t, True) for t in range(4)]
    pk, n = calculate_pass_hat_k(results, k=4)
    assert n == 1
    assert pk == 1.0


def test_pass_hat_k_all_failures():
    results = [_make("retail", 0, t, False) for t in range(4)]
    pk, _ = calculate_pass_hat_k(results, k=4)
    assert pk == 0.0


def test_pass_hat_k_mixed_unbiased_estimator():
    # 2 of 4 trials succeed -> pass^4 = C(2,4)/C(4,4) = 0/1 = 0
    results = [_make("retail", 0, t, t < 2) for t in range(4)]
    pk, _ = calculate_pass_hat_k(results, k=4)
    assert pk == 0.0
    # pass^1 should be 2/4 = 0.5
    pk1, _ = calculate_pass_hat_k(results, k=1)
    assert pk1 == 0.5
    # pass^2 = C(2,2)/C(4,2) = 1/6
    pk2, _ = calculate_pass_hat_k(results, k=2)
    assert abs(pk2 - 1 / 6) < 1e-9


def test_pass_hat_k_averages_across_tasks():
    results = [
        _make("retail", 0, 0, True),
        _make("retail", 0, 1, True),
        _make("retail", 1, 0, False),
        _make("retail", 1, 1, True),
    ]
    pk, n = calculate_pass_hat_k(results, k=2)
    assert n == 2
    # task 0: C(2,2)/C(2,2) = 1.0
    # task 1: C(1,2)/C(2,2) = 0/1 = 0
    assert pk == 0.5
