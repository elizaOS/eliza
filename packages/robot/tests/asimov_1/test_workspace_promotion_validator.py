from __future__ import annotations

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
