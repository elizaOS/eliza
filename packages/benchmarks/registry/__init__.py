"""Public benchmark registration and artifact loading API."""

from .commands import get_benchmark_registry, load_benchmark_result_json

__all__ = ["get_benchmark_registry", "load_benchmark_result_json"]

from .catalog import WORKLOADS, Workload

__all__ += ["WORKLOADS", "Workload"]
