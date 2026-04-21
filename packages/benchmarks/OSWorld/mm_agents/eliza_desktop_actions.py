"""
Desktop actions for the Eliza OSWorld agent.

These actions map to OSWorld's pyautogui and computer_13 action spaces.
Each action handler generates pyautogui code (or a computer_13 dict) that
OSWorld's DesktopEnv.step() can execute on the VM.

The generated code is stored in a shared ActionCollector so the agent adapter
can retrieve it after message_service.handle_message() returns.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
from typing import TYPE_CHECKING

# Ensure protobuf generated modules are importable
_generated_dir = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "eliza", "packages", "python",
    "elizaos", "types", "generated",
)
_generated_dir = os.path.normpath(_generated_dir)
if os.path.isdir(_generated_dir) and _generated_dir not in sys.path:
    sys.path.insert(0, _generated_dir)

from elizaos.types.components import (
    Action,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    HandlerOptions,
    ProviderResult,
)

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

logger = logging.getLogger("osworld.eliza.actions")


# ---------------------------------------------------------------------------
# ActionCollector -- thread-safe store for generated pyautogui commands
# ---------------------------------------------------------------------------


class ActionCollector:
    """Collects pyautogui code strings during a single handle_message call."""

    _instance: ActionCollector | None = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._actions: list[str] = []
        self._done: bool = False
        self._fail: bool = False

    @classmethod
    def get(cls) -> ActionCollector:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = ActionCollector()
        return cls._instance

    def add(self, code: str) -> None:
        self._actions.append(code)

    def mark_done(self) -> None:
        self._done = True

    def mark_fail(self) -> None:
        self._fail = True

    @property
    def is_done(self) -> bool:
        return self._done

    @property
    def is_fail(self) -> bool:
        return self._fail

    def collect(self) -> list[str]:
        """Return collected actions and reset for next step."""
        result = list(self._actions)
        if self._done:
            result.append("DONE")
        elif self._fail:
            result.append("FAIL")
        self._actions.clear()
        self._done = False
        self._fail = False
        return result

    def reset(self) -> None:
        self._actions.clear()
        self._done = False
        self._fail = False


# ---------------------------------------------------------------------------
# Helper: extract param from LLM-parsed params (in message content)
# ---------------------------------------------------------------------------

_SENTINEL = object()  # Used to distinguish "not found" from falsy values like 0


def _get_param(message: Memory, key: str, default: object = None) -> object:
    """Extract a parameter from the message content's data or params."""
    try:
        if message.content and message.content.data:
            struct_dict = dict(message.content.data)
            if key in struct_dict:
                return struct_dict[key]
    except (AttributeError, TypeError):
        pass
    try:
        if message.content and hasattr(message.content, "params") and message.content.params:
            params = json.loads(message.content.params)
            if key in params:
                return params[key]
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass
    return default


def _get_param_from_options(
    options: object | None, key: str, default: object = _SENTINEL
) -> object:
    """Extract a parameter from HandlerOptions / options object."""
    if options is None:
        return default
    # Try options.parameters (protobuf Struct or dict-like)
    if hasattr(options, "parameters") and options.parameters is not None:
        try:
            params = options.parameters
            if hasattr(params, "get"):
                val = params.get(key)
                if val is not None:
                    return val
            elif hasattr(params, "__getitem__"):
                if key in params:
                    return params[key]
            # Protobuf Struct access
            if hasattr(params, "fields") and key in params.fields:
                field = params.fields[key]
                # Extract value from protobuf Value
                kind = field.WhichOneof("kind") if hasattr(field, "WhichOneof") else None
                if kind == "number_value":
                    return field.number_value
                elif kind == "string_value":
                    return field.string_value
                elif kind == "bool_value":
                    return field.bool_value
                return default
        except (TypeError, AttributeError, KeyError):
            pass
    # Fallback: try .params
    if hasattr(options, "params") and options.params is not None:
        try:
            if isinstance(options.params, str):
                params = json.loads(options.params)
            else:
                params = dict(options.params)
            return params.get(key, default)
        except (json.JSONDecodeError, TypeError, AttributeError):
            pass
    return default


