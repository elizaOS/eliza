"""Tests for the Python -> bun subprocess bridge.

These tests do not actually spawn ``bun``. They monkeypatch
``subprocess.run`` so we can assert on the payload the bridge serializes
and the artifact it deserializes, without depending on the TS side being
built or on a real Cerebras key.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any

import pytest

from eliza_compactbench import bridge


def _make_completed(stdout: str, stderr: str = "", returncode: int = 0) -> Any:
    return subprocess.CompletedProcess(
        args=["bun"], returncode=returncode, stdout=stdout.encode("utf-8"), stderr=stderr.encode("utf-8")
    )


def test_bridge_serializes_transcript_and_returns_artifact(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(args: list[str], *, input: bytes, **kwargs: Any) -> Any:
        captured["args"] = args
        captured["payload"] = json.loads(input.decode("utf-8"))
        captured["cwd"] = kwargs.get("cwd")
        artifact = {
            "schemaVersion": "1.0.0",
            "summaryText": "ok",
            "structured_state": {
                "immutable_facts": ["fact a"],
                "locked_decisions": [],
                "deferred_items": [],
                "forbidden_behaviors": [],
                "entity_map": {"alice": "engineer"},
                "unresolved_items": [],
            },
            "selectedSourceTurnIds": [],
            "warnings": [],
            "methodMetadata": {"method": "naive-summary"},
        }
        return _make_completed(json.dumps(artifact))

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")

    transcript = {"turns": [{"id": 0, "role": "user", "content": "hi", "tags": []}]}
    result = bridge.run_ts_compactor(
        "naive-summary", transcript, options={"targetTokens": 500}
    )

    assert captured["args"][0] == "/fake/bun"
    assert captured["args"][1] == "run"
    assert captured["args"][3] == "naive-summary"
    assert captured["payload"]["strategy"] == "naive-summary"
    assert captured["payload"]["transcript"] == transcript
    assert captured["payload"]["options"] == {"targetTokens": 500}
    assert result["summaryText"] == "ok"
    assert result["structured_state"]["immutable_facts"] == ["fact a"]


def test_bridge_raises_on_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(_args: list[str], *, input: bytes, **_kwargs: Any) -> Any:
        return _make_completed("", stderr="ts blew up", returncode=2)

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")

    with pytest.raises(bridge.BridgeError) as excinfo:
        bridge.run_ts_compactor("naive-summary", {"turns": []})
    assert "exited with code 2" in str(excinfo.value)
    assert "ts blew up" in str(excinfo.value)


def test_bridge_raises_on_error_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(_args: list[str], *, input: bytes, **_kwargs: Any) -> Any:
        return _make_completed(json.dumps({"error": "module not found"}))

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")

    with pytest.raises(bridge.BridgeError) as excinfo:
        bridge.run_ts_compactor("hybrid-ledger", {"turns": []})
    assert "module not found" in str(excinfo.value)


def test_bridge_raises_when_bun_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bridge.shutil, "which", lambda _: None)
    with pytest.raises(bridge.BridgeError) as excinfo:
        bridge.run_ts_compactor("naive-summary", {"turns": []})
    assert "bun is not on PATH" in str(excinfo.value)


def test_bridge_raises_on_invalid_json(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(_args: list[str], *, input: bytes, **_kwargs: Any) -> Any:
        return _make_completed("not json at all")

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")

    with pytest.raises(bridge.BridgeError) as excinfo:
        bridge.run_ts_compactor("naive-summary", {"turns": []})
    assert "non-JSON stdout" in str(excinfo.value)


def test_bridge_recovers_error_envelope_on_nonzero_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The TS shim writes its error envelope to stdout and exits 1. Earlier
    versions surfaced only the stderr noise; the bridge should now parse
    the structured ``{"error": ...}`` and surface the real message.
    """

    def fake_run(_args: list[str], *, input: bytes, **_kwargs: Any) -> Any:
        return _make_completed(
            '{"error": "Cerebras chat completion failed (401): bad key"}',
            stderr="bun: warning",
            returncode=1,
        )

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")

    with pytest.raises(bridge.BridgeError) as excinfo:
        bridge.run_ts_compactor("naive-summary", {"turns": []})
    assert "Cerebras chat completion failed (401)" in str(excinfo.value)


def test_bridge_recovers_trailing_json_after_stray_logs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stray ``console.log`` from the TS process or bun startup banner
    must not break artifact parsing — the last balanced JSON object on
    stdout is the result.
    """
    artifact = {
        "schemaVersion": "1.0.0",
        "summaryText": "x",
        "structured_state": {
            "immutable_facts": [],
            "locked_decisions": [],
            "deferred_items": [],
            "forbidden_behaviors": [],
            "entity_map": {},
            "unresolved_items": [],
        },
        "selectedSourceTurnIds": [],
        "warnings": [],
        "methodMetadata": {},
    }
    noisy_stdout = (
        "[bun] resolving dependencies...\n"
        "module imported in 142ms\n"
        f"{json.dumps(artifact)}\n"
    )

    def fake_run(_args: list[str], *, input: bytes, **_kwargs: Any) -> Any:
        return _make_completed(noisy_stdout)

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")

    result = bridge.run_ts_compactor("naive-summary", {"turns": []})
    assert result["summaryText"] == "x"


def test_bridge_serializes_unicode_without_escape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unicode in the transcript must reach the TS side as raw UTF-8, not
    as ``\\u`` escape sequences. The TS JSON.parse handles both, but we
    don't want to bloat large payloads.
    """
    captured: dict[str, Any] = {}

    def fake_run(_args: list[str], *, input: bytes, **_kwargs: Any) -> Any:
        captured["raw"] = input
        return _make_completed(
            json.dumps(
                {
                    "schemaVersion": "1.0.0",
                    "summaryText": "ok",
                    "structured_state": {
                        "immutable_facts": [],
                        "locked_decisions": [],
                        "deferred_items": [],
                        "forbidden_behaviors": [],
                        "entity_map": {},
                        "unresolved_items": [],
                    },
                    "selectedSourceTurnIds": [],
                    "warnings": [],
                    "methodMetadata": {},
                }
            )
        )

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")

    transcript = {"turns": [{"id": 0, "role": "user", "content": "héllo 你好 🌊", "tags": []}]}
    bridge.run_ts_compactor("naive-summary", transcript)

    raw_text = captured["raw"].decode("utf-8")
    assert "héllo" in raw_text
    assert "你好" in raw_text
    assert "🌊" in raw_text
    assert "\\u" not in raw_text


def test_bridge_rejects_nan_in_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    """JS JSON.parse cannot consume NaN/Infinity, so the bridge must
    refuse them at serialization time rather than producing a payload the
    TS side will silently drop or fail on.
    """
    monkeypatch.setattr(bridge.shutil, "which", lambda _: "/fake/bun")
    transcript = {
        "turns": [{"id": 0, "role": "user", "content": "x"}],
        "metadata": {"score": float("nan")},
    }
    with pytest.raises(ValueError):
        bridge.run_ts_compactor("naive-summary", transcript)
