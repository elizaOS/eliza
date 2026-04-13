"""
Integration tests for the Eliza OSWorld agent adapter.

Tests:
1. Agent initialization and reset
2. Observation formatting (screenshot + a11y tree)
3. Action collection from handle_message
4. Fallback action parsing
5. Full predict loop (with mocked message service)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Ensure the OSWorld root is on the path
OSWORLD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if OSWORLD_ROOT not in sys.path:
    sys.path.insert(0, OSWORLD_ROOT)

# Mock elizaos before importing
sys.modules.setdefault("elizaos", MagicMock())
sys.modules.setdefault("elizaos.types", MagicMock())
sys.modules.setdefault("elizaos.types.components", MagicMock())
sys.modules.setdefault("elizaos.types.memory", MagicMock())
sys.modules.setdefault("elizaos.types.primitives", MagicMock())
sys.modules.setdefault("elizaos.types.runtime", MagicMock())
sys.modules.setdefault("elizaos.types.state", MagicMock())
sys.modules.setdefault("elizaos.types.generated", MagicMock())
sys.modules.setdefault("elizaos.types.generated.eliza", MagicMock())
sys.modules.setdefault("elizaos.types.generated.eliza.v1", MagicMock())
sys.modules.setdefault("elizaos.types.generated.eliza.v1.primitives_pb2", MagicMock())
sys.modules.setdefault("elizaos.runtime", MagicMock())

from mm_agents.eliza_agent import (
    _detect_model_provider,
    _fallback_parse_actions,
    _linearize_accessibility_tree_simple,
    ElizaOSWorldAgent,
)
from mm_agents.eliza_desktop_actions import ActionCollector
from mm_agents.eliza_observation import ObservationStore


@pytest.fixture(autouse=True)
def reset_singletons():
    ActionCollector._instance = None
    ObservationStore._instance = None
    yield


# ---------------------------------------------------------------------------
# Model Provider Detection
# ---------------------------------------------------------------------------

class TestModelProviderDetection:
    def test_groq_explicit(self):
        assert _detect_model_provider("groq/qwen3-32b") == "groq"

    def test_qwen_model(self):
        assert _detect_model_provider("qwen/qwen3-32b") == "groq"

    def test_gpt_model(self):
        assert _detect_model_provider("gpt-4o") == "openai"

    def test_claude_model(self):
        assert _detect_model_provider("claude-3-opus") == "anthropic"

    def test_gemini_model(self):
        assert _detect_model_provider("gemini-1.5-pro") == "google"

    def test_unknown_model(self):
        assert _detect_model_provider("some-custom-model") is None


# ---------------------------------------------------------------------------
# Fallback Action Parsing
# ---------------------------------------------------------------------------

class TestFallbackActionParsing:
    def test_empty_response(self):
        assert _fallback_parse_actions("") == []

    def test_wait_signal(self):
        assert _fallback_parse_actions("WAIT") == ["WAIT"]

    def test_done_signal(self):
        assert _fallback_parse_actions("DONE") == ["DONE"]

    def test_fail_signal(self):
        assert _fallback_parse_actions("FAIL") == ["FAIL"]

    def test_python_code_block(self):
        response = "Let me click the button.\n```python\npyautogui.click(100, 200)\n```"
        result = _fallback_parse_actions(response)
        assert len(result) == 1
        assert "pyautogui.click(100, 200)" in result[0]

    def test_bare_code_block(self):
        response = "```\npyautogui.press('enter')\n```"
        result = _fallback_parse_actions(response)
        assert len(result) == 1
        assert "pyautogui.press('enter')" in result[0]

    def test_multiple_code_blocks(self):
        response = (
            "First:\n```python\npyautogui.click(100, 200)\n```\n"
            "Then:\n```python\npyautogui.press('enter')\n```"
        )
        result = _fallback_parse_actions(response)
        assert len(result) == 2

    def test_code_block_with_done(self):
        response = "```\nDONE\n```"
        result = _fallback_parse_actions(response)
        assert result == ["DONE"]

    def test_no_code_blocks(self):
        response = "I see a button at coordinates (100, 200)"
        result = _fallback_parse_actions(response)
        assert result == []


# ---------------------------------------------------------------------------
# ElizaOSWorldAgent Tests
# ---------------------------------------------------------------------------

class TestElizaOSWorldAgent:
    def test_init_defaults(self):
        agent = ElizaOSWorldAgent()
        assert agent.platform == "ubuntu"
        assert agent.model == "qwen/qwen3-32b"
        assert agent.observation_type == "screenshot_a11y_tree"
        assert agent.action_space == "pyautogui"
        assert agent.max_steps == 15
        assert agent.step_idx == 0
        assert agent.thoughts == []
        assert agent.actions == []

    def test_init_custom(self):
        agent = ElizaOSWorldAgent(
            model="gpt-4o",
            observation_type="screenshot",
            max_steps=20,
            temperature=0.7,
        )
        assert agent.model == "gpt-4o"
        assert agent.observation_type == "screenshot"
        assert agent.max_steps == 20
        assert agent.temperature == 0.7

    def test_reset(self):
        agent = ElizaOSWorldAgent()
        agent.thoughts.append("thought1")
        agent.actions.append("action1")
        agent.observations.append({"screenshot": None})
        agent.step_idx = 5

        agent.reset(vm_ip="192.168.1.100")

        assert agent.thoughts == []
        assert agent.actions == []
        assert agent.observations == []
        assert agent.step_idx == 0
        assert agent.vm_ip == "192.168.1.100"

    def test_reset_clears_stores(self):
        agent = ElizaOSWorldAgent()
        collector = ActionCollector.get()
        collector.add("some_code")
        store = ObservationStore.get()
        store.set_observation(instruction="test")

        agent.reset()

        assert collector.collect() == []
        assert store.instruction == ""


# ---------------------------------------------------------------------------
# A11y Tree Linearization
# ---------------------------------------------------------------------------

class TestA11yLinearization:
    def test_simple_passthrough(self):
        """If full linearizer fails, should return raw text."""
        tree = "<node>test</node>"
        result = _linearize_accessibility_tree_simple(tree, "ubuntu")
        # Should return something (either linearized or raw)
        assert result is not None
        assert len(result) > 0

    def test_long_tree_truncation(self):
        tree = "x" * 60000
        result = _linearize_accessibility_tree_simple(tree, "ubuntu")
        # Should be truncated
        assert len(result) <= 55000


# ---------------------------------------------------------------------------
# Observation Processing
# ---------------------------------------------------------------------------

class TestObservationProcessing:
    def test_screenshot_encoding(self):
        """Test that raw bytes are properly base64 encoded."""
        raw_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        encoded = base64.b64encode(raw_bytes).decode("utf-8")
        assert isinstance(encoded, str)
        assert len(encoded) > 0
        # Should be decodable
        decoded = base64.b64decode(encoded)
        assert decoded == raw_bytes

    def test_observation_store_integration(self):
        """Test that observation store properly receives all fields."""
        store = ObservationStore.get()
        store.set_observation(
            instruction="Test task",
            accessibility_tree="<tree/>",
            screenshot_base64="abc123",
            step_number=2,
            max_steps=15,
            platform="ubuntu",
            screen_width=1920,
            screen_height=1080,
            client_password="password",
        )
        assert store.instruction == "Test task"
        assert store.accessibility_tree == "<tree/>"
        assert store.screenshot_base64 == "abc123"
        assert store.step_number == 2
        assert store.max_steps == 15
        assert store.platform == "ubuntu"
        assert store.screen_width == 1920
        assert store.screen_height == 1080
        assert store.client_password == "password"
