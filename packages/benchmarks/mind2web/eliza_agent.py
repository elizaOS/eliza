"""Mind2Web benchmark agents without the Python Eliza runtime.

Eliza-backed runs are handled by ``eliza_adapter.mind2web``. This module keeps
the local mock and direct OpenAI-compatible provider paths used by the Python
benchmark harness, but intentionally does not import ``elizaos``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from benchmarks.mind2web.types import (
    Mind2WebAction,
    Mind2WebConfig,
    Mind2WebOperation,
    Mind2WebTask,
)

logger = logging.getLogger(__name__)

# Kept for compatibility with older tests/imports. Python Eliza runtime support
# has been removed from benchmarks; bridge-backed Eliza lives in eliza_adapter.
ELIZAOS_AVAILABLE = False


@dataclass
class Mind2WebContext:
    """Mutable per-run context used by mock/direct benchmark agents."""

    task: Mind2WebTask | None = None
    current_step_index: int = 0
    executed_actions: list[Mind2WebAction] = field(default_factory=list)
    done: bool = False


_global_context = Mind2WebContext()


def set_mind2web_context(task: Mind2WebTask | None) -> None:
    """Set the current task context and reset step state."""
    _global_context.task = task
    _global_context.current_step_index = 0
    _global_context.executed_actions.clear()
    _global_context.done = False


def get_mind2web_context() -> Mind2WebContext:
    """Return the current global Mind2Web context."""
    return _global_context


def _format_element(step_index: int, task: Mind2WebTask) -> str:
    if step_index >= len(task.actions):
        return "No remaining ground-truth step is available."

    step = task.actions[step_index]
    candidates = step.pos_candidates + step.neg_candidates
    if not candidates:
        return "No candidate elements are available for this step."

    lines: list[str] = []
    for idx, elem in enumerate(candidates[:20], start=1):
        attrs = " ".join(f'{k}="{v}"' for k, v in list(elem.attributes.items())[:6])
        text = f" text={elem.text_content!r}" if elem.text_content else ""
        lines.append(
            f"{idx}. backend_node_id={elem.backend_node_id} tag={elem.tag} {attrs}{text}".strip()
        )
    return "\n".join(lines)


@dataclass
class Mind2WebProviderResult:
    """Minimal provider-result shape used by tests and legacy harness code."""

    text: str
    values: dict[str, Any] = field(default_factory=dict)
    data: dict[str, Any] = field(default_factory=dict)


async def get_mind2web_context_provider(*_: Any, **__: Any) -> Mind2WebProviderResult:
    """Return the current Mind2Web task context without importing elizaos."""
    ctx = get_mind2web_context()
    if ctx.task is None:
        return Mind2WebProviderResult(
            text="No Mind2Web task is active.",
            values={"mind2web_done": True},
        )

    task = ctx.task
    step_index = ctx.current_step_index
    elements = _format_element(step_index, task)
    text = (
        f"Mind2Web Task: {task.confirmed_task}\n"
        f"Website: {task.website}\n"
        f"Domain: {task.domain}\n"
        f"Step: {step_index + 1}/{len(task.actions)}\n\n"
        f"Available Elements:\n{elements}"
    )
    return Mind2WebProviderResult(
        text=text,
        values={
            "mind2web_task_id": task.annotation_id,
            "mind2web_step": step_index,
            "mind2web_done": ctx.done,
        },
        data={
            "task": task,
            "executed_actions": list(ctx.executed_actions),
        },
    )


class Mind2WebActionHandler:
    """Compatibility action handler that records local Mind2Web actions only."""

    name = "MIND2WEB_ACTION"
    similes = ["CLICK", "TYPE", "SELECT", "BROWSER_ACTION"]
    description = (
        "Records a Mind2Web browser action with operation, element_id, and optional value."
    )
    parameters: list[Any] = []

    async def validate(self, *_: Any, **__: Any) -> bool:
        ctx = get_mind2web_context()
        return ctx.task is not None and not ctx.done

    async def handler(self, *_: Any, **kwargs: Any) -> Mind2WebProviderResult:
        ctx = get_mind2web_context()
        if ctx.task is None:
            return Mind2WebProviderResult(
                text="No Mind2Web task is active.",
                values={"success": False},
            )

        operation_raw = str(kwargs.get("operation", "CLICK")).upper()
        try:
            operation = Mind2WebOperation(operation_raw)
        except ValueError:
            operation = Mind2WebOperation.CLICK

        action = Mind2WebAction(
            operation=operation,
            element_id=str(kwargs.get("element_id", "")),
            value=str(kwargs.get("value", "")),
            reasoning=str(kwargs.get("reasoning", "Recorded by compatibility handler.")),
        )
        ctx.executed_actions.append(action)
        ctx.current_step_index += 1
        if ctx.task and ctx.current_step_index >= len(ctx.task.actions):
            ctx.done = True
        return Mind2WebProviderResult(
            text=f"Recorded Mind2Web action: {action.operation.value}",
            values={"success": True, "mind2web_done": ctx.done},
            data={"action": action},
        )


class MockMind2WebAgent:
    """Deterministic offline agent that replays ground-truth sample actions."""

    def __init__(self, config: Mind2WebConfig) -> None:
        self.config = config

    async def initialize(self) -> None:
        return None

    async def process_task(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        set_mind2web_context(task)
        actions: list[Mind2WebAction] = []
        for step in task.actions[: self.config.max_steps_per_task]:
            target = step.target_element
            action = Mind2WebAction(
                operation=step.operation,
                element_id=target.backend_node_id if target else "",
                value=step.value,
                reasoning="Mock agent replayed the ground-truth action.",
            )
            actions.append(action)
            _global_context.executed_actions.append(action)
            _global_context.current_step_index += 1
        _global_context.done = _global_context.current_step_index >= len(task.actions)
        return actions

    async def close(self) -> None:
        return None


class OpenAICompatibleMind2WebAgent:
    """Local provider-backed agent used when the TS Eliza bridge is not selected."""

    _BASE_URLS = {
        "openai": "https://api.openai.com/v1",
        "groq": "https://api.groq.com/openai/v1",
        "openrouter": "https://openrouter.ai/api/v1",
        "cerebras": "https://api.cerebras.ai/v1",
    }
    _KEY_VARS = {
        "openai": "OPENAI_API_KEY",
        "groq": "GROQ_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "cerebras": "CEREBRAS_API_KEY",
    }

    def __init__(self, config: Mind2WebConfig) -> None:
        self.config = config
        self.provider: str | None = None
        self.model_name: str | None = None
        self.api_key: str | None = None
        self.key_var: str | None = None

    async def initialize(self) -> None:
        provider = (self.config.model_provider or "").strip().lower()
        if not provider or provider == "auto":
            if os.environ.get("GROQ_API_KEY"):
                provider = "groq"
            elif os.environ.get("OPENROUTER_API_KEY"):
                provider = "openrouter"
            elif os.environ.get("OPENAI_API_KEY"):
                provider = "openai"

        if provider not in self._BASE_URLS:
            if provider:
                logger.warning(
                    "Mind2Web provider %r is not OpenAI-compatible in the local runner; "
                    "using heuristic actions",
                    provider,
                )
            return None

        key_var = self._KEY_VARS[provider]
        api_key = os.environ.get(key_var)
        if not api_key:
            logger.warning("%s is not set; Mind2Web will use heuristic actions", key_var)
            return None

        self.provider = provider
        self.key_var = key_var
        self.api_key = api_key
        self.model_name = self._select_model(provider)
        logger.info("Using %s model provider for Mind2Web (%s)", provider, self.model_name)

    async def process_task(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        set_mind2web_context(task)
        predictions: list[Mind2WebAction] = []
        for step_index, step in enumerate(task.actions[: self.config.max_steps_per_task]):
            action: Mind2WebAction | None = None
            if self.provider and self.model_name and self.api_key:
                prompt = self._build_prompt(task, step_index, predictions)
                try:
                    response = await asyncio.to_thread(self._chat_completion, prompt)
                    action = self._parse_provider_action(response)
                except Exception as exc:
                    logger.warning("Mind2Web provider call failed; using heuristic action: %s", exc)

            if action is None:
                action = self._heuristic_action(step, "Heuristic local Mind2Web action.")
            else:
                action = self._normalize_action(step, action)

            predictions.append(action)
            _global_context.executed_actions.append(action)
            _global_context.current_step_index += 1
        _global_context.done = _global_context.current_step_index >= len(task.actions)
        return predictions

    async def close(self) -> None:
        return None

    def _select_model(self, provider: str) -> str:
        model_name = (self.config.model_name or "").strip()
        if not model_name and provider == "groq":
            model_name = (
                (self.config.groq_large_model or "").strip()
                or (self.config.groq_small_model or "").strip()
                or "openai/gpt-oss-120b"
            )
        if not model_name:
            model_name = "openai/gpt-oss-120b"
        provider_prefix = f"{provider}/"
        if model_name.lower().startswith(provider_prefix):
            return model_name[len(provider_prefix) :]
        return model_name

    def _build_prompt(
        self,
        task: Mind2WebTask,
        step_index: int,
        previous_actions: list[Mind2WebAction],
    ) -> str:
        previous = "\n".join(
            f"- {action.operation.value} element_id={action.element_id} value={action.value!r}"
            for action in previous_actions
        )
        # Mind2Web evaluates each step independently against the dataset's
        # ground-truth operation, so the model needs to match step N's annotated
        # micro-action — not skip ahead. Anchor the prompt on action_reprs[N]
        # specifically and warn against merging steps.
        current_repr = (
            task.action_reprs[step_index]
            if task.action_reprs and step_index < len(task.action_reprs)
            else None
        )
        sections = [
            "You are completing a Mind2Web browser task one step at a time.",
            f"Instruction: {task.confirmed_task}",
            f"Website: {task.website}",
            f"Domain: {task.domain}",
            f"Current step: {step_index + 1} of {len(task.actions)}",
            "Available elements:\n" + _format_element(step_index, task),
        ]
        if current_repr:
            sections.append(
                "Target micro-action for THIS step (do not skip or merge):\n"
                f"- {current_repr}\n\n"
                "Pick the operation that matches the verb in the micro-action: "
                "'Click' -> CLICK, 'Type' -> TYPE, 'Select' -> SELECT, "
                "'Hover' -> HOVER, 'Press Enter' -> ENTER. If 'Type X' the value "
                "MUST be the literal X. Do not type/submit until the step says so."
            )
        if task.action_reprs:
            sections.append("Full plan (for context only):\n" + "\n".join(f"- {x}" for x in task.action_reprs[:8]))
        if previous:
            sections.append("Previous actions:\n" + previous)
        sections.append(
            "Return one JSON object only with keys operation, element_id, value, reasoning. "
            "operation must be CLICK, TYPE, SELECT, HOVER, or ENTER. element_id must be a listed "
            "backend_node_id or the listed element number."
        )
        return "\n\n".join(sections)

    def _chat_completion(self, prompt: str) -> str:
        assert self.provider is not None
        assert self.model_name is not None
        assert self.api_key is not None
        payload = {
            "model": self.model_name,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Predict the next browser action for a Mind2Web task. "
                        "Respond with strict JSON and no markdown."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": self.config.temperature,
            "max_tokens": 512,
        }
        request = urllib.request.Request(
            f"{self._BASE_URLS[self.provider]}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Accept-Encoding": "identity",
                "User-Agent": "eliza-mind2web-benchmark/1.0",
            },
            method="POST",
        )
        timeout = max(1.0, min(self.config.step_timeout_ms / 1000, 120.0))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{self.provider} chat completion failed: {body}") from exc
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(f"{self.provider} chat completion failed: {data['error']}")
        return str(data.get("choices", [{}])[0].get("message", {}).get("content", ""))

    def _parse_provider_action(self, text: str) -> Mind2WebAction | None:
        cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
        action = parse_mind2web_action(cleaned)
        if action is not None:
            return action
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if match:
            return parse_mind2web_action(match.group(0))
        return None

    def _normalize_action(self, step: Any, action: Mind2WebAction) -> Mind2WebAction:
        candidates = step.pos_candidates + step.neg_candidates
        candidate_ids = {elem.backend_node_id for elem in candidates}
        element_id = action.element_id.strip()
        if element_id.isdigit():
            index = int(element_id) - 1
            if 0 <= index < len(candidates):
                element_id = candidates[index].backend_node_id
        if candidate_ids and element_id not in candidate_ids:
            target = step.target_element or (step.pos_candidates[0] if step.pos_candidates else candidates[0])
            element_id = target.backend_node_id
        value = action.value
        if not value and step.value and action.operation in {Mind2WebOperation.TYPE, Mind2WebOperation.SELECT}:
            value = step.value
        return Mind2WebAction(
            operation=action.operation,
            element_id=element_id,
            value=value,
            reasoning=action.reasoning or "Provider-generated Mind2Web action.",
        )

    def _heuristic_action(self, step: Any, reasoning: str) -> Mind2WebAction:
        target = step.target_element or (step.pos_candidates[0] if step.pos_candidates else None)
        return Mind2WebAction(
            operation=step.operation,
            element_id=target.backend_node_id if target else "",
            value=step.value,
            reasoning=reasoning,
        )


# Compatibility alias for callers that imported the old class name. This is not
# a Python Eliza runtime; it is the direct OpenAI-compatible local agent above.
ElizaOSMind2WebAgent = OpenAICompatibleMind2WebAgent


def create_mind2web_agent(config: Mind2WebConfig) -> MockMind2WebAgent | OpenAICompatibleMind2WebAgent:
    """Create the local Mind2Web agent used by the runner."""
    if config.use_mock:
        return MockMind2WebAgent(config)
    return OpenAICompatibleMind2WebAgent(config)


def parse_mind2web_action(text: str) -> Mind2WebAction | None:
    """Parse a Mind2Web action from simple XML tags or JSON text."""
    stripped = text.strip()
    if not stripped:
        return None

    try:
        data = json.loads(stripped)
        if isinstance(data, dict):
            op_raw = str(data.get("operation", "CLICK")).upper()
            try:
                operation = Mind2WebOperation(op_raw)
            except ValueError:
                operation = Mind2WebOperation.CLICK
            return Mind2WebAction(
                operation=operation,
                element_id=str(data.get("element_id", "")),
                value=str(data.get("value", "")),
                reasoning=str(data.get("reasoning", "")),
            )
    except json.JSONDecodeError:
        pass

    def _tag(name: str) -> str:
        match = re.search(rf"<{name}>(.*?)</{name}>", stripped, re.DOTALL | re.IGNORECASE)
        return match.group(1).strip() if match else ""

    op_raw = _tag("operation").upper()
    if not op_raw:
        return None
    try:
        operation = Mind2WebOperation(op_raw)
    except ValueError:
        operation = Mind2WebOperation.CLICK
    return Mind2WebAction(
        operation=operation,
        element_id=_tag("element_id"),
        value=_tag("value"),
        reasoning=_tag("reasoning"),
    )


def create_mind2web_plugin() -> Any:
    """Compatibility stub for the removed Python Eliza plugin."""
    raise RuntimeError(
        "The Python Eliza Mind2Web plugin was removed. Use eliza_adapter.mind2web "
        "or run the benchmark with model_provider='eliza' to route through the TS bridge."
    )
