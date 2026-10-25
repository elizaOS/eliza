"""Shared inclusion/exclusion semantics for result reports."""


def benchmark_selected(
    benchmark_id: str,
    *,
    include_benchmarks: set[str] | None,
    exclude_benchmarks: set[str] | None,
) -> bool:
    if include_benchmarks is not None and benchmark_id not in include_benchmarks:
        return False
    if exclude_benchmarks is not None and benchmark_id in exclude_benchmarks:
        return False
    return True
