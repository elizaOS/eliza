"""
Tests for the Eliza OSWorld desktop actions.

Tests every desktop action that the agent can invoke, verifying:
1. Correct pyautogui code generation
2. Parameter extraction and validation
3. ActionCollector behavior
4. Edge cases (missing params, type coercion, etc.)
"""
from __future__ import annotations

import asyncio
import json
import sys
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Ensure the OSWorld root is on the path
OSWORLD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if OSWORLD_ROOT not in sys.path:
    sys.path.insert(0, OSWORLD_ROOT)


# ---------------------------------------------------------------------------
# Mock the elizaos imports before importing our modules
# ---------------------------------------------------------------------------

class MockActionResult:
    def __init__(self, success: bool = True, text: str = "", data: dict | None = None, values: dict | None = None):
        self.success = success
        self.text = text
        self.data = data or {}
        self.values = values or {}


class MockActionParameter:
    def __init__(self, name: str = "", description: str = "", required: bool = False, schema: object = None):
        self.name = name
        self.description = description
        self.required = required
        self.schema = schema


class MockActionParameterSchema:
    def __init__(self, type: str = "string", minimum: float = 0.0, maximum: float = 0.0, **kwargs: object):
        self.type = type
        self.minimum = minimum
        self.maximum = maximum


class MockAction:
    def __init__(self, name: str = "", description: str = "", handler=None, validate=None,
                 similes=None, examples=None, priority=None, tags=None, parameters=None):
        self.name = name
        self.description = description
        self.handler = handler
        self.validate = validate
        self.similes = similes
        self.examples = examples
        self.priority = priority
        self.tags = tags
        self.parameters = parameters


class MockProviderResult:
    def __init__(self, text: str = "", values: dict | None = None, data: dict | None = None):
        self.text = text
        self.values = values or {}
        self.data = data or {}


class MockProvider:
    def __init__(self, name: str = "", get=None, description: str | None = None,
                 dynamic: bool | None = None, position: int | None = None, private: bool | None = None):
        self.name = name
        self.get = get
        self.description = description
        self.dynamic = dynamic
        self.position = position
        self.private = private


class MockHandlerOptions:
    def __init__(self, params: str | dict | None = None):
        self.params = params


class MockContent:
    def __init__(self, text: str = "", data: dict | None = None, params: str | None = None,
                 attachments: list | None = None, source: str | None = None):
        self.text = text
        self.data = data
        self.params = params
        self.attachments = attachments
        self.source = source


class MockMemory:
    def __init__(self, content: MockContent | None = None, id: str = "test-id",
                 entity_id: str = "test-entity", agent_id: str = "test-agent",
                 room_id: str = "test-room", created_at: int = 0):
        self.content = content
        self.id = id
        self.entity_id = entity_id
        self.agent_id = agent_id
        self.room_id = room_id
        self.created_at = created_at


# Set up mock modules
mock_components = MagicMock()
mock_components.Action = MockAction
mock_components.ActionParameter = MockActionParameter
mock_components.ActionParameterSchema = MockActionParameterSchema
mock_components.ActionResult = MockActionResult
mock_components.HandlerOptions = MockHandlerOptions
mock_components.ProviderResult = MockProviderResult
mock_components.Provider = MockProvider

mock_memory = MagicMock()
mock_memory.Memory = MockMemory

mock_primitives = MagicMock()
mock_primitives.Content = MockContent

mock_runtime = MagicMock()
mock_state = MagicMock()

# Patch module imports
sys.modules["elizaos"] = MagicMock()
sys.modules["elizaos.types"] = MagicMock()
sys.modules["elizaos.types.components"] = mock_components
sys.modules["elizaos.types.memory"] = mock_memory
sys.modules["elizaos.types.primitives"] = mock_primitives
sys.modules["elizaos.types.runtime"] = mock_runtime
sys.modules["elizaos.types.state"] = mock_state