def _extract(
    message: Memory, options: object | None, key: str, default: object = None
) -> object:
    """Try options first, then message. Uses sentinel to distinguish 'not found' from falsy values."""
    val = _get_param_from_options(options, key, _SENTINEL)
    if val is not _SENTINEL:
        return val
    return _get_param(message, key, default)


# ---------------------------------------------------------------------------
# Action: DESKTOP_CLICK -- click at screen coordinates
# ---------------------------------------------------------------------------

async def _desktop_click_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    x = _extract(message, options, "x")
    y = _extract(message, options, "y")
    button = _extract(message, options, "button", "left")
    num_clicks = _extract(message, options, "num_clicks", 1)

    if x is None or y is None:
        return ActionResult(
            success=False,
            text="DESKTOP_CLICK requires x and y coordinates",
        )

    try:
        x, y = int(float(str(x))), int(float(str(y)))
    except (ValueError, TypeError):
        return ActionResult(
            success=False,
            text="DESKTOP_CLICK: invalid coordinates",
        )
    try:
        num_clicks = int(float(str(num_clicks))) if num_clicks and str(num_clicks).strip() else 1
    except (ValueError, TypeError):
        num_clicks = 1
    button = str(button).strip() if button and str(button).strip() else "left"

    if num_clicks == 1:
        code = f"pyautogui.click({x}, {y}, button='{button}')"
    else:
        code = f"pyautogui.click({x}, {y}, clicks={num_clicks}, button='{button}')"

    logger.info("DESKTOP_CLICK: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_click_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_CLICK = Action(
    name="DESKTOP_CLICK",
    description=(
        "Click at a specific screen coordinate. Use this to click buttons, links, "
        "icons, or any UI element at a precise (x, y) position on the screen."
    ),
    handler=_desktop_click_handler,
    validate=_desktop_click_validate,
    similes=["CLICK", "CLICK_AT", "MOUSE_CLICK", "TAP"],
    parameters=[
        ActionParameter(
            name="x",
            description="X coordinate to click at (0-1920)",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=3840.0),
        ),
        ActionParameter(
            name="y",
            description="Y coordinate to click at (0-1080)",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=2160.0),
        ),
        ActionParameter(
            name="button",
            description="Mouse button: 'left', 'right', or 'middle'. Default: 'left'",
            required=False,
            schema=ActionParameterSchema(type="string"),
        ),
        ActionParameter(
            name="num_clicks",
            description="Number of clicks (1 for single, 2 for double). Default: 1",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=1.0, maximum=3.0),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_TYPE -- type text using keyboard
# ---------------------------------------------------------------------------

