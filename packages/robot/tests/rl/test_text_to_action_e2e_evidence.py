from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import evidence_text_to_action_e2e as e2e


class _Args:
    def __init__(self, checkpoint: Path, profile: str | None = None) -> None:
        self.checkpoint = checkpoint
        self.profile = profile


def _write_manifest(path: Path, *, profile_id: str) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "manifest.json").write_text(
        json.dumps({"profile_id": profile_id, "regime": "alberta_streaming"}),
        encoding="utf-8",
    )


def test_e2e_evidence_infers_profile_from_checkpoint_manifest(tmp_path: Path) -> None:
    _write_manifest(tmp_path, profile_id="asimov-1")
    args = _Args(tmp_path)

    assert e2e._resolve_profile(args) == "asimov-1"
    assert args.profile == "asimov-1"


def test_e2e_evidence_rejects_checkpoint_profile_mismatch(tmp_path: Path) -> None:
    _write_manifest(tmp_path, profile_id="asimov-1")

    with pytest.raises(ValueError, match="checkpoint profile mismatch"):
        e2e._resolve_profile(_Args(tmp_path, profile="hiwonder-ainex"))


@pytest.mark.asyncio
async def test_e2e_evidence_uses_asimov_mujoco_for_asimov_sim_only(monkeypatch) -> None:
    calls: list[str] = []

    class FakeAsimovBackend:
        backend_name = "asimov_mujoco"

        def __init__(self, *, profile_id: str) -> None:
            self.profile_id = profile_id

        async def connect(self) -> None:
            calls.append(f"connect:{self.profile_id}")

    monkeypatch.setattr(e2e, "AsimovMujocoBackend", FakeAsimovBackend)

    backend, sim_env = await e2e._build_backend(
        type("Args", (), {"profile": "asimov-1", "no_real": True})()
    )

    assert backend.backend_name == "asimov_mujoco"
    assert sim_env is None
    assert calls == ["connect:asimov-1"]