# Now import our modules
from mm_agents.eliza_desktop_actions import (
    ActionCollector,
    DESKTOP_CLICK,
    DESKTOP_TYPE,
    DESKTOP_HOTKEY,
    DESKTOP_SCROLL,
    DESKTOP_HSCROLL,
    DESKTOP_DRAG,
    DESKTOP_DRAG_TO,
    DESKTOP_MOVE,
    DESKTOP_MOUSE_DOWN,
    DESKTOP_MOUSE_UP,
    DESKTOP_KEY_DOWN,
    DESKTOP_KEY_UP,
    DESKTOP_SLEEP,
    DESKTOP_WAIT,
    DESKTOP_DONE,
    DESKTOP_FAIL,
    ALL_DESKTOP_ACTIONS,
    _extract,
)
from mm_agents.eliza_observation import ObservationStore, OBSERVATION_PROVIDER


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_singletons():
    """Reset shared state before each test."""
    ActionCollector._instance = None
    ObservationStore._instance = None
    yield


def make_message(params: dict[str, object]) -> MockMemory:
    """Create a mock message with params in content.params."""
    return MockMemory(content=MockContent(params=json.dumps(params)))


def make_options(params: dict[str, object]) -> MockHandlerOptions:
    """Create mock handler options with params."""
    return MockHandlerOptions(params=params)


# ---------------------------------------------------------------------------
# ActionCollector Tests
# ---------------------------------------------------------------------------

class TestActionCollector:
    def test_singleton(self):
        a = ActionCollector.get()
        b = ActionCollector.get()
        assert a is b

    def test_add_and_collect(self):
        collector = ActionCollector.get()
        collector.add("pyautogui.click(100, 200)")
        collector.add("pyautogui.press('enter')")
        result = collector.collect()
        assert result == ["pyautogui.click(100, 200)", "pyautogui.press('enter')"]

    def test_collect_clears(self):
        collector = ActionCollector.get()
        collector.add("code1")
        collector.collect()
        assert collector.collect() == []

    def test_done_signal(self):
        collector = ActionCollector.get()
        collector.add("pyautogui.click(100, 200)")
        collector.mark_done()
        result = collector.collect()
        assert result == ["pyautogui.click(100, 200)", "DONE"]

    def test_fail_signal(self):
        collector = ActionCollector.get()
        collector.mark_fail()
        result = collector.collect()
        assert result == ["FAIL"]

    def test_reset(self):
        collector = ActionCollector.get()
        collector.add("code1")
        collector.mark_done()
        collector.reset()
        assert collector.collect() == []
        assert not collector.is_done
        assert not collector.is_fail


# ---------------------------------------------------------------------------
# DESKTOP_CLICK Tests
# ---------------------------------------------------------------------------

