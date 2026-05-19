"""CPU-only smoke tests for the `--low-vram-smoke` preset in train_local.py.

The preset is a flag bundle. It must override the registry defaults to
fit a 12 GB consumer GPU (seq_len 2048, batch 1, grad_accum 16, memory
budget 11.5 GB, max_samples 1000, epochs 1) while still letting any
explicit CLI flag the caller passed win.

These tests parse args via the same argparse layout as `train_local.main`
and assert the merged values without touching torch/cuda/the data layer.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

train_local = importlib.import_module("train_local")


def _build_parser():
    """Reach into train_local.main and reconstruct just its argparse.

    Cheaper than refactoring main() to factor out the parser; the preset
    branch lives inline after parse_args so we parse with the real CLI
    and apply the override block by hand below.
    """
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3.5-0.8B")
    ap.add_argument("--train-file")
    ap.add_argument("--val-file")
    ap.add_argument("--out-dir")
    ap.add_argument("--run-name", default="qwen35-eliza-native")
    ap.add_argument("--max-samples", type=int, default=0)
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--resume-from-checkpoint", default=None)
    ap.add_argument("--batch-size", type=int, default=4)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-seq-len", type=int, default=4096)
    ap.add_argument("--full-finetune", action="store_true")
    ap.add_argument("--preflight-only", action="store_true")
    ap.add_argument("--optimizer", choices=["apollo", "apollo_mini"], default="apollo")
    ap.add_argument("--apollo-rank", type=int, default=256)
    ap.add_argument("--apollo-scale", type=float, default=1.0)
    ap.add_argument("--apollo-update-proj-gap", type=int, default=200)
    ap.add_argument("--max-chars", type=int, default=0)
    ap.add_argument("--use-liger", default="auto", choices=("auto", "on", "off"))
    ap.add_argument("--registry-key", default=None)
    ap.add_argument("--memory-budget-gb", type=float, default=None)
    ap.add_argument("--low-vram-smoke", action="store_true")
    return ap


def _resolve(argv):
    """Mirror of the merge logic in train_local.main: parse, snapshot
    "value came in at default" for each tracked dest, run the registry
    merge, then run the --low-vram-smoke preset. Kept in sync with
    train_local.main by hand."""
    from scripts.training.model_registry import get as _registry_get

    ap = _build_parser()
    args = ap.parse_args(argv)

    defaults_at_parse = {
        dest: getattr(args, dest) == ap.get_default(dest)
        for dest in (
            "model", "batch_size", "grad_accum", "max_seq_len", "optimizer",
            "apollo_rank", "max_samples", "epochs",
        )
    }
    memory_budget_unset = args.memory_budget_gb is None

    if args.registry_key:
        entry = _registry_get(args.registry_key)
        if defaults_at_parse["model"]:
            args.model = entry.hf_id
        if defaults_at_parse["batch_size"]:
            args.batch_size = entry.micro_batch
        if defaults_at_parse["grad_accum"]:
            args.grad_accum = entry.grad_accum
        if defaults_at_parse["max_seq_len"]:
            args.max_seq_len = entry.seq_len
        if defaults_at_parse["optimizer"]:
            args.optimizer = entry.optimizer
        if defaults_at_parse["apollo_rank"]:
            args.apollo_rank = entry.optimizer_rank
        if memory_budget_unset:
            args.memory_budget_gb = entry.train_mem_gb_budget

    if args.low_vram_smoke:
        if defaults_at_parse["max_seq_len"]:
            args.max_seq_len = 2048
        if defaults_at_parse["batch_size"]:
            args.batch_size = 1
        if defaults_at_parse["grad_accum"]:
            args.grad_accum = 16
        if defaults_at_parse["max_samples"]:
            args.max_samples = 1000
        if defaults_at_parse["epochs"]:
            args.epochs = 1.0
        if memory_budget_unset:
            args.memory_budget_gb = 11.5

    return args


def test_low_vram_smoke_overrides_registry_2b_defaults() -> None:
    """Registry 2B says seq_len=8192, batch=1, accum=16, budget=15.5GB. The
    preset must tighten seq_len to 2048 and the budget to 11.5 so a 12 GB card
    can run the path."""
    args = _resolve(["--registry-key", "qwen3.5-2b", "--low-vram-smoke"])
    assert args.max_seq_len == 2048
    assert args.batch_size == 1
    assert args.grad_accum == 16
    assert args.max_samples == 1000
    assert args.epochs == 1.0
    assert args.memory_budget_gb == 11.5
    # Effective batch held at 16 — same loss signal as registry default 2B.
    assert args.batch_size * args.grad_accum == 16
    # Liger and APOLLO settings flow through unchanged.
    assert args.use_liger == "auto"
    assert args.optimizer == "apollo_mini"


def test_low_vram_smoke_explicit_seq_len_wins() -> None:
    """The preset must NOT override values the caller passed explicitly.
    Useful for the "still OOMs at 2048, retry at 1024" workflow documented
    in the README."""
    args = _resolve(
        ["--registry-key", "qwen3.5-2b", "--low-vram-smoke", "--max-seq-len", "1024"]
    )
    assert args.max_seq_len == 1024
    # Other preset overrides still apply.
    assert args.batch_size == 1
    assert args.grad_accum == 16


def test_low_vram_smoke_explicit_memory_budget_wins() -> None:
    args = _resolve(
        ["--registry-key", "qwen3.5-2b", "--low-vram-smoke", "--memory-budget-gb", "10.0"]
    )
    assert args.memory_budget_gb == 10.0


def test_low_vram_smoke_without_registry_key() -> None:
    """The preset is meant to be used with --registry-key but should still
    apply sane defaults when used standalone (model stays at the argparse
    default Qwen3.5-0.8B)."""
    args = _resolve(["--low-vram-smoke"])
    assert args.max_seq_len == 2048
    assert args.batch_size == 1
    assert args.grad_accum == 16
    assert args.max_samples == 1000
    assert args.epochs == 1.0
    assert args.memory_budget_gb == 11.5


def test_no_low_vram_smoke_leaves_registry_defaults_alone() -> None:
    """Regression guard — the preset must only fire when the flag is set."""
    args = _resolve(["--registry-key", "qwen3.5-2b"])
    assert args.max_seq_len == 8192
    assert args.batch_size == 1
    assert args.grad_accum == 16  # same as preset, coincidence at 2B
    assert args.memory_budget_gb == pytest.approx(15.5)
    assert args.max_samples == 0
    assert args.epochs == 3.0


def test_low_vram_smoke_flag_lives_on_train_local_parser() -> None:
    """The flag must actually exist on the real parser. Catches the
    regression where someone removes the option but leaves the override
    block (or vice versa)."""
    src = (ROOT / "scripts" / "train_local.py").read_text(encoding="utf-8")
    assert '"--low-vram-smoke"' in src
    assert "args.low_vram_smoke" in src
    assert "low-vram-smoke preset" in src
