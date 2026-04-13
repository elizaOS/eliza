"""EXECUTE_CODE action for running TypeScript EVM skills via Bun."""

from __future__ import annotations

import json
import logging
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


async def _validate_execute_code(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that we have an AnvilEnv and code file path configured."""
    env = runtime.get_setting("ANVIL_ENV")
    code_file = runtime.get_setting("CODE_FILE")
    return env is not None and code_file is not None


async def _handle_execute_code(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """
    Execute TypeScript code on the EVM chain.

    Writes the code to a file, runs it via Bun's runSkill.ts runner,
    processes the result through the AnvilEnv for reward calculation,
    and returns the step result as feedback.
    """
    _ = message, state, responses

    # Extract code from parameters
    code = ""
    if options and options.parameters:
        code = str(options.parameters.get("code", ""))

    if not code.strip():
        error_msg = "No TypeScript code provided. Include code in the EXECUTE_CODE parameters."
        if callback:
            await callback(Content(text=error_msg, actions=["EXECUTE_CODE"]))
        return ActionResult(
            text=error_msg,
            success=False,
            error="Missing required parameter: code",
        )

    # Get runtime settings
    env = runtime.get_setting("ANVIL_ENV")
    if env is None:
        error_msg = "AnvilEnv not available in runtime settings."
        if callback:
            await callback(Content(text=error_msg, actions=["EXECUTE_CODE"]))
        return ActionResult(
            text=error_msg,
            success=False,
            error="ANVIL_ENV not configured",
        )

    code_file = runtime.get_setting("CODE_FILE")
    if not isinstance(code_file, str) or not code_file:
        error_msg = "CODE_FILE not configured in runtime settings."
        if callback:
            await callback(Content(text=error_msg, actions=["EXECUTE_CODE"]))
        return ActionResult(
            text=error_msg,
            success=False,
            error="CODE_FILE not configured",
        )

    timeout_ms_setting = runtime.get_setting("TIMEOUT_MS")
    timeout_ms = int(timeout_ms_setting) if timeout_ms_setting is not None else 30000

    # Execute the TypeScript skill
    from benchmarks.evm.eliza_explorer import run_typescript_skill

    logger.info("Executing TypeScript skill (%d bytes of code)", len(code))

    result = run_typescript_skill(
        code=code,
        rpc_url=env.rpc_url,
        private_key=env.agent_private_key,
        chain_id=env.chain_id,
        code_file=code_file,
        timeout_ms=timeout_ms,
    )

    # Process through AnvilEnv for reward calculation
    step_result = await env.step(json.dumps(result))

    # Store the step result for the main loop to read
    runtime.set_setting("LAST_STEP_RESULT", step_result)

    # Build feedback text
    feedback_parts: list[str] = []

    if step_result.error:
        feedback_parts.append(f"Execution error: {step_result.error[:500]}")
    elif step_result.reward > 0:
        feedback_parts.append(
            f"Reward: +{step_result.reward} (total: {env.total_reward}). "
            f"Transactions: {len(step_result.tx_results)}."
        )
        if step_result.unique_selectors:
            for addr, sels in step_result.unique_selectors.items():
                feedback_parts.append(f"  New selectors on {addr[:12]}...: {', '.join(sels)}")
        if step_result.deployed_contracts:
            for addr, ctype in step_result.deployed_contracts.items():
                feedback_parts.append(f"  Deployed: {addr[:12]}... ({ctype})")
    else:
        feedback_parts.append(
            f"Reward: 0 (total: {env.total_reward}). "
            f"No new unique (address, selector) pairs discovered. "
            f"Try different function selectors or deploy new contracts."
        )

    feedback_text = "\n".join(feedback_parts)

    response_content = Content(
        text=feedback_text,
        actions=["EXECUTE_CODE"],
    )

    if callback:
        await callback(response_content)

    # Build result data
    result_data: dict[str, str | int | bool | dict[str, list[str]] | dict[str, str]] = {
        "actionName": "EXECUTE_CODE",
        "reward": step_result.reward,
        "totalReward": env.total_reward,
        "txCount": len(step_result.tx_results),
        "error": step_result.error,
    }

    return ActionResult(
        text=f"Executed EVM skill: reward={step_result.reward}, total={env.total_reward}",
        values={
            "reward": str(step_result.reward),
            "totalReward": str(env.total_reward),
            "txCount": str(len(step_result.tx_results)),
        },
        data=result_data,
        success=not bool(step_result.error),
        error=step_result.error if step_result.error else None,
    )


execute_code_action = Action(
    name="EXECUTE_CODE",
    description=(
        "Execute TypeScript code on the EVM chain. The code is written to a file "
        "and run via Bun. It must export an executeSkill function that returns JSON "
        "with transaction results. Use this to deploy contracts, call functions, "
        "and discover unique (address, selector) pairs for rewards."
    ),
    similes=["RUN_CODE", "EXECUTE_SKILL", "RUN_TYPESCRIPT", "EVM_EXECUTE"],
    validate=_validate_execute_code,
    handler=_handle_execute_code,
    parameters=[
        ActionParameter(
            name="code",
            description="TypeScript code to execute on the EVM chain",
            required=True,
            schema=ActionParameterSchema(
                type="string",
                description=(
                    "TypeScript code using viem that exports: "
                    "async function executeSkill(rpcUrl: string, privateKey: string, "
                    "chainId: number): Promise<string>. "
                    "Must return JSON: { results: [{txHash, to, selector, success, deployedAddress?}], error: null }"
                ),
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Deploy an ERC20 token and call its mint function"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Deploying ERC20 and calling mint...",
                    actions=["EXECUTE_CODE"],
                ),
            ),
        ],
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Call precompile contracts to discover new selectors"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Calling EVM precompiles...",
                    actions=["EXECUTE_CODE"],
                ),
            ),
        ],
    ],
)
