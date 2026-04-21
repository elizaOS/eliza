"""
End-to-end mock test for the Eliza OSWorld agent.

This test verifies the full pipeline WITHOUT a real VM:
1. Agent initialization with real Eliza runtime
2. Observation injection via provider
3. Message service handle_message call (with real Groq LLM)
4. Action generation and pyautogui code collection
5. Correct output format for OSWorld's env.step()

Set GROQ_API_KEY to run with real LLM, otherwise skips.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import logging

import pytest

# Ensure paths
OSWORLD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if OSWORLD_ROOT not in sys.path:
    sys.path.insert(0, OSWORLD_ROOT)

_generated_dir = os.path.normpath(os.path.join(
    OSWORLD_ROOT, "..", "..", "eliza", "packages", "python",
    "elizaos", "types", "generated",
))
if os.path.isdir(_generated_dir) and _generated_dir not in sys.path:
    sys.path.insert(0, _generated_dir)

logging.basicConfig(level=logging.INFO)


GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
SKIP_REASON = "GROQ_API_KEY not set" if not GROQ_API_KEY else ""

# A minimal fake a11y tree for testing
FAKE_A11Y_TREE = """tag\tname\ttext\tclass\tdescription\tposition (top-left x&y)\tsize (w&h)
frame\tChrome - Settings\t""\t\t\t(0, 0)\t(1920, 1080)
push-button\tSettings\t""\tGtkButton\tOpen settings\t(100, 50)\t(80, 30)
push-button\tPrivacy and security\t""\tGtkButton\tPrivacy settings\t(150, 200)\t(200, 30)
toggle-button\tSend a Do Not Track request\t"off"\tGtkToggleButton\tDo Not Track toggle\t(800, 400)\t(50, 25)
push-button\tConfirm\t""\tGtkButton\tConfirm setting\t(850, 500)\t(100, 35)
"""


@pytest.mark.skipif(not GROQ_API_KEY, reason=SKIP_REASON)
class TestElizaE2EMock:
    """End-to-end test with mock observations but real LLM."""

    def test_agent_init_and_predict(self):
        """Test full agent init -> predict pipeline."""
        from mm_agents.eliza_agent import ElizaOSWorldAgent
        from mm_agents.eliza_desktop_actions import ActionCollector

        agent = ElizaOSWorldAgent(
            model="qwen/qwen3-32b",
            observation_type="a11y_tree",  # Text only, no screenshot
            max_steps=5,
            groq_api_key=GROQ_API_KEY,
        )

        # Init
        asyncio.run(agent.async_init())
        assert agent._initialized

        # Build a mock observation (text-only a11y tree)
        obs = {
            "accessibility_tree": FAKE_A11Y_TREE,
        }

        # Predict
        instruction = "Enable the 'Do Not Track' feature in Chrome settings."
        response, actions = agent.predict(instruction, obs)

        print(f"\n{'='*60}")
        print(f"INSTRUCTION: {instruction}")
        print(f"RESPONSE: {response[:500]}")
        print(f"ACTIONS: {actions}")
        print(f"{'='*60}")

        # Verify we got a response
        assert response is not None
        assert len(response) > 0

        # Verify we got actions
        assert actions is not None
        assert len(actions) > 0

        # Verify actions are in valid format
        for action in actions:
            assert isinstance(action, str)
            # Each action should be pyautogui code, WAIT, DONE, or FAIL
            valid = (
                "pyautogui" in action
                or action in ("WAIT", "DONE", "FAIL")
            )
            assert valid, f"Invalid action format: {action}"

        # Verify step tracking
        assert agent.step_idx == 1
        assert len(agent.thoughts) == 1
        assert len(agent.actions) == 1

    def test_agent_multi_step(self):
        """Test agent can do multiple predict steps."""
        from mm_agents.eliza_agent import ElizaOSWorldAgent

        agent = ElizaOSWorldAgent(
            model="qwen/qwen3-32b",
            observation_type="a11y_tree",
            max_steps=5,
            groq_api_key=GROQ_API_KEY,
        )

        asyncio.run(agent.async_init())

        obs = {"accessibility_tree": FAKE_A11Y_TREE}
        instruction = "Click the 'Privacy and security' button."

        # Step 1
        response1, actions1 = agent.predict(instruction, obs)
        assert agent.step_idx == 1

        # Step 2 (simulating updated observation after action)
        response2, actions2 = agent.predict(instruction, obs)
        assert agent.step_idx == 2

        # History should accumulate
        assert len(agent.thoughts) == 2
        assert len(agent.actions) == 2

    def test_agent_reset_between_tasks(self):
        """Test that reset clears state for a new task."""
        from mm_agents.eliza_agent import ElizaOSWorldAgent

        agent = ElizaOSWorldAgent(
            model="qwen/qwen3-32b",
            observation_type="a11y_tree",
            max_steps=5,
            groq_api_key=GROQ_API_KEY,
        )

        asyncio.run(agent.async_init())

        obs = {"accessibility_tree": FAKE_A11Y_TREE}
        agent.predict("Click the button.", obs)
        assert agent.step_idx == 1

        # Reset
        agent.reset(vm_ip="192.168.1.1")
        assert agent.step_idx == 0
        assert agent.thoughts == []
        assert agent.vm_ip == "192.168.1.1"

        # Should work again after reset
        agent.predict("Click the other button.", obs)
        assert agent.step_idx == 1


if __name__ == "__main__":
    # Run directly for quick testing
    if not GROQ_API_KEY:
        print("Set GROQ_API_KEY to run this test")
        sys.exit(1)

    test = TestElizaE2EMock()
    print("Running test_agent_init_and_predict...")
    test.test_agent_init_and_predict()
    print("PASSED!")

    print("\nRunning test_agent_multi_step...")
    test.test_agent_multi_step()
    print("PASSED!")

    print("\nRunning test_agent_reset_between_tasks...")
    test.test_agent_reset_between_tasks()
    print("PASSED!")

    print("\nAll E2E tests passed!")
