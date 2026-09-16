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


@pytest.mark.parametrize("failure", ["convert", "quantize", "smoke"])
def test_failed_artifact_replacement_cannot_retain_a_passed_sidecar(tmp_path, failure):
    import hashlib
    import json
    import subprocess
    from scripts.quantization.gguf_k_quant import QuantProfile, run_quant_profile, write_sidecar

    converter = tmp_path / "convert.py"
    converter.write_text("import sys\nfrom pathlib import Path\nPath(sys.argv[sys.argv.index('--outfile')+1]).write_bytes(b'f16')\n")
    quantizer = executable(tmp_path / "llama-quantize", "import sys\nfrom pathlib import Path\nPath(sys.argv[-2]).write_bytes(b'first artifact')")
    completion = executable(tmp_path / "llama-completion", "print('Paris.')")
    output = tmp_path / "output"
    profile = QuantProfile(level="Q4_K_M", sidecar_name="gguf_q4_k_m.json", notes="fixture")

    def run():
        return run_quant_profile(profile, ["--model", "fixture", "--output", str(output)],
            find_convert_script=lambda _: converter, find_quantize_binary=lambda _: quantizer, write_sidecar=write_sidecar)

    assert run() == 0
    sidecar = output / profile.sidecar_name
    receipt = json.loads(sidecar.read_text())
    artifact = Path(receipt["output_file"])
    first_hash = hashlib.sha256(artifact.read_bytes()).hexdigest()
    if failure == "convert":
        converter.write_text("raise SystemExit(2)\n")
    elif failure == "quantize":
        executable(quantizer, "raise SystemExit(2)")
    else:
        executable(quantizer, "import sys\nfrom pathlib import Path\nPath(sys.argv[-2]).write_bytes(b'replacement artifact')")
        executable(completion, "raise SystemExit(2)")
    if failure == "smoke":
        assert run() == 2
        assert artifact.read_bytes() == b"replacement artifact"
    else:
        with pytest.raises(subprocess.CalledProcessError):
            run()
    assert not sidecar.exists(), "failed replacement must not leave earlier release eligibility"
    assert receipt["recipe_test"]["artifact_sha256"] == first_hash


def test_smoke_retains_complete_generated_output(tmp_path):
    generated = "完整输出 🟠 " * 400
    executable(tmp_path / "llama-completion", f"print({generated!r})")
    result = smoke_load_gguf(tmp_path / "model.gguf", tmp_path / "llama-quantize")
    assert result["ok"] is True
    assert result["output"] == generated.strip()
