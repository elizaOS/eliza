"""
GENERATE_PLAN action – takes a trading scenario description and produces
a JSON trading plan in the format expected by the Rust ``hl-runner``.

The LLM response text is parsed to extract the JSON plan.  The plan is
validated against the schema before being stored in the runtime for
subsequent execution by ``EXECUTE_PLAN``.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING

from elizaos.types import (
    Action,
    ActionExample,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    Content,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

logger = logging.getLogger(__name__)

# Constraints mirrored from crates/hl-runner/src/llm/mod.rs
_MAX_ORDER_SIZE = 1.0
_MIN_ORDER_SIZE = 0.0001
_MAX_LEVERAGE = 20


def _coerce_scenario(value: object) -> object | None:
    from benchmarks.HyperliquidBench.types import ScenarioKind, TradingScenario

    if isinstance(value, TradingScenario):
        return value
    if isinstance(value, dict):
        kind_raw = value.get("kind", ScenarioKind.CUSTOM.value)
        if isinstance(kind_raw, ScenarioKind):
            kind = kind_raw
        else:
            try:
                kind = ScenarioKind(str(kind_raw))
            except ValueError:
                kind = ScenarioKind.CUSTOM
        return TradingScenario(
            scenario_id=str(value.get("scenario_id", value.get("scenarioId", "unknown"))),
            kind=kind,
            description=str(value.get("description", "")),
            allowed_coins=[str(item) for item in value.get("allowed_coins", value.get("allowedCoins", []))],
            max_steps=int(value.get("max_steps", value.get("maxSteps", 5))),
            builder_code=str(value["builder_code"]) if value.get("builder_code") is not None else None,
            plan_spec=str(value["plan_spec"]) if value.get("plan_spec") is not None else None,
            hian_prompt_path=str(value["hian_prompt_path"]) if value.get("hian_prompt_path") is not None else None,
        )
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return _coerce_scenario(parsed)
    return None

_VALID_SIDES = {"buy", "sell"}
_VALID_TIFS = {"ALO", "GTC", "IOC", "Alo", "Gtc", "Ioc", "alo", "gtc", "ioc"}
_VALID_STEP_KEYS = {
    "perp_orders",
    "cancel_last",
    "cancel_oids",
    "cancel_all",
    "usd_class_transfer",
    "set_leverage",
    "sleep_ms",
}


def _extract_json_plan(raw_text: str) -> dict[str, list[dict[str, object]]]:
    """
    Extract a JSON plan from potentially messy LLM output.

    Handles markdown code fences, leading commentary, etc.
    """
    # Try to find JSON inside code fences first
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)```", raw_text, re.DOTALL)
    candidate = fence_match.group(1).strip() if fence_match else raw_text.strip()

    # Find the first '{' and last '}'
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in LLM response")

    json_str = candidate[start : end + 1]
    parsed: dict[str, object] = json.loads(json_str)

    if "steps" not in parsed:
        raise ValueError("Plan JSON must contain a 'steps' key")
    steps = parsed["steps"]
    if not isinstance(steps, list) or len(steps) == 0:
        raise ValueError("Plan must have at least one step")

    return {"steps": steps}  # type: ignore[return-value]


def _validate_plan(
    plan: dict[str, list[dict[str, object]]],
    allowed_coins: list[str],
    max_steps: int,
) -> list[str]:
    """
    Validate a parsed plan dict.  Returns a list of error strings (empty == valid).
    """
    errors: list[str] = []
    steps = plan.get("steps", [])
    if len(steps) > max_steps:
        errors.append(f"Plan has {len(steps)} steps but max is {max_steps}")

    upper_coins = {c.upper() for c in allowed_coins}

    for idx, step in enumerate(steps):
        if not isinstance(step, dict) or len(step) != 1:
            errors.append(f"Step {idx}: must be a dict with exactly one key")
            continue

        key = next(iter(step))
        if key not in _VALID_STEP_KEYS:
            errors.append(f"Step {idx}: unknown step kind '{key}'")
            continue

        payload = step[key]
        if not isinstance(payload, dict):
            errors.append(f"Step {idx}: '{key}' payload must be a dict")
            continue

        if key == "perp_orders":
            orders = payload.get("orders", [])
            if not isinstance(orders, list) or len(orders) == 0:
                errors.append(f"Step {idx}: perp_orders must have >=1 order")
                continue
            for oi, order in enumerate(orders):
                coin = str(order.get("coin", "")).upper()
                if coin not in upper_coins:
                    errors.append(f"Step {idx} order {oi}: coin '{coin}' not allowed")
                side = str(order.get("side", "")).lower()
                if side not in _VALID_SIDES:
                    errors.append(f"Step {idx} order {oi}: invalid side '{side}'")
                tif = str(order.get("tif", "GTC"))
                if tif not in _VALID_TIFS:
                    errors.append(f"Step {idx} order {oi}: invalid tif '{tif}'")
                sz = order.get("sz", 0)
                if isinstance(sz, (int, float)):
                    if sz < _MIN_ORDER_SIZE or sz > _MAX_ORDER_SIZE:
                        errors.append(
                            f"Step {idx} order {oi}: sz {sz} out of "
                            f"[{_MIN_ORDER_SIZE}, {_MAX_ORDER_SIZE}]"
                        )

        elif key == "set_leverage":
            lev = payload.get("leverage", 0)
            if isinstance(lev, (int, float)):
                if int(lev) < 1 or int(lev) > _MAX_LEVERAGE:
                    errors.append(
                        f"Step {idx}: leverage {lev} must be in [1, {_MAX_LEVERAGE}]"
                    )

    return errors


async def _validate_generate_plan(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that we have a scenario to generate a plan for."""
    scenario = _coerce_scenario(runtime.get_setting("CURRENT_SCENARIO"))
    return scenario is not None


