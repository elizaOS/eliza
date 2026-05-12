"""Eliza-1 publish orchestrator package.

End-to-end runner that takes an already-quantized bundle directory,
verifies kernels, applies eval gates, builds the Eliza-1 manifest,
generates the README, and pushes to ``elizaos/eliza-1-<tier>``.

The flow is the canonical implementation of
``packages/training/AGENTS.md`` §6. There is no opt-out flag for any
gate. ``--dry-run`` performs every check but does not push.
"""

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


def __getattr__(name: str):
    """Lazily expose orchestrator symbols without breaking `python -m`.

    Importing `scripts.publish` is part of Python's package execution
    path for `python -m scripts.publish.orchestrator`. Eagerly importing
    `.orchestrator` here preloads the same module that runpy is about to
    execute and triggers a RuntimeWarning. Lazy lookup keeps the public
    package API intact while letting the module entrypoint run cleanly.
    """

    if name in __all__:
        from . import orchestrator

        return getattr(orchestrator, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
