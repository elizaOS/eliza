from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_cad_toolchain import (
    REQUIRED_CAPABILITIES,
    build_fembot_cad_toolchain_readiness_proof,
)
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory


def test_fembot_cad_toolchain_prefers_cli_python_occ_over_freecad() -> None:
    report = build_fembot_cad_toolchain_readiness_proof()

    assert report["schema"] == "asimov-fembot-cad-toolchain-readiness-v1"
    assert report["ok"] is True
    assert report["required_capabilities"] == list(REQUIRED_CAPABILITIES)
    assert report["freecad_fallback"]["role"] == "fallback_only_not_preferred"
    assert report["isolated_env"]["requirements_exists"] is True
    assert report["isolated_env"]["venv"].endswith("cad/asimov-fembot/cad-env/.venv")
    assert "uv venv" in report["isolated_env"]["provision_command"]
    assert report["summary"]["cadquery_cli_capability_smoke_ok"] is True
    assert report["capability_smoke"]["ok"] is True
    assert report["capability_smoke"]["backend"] == "cadquery"
    assert report["capability_smoke"]["capabilities"] == {
        capability: True for capability in REQUIRED_CAPABILITIES
    }
    assert report["capability_smoke"]["metrics"]["imported_box_volume"] > 0.0
    assert report["capability_smoke"]["metrics"]["loft_volume"] > 0.0
    assert report["capability_smoke"]["metrics"]["sweep_volume"] > 0.0
    assert 0.0 < report["capability_smoke"]["metrics"]["boolean_cut_volume"] < 1.0
    assert 0.0 < report["capability_smoke"]["metrics"]["shell_volume"] < 1.0
    assert report["capability_smoke"]["metrics"]["selected_faces"] > 0
    assert report["capability_smoke"]["metrics"]["selected_edges"] > 0

    candidates = {candidate["package"]: candidate for candidate in report["candidates"]}
    assert set(candidates) == {"cadquery", "build123d", "cadquery-ocp", "pycad"}
    assert candidates["cadquery"]["role"] == "preferred"
    assert candidates["build123d"]["role"] == "preferred"
    assert candidates["cadquery-ocp"]["role"] == "kernel"
    assert candidates["pycad"]["role"] == "candidate_needs_capability_proof"
    assert candidates["pycad"]["capabilities"]["step_import"] is False
    assert candidates["pycad"]["ready"] is False

    for package in ("cadquery", "build123d", "cadquery-ocp"):
        assert set(candidates[package]["capabilities"]) == set(REQUIRED_CAPABILITIES)


def test_fembot_inventory_surfaces_cad_toolchain_status() -> None:
    report = collect_fembot_inventory()

    assert report["cad_toolchain"]["ok"] is True
    assert report["cad_toolchain"]["summary"]["freecad_role"] == "fallback_only_not_preferred"
    assert (
        report["cad_toolchain"]["summary"]["cadquery_cli_capability_smoke_ok"]
        is True
    )
    assert "preferred_ready" in report["cad_toolchain"]["summary"]


def test_fembot_cad_toolchain_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "cad-toolchain.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_cad_toolchain_proof.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-cad-toolchain-readiness-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"freecad_role": "fallback_only_not_preferred"' in proc.stdout


def test_fembot_cad_env_provisioner_reports_status_without_create() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/provision_asimov_fembot_cad_env.py"],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert "status" in report
    assert report["status"]["requirements_exists"] is True
    assert report["status"]["venv"].endswith("cad/asimov-fembot/cad-env/.venv")