async def _handle_generate_plan(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """
    Parse the LLM's text response to extract a JSON trading plan, validate it,
    and store it in runtime settings for the EXECUTE_PLAN action.
    """
    _ = state, options, responses
    scenario = _coerce_scenario(runtime.get_setting("CURRENT_SCENARIO"))
    if scenario is None:
        return ActionResult(
            text="No trading scenario configured",
            success=False,
            error="CURRENT_SCENARIO not set in runtime",
        )

    # The plan text should be in the agent's response (message.content.text)
    raw_text = ""
    if message.content and message.content.text:
        raw_text = message.content.text

    if not raw_text:
        return ActionResult(
            text="No plan text provided",
            success=False,
            error="Message content is empty – cannot extract plan",
        )

    # Extract and validate the JSON plan
    try:
        plan_dict = _extract_json_plan(raw_text)
    except (json.JSONDecodeError, ValueError) as exc:
        error_msg = f"Failed to parse plan JSON: {exc}"
        logger.warning(error_msg)
        if callback:
            await callback(Content(text=error_msg, actions=["GENERATE_PLAN"]))
        return ActionResult(text=error_msg, success=False, error=error_msg)

    validation_errors = _validate_plan(
        plan_dict, scenario.allowed_coins, scenario.max_steps
    )
    if validation_errors:
        error_msg = "Plan validation failed:\n" + "\n".join(
            f"  - {e}" for e in validation_errors
        )
        logger.warning(error_msg)
        if callback:
            await callback(Content(text=error_msg, actions=["GENERATE_PLAN"]))
        return ActionResult(text=error_msg, success=False, error=error_msg)

    # Store the plan for EXECUTE_PLAN
    plan_json = json.dumps(plan_dict, separators=(",", ":"))
    runtime.set_setting("CURRENT_PLAN_JSON", plan_json)
    runtime.set_setting("CURRENT_PLAN_DICT", plan_dict)

    step_count = len(plan_dict["steps"])
    step_kinds = [next(iter(s)) for s in plan_dict["steps"]]
    summary = (
        f"Generated valid plan with {step_count} steps: {', '.join(step_kinds)}"
    )
    logger.info(summary)

    if callback:
        await callback(
            Content(
                text=f"{summary}\n\n```json\n{json.dumps(plan_dict, indent=2)}\n```",
                actions=["GENERATE_PLAN"],
            )
        )

    return ActionResult(
        text=summary,
        values={
            "stepCount": step_count,
            "stepKinds": step_kinds,
        },
        data={
            "actionName": "GENERATE_PLAN",
            "plan": plan_dict,
            "stepCount": step_count,
        },
        success=True,
    )


generate_plan_action = Action(
    name="GENERATE_PLAN",
    description=(
        "Parse and validate a JSON trading plan for Hyperliquid from the agent's "
        "response text. The plan must conform to the hl-runner schema with steps "
        "like perp_orders, cancel_last, set_leverage, usd_class_transfer, etc."
    ),
    similes=["CREATE_PLAN", "MAKE_PLAN", "TRADING_PLAN"],
    validate=_validate_generate_plan,
    handler=_handle_generate_plan,
    parameters=[
        ActionParameter(
            name="plan_json",
            description="Optional explicit JSON plan string (otherwise extracted from message text)",
            required=False,
            schema=ActionParameterSchema(
                type="string",
                description="Raw JSON plan conforming to the hl-runner schema",
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(
                    text=(
                        "Generate a coverage plan that places an ALO buy and GTC sell "
                        "on ETH, then cancels the last order."
                    )
                ),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text=(
                        '{"steps":[{"perp_orders":{"orders":[{"coin":"ETH","side":"buy",'
                        '"tif":"ALO","sz":0.01,"reduceOnly":false,"px":"mid-1.0%",'
                        '"trigger":{"kind":"none"}}]}},{"cancel_last":{}}]}'
                    ),
                    actions=["GENERATE_PLAN"],
                ),
            ),
        ],
    ],
)
