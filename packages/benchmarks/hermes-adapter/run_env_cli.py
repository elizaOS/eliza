"""Thin subprocess CLI wrapper around :func:`hermes_adapter.env_runner.run_hermes_env`.

Used by the orchestrator's registry entries so each Hermes-native env
(``hermes_tblite``, ``hermes_terminalbench_2``, ``hermes_yc_bench``,
``hermes_swe_env``) becomes a normal subprocess-spawnable benchmark with
JSON result file output.

Writes the resulting :class:`HermesEnvResult` as
``<output>/hermes_<env>_<timestamp>.json``. Exits non-zero on failure with
the failure message captured on stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

from hermes_adapter.env_runner import run_hermes_env


# Public env_id -> the canonical ENV_MODULES key used by env_runner.
ENV_ID_ALIASES: dict[str, str] = {
    "tblite": "tblite",
    "hermes_tblite": "tblite",
    "terminalbench_2": "terminalbench_2",
    "hermes_terminalbench_2": "terminalbench_2",
    "yc_bench": "yc_bench",
    "hermes_yc_bench": "yc_bench",
    "hermes_swe_env": "hermes_swe_env",
    "swe_env": "hermes_swe_env",
}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run_env_cli.py",
        description="Run one of the hermes-agent benchmark envs and dump a JSON result.",
    )
    parser.add_argument("--env", required=True, help=f"Env id (one of {sorted(ENV_ID_ALIASES)})")
    parser.add_argument("--output", required=True, help="Output directory for artifacts + JSON result")
    parser.add_argument("--model", required=True, help="Model name to evaluate")
    parser.add_argument("--provider", default="cerebras", help="OpenAI-compatible provider label")
    parser.add_argument("--base-url", default=None, help="Optional explicit OpenAI-compatible base URL")
    parser.add_argument("--max-tasks", type=int, default=None, help="Cap on number of eval samples")
    parser.add_argument("--task-filter", default=None, help="Optional --env.task_filter forwarded to the env")
    parser.add_argument("--repo-path", default=None, help="Override path to the hermes-agent repo checkout")
    parser.add_argument("--force", action="store_true", help="Re-run even when a cached eval-summary exists")
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=7200.0,
        help="Hard subprocess timeout for the underlying hermes evaluate call",
    )
    return parser


def _resolve_env_id(raw: str) -> str:
    key = raw.strip()
    if key not in ENV_ID_ALIASES:
        raise SystemExit(
            f"Unknown --env {raw!r}. Expected one of: {', '.join(sorted(ENV_ID_ALIASES))}"
        )
    return ENV_ID_ALIASES[key]


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    env_id = _resolve_env_id(args.env)
    output_dir = Path(args.output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    repo_path = Path(args.repo_path).expanduser().resolve() if args.repo_path else None

    result = run_hermes_env(
        env_id,
        output_dir=output_dir,
        provider=args.provider,
        model=args.model,
        base_url=args.base_url,
        repo_path=repo_path,
        max_tasks=args.max_tasks,
        task_filter=args.task_filter,
        timeout_s=args.timeout_seconds,
        force=args.force,
    )

    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    result_path = output_dir / f"hermes_{env_id}_{ts}.json"
    payload = asdict(result)
    # Path objects are not JSON-serializable as dataclasses; coerce to strings.
    for key in ("samples_path", "summary_path"):
        if key in payload and payload[key] is not None:
            payload[key] = str(payload[key])
    payload["env_id_public"] = args.env.strip()
    result_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(str(result_path))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — surface error message to caller
        print(f"run_env_cli.py: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
