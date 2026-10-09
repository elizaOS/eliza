"""Command helper for standard code-agent benchmark tasks."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a standard benchmark task through a code agent.")
    parser.add_argument("--adapter", required=True, choices=["elizaos", "opencode"])
    parser.add_argument("--benchmark", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--provider", default="cerebras")
    parser.add_argument("--model", default="gemma-4-31b")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--result-json", required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    prompt = Path(args.prompt).read_text(encoding="utf-8")
    result_json = Path(args.result_json)
    metadata: dict[str, Any] = {
        "adapter": args.adapter,
        "benchmark": args.benchmark,
        "task": args.task,
        "prompt": str(args.prompt),
        "provider": args.provider,
        "model": args.model,
        "prompt_chars": len(prompt),
        "dry_run": bool(args.dry_run),
    }
    if args.dry_run:
        _write_json(result_json, {**metadata, "status": "dry_run", "response_text": ""})
        return 0

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harnesses" / "eliza"))
    from eliza_adapter import run_code_agent_task

    try:
        response = run_code_agent_task(
            adapter=args.adapter, provider=args.provider, model=args.model,
            timeout_seconds=args.timeout_seconds, prompt=prompt,
            context={
                "benchmark": args.benchmark,
                "task_id": args.task,
                "system_prompt": (
                    "You are an autonomous coding benchmark agent. Return only the requested code "
                    "artifact; do not include markdown fences or explanation unless the task asks."
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
                "response_text": "",
                "error": f"{type(exc).__name__}: {exc}",
            },
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
