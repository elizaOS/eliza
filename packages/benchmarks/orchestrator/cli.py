from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .adapters import discover_adapters
from .db import connect_database, initialize_database, recover_stale_running_runs
from .runner import run_benchmarks
from .types import RunRequest
from .viewer_server import serve_viewer
from .viewer_data import build_viewer_dataset


def _workspace_root_from_here() -> Path:
    return Path(__file__).resolve().parents[2]


def _parse_json_arg(raw: str | None) -> dict[str, Any]:
    if raw is None or raw.strip() == "":
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("--extra must be a JSON object")
    return value


def _build_request(args: argparse.Namespace, adapters: dict[str, Any]) -> RunRequest:
    if args.all:
        benchmarks = tuple(sorted(adapters.keys()))
    elif args.benchmarks:
        benchmarks = tuple(args.benchmarks)
    else:
        benchmarks = tuple(sorted(adapters.keys()))

    return RunRequest(
        benchmarks=benchmarks,
        agent=args.agent,
        provider=args.provider,
        model=args.model,
        extra_config=_parse_json_arg(args.extra),
        resume=bool(args.resume),
        rerun_failed=bool(args.rerun_failed),
        force=bool(args.force),
    )


def _cmd_list(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    discovery = discover_adapters(workspace_root)
    covered_dirs = {adapter.directory for adapter in discovery.adapters.values()}
    missing_dirs = [d for d in discovery.all_directories if d not in covered_dirs]

    print("Integrated benchmark adapters:")
    for benchmark_id in sorted(discovery.adapters):
        adapter = discovery.adapters[benchmark_id]
        print(f"- {benchmark_id:16s} dir={adapter.directory:18s} cwd={adapter.cwd}")

    print("")
    print(f"Total adapters: {len(discovery.adapters)}")
    print(f"Total benchmark dirs: {len(discovery.all_directories)}")
    if missing_dirs:
        print("Uncovered benchmark directories:")
        for directory in missing_dirs:
            print(f"- {directory}")
        return 2
    print("All benchmark directories are covered by adapters.")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    discovery = discover_adapters(workspace_root)
    request = _build_request(args, discovery.adapters)

    run_group_id, outcomes, viewer_snapshot = run_benchmarks(
        workspace_root=workspace_root,
        request=request,
    )

    print(f"Run group: {run_group_id}")
    print(f"Viewer snapshot: {viewer_snapshot}")
    print("")

    succeeded = 0
    failed = 0
    skipped = 0
    incompatible = 0

    for outcome in outcomes:
        print(
            f"- {outcome.benchmark_id:16s} "
            f"run_id={outcome.run_id} "
            f"status={outcome.status} "
            f"score={outcome.score}"
        )
        if outcome.status == "succeeded":
            succeeded += 1
        elif outcome.status == "failed":
            failed += 1
        elif outcome.status == "skipped":
            skipped += 1
        elif outcome.status == "incompatible":
            incompatible += 1

    print("")
    print(
        f"Summary: succeeded={succeeded} failed={failed} "
        f"skipped={skipped} incompatible={incompatible}"
    )
    return 1 if failed > 0 else 0


def _cmd_export_viewer(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)
    out = _rebuild_viewer_json(workspace_root, conn)
    conn.close()
    print(str(out))
    return 0


def _rebuild_viewer_json(workspace_root: Path, conn) -> Path:
    data = build_viewer_dataset(conn)
    out = workspace_root / "benchmarks" / "benchmark_results" / "viewer_data.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2, ensure_ascii=True), encoding="utf-8")
    return out


def _cmd_recover_stale(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)

    stale_seconds = max(0, int(args.stale_seconds))
    stale_before_epoch = datetime.now(UTC).timestamp() - stale_seconds
    stale_before = datetime.fromtimestamp(stale_before_epoch, tz=UTC).isoformat()
    ended_at = datetime.now(UTC).isoformat()
    recovered = recover_stale_running_runs(conn, stale_before=stale_before, ended_at=ended_at)
    viewer_snapshot = _rebuild_viewer_json(workspace_root, conn)
    conn.close()

    print(f"Recovered runs: {len(recovered)}")
    for run_id in recovered:
        print(f"- {run_id}")
    print(f"Viewer snapshot: {viewer_snapshot}")
    return 0


def _cmd_show_runs(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)
    data = build_viewer_dataset(conn)
    conn.close()
    runs = list(data.get("runs", []))
    runs.sort(key=lambda x: (str(x.get("agent", "")), str(x.get("run_id", ""))), reverse=bool(args.desc))
    if args.limit is not None:
        runs = runs[: args.limit]

    for row in runs:
        print(
            f"{row.get('started_at')} "
            f"benchmark={row.get('benchmark_id')} "
            f"run_id={row.get('run_id')} "
            f"agent={row.get('agent')} "
            f"provider={row.get('provider')} "
            f"model={row.get('model')} "
            f"status={row.get('status')} "
            f"score={row.get('score')}"
        )
    return 0


def _cmd_serve_viewer(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    serve_viewer(
        workspace_root=workspace_root,
        host=args.host,
        port=args.port,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bench-orchestrator",
        description="Run and store benchmark suites in benchmarks/benchmark_results",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list-benchmarks", help="Show integrated benchmark adapters and coverage")
    p_list.set_defaults(func=_cmd_list)

    p_run = sub.add_parser("run", help="Run one or more benchmarks idempotently")
    p_run.add_argument("--all", action="store_true", help="Run all integrated benchmarks")
    p_run.add_argument(
        "--benchmarks",
        nargs="+",
        default=None,
        help="Benchmark IDs to run (default: all)",
    )
    p_run.add_argument("--agent", default="eliza", help="Agent label for this run")
    p_run.add_argument("--provider", default="groq", help="Model provider")
    p_run.add_argument("--model", default="qwen3", help="Model name")
    p_run.add_argument("--extra", default=None, help="JSON object with benchmark-specific options")
    p_run.add_argument("--resume", action="store_true", help="Alias for idempotent run behavior")
    p_run.add_argument("--rerun-failed", action="store_true", help="Only re-run failed signatures")
    p_run.add_argument("--force", action="store_true", help="Force a new run regardless of existing success")
    p_run.set_defaults(func=_cmd_run)

    p_export = sub.add_parser("export-viewer-data", help="Rebuild benchmark_results/viewer_data.json from SQLite")
    p_export.set_defaults(func=_cmd_export_viewer)

    p_recover = sub.add_parser(
        "recover-stale-runs",
        help="Mark stale running rows as failed and close affected run groups",
    )
    p_recover.add_argument(
        "--stale-seconds",
        type=int,
        default=300,
        help="Recover runs older than this many seconds (use 0 to recover all running rows)",
    )
    p_recover.set_defaults(func=_cmd_recover_stale)

    p_show = sub.add_parser("show-runs", help="Print normalized runs from the orchestrator DB")
    p_show.add_argument("--limit", type=int, default=200, help="Max rows to print")
    p_show.add_argument("--desc", action="store_true", help="Sort descending by (agent, run_id)")
    p_show.set_defaults(func=_cmd_show_runs)

    p_serve = sub.add_parser("serve-viewer", help="Serve benchmarks/viewer with live API data")
    p_serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=8877, help="Bind port (default: 8877)")
    p_serve.set_defaults(func=_cmd_serve_viewer)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))
