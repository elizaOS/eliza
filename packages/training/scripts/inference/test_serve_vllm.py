"""Tests for the Gemma 4 vLLM launcher command assembly."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.inference import serve_vllm as S  # noqa: E402
from scripts.training.model_registry import get as registry_get  # noqa: E402


def _args(**overrides):
    values = {
        "gpu_target": "single",
        "model": None,
        "quantization": None,
        "kv_cache_dtype": None,
        "max_model_len": None,
        "enable_prefix_caching": True,
        "prefix_block_size": 16,
        "max_num_batched_tokens": 8192,
        "long_prefill_token_threshold": 2048,
        "cudagraph_mode": "FULL_AND_PIECEWISE",
        "compilation_level": 3,
        "eagle3": None,
        "mtp": None,
        "num_speculative_tokens": 0,
        "reasoning_parser": "gemma4",
        "enable_tool_choice": True,
        "tool_call_parser": "gemma4",
        "chat_template": S.DEFAULT_GEMMA4_CHAT_TEMPLATE,
        "attention_backend": None,
        "port": 8000,
        "host": None,
        "served_model_name": None,
        "extra": "",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def test_build_command_uses_gemma4_tooling_defaults() -> None:
    cmd = S.build_command(_args(), entry=registry_get("gemma4-e2b"))

    assert cmd[0:3] == ["vllm", "serve", "google/gemma-4-E2B"]
    assert cmd[cmd.index("--reasoning-parser") + 1] == "gemma4"
    assert cmd[cmd.index("--tool-call-parser") + 1] == "gemma4"
    assert cmd[cmd.index("--chat-template") + 1] == S.DEFAULT_GEMMA4_CHAT_TEMPLATE
    assert "qwen3" not in " ".join(cmd).lower()
    assert "qwen3_coder" not in cmd


def test_build_command_can_use_gemma_mtp_separate_drafter() -> None:
    cmd = S.build_command(
        _args(mtp="elizaos/eliza-1-mtp-4b", num_speculative_tokens=1),
        entry=registry_get("gemma4-e4b"),
    )

    spec = json.loads(cmd[cmd.index("--speculative-config") + 1])
    assert spec == {
        "method": "mtp",
        "model": "elizaos/eliza-1-mtp-4b",
        "num_speculative_tokens": 1,
    }


def test_build_command_can_omit_chat_template_for_model_default() -> None:
    cmd = S.build_command(_args(chat_template=""), entry=registry_get("gemma4-e2b"))

    assert "--chat-template" not in cmd
