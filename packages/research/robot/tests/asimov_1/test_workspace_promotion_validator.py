from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.cad_edit import (  # noqa: E402
    apply_asimov1_mjcf_patch,
    create_asimov1_edit_workspace,
    promote_asimov1_workspace,
    regenerate_asimov1_workspace,
)
from scripts.validate_asimov1_workspace_promotion import (  # noqa: E402
    validate_workspace_promotion,
)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _prepare_workspace(path: Path) -> Path:
    create_asimov1_edit_workspace(path, force=True)
    apply_asimov1_mjcf_patch(
        path,
        {
            "joints": {"left_ankle_roll_joint": {"range": [-0.12, 0.12]}},
            "comment": "promotion validator test",
        },
    )
    regenerate_asimov1_workspace(path)
    return path


def test_workspace_promotion_validator_accepts_dry_run_evidence(tmp_path: Path) -> None:
    workspace = _prepare_workspace(tmp_path / "edit")
    promote_asimov1_workspace(workspace, dry_run=True)

    report = validate_workspace_promotion(workspace)

    assert report["ok"] is True
    assert report["checks"]["promotion_source_hashes"] is True
    assert report["checks"]["promotion_vendor_commit"] is True
    assert report["checks"]["manifest_cad_inventory_hashes"] is True
    assert report["checks"]["promotion_cad_inventory_hashes"] is True
    assert report["checks"]["promotion_generated_hashes"] is True
    assert report["checks"]["source_edit_chain"] is True
    assert report["checks"]["promotion_destinations"] is True
    assert report["checks"]["promotion_applied_hashes"] is True
    assert report["promotion"]["copy_count"] == 31


def test_workspace_promotion_validator_requires_applied_hashes_when_requested(
    tmp_path: Path,
) -> None:
    workspace = _prepare_workspace(tmp_path / "edit")
    promote_asimov1_workspace(workspace, dry_run=True)

    report = validate_workspace_promotion(workspace, require_applied=True)

    assert report["ok"] is False
    assert report["checks"]["promotion_applied_hashes"] is False


def test_workspace_promotion_validator_rejects_stale_generated_hash(
    tmp_path: Path,
) -> None:
    workspace = _prepare_workspace(tmp_path / "edit")
    promote_asimov1_workspace(workspace, dry_run=True)
    plan_path = workspace / "asimov_promotion_plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    plan["generated_mjcf_sha256"] = "0" * 64
    plan_path.write_text(json.dumps(plan), encoding="utf-8")

    report = validate_workspace_promotion(workspace)

    assert report["ok"] is False
    assert report["checks"]["promotion_generated_hashes"] is False


def test_workspace_promotion_validator_rejects_unloadable_generated_mjcf(
    tmp_path: Path,
) -> None:
    workspace = _prepare_workspace(tmp_path / "edit")
    promote_asimov1_workspace(workspace, dry_run=True)
    meta = json.loads((workspace / "ASIMOV_EDIT_WORKSPACE.json").read_text(encoding="utf-8"))
    generated_mjcf = Path(meta["generated_mjcf"])
    generated_mjcf.write_text("<mujoco><worldbody></worldbody></mujoco>\n", encoding="utf-8")
    mjcf_hash = _sha256(generated_mjcf)
    for report_name in (
        "asimov_regeneration_report.json",
        "asimov_promotion_plan.json",
    ):
        report_path = workspace / report_name
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["generated_mjcf_sha256"] = mjcf_hash
        if report_name == "asimov_promotion_plan.json":
            for item in report["copies"]:
                if item["source"] == str(generated_mjcf):
                    item["source_sha256"] = mjcf_hash
        report_path.write_text(json.dumps(report), encoding="utf-8")
    manifest_path = Path(meta["generated_manifest"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["generated_mjcf_sha256"] = mjcf_hash
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    promotion_path = workspace / "asimov_promotion_plan.json"
    regen_path = workspace / "asimov_regeneration_report.json"
    regen = json.loads(regen_path.read_text(encoding="utf-8"))
    regen["generated_manifest_sha256"] = _sha256(manifest_path)
    regen_path.write_text(json.dumps(regen), encoding="utf-8")
    promotion = json.loads(promotion_path.read_text(encoding="utf-8"))
    promotion["generated_manifest_sha256"] = _sha256(manifest_path)
    for item in promotion["copies"]:
        if item["source"] == str(manifest_path):
            item["source_sha256"] = _sha256(manifest_path)
    promotion_path.write_text(json.dumps(promotion), encoding="utf-8")

    report = validate_workspace_promotion(workspace)

    assert report["ok"] is False
    assert report["checks"]["manifest_hashes"] is True
    assert report["checks"]["promotion_generated_hashes"] is True
    assert report["checks"]["generated_mjcf_compiles"] is False


def test_workspace_promotion_validator_rejects_stale_source_edit_chain(
    tmp_path: Path,
) -> None:
    workspace = _prepare_workspace(tmp_path / "edit")
    promote_asimov1_workspace(workspace, dry_run=True)
    meta = json.loads((workspace / "ASIMOV_EDIT_WORKSPACE.json").read_text(encoding="utf-8"))
    source = Path(meta["source_xml"])
    source.write_text(
        source.read_text(encoding="utf-8").replace(
            "promotion validator test",
            "stale source edit",
        ),
        encoding="utf-8",
    )

    report = validate_workspace_promotion(workspace)

    assert report["ok"] is False
    assert report["checks"]["source_edit_chain"] is False


def test_workspace_promotion_validator_rejects_stale_vendor_commit(
    tmp_path: Path,
) -> None:
    workspace = _prepare_workspace(tmp_path / "edit")
    promote_asimov1_workspace(workspace, dry_run=True)
    plan_path = workspace / "asimov_promotion_plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    plan["vendor_commit"] = "stale"
    plan_path.write_text(json.dumps(plan), encoding="utf-8")

    report = validate_workspace_promotion(workspace)

    assert report["ok"] is False
    assert report["checks"]["promotion_vendor_commit"] is False


def test_workspace_promotion_validator_rejects_stale_cad_inventory_hash(
    tmp_path: Path,
) -> None:
    workspace = _prepare_workspace(tmp_path / "edit")
    promote_asimov1_workspace(workspace, dry_run=True)
    manifest_path = workspace / "generated" / "asimov-1" / "asimov_asset_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["cad"]["main_step_sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    report = validate_workspace_promotion(workspace)

    assert report["ok"] is False
    assert report["checks"]["manifest_cad_inventory_hashes"] is False