async def _desktop_type_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    text = _extract(message, options, "text")
    if text is None:
        return ActionResult(success=False, text="DESKTOP_TYPE requires 'text' parameter")

    text_str = str(text)
    # Escape for Python string
    escaped = text_str.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    code = f"pyautogui.write('{escaped}', interval=0.02)"

    logger.info("DESKTOP_TYPE: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_type_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_TYPE = Action(
    name="DESKTOP_TYPE",
    description=(
        "Type text using the keyboard. Use this to enter text into text fields, "
        "search bars, address bars, editors, or any focused input element. "
        "The text is typed character by character."
    ),
    handler=_desktop_type_handler,
    validate=_desktop_type_validate,
    similes=["TYPE_TEXT", "ENTER_TEXT", "KEYBOARD_TYPE", "WRITE_TEXT"],
    parameters=[
        ActionParameter(
            name="text",
            description="The text to type",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_HOTKEY -- press key combination
# ---------------------------------------------------------------------------

async def _desktop_hotkey_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    keys = _extract(message, options, "keys")
    if keys is None:
        return ActionResult(
            success=False, text="DESKTOP_HOTKEY requires 'keys' parameter"
        )

    keys_str = str(keys).strip()
    # Accept formats: "ctrl+c", "ctrl c", "ctrl, c", "enter", "Return"
    parts = [
        k.strip().lower()
        for k in keys_str.replace("+", " ").replace(",", " ").split()
        if k.strip()
    ]

    if len(parts) == 1:
        code = f"pyautogui.press('{parts[0]}')"
    else:
        args = ", ".join(f"'{k}'" for k in parts)
        code = f"pyautogui.hotkey({args})"

    logger.info("DESKTOP_HOTKEY: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_hotkey_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_HOTKEY = Action(
    name="DESKTOP_HOTKEY",
    description=(
        "Press a keyboard key or key combination. Use this for shortcuts (ctrl+c, ctrl+v, "
        "alt+tab), Enter/Return, Tab, Escape, arrow keys, F-keys, etc. "
        "Format keys as 'ctrl+c' or 'enter'."
    ),
    handler=_desktop_hotkey_handler,
    validate=_desktop_hotkey_validate,
    similes=["PRESS_KEY", "KEY_PRESS", "HOTKEY", "KEYBOARD_SHORTCUT"],
    parameters=[
        ActionParameter(
            name="keys",
            description=(
                "Key or key combination to press. Examples: 'enter', 'ctrl+c', "
                "'alt+tab', 'ctrl+shift+s', 'backspace', 'tab', 'escape', 'F5'"
            ),
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_SCROLL -- scroll at position
# ---------------------------------------------------------------------------

async def _desktop_scroll_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    x = _extract(message, options, "x")
    y = _extract(message, options, "y")
    direction = _extract(message, options, "direction", "down")
    amount = _extract(message, options, "amount", 3)

    direction_str = str(direction).strip().lower() if direction and str(direction).strip() else "down"
    try:
        amount_int = int(float(str(amount))) if amount and str(amount).strip() else 3
    except (ValueError, TypeError):
        amount_int = 3
    # pyautogui.scroll: positive = up, negative = down
    scroll_amount = amount_int if direction_str == "up" else -amount_int

    if x is not None and y is not None:
        code = f"pyautogui.scroll({scroll_amount}, x={int(float(str(x)))}, y={int(float(str(y)))})"
    else:
        code = f"pyautogui.scroll({scroll_amount})"

    logger.info("DESKTOP_SCROLL: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_scroll_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_SCROLL = Action(
    name="DESKTOP_SCROLL",
    description=(
        "Scroll the mouse wheel at the current position or a specific coordinate. "
        "Use direction 'up' or 'down' and amount for number of scroll clicks."
    ),
    handler=_desktop_scroll_handler,
    validate=_desktop_scroll_validate,
    similes=["SCROLL", "SCROLL_UP", "SCROLL_DOWN", "MOUSE_SCROLL"],
    parameters=[
        ActionParameter(
            name="x",
            description="X coordinate to scroll at (optional, uses current position if omitted)",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="y",
            description="Y coordinate to scroll at (optional, uses current position if omitted)",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="direction",
            description="Scroll direction: 'up' or 'down'. Default: 'down'",
            required=False,
            schema=ActionParameterSchema(type="string"),
        ),
        ActionParameter(
            name="amount",
            description="Number of scroll clicks. Default: 3",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_DRAG -- drag from one position to another
# ---------------------------------------------------------------------------

async def _desktop_drag_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    start_x = _extract(message, options, "start_x")
    start_y = _extract(message, options, "start_y")
    end_x = _extract(message, options, "end_x")
    end_y = _extract(message, options, "end_y")

    if any(v is None for v in [start_x, start_y, end_x, end_y]):
        return ActionResult(
            success=False,
            text="DESKTOP_DRAG requires start_x, start_y, end_x, end_y",
        )

    try:
        sx = int(float(str(start_x)))
        sy = int(float(str(start_y)))
        ex = int(float(str(end_x)))
        ey = int(float(str(end_y)))
    except (ValueError, TypeError):
        return ActionResult(
            success=False,
            text="DESKTOP_DRAG: invalid coordinate values",
        )
    code = (
        f"pyautogui.moveTo({sx}, {sy}); "
        f"time.sleep(0.3); "
        f"pyautogui.drag({ex - sx}, {ey - sy}, duration=0.5)"
    )

    logger.info("DESKTOP_DRAG: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_drag_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_DRAG = Action(
    name="DESKTOP_DRAG",
    description=(
        "Drag the mouse from one position to another. Use this for drag-and-drop, "
        "resizing windows, selecting text by dragging, moving sliders, etc."
    ),
    handler=_desktop_drag_handler,
    validate=_desktop_drag_validate,
    similes=["DRAG", "DRAG_AND_DROP", "MOUSE_DRAG"],
    parameters=[
        ActionParameter(
            name="start_x",
            description="Starting X coordinate",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="start_y",
            description="Starting Y coordinate",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="end_x",
            description="Ending X coordinate",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="end_y",
            description="Ending Y coordinate",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_MOVE -- move mouse cursor
# ---------------------------------------------------------------------------

async def _desktop_move_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    x = _extract(message, options, "x")
    y = _extract(message, options, "y")

    if x is None or y is None:
        return ActionResult(
            success=False, text="DESKTOP_MOVE requires x and y coordinates"
        )

    code = f"pyautogui.moveTo({int(float(str(x)))}, {int(float(str(y)))})"
    logger.info("DESKTOP_MOVE: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_move_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_MOVE = Action(
    name="DESKTOP_MOVE",
    description="Move the mouse cursor to a specific screen coordinate.",
    handler=_desktop_move_handler,
    validate=_desktop_move_validate,
    similes=["MOVE_TO", "MOVE_MOUSE", "CURSOR_MOVE"],
    parameters=[
        ActionParameter(
            name="x",
            description="X coordinate to move to",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="y",
            description="Y coordinate to move to",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_WAIT -- wait / do nothing this step
# ---------------------------------------------------------------------------

async def _desktop_wait_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    logger.info("DESKTOP_WAIT")
    ActionCollector.get().add("WAIT")
    return ActionResult(success=True, text="WAIT")


async def _desktop_wait_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_WAIT = Action(
    name="DESKTOP_WAIT",
    description=(
        "Wait and do nothing this step. Use when the application is loading, "
        "a dialog is appearing, or you need to wait for an operation to complete."
    ),
    handler=_desktop_wait_handler,
    validate=_desktop_wait_validate,
    similes=["WAIT", "PAUSE", "SLEEP"],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_DONE -- signal task completion
# ---------------------------------------------------------------------------

async def _desktop_done_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    logger.info("DESKTOP_DONE")
    ActionCollector.get().mark_done()
    return ActionResult(success=True, text="DONE")


async def _desktop_done_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_DONE = Action(
    name="DESKTOP_DONE",
    description=(
        "Signal that the task is complete. Use this ONLY when you have verified "
        "the task has been successfully completed."
    ),
    handler=_desktop_done_handler,
    validate=_desktop_done_validate,
    similes=["DONE", "TASK_COMPLETE", "FINISH"],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_FAIL -- signal task failure
# ---------------------------------------------------------------------------

async def _desktop_fail_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    logger.info("DESKTOP_FAIL")
    ActionCollector.get().mark_fail()
    return ActionResult(success=True, text="FAIL")


async def _desktop_fail_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_FAIL = Action(
    name="DESKTOP_FAIL",
    description=(
        "Signal that the task cannot be completed. Use this only as a last resort "
        "when you are certain the task is impossible."
    ),
    handler=_desktop_fail_handler,
    validate=_desktop_fail_validate,
    similes=["FAIL", "TASK_FAILED", "GIVE_UP"],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_MOUSE_DOWN -- press mouse button without releasing
# ---------------------------------------------------------------------------

async def _desktop_mouse_down_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    x = _extract(message, options, "x")
    y = _extract(message, options, "y")
    button = _extract(message, options, "button", "left")
    button = str(button).strip() if button and str(button).strip() else "left"

    parts = []
    if x is not None and y is not None:
        parts.append(f"pyautogui.moveTo({int(float(str(x)))}, {int(float(str(y)))})")
    parts.append(f"pyautogui.mouseDown(button='{button}')")
    code = "; ".join(parts)

    logger.info("DESKTOP_MOUSE_DOWN: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_mouse_down_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_MOUSE_DOWN = Action(
    name="DESKTOP_MOUSE_DOWN",
    description=(
        "Press and hold a mouse button without releasing it. "
        "Use this to start a drag operation, or to hold the mouse button "
        "while performing other actions. Follow with DESKTOP_MOUSE_UP to release."
    ),
    handler=_desktop_mouse_down_handler,
    validate=_desktop_mouse_down_validate,
    similes=["MOUSE_DOWN", "PRESS_MOUSE", "HOLD_CLICK"],
    parameters=[
        ActionParameter(
            name="x",
            description="X coordinate to move to before pressing (optional)",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="y",
            description="Y coordinate to move to before pressing (optional)",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="button",
            description="Mouse button: 'left', 'right', or 'middle'. Default: 'left'",
            required=False,
            schema=ActionParameterSchema(type="string"),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_MOUSE_UP -- release a held mouse button
# ---------------------------------------------------------------------------

async def _desktop_mouse_up_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    x = _extract(message, options, "x")
    y = _extract(message, options, "y")
    button = _extract(message, options, "button", "left")
    button = str(button).strip() if button and str(button).strip() else "left"

    parts = []
    if x is not None and y is not None:
        parts.append(f"pyautogui.moveTo({int(float(str(x)))}, {int(float(str(y)))})")
    parts.append(f"pyautogui.mouseUp(button='{button}')")
    code = "; ".join(parts)

    logger.info("DESKTOP_MOUSE_UP: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_mouse_up_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_MOUSE_UP = Action(
    name="DESKTOP_MOUSE_UP",
    description=(
        "Release a held mouse button. Use after DESKTOP_MOUSE_DOWN to complete "
        "a drag operation or release a held button."
    ),
    handler=_desktop_mouse_up_handler,
    validate=_desktop_mouse_up_validate,
    similes=["MOUSE_UP", "RELEASE_MOUSE", "RELEASE_CLICK"],
    parameters=[
        ActionParameter(
            name="x",
            description="X coordinate to move to before releasing (optional)",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="y",
            description="Y coordinate to move to before releasing (optional)",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="button",
            description="Mouse button: 'left', 'right', or 'middle'. Default: 'left'",
            required=False,
            schema=ActionParameterSchema(type="string"),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_KEY_DOWN -- hold a keyboard key down
# ---------------------------------------------------------------------------

async def _desktop_key_down_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    key = _extract(message, options, "key")
    if key is None:
        return ActionResult(success=False, text="DESKTOP_KEY_DOWN requires 'key' parameter")

    key_str = str(key).strip().lower()
    code = f"pyautogui.keyDown('{key_str}')"

    logger.info("DESKTOP_KEY_DOWN: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_key_down_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_KEY_DOWN = Action(
    name="DESKTOP_KEY_DOWN",
    description=(
        "Press and hold a keyboard key without releasing it. "
        "Use for modifier keys (shift, ctrl, alt) while performing other actions "
        "like clicking. Follow with DESKTOP_KEY_UP to release the key."
    ),
    handler=_desktop_key_down_handler,
    validate=_desktop_key_down_validate,
    similes=["KEY_DOWN", "HOLD_KEY", "PRESS_AND_HOLD"],
    parameters=[
        ActionParameter(
            name="key",
            description="Key to hold down. Examples: 'shift', 'ctrl', 'alt', 'command'",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_KEY_UP -- release a held keyboard key
# ---------------------------------------------------------------------------

async def _desktop_key_up_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    key = _extract(message, options, "key")
    if key is None:
        return ActionResult(success=False, text="DESKTOP_KEY_UP requires 'key' parameter")

    key_str = str(key).strip().lower()
    code = f"pyautogui.keyUp('{key_str}')"

    logger.info("DESKTOP_KEY_UP: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_key_up_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_KEY_UP = Action(
    name="DESKTOP_KEY_UP",
    description=(
        "Release a held keyboard key. Use after DESKTOP_KEY_DOWN to release "
        "a modifier key (shift, ctrl, alt)."
    ),
    handler=_desktop_key_up_handler,
    validate=_desktop_key_up_validate,
    similes=["KEY_UP", "RELEASE_KEY"],
    parameters=[
        ActionParameter(
            name="key",
            description="Key to release. Examples: 'shift', 'ctrl', 'alt', 'command'",
            required=True,
            schema=ActionParameterSchema(type="string"),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_DRAG_TO -- drag to absolute coordinates
# ---------------------------------------------------------------------------

async def _desktop_drag_to_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    x = _extract(message, options, "x")
    y = _extract(message, options, "y")
    duration = _extract(message, options, "duration", 0.5)

    if x is None or y is None:
        return ActionResult(
            success=False, text="DESKTOP_DRAG_TO requires x and y coordinates"
        )

    try:
        xi, yi = int(float(str(x))), int(float(str(y)))
        dur = float(str(duration)) if duration else 0.5
    except (ValueError, TypeError):
        return ActionResult(success=False, text="DESKTOP_DRAG_TO: invalid values")

    code = f"pyautogui.dragTo({xi}, {yi}, duration={dur})"

    logger.info("DESKTOP_DRAG_TO: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_drag_to_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_DRAG_TO = Action(
    name="DESKTOP_DRAG_TO",
    description=(
        "Drag the mouse to an absolute screen position. The mouse button is held "
        "down during movement. Use for dragging objects to a specific location."
    ),
    handler=_desktop_drag_to_handler,
    validate=_desktop_drag_to_validate,
    similes=["DRAG_TO", "DRAG_ABSOLUTE"],
    parameters=[
        ActionParameter(
            name="x",
            description="Target X coordinate to drag to",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="y",
            description="Target Y coordinate to drag to",
            required=True,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
        ActionParameter(
            name="duration",
            description="Duration of drag in seconds. Default: 0.5",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_HSCROLL -- horizontal scroll
# ---------------------------------------------------------------------------

async def _desktop_hscroll_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    amount = _extract(message, options, "amount", 3)
    direction = _extract(message, options, "direction", "right")

    direction_str = str(direction).strip().lower() if direction and str(direction).strip() else "right"
    try:
        amount_int = int(float(str(amount))) if amount and str(amount).strip() else 3
    except (ValueError, TypeError):
        amount_int = 3

    scroll_val = amount_int if direction_str == "right" else -amount_int
    code = f"pyautogui.hscroll({scroll_val})"

    logger.info("DESKTOP_HSCROLL: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_hscroll_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_HSCROLL = Action(
    name="DESKTOP_HSCROLL",
    description=(
        "Scroll horizontally (left or right). Use for wide content that extends "
        "beyond the visible area, like spreadsheets or timelines."
    ),
    handler=_desktop_hscroll_handler,
    validate=_desktop_hscroll_validate,
    similes=["HSCROLL", "HORIZONTAL_SCROLL", "SCROLL_LEFT", "SCROLL_RIGHT"],
    parameters=[
        ActionParameter(
            name="direction",
            description="Scroll direction: 'left' or 'right'. Default: 'right'",
            required=False,
            schema=ActionParameterSchema(type="string"),
        ),
        ActionParameter(
            name="amount",
            description="Number of scroll clicks. Default: 3",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Action: DESKTOP_SLEEP -- explicit delay
# ---------------------------------------------------------------------------

async def _desktop_sleep_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: object = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    seconds = _extract(message, options, "seconds", 1.0)

    try:
        secs = float(str(seconds)) if seconds and str(seconds).strip() else 1.0
    except (ValueError, TypeError):
        secs = 1.0

    secs = max(0.1, min(secs, 10.0))  # Clamp between 0.1 and 10 seconds
    code = f"time.sleep({secs})"

    logger.info("DESKTOP_SLEEP: %s", code)
    ActionCollector.get().add(code)
    return ActionResult(success=True, text=code)


async def _desktop_sleep_validate(
    runtime: IAgentRuntime, message: Memory, state: State | None
) -> bool:
    return True


DESKTOP_SLEEP = Action(
    name="DESKTOP_SLEEP",
    description=(
        "Wait for a specific number of seconds. Use when an application needs time "
        "to load, a dialog needs to appear, or an animation needs to complete. "
        "Different from DESKTOP_WAIT which just signals waiting -- this actually "
        "inserts a timed delay."
    ),
    handler=_desktop_sleep_handler,
    validate=_desktop_sleep_validate,
    similes=["SLEEP", "DELAY", "TIMED_WAIT"],
    parameters=[
        ActionParameter(
            name="seconds",
            description="Number of seconds to wait (0.1 to 10). Default: 1.0",
            required=False,
            schema=ActionParameterSchema(type="number", minimum=0.0, maximum=9999.0),
        ),
    ],
)


# ---------------------------------------------------------------------------
# All actions exported for the plugin
# ---------------------------------------------------------------------------

ALL_DESKTOP_ACTIONS: list[Action] = [
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
]