class TestDesktopClick:
    def test_basic_click(self):
        msg = make_message({"x": 100, "y": 200})
        result = asyncio.run(DESKTOP_CLICK.handler(None, msg, None, None, None, None))
        assert result.success
        assert "pyautogui.click(100, 200" in result.text
        actions = ActionCollector.get().collect()
        assert len(actions) == 1
        assert "click(100, 200" in actions[0]

    def test_click_with_options(self):
        msg = make_message({})
        opts = make_options({"x": 500, "y": 300, "button": "right", "num_clicks": 2})
        result = asyncio.run(DESKTOP_CLICK.handler(None, msg, None, opts, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "500" in code
        assert "300" in code
        assert "right" in code
        assert "clicks=2" in code

    def test_click_missing_coords(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_CLICK.handler(None, msg, None, None, None, None))
        assert not result.success
        assert "requires x and y" in result.text

    def test_click_float_coords(self):
        msg = make_message({"x": 100.7, "y": 200.3})
        result = asyncio.run(DESKTOP_CLICK.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "100" in code
        assert "200" in code

    def test_click_string_coords(self):
        """Coordinates may come as strings from LLM output."""
        msg = make_message({"x": "960", "y": "540"})
        result = asyncio.run(DESKTOP_CLICK.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "960" in code
        assert "540" in code


# ---------------------------------------------------------------------------
# DESKTOP_TYPE Tests
# ---------------------------------------------------------------------------

class TestDesktopType:
    def test_basic_type(self):
        msg = make_message({"text": "hello world"})
        result = asyncio.run(DESKTOP_TYPE.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.write" in code
        assert "hello world" in code

    def test_type_with_special_chars(self):
        msg = make_message({"text": "it's a test"})
        result = asyncio.run(DESKTOP_TYPE.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.write" in code
        # Single quotes should be escaped
        assert "\\'" in code

    def test_type_missing_text(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_TYPE.handler(None, msg, None, None, None, None))
        assert not result.success


# ---------------------------------------------------------------------------
# DESKTOP_HOTKEY Tests
# ---------------------------------------------------------------------------

class TestDesktopHotkey:
    def test_single_key(self):
        msg = make_message({"keys": "enter"})
        result = asyncio.run(DESKTOP_HOTKEY.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.press('enter')" == code

    def test_key_combo(self):
        msg = make_message({"keys": "ctrl+c"})
        result = asyncio.run(DESKTOP_HOTKEY.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.hotkey('ctrl', 'c')" == code

    def test_three_key_combo(self):
        msg = make_message({"keys": "ctrl+shift+s"})
        result = asyncio.run(DESKTOP_HOTKEY.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.hotkey('ctrl', 'shift', 's')" == code

    def test_space_separated_keys(self):
        msg = make_message({"keys": "alt tab"})
        result = asyncio.run(DESKTOP_HOTKEY.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.hotkey('alt', 'tab')" == code

    def test_missing_keys(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_HOTKEY.handler(None, msg, None, None, None, None))
        assert not result.success


# ---------------------------------------------------------------------------
# DESKTOP_SCROLL Tests
# ---------------------------------------------------------------------------

class TestDesktopScroll:
    def test_scroll_down(self):
        msg = make_message({"direction": "down", "amount": 5})
        result = asyncio.run(DESKTOP_SCROLL.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.scroll(-5)" == code

    def test_scroll_up(self):
        msg = make_message({"direction": "up", "amount": 3})
        result = asyncio.run(DESKTOP_SCROLL.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.scroll(3)" == code

    def test_scroll_at_position(self):
        msg = make_message({"x": 500, "y": 400, "direction": "down", "amount": 2})
        result = asyncio.run(DESKTOP_SCROLL.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "x=500" in code
        assert "y=400" in code
        assert "-2" in code

    def test_scroll_defaults(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_SCROLL.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.scroll(-3)" == code


# ---------------------------------------------------------------------------
# DESKTOP_DRAG Tests
# ---------------------------------------------------------------------------

class TestDesktopDrag:
    def test_basic_drag(self):
        msg = make_message({"start_x": 100, "start_y": 200, "end_x": 500, "end_y": 400})
        result = asyncio.run(DESKTOP_DRAG.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "moveTo(100, 200)" in code
        assert "drag(400, 200" in code  # delta: 500-100, 400-200

    def test_drag_missing_params(self):
        msg = make_message({"start_x": 100, "start_y": 200})
        result = asyncio.run(DESKTOP_DRAG.handler(None, msg, None, None, None, None))
        assert not result.success


# ---------------------------------------------------------------------------
# DESKTOP_MOVE Tests
# ---------------------------------------------------------------------------

class TestDesktopMove:
    def test_move(self):
        msg = make_message({"x": 960, "y": 540})
        result = asyncio.run(DESKTOP_MOVE.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.moveTo(960, 540)" == code

    def test_move_missing_coords(self):
        msg = make_message({"x": 100})
        result = asyncio.run(DESKTOP_MOVE.handler(None, msg, None, None, None, None))
        assert not result.success


# ---------------------------------------------------------------------------
# DESKTOP_WAIT / DONE / FAIL Tests
# ---------------------------------------------------------------------------

class TestDesktopSignals:
    def test_wait(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_WAIT.handler(None, msg, None, None, None, None))
        assert result.success
        assert ActionCollector.get().collect() == ["WAIT"]

    def test_done(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_DONE.handler(None, msg, None, None, None, None))
        assert result.success
        assert ActionCollector.get().is_done
        actions = ActionCollector.get().collect()
        assert "DONE" in actions

    def test_fail(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_FAIL.handler(None, msg, None, None, None, None))
        assert result.success
        assert ActionCollector.get().is_fail
        actions = ActionCollector.get().collect()
        assert "FAIL" in actions


# ---------------------------------------------------------------------------
# ALL_DESKTOP_ACTIONS Tests
# ---------------------------------------------------------------------------

class TestMouseDown:
    def test_mouse_down_default(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_MOUSE_DOWN.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.mouseDown(button='left')" == code

    def test_mouse_down_at_position(self):
        msg = make_message({"x": 500, "y": 300, "button": "right"})
        result = asyncio.run(DESKTOP_MOUSE_DOWN.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "moveTo(500, 300)" in code
        assert "mouseDown(button='right')" in code


class TestMouseUp:
    def test_mouse_up_default(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_MOUSE_UP.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.mouseUp(button='left')" == code

    def test_mouse_up_at_position(self):
        msg = make_message({"x": 800, "y": 600})
        result = asyncio.run(DESKTOP_MOUSE_UP.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "moveTo(800, 600)" in code
        assert "mouseUp" in code


class TestKeyDown:
    def test_key_down(self):
        msg = make_message({"key": "shift"})
        result = asyncio.run(DESKTOP_KEY_DOWN.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.keyDown('shift')" == code

    def test_key_down_missing(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_KEY_DOWN.handler(None, msg, None, None, None, None))
        assert not result.success


class TestKeyUp:
    def test_key_up(self):
        msg = make_message({"key": "ctrl"})
        result = asyncio.run(DESKTOP_KEY_UP.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.keyUp('ctrl')" == code

    def test_key_up_missing(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_KEY_UP.handler(None, msg, None, None, None, None))
        assert not result.success


class TestDragTo:
    def test_drag_to(self):
        msg = make_message({"x": 500, "y": 400})
        result = asyncio.run(DESKTOP_DRAG_TO.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.dragTo(500, 400" in code

    def test_drag_to_missing(self):
        msg = make_message({"x": 500})
        result = asyncio.run(DESKTOP_DRAG_TO.handler(None, msg, None, None, None, None))
        assert not result.success


class TestHScroll:
    def test_hscroll_right(self):
        msg = make_message({"direction": "right", "amount": 5})
        result = asyncio.run(DESKTOP_HSCROLL.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.hscroll(5)" == code

    def test_hscroll_left(self):
        msg = make_message({"direction": "left", "amount": 3})
        result = asyncio.run(DESKTOP_HSCROLL.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "pyautogui.hscroll(-3)" == code


class TestSleep:
    def test_sleep_default(self):
        msg = make_message({})
        result = asyncio.run(DESKTOP_SLEEP.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "time.sleep(1.0)" == code

    def test_sleep_custom(self):
        msg = make_message({"seconds": 2.5})
        result = asyncio.run(DESKTOP_SLEEP.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "time.sleep(2.5)" == code

    def test_sleep_clamped(self):
        """Sleep should be clamped between 0.1 and 10 seconds."""
        msg = make_message({"seconds": 100})
        result = asyncio.run(DESKTOP_SLEEP.handler(None, msg, None, None, None, None))
        assert result.success
        code = ActionCollector.get().collect()[0]
        assert "time.sleep(10.0)" == code


class TestAllActions:
    def test_all_actions_count(self):
        assert len(ALL_DESKTOP_ACTIONS) == 16

    def test_all_actions_have_names(self):
        names = {a.name for a in ALL_DESKTOP_ACTIONS}
        expected = {
            "DESKTOP_CLICK", "DESKTOP_TYPE", "DESKTOP_HOTKEY",
            "DESKTOP_SCROLL", "DESKTOP_HSCROLL", "DESKTOP_DRAG",
            "DESKTOP_DRAG_TO", "DESKTOP_MOVE",
            "DESKTOP_MOUSE_DOWN", "DESKTOP_MOUSE_UP",
            "DESKTOP_KEY_DOWN", "DESKTOP_KEY_UP",
            "DESKTOP_SLEEP",
            "DESKTOP_WAIT", "DESKTOP_DONE", "DESKTOP_FAIL",
        }
        assert names == expected

    def test_all_actions_have_handlers(self):
        for action in ALL_DESKTOP_ACTIONS:
            assert action.handler is not None
            assert action.validate is not None

    def test_all_actions_have_descriptions(self):
        for action in ALL_DESKTOP_ACTIONS:
            assert action.description
            assert len(action.description) > 10

    def test_all_validators_return_true(self):
        """All validators should return True (unconditionally enabled for OSWorld)."""
        msg = make_message({})
        for action in ALL_DESKTOP_ACTIONS:
            result = asyncio.run(action.validate(None, msg, None))
            assert result is True, f"{action.name} validate returned False"


# ---------------------------------------------------------------------------
# ObservationStore Tests
# ---------------------------------------------------------------------------

class TestObservationStore:
    def test_singleton(self):
        a = ObservationStore.get()
        b = ObservationStore.get()
        assert a is b

    def test_set_observation(self):
        store = ObservationStore.get()
        store.set_observation(
            instruction="Click the button",
            accessibility_tree="<tree>data</tree>",
            screenshot_base64="abc123",
            step_number=3,
            max_steps=15,
        )
        assert store.instruction == "Click the button"
        assert store.accessibility_tree == "<tree>data</tree>"
        assert store.screenshot_base64 == "abc123"
        assert store.step_number == 3

    def test_reset(self):
        store = ObservationStore.get()
        store.set_observation(instruction="test", step_number=5)
        store.add_previous_action("click 100 200")
        store.reset()
        assert store.instruction == ""
        assert store.step_number == 0
        assert store.previous_actions == []

    def test_previous_actions(self):
        store = ObservationStore.get()
        store.add_previous_action("click 100 200")
        store.add_previous_action("type hello")
        assert len(store.previous_actions) == 2


# ---------------------------------------------------------------------------
# Observation Provider Tests
# ---------------------------------------------------------------------------

class TestObservationProvider:
    def test_provider_basic(self):
        store = ObservationStore.get()
        store.set_observation(
            instruction="Enable Do Not Track in Chrome",
            accessibility_tree="tag\tname\ttext\nbutton\tSettings\t\"\"",
            step_number=0,
            max_steps=15,
        )
        result = asyncio.run(OBSERVATION_PROVIDER.get(None, None, None))
        assert "Enable Do Not Track" in result.text
        assert "Accessibility Tree" in result.text
        assert "button" in result.text

    def test_provider_with_history(self):
        store = ObservationStore.get()
        store.set_observation(instruction="Test task", step_number=2)
        store.add_previous_action("pyautogui.click(100, 200)")
        store.add_previous_action("pyautogui.press('enter')")
        result = asyncio.run(OBSERVATION_PROVIDER.get(None, None, None))
        assert "Previous Actions" in result.text
        assert "click(100, 200)" in result.text

    def test_provider_metadata(self):
        assert OBSERVATION_PROVIDER.name == "OSWORLD_OBSERVATION"
        assert OBSERVATION_PROVIDER.position == 0
        assert OBSERVATION_PROVIDER.dynamic is True


# ---------------------------------------------------------------------------
# Parameter Extraction Tests
# ---------------------------------------------------------------------------

class TestParamExtraction:
    """Tests parameter extraction from options and message content.

    NOTE: These tests use MockHandlerOptions with a .params dict, which
    tests the fallback .params path in _get_param_from_options. The real
    Eliza runtime passes parameters as a plain dict via the _Opts dynamic
    class (see runtime.py process_actions). The protobuf Struct path is
    tested in the integration_dryrun test with real Eliza runtime.
    """
    def test_extract_from_options(self):
        msg = make_message({"x": 100})
        opts = make_options({"x": 500})
        # Options should take priority
        val = _extract(msg, opts, "x")
        assert val == 500

    def test_extract_from_message(self):
        msg = make_message({"x": 100})
        val = _extract(msg, None, "x")
        assert val == 100

    def test_extract_missing(self):
        msg = make_message({})
        val = _extract(msg, None, "x")
        assert val is None

    def test_extract_default(self):
        msg = make_message({})
        val = _extract(msg, None, "x", 42)
        assert val == 42

    def test_extract_falsy_zero(self):
        """Default of 0 should be returned when key is missing, not None."""
        msg = make_message({})
        val = _extract(msg, None, "x", 0)
        assert val == 0

    def test_extract_falsy_empty_string(self):
        """Default of '' should be returned when key is missing."""
        msg = make_message({})
        val = _extract(msg, None, "x", "")
        assert val == ""
