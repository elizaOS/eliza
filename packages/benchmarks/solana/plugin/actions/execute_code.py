"""EXECUTE_CODE action for running TypeScript Solana skills.

Provides both:
- execute_solana_skill(): shared execution function used by Phase 1 (deterministic)
  and Phase 2 (LLM-assisted via action handler)
- execute_code_action: ElizaOS Action registered in the solana-bench plugin
"""

from __future__ import annotations

import base64
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
    from voyager.surfpool_env import SurfpoolEnv

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Shared execution logic (used by both Phase 1 and Phase 2)
# ---------------------------------------------------------------------------


async def execute_solana_skill(
    code: str,
    env: SurfpoolEnv,
    code_file: str,
    timeout_ms: int,
) -> tuple[int, bool, dict[str, object]]:
    """Run TypeScript code, sign the resulting transaction, and submit to the validator.

    Returns:
        (reward, success, info) where *info* may contain:
          - ``"unique_instructions"``: ``dict[str, list[int]]`` — discovered pairs
          - ``"programs_interacted"``: ``list[str]`` — program IDs in the tx
          - ``"error"``: ``str`` — error description when *success* is False
    """
    # Lazy imports so the module can be loaded without sys.path side-effects.
    from benchmarks.solana.eliza_explorer import run_typescript_skill
    from solders.transaction import Transaction as SoldersTransaction

    blockhash = str((await env.client.get_latest_blockhash()).value.blockhash)
    agent_pubkey = str(env.agent_keypair.pubkey())

    result = run_typescript_skill(code, agent_pubkey, blockhash, code_file, timeout_ms)

    tx_data = result.get("serialized_tx")
    if not tx_data:
        error_msg = str(result)[:1000]
        logger.warning("No serialized tx: %s", error_msg[:400])
        return 0, False, {"error": error_msg}

    try:
        tx = SoldersTransaction.from_bytes(base64.b64decode(tx_data))
        signed = env._partial_sign_transaction(bytes(tx), [env.agent_keypair])
        _obs, reward, _, _, info = await env.step(signed)
    except Exception as exc:
        error_msg = f"Transaction submission failed: {exc}"
        logger.warning(error_msg)
        return 0, False, {"error": error_msg}

    logger.info(
        "Skill result: reward=%d  total=%d  programs=%s",
        reward,
        env.total_reward,
        info.get("programs_interacted", []),
    )
    return int(reward), True, dict(info)


# ---------------------------------------------------------------------------
# Action handler (Phase 2 — called by runtime via handle_message)
# ---------------------------------------------------------------------------


async def _validate_execute_code(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that the Solana environment is available in runtime settings."""
    env = runtime.get_setting("SURFPOOL_ENV")
    return env is not None


async def _handle_execute_code(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Execute TypeScript code against the Solana validator."""
    _ = message, state, responses

    # -- Extract code parameter ------------------------------------------
    code = ""
    if options and options.parameters:
        code = str(options.parameters.get("code", ""))

    if not code:
        return ActionResult(
            text="No code provided",
            success=False,
            error="Missing required parameter: code",
        )

    # -- Retrieve environment & config from runtime settings -------------
    env = runtime.get_setting("SURFPOOL_ENV")
    if env is None:
        return ActionResult(
            text="Solana environment not available",
            success=False,
            error="SURFPOOL_ENV not configured in runtime",
        )

    code_file = str(runtime.get_setting("CODE_FILE") or "")
    if not code_file:
        return ActionResult(
            text="Code file path not configured",
            success=False,
            error="CODE_FILE not set in runtime",
        )

    timeout_ms = int(runtime.get_setting("TIMEOUT_MS") or 30000)

    # -- Execute ---------------------------------------------------------
    reward, success, info = await execute_solana_skill(
        code=code,
        env=env,
        code_file=code_file,
        timeout_ms=timeout_ms,
    )

    # Store structured result so the agent loop can read it after handle_message
    runtime.set_setting("LAST_EXECUTION_RESULT", {
        "reward": reward,
        "success": success,
        "info": info,
    })

    # -- Build human-readable feedback -----------------------------------
    if success and reward > 0:
        result_text = (
            f"Reward: {reward}. Total: {env.total_reward}. "
            f"Programs: {info.get('programs_interacted', [])}."
        )
    elif success:
        result_text = f"reward=0. Total: {env.total_reward}. No new discoveries."
    else:
        result_text = f"Execution failed: {info.get('error', 'unknown')}"

    response = Content(
        text=result_text,
        actions=["EXECUTE_CODE"],
    )
    if callback:
        await callback(response)

    error_field = info.get("error")
    return ActionResult(
        text=result_text,
        values={
            "reward": str(reward),
            "totalReward": str(env.total_reward),
        },
        data={
            "actionName": "EXECUTE_CODE",
            "reward": reward,
            "totalReward": env.total_reward,
            "success": success,
        },
        success=success,
        error=str(error_field) if error_field else None,
    )


# ---------------------------------------------------------------------------
# Action definition
# ---------------------------------------------------------------------------

execute_code_action = Action(
    name="EXECUTE_CODE",
    description=(
        "Execute TypeScript code against a Solana validator. The code must export "
        "an async function `executeSkill(blockhash: string): Promise<string>` that "
        "returns a base64-encoded serialized transaction. The action handles signing "
        "and submission automatically, returning the reward earned."
    ),
    similes=["RUN_CODE", "EXECUTE_SKILL", "RUN_SKILL", "SOLANA_EXECUTE"],
    validate=_validate_execute_code,
    handler=_handle_execute_code,
    parameters=[
        ActionParameter(
            name="code",
            description="TypeScript code with an executeSkill function",
            required=True,
            schema=ActionParameterSchema(
                type="string",
                description=(
                    "TypeScript source that exports: "
                    "export async function executeSkill(blockhash: string): Promise<string>"
                ),
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Discover Memo program interactions"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Executing Memo program skill...",
                    actions=["EXECUTE_CODE"],
                ),
            ),
        ],
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Explore Token-2022 extensions"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Running Token-2022 extension discovery...",
                    actions=["EXECUTE_CODE"],
                ),
            ),
        ],
    ],
)
