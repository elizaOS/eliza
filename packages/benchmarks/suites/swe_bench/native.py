"""Run SWE tasks through the production Eliza coding message loop.

The CLI's success means the turn completed; only the official Docker evaluator
can establish issue resolution. Full stdout/stderr are retained as receipts.
"""
from __future__ import annotations

import asyncio
import json
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


async def run_native_instance(instance: SWEBenchInstance, evaluator, config: SWEBenchConfig) -> SWEBenchResult:
    from .cli import _build_subtask_prompt

    started = time.monotonic()
    manager = RepositoryManager(config.workspace_dir)
    process = None
    # Keep receipts and state outside the checkout that gets cleaned up.
    receipt_dir = Path(config.output_dir).resolve() / "native" / instance.instance_id.replace("/", "_")
    receipt_dir.mkdir(parents=True, exist_ok=True)
    try:
        if not config.model_name:
            raise ValueError("Native coding requires an explicit model")
        repo = await manager.setup_repo(instance)
        repo_root = Path(__file__).resolve().parents[4]
        entrypoint = repo_root / "packages/agent/src/bin.ts"
        env = dict(os.environ)
        env.update({
            "ELIZA_STATE_DIR": str(receipt_dir / "state"),
            "ELIZA_CONFIG_PATH": str(receipt_dir / "state" / "eliza.json"),
            "CODING_TOOLS_WORKSPACE_ROOTS": str(repo.resolve()),
            "OPENAI_SMALL_MODEL": config.model_name,
            "OPENAI_LARGE_MODEL": config.model_name,
            "LOG_LEVEL": "error",
        })
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
            await asyncio.wait_for(process.wait(), timeout=config.timeout_seconds)
        if process.returncode != 0:
            raise RuntimeError(f"Native CLI exited {process.returncode}; see {receipt_dir}")
        row = parse_native_result((receipt_dir / "stdout.log").read_text(), instance.instance_id)
        (receipt_dir / "result.json").write_text(json.dumps(row, indent=2))
        patch = await manager.get_diff()
        if not patch.strip():
            raise RuntimeError("Native coding turn completed without a working-tree diff")
        result = await evaluator.evaluate_patch(instance, patch)
        result.duration_seconds = time.monotonic() - started
        result.status = f"{result.status or ''} execution=native_direct receipt={receipt_dir}".strip()
        return result
    except Exception as exc:
        return SWEBenchResult(
            instance_id=instance.instance_id, generated_patch="", patch_status=PatchStatus.NOT_GENERATED,
            tests_passed=[], tests_failed=[], success=False,
            duration_seconds=time.monotonic() - started, tokens_used=None,
            error=f"{type(exc).__name__}: {exc}", status=f"execution=native_direct receipt={receipt_dir}",
        )
    finally:
        if process is not None and process.returncode is None:
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
        manager.cleanup_current_repo()
