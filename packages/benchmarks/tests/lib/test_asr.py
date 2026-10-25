from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from benchmarks.lib import asr as eliza1_asr
from benchmarks.lib.asr import (
    Eliza1ASR as Eliza1ASRBackend,
    build_command,
    parse_asr_output,
)


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


def test_async_asr_does_not_block_event_loop(monkeypatch):
    import asyncio
    import sys

    monkeypatch.setattr(
        eliza1_asr,
        "build_command",
        lambda **kw: [
            sys.executable,
            "-c",
            'import time; time.sleep(0.1); print("<asr_text>spoken</asr_text>")',
        ],
    )
    backend = Eliza1ASRBackend()

    async def run():
        task = asyncio.create_task(backend.transcribe(b"RIFF"))
        await asyncio.sleep(0.01)
        assert not task.done()
        assert await task == "spoken"

    asyncio.run(run())


@pytest.mark.parametrize("cancel", [False, True])
def test_async_asr_reaps_child_and_removes_audio(tmp_path, monkeypatch, cancel):
    import asyncio
    import json
    import os
    import sys

    marker = tmp_path / "started.json"
    code = (
        "import json,os,sys,time; from pathlib import Path; "
        f"Path({str(marker)!r}).write_text(json.dumps([os.getpid(),sys.argv[1]])); "
        "time.sleep(60)"
    )
    monkeypatch.setattr(
        eliza1_asr,
        "build_command",
        lambda **kw: [sys.executable, "-c", code, str(kw["audio_path"])],
    )
    backend = Eliza1ASRBackend(timeout=3 if not cancel else 30)

    async def run():
        task = asyncio.create_task(backend.transcribe(b"RIFF"))
        try:
            for _ in range(1000):
                if marker.exists() or task.done():
                    break
                await asyncio.sleep(0.01)
            assert marker.exists()
            if cancel:
                task.cancel()
            with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
                await task
        finally:
            if not task.done():
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task

    asyncio.run(run())
    pid, audio = json.loads(marker.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert not Path(audio).exists()
