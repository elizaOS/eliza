from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import check_asimov1_real_prereqs as prereqs  # noqa: E402


def _fake_missing_spec(name: str):
    if name == "edge.generated.edge_cloud_pb2":
        raise ModuleNotFoundError(name)
    return None


def _fake_present_spec(_name: str):
    return object()


def test_real_prereqs_non_strict_allows_missing_hardware_credentials(monkeypatch) -> None:
    monkeypatch.delenv("ASIMOV_LIVEKIT_URL", raising=False)
    monkeypatch.delenv("ASIMOV_LIVEKIT_TOKEN", raising=False)
    monkeypatch.setattr(prereqs.importlib.util, "find_spec", _fake_missing_spec)

    report = prereqs.check_asimov1_real_prereqs()

    assert report["ok"] is True
    assert report["checks"]["target_registered"] is True
    assert report["checks"]["command_envelope_target"] is True
    assert report["checks"]["backend_factory"] is True
    assert report["checks"]["livekit_url_configured"] is False
    assert report["checks"]["livekit_token_configured"] is False
    assert report["checks"]["livekit_python_available"] is False
    assert report["checks"]["edge_protobuf_available"] is False
    assert report["missing_required"] == []
    assert report["capabilities"]["command_topic"] == "commands"
    assert report["capabilities"]["telemetry_message"].endswith("EdgeTelemetry")


def test_real_prereqs_strict_requires_credentials_and_modules(monkeypatch) -> None:
    monkeypatch.delenv("ASIMOV_LIVEKIT_URL", raising=False)
    monkeypatch.delenv("ASIMOV_LIVEKIT_TOKEN", raising=False)
    monkeypatch.setattr(prereqs.importlib.util, "find_spec", _fake_missing_spec)

    report = prereqs.check_asimov1_real_prereqs(
        require_credentials=True,
        require_modules=True,
    )

    assert report["ok"] is False
    assert report["missing_required"] == [
        "ASIMOV_LIVEKIT_URL",
        "ASIMOV_LIVEKIT_TOKEN",
        "livekit",
        "edge.generated.edge_cloud_pb2",
    ]


def test_real_prereqs_strict_passes_with_credentials_and_modules(monkeypatch) -> None:
    monkeypatch.setenv("ASIMOV_LIVEKIT_URL", "wss://asimov.example.invalid")
    monkeypatch.setenv("ASIMOV_LIVEKIT_TOKEN", "token")
    monkeypatch.setattr(prereqs.importlib.util, "find_spec", _fake_present_spec)

    report = prereqs.check_asimov1_real_prereqs(
        require_credentials=True,
        require_modules=True,
    )

    assert report["ok"] is True
    assert report["missing_required"] == []
    assert report["checks"]["livekit_url_configured"] is True
    assert report["checks"]["livekit_token_configured"] is True
    assert report["checks"]["livekit_python_available"] is True
    assert report["checks"]["edge_protobuf_available"] is True
    assert report["capabilities"]["livekit_configured"] is True
