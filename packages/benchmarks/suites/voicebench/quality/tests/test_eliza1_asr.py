from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from elizaos_voicebench.adapters import _build_stt
from elizaos_voicebench.clients.eliza1_asr import (
    Eliza1ASRClient,
    build_command,
    parse_asr_output,
)


def test_build_command_audio_flags() -> None:
    cmd = build_command(
        binary=Path("/bin/llama-mtmd-cli"),
        model=Path("/m/asr.gguf"),
        mmproj=Path("/m/mmproj.gguf"),
        audio_path=Path("/tmp/x.wav"),
        prompt="Transcribe the audio.",
        n_predict=256,
    )
    assert cmd[0] == "/bin/llama-mtmd-cli"
    assert cmd[1:5] == ["-m", "/m/asr.gguf", "--mmproj", "/m/mmproj.gguf"]
    assert "--audio" in cmd and "--no-perf" in cmd


def test_parse_asr_output_strips_envelope() -> None:
    assert parse_asr_output("language English<asr_text>Hi.\n\n") == "Hi."


def test_client_transcribes_via_subprocess(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Completed:
        returncode = 0
        stdout = "language English<asr_text>spoken instruction"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Completed())
    client = Eliza1ASRClient(
        binary=Path("/bin/cli"), model=Path("/m/a.gguf"), mmproj=Path("/m/b.gguf")
    )
    text = asyncio.run(client.transcribe(b"RIFFfake"))
    assert text == "spoken instruction"


def test_client_raises_on_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Completed:
        returncode = 0
        stdout = "language English<asr_text>"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Completed())
    client = Eliza1ASRClient(
        binary=Path("/bin/cli"), model=Path("/m/a.gguf"), mmproj=Path("/m/b.gguf")
    )
    with pytest.raises(RuntimeError, match="empty transcript"):
        asyncio.run(client.transcribe(b"x"))


def test_build_stt_supports_eliza1(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Completed:
        returncode = 0
        stdout = "language English<asr_text>ok"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Completed())
    monkeypatch.setenv("ELIZA1_ASR_CLI", "/bin/cli")
    monkeypatch.setenv("ELIZA1_ASR_MODEL", "/m/a.gguf")
    monkeypatch.setenv("ELIZA1_ASR_MMPROJ", "/m/b.gguf")
    fn = _build_stt("eliza1")
    assert asyncio.run(fn(b"RIFF")) == "ok"
