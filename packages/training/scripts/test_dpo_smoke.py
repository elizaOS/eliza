"""Pytest smoke test for train_dpo.py.

Runs a 5-step DPO pass against an existing SFT checkpoint on disk and
verifies a `final/` artifact lands. Skipped on CPU-only boxes — DPO under
TRL needs a CUDA device for the bf16 reference forward.

Run:
    cd training && pytest -xvs scripts/test_dpo_smoke.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Candidate SFT checkpoints to try, in priority order. The first one that
# exists wins. Any of these is sufficient for a smoke run — the test only
# verifies that the trainer wires up and writes a final dir.
CANDIDATE_CKPTS = [
    ROOT / "checkpoints" / "qwen3.5-0.8b-eliza-payload-v3" / "final",
    ROOT / "checkpoints" / "qwen3.5-0.8b-eliza-payload-v1" / "final",
    ROOT / "checkpoints" / "qwen3.5-0.8b-smoke-v3" / "final",
]


def _has_cuda() -> bool:
    try:
        import torch
    except ImportError:
        return False
    return torch.cuda.is_available()


def _has_trl() -> bool:
    try:
        import trl  # noqa: F401
    except ImportError:
        return False
    return True


def _has_python_headers() -> bool:
    """Triton JIT-compiles a CUDA utility module on first use, which
    requires Python.h. On stripped boxes (no python3-dev / python3.12-dev)
    Triton fails before training even starts. Skip rather than fail."""
    import sysconfig
    inc = sysconfig.get_path("include")
    return bool(inc) and (Path(inc) / "Python.h").exists()


def _resolve_checkpoint() -> Path | None:
    for c in CANDIDATE_CKPTS:
        if c.exists() and (c / "config.json").exists():
            return c
    return None


@pytest.mark.skipif(not _has_cuda(), reason="DPO smoke requires CUDA")
@pytest.mark.skipif(not _has_trl(), reason="DPO smoke requires `trl` (uv sync --extra train)")
@pytest.mark.skipif(
    not _has_python_headers(),
    reason="DPO smoke requires Python development headers (python3-dev) for Triton JIT",
)
def test_dpo_smoke_5_steps(tmp_path: Path) -> None:
    ckpt = _resolve_checkpoint()
    if ckpt is None:
        pytest.skip("no SFT checkpoint on disk to smoke against")

    # Use a tmp output dir so we don't pollute checkpoints/. The trainer's
    # `save_strategy="steps"` with `save_steps=500` won't fire in 5 steps,
    # but `trainer.save_model(out/final)` always runs at the end.
    out_dir = tmp_path / "dpo-smoke"
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "train_dpo.py"),
        "--registry-key", "qwen3.5-2b",
        "--sft-checkpoint", str(ckpt),
        "--output-dir", str(out_dir),
        "--max-steps", "5",
        "--max-samples", "32",
        "--batch-size", "1",
        "--grad-accum", "1",
        "--max-seq-len", "1024",
    ]
    env = dict(os.environ)
    env["TOKENIZERS_PARALLELISM"] = "false"
    res = subprocess.run(cmd, env=env, capture_output=True, text=True,
                         cwd=str(ROOT), timeout=900)
    if res.returncode != 0:
        sys.stderr.write("STDOUT:\n" + res.stdout + "\nSTDERR:\n" + res.stderr)
    assert res.returncode == 0, "train_dpo.py exited non-zero"

    final = out_dir / "final"
    assert final.exists(), f"expected {final} to be created"
    # Must contain at least the model config + tokenizer config.
    assert (final / "config.json").exists()
    assert (final / "tokenizer_config.json").exists() or \
           (final / "tokenizer.json").exists()


def test_dpo_help_runs_no_gpu() -> None:
    """Sanity: --help works on CPU-only too. Catches import-time regressions."""
    cmd = [sys.executable, str(ROOT / "scripts" / "train_dpo.py"), "--help"]
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT))
    assert res.returncode == 0, res.stderr
    assert "--sft-checkpoint" in res.stdout
    assert "--registry-key" in res.stdout
