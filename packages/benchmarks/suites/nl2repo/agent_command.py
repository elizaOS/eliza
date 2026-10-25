"""Command helper for generating NL2Repo workspaces through benchmark agents."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def build_prompt(*, instruction_path: str, prompt_path: str, workspace: str) -> str:
    instruction = _read_text(instruction_path)
    prompt = _read_text(prompt_path)
    return "\n\n".join(
        [
            instruction,
            "The full requirements document from start.md follows.",
            prompt,
            f"Write the final repository files in: {workspace}",
        ]
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an NL2Repo task through an Eliza benchmark task agent.")
    parser.add_argument("--adapter", required=True, choices=["elizaos", "opencode"])
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--instruction", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--provider", default="cerebras")
    parser.add_argument("--model", default="gemma-4-31b")
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--result-json", default="")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    workspace = Path(args.workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(
        instruction_path=args.instruction,
        prompt_path=args.prompt,
        workspace=str(workspace),
    )
    result_json = Path(args.result_json) if args.result_json else workspace / ".nl2repo-agent-result.json"
    metadata: dict[str, Any] = {
        "adapter": args.adapter,
        "task": args.task,
        "workspace": str(workspace),
        "instruction": args.instruction,
        "prompt": args.prompt,
        "provider": args.provider,
        "model": args.model,
        "prompt_chars": len(prompt),
        "dry_run": bool(args.dry_run),
    }
    if args.dry_run:
        _write_json(result_json, {**metadata, "status": "dry_run"})
        return 0

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harnesses" / "eliza"))
    from eliza_adapter import run_code_agent_task

    try:
        response = run_code_agent_task(
            adapter=args.adapter, provider=args.provider, model=args.model,
            timeout_seconds=args.timeout_seconds, prompt=prompt,
            context={
                "benchmark": "nl2repo",
                "task_id": args.task,
                "workspace": str(workspace),
                "instruction_path": args.instruction,
                "prompt_path": args.prompt,
                "system_prompt": (
                    "You are an autonomous coding task agent running inside NL2Repo-Bench. "
                    "Use the workspace path as the repository root and leave implemented files there."
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


if __name__ == "__main__":
    raise SystemExit(main())
