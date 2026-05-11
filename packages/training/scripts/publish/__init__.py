"""Eliza-1 publish orchestrator package.

End-to-end runner that takes an already-quantized bundle directory,
verifies kernels, applies eval gates, builds the Eliza-1 manifest,
generates the README, and pushes to ``elizalabs/eliza-1-<tier>``.

The flow is the canonical implementation of
``packages/training/AGENTS.md`` §6. There is no opt-out flag for any
gate. ``--dry-run`` performs every check but does not push.
"""

from .orchestrator import (
    EXIT_BUNDLE_LAYOUT_FAIL,
    EXIT_EVAL_GATE_FAIL,
    EXIT_HF_PUSH_FAIL,
    EXIT_KERNEL_VERIFY_FAIL,
    EXIT_MANIFEST_INVALID,
    EXIT_MISSING_FILE,
    EXIT_OK,
    EXIT_USAGE,
    OrchestratorError,
    PublishContext,
    run,
)

__all__ = [
    "EXIT_BUNDLE_LAYOUT_FAIL",
    "EXIT_EVAL_GATE_FAIL",
    "EXIT_HF_PUSH_FAIL",
    "EXIT_KERNEL_VERIFY_FAIL",
    "EXIT_MANIFEST_INVALID",
    "EXIT_MISSING_FILE",
    "EXIT_OK",
    "EXIT_USAGE",
    "OrchestratorError",
    "PublishContext",
    "run",
]
