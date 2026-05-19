"""End-to-end test: client sends `profile.describe`, server returns active profile."""

from __future__ import annotations

import json

import pytest
from websockets.asyncio.client import connect

from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso


@pytest.mark.asyncio
async def test_profile_describe_returns_hiwonder_profile(mock_server: str) -> None:
    """Active profile defaults to hiwonder-ainex and round-trips over the wire."""
    async with connect(mock_server) as ws:
        # Drain initial session.hello + any preliminary telemetry.
        hello = json.loads(await ws.recv())
        assert hello["type"] == "event"
        assert hello["event"] == "session.hello"

        cmd = CommandEnvelope(
            request_id="profile-test-1",
            timestamp=utc_now_iso(),
            command="profile.describe",
            payload={},
        )
        await ws.send(json.dumps(cmd.to_json()))

        # The server may interleave events; pull frames until we see our response.
        response = None
        for _ in range(10):
            frame = json.loads(await ws.recv())
            if frame.get("type") == "response" and frame.get("request_id") == "profile-test-1":
                response = frame
                break
        assert response is not None, "no profile.describe response received"
        assert response["ok"] is True

        profile = response["data"]["profile"]
        assert profile["id"] == "hiwonder-ainex"
        assert profile["kinematics"]["dof"] == 24
        assert len(profile["kinematics"]["joints"]) == 24
        # Asset paths must be JSON-safe strings, not Path objects.
        for key in ("mjcf_xml", "mjx_xml", "urdf", "mesh_dir"):
            assert isinstance(profile["assets"][key], str)


@pytest.mark.asyncio
async def test_profile_describe_rejects_unknown_id(mock_server: str) -> None:
    """A bogus profile id surfaces as ok=false rather than a backend crash."""
    async with connect(mock_server) as ws:
        await ws.recv()  # session.hello

        cmd = CommandEnvelope(
            request_id="profile-test-bad",
            timestamp=utc_now_iso(),
            command="profile.describe",
            payload={"id": "does-not-exist"},
        )
        await ws.send(json.dumps(cmd.to_json()))

        response = None
        for _ in range(10):
            frame = json.loads(await ws.recv())
            if frame.get("type") == "response" and frame.get("request_id") == "profile-test-bad":
                response = frame
                break
        assert response is not None
        assert response["ok"] is False
        assert "profile.describe failed" in response["message"]
