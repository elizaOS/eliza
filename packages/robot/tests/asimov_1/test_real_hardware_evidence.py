from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import collect_asimov1_real_hardware_evidence as evidence  # noqa: E402


def _args(tmp_path: Path, **overrides) -> argparse.Namespace:
    values = {
        "url": "wss://asimov.example.invalid",
        "token": "token",
        "timeout": 0.1,
        "out": tmp_path,
        "require_modules": True,
        "allow_stand": False,
        "allow_zero_velocity": False,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def test_real_hardware_evidence_runs_preflight_telemetry_and_damp_probe(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []

    def fake_prereqs(*, require_credentials: bool, require_modules: bool) -> dict:
        calls.append(f"preflight:{require_credentials}:{require_modules}")
        return {"ok": True, "profile_id": "asimov-1", "checks": {}, "missing_required": []}

    async def fake_telemetry(*, url: str, token: str, timeout_s: float) -> dict:
        calls.append(f"telemetry:{url}:{token}:{timeout_s}")
        return {
            "ok": True,
            "profile_id": "asimov-1",
            "probe": "telemetry_only",
            "command_messages_published": 0,
        }

    async def fake_command(args: argparse.Namespace) -> dict:
        calls.append(f"command:{args.allow_stand}:{args.allow_zero_velocity}")
        return {
            "ok": True,
            "profile_id": "asimov-1",
            "probe": "staged_real_command",
            "commands_sent": ["mode:DAMP"],
        }

    monkeypatch.setattr(evidence, "check_asimov1_real_prereqs", fake_prereqs)
    monkeypatch.setattr(evidence, "probe_asimov_real_telemetry", fake_telemetry)
    monkeypatch.setattr(evidence, "run_command_probe", fake_command)

    report = asyncio.run(evidence.collect_asimov1_real_hardware_evidence(_args(tmp_path)))

    assert report["ok"] is True
    assert [stage["name"] for stage in report["stages"]] == [
        "strict_preflight",
        "telemetry_only",
        "staged_real_command",
    ]
    assert report["checks"]["non_default_motion_requires_flags"] is True
    assert calls == [
        "preflight:True:True",
        "telemetry:wss://asimov.example.invalid:token:0.1",
        "command:False:False",
    ]
    written = Path(report["report_path"])
    assert written == tmp_path / "asimov1_real_hardware_evidence.json"
    assert json.loads(written.read_text(encoding="utf-8"))["ok"] is True


def test_real_hardware_evidence_stops_before_live_stages_when_preflight_fails(
    monkeypatch,
    tmp_path: Path,
) -> None:
    async def fail_if_called(*_args, **_kwargs) -> dict:
        raise AssertionError("live stage should not run")

    monkeypatch.setattr(
        evidence,
        "check_asimov1_real_prereqs",
        lambda **_kwargs: {
            "ok": False,
            "profile_id": "asimov-1",
            "checks": {},
            "missing_required": ["ASIMOV_LIVEKIT_URL"],
        },
    )
    monkeypatch.setattr(evidence, "probe_asimov_real_telemetry", fail_if_called)
    monkeypatch.setattr(evidence, "run_command_probe", fail_if_called)

    report = asyncio.run(evidence.collect_asimov1_real_hardware_evidence(_args(tmp_path)))

    assert report["ok"] is False
    assert [stage["name"] for stage in report["stages"]] == ["strict_preflight"]
    assert report["checks"]["telemetry_probe_completed"] is False
    assert report["checks"]["command_probe_completed"] is False
