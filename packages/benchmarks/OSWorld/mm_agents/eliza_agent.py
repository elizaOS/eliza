"""
Eliza OSWorld Agent -- routes all decisions through Eliza's message_service.handle_message().

This agent implements the OSWorld agent interface (predict / reset) but uses
Eliza's canonical message processing pipeline:
  1. Observations (screenshot + a11y tree) are injected via a Provider
  2. The LLM chooses from registered desktop Actions (DESKTOP_CLICK, DESKTOP_TYPE, etc.)
  3. Action handlers generate pyautogui code
  4. The code is collected and returned to OSWorld's env.step()

Usage:
    agent = ElizaOSWorldAgent(
        model="qwen/qwen3-32b",
        observation_type="screenshot_a11y_tree",
        action_space="pyautogui",
    )
    await agent.async_init()
    # ... used within OSWorld's run_single_example loop
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import sys
import uuid
from typing import Dict, List

# Ensure protobuf generated modules are importable
_generated_dir = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "eliza", "packages", "python",
    "elizaos", "types", "generated",
)
_generated_dir = os.path.normpath(_generated_dir)
if os.path.isdir(_generated_dir) and _generated_dir not in sys.path:
    sys.path.insert(0, _generated_dir)

from mm_agents.eliza_desktop_actions import ActionCollector
from mm_agents.eliza_observation import ObservationStore
from mm_agents.plugin import create_osworld_plugin

logger = logging.getLogger("osworld.eliza.agent")


def _resize_screenshot_b64(raw_bytes: bytes, max_dimension: int = 1280) -> str:
    """Resize a screenshot to fit within max_dimension and return base64 PNG.

    Tries the computeruse native bindings first (fastest, best quality),
    falls back to PIL (available via OSWorld dependencies).
    """
    # Path 1: Try computeruse native bindings (if available)
    try:
        import computeruse
        desktop = computeruse.Desktop()
        # The native API can resize directly from raw screenshot data
        return desktop.screenshot_to_base64_png_resized(raw_bytes, max_dimension)
    except (ImportError, AttributeError, Exception):
        pass

    # Path 2: Use PIL (always available in OSWorld environment)
    try:
        from PIL import Image
        from io import BytesIO

        img = Image.open(BytesIO(raw_bytes))
        w, h = img.size

        # Only resize if larger than max_dimension
        if max(w, h) > max_dimension:
            if w >= h:
                new_w = max_dimension
                new_h = int(h * max_dimension / w)
            else:
                new_h = max_dimension
                new_w = int(w * max_dimension / h)
            img = img.resize((new_w, new_h), Image.LANCZOS)

        buf = BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception:
        # Path 3: Raw base64 (no resizing)
        return base64.b64encode(raw_bytes).decode("utf-8")


def _linearize_accessibility_tree_simple(accessibility_tree: str, platform: str = "ubuntu") -> str:
    """Simplified a11y tree linearization (avoids heavy imports).
    
    Falls back to the full linearizer if available.
    """
    try:
        from mm_agents.agent import linearize_accessibility_tree
        return linearize_accessibility_tree(accessibility_tree, platform)
    except Exception:
        # If the full linearizer fails, just return raw (it's XML)
        # Trim to a reasonable size
        if len(accessibility_tree) > 50000:
            return accessibility_tree[:50000] + "\n[... truncated ...]"
        return accessibility_tree


class ElizaOSWorldAgent:
    """OSWorld agent backed by Eliza's message service.
    
    This class implements the OSWorld agent interface (predict, reset) while
    routing ALL decision-making through Eliza's message_service.handle_message().
    """

    def __init__(
        self,
        platform: str = "ubuntu",
        model: str = "qwen/qwen3-32b",
        max_tokens: int = 2048,
        top_p: float = 0.9,
        temperature: float = 0.5,
        action_space: str = "pyautogui",
        observation_type: str = "screenshot_a11y_tree",
        max_trajectory_length: int = 5,
        a11y_tree_max_tokens: int = 10000,
        max_steps: int = 15,
        client_password: str = "password",
        groq_api_key: str | None = None,
        screen_width: int = 1920,
        screen_height: int = 1080,
    ):
        self.platform = platform
        self.model = model
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.temperature = temperature
        self.action_space = action_space
        self.observation_type = observation_type
        self.max_trajectory_length = max_trajectory_length
        self.a11y_tree_max_tokens = a11y_tree_max_tokens
        self.max_steps = max_steps
        self.client_password = client_password
        self.groq_api_key = groq_api_key or os.environ.get("GROQ_API_KEY", "")
        self.screen_width = screen_width
        self.screen_height = screen_height

        # State tracking
        self.thoughts: list[str] = []
        self.actions: list[str] = []
        self.observations: list[dict[str, str | None]] = []
        self.step_idx = 0
        self.vm_ip: str | None = None

        # Eliza runtime -- initialized in async_init
        self._runtime: object | None = None
        self._initialized = False

    async def async_init(self) -> None:
        """Initialize the Eliza runtime with desktop actions and observation provider.
        
        Must be called once before predict().
        """
        if self._initialized:
            return

        from elizaos.runtime import AgentRuntime

        # Build character config for the agent
        character = _build_character(
            model=self.model,
            screen_width=self.screen_width,
            screen_height=self.screen_height,
            client_password=self.client_password,
        )

        # Create runtime settings
        settings: dict[str, str] = {}
        if self.groq_api_key:
            settings["GROQ_API_KEY"] = self.groq_api_key

        # Determine model provider from model name
        model_provider = _detect_model_provider(self.model)
        if model_provider:
            settings["MODEL_PROVIDER"] = model_provider

        # Build the OSWorld plugin (bundles all desktop actions + observation provider)
        osworld_plugin = create_osworld_plugin()

        runtime = AgentRuntime(
            character=character,
            plugins=[osworld_plugin],
            settings=settings,
            disable_basic_capabilities=True,  # We only want our desktop actions
        )

        # Register Groq model handler for TEXT_LARGE and TEXT_SMALL
        groq_handler = _create_groq_model_handler(
            model=self.model,
            api_key=self.groq_api_key,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
        )
        from elizaos.types.model import ModelType
        runtime.register_model(ModelType.TEXT_LARGE, groq_handler, provider="groq")
        runtime.register_model(ModelType.TEXT_SMALL, groq_handler, provider="groq")

        await runtime.initialize()

        self._runtime = runtime
        self._initialized = True
        logger.info(
            "Eliza OSWorld agent initialized with model=%s, provider=%s",
            self.model,
            model_provider,
        )

    def predict(self, instruction: str, obs: Dict) -> tuple[str, List[str]]:
        """Predict the next action(s) via Eliza's message service.
        
        This is the synchronous entry point called by OSWorld's run loop.
        Internally runs the async handle_message in an event loop.
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If already in an async context, use nest_asyncio or run in thread
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(asyncio.run, self._async_predict(instruction, obs))
                    return future.result(timeout=300)
            else:
                return loop.run_until_complete(self._async_predict(instruction, obs))
        except RuntimeError:
            return asyncio.run(self._async_predict(instruction, obs))

    async def _async_predict(self, instruction: str, obs: Dict) -> tuple[str, List[str]]:
        """Async implementation of predict using Eliza's handle_message."""
        if not self._initialized:
            await self.async_init()

        runtime = self._runtime
        assert runtime is not None, "Runtime not initialized"

        # ---- 1. Process observation ----
        screenshot_b64: str | None = None
        a11y_tree: str | None = None

        if self.observation_type in ("screenshot", "screenshot_a11y_tree", "som"):
            if "screenshot" in obs and obs["screenshot"]:
                raw = obs["screenshot"]
                if isinstance(raw, bytes):
                    # Resize screenshot to reduce token usage.
                    # The computeruse package has optimized native resizing via
                    # screenshot_to_base64_png_resized(), but falls back to PIL.
                    screenshot_b64 = _resize_screenshot_b64(raw, max_dimension=1280)
                elif isinstance(raw, str):
                    screenshot_b64 = raw

        if self.observation_type in ("a11y_tree", "screenshot_a11y_tree"):
            if "accessibility_tree" in obs and obs["accessibility_tree"]:
                a11y_tree = _linearize_accessibility_tree_simple(
                    obs["accessibility_tree"], self.platform
                )
                # Trim a11y tree
                if a11y_tree and self.a11y_tree_max_tokens:
                    try:
                        import tiktoken
                        enc = tiktoken.encoding_for_model("gpt-4")
                        tokens = enc.encode(a11y_tree)
                        if len(tokens) > self.a11y_tree_max_tokens:
                            a11y_tree = enc.decode(tokens[: self.a11y_tree_max_tokens])
                            a11y_tree += "\n[... truncated ...]"
                    except ImportError:
                        # No tiktoken, just truncate by chars (~4 chars/token)
                        max_chars = self.a11y_tree_max_tokens * 4
                        if len(a11y_tree) > max_chars:
                            a11y_tree = a11y_tree[:max_chars] + "\n[... truncated ...]"

        # Store observation for history
        self.observations.append({
            "screenshot": screenshot_b64,
            "accessibility_tree": a11y_tree,
        })

        # ---- 2. Set observation in the provider store ----
        obs_store = ObservationStore.get()
        obs_store.set_observation(
            instruction=instruction,
            accessibility_tree=a11y_tree,
            screenshot_base64=screenshot_b64,
            step_number=self.step_idx,
            max_steps=self.max_steps,
            platform=self.platform,
            screen_width=self.screen_width,
            screen_height=self.screen_height,
            client_password=self.client_password,
        )
        # Add history (only last N, and clear store history first to avoid accumulation)
        obs_store.previous_actions.clear()
        obs_store.previous_thoughts.clear()
        for a in self.actions[-self.max_trajectory_length:]:
            obs_store.add_previous_action(str(a))
        for t in self.thoughts[-self.max_trajectory_length:]:
            obs_store.add_previous_thought(str(t))

        # ---- 3. Reset action collector ----
        collector = ActionCollector.get()
        collector.reset()

        # ---- 4. Build Eliza message ----
        from elizaos.types.primitives import Content, Media
        from elizaos.types.memory import Memory

        if not hasattr(self, "_room_id"):
            self._room_id = str(uuid.uuid4())
        if not hasattr(self, "_entity_id"):
            self._entity_id = str(uuid.uuid4())

        room_id = self._room_id
        entity_id = self._entity_id
        agent_id = str(runtime.agent_id) if hasattr(runtime, "agent_id") else str(uuid.uuid4())
        msg_id = str(uuid.uuid4())

        # Build message content
        msg_text = (
            f"You are looking at a computer screen. Complete this task: {instruction}\n\n"
            f"Based on the current screenshot and accessibility tree, decide on the "
            f"next action to take. Choose ONE action from the available desktop actions."
        )

        # Build Content protobuf
        content = Content(
            text=msg_text,
            source="osworld",
        )

        # Add screenshot as Media attachment if available
        if screenshot_b64:
            content.attachments.append(Media(
                url=f"data:image/png;base64,{screenshot_b64}",
                title="Current screenshot",
                description="Screenshot of the current VM desktop state",
                content_type="image/png",
                source="osworld",
            ))

        # Build Memory protobuf
        import time as _time
        message = Memory(
            id=msg_id,
            entity_id=entity_id,
            agent_id=agent_id,
            room_id=room_id,
            content=content,
            created_at=int(_time.time() * 1000),
        )

        # ---- 5. Call message_service.handle_message ----
        response_text = ""

        async def _callback(content: Content) -> list[Memory]:
            nonlocal response_text
            if content and content.text:
                response_text = content.text
            return []

        try:
            result = await runtime.message_service.handle_message(
                runtime, message, _callback
            )

            if result and result.response_content and result.response_content.text:
                response_text = result.response_content.text

        except Exception as e:
            logger.error("handle_message failed: %s", e, exc_info=True)
            response_text = f"Error: {e}"

        # ---- 6. Collect generated actions ----
        generated_actions = collector.collect()

        if not generated_actions:
            # If no actions were generated, try to parse from response text
            logger.warning("No actions generated from handle_message, attempting fallback")
            generated_actions = _fallback_parse_actions(response_text)

        if not generated_actions:
            # Last resort: WAIT
            generated_actions = ["WAIT"]

        # ---- 7. Record history ----
        self.thoughts.append(response_text)
        self.actions.append(str(generated_actions))
        self.step_idx += 1

        logger.info("Step %d: response=%s, actions=%s", self.step_idx, response_text[:200], generated_actions)

        return response_text, generated_actions

    def reset(self, _logger: object = None, vm_ip: str | None = None, **kwargs: object) -> None:
        """Reset agent state for a new task."""
        if _logger is not None:
            global logger
            logger = _logger  # type: ignore[assignment]

        self.vm_ip = vm_ip
        self.thoughts.clear()
        self.actions.clear()
        self.observations.clear()
        self.step_idx = 0

        # Reset shared stores
        ObservationStore.get().reset()
        ActionCollector.get().reset()


