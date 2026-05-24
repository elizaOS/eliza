from __future__ import annotations

import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_PROOF_TYPES, collect_fembot_inventory
from eliza_robot.asimov_1.fembot_proofs import (
    FEMBOT_PROOF_CONTRACTS,
    fembot_proof_contract_report,
)


def test_fembot_proof_contracts_match_inventory_required_types() -> None:
    contract_types = tuple(contract.proof_type for contract in FEMBOT_PROOF_CONTRACTS)

    assert contract_types == FEMBOT_PROOF_TYPES
    assert len(contract_types) == 17
    assert len(set(contract_types)) == len(contract_types)
    assert "flatness_or_smoothness" in contract_types
    assert "motor_bearing_ring_gear_pulley_fastener_keepouts" in contract_types
    assert "hardware_measurements" in contract_types
    assert "visual_motion_media" in contract_types
    assert "collision_sweep" in contract_types
    assert "collider_scale_tuning" in contract_types
    assert "structural_sanity" in contract_types


def test_fembot_proof_contracts_have_acceptance_fields() -> None:
    report = fembot_proof_contract_report()

    assert report["schema"] == "asimov-fembot-proof-contract-v1"
    assert report["proof_count"] == len(FEMBOT_PROOF_CONTRACTS)
    for contract in report["contracts"]:
        assert contract["proof_type"]
        assert contract["required_artifact_schema"]
        assert contract["pass_condition"]
        assert "accepted" in contract["minimum_fields"]
        assert set(contract["applies_to"]) == {"torso", "head", "arm", "leg", "foot"}


def test_fembot_inventory_includes_proof_contract_report() -> None:
    report = collect_fembot_inventory()

    assert report["proof_contracts"]["schema"] == "asimov-fembot-proof-contract-v1"
    assert report["proof_contracts"]["proof_types"] == list(FEMBOT_PROOF_TYPES)
    assert len(report["proof_contracts"]["contracts"]) == len(FEMBOT_PROOF_TYPES)


def test_fembot_proof_contract_cli_reports_contracts() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/report_asimov_fembot_proof_contracts.py"],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert '"schema": "asimov-fembot-proof-contract-v1"' in proc.stdout
    assert '"proof_type": "collision_sweep"' in proc.stdout
    assert '"proof_type": "hardware_measurements"' in proc.stdout
