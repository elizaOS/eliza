"""Tests for the release process guard."""

from __future__ import annotations

from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]

from eliza_training.manifest.release_process_guard import find_blocked_processes  # noqa: E402


def test_find_blocked_processes_flags_model_and_benchmark_residents() -> None:
    ps_output = "\n".join(
        [
            "123 1 100 zsh zsh",
            "124 1 1500000 llama /tmp/bin/llama-speculative-simple -m model.gguf",
        ]
    )

    blocked = find_blocked_processes(ps_output, current_pid=999)

    assert len(blocked) == 1
    assert "llama-speculative-simple" in blocked[0]


def test_find_blocked_processes_ignores_guard_itself() -> None:
    ps_output = "\n".join(
        [
            "123 1 100 python python packages/training/scripts/manifest/release_process_guard.py",
            "124 1 100 rg rg llama-speculative",
        ]
    )

    assert find_blocked_processes(ps_output, current_pid=123) == []
