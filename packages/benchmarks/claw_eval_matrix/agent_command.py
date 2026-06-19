"""Command helper for running deterministic Claw-Eval tasks through agents."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "benchmarks" / "eliza-adapter").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root from Claw-Eval agent command")


def _add_adapter_paths() -> Path:
    root = _repo_root()
    for relative in (
        "packages/benchmarks/eliza-adapter",
        "packages/benchmarks/hermes-adapter",
        "packages/benchmarks/openclaw-adapter",
        "packages",
    ):
        path = str(root / relative)
        if path not in sys.path:
            sys.path.insert(0, path)
    return root


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a Claw-Eval task through a benchmark agent.")
    parser.add_argument("--adapter", required=True, choices=["elizaos", "opencode"])
    parser.add_argument("--task-yaml", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--provider", default="cerebras")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--result-json", required=True)
    return parser.parse_args(argv)


def _prompt_from_task(task_yaml: Path) -> str:
    import yaml

    data = yaml.safe_load(task_yaml.read_text(encoding="utf-8"))
    prompt = ((data or {}).get("prompt") or {}).get("text") or ""
    return "\n\n".join(
        [
            "You are running a deterministic Claw-Eval benchmark task.",
            "Answer the task directly. Use available tools when useful, then provide the final answer.",
            str(prompt),
        ]
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    task_yaml = Path(args.task_yaml)
    prompt = _prompt_from_task(task_yaml)
    result_json = Path(args.result_json)
    metadata: dict[str, Any] = {
        "adapter": args.adapter,
        "benchmark": "claw_eval",
        "task": args.task,
        "task_yaml": str(task_yaml),
        "provider": args.provider,
        "model": args.model,
        "prompt_chars": len(prompt),
        "dry_run": bool(args.dry_run),
    }
    if args.dry_run:
        _write_json(result_json, {**metadata, "status": "dry_run"})
        return 0

    root = _add_adapter_paths()
    os.environ["BENCHMARK_TASK_AGENT"] = args.adapter
    os.environ["BENCHMARK_MODEL_PROVIDER"] = args.provider
    os.environ["BENCHMARK_MODEL_NAME"] = args.model
    os.environ.setdefault("ELIZA_AGENT_ORCHESTRATOR", "1")
    os.environ.setdefault("ELIZA_AGENT_SELECTION_STRATEGY", "fixed")
    os.environ.setdefault("ELIZA_ACP_DEFAULT_AGENT", args.adapter)
    os.environ.setdefault("ELIZA_DEFAULT_AGENT_TYPE", args.adapter)
    os.environ.setdefault("ELIZA_BENCH_HTTP_TIMEOUT", str(args.timeout_seconds))
    os.environ.setdefault("ELIZA_BENCH_START_TIMEOUT", "300")

    from eliza_adapter import ElizaServerManager  # type: ignore

    manager = ElizaServerManager(timeout=300.0, repo_root=root)
    try:
        manager.start()
        manager.client.reset(task_id=args.task, benchmark="claw_eval")
        response = manager.client.send_message(
            prompt,
            context={
                "benchmark": "claw_eval",
                "task_id": args.task,
                "task_yaml": str(task_yaml),
                "system_prompt": (
                    "You are an autonomous benchmark agent. Solve the task, "
                    "use tools when useful, and make the final answer explicit."
                ),
            },
        )
        _write_json(
            result_json,
            {
                **metadata,
                "status": "completed",
                "response_text": response.text,
                "actions": response.actions,
                "metadata": response.metadata,
                "usage": response.params.get("usage", {}),
            },
        )
        return 0
    except Exception as exc:
        _write_json(
            result_json,
            {
                **metadata,
                "status": "error",
                "error": f"{type(exc).__name__}: {exc}",
            },
        )
        return 1
    finally:
        manager.stop()


if __name__ == "__main__":
    raise SystemExit(main())

