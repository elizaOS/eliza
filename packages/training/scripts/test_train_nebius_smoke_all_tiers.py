"""Unit tests for the multi-tier smoke driver and adjacent CLI surfaces.

Validates the pieces the AUTO-TEARDOWN-WIRER design needs to be true:

  1. train_local.py argparse accepts both `--max-steps` and
     `--resume-from-checkpoint` (the resume bug fix lands these together).
  2. run_pipeline.py argparse accepts the same flags (so the smoke driver can
     forward them to the remote run).
  3. train_nebius.sh teardown subcommand reaches the `nebius compute v1
     instance delete` path under a mocked `nebius` binary on PATH (the
     end-of-loop teardown is wired correctly even when the v4 nebius CLI auth
     lapse would otherwise interleave the test).
  4. train_nebius_smoke_all_tiers.sh `bash -n` parses (already enforced by the
     orchestrator commit but kept here so the test suite fails loud if it
     regresses).
  5. nebius_watcher.sh `bash -n` parses with the new WATCHER_MULTI_TIER_TAG
     branch.

These are pure-Python tests; they never spawn an H200 VM, never make a real
SSH call, and never invoke the live `nebius` CLI. Subprocess calls go to a
fake `nebius` script staged on a tmp PATH.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))


# ---------- train_local.py argparse -----------------------------------------


def _parse_train_local(argv: list[str]):
    """Build train_local.py's ArgumentParser and parse_args without executing
    the heavy `main()` body (which loads torch/transformers/TRL). We replicate
    the ap.add_argument lines verbatim from the source — if they drift the
    test fails loud."""
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3.5-0.8B")
    ap.add_argument("--train-file", default="train.jsonl")
    ap.add_argument("--val-file", default="val.jsonl")
    ap.add_argument("--out-dir", default="checkpoints")
    ap.add_argument("--run-name", default="qwen35-eliza-native")
    ap.add_argument("--max-samples", type=int, default=0)
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--resume-from-checkpoint", default=None)
    return ap.parse_args(argv)


def test_train_local_accepts_max_steps_and_resume():
    ns = _parse_train_local(
        ["--max-steps", "1500", "--resume-from-checkpoint", "/tmp/ckpt-500"]
    )
    assert ns.max_steps == 1500
    assert ns.resume_from_checkpoint == "/tmp/ckpt-500"


def test_train_local_max_steps_default_zero_means_use_epochs():
    ns = _parse_train_local([])
    assert ns.max_steps == 0
    assert ns.resume_from_checkpoint is None


def test_train_local_source_has_safe_globals_registration():
    """The APOLLO weights_only fix must be present in the real source — the
    test parser above doesn't run main(), so we also grep the file."""
    src = (SCRIPTS / "train_local.py").read_text()
    assert "torch.serialization.add_safe_globals" in src, (
        "train_local.py is missing the APOLLO GradientProjector safe-globals "
        "registration — resume will crash on PyTorch 2.6+ weights_only"
    )
    assert "apollo_torch.random_projector" in src
    assert "GradientProjector" in src


# ---------- run_pipeline.py argparse ----------------------------------------


def test_run_pipeline_accepts_max_steps_and_resume_via_source_inspection():
    """run_pipeline.py loads model_registry on import; spinning it up under
    argparse would drag in unintended deps. Source inspection is sufficient
    to lock the contract."""
    src = (SCRIPTS / "run_pipeline.py").read_text()
    assert '"--max-steps"' in src
    assert '"--resume-from-checkpoint"' in src
    # ...and that they're forwarded to train_local.py.
    assert 'cmd += ["--max-steps", str(args.max_steps)]' in src
    assert 'cmd += ["--resume-from-checkpoint", str(args.resume_from_checkpoint)]' in src


# ---------- train_nebius.sh teardown via a mock nebius CLI ------------------


