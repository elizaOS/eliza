"""Run SWE tasks through the production Eliza coding message loop.

The CLI's success means the turn completed; only the official Docker evaluator
can establish issue resolution. Full stdout/stderr are retained as receipts.
"""
from __future__ import annotations

import asyncio
import json
import hashlib
import math
import uuid
import os
import signal
import time
from pathlib import Path

from .repo_manager import RepositoryManager
from .types import PatchStatus, SWEBenchConfig, SWEBenchInstance, SWEBenchResult


def parse_native_result(stdout: str, task_id: str) -> dict:
    rows = []
    for line in stdout.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue  # Runtime logs may share stdout with the CLI result.
        if isinstance(row, dict) and row.get("id") == task_id and "success" in row:
            rows.append(row)
    if len(rows) != 1:
        raise ValueError(f"Expected one native CLI result for {task_id}, received {len(rows)}")
    row = rows[0]
    if row.get("success") is not True:
        raise RuntimeError(f"Native coding turn failed: {row.get('error', 'unknown failure')}")
    actions = row.get("actions_taken")
    if not isinstance(actions, list) or not any(action in {"WRITE", "EDIT", "SHELL", "FILE"} for action in actions):
        raise RuntimeError("Native coding turn has no file-mutation tool receipt")
    return row