def _fallback_parse_actions(response: str) -> list[str]:
    """Try to extract pyautogui code from a raw LLM response (fallback)."""
    if not response:
        return []

    stripped = response.strip()
    if stripped in ("WAIT", "DONE", "FAIL"):
        return [stripped]

    # Try to find code blocks
    import re
    pattern = r"```(?:python\s+)?(.*?)```"
    matches = re.findall(pattern, response, re.DOTALL)
    if matches:
        codes = []
        for match in matches:
            match = match.strip()
            if match in ("WAIT", "DONE", "FAIL"):
                codes.append(match)
            elif match:
                codes.append(match)
        return codes

    return []


def _detect_model_provider(model: str) -> str | None:
    """Detect the model provider from the model name."""
    model_lower = model.lower()
    if "groq" in model_lower or model_lower.startswith("qwen"):
        return "groq"
    if "gpt" in model_lower or "o1" in model_lower or "o3" in model_lower:
        return "openai"
    if "claude" in model_lower:
        return "anthropic"
    if "gemini" in model_lower:
        return "google"
    return None


def _create_groq_model_handler(
    model: str,
    api_key: str,
    max_tokens: int = 2048,
    temperature: float = 0.5,
) -> object:
    """Create an async model handler that calls Groq API.

    Returns a coroutine function with signature:
        async def handler(runtime, params) -> str
    """
    from groq import AsyncGroq

    client = AsyncGroq(api_key=api_key)

    async def groq_handler(runtime: object, params: dict[str, object]) -> str:
        prompt = str(params.get("prompt", ""))
        temp = params.get("temperature", temperature)
        max_tok = params.get("max_tokens", max_tokens)
        stop = params.get("stop")

        if not prompt:
            return ""

        messages = [{"role": "user", "content": prompt}]

        kwargs: dict[str, object] = {
            "model": model,
            "messages": messages,
            "temperature": float(str(temp)),
            "max_tokens": int(str(max_tok)),
        }
        if stop:
            kwargs["stop"] = stop

        try:
            response = await client.chat.completions.create(**kwargs)
            result = response.choices[0].message.content or ""
            return result
        except Exception as e:
            logger.error("Groq API call failed: %s", e)
            return ""

    return groq_handler


def _build_character(
    model: str,
    screen_width: int = 1920,
    screen_height: int = 1080,
    client_password: str = "password",
) -> object:
    """Build an Eliza Character for the OSWorld agent."""
    from elizaos.types.agent import Character

    system_prompt = (
        "You are an expert desktop automation agent. You interact with a computer "
        "by observing screenshots and accessibility trees, then choosing precise "
        "actions to complete tasks.\n\n"
        "CRITICAL RULES:\n"
        f"- Screen resolution is {screen_width}x{screen_height} pixels.\n"
        "- Always choose exactly ONE action per step.\n"
        "- Be precise with coordinates - look at the screenshot and accessibility tree carefully.\n"
        "- The accessibility tree shows UI elements with their positions and sizes.\n"
        "- Use the position info from the accessibility tree to determine click coordinates.\n"
        f"- Computer password is: {client_password}\n"
        "- Think step by step before acting.\n"
        "- When a task is complete, use DESKTOP_DONE.\n"
        "- Only use DESKTOP_FAIL if truly impossible.\n"
    )

    character = Character(
        name="OSWorld Desktop Agent",
        system=system_prompt,
    )

    return character
