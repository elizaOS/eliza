"""Tests for the release process guard."""

from __future__ import annotations

import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.release_process_guard import find_blocked_processes  # noqa: E402


def test_find_blocked_processes_flags_model_and_benchmark_residents() -> None:
    ps_output = "\n".join(
        [
            "123 1 100 zsh zsh",
            "124 1 120000 node node --import tsx packages/lifeops-bench/src/server.ts",
            "125 1 1500000 llama /tmp/bin/llama-speculative-simple -m model.gguf",
        ]
    )

    blocked = find_blocked_processes(ps_output, current_pid=999)

    assert len(blocked) == 2
    assert "lifeops-bench/src/server.ts" in blocked[0]
    assert "llama-speculative-simple" in blocked[1]


def test_find_blocked_processes_ignores_guard_itself() -> None:
    ps_output = "\n".join(
        [
            "123 1 100 python python packages/training/scripts/manifest/release_process_guard.py",
            "124 1 100 rg rg llama-speculative",
        ]
    )

    assert find_blocked_processes(ps_output, current_pid=123) == []
