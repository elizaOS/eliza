#!/usr/bin/env python3
"""Tests for the package-board co-design + AMS gates.

Each gate must PASS on the committed artifacts and fail-closed when a contract
is corrupted (stale checksum, missing pin, electrical claim, etc.).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def run(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts" / script), *args],
        capture_output=True,
        text=True,
    )


def run_in(workdir: Path, script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(workdir / "scripts" / script), *args],
        capture_output=True,
        text=True,
    )


def test_analog_policy_passes() -> None:
    result = run("check_analog_automation_policy.py")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS analog_automation_policy" in result.stdout


def test_signal_group_intent_passes() -> None:
    result = run("check_signal_group_intent.py")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS signal_group_intent" in result.stdout


def test_ams_contract_passes() -> None:
    result = run("check_ams_contract.py")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS ams_block_contract" in result.stdout
    for path in (ROOT / "docs/spec-db/ams").glob("*.yaml"):
        contract = yaml.safe_load(path.read_text())
        for key in (
            "claim_allowed",
            "release_claim_allowed",
            "electrical_signoff_claim_allowed",
            "vendor_ip_claim_allowed",
            "silicon_claim_allowed",
        ):
            assert contract.get(key) is False, f"{path.name}: {key}"


def test_padring_substrate_passes() -> None:
    result = run("check_padring_substrate.py")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS padring_substrate" in result.stdout


def test_artifact_provenance_passes() -> None:
    result = run("build_artifact_provenance.py")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS artifact_provenance" in result.stdout


def _mirror(workdir: Path) -> None:
    for rel in (
        "scripts",
        "package",
        "pd",
        "docs/spec-db",
        "docs/pd/pad-cell-selection-criteria.md",
        "board/kicad/e1-demo",
        "board/kicad/e1-phone/evt1-stackup-impedance-coupon-plan.yaml",
    ):
        src = ROOT / rel
        dst = workdir / rel
        if src.is_dir():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
        elif src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def test_signal_group_fails_on_unknown_member() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        _mirror(workdir)
        path = workdir / "package/signal-groups.yaml"
        intent = yaml.safe_load(path.read_text())
        intent["signal_groups"][0]["members"].append("NOT_A_REAL_PIN")
        path.write_text(yaml.safe_dump(intent, sort_keys=False))
        result = run_in(workdir, "check_signal_group_intent.py")
        assert result.returncode == 1, result.stdout
        assert "NOT_A_REAL_PIN" in result.stdout


def test_ams_contract_fails_on_unblocked_status() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        _mirror(workdir)
        path = workdir / "docs/spec-db/ams/pll-ref-clock.yaml"
        contract = yaml.safe_load(path.read_text())
        contract["status"] = "READY_FOR_TAPEOUT"
        path.write_text(yaml.safe_dump(contract, sort_keys=False))
        result = run_in(workdir, "check_ams_contract.py")
        assert result.returncode == 1, result.stdout
        assert "status must stay BLOCKED" in result.stdout


def test_padring_substrate_fails_when_advanced_node_unblocked() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        _mirror(workdir)
        path = workdir / "pd/padframe/e1-demo-substrate.yaml"
        substrate = yaml.safe_load(path.read_text())
        for rule in substrate["node_pitch_rules"]:
            if rule["node_id"] == "tsmc-n2p":
                rule["posture"] = "open_fabricable"
                rule["bump_pitch_um"] = 130
        path.write_text(yaml.safe_dump(substrate, sort_keys=False))
        result = run_in(workdir, "check_padring_substrate.py")
        assert result.returncode == 1, result.stdout
        assert "tsmc-n2p" in result.stdout


def test_provenance_fails_on_stale_upstream() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        _mirror(workdir)
        # Build clean, then mutate an upstream source so the downstream
        # upstream_checksum goes stale.
        built = run_in(workdir, "build_artifact_provenance.py", "--build")
        assert built.returncode == 0, built.stdout
        die_source = workdir / "pd/padframe/e1_demo_padframe.yaml"
        die_source.write_text(die_source.read_text() + "\n# ECO drift without propagation\n")
        result = run_in(workdir, "build_artifact_provenance.py")
        assert result.returncode == 1, result.stdout
        assert "stale" in result.stdout


def test_analog_policy_fails_on_missing_blocked_action() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        _mirror(workdir)
        path = workdir / "docs/spec-db/e1-analog-automation-policy.yaml"
        policy = yaml.safe_load(path.read_text())
        policy["blocked_actions"].remove("run_spice_simulation")
        path.write_text(yaml.safe_dump(policy, sort_keys=False))
        result = run_in(workdir, "check_analog_automation_policy.py")
        assert result.returncode == 1, result.stdout
        assert "run_spice_simulation" in result.stdout


def main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS: {test.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL: {test.__name__}: {exc}")
    if failures:
        print(f"{failures} test(s) failed")
        return 1
    print(f"All {len(tests)} package/AMS tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
