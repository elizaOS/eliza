"""
Dry-run integration test for the Eliza OSWorld agent.

This test validates the FULL pipeline end-to-end without a real VM:
1. Agent initialization (Eliza runtime, actions, providers)
2. Observation injection (screenshot + a11y tree)
3. Message creation and handle_message call
4. LLM response (via Groq API - REAL API call)
5. Action parsing and pyautogui code generation
6. ActionCollector output

This proves the agent can take observations, route through
message_service.handle_message(), and produce executable pyautogui code.

Requires: GROQ_API_KEY environment variable set.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
import uuid

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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("test.integration")


# ---------------------------------------------------------------------------
# Sample observation data (simulating what a VM would return)
# ---------------------------------------------------------------------------

SAMPLE_INSTRUCTION = "Enable the 'Do Not Track' feature in Chrome to enhance my online privacy."

# Minimal a11y tree mimicking Chrome settings
SAMPLE_A11Y_TREE = """tag\tname\ttext\tclass\tdescription\tposition (top-left x&y)\tsize (w&h)
frame\tSettings - Privacy and security\t""\t\t\t(0, 0)\t(1920, 1080)
panel\tSettings\t""\t\t\t(0, 0)\t(1920, 1080)
list\t\t""\t\t\t(300, 100)\t(1200, 900)
list item\tThird-party cookies\t""\t\t\t(350, 200)\t(800, 50)
link\tThird-party cookies\t""\t\tBlock third-party cookies\t(350, 200)\t(200, 30)
list item\tAd privacy\t""\t\t\t(350, 260)\t(800, 50)
link\tAd privacy\t""\t\t\t(350, 260)\t(200, 30)
list item\tSecurity\t""\t\t\t(350, 320)\t(800, 50)
link\tSecurity\t""\t\t\t(350, 320)\t(200, 30)
toggle button\tSend a "Do Not Track" request\t"Off"\t\tToggle to enable Do Not Track\t(1100, 580)\t(50, 30)
static text\tSend a "Do Not Track" request with your browsing traffic\t""\t\t\t(400, 575)\t(600, 30)
"""

# A tiny 1x1 red PNG for screenshot (not a real screenshot, just to test the pipeline)
SAMPLE_SCREENSHOT_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58hHgAH+AL/hY2qNAAAAABJRU5ErkJggg=="
)


def test_full_pipeline_dryrun():
    """
    Full dry-run integration test:
    1. Create ElizaOSWorldAgent
    2. Initialize it (creates Eliza runtime)
    3. Call predict() with mock observations
    4. Verify actions were generated
    """
    groq_key = os.environ.get("GROQ_API_KEY")
    if not groq_key:
        import pytest
        pytest.skip("GROQ_API_KEY not set -- cannot run real LLM integration test")

    from mm_agents.eliza_agent import ElizaOSWorldAgent
    from mm_agents.eliza_desktop_actions import ActionCollector
    from mm_agents.eliza_observation import ObservationStore

    # ---- 1. Create agent ----
    logger.info("Creating ElizaOSWorldAgent...")
    agent = ElizaOSWorldAgent(
        model="qwen/qwen3-32b",
        observation_type="screenshot_a11y_tree",
        action_space="pyautogui",
        max_steps=15,
        groq_api_key=groq_key,
    )

    # ---- 2. Initialize (creates Eliza runtime) ----
    logger.info("Initializing agent (Eliza runtime)...")
    asyncio.run(agent.async_init())
    logger.info("Agent initialized successfully!")

    # ---- 3. Reset for new task ----
    agent.reset(vm_ip="127.0.0.1")
    logger.info("Agent reset for new task")

    # ---- 4. Build mock observation (like DesktopEnv._get_obs()) ----
    obs = {
        "screenshot": SAMPLE_SCREENSHOT_BYTES,
        "accessibility_tree": SAMPLE_A11Y_TREE,
    }

    # ---- 5. Call predict() ----
    logger.info("Calling predict() with mock observation...")
    logger.info("Instruction: %s", SAMPLE_INSTRUCTION)

    response, actions = agent.predict(SAMPLE_INSTRUCTION, obs)

    # ---- 6. Verify results ----
    logger.info("=" * 60)
    logger.info("RESULTS")
    logger.info("=" * 60)
    logger.info("Response (first 500 chars): %s", response[:500] if response else "EMPTY")
    logger.info("Actions: %s", actions)
    logger.info("Step index: %d", agent.step_idx)
    logger.info("Thoughts recorded: %d", len(agent.thoughts))
    logger.info("Actions recorded: %d", len(agent.actions))

    # Assertions
    assert response, "Response should not be empty"
    assert actions, "Actions should not be empty"
    assert len(actions) >= 1, "Should have at least one action"
    assert agent.step_idx == 1, "Step index should be 1 after first predict"

    # Check that actions are valid pyautogui code or signals
    valid_signals = {"WAIT", "DONE", "FAIL"}
    for action in actions:
        is_signal = action in valid_signals
        is_pyautogui = "pyautogui" in action or "time.sleep" in action
        assert is_signal or is_pyautogui, (
            f"Action should be pyautogui code or signal, got: {action}"
        )

    logger.info("=" * 60)
    logger.info("DRY-RUN TEST PASSED!")
    logger.info("The Eliza agent successfully:")
    logger.info("  1. Initialized Eliza runtime with desktop actions")
    logger.info("  2. Received mock observation (screenshot + a11y tree)")
    logger.info("  3. Routed through message_service.handle_message()")
    logger.info("  4. Called Groq/Qwen3 LLM for decision")
    logger.info("  5. Generated valid pyautogui action code")
    logger.info("=" * 60)

    # ---- 7. Test a second step (to verify history works) ----
    logger.info("Testing second predict() call (with history)...")
    response2, actions2 = agent.predict(SAMPLE_INSTRUCTION, obs)
    logger.info("Step 2 response: %s", response2[:300] if response2 else "EMPTY")
    logger.info("Step 2 actions: %s", actions2)
    assert agent.step_idx == 2
    logger.info("Second step also passed!")

    print("\n" + "=" * 60)
    print("ALL DRY-RUN INTEGRATION TESTS PASSED")
    print("=" * 60)


if __name__ == "__main__":
    test_full_pipeline_dryrun()
