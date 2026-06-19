"""WebShop benchmark agent backed by the eliza TS bridge.

Drop-in replacement for ``elizaos_webshop.eliza_agent.ElizaOSWebShopAgent``
that bypasses the Python ``AgentRuntime`` (which currently hits an upstream
proto bug at ``HandlerOptions.parameter_errors``) and instead drives the
multi-turn shopping loop directly through the eliza TypeScript benchmark
HTTP server.

For each turn the adapter:
  1. Builds a prompt containing the task instruction, current observation,
     and a short history of recent actions.
  2. Sends it through ``ElizaClient.send_message`` with a benchmark-tagged
     context object so the TS bridge can scope its session.
  3. Parses the response into either a WEBSHOP_ACTION (e.g. ``search[...]``,
     ``click[P004]``, ``buy``) or a final REPLY.
  4. Steps the in-process ``WebShopEnvironment`` with the chosen action.

The adapter implements the same minimal interface that
``elizaos_webshop.runner.WebShopRunner`` calls (``initialize``,
``process_task``, ``close``), so it can be swapped in via
``create_webshop_agent`` without touching the runner.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from elizaos_webshop.environment import WebShopEnvironment
    from elizaos_webshop.types import EpisodeStep, PageObservation, WebShopTask

logger = logging.getLogger(__name__)


_VALID_ACTIONS = ("WEBSHOP_ACTION", "REPLY")

_SYSTEM_PROMPT = (
    "You are an AI shopping agent being evaluated on the WebShop benchmark. "
    "You must navigate a simulated webstore to purchase the product matching "
    "the user's instruction.\n\n"
    "On every turn, choose exactly ONE currently available WebShop action. "
    "If a webshop_action tool is available, call it with command set to that "
    "exact action string. Otherwise return JSON only with actions "
    '["BENCHMARK_ACTION"] and params.BENCHMARK_ACTION.command set to the '
    "exact action string.\n\n"
    "On product pages, select every visible option value required by the "
    "instruction, such as size, color, style, or caffeine, before choosing "
    "click[buy now]. Only choose click[buy now] after the currently selected "
    "product and selected options satisfy the instruction.\n\n"
    "Available actions:\n"
    "  search[query string]\n"
    "  click[PRODUCT_ID]\n"
    "  click[option value]\n"
    "  click[buy now]\n"
    "  click[back to search]\n\n"
    "If action calling is unavailable, return JSON only:\n"
    '{"actions":["BENCHMARK_ACTION"],"params":{"BENCHMARK_ACTION":{"command":"search[wireless bluetooth headphones under $100]"}}}\n\n'
    "Once you have purchased the correct product, the episode ends "
    "automatically — no further action required."
)


def _webshop_action_tool_schema() -> dict[str, object]:
    """OpenAI-compatible single-tool surface for one WebShop command."""
    return {
        "type": "function",
        "function": {
            "name": "webshop_action",
            "description": (
                "Execute exactly one command from the current WebShop "
                "Available Actions list."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": (
                            "Exact WebShop command, for example "
                            "search[wireless headphones], click[B000HEADPH], "
                            "click[black], click[buy now], or "
                            "click[back to search]."
                        ),
                    }
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    }


def _format_observation(obs: "PageObservation") -> str:
    lines: list[str] = [f"## Page: {obs.page_type.value}", obs.message]
    if obs.page_type.value == "results" and obs.results:
        lines.append("\n### Results (top 10):")
        for r in obs.results[:10]:
            lines.append(
                f"- [{r.product_id}] {r.name} | ${r.price:.2f} | "
                f"rating={r.rating:.1f} | {r.category}"
            )
    if obs.page_type.value == "product" and obs.product is not None:
        p = obs.product
        lines.append("\n### Product:")
        lines.append(f"- id: {p.product_id}")
        lines.append(f"- name: {p.name}")
        lines.append(f"- price: ${p.price:.2f}")
        lines.append(f"- rating: {p.rating:.1f}")
        if p.features:
            lines.append(f"- features: {', '.join(p.features[:12])}")
        if p.options:
            lines.append("- options:")
            for k, vals in p.options.items():
                selected = obs.selected_options.get(k, "not selected")
                lines.append(f"  - {k}: {vals} (selected: {selected})")
    if obs.available_actions:
        lines.append("\n### Available actions:")
        for a in obs.available_actions[:20]:
            lines.append(f"- {a}")
    return "\n".join(lines)


def _strip_xml_action_block(text: str, tag: str) -> str | None:
    match = re.search(rf"<{tag}>([\s\S]*?)</{tag}>", text)
    return match.group(1).strip() if match else None


def _parse_action_from_response(
    response_text: str,
    response_actions: list[str],
    response_params: dict[str, object],
) -> tuple[str, str | None]:
    """Return (action_name, action_line) parsed from the bridge response.

    ``action_name`` is one of ``WEBSHOP_ACTION`` / ``REPLY`` / ``""``.
    ``action_line`` is the WebShop action string (e.g. ``search[...]``) when
    relevant, otherwise ``None``.
    """
    chosen_action = ""
    for a in response_actions:
        upper = (a or "").strip().upper()
        if upper in _VALID_ACTIONS:
            chosen_action = upper
            break

    if not chosen_action:
        # Fall back to scanning the text for an XML-style <actions>...</actions>
        actions_block = _strip_xml_action_block(response_text or "", "actions")
        if actions_block:
            for a in re.split(r"[,\s]+", actions_block.upper()):
                if a in _VALID_ACTIONS:
                    chosen_action = a
                    break

    action_line: str | None = None
    # 1) Native tool-call clients (Hermes/OpenClaw/direct benchmark server
    #    paths) return OpenAI-style tool_calls. Prefer the explicit
    #    webshop_action command when present, but accept BENCHMARK_ACTION too
    #    because the TS bench plugin may normalize native calls to that shape.
    raw_tool_calls = response_params.get("tool_calls")
    if isinstance(raw_tool_calls, list):
        for call in raw_tool_calls:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            function_record = function if isinstance(function, dict) else {}
            name = str(
                call.get("name") or function_record.get("name") or ""
            ).strip()
            arguments = call.get("arguments", function_record.get("arguments"))
            if isinstance(arguments, str):
                try:
                    parsed = json.loads(arguments)
                except json.JSONDecodeError:
                    parsed = {}
                arguments = parsed
            if not isinstance(arguments, dict):
                continue
            if name.lower() not in {"webshop_action", "benchmark_action"}:
                continue
            cmd = arguments.get("command") or arguments.get("action")
            if isinstance(cmd, str) and cmd.strip():
                action_line = cmd.strip()
                break

    # 2) Bench server emits BENCHMARK_ACTION with {command: "..."} — that
    #    `command` IS our webshop action line. Check this first because the
    #    generic eliza agent always tags actions=BENCHMARK_ACTION when its
    #    benchmark plugin captured a structured action.
    if action_line is None:
        bench_params = response_params.get("BENCHMARK_ACTION")
        if isinstance(bench_params, dict):
            cmd = bench_params.get("command")
            if isinstance(cmd, str) and cmd.strip():
                action_line = cmd.strip()

    # 3) Some agents emit WEBSHOP_ACTION/{action: ...} directly.
    if action_line is None:
        action_params = response_params.get("WEBSHOP_ACTION") or response_params.get("action")
        if isinstance(action_params, dict):
            inner = action_params.get("action")
            if isinstance(inner, str) and inner.strip():
                action_line = inner.strip()
        elif isinstance(action_params, str) and action_params.strip():
            action_line = action_params.strip()

    # 4) XML <action>...</action> block in the text body.
    if action_line is None:
        xml_action = _strip_xml_action_block(response_text or "", "action")
        if xml_action:
            action_line = xml_action

    # 5) Last resort: find a recognisable action shape anywhere in the text.
    if action_line is None:
        shape_match = re.search(
            r"(search\[[^\]]+\]|click\[[^\]]+\]|"
            r"select_option\[[^,\]]+,\s*[^\]]+\]|\bback\b|\bbuy\b)",
            response_text or "",
            re.IGNORECASE,
        )
        if shape_match:
            action_line = shape_match.group(1).strip()

    # If we found any usable action shape, treat it as a WEBSHOP_ACTION even
    # if the bridge tagged the response as REPLY / BENCHMARK_ACTION — those
    # are generic-agent labels that don't override the parsed command.
    if action_line:
        chosen_action = "WEBSHOP_ACTION"

    return chosen_action, action_line


def _looks_like_webshop_action(action_line: str) -> bool:
    return bool(
        re.search(
            r"^(search\[[^\]]+\]|click\[[^\]]+\]|"
            r"select_option\[[^,\]]+,\s*[^\]]+\]|back|buy)$",
            action_line.strip(),
            re.IGNORECASE,
        )
    )


def _normalize_action_alias(
    action_line: str,
    observation: "PageObservation | None",
) -> str:
    """Map common model aliases onto exact upstream WebShop click actions."""
    raw = action_line.strip()
    if not observation:
        return raw
    available = list(observation.available_actions or [])
    by_lower = {a.lower(): a for a in available}
    exact = by_lower.get(raw.lower())
    if exact:
        return exact

    lowered = raw.lower()
    if lowered == "buy":
        return by_lower.get("click[buy now]", raw)
    if lowered == "back":
        return by_lower.get("click[back to search]", raw)

    match = re.match(r"select_option\[[^,\]]+,\s*([^\]]+)\]$", raw, re.IGNORECASE)
    if match:
        value = match.group(1).strip()
        return by_lower.get(f"click[{value.lower()}]", raw)

    return raw


def _webshop_context(
    *,
    task: "WebShopTask",
    observation: "PageObservation",
    obs_str: str,
    turn: int,
    model: str | None,
) -> dict[str, object]:
    return {
        "benchmark": "webshop",
        "task_id": task.task_id,
        "goal": task.instruction,
        "observation": obs_str,
        "actionSpace": list(observation.available_actions),
        "available_actions": list(observation.available_actions),
        "tools": [_webshop_action_tool_schema()],
        "tool_choice": "required",
        "turn": turn,
        "model_name": model,
        "instruction": task.instruction,
        "page": observation.page_type.value if observation else "",
        "budget": task.budget,
    }


def _selected_option_actions(
    action_history: list[str],
    observation: "PageObservation | None",
) -> list[str]:
    """Infer selected product options missing from upstream text observations."""
    if not observation:
        return []
    available = set(observation.available_actions or [])
    reserved = {
        "click[back to search]",
        "click[< prev]",
        "click[next >]",
        "click[description]",
        "click[features]",
        "click[reviews]",
        "click[buy now]",
    }
    selected: list[str] = []
    seen: set[str] = set()
    for action in action_history:
        lowered = action.lower()
        if action not in available:
            continue
        if not lowered.startswith("click["):
            continue
        if lowered in reserved or "__invalid__" in lowered:
            continue
        if action in seen:
            continue
        seen.add(action)
        selected.append(action)
    return selected


class ElizaBridgeWebShopAgent:
    """WebShop agent driven by the eliza TS bridge (no Python AgentRuntime)."""

    def __init__(
        self,
        env: "WebShopEnvironment",
        *,
        max_turns: int = 20,
        client: ElizaClient | None = None,
        model: str | None = None,
    ) -> None:
        self.env = env
        self.max_turns = max_turns
        self._client = client or ElizaClient()
        self._model = model
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def process_task(
        self, task: "WebShopTask"
    ) -> "tuple[list[EpisodeStep], str, PageObservation | None]":
        from elizaos_webshop.types import EpisodeStep

        if not self._initialized:
            await self.initialize()

        # Reset session for this task so prior task state doesn't bleed.
        try:
            self._client.reset(task_id=task.task_id, benchmark="webshop")
        except Exception as exc:
            logger.warning("[webshop-bridge] reset failed (continuing): %s", exc)

        observation = self.env.reset(task)
        steps: list[EpisodeStep] = []
        action_history: list[str] = []
        final_response = ""

        for turn in range(self.max_turns):
            obs_str = _format_observation(observation) if observation else ""
            history_str = "\n".join(
                f"  {i + 1}. {a}" for i, a in enumerate(action_history[-5:])
            )

            prompt_parts: list[str] = [
                "# Task",
                f"Instruction: {task.instruction}",
            ]
            if task.budget is not None:
                prompt_parts.append(f"Budget: under ${task.budget:.2f}")
            if task.goal_attributes:
                prompt_parts.append(
                    f"Goal attributes: {json.dumps(task.goal_attributes)}"
                )
            prompt_parts.append("\n# Current observation\n" + obs_str)
            if action_history:
                prompt_parts.append("\n# Recent actions\n" + history_str)
            selected_actions = _selected_option_actions(action_history, observation)
            if selected_actions:
                prompt_parts.append(
                    "\n# Selected product options\n"
                    + "\n".join(f"- {a}" for a in selected_actions)
                    + "\nIf all required product options are selected, choose click[buy now]."
                )
            prompt_parts.append(_SYSTEM_PROMPT)

            prompt = "\n".join(prompt_parts)

            try:
                response = self._client.send_message(
                    text=prompt,
                    context=_webshop_context(
                        task=task,
                        observation=observation,
                        obs_str=obs_str,
                        turn=turn,
                        model=self._model,
                    ),
                )
            except Exception as exc:
                logger.error(
                    "[webshop-bridge] bridge call failed at turn %d: %s",
                    turn,
                    exc,
                )
                final_response = f"Bridge error: {exc}"
                break

            logger.debug(
                "[webshop-bridge] turn=%d text_len=%d actions=%s params=%s",
                turn,
                len(response.text or ""),
                response.actions,
                {k: type(v).__name__ for k, v in response.params.items()},
            )
            chosen_action, action_line = _parse_action_from_response(
                response.text or "",
                response.actions,
                response.params,
            )

            if chosen_action == "REPLY" or (not chosen_action and not action_line):
                logger.warning(
                    "[webshop-bridge] turn %d: no parseable action; scoring invalid response %r",
                    turn,
                    (response.text or "")[:200],
                )
                action_line = "__invalid__"

            if not action_line:
                # Couldn't parse a usable action — give the agent one more turn
                # but log the misbehaviour.
                logger.warning(
                    "[webshop-bridge] turn %d: WEBSHOP_ACTION with no parseable "
                    "action line; response_text=%r",
                    turn,
                    (response.text or "")[:200],
                )
                action_history.append("[invalid action]")
                continue

            action_line = _normalize_action_alias(action_line, observation)
            if not _looks_like_webshop_action(action_line):
                logger.warning(
                    "[webshop-bridge] turn %d: scoring invalid action %r",
                    turn,
                    action_line,
                )

            outcome = self.env.step(action_line)
            steps.append(
                EpisodeStep(
                    action=action_line,
                    observation=outcome.observation,
                    reward=float(outcome.reward),
                    done=bool(outcome.done),
                    info=dict(outcome.info),
                )
            )
            action_history.append(action_line)
            observation = outcome.observation

            if outcome.done:
                final_response = (
                    f"Purchased {self.env.purchased_product_id or 'nothing'} "
                    f"with reward {self.env.final_reward:.2f}"
                )
                break

        return steps, final_response, observation

    async def close(self) -> None:
        self._initialized = False


def create_eliza_bridge_webshop_agent(
    env: "WebShopEnvironment",
    *,
    max_turns: int = 20,
    client: ElizaClient | None = None,
    model: str | None = None,
) -> ElizaBridgeWebShopAgent:
    """Factory matching the signature expected by the WebShop runner."""
    return ElizaBridgeWebShopAgent(
        env=env,
        max_turns=max_turns,
        client=client,
        model=model,
    )


__all__ = [
    "ElizaBridgeWebShopAgent",
    "create_eliza_bridge_webshop_agent",
]
