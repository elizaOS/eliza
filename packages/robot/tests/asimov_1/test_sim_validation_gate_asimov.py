from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.cad import sha256_file  # noqa: E402
from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
)
from scripts.sim_validation_gate import (  # noqa: E402
    _gate_asimov_mjx_env,
    _gate_asimov_model_provenance,
)


def _write_provenance_checkpoint(
    path: Path,
    *,
    mjcf_hash: str | None = None,
    manifest_hash: str | None = None,
) -> None:
    mjcf_hash = mjcf_hash or sha256_file(ASIMOV1_GENERATED_MJCF)
    manifest_hash = manifest_hash or sha256_file(ASIMOV1_GENERATED_MANIFEST)
    payload = {
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": mjcf_hash,
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": manifest_hash,
    }
    for name in ("training_job.json", "manifest.json", "config.json"):
        (path / name).write_text(json.dumps(payload), encoding="utf-8")


def test_asimov_sim_gate_accepts_asymmetric_mjx_observations() -> None:
    report = asyncio.run(_gate_asimov_mjx_env())

    assert report["passed"] is True
    assert report["obs_keys"] == ["privileged_state", "state"]
    assert report["actor_obs_shape"] == [53]
    assert report["critic_obs_shape"] == [62]
    assert report["observation_size"] == {"state": 53, "privileged_state": 62}


def test_asimov_model_provenance_gate_accepts_current_assets(tmp_path: Path) -> None:
    _write_provenance_checkpoint(tmp_path)

    report = asyncio.run(_gate_asimov_model_provenance(tmp_path))

    assert report["passed"] is True
    assert all(report["checks"].values())


def test_asimov_model_provenance_gate_rejects_stale_hash(tmp_path: Path) -> None:
    _write_provenance_checkpoint(tmp_path, mjcf_hash="0" * 64)

    report = asyncio.run(_gate_asimov_model_provenance(tmp_path))

    assert report["passed"] is False
    assert report["checks"]["mjcf_hash"] is False


def test_asimov_model_provenance_gate_rejects_stale_manifest_or_config(
    tmp_path: Path,
) -> None:
    _write_provenance_checkpoint(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    manifest["asset_manifest_sha256"] = "0" * 64
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    report = asyncio.run(_gate_asimov_model_provenance(tmp_path))

    assert report["passed"] is False
    assert report["checks"]["asset_manifest_hash"] is True
    assert report["checks"]["asset_manifest_manifest_config_provenance"] is False