def validate_native_trajectory(directory: Path, trace_id: str, task: dict) -> dict:
    """Require a persisted final trajectory for this exact attempt and task."""
    matches = []
    for path in sorted(directory.glob("*/tj-*.json")):
        raw = path.read_bytes()
        try:
            record = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RuntimeError(f"Invalid native trajectory artifact: {path}") from exc
        if not isinstance(record, dict) or record.get("traceId") != trace_id:
            continue
        root = record.get("rootMessage")
        text = root.get("text") if isinstance(root, dict) else None
        if not isinstance(text, str):
            continue
        prompt, separator, context = text.rpartition("\n\nTask context (JSON):\n")
        if not separator or prompt != task["prompt"]:
            continue
        try:
            decoded_context = json.loads(context)
        except json.JSONDecodeError:
            continue
        if decoded_context != task["context"]:
            continue
        matches.append((path, raw, record))
    if len(matches) != 1:
        raise RuntimeError(f"Expected one native task trajectory for trace {trace_id}, received {len(matches)}")
    path, raw, record = matches[0]
    started, ended = record.get("startedAt"), record.get("endedAt")
    if record.get("status") != "finished" or any(
        isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
        for value in (started, ended)
    ) or ended < started:
        raise RuntimeError(f"Native task trajectory is incomplete: {path}")
    stages = record.get("stages")
    if not isinstance(stages, list) or not any(
        isinstance(stage, dict) and stage.get("kind") == "tool" for stage in stages
    ):
        raise RuntimeError(f"Native task trajectory has no recorded tool stage: {path}")
    return {"trace_id": trace_id, "trajectory_id": record.get("trajectoryId"),
            "path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "status": "finished"}


async def _stop_native_process(process) -> None:
    if process is None or process.returncode is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass
    await process.wait()


async def run_native_instance(instance: SWEBenchInstance, evaluator, config: SWEBenchConfig, *, provider: str | None = None) -> SWEBenchResult:
    from .cli import _build_subtask_prompt

    started = time.monotonic()
    manager = RepositoryManager(config.workspace_dir)
    process = None
    patch = ""
    trace_id = str(uuid.uuid4())
    # Keep receipts and state outside the checkout that gets cleaned up.
    receipt_dir = Path(config.output_dir).resolve() / "native" / instance.instance_id.replace("/", "_") / trace_id
    receipt_dir.mkdir(parents=True, exist_ok=True)
    try:
        if not config.model_name:
            raise ValueError("Native coding requires an explicit model")
        repo = await manager.setup_repo(instance)
        repo_root = Path(__file__).resolve().parents[4]
        entrypoint = repo_root / "packages/agent/src/bin.ts"
        env = dict(os.environ)
        # Parent test runners must not disable the production CLI lifecycle.
        for key in tuple(env):
            if key.startswith("VITEST") or key in {"ELIZA_TEST_FAST", "ELIZA_TEST_HOME"}:
                del env[key]
        if env.get("NODE_ENV") == "test":
            env["NODE_ENV"] = "development"
        env.update({
            "ELIZA_STATE_DIR": str(receipt_dir / "state"),
            "ELIZA_CONFIG_PATH": str(receipt_dir / "state" / "eliza.json"),
            "CODING_TOOLS_WORKSPACE_ROOTS": str(repo.resolve()),
            "OPENAI_SMALL_MODEL": config.model_name,
            "OPENAI_LARGE_MODEL": config.model_name,
            "LOG_LEVEL": "error",
            "ELIZA_TRACE_ID": trace_id,
        })
        if provider == "cerebras":
            if not env.get("CEREBRAS_API_KEY"):
                raise ValueError("Cerebras provider requires CEREBRAS_API_KEY")
            # The selected benchmark model overrides inherited provider defaults.
            for key in ("CEREBRAS_MODEL", "CEREBRAS_SMALL_MODEL", "CEREBRAS_LARGE_MODEL"):
                env[key] = config.model_name
            env["OPENAI_API_KEY"] = env["CEREBRAS_API_KEY"]
            env["OPENAI_BASE_URL"] = env.get("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1")
        elif provider not in {None, "openai", "openai-compatible"}:
            raise ValueError(f"Native coding provider {provider!r} is not configured; use an explicit OpenAI-compatible endpoint")
        task = {
            "id": instance.instance_id,
            "type": "coding",
            "prompt": _build_subtask_prompt(instance),
            "context": {"workspace": str(repo.resolve()), "benchmark": "swe_bench", "execution_mode": "native_direct"},
        }
        (receipt_dir / "task.json").write_text(json.dumps(task, indent=2))
        with (receipt_dir / "stdout.log").open("wb") as stdout, (receipt_dir / "stderr.log").open("wb") as stderr:
            process = await asyncio.create_subprocess_exec(
                "bun", "--no-install", "--conditions=eliza-source", str(entrypoint),
                "benchmark", "--task", str(receipt_dir / "task.json"),
                cwd=repo, env=env, stdout=stdout, stderr=stderr,
                start_new_session=os.name == "posix",
            )
            try:
                await asyncio.wait_for(process.wait(), timeout=config.timeout_seconds)
            except TimeoutError:
                # Settle the writer before taking a diagnostic diff; it must never
                # be graded or disappear when the disposable checkout is removed.
                await _stop_native_process(process)
                patch = await manager.get_diff()
                (receipt_dir / "attempted.patch").write_text(patch)
                raise TimeoutError(
                    f"Native CLI exceeded {config.timeout_seconds}s; see {receipt_dir}"
                ) from None
        # Preserve the attempted edit even when the completed CLI reports failure.
        # Failed turns remain ineligible for grading.
        patch = await manager.get_diff()
        if process.returncode != 0:
            raise RuntimeError(f"Native CLI exited {process.returncode}; see {receipt_dir}")
        row = parse_native_result((receipt_dir / "stdout.log").read_text(), instance.instance_id)
        (receipt_dir / "result.json").write_text(json.dumps(row, indent=2))
        if not patch.strip():
            raise RuntimeError("Native coding turn completed without a working-tree diff")
        evidence = validate_native_trajectory(receipt_dir / "state" / "trajectories", trace_id, task)
        (receipt_dir / "trace-evidence.json").write_text(json.dumps(evidence, indent=2))
        result = await evaluator.evaluate_patch(instance, patch)
        result.duration_seconds = time.monotonic() - started
        result.status = f"{result.status or ''} execution=native_direct receipt={receipt_dir}".strip()
        return result
    except Exception as exc:
        return SWEBenchResult(
            instance_id=instance.instance_id, generated_patch=patch,
            patch_status=PatchStatus.GENERATED if patch.strip() else PatchStatus.NOT_GENERATED,
            tests_passed=[], tests_failed=[], success=False,
            duration_seconds=time.monotonic() - started, tokens_used=None,
            error=f"{type(exc).__name__}: {exc}", status=f"execution=native_direct receipt={receipt_dir}",
        )
    finally:
        await _stop_native_process(process)
        manager.cleanup_current_repo()
