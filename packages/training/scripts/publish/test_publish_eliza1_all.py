"""Tests for the `publish_eliza1_all` operator entry point.

Coverage:
- dry-run produces a summary with no network calls and a zero exit
- the bundle dry-run wrapper turns a red orchestrator verdict into a "pending"
  outcome (never "published"), and a missing staged bundle into "pending" too
- the active-tier SFT-weights status reports "pending" when there is no final/ checkpoint
- the "publishable today" datasets are surfaced (eliza-1-training, eliza-1-evals)
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.publish import publish_eliza1_all as P  # noqa: E402


def test_dry_run_returns_zero_and_emits_summary(capsys, monkeypatch):
    # No HF_TOKEN -> forced dry-run; --skip-bundle-status to keep it offline.
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)
    rc = P.main(["--dry-run", "--skip-bundle-status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Eliza-1 HF publish summary" in out
    assert "elizaos/eliza-1-training" in out
    assert "elizaos/eliza-1-evals" in out
    # Nothing pushed in dry-run.
    assert "nothing was pushed" in out


def test_bundle_dry_run_missing_bundle_is_pending():
    out = P._bundle_dry_run("2b", Path("/nonexistent/eliza-1-2b.bundle"))
    assert out.status == "pending"
    assert out.repo == "elizaos/eliza-1"
    assert out.kind == "model-bundle"
    assert "bundles/2b/" in out.detail


def test_bundle_dry_run_red_gate_is_pending(tmp_path, monkeypatch):
    # Point at an empty dir: the orchestrator will fail layout validation (exit
    # != 0). The wrapper must classify that as "pending", never "published".
    bdir = tmp_path / "eliza-1-0_8b.bundle"
    bdir.mkdir()
    out = P._bundle_dry_run("0_8b", bdir)
    assert out.status == "pending"
    assert "exit=" in out.detail


def test_sft_weights_status_pending_without_final(monkeypatch, tmp_path):
    # Repoint TRAINING_ROOT/checkpoints at an empty tree.
    fake_root = tmp_path / "training"
    (fake_root / "checkpoints").mkdir(parents=True)
    monkeypatch.setattr(P, "TRAINING_ROOT", fake_root)
    out = P._sft_weights_status()
    assert out.status == "pending"
    assert out.repo == "elizaos/eliza-1"


def test_bundle_tiers_cover_full_active_matrix():
    assert P.BUNDLE_TIERS == (
        "0_8b",
        "2b",
        "4b",
        "9b",
        "27b",
        "27b-256k",
        "27b-1m",
    )
