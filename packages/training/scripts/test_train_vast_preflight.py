"""Exercises the Vast launcher's preflight receipt at the paid-operation boundary.

The deterministic harness copies the real launcher into a temporary training
root and replaces external CLIs with sentinels; it never contacts Vast.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from scripts.lib.vast import TARGETS

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_CHECKS = {
    "uv_lock",
    "pytest",
    "schema",
    "memory",
    "smoke",
    "cuda_capability",
    "format_ceiling",
    "default_thought_leak",
}


def _launcher_fixture(tmp_path: Path) -> tuple[Path, dict[str, str], Path]:
    fixture_root = tmp_path / "training"
    scripts = fixture_root / "scripts"
    scripts.mkdir(parents=True)
    launcher = scripts / "train_vast.sh"
    launcher.write_text((ROOT / "scripts" / "train_vast.sh").read_text())

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    marker = tmp_path / "vastai-called"

    fake_uv = fake_bin / "uv"
    fake_uv.write_text("#!/bin/sh\nexit 1\n")
    fake_uv.chmod(0o755)

    fake_vastai = fake_bin / "vastai"
    fake_vastai.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$VAST_SENTINEL"\nexit 77\n'
    )
    fake_vastai.chmod(0o755)

    ssh_key = tmp_path / "fixture.pub"
    ssh_key.write_text("fixture")

    env = os.environ.copy()
    for name in (
        "NEBIUS_API_KEY",
        "NEBIUS_PROJECT_ID",
        "NEBIUS_VM_PRESET",
        "NEBIUS_VM_REGION",
        "NEBIUS_INSTANCE_ID",
        "ELIZA_SKIP_PREFLIGHT",
        "ELIZA_VAST_GPU_PREFERENCE",
        "FSDP_WORLD_SIZE",
        "PIPELINE",
        "REGISTRY_KEY",
        "VAST_GPU_TARGET",
    ):
        env.pop(name, None)
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "SSH_KEY": str(ssh_key),
            "VAST_API_KEY": "fixture-only",
            "VAST_OFFER_ID": "fixture-offer",
            "VAST_SENTINEL": str(marker),
        }
    )
    return launcher, env, marker


def _passing_checks() -> dict[str, dict[str, str]]:
    return {name: {"status": "pass"} for name in EXPECTED_CHECKS}


def _write_receipt(
    root: Path,
    registry_key: str,
    gpu_target: str,
    *,
    checks: dict[str, dict[str, str]] | None = None,
) -> None:
    (root / ".preflight.ok").write_text(
        json.dumps(
            {
                "timestamp_epoch": 0,
                "timestamp": "fixture",
                "registry_key": registry_key,
                "gpu_target": gpu_target,
                "checks": _passing_checks() if checks is None else checks,
            }
        )
    )


def _provision(launcher: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash",
            str(launcher),
            "--pipeline",
            "grpo",
            "--registry-key",
            "gemma4-12b",
            "provision",
        ],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


def test_matching_receipt_reaches_paid_operation_sentinel(tmp_path: Path) -> None:
    launcher, env, marker = _launcher_fixture(tmp_path)
    _write_receipt(launcher.parents[1], "gemma4-12b", "h200-4x")

    result = _provision(launcher, env)

    assert result.returncode == 77
    assert "fresh and matched" in result.stdout
    assert marker.read_text().startswith("create instance fixture-offer")


@pytest.mark.parametrize(
    ("receipt_registry", "receipt_target"),
    [
        ("gemma4-e2b", "h200-4x"),
        ("gemma4-12b", "h200-8x"),
    ],
)
def test_mismatched_receipt_fails_before_paid_operation(
    tmp_path: Path,
    receipt_registry: str,
    receipt_target: str,
) -> None:
    launcher, env, marker = _launcher_fixture(tmp_path)
    _write_receipt(launcher.parents[1], receipt_registry, receipt_target)

    result = _provision(launcher, env)

    assert result.returncode == 2
    assert "pre-flight receipt mismatch" in result.stderr
    assert "does not authorize this registry/GPU combination" in result.stderr
    assert not marker.exists()


@pytest.mark.parametrize(
    "receipt_checks",
    [
        {},
        {name: {"status": "pass"} for name in EXPECTED_CHECKS - {"schema"}},
        {
            **_passing_checks(),
            "memory": {"status": "fail"},
        },
    ],
    ids=("empty", "missing-gate", "failed-gate"),
)
def test_unproven_receipt_fails_before_paid_operation(
    tmp_path: Path,
    receipt_checks: dict[str, dict[str, str]],
) -> None:
    launcher, env, marker = _launcher_fixture(tmp_path)
    _write_receipt(
        launcher.parents[1],
        "gemma4-12b",
        "h200-4x",
        checks=receipt_checks,
    )

    result = _provision(launcher, env)

    assert result.returncode == 2
    assert "does not prove all eight gates passed" in result.stderr
    assert not marker.exists()


def test_preflight_covers_every_searchable_gpu_target() -> None:
    preflight = (ROOT / "scripts" / "preflight.sh").read_text()
    memory_block = preflight[
        preflight.index("TARGET_TO_HW:") : preflight.index(
            "if GPU_TARGET not in TARGET_TO_HW:"
        )
    ]
    cuda_block = preflight[
        preflight.index("TARGET_CAPS:") : preflight.index(
            "if GPU_TARGET not in TARGET_CAPS:"
        )
    ]
    declared_pattern = re.compile(r'^\s+"([^"]+)":', re.MULTILINE)

    assert set(declared_pattern.findall(memory_block)) == set(TARGETS)
    assert set(declared_pattern.findall(cuda_block)) == set(TARGETS)