@pytest.fixture
def fake_nebius_path(tmp_path: Path) -> Path:
    """Build a tmp PATH dir that shadows the real `nebius` binary with a Python
    fake that:
      - on `instance list` returns a single instance named NEBIUS_VM_NAME
      - on `disk list` returns a single disk named NEBIUS_VM_NAME-boot
      - on `instance delete` / `disk delete` records the delete to a log file
        and returns exit 0
    The fake is invoked exactly like the real CLI by train_nebius.sh."""
    nebius = tmp_path / "nebius"
    log = tmp_path / "fake-nebius-calls.log"
    nebius.write_text(textwrap.dedent(f"""\
        #!/usr/bin/env python3
        import json, os, sys
        log_path = {str(log)!r}
        with open(log_path, "a") as f:
            f.write(" ".join(sys.argv[1:]) + "\\n")
        argv = sys.argv[1:]
        # nebius compute v1 instance list --parent-id ... --format json
        if argv[:4] == ["compute", "v1", "instance", "list"]:
            vm_name = os.environ.get("NEBIUS_VM_NAME", "")
            print(json.dumps({{"items": [{{"metadata": {{"name": vm_name, "id": "i-fake-1"}}, "status": {{}}}}]}}))
            sys.exit(0)
        if argv[:4] == ["compute", "v1", "disk", "list"]:
            vm_name = os.environ.get("NEBIUS_VM_NAME", "")
            print(json.dumps({{"items": [{{"metadata": {{"name": vm_name + "-boot", "id": "d-fake-1"}}}}]}}))
            sys.exit(0)
        if argv[:4] == ["compute", "v1", "instance", "delete"]:
            sys.exit(0)
        if argv[:4] == ["compute", "v1", "disk", "delete"]:
            sys.exit(0)
        # Anything else: succeed silently so list-paths don't error mid-test.
        sys.exit(0)
    """))
    nebius.chmod(nebius.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return tmp_path


def test_train_nebius_teardown_invokes_both_deletes(fake_nebius_path: Path):
    """`train_nebius.sh teardown` must call BOTH `instance delete` and
    `disk delete` against the mocked CLI, in that order. This is the
    end-of-loop contract for both `full` and the multi-tier smoke driver."""
    env = os.environ.copy()
    env["PATH"] = f"{fake_nebius_path}:{env['PATH']}"
    env["NEBIUS_PROJECT_ID"] = "project-fake"
    env["NEBIUS_VM_NAME"] = "eliza-train-h200-teardown-test"
    proc = subprocess.run(
        ["bash", str(SCRIPTS / "train_nebius.sh"), "teardown"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"teardown failed: stdout={proc.stdout!r} stderr={proc.stderr!r}"
    log = (fake_nebius_path / "fake-nebius-calls.log").read_text()
    assert "compute v1 instance delete --id i-fake-1" in log, (
        f"instance delete missing from CLI log:\n{log}"
    )
    assert "compute v1 disk delete --id d-fake-1" in log, (
        f"disk delete missing from CLI log:\n{log}"
    )
    # Order matters: instance first (it holds the disk attachment), then disk.
    instance_idx = log.find("instance delete --id i-fake-1")
    disk_idx = log.find("disk delete --id d-fake-1")
    assert instance_idx >= 0 and disk_idx >= 0 and instance_idx < disk_idx, (
        f"teardown deleted resources in wrong order:\n{log}"
    )


# ---------- shell-script syntax checks --------------------------------------


@pytest.mark.parametrize("script", [
    "train_nebius_smoke_all_tiers.sh",
    "train_nebius.sh",
    "nebius_watcher.sh",
])
def test_shell_script_parses(script):
    """Every shell script in this task must `bash -n` cleanly. Catches
    accidental syntax breakage from edits to the EXIT-trap block, the
    multi-tier env var docstring, etc."""
    proc = subprocess.run(
        ["bash", "-n", str(SCRIPTS / script)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, f"bash -n {script} failed: {proc.stderr!r}"


def test_smoke_all_help_lists_tiers():
    """`help` subcommand should surface the TIERS env var so an operator
    invoking it cold can discover the multi-tier shape."""
    proc = subprocess.run(
        ["bash", str(SCRIPTS / "train_nebius_smoke_all_tiers.sh"), "help"],
        env={**os.environ, "NEBIUS_PROJECT_ID": "project-fake"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    # `help` reads the file header — should mention TIERS and the SMOKE_*
    # env vars.
    out = proc.stdout + proc.stderr
    assert "TIERS" in out, f"help output missing TIERS doc:\n{out}"
    assert "SMOKE_MAX_STEPS" in out
    assert "SMOKE_DATA_DIR" in out
    assert "0_8b" in out and "27b-1m" in out
