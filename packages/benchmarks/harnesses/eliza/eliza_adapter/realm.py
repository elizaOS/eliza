"""REALM-Bench agent backed by the eliza benchmark server.

Drop-in replacement for ``REALMAgent`` — same ``solve_task`` interface
but routes planning decisions through the eliza TypeScript
benchmark server (``ElizaClient.send_message``) instead of the Python
``elizaos`` runtime.

REALM has a clear LLM-driven decision point: each iteration the agent
selects one of GENERATE_PLAN / EXECUTE_STEP / ADAPT_PLAN / COMPLETE_TASK.
We emulate that loop here, sending the task context + planning state
to the TS bridge each turn and parsing the selected action from the
response (``actions[0]`` if present, else extracted from the response
text). This adapter has no tool executor: proposed steps are not effect
receipts. Only the independent per-problem evaluator establishes success.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING, Optional

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.realm.types import (
        ExecutionModel,
        PlanningTrajectory,
        REALMTask,
        REALMTestCase,
    )


def _realm_types():
    """Lazy import of benchmarks.realm.types to avoid requiring benchmarks/ on sys.path at module load."""
    from benchmarks.realm.types import (
        ExecutionModel,
        PlanningAction,
        PlanningStep,
        PlanningTrajectory,
        REALMTask,
        REALMTestCase,
    )

    return (
        ExecutionModel,
        PlanningAction,
        PlanningStep,
        PlanningTrajectory,
        REALMTask,
        REALMTestCase,
    )


logger = logging.getLogger(__name__)


_VALID_ACTIONS = {
    "GENERATE_PLAN",
    "EXECUTE_STEP",
    "ADAPT_PLAN",
    "COMPLETE_TASK",
    "REPLY",
}


def _benchmark_action_params(params: dict[str, object]) -> dict[str, object]:
    """Return params captured under BENCHMARK_ACTION, if present."""
    nested = params.get("BENCHMARK_ACTION")
    if isinstance(nested, dict):
        return nested
    return params


def _extract_benchmark_action(
    params: dict[str, object],
    task_tools: list[str],
) -> tuple[str | None, str | None]:
    """Extract a REALM control action or concrete tool name from bridge params."""
    bench_params = _benchmark_action_params(params)
    tool_set = {tool.lower(): tool for tool in task_tools}
    for key in ("action", "name", "command", "tool_name", "operation"):
        raw = bench_params.get(key)
        if not isinstance(raw, str) or not raw.strip():
            continue
        value = raw.strip()
        upper = value.upper()
        if upper in _VALID_ACTIONS:
            return upper, None
        if value.lower() in tool_set:
            return None, tool_set[value.lower()]
    return None, None


def _extract_action(text: str) -> str | None:
    """Find the first valid REALM action name in *text*."""
    if not text:
        return None
    upper = text.upper()
    # Prefer XML-style <actions>NAME</actions>
    m = re.search(r"<actions>\s*([A-Z_]+)\s*</actions>", upper)
    if m:
        candidate = m.group(1).strip()
        if candidate in _VALID_ACTIONS:
            return candidate
    # Fall back to the first action keyword anywhere in the text.
    for action in ("GENERATE_PLAN", "EXECUTE_STEP", "ADAPT_PLAN", "COMPLETE_TASK", "REPLY"):
        if action in upper:
            return action
    return None


def _parse_plan_json(text: str, available_tools: list[str]) -> list[dict[str, object]]:
    """Parse a JSON array plan from the LLM response.

    Mirrors ``benchmarks.realm.plugin.actions._parse_plan_json`` so the
    eliza-adapter mode produces the same plan shape as the canonical
    Python runtime path.
    """
    if not text or not text.strip():
        return []

    json_text: str | None = None
    for pattern in (r"```json\s*(.*?)```", r"```\s*(.*?)```", r"\[\s*\{.*?\}\s*\]"):
        match = re.search(pattern, text, re.DOTALL)
        if match:
            json_text = match.group(1) if "```" in pattern else match.group(0)
            break
    if json_text is None:
        json_text = text

    json_text = json_text.strip()
    if not json_text.startswith("["):
        start = json_text.find("[")
        end = json_text.rfind("]")
        if start != -1 and end != -1:
            json_text = json_text[start : end + 1]
    json_text = re.sub(r",\s*([\]}])", r"\1", json_text)

    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        return []

    if isinstance(parsed, dict):
        parsed = parsed.get("actions") or parsed.get("plan") or parsed.get("steps")

    if not isinstance(parsed, list):
        return []

    plan: list[dict[str, object]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        action_name = item.get("action") or item.get("tool") or item.get("name")
        if not isinstance(action_name, str) or action_name not in available_tools:
            continue
        plan.append({
            "action": action_name,
            "description": str(item.get("description", "")),
            "parameters": item.get("parameters", {}),
        })
    return plan


def _measured_tokens(usage: object) -> int | None:
    """Return complete measured usage; absent or malformed counts stay unknown."""
    if not isinstance(usage, dict):
        return None
    def count(*keys: str) -> int | None:
        for key in keys:
            if key in usage:
                value = usage[key]
                return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
        return None
    total = count("total_tokens", "totalTokens")
    if total is not None:
        return total
    prompt = count("prompt_tokens", "promptTokens", "input_tokens", "inputTokens")
    completion = count("completion_tokens", "completionTokens", "output_tokens", "outputTokens")
    return prompt + completion if prompt is not None and completion is not None else None


class ElizaREALMAgent:
    """REALM benchmark agent that delegates planning to the eliza TS server.

    Drop-in replacement for ``benchmarks.realm.agent.REALMAgent`` — same
    ``solve_task`` interface returning a ``PlanningTrajectory``, but each
    LLM call is forwarded to the eliza benchmark HTTP server via
    ``ElizaClient.send_message``.
    """

    def __init__(
        self,
        client: ElizaClient | None = None,
        max_steps: int = 15,
        execution_model: "ExecutionModel | None" = None,
        enable_adaptation: bool = True,
    ) -> None:
        self._client = client or ElizaClient()
        self.max_steps = max_steps
        if execution_model is None:
            ExecutionModelCls, *_ = _realm_types()
            execution_model = ExecutionModelCls.DAG
        self.execution_model = execution_model
        self.enable_adaptation = enable_adaptation
        self._initialized = False

    async def initialize(self) -> None:
        """Verify the eliza server is reachable."""
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def solve_task(
        self,
        task: REALMTask,
        test_case: Optional[REALMTestCase] = None,
    ) -> PlanningTrajectory:
        if not self._initialized:
            await self.initialize()

        _, _, _, PlanningTrajectory, *_ = _realm_types()

        start_time = time.time()
        trajectory = PlanningTrajectory(task_id=task.id)
        trajectory.start_time_ms = start_time * 1000

        # Reset eliza session for this task
        self._client.reset(task_id=task.id, benchmark="realm")

        message_text = task.goal
        if test_case:
            msg_raw = test_case.input.get("message")
            if isinstance(msg_raw, str):
                message_text = msg_raw

        plan: list[dict[str, object]] = []
        executed_steps: list[dict[str, object]] = []
        adaptation_count = 0
        measured_tokens = 0
        usage_complete = True
        last_action_text = ""

        try:
            max_iterations = self.max_steps * 2
            for iteration in range(max_iterations):
                if iteration == 0:
                    msg = (
                        f"Please solve this REALM planning task.\n\n"
                        f"GOAL: {message_text}\n\n"
                        f"Start by using GENERATE_PLAN to create a step-by-step plan."
                    )
                else:
                    msg = (
                        f"Previous action result:\n{last_action_text}\n\n"
                        f"Decide on the next action based on the current planning state."
                    )

                context: dict[str, object] = {
                    "benchmark": "realm",
                    "task_id": task.id,
                    "task_name": task.name,
                    "task_description": task.description,
                    # The new taxonomy uses ``problem`` (P1..P11).
                    # ``task_category`` is kept for back-compat with the
                    # TS bridge prompt templates.
                    "task_problem": getattr(task, "problem", task.category).value,
                    "task_category": getattr(task, "problem", task.category).value,
                    "task_goal": message_text,
                    "available_tools": task.available_tools,
                    "constraints": task.constraints,
                    "requirements": task.requirements,
                    # New: raw upstream instance so the LLM can reason
                    # over distances / time windows / job matrices etc.
                    "instance": getattr(task, "instance", {}),
                    "num_agents": getattr(task, "num_agents", 1),
                    "max_steps": task.max_steps,
                    "current_plan": plan,
                    "executed_steps": executed_steps,
                    "adaptation_count": adaptation_count,
                    "iteration": iteration,
                    "valid_actions": sorted(_VALID_ACTIONS),
                }

                response = self._client.send_message(text=msg, context=context)
                usage = response.params.get("usage") if isinstance(response.params, dict) else None
                turn_tokens = _measured_tokens(usage)
                if turn_tokens is None:
                    usage_complete = False
                else:
                    measured_tokens += turn_tokens
                trajectory.tokens_used = measured_tokens if usage_complete else None

                # Resolve the selected action: explicit actions[0] wins,
                # else parse from response text/thought.
                selected_action: str | None = None
                if response.actions:
                    candidate = str(response.actions[0]).strip().upper()
                    if candidate in _VALID_ACTIONS:
                        selected_action = candidate
                    elif candidate == "BENCHMARK_ACTION":
                        selected_action, _direct_tool_name = _extract_benchmark_action(
                            response.params,
                            task.available_tools,
                        )
                if selected_action is None:
                    for source in (response.text, response.thought):
                        if source:
                            selected_action = _extract_action(source)
                            if selected_action:
                                break
                logger.info(
                    "[eliza-realm] Iteration %d: action=%s",
                    iteration + 1,
                    selected_action,
                )

                # Dispatch the selected action against our plan/executed-step state.
                if selected_action == "GENERATE_PLAN":
                    parsed_plan = _parse_plan_json(response.text or "", task.available_tools)
                    bench_params = _benchmark_action_params(response.params)
                    raw_plan = response.params.get("plan") or bench_params.get("plan")
                    if not parsed_plan and raw_plan:
                        if isinstance(raw_plan, list):
                            parsed_plan = _parse_plan_json(
                                json.dumps(raw_plan), task.available_tools
                            )
                    plan = parsed_plan
                    last_action_text = (
                        f"Generated plan with {len(plan)} steps"
                    )

                elif selected_action == "EXECUTE_STEP":
                    last_action_text = (
                        "No tool executor is configured for this planning benchmark. "
                        "No action was executed. Submit a structured solution with "
                        "COMPLETE_TASK for independent constraint evaluation."
                    )

                elif selected_action == "ADAPT_PLAN":
                    last_action_text = (
                        "Submit a revised structured solution for independent evaluation. "
                        "An adaptation request alone does not establish a successful replan."
                    )

                elif selected_action == "COMPLETE_TASK":
                    # Capture an optional solution payload from the bridge
                    # response, so the new extrinsic evaluator can score
                    # the agent against the oracle.
                    bench_params = _benchmark_action_params(response.params)
                    raw_sol = (
                        response.params.get("solution")
                        or bench_params.get("solution")
                    )
                    if isinstance(raw_sol, dict):
                        trajectory.solution = raw_sol
                    elif isinstance(response.text, str) and response.text.strip().startswith("{"):
                        try:
                            maybe = json.loads(response.text)
                            if isinstance(maybe, dict):
                                trajectory.solution = maybe
                        except json.JSONDecodeError:
                            pass
                    logger.info("[eliza-realm] Task completed via COMPLETE_TASK action")
                    break

                else:
                    last_action_text = response.text or "(no action selected)"

                # Bail once we have hit the planning step budget.
                if len(executed_steps) >= self.max_steps:
                    logger.info(
                        "[eliza-realm] Max steps (%d) reached; finishing.",
                        self.max_steps,
                    )
                    break

            trajectory.adaptation_count = adaptation_count
            trajectory.duration_ms = (time.time() - start_time) * 1000
            trajectory.overall_success = False
            trajectory.final_outcome = (
                "Solution submitted; awaiting independent evaluation"
                if trajectory.solution else "No structured solution submitted"
            )

        except Exception as exc:
            trajectory.final_outcome = f"Task failed: {exc}"
            trajectory.overall_success = False
            trajectory.duration_ms = (time.time() - start_time) * 1000
            logger.error("[eliza-realm] Task %s failed: %s", task.id, exc)

        trajectory.end_time_ms = time.time() * 1000
        return trajectory

    async def close(self) -> None:
        """No-op — the server manager handles cleanup."""
        pass
