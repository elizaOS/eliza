from __future__ import annotations

import pytest

from elizaos_voiceagentbench.stt import ElizaRuntimeSTT, build_stt
from elizaos_voiceagentbench.types import AudioQuery


def test_eliza_runtime_stt_requires_explicit_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ELIZA_API_BASE", raising=False)
    monkeypatch.delenv("ELIZA_BENCH_URL", raising=False)

    with pytest.raises(RuntimeError, match="ELIZA_API_BASE or ELIZA_BENCH_URL"):
        ElizaRuntimeSTT()


def test_eliza_runtime_stt_refuses_missing_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ELIZA_API_BASE", "http://127.0.0.1:31337")
    stt = ElizaRuntimeSTT()

    with pytest.raises(RuntimeError, match="missing audio bytes"):
        stt.transcribe(AudioQuery(audio_bytes=None, transcript="ground truth"))


def test_eliza_runtime_stt_posts_real_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    class _Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"text": "transcribed speech"}

    class _Client:
        def __init__(self, *, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> "_Client":
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def post(self, url: str, *, files: dict[str, object], data: dict[str, str]) -> _Response:
            calls.append({"url": url, "files": files, "data": data})
            return _Response()

    import httpx

    monkeypatch.setattr(httpx, "Client", _Client)
    monkeypatch.setenv("ELIZA_API_BASE", "http://127.0.0.1:31337")

    stt = build_stt(provider="eliza-runtime")
    text = stt.transcribe(AudioQuery(audio_bytes=b"RIFF", transcript="ground truth", language="en"))

    assert text == "transcribed speech"
    assert calls
    assert calls[0]["url"] == "http://127.0.0.1:31337/v1/audio/transcriptions"
    assert calls[0]["data"] == {
        "model": "whisper-large-v3-turbo",
        "language": "en",
        "response_format": "json",
    }
