"""Offline unit tests for the local eliza-1 VLM bridge (no model load).

Covers llama-mtmd-cli command construction, model/binary resolution, and the
<think>-block-stripping output parser. These run without GPU or any model
weights — they only exercise pure command/string logic.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "vision_harness_runtime",
    Path(__file__).resolve().parent / "vision_harness_runtime.py",
)
assert _SPEC and _SPEC.loader
vhr = importlib.util.module_from_spec(_SPEC)
sys.modules["vision_harness_runtime"] = vhr
_SPEC.loader.exec_module(vhr)


def test_build_mtmd_command_uses_image_vqa_flags() -> None:
    cmd = vhr._build_mtmd_command(
        binary="/bin/llama-mtmd-cli",
        text_model="/m/text.gguf",
        mmproj="/m/mmproj.gguf",
        image_path="/tmp/x.jpg",
        question="What is this?",
        max_tokens=48,
    )
    assert cmd[0] == "/bin/llama-mtmd-cli"
    assert cmd[cmd.index("-m") + 1] == "/m/text.gguf"
    assert cmd[cmd.index("--mmproj") + 1] == "/m/mmproj.gguf"
    assert cmd[cmd.index("--image") + 1] == "/tmp/x.jpg"
    assert cmd[cmd.index("-p") + 1] == "What is this?"
    assert cmd[cmd.index("-n") + 1] == "48"
    # Qwen-VL grounding accuracy requires the 1024 minimum image-token floor.
    assert cmd[cmd.index("--image-min-tokens") + 1] == "1024"


def test_build_mtmd_command_defaults_predict_tokens() -> None:
    cmd = vhr._build_mtmd_command(
        binary="b",
        text_model="t",
        mmproj="mm",
        image_path="i",
        question="q",
        max_tokens=None,
    )
    assert cmd[cmd.index("-n") + 1] == "96"


def test_parse_mtmd_output_strips_think_block() -> None:
    raw = "<think>\nreasoning about the scene\n</think>\nA baseball stadium at night\n"
    assert vhr._parse_mtmd_output(raw) == "A baseball stadium at night"


def test_parse_mtmd_output_strips_bare_think_open_tag() -> None:
    raw = "<think>\n\nA red stop sign"
    assert vhr._parse_mtmd_output(raw) == "A red stop sign"


def test_parse_mtmd_output_passthrough_plain_text() -> None:
    assert vhr._parse_mtmd_output("  7  ") == "7"


def test_resolve_vlm_models_honors_env_overrides(tmp_path, monkeypatch) -> None:
    text = tmp_path / "text.gguf"
    mmproj = tmp_path / "mmproj.gguf"
    text.write_bytes(b"x")
    mmproj.write_bytes(b"y")
    monkeypatch.setenv("LOCAL_ELIZA_VLM_MODEL", str(text))
    monkeypatch.setenv("LOCAL_ELIZA_VLM_MMPROJ", str(mmproj))
    resolved_text, resolved_mmproj = vhr._resolve_vlm_models("eliza-1-2b")
    assert resolved_text == str(text)
    assert resolved_mmproj == str(mmproj)


def test_resolve_vlm_models_resolves_bundle_layout(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("LOCAL_ELIZA_VLM_MODEL", raising=False)
    monkeypatch.delenv("LOCAL_ELIZA_VLM_MMPROJ", raising=False)
    monkeypatch.setenv("ELIZA_STATE_DIR", str(tmp_path))
    bundle = tmp_path / "local-inference" / "models" / "eliza-1-2b.bundle"
    (bundle / "text").mkdir(parents=True)
    (bundle / "vision").mkdir(parents=True)
    text = bundle / "text" / "eliza-1-2b-32k.gguf"
    mmproj = bundle / "vision" / "mmproj-2b.gguf"
    text.write_bytes(b"x")
    mmproj.write_bytes(b"y")
    resolved_text, resolved_mmproj = vhr._resolve_vlm_models("eliza-1-2b")
    assert resolved_text == str(text)
    assert resolved_mmproj == str(mmproj)
