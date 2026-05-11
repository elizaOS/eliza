"""Run vendored LOCA-bench against Cerebras ``gpt-oss-120b``.

This wrapper keeps the upstream LOCA CLI intact while standardizing the
elizaOS benchmark defaults, environment variables, output auditing, and
trajectory collection.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

from eliza_loca.trajectory_audit import audit_output_dir


LOCA_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
DEFAULT_MODEL = "gpt-oss-120b"


def main() -> int:
    args = parse_args()
    env = build_env(args)
    command = build_command(args)

    if args.dry_run:
        print(json.dumps({"command": command, "cwd": str(LOCA_ROOT)}, indent=2))
        return 0

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(command, cwd=LOCA_ROOT, env=env, check=False)

    audit_path = output_dir / "eliza_loca_audit.json"
    audit = audit_output_dir(output_dir, include_previews=args.include_previews)
    audit_path.write_text(
        json.dumps(audit, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote audit {audit_path}")
    print(
        "trajectory_count={trajectory_count} issue_count={issue_count} "
        "avg_accuracy={avg_accuracy} total_api_tokens={total_api_tokens}".format(
            **audit["summary"]
        )
    )
    if completed.returncode != 0:
        return completed.returncode
    return 1 if audit["summary"]["issue_count"] else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="task-configs/debug.json")
    parser.add_argument("--strategy", default="react", choices=["react", "ptc", "memory_tool"])
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--output-dir", default="outputs/eliza_gpt_oss_120b_debug")
    parser.add_argument("--max-workers", type=int, default=1)
    parser.add_argument("--max-tool-uses", type=int, default=25)
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--initial-retry-delay", type=float, default=1.0)
    parser.add_argument("--max-context-size", type=int, default=131072)
    parser.add_argument("--reset-size", type=int, default=65536)
    parser.add_argument("--reset-ratio", type=float, default=0.5)
    parser.add_argument("--memory-warning-threshold", type=float, default=0.7)
    parser.add_argument("--keep-thinking", type=int, default=0)
    parser.add_argument("--context-reset", action="store_true")
    parser.add_argument("--context-summary", action="store_true")
    parser.add_argument("--context-awareness", action="store_true")
    parser.add_argument("--thinking-reset", action="store_true")
    parser.add_argument(
        "--reasoning-effort",
        choices=["low", "medium", "high"],
        default=None,
        help="Cerebras-supported GPT-OSS reasoning effort.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-previews", action="store_true")
    return parser.parse_args()


def build_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    api_key = env.get("LOCA_OPENAI_API_KEY") or env.get("CEREBRAS_API_KEY")
    if not api_key:
        raise SystemExit("CEREBRAS_API_KEY or LOCA_OPENAI_API_KEY is required")
    env["LOCA_OPENAI_API_KEY"] = api_key
    env["LOCA_OPENAI_BASE_URL"] = args.base_url.rstrip("/")
    env["LOCA_QUIET"] = "1"
    env["FASTMCP_SHOW_CLI_BANNER"] = "false"
    existing_pythonpath = env.get("PYTHONPATH", "")
    paths = [str(LOCA_ROOT)]
    if existing_pythonpath:
        paths.append(existing_pythonpath)
    env["PYTHONPATH"] = os.pathsep.join(paths)
    return env


def build_command(args: argparse.Namespace) -> list[str]:
    command: list[str] = [
        sys.executable,
        "-m",
        "loca.cli.main",
        "run",
        "--config-file",
        str(resolve_path(args.config)),
        "--strategy",
        args.strategy,
        "--model",
        args.model,
        "--output-dir",
        str(Path(args.output_dir).resolve()),
        "--max-workers",
        str(args.max_workers),
        "--max-tool-uses",
        str(args.max_tool_uses),
        "--max-tokens",
        str(args.max_tokens),
        "--timeout",
        str(args.timeout),
        "--max-retries",
        str(args.max_retries),
        "--initial-retry-delay",
        str(args.initial_retry_delay),
        "--max-context-size",
        str(args.max_context_size),
        "--reset-size",
        str(args.reset_size),
        "--reset-ratio",
        str(args.reset_ratio),
        "--memory-warning-threshold",
        str(args.memory_warning_threshold),
        "--keep-thinking",
        str(args.keep_thinking),
    ]
    command.append("--context-reset" if args.context_reset else "--no-context-reset")
    command.append("--context-summary" if args.context_summary else "--no-context-summary")
    command.append(
        "--context-awareness" if args.context_awareness else "--no-context-awareness"
    )
    command.append("--thinking-reset" if args.thinking_reset else "--no-thinking-reset")
    if args.reasoning_effort:
        command.extend(["--reasoning-effort", args.reasoning_effort])
    return command


def resolve_path(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    return LOCA_ROOT / candidate


if __name__ == "__main__":
    sys.exit(main())
