"""Tests for the OpenPI policy client + dispatcher."""

from __future__ import annotations

import importlib
import sys

import numpy as np
import pytest

from eliza_robot.policy import ActionChunk, PolicyBackend, get_policy_backend
from eliza_robot.policy.openpi.client import OpenPIPolicyClient

# ---------------------------------------------------------------------------
# Lazy-import error surface
# ---------------------------------------------------------------------------

def test_openpi_client_lazy_import_error_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """`start()` raises ImportError mentioning openpi-client when missing."""
    # Force the lazy import to fail even if the real package happens to be
    # installed in the test environment.
    monkeypatch.setitem(sys.modules, "openpi_client", None)
    monkeypatch.setitem(sys.modules, "openpi_client.websocket_client_policy", None)

    client = OpenPIPolicyClient(endpoint="ws://localhost:9200")
    with pytest.raises(ImportError) as excinfo:
        client.start("walk forward")
    assert "openpi-client" in str(excinfo.value)


# ---------------------------------------------------------------------------
# ActionChunk dataclass
# ---------------------------------------------------------------------------

def test_action_chunk_dataclass_shape() -> None:
    chunk = ActionChunk(
        joints=np.array([0.1, -0.2, 0.3], dtype=np.float32),
        walk_command={"x": 0.01, "y": 0.0, "yaw": 0.5, "speed": 2, "height": 0.036},
        head_target={"pan": 0.0, "tilt": -0.2},
        confidence=0.87,
        latency_ms=42.5,
    )
    d = chunk.to_dict()

    assert d["joints"] == [pytest.approx(0.1), pytest.approx(-0.2), pytest.approx(0.3)]
    assert d["walk_command"]["speed"] == 2
    assert d["head_target"]["tilt"] == pytest.approx(-0.2)
    assert d["confidence"] == pytest.approx(0.87)
    assert d["latency_ms"] == pytest.approx(42.5)

    # Default-constructed chunk round-trips cleanly without numpy fields.
    empty = ActionChunk()
    empty_d = empty.to_dict()
    assert empty_d["joints"] is None
    assert empty_d["walk_command"] is None
    assert empty_d["head_target"] is None
    assert empty_d["confidence"] == pytest.approx(1.0)
    assert empty_d["latency_ms"] == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def test_dispatch_unknown_raises() -> None:
    with pytest.raises(ValueError) as excinfo:
        get_policy_backend("nonexistent")
    assert "nonexistent" in str(excinfo.value)


def test_dispatch_openpi_returns_client_type() -> None:
    backend = get_policy_backend("openpi", endpoint="ws://x:9200")
    assert isinstance(backend, OpenPIPolicyClient)
    assert isinstance(backend, PolicyBackend)
    # No network connection should be opened — only the constructor ran.
    assert backend.is_alive() is False


def test_openpi_endpoint_must_include_port(monkeypatch: pytest.MonkeyPatch) -> None:
    """Endpoint format is validated at `start()`, not in the constructor."""
    # Install a fake openpi_client so the import path inside start() succeeds
    # and we hit the endpoint parser instead.
    import types

    fake_ws_mod = types.ModuleType("openpi_client.websocket_client_policy")

    class _FakeClient:
        def __init__(self, host: str, port: int) -> None:  # pragma: no cover - never reached
            self.host = host
            self.port = port

    fake_ws_mod.WebsocketClientPolicy = _FakeClient  # type: ignore[attr-defined]
    fake_pkg = types.ModuleType("openpi_client")
    monkeypatch.setitem(sys.modules, "openpi_client", fake_pkg)
    monkeypatch.setitem(sys.modules, "openpi_client.websocket_client_policy", fake_ws_mod)

    client = OpenPIPolicyClient(endpoint="ws://no-port")
    with pytest.raises(ValueError):
        client.start("walk forward")


def test_openpi_endpoint_rejects_empty() -> None:
    with pytest.raises(ValueError):
        OpenPIPolicyClient(endpoint="")


# ---------------------------------------------------------------------------
# Optional: only runs if openpi-client is actually installed (skipped otherwise)
# ---------------------------------------------------------------------------

def test_openpi_client_import_with_real_package_if_available() -> None:
    pytest.importorskip("openpi_client")
    # If we get here, the lazy import path should succeed up to the network
    # call. We don't actually connect — just confirm the symbol resolves.
    mod = importlib.import_module("openpi_client.websocket_client_policy")
    assert hasattr(mod, "WebsocketClientPolicy")
