"""Shared helpers for inference runners."""

from .output_io import (
    build_task_workspace,
    write_all_trajectories_file,
    write_eval_file,
    write_json_file,
    write_results_file,
    write_summary_file,
    write_trajectory_file,
)
from .trajectory_schema import (
    SCHEMA_VERSION,
    attach_conversation,
    attach_events,
    attach_metrics,
    attach_provider_payload,
    make_base_envelope,
)

__all__ = [
    "SCHEMA_VERSION",
    "attach_conversation",
    "attach_events",
    "attach_metrics",
    "attach_provider_payload",
    "build_task_workspace",
    "make_base_envelope",
    "write_all_trajectories_file",
    "write_eval_file",
    "write_json_file",
    "write_results_file",
    "write_summary_file",
    "write_trajectory_file",
]
