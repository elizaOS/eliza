"""Smoke test the unified training CLI dry-run mode for every profile.

These tests don't run the full PPO loop (too expensive for CI); they
exercise the `--dry-run` mode that reset+step the env once and writes a
manifest. That's enough to catch broken profile→env wiring before a GPU
spend.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

PKG_ROOT = Path(__file__).resolve().parents[2]
TRAIN_SCRIPT = PKG_ROOT / "scripts" / "train_text_conditioned.py"

SUPPORTED = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1")


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_unified_train_cli_dry_run_writes_manifest(
    profile_id: str, tmp_path: Path
) -> None:
    pytest.importorskip("mujoco")
    out_dir = tmp_path / f"smoke_{profile_id}"
    cmd = [
        sys.executable,
        str(TRAIN_SCRIPT),
        "--profile",
        profile_id,
        "--out",
        str(out_dir),
        "--dry-run",
        "--seed",
        "0",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(PKG_ROOT))
    assert proc.returncode == 0, (
        f"{profile_id} dry-run rc={proc.returncode}\n"
        f"stdout={proc.stdout[-500:]}\nstderr={proc.stderr[-500:]}"
    )
    manifest_path = out_dir / "manifest.json"
    assert manifest_path.is_file(), f"missing manifest at {manifest_path}"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["regime"] == "dry_run"
    assert manifest["profile_id"] == profile_id
    assert manifest["dry_run"] is True
    assert manifest["obs_dim"] > 0
    assert manifest["action_dim"] > 0


def test_unified_train_cli_rejects_unknown_profile() -> None:
    cmd = [
        sys.executable,
        str(TRAIN_SCRIPT),
        "--profile",
        "does-not-exist",
        "--dry-run",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(PKG_ROOT))
    assert proc.returncode != 0
    assert "invalid choice" in (proc.stderr + proc.stdout).lower()
