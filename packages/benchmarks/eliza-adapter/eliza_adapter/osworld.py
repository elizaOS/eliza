"""OSWorld agent backed by the eliza TS benchmark server.

Drop-in replacement for ``mm_agents.eliza_agent.ElizaOSWorldAgent`` —
exposes the same ``predict(instruction, obs)`` /``reset(...)`` interface
that ``run_single_example`` expects, but every decision-making call goes
through the elizaOS TypeScript benchmark bridge instead of building a
Python ``AgentRuntime``.

Note: full OSWorld runs require a desktop VM (Docker / VMware /
VirtualBox / AWS) — this adapter only replaces the agent's *decision
loop*. The OSWorld ``DesktopEnv`` still owns screenshot capture +
pyautogui execution.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import time
import uuid
from typing import Any, List, Optional, Tuple

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


_PYAUTOGUI_FENCE_RE = re.compile(
    r"```(?:python|pyautogui)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE
)
_TERMINAL_ACTION_RE = re.compile(r"\b(WAIT|DONE|FAIL)\b")
_CLICK_ACTION_RE = re.compile(r"^CLICK\(\s*(\d+)\s*,\s*(\d+)\s*\)$", re.IGNORECASE)


def _resize_screenshot_b64(raw: bytes, max_dimension: int = 1280) -> str:
    """Resize screenshot bytes for token efficiency. Mirrors the helper in
    ``mm_agents.eliza_agent``."""
    try:
        from io import BytesIO

        from PIL import Image

        img = Image.open(BytesIO(raw))
        if max(img.size) > max_dimension:
            ratio = max_dimension / float(max(img.size))
            new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
            img = img.resize(new_size, Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return base64.b64encode(raw).decode("ascii")


def _parse_actions(response_text: str, params: dict[str, Any]) -> list[str]:
    """Extract pyautogui code blocks (or terminal markers) from a response."""
    def action_values(value: Any) -> list[str]:
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        if not isinstance(value, dict):
            return []

        out: list[str] = []
        for key in ("command", "code", "value", "action"):
            raw = value.get(key)
            if isinstance(raw, str) and raw.strip():
                out.append(raw.strip())

        args = value.get("arguments")
        if isinstance(args, str) and args.strip():
            out.append(args.strip())
        elif isinstance(args, dict):
            for key in ("command", "code", "value", "action"):
                raw = args.get(key)
                if isinstance(raw, str) and raw.strip():
                    out.append(raw.strip())
        return out

    param_actions: list[str] = []
    raw_actions = params.get("actions")
    if isinstance(raw_actions, list) and raw_actions:
        param_actions.extend(str(a).strip() for a in raw_actions if str(a).strip())

    param_actions.extend(action_values(params.get("BENCHMARK_ACTION")))
    param_actions.extend(action_values(params))

    for action in param_actions:
        if action in ("WAIT", "DONE", "FAIL"):
            return [action]
        click_match = _CLICK_ACTION_RE.match(action)
        if click_match:
            x, y = click_match.groups()
            return [f"pyautogui.click({x}, {y})"]
        if "pyautogui" in action or "\n" in action:
            return [action]

    if not response_text:
        return []

    stripped = response_text.strip()
    if stripped in ("WAIT", "DONE", "FAIL"):
        return [stripped]

    matches = _PYAUTOGUI_FENCE_RE.findall(response_text)
    if matches:
        out: list[str] = []
        for m in matches:
            text = m.strip()
            if text:
                out.append(text)
        if out:
            return out

    term_match = _TERMINAL_ACTION_RE.search(response_text)
    if term_match:
        return [term_match.group(1)]

    return []


class ElizaBridgeOSWorldAgent:
    """OSWorld agent that routes decision-making through the eliza TS bridge.

    Same ``predict`` / ``reset`` shape as
    ``mm_agents.eliza_agent.ElizaOSWorldAgent`` so OSWorld's
    ``run_single_example`` can drop us in unchanged.
    """

    def __init__(
        self,
        platform: str = "ubuntu",
        model: str = "eliza-ts-bridge",
        max_tokens: int = 2048,
        temperature: float = 0.5,
        action_space: str = "pyautogui",
        observation_type: str = "screenshot_a11y_tree",
        max_trajectory_length: int = 5,
        a11y_tree_max_tokens: int = 10000,
        max_steps: int = 15,
        client_password: str = "password",
        screen_width: int = 1920,
        screen_height: int = 1080,
        client: Optional[ElizaClient] = None,
        **_unused: Any,
    ) -> None:
        self.platform = platform
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.action_space = action_space
        self.observation_type = observation_type
        self.max_trajectory_length = max_trajectory_length
        self.a11y_tree_max_tokens = a11y_tree_max_tokens
        self.max_steps = max_steps
        self.client_password = client_password
        self.screen_width = screen_width
        self.screen_height = screen_height

        self.thoughts: list[str] = []
        self.actions: list[str] = []
        self.observations: list[dict[str, str | None]] = []
        self.step_idx = 0
        self.vm_ip: str | None = None

        self._client = client or ElizaClient()
        self._task_id = str(uuid.uuid4())
        self._initialized = False

    async def async_init(self) -> None:
        """Verify the eliza bridge server is reachable. No local runtime
        is built — all decision calls go through HTTP."""
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        try:
            self._client.reset(task_id=self._task_id, benchmark="osworld")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)
        self._initialized = True

    def predict(self, instruction: str, obs: dict[str, Any]) -> Tuple[str, List[str]]:
        """Synchronous OSWorld entry point — drives the async bridge call."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(
                        asyncio.run, self._async_predict(instruction, obs)
                    )
                    return future.result(timeout=300)
            return loop.run_until_complete(self._async_predict(instruction, obs))
        except RuntimeError:
            return asyncio.run(self._async_predict(instruction, obs))

    async def _async_predict(
        self, instruction: str, obs: dict[str, Any]
    ) -> Tuple[str, List[str]]:
        if not self._initialized:
            await self.async_init()

        # ---- Process observation ----
        screenshot_b64: str | None = None
        a11y_tree: str | None = None

        if self.observation_type in ("screenshot", "screenshot_a11y_tree", "som"):
            raw = obs.get("screenshot")
            if isinstance(raw, bytes):
                screenshot_b64 = _resize_screenshot_b64(raw, max_dimension=1280)
            elif isinstance(raw, str):
                screenshot_b64 = raw

        if self.observation_type in ("a11y_tree", "screenshot_a11y_tree"):
            tree_raw = obs.get("accessibility_tree")
            if isinstance(tree_raw, str):
                a11y_tree = tree_raw
                if self.a11y_tree_max_tokens:
                    max_chars = self.a11y_tree_max_tokens * 4
                    if len(a11y_tree) > max_chars:
                        a11y_tree = a11y_tree[:max_chars] + "\n[... truncated ...]"

        self.observations.append(
            {"screenshot": screenshot_b64, "accessibility_tree": a11y_tree}
        )

        # ---- Build prompt + context ----
        history_actions = self.actions[-self.max_trajectory_length :]
        history_thoughts = self.thoughts[-self.max_trajectory_length :]

        prompt = (
            "You are an OSWorld agent controlling a desktop VM via "
            f"{self.action_space}.\n\n"
            f"Task: {instruction}\n\n"
            f"Step {self.step_idx + 1}/{self.max_steps}\n\n"
            "Decide on the next action. Respond with a Python pyautogui "
            "code block:\n```python\n# your pyautogui code here\n```\n"
            "Or respond with WAIT, DONE, or FAIL."
        )

        start_time = time.time()
        response_text = ""
        actions: list[str] = []

        try:
            response = self._client.send_message(
                text=prompt,
                context={
                    "benchmark": "osworld",
                    "task_id": self._task_id,
                    "step_number": self.step_idx,
                    "max_steps": self.max_steps,
                    "instruction": instruction,
                    "platform": self.platform,
                    "screen_width": self.screen_width,
                    "screen_height": self.screen_height,
                    "client_password": self.client_password,
                    "action_space": self.action_space,
                    "observation_type": self.observation_type,
                    "screenshot_base64": screenshot_b64,
                    "accessibility_tree": a11y_tree,
                    "previous_actions": history_actions,
                    "previous_thoughts": history_thoughts,
                },
            )
            response_text = response.text or ""
            actions = _parse_actions(response_text, response.params)
        except Exception as exc:
            logger.error(
                "[eliza-bridge-osworld] send_message failed at step %d: %s",
                self.step_idx,
                exc,
            )
            response_text = f"Error: {exc}"

        if not actions:
            actions = ["WAIT"]

        self.thoughts.append(response_text)
        self.actions.append(str(actions))
        self.step_idx += 1

        latency_ms = (time.time() - start_time) * 1000
        logger.info(
            "[eliza-bridge-osworld] step=%d latency=%.0fms actions=%s",
            self.step_idx,
            latency_ms,
            actions,
        )

        return response_text, actions

    def reset(
        self,
        _logger: Any = None,
        vm_ip: str | None = None,
        **_kwargs: Any,
    ) -> None:
        if _logger is not None:
            global logger
            logger = _logger  # type: ignore[assignment]
        self.vm_ip = vm_ip
        self.thoughts.clear()
        self.actions.clear()
        self.observations.clear()
        self.step_idx = 0
        self._task_id = str(uuid.uuid4())
        try:
            self._client.reset(task_id=self._task_id, benchmark="osworld")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)
