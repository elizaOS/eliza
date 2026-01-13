from __future__ import annotations

import os

from fastapi.testclient import TestClient

from server import app


def test_health() -> None:
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_chat_rejects_without_secret_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("ELIZA_ROBLOX_SHARED_SECRET", "s3cr3t")
    client = TestClient(app)
    resp = client.post(
        "/roblox/chat",
        json={"playerId": 1, "playerName": "A", "text": "hi"},
        headers={"x-eliza-secret": "wrong"},
    )
    assert resp.status_code == 401


def test_chat_requires_body_fields() -> None:
    client = TestClient(app)
    resp = client.post("/roblox/chat", json={})
    assert resp.status_code == 422


def test_chat_echo_is_best_effort(monkeypatch) -> None:
    # Ensure echo path doesn't crash even if Roblox isn't configured.
    monkeypatch.setenv("ROBLOX_ECHO_TO_GAME", "true")
    client = TestClient(app)
    resp = client.post(
        "/roblox/chat",
        json={"playerId": 1, "playerName": "A", "text": "hi"},
        headers={"x-eliza-secret": ""},
    )
    assert resp.status_code == 200
    assert "reply" in resp.json()

