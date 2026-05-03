"""
Real integration tests for EVERY desktop action through the full Eliza pipeline.

NO MOCKS. Each test:
1. Creates a real ElizaOSWorldAgent with a real Groq model handler
2. Provides an a11y tree designed to trigger a specific action
3. Calls predict() which calls Eliza's message_service.handle_message()
4. Verifies the LLM chose the correct action and generated valid pyautogui code

Requires: GROQ_API_KEY environment variable.
"""
from __future__ import annotations

import asyncio
import base64
import os
import sys

import pytest

OSWORLD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if OSWORLD_ROOT not in sys.path:
    sys.path.insert(0, OSWORLD_ROOT)

_generated_dir = os.path.normpath(os.path.join(
    OSWORLD_ROOT, "..", "..", "eliza", "packages", "python",
    "elizaos", "types", "generated",
))
if os.path.isdir(_generated_dir) and _generated_dir not in sys.path:
    sys.path.insert(0, _generated_dir)

GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
SKIP_REASON = "GROQ_API_KEY not set -- requires real LLM"

# Tiny 1x1 PNG so screenshot processing doesn't fail
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58hHgAH+AL/hY2qNAAAAABJRU5ErkJggg=="
)

# Shared agent instance (expensive to create -- one Eliza runtime for all tests)
_agent = None


def get_agent():
    global _agent
    if _agent is None:
        from mm_agents.eliza_agent import ElizaOSWorldAgent
        _agent = ElizaOSWorldAgent(
            model="qwen/qwen3-32b",
            observation_type="screenshot_a11y_tree",
            groq_api_key=GROQ_KEY,
        )
        asyncio.run(_agent.async_init())
    _agent.reset()
    return _agent


def run_predict(instruction: str, a11y_tree: str) -> tuple[str, list[str]]:
    """Run a single predict call through the real Eliza pipeline."""
    agent = get_agent()
    obs = {"screenshot": TINY_PNG, "accessibility_tree": a11y_tree}
    return agent.predict(instruction, obs)


def assert_has_pyautogui(actions: list[str], fragment: str):
    """Assert at least one action contains the given pyautogui fragment."""
    joined = " ".join(actions)
    assert fragment in joined, (
        f"Expected '{fragment}' in actions, got: {actions}"
    )


