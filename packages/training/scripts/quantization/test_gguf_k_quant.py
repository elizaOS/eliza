"""Exercises quantization smoke verification through real subprocess boundaries.

Small executable fixtures emulate the external completion tool while the shared
smoke runner performs its real discovery, stdin, output, and failure handling.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from scripts.quantization.gguf_k_quant import smoke_load_gguf


def executable(path: Path, body: str) -> Path:
    path.write_text(f"#!{sys.executable}\n{body}\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def test_smoke_uses_noninteractive_completion_and_only_generated_output(tmp_path):
    executable(tmp_path / "llama-cli", "raise SystemExit('conversation-only tool')")
    executable(
        tmp_path / "llama-completion",
        "import sys\n"
        "assert '-no-cnv' in sys.argv\n"
        "assert '--no-display-prompt' in sys.argv\n"
        "assert sys.stdin.read() == ''\n"
        "print('Paris.')",
    )

    result = smoke_load_gguf(tmp_path / "model.gguf", tmp_path / "llama-quantize")

    assert result["ok"] is True
    assert result["output"] == "Paris."


def test_smoke_finds_completion_on_path(tmp_path, monkeypatch):
    tools = tmp_path / "tools"
    tools.mkdir()
    executable(tools / "llama-completion", "print('Paris.')")
    monkeypatch.setenv("PATH", str(tools))

    result = smoke_load_gguf(tmp_path / "model.gguf", tmp_path / "llama-quantize")

    assert result["ok"] is True
    assert result["output"] == "Paris."


def test_smoke_rejects_conversation_tool_without_completion(tmp_path, monkeypatch):
    executable(tmp_path / "llama-cli", "print('a chat banner is not generation')")
    monkeypatch.setenv("PATH", str(tmp_path))

    result = smoke_load_gguf(tmp_path / "model.gguf", tmp_path / "llama-quantize")

    assert result["ok"] is False
    assert "llama-completion not found" in result["error"]


@pytest.mark.parametrize(
    "body",
    ["raise SystemExit(0)", "print('partial output'); raise SystemExit(2)"],
)
def test_smoke_rejects_empty_or_failed_generation(tmp_path, body):
    executable(tmp_path / "llama-completion", body)

    result = smoke_load_gguf(tmp_path / "model.gguf", tmp_path / "llama-quantize")

    assert result["ok"] is False
