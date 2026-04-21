"""
EXECUTE_PLAN action – shells out to the Rust ``hl-runner`` binary to execute
a plan, then runs the ``hl-evaluator`` to score the result.

The plan JSON is written to a temporary file, the runner is invoked as a
subprocess, and the evaluator scores the runner's ``per_action.jsonl``
output.  All results are captured and fed back to the agent.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path
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


def _coerce_bench_root(value: object, fallback: Path) -> Path:
    if isinstance(value, Path):
        return value
    if isinstance(value, str) and value.strip():
        return Path(value)
    return fallback


def _coerce_bench_config(value: object) -> object:
    from benchmarks.HyperliquidBench.types import HLBenchConfig

    if isinstance(value, HLBenchConfig):
        return value
    if isinstance(value, dict):
        config_data = dict(value)
        if "bench_root" in config_data and isinstance(config_data["bench_root"], str):
            config_data["bench_root"] = Path(config_data["bench_root"])
        return HLBenchConfig(**config_data)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return HLBenchConfig()
        return _coerce_bench_config(parsed)
    return HLBenchConfig()


async def _run_subprocess(
    cmd: list[str],
    cwd: Path,
    timeout_seconds: int = 120,
) -> tuple[int, str, str]:
    """Run a subprocess and return ``(exit_code, stdout, stderr)``."""
    logger.info("Running: %s  (cwd=%s)", " ".join(cmd), cwd)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ},
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=timeout_seconds
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return -1, "", f"Subprocess timed out after {timeout_seconds}s"

    exit_code = proc.returncode if proc.returncode is not None else -1
    return (
        exit_code,
        stdout_bytes.decode("utf-8", errors="replace"),
        stderr_bytes.decode("utf-8", errors="replace"),
    )


def _find_cargo_binary(bench_root: Path, crate_name: str) -> list[str]:
    """
    Build the command to invoke a cargo binary.

    Prefers a pre-built release binary under ``target/release/``, falls back
    to ``cargo run -p <crate_name> --release --``.
    """
    release_bin = bench_root / "target" / "release" / crate_name
    if release_bin.exists():
        return [str(release_bin)]
    return ["cargo", "run", "-p", crate_name, "--release", "--"]


async def _run_hl_runner(
    plan_json: str,
    bench_root: Path,
    out_dir: Path,
    demo: bool = True,
    network: str = "testnet",
    builder_code: str | None = None,
    effect_timeout_ms: int = 2000,
) -> tuple[int, str, str]:
    """Write the plan to a temp file and invoke ``hl-runner``."""
    # Write plan to a temporary JSON file
    plan_file = out_dir / "plan_input.json"
    plan_file.parent.mkdir(parents=True, exist_ok=True)
    plan_file.write_text(plan_json)

    cmd = _find_cargo_binary(bench_root, "hl-runner")
    cmd.extend(["--plan", str(plan_file), "--out", str(out_dir)])

    if demo:
        cmd.append("--demo")
    else:
        cmd.extend(["--network", network])

    if builder_code:
        cmd.extend(["--builder-code", builder_code])

    cmd.extend(["--effect-timeout-ms", str(int(effect_timeout_ms))])

    return await _run_subprocess(cmd, cwd=bench_root, timeout_seconds=120)


async def _run_hl_evaluator(
    bench_root: Path,
    per_action_path: Path,
    domains_path: Path,
    out_dir: Path,
) -> tuple[int, str, str]:
    """Invoke ``hl-evaluator`` on the runner artifacts."""
    cmd = _find_cargo_binary(bench_root, "hl-evaluator")
    cmd.extend([
        "--input", str(per_action_path),
        "--domains", str(domains_path),
        "--out-dir", str(out_dir),
    ])
    return await _run_subprocess(cmd, cwd=bench_root, timeout_seconds=60)


async def _validate_execute_plan(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that we have a plan ready to execute."""
    plan = runtime.get_setting("CURRENT_PLAN_JSON")
    return plan is not None and len(str(plan)) > 2