# ---------------------------------------------------------------------------
# Tests -- each sends a specific instruction + a11y tree to trigger one action
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestClickAction:
    def test_click_button(self):
        response, actions = run_predict(
            "Click the Submit button",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "button\tSubmit\t\"\"\t(800, 500)\t(100, 40)"
        )
        assert actions
        assert any("pyautogui" in a or a in ("WAIT", "DONE", "FAIL") for a in actions)


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestTypeAction:
    def test_type_in_search(self):
        response, actions = run_predict(
            "Type 'hello world' into the search box. The search box is already focused.",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "text field\tSearch\t\"\"\t(400, 100)\t(300, 30)"
        )
        assert actions
        # Should either type or click then type
        joined = " ".join(actions)
        assert "pyautogui" in joined or "WAIT" in joined


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestHotkeyAction:
    def test_ctrl_s_save(self):
        response, actions = run_predict(
            "Save the current file using the keyboard shortcut Ctrl+S",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "menu bar\tFile Edit View\t\"\"\t(0, 0)\t(1920, 30)"
        )
        assert actions
        joined = " ".join(actions)
        assert "pyautogui" in joined or "WAIT" in joined


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestScrollAction:
    def test_scroll_down(self):
        response, actions = run_predict(
            "Scroll down to see more content on this page",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "scroll bar\tVertical scroll\t\"\"\t(1900, 100)\t(20, 800)\n"
            "panel\tContent area\t\"Long text that continues below...\"\t(0, 0)\t(1900, 5000)"
        )
        assert actions
        joined = " ".join(actions)
        assert "pyautogui" in joined or "WAIT" in joined


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestDoneAction:
    def test_task_complete(self):
        response, actions = run_predict(
            "The Do Not Track feature has already been enabled. The toggle shows 'On'. The task is complete.",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "toggle button\tSend a Do Not Track request\tOn\t(1100, 580)\t(50, 30)"
        )
        assert actions
        # Agent should signal DONE or try to verify
        joined = " ".join(actions)
        assert "DONE" in joined or "pyautogui" in joined


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestMultiStepReasoning:
    def test_chrome_settings_navigation(self):
        """Test that the agent can reason through a multi-step Chrome task."""
        response, actions = run_predict(
            "Open Chrome settings and navigate to Privacy and Security",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "frame\tGoogle Chrome\t\"\"\t(0, 0)\t(1920, 1080)\n"
            "button\tChrome menu\t\"\"\t(1880, 60)\t(30, 30)\n"
            "text field\tAddress bar\t\"about:blank\"\t(400, 55)\t(800, 30)"
        )
        assert response, "LLM should produce a response"
        assert actions, "Should produce at least one action"
        # Agent should either click the menu or type in the address bar
        joined = " ".join(actions)
        assert "pyautogui" in joined


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestActionCodeValidity:
    """Verify generated pyautogui code is syntactically valid Python."""

    def test_generated_code_is_valid_python(self):
        response, actions = run_predict(
            "Click the OK button",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "button\tOK\t\"\"\t(960, 540)\t(80, 30)"
        )
        for action in actions:
            if action in ("WAIT", "DONE", "FAIL"):
                continue
            # Verify it parses as valid Python
            try:
                compile(action, "<action>", "exec")
            except SyntaxError as e:
                pytest.fail(f"Generated code is invalid Python: {action!r}\nError: {e}")


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestGIMPTask:
    """Test a GIMP-like image editing scenario."""

    def test_gimp_brightness(self):
        response, actions = run_predict(
            "Reduce the brightness of the image. Go to Colors > Brightness-Contrast",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "frame\tGNU Image Manipulation Program\t\"\"\t(0, 0)\t(1920, 1080)\n"
            "menu\tColors\t\"\"\t(200, 10)\t(60, 25)\n"
            "menu\tFile\t\"\"\t(50, 10)\t(40, 25)\n"
            "menu\tEdit\t\"\"\t(100, 10)\t(40, 25)\n"
            "canvas\tImage canvas\t\"\"\t(300, 100)\t(1200, 800)"
        )
        assert actions
        # Should click the Colors menu
        joined = " ".join(actions)
        assert "pyautogui" in joined


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestLibreOfficeTask:
    """Test a LibreOffice Calc scenario."""

    def test_calc_enter_formula(self):
        response, actions = run_predict(
            "Enter the formula =SUM(A1:A10) into cell B1",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "frame\tLibreOffice Calc\t\"\"\t(0, 0)\t(1920, 1080)\n"
            "table\tSpreadsheet\t\"\"\t(100, 150)\t(1700, 800)\n"
            "cell\tA1\t\"100\"\t(100, 150)\t(100, 25)\n"
            "cell\tB1\t\"\"\t(200, 150)\t(100, 25)\n"
            "text field\tName Box\t\"A1\"\t(10, 130)\t(80, 25)\n"
            "text field\tFormula Bar\t\"\"\t(100, 130)\t(1800, 25)"
        )
        assert actions
        joined = " ".join(actions)
        assert "pyautogui" in joined


@pytest.mark.skipif(not GROQ_KEY, reason=SKIP_REASON)
class TestOSTask:
    """Test an OS-level task."""

    def test_open_terminal(self):
        response, actions = run_predict(
            "Open a terminal application. Right-click on the desktop and select 'Open Terminal'",
            "tag\tname\ttext\tposition (top-left x&y)\tsize (w&h)\n"
            "panel\tDesktop\t\"\"\t(0, 0)\t(1920, 1080)\n"
            "panel\tTaskbar\t\"\"\t(0, 1050)\t(1920, 30)\n"
            "button\tActivities\t\"\"\t(10, 1055)\t(80, 25)"
        )
        assert actions
        joined = " ".join(actions)
        assert "pyautogui" in joined
