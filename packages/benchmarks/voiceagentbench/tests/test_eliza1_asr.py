from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from elizaos_voiceagentbench import eliza1_asr
from elizaos_voiceagentbench.eliza1_asr import (
    Eliza1ASRBackend,
    build_command,
    parse_asr_output,
)
from elizaos_voiceagentbench.stt import build_stt
from elizaos_voiceagentbench.types import AudioQuery


def test_build_command_uses_mtmd_audio_flags() -> None:
    cmd = build_command(
        binary=Path("/bin/llama-mtmd-cli"),
        model=Path("/m/asr.gguf"),
        mmproj=Path("/m/asr-mmproj.gguf"),
        audio_path=Path("/tmp/x.wav"),
        prompt="Transcribe the audio.",
        n_predict=256,
    )
    assert cmd == [
        "/bin/llama-mtmd-cli",
        "-m",
        "/m/asr.gguf",
        "--mmproj",
        "/m/asr-mmproj.gguf",
        "--audio",
        "/tmp/x.wav",
        "-p",
        "Transcribe the audio.",
        "-n",
        "256",
        "--no-perf",
    ]


@pytest.mark.parametrize(
    "stdout,expected",
    [
        ("\nlanguage English<asr_text>Hello world.\n\n\n", "Hello world."),
        ("language English<asr_text>Set a timer</asr_text>", "Set a timer"),
        ("<asr_text>Just text</asr_text>", "Just text"),
        ("no envelope at all", "no envelope at all"),
    ],
)
def test_parse_asr_output(stdout: str, expected: str) -> None:
    assert parse_asr_output(stdout) == expected


def test_backend_refuses_missing_audio() -> None:
    backend = Eliza1ASRBackend(
        binary=Path("/bin/llama-mtmd-cli"),
        model=Path("/m/asr.gguf"),
        mmproj=Path("/m/asr-mmproj.gguf"),
    )
    with pytest.raises(RuntimeError, match="audio bytes are required"):
        backend.transcribe_bytes(None)  # type: ignore[arg-type]


def test_backend_parses_subprocess_output(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class _Completed:
        returncode = 0
        stdout = "\nlanguage English<asr_text>What is the capital of France?\n\n"
        stderr = ""

    def _fake_run(cmd, **kwargs):  # type: ignore[no-untyped-def]
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env")
        return _Completed()

    monkeypatch.setattr(subprocess, "run", _fake_run)
    backend = Eliza1ASRBackend(
        binary=Path("/opt/bin/llama-mtmd-cli"),
        model=Path("/m/asr.gguf"),
        mmproj=Path("/m/asr-mmproj.gguf"),
    )
    text = backend.transcribe_bytes(b"RIFFfake")
    assert text == "What is the capital of France?"
    cmd = captured["cmd"]
    assert "--audio" in cmd and "--mmproj" in cmd
    assert cmd[0] == "/opt/bin/llama-mtmd-cli"
    env = captured["env"]
    assert isinstance(env, dict)
    assert env["DYLD_LIBRARY_PATH"].startswith("/opt/bin")


def test_backend_raises_on_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Completed:
        returncode = 1
        stdout = ""
        stderr = "model load failed"

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Completed())
    backend = Eliza1ASRBackend(
        binary=Path("/bin/cli"), model=Path("/m/a.gguf"), mmproj=Path("/m/b.gguf")
    )
    with pytest.raises(RuntimeError, match="model load failed"):
        backend.transcribe_bytes(b"x")


def test_build_stt_selects_eliza1(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Completed:
        returncode = 0
        stdout = "language English<asr_text>hi there"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Completed())
    monkeypatch.setattr(eliza1_asr, "resolve_binary", lambda: Path("/bin/cli"))
    monkeypatch.setattr(eliza1_asr, "resolve_model", lambda: Path("/m/a.gguf"))
    monkeypatch.setattr(eliza1_asr, "resolve_mmproj", lambda: Path("/m/b.gguf"))

    stt = build_stt(provider="eliza1")
    text = stt.transcribe(AudioQuery(audio_bytes=b"RIFF", transcript="gt", language="en"))
    assert text == "hi there"