async def _handle_execute_plan(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """
    Execute the current plan via the Rust hl-runner, then score it with
    hl-evaluator.  Stores the result for the HL_CONTEXT provider to
    surface in the next iteration.
    """
    _ = message, state, options, responses

    from benchmarks.HyperliquidBench.types import HLBenchConfig

    plan_json: str | None = runtime.get_setting("CURRENT_PLAN_JSON")
    if not plan_json:
        return ActionResult(
            text="No plan to execute – run GENERATE_PLAN first",
            success=False,
            error="CURRENT_PLAN_JSON not set",
        )

    config = _coerce_bench_config(runtime.get_setting("BENCH_CONFIG"))
    bench_root = _coerce_bench_root(runtime.get_setting("BENCH_ROOT"), config.bench_root)

    # Create a timestamped output directory
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = bench_root / config.runs_dir / f"eliza-{timestamp}"
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Step 1: Run hl-runner ──────────────────────────────────────
    runner_exit, runner_stdout, runner_stderr = await _run_hl_runner(
        plan_json=plan_json,
        bench_root=bench_root,
        out_dir=out_dir,
        demo=config.demo_mode,
        network=config.network,
        builder_code=config.builder_code,
        effect_timeout_ms=config.effect_timeout_ms,
    )

    if runner_exit != 0:
        error_msg = (
            f"hl-runner failed (exit {runner_exit}):\n"
            f"stdout: {runner_stdout[:1000]}\n"
            f"stderr: {runner_stderr[:1000]}"
        )
        logger.error(error_msg)
        runtime.set_setting("LAST_RESULT_JSON", json.dumps({
            "runner": {"success": False, "exitCode": runner_exit, "stderr": runner_stderr[:500]},
            "evaluator": None,
        }))
        if callback:
            await callback(Content(text=error_msg, actions=["EXECUTE_PLAN"]))
        return ActionResult(text=error_msg, success=False, error=error_msg)

    logger.info("hl-runner succeeded, artifacts in %s", out_dir)

    # ── Step 2: Run hl-evaluator ───────────────────────────────────
    per_action_path = out_dir / "per_action.jsonl"
    domains_path = bench_root / config.domains_file

    if not per_action_path.exists():
        error_msg = f"Runner did not produce {per_action_path}"
        logger.error(error_msg)
        if callback:
            await callback(Content(text=error_msg, actions=["EXECUTE_PLAN"]))
        return ActionResult(text=error_msg, success=False, error=error_msg)

    eval_exit, eval_stdout, eval_stderr = await _run_hl_evaluator(
        bench_root=bench_root,
        per_action_path=per_action_path,
        domains_path=domains_path,
        out_dir=out_dir,
    )

    # Parse eval_score.json if the evaluator succeeded
    eval_score_path = out_dir / "eval_score.json"
    eval_result: dict[str, object] = {}
    final_score = 0.0

    if eval_exit == 0 and eval_score_path.exists():
        eval_result = json.loads(eval_score_path.read_text())
        final_score = float(eval_result.get("finalScore", 0.0))
        logger.info("Evaluation complete: FINAL_SCORE=%.3f", final_score)
    else:
        logger.warning(
            "hl-evaluator issue (exit %d): %s", eval_exit, eval_stderr[:500]
        )

    # Build result summary
    result_summary: dict[str, object] = {
        "runner": {
            "success": True,
            "exitCode": runner_exit,
            "outDir": str(out_dir),
        },
        "evaluator": {
            "success": eval_exit == 0,
            "exitCode": eval_exit,
            "finalScore": final_score,
            "base": eval_result.get("base", 0.0),
            "bonus": eval_result.get("bonus", 0.0),
            "penalty": eval_result.get("penalty", 0.0),
            "uniqueSignatures": eval_result.get("uniqueSignatures", []),
        },
    }

    # Store for next iteration's context
    runtime.set_setting("LAST_RESULT_JSON", json.dumps(result_summary, indent=2))
    # Mark plan as executed
    runtime.set_setting("PLAN_EXECUTED", True)

    summary_text = (
        f"Plan executed and evaluated.\n"
        f"  Final Score: {final_score:.3f}\n"
        f"  Base: {eval_result.get('base', 0)}, "
        f"Bonus: {eval_result.get('bonus', 0)}, "
        f"Penalty: {eval_result.get('penalty', 0)}\n"
        f"  Unique Signatures: {eval_result.get('uniqueSignatures', [])}\n"
        f"  Artifacts: {out_dir}"
    )

    if callback:
        await callback(Content(text=summary_text, actions=["EXECUTE_PLAN"]))

    return ActionResult(
        text=summary_text,
        values={
            "finalScore": final_score,
            "outDir": str(out_dir),
        },
        data={
            "actionName": "EXECUTE_PLAN",
            "result": result_summary,
        },
        success=True,
    )


execute_plan_action = Action(
    name="EXECUTE_PLAN",
    description=(
        "Execute the current trading plan by invoking the Rust hl-runner binary "
        "as a subprocess, then score the results with the hl-evaluator. "
        "Requires GENERATE_PLAN to have been run first."
    ),
    similes=["RUN_PLAN", "SUBMIT_PLAN", "TRADE"],
    validate=_validate_execute_plan,
    handler=_handle_execute_plan,
    parameters=[
        ActionParameter(
            name="demo_mode",
            description="Override demo mode (true = no real trading)",
            required=False,
            schema=ActionParameterSchema(
                type="boolean",
                description="When true, the runner synthesizes results without hitting Hyperliquid APIs",
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Execute the generated trading plan"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Executing plan via hl-runner and scoring with hl-evaluator...",
                    actions=["EXECUTE_PLAN"],
                ),
            ),
        ],
    ],
)
