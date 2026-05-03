"""
Observation provider for the Eliza OSWorld agent.

Injects the current VM observation (accessibility tree, screenshot metadata,
task instruction) into the Eliza state so the LLM can make informed decisions.

The observation is set externally by the agent adapter before each
handle_message call.
"""
from __future__ import annotations

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

from elizaos.types.components import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

logger = logging.getLogger("osworld.eliza.observation")


class ObservationStore:
    """Thread-safe store for current VM observation state.

    The agent adapter sets the observation before each handle_message call.
    The provider reads it during compose_state.
    """

    _instance: ObservationStore | None = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self.instruction: str = ""
        self.accessibility_tree: str | None = None
        self.screenshot_base64: str | None = None
        self.step_number: int = 0
        self.max_steps: int = 15
        self.previous_actions: list[str] = []
        self.previous_thoughts: list[str] = []
        self.platform: str = "ubuntu"
        self.screen_width: int = 1920
        self.screen_height: int = 1080
        self.client_password: str = "password"

    @classmethod
    def get(cls) -> ObservationStore:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = ObservationStore()
        return cls._instance

    def set_observation(
        self,
        instruction: str,
        accessibility_tree: str | None = None,
        screenshot_base64: str | None = None,
        step_number: int = 0,
        max_steps: int = 15,
        platform: str = "ubuntu",
        screen_width: int = 1920,
        screen_height: int = 1080,
        client_password: str = "password",
    ) -> None:
        self.instruction = instruction
        self.accessibility_tree = accessibility_tree
        self.screenshot_base64 = screenshot_base64
        self.step_number = step_number
        self.max_steps = max_steps
        self.platform = platform
        self.screen_width = screen_width
        self.screen_height = screen_height
        self.client_password = client_password

    def add_previous_action(self, action: str) -> None:
        self.previous_actions.append(action)

    def add_previous_thought(self, thought: str) -> None:
        self.previous_thoughts.append(thought)

    def reset(self) -> None:
        self.instruction = ""
        self.accessibility_tree = None
        self.screenshot_base64 = None
        self.step_number = 0
        self.previous_actions.clear()
        self.previous_thoughts.clear()


async def _observation_provider_get(
    runtime: IAgentRuntime, message: Memory, state: State
) -> ProviderResult:
    """Provide current VM observation to the agent's context."""
    store = ObservationStore.get()

    parts: list[str] = []

    parts.append(f"## Desktop Automation Task")
    parts.append(f"**Instruction:** {store.instruction}")
    parts.append(f"**Platform:** {store.platform}")
    parts.append(f"**Screen resolution:** {store.screen_width}x{store.screen_height}")
    parts.append(f"**Step:** {store.step_number + 1} / {store.max_steps}")
    parts.append(f"**Computer password:** {store.client_password}")
    parts.append("")

    if store.accessibility_tree:
        # Trim if very long (keep under ~10k tokens)
        a11y = store.accessibility_tree
        if len(a11y) > 40000:
            a11y = a11y[:40000] + "\n[... truncated ...]"
        parts.append("## Current Accessibility Tree")
        parts.append("```")
        parts.append(a11y)
        parts.append("```")
        parts.append("")

    if store.previous_actions:
        parts.append("## Previous Actions (most recent last)")
        for i, (action, thought) in enumerate(
            zip(
                store.previous_actions[-5:],
                store.previous_thoughts[-5:]
                if len(store.previous_thoughts) >= len(store.previous_actions[-5:])
                else [""] * len(store.previous_actions[-5:]),
            )
        ):
            step_offset = max(0, len(store.previous_actions) - 5) + i + 1
            parts.append(f"  Step {step_offset}: {action}")
            if thought:
                parts.append(f"    Thought: {thought[:200]}")
        parts.append("")

    parts.append(
        "## Important Notes\n"
        "- Coordinates (x, y) are in pixels relative to the top-left corner of the screen.\n"
        "- The screen resolution is {w}x{h}.\n"
        "- Use DESKTOP_CLICK to click UI elements at their coordinates.\n"
        "- Use DESKTOP_TYPE to type text into the currently focused field.\n"
        "- Use DESKTOP_HOTKEY for keyboard shortcuts like 'enter', 'ctrl+c', 'tab'.\n"
        "- Use DESKTOP_SCROLL to scroll up or down.\n"
        "- Use DESKTOP_DONE when the task is complete.\n"
        "- Use DESKTOP_FAIL only if the task is truly impossible.\n"
        "- Think carefully about what you see in the screenshot and accessibility tree "
        "before choosing your action.\n"
        "- Identify UI elements by their position in the accessibility tree or "
        "by visually inspecting the screenshot.\n".format(
            w=store.screen_width, h=store.screen_height
        )
    )

    return ProviderResult(text="\n".join(parts))


OBSERVATION_PROVIDER = Provider(
    name="OSWORLD_OBSERVATION",
    description="Provides current VM observation (screenshot, accessibility tree, task instruction)",
    get=_observation_provider_get,
    position=0,  # High priority -- appears first in context
    dynamic=True,
)
