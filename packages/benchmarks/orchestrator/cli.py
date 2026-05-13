from __future__ import annotations

import argparse
import json
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .adapters import discover_adapters
from .calibration_report import build_calibration_report, print_calibration_report
from .compare_vs_random import add_compare_vs_random_parser
from .db import (
    connect_database,
    initialize_database,
    list_runs_for_comparison,
    recover_stale_running_runs,
    repair_nonzero_returncode_statuses,
    tag_run_with_comparison,
)
from .random_baseline_runner import CALIBRATION_HARNESSES, SYNTHETIC_HARNESSES
from .runner import _rebuild_latest_result_snapshots, _repair_current_compatibility_statuses, run_benchmarks
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
    harnesses = _selected_harnesses(args)
    all_outcomes = []
    viewer_snapshot: Path | None = None

    for harness in harnesses:
        harness_request = replace(request, agent=harness)
        run_group_id, outcomes, viewer_snapshot = run_benchmarks(
            workspace_root=workspace_root,
            request=harness_request,
        )
        all_outcomes.extend(outcomes)
        print(f"Run group ({harness}): {run_group_id}")

    if viewer_snapshot is not None:
        print(f"Viewer snapshot: {viewer_snapshot}")
    print("")

    succeeded = 0
    failed = 0
    skipped = 0
    incompatible = 0
    # Default-on: suppress per-outcome printing for incompatible (harness/benchmark
    # mismatch) rows in the summary. They are always recorded in SQLite either way.
    skip_incompatible = bool(getattr(args, "skip_incompatible", True))

    for outcome in all_outcomes:
        if outcome.status == "incompatible" and skip_incompatible:
            incompatible += 1
            continue
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


def _selected_harnesses(args: argparse.Namespace) -> tuple[str, ...]:
    if getattr(args, "all_harnesses", False):
        harnesses = ["eliza", "hermes", "openclaw"]
        if bool(getattr(args, "include_calibration_harnesses", False)):
            harnesses.extend(CALIBRATION_HARNESSES)
        if bool(getattr(args, "include_random_baseline", False)):
            harnesses.append("random_v1")
        return tuple(dict.fromkeys(harnesses))
    raw = getattr(args, "harnesses", None)
    include_random = bool(getattr(args, "include_random_baseline", False))
    include_calibration = bool(getattr(args, "include_calibration_harnesses", False))
    if raw:
        values: list[str] = []
        for item in raw:
            values.extend(part.strip().lower() for part in str(item).split(",") if part.strip())
        deduped: list[str] = []
        for value in values:
            if value not in {"eliza", "hermes", "openclaw", *SYNTHETIC_HARNESSES}:
                raise SystemExit(
                    "Unknown harness "
                    f"'{value}'. Expected eliza, hermes, openclaw, random_v1, "
                    "perfect_v1, wrong_v1, or half_v1."
                )
            if value not in deduped:
                deduped.append(value)
        if include_random and "random_v1" not in deduped:
            deduped.append("random_v1")
        if include_calibration:
            for harness in CALIBRATION_HARNESSES:
                if harness not in deduped:
                    deduped.append(harness)
        return tuple(deduped) if deduped else (args.agent,)
    if include_calibration and include_random:
        return (args.agent, *CALIBRATION_HARNESSES, "random_v1")
    if include_calibration:
        return (args.agent, *CALIBRATION_HARNESSES)
    if include_random:
        return (args.agent, "random_v1")
    return (args.agent,)


def _cmd_export_viewer(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    repair_nonzero_returncode_statuses(conn)
    discovery = discover_adapters(workspace_root)
    _repair_current_compatibility_statuses(conn, discovery.adapters)
    _rebuild_latest_result_snapshots(conn, output_root, discovery.adapters)
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
    repaired = repair_nonzero_returncode_statuses(conn)
    discovery = discover_adapters(workspace_root)
    compatibility_repaired = _repair_current_compatibility_statuses(conn, discovery.adapters)
    _rebuild_latest_result_snapshots(
        conn,
        workspace_root / "benchmarks" / "benchmark_results",
        discovery.adapters,
    )
    viewer_snapshot = _rebuild_viewer_json(workspace_root, conn)
    conn.close()

    print(f"Recovered runs: {len(recovered)}")
    print(f"Repaired nonzero-return-code statuses: {repaired}")
    print(f"Repaired compatibility statuses: {compatibility_repaired}")
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


def _cmd_calibration_report(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    discovery = discover_adapters(workspace_root)
    report = build_calibration_report(
        workspace_root=workspace_root,
        tolerance=float(args.tolerance),
        benchmark_ids=set(discovery.adapters),
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True))
    else:
        print_calibration_report(report)
    if args.fail_on_suspicious:
        for row in report.get("rows", []):
            if row.get("calibration_status") not in {"valid"}:
                return 1
            if row.get("real_pattern") in {"all_real_zero", "all_real_one", "all_real_equal"}:
                return 1
            if str(row.get("real_pattern") or "").endswith("_mixed_config"):
                return 1
    return 0


def _parse_model_spec(spec: str) -> tuple[str, str, str | None]:
    """Parse ``provider:model[@base_url]`` into ``(provider, model, base_url)``.

    Examples:
        ``vllm:elizaos/eliza-1-2b@http://127.0.0.1:8001/v1``
        ``groq:openai/gpt-oss-120b``
    """
    raw = spec.strip()
    if not raw:
        raise ValueError("model spec is empty")
    base_url: str | None = None
    if "@" in raw:
        raw, base_url = raw.split("@", 1)
        base_url = base_url.strip() or None
    if ":" not in raw:
        raise ValueError(
            f"invalid model spec '{spec}': expected '<provider>:<model>[@<base_url>]'"
        )
    provider, model = raw.split(":", 1)
    provider = provider.strip().lower()
    model = model.strip()
    if not provider or not model:
        raise ValueError(f"invalid model spec '{spec}': provider and model are required")
    return provider, model, base_url


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _run_one_side(
    *,
    workspace_root: Path,
    provider: str,
    model: str,
    base_url: str | None,
    benchmarks: tuple[str, ...],
    temperature: float,
    max_examples: int | None,
    comparison_id: str,
) -> list[dict[str, Any]]:
    extra: dict[str, Any] = {}
    if base_url:
        extra["vllm_base_url"] = base_url
    if max_examples is not None:
        extra["max_examples"] = max_examples
        extra["max_tasks"] = max_examples
        extra["max_questions"] = max_examples
        extra["sample"] = max_examples

    request = RunRequest(
        benchmarks=benchmarks,
        agent="compare",
        provider=provider,
        model=model,
        extra_config=extra,
        force=True,
    )
    _, outcomes, _ = run_benchmarks(workspace_root=workspace_root, request=request)

    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)
    side_rows: list[dict[str, Any]] = []
    for outcome in outcomes:
        tag_run_with_comparison(
            conn,
            run_id=outcome.run_id,
            comparison_id=comparison_id,
        )
        side_rows.append(
            {
                "benchmark_id": outcome.benchmark_id,
                "run_id": outcome.run_id,
                "status": outcome.status,
                "provider": provider,
                "model": model,
                "base_url": base_url,
                "score": outcome.score,
                "unit": outcome.unit,
                "higher_is_better": outcome.higher_is_better,
                "metrics": outcome.metrics,
                "duration_seconds": outcome.duration_seconds,
                "error": outcome.error,
            }
        )
    conn.close()
    return side_rows


def _format_score(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.4f}"


def _format_delta(value: float | None) -> str:
    if value is None:
        return "n/a"
    sign = "+" if value > 0 else ""
    return f"{sign}{value:.4f}"


def _compute_winner(
    a_score: float | None,
    b_score: float | None,
    higher_is_better: bool | None,
) -> str:
    if a_score is None and b_score is None:
        return "n/a"
    if a_score is None:
        return "B"
    if b_score is None:
        return "A"
    if a_score == b_score:
        return "tie"
    if higher_is_better is False:
        return "A" if a_score < b_score else "B"
    return "A" if a_score > b_score else "B"


def _print_compare_table(
    *,
    label_a: str,
    label_b: str,
    rows: list[dict[str, Any]],
) -> None:
    headers = [
        "benchmark",
        f"A: {label_a}",
        f"B: {label_b}",
        "delta (B-A)",
        "winner",
    ]
    body: list[list[str]] = []
    for row in rows:
        a_score = row.get("a_score")
        b_score = row.get("b_score")
        delta = row.get("delta")
        body.append(
            [
                str(row.get("benchmark_id", "")),
                _format_score(a_score),
                _format_score(b_score),
                _format_delta(delta),
                str(row.get("winner", "")),
            ]
        )
    widths = [
        max(len(headers[i]), *(len(r[i]) for r in body)) if body else len(headers[i])
        for i in range(len(headers))
    ]
    sep = "-+-".join("-" * w for w in widths)
    print(" | ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print(sep)
    for row in body:
        print(" | ".join(cell.ljust(w) for cell, w in zip(row, widths)))


def _build_compare_rows(
    a_runs: list[dict[str, Any]],
    b_runs: list[dict[str, Any]],
    benchmarks: list[str],
) -> list[dict[str, Any]]:
    a_by_bench = {run["benchmark_id"]: run for run in a_runs}
    b_by_bench = {run["benchmark_id"]: run for run in b_runs}
    rows: list[dict[str, Any]] = []
    for benchmark_id in benchmarks:
        a = a_by_bench.get(benchmark_id)
        b = b_by_bench.get(benchmark_id)
        a_score = a.get("score") if a else None
        b_score = b.get("score") if b else None
        higher_is_better: bool | None = None
        for side in (a, b):
            if side and side.get("higher_is_better") is not None:
                higher_is_better = bool(side["higher_is_better"])
                break
        delta: float | None
        if a_score is not None and b_score is not None:
            delta = b_score - a_score
        else:
            delta = None
        rows.append(
            {
                "benchmark_id": benchmark_id,
                "a_score": a_score,
                "b_score": b_score,
                "delta": delta,
                "higher_is_better": higher_is_better,
                "winner": _compute_winner(a_score, b_score, higher_is_better),
                "a_run_id": a.get("run_id") if a else None,
                "b_run_id": b.get("run_id") if b else None,
                "a_status": a.get("status") if a else "missing",
                "b_status": b.get("status") if b else "missing",
                "unit": (a or b or {}).get("unit"),
            }
        )
    return rows


def _cmd_compare(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    a_provider, a_model, a_base_url = _parse_model_spec(args.a)
    b_provider, b_model, b_base_url = _parse_model_spec(args.b)
    benchmarks = _split_csv(args.benchmarks)
    if not benchmarks:
        raise SystemExit("--benchmarks must be a non-empty comma-separated list")

    discovery = discover_adapters(workspace_root)
    unknown = [b for b in benchmarks if b not in discovery.adapters]
    if unknown:
        raise SystemExit(f"Unknown benchmark IDs: {', '.join(unknown)}")

    comparison_id = f"cmp_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
    label_a = f"{a_provider}:{a_model}"
    label_b = f"{b_provider}:{b_model}"

    print(f"Comparison ID: {comparison_id}")
    print(f"A: {label_a}{(' @ ' + a_base_url) if a_base_url else ''}")
    print(f"B: {label_b}{(' @ ' + b_base_url) if b_base_url else ''}")
    print(f"Benchmarks: {', '.join(benchmarks)}")
    print("")

    print("Running side A...")
    a_runs = _run_one_side(
        workspace_root=workspace_root,
        provider=a_provider,
        model=a_model,
        base_url=a_base_url,
        benchmarks=tuple(benchmarks),
        temperature=args.temperature,
        max_examples=args.max_examples,
        comparison_id=comparison_id,
    )
    print("Running side B...")
    b_runs = _run_one_side(
        workspace_root=workspace_root,
        provider=b_provider,
        model=b_model,
        base_url=b_base_url,
        benchmarks=tuple(benchmarks),
        temperature=args.temperature,
        max_examples=args.max_examples,
        comparison_id=comparison_id,
    )

    rows = _build_compare_rows(a_runs, b_runs, benchmarks)
    print("")
    _print_compare_table(label_a=label_a, label_b=label_b, rows=rows)

    out_dir = Path(args.out) if args.out else (
        workspace_root / "benchmarks" / "benchmark_results" / "comparisons"
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"compare-{comparison_id}.json"
    payload = {
        "comparison_id": comparison_id,
        "created_at": datetime.now(UTC).isoformat(),
        "a": {
            "provider": a_provider,
            "model": a_model,
            "base_url": a_base_url,
            "runs": a_runs,
        },
        "b": {
            "provider": b_provider,
            "model": b_model,
            "base_url": b_base_url,
            "runs": b_runs,
        },
        "rows": rows,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8")
    print("")
    print(f"Wrote {out_path}")
    return 0


def _cmd_view_comparison(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)
    runs = list_runs_for_comparison(conn, comparison_id=args.comparison_id)
    conn.close()
    if not runs:
        print(f"No runs found for comparison_id={args.comparison_id}")
        return 1

    sides: dict[tuple[str, str], list[dict[str, Any]]] = {}
    order: list[tuple[str, str]] = []
    for row in runs:
        key = (str(row.get("provider", "")), str(row.get("model", "")))
        if key not in sides:
            sides[key] = []
            order.append(key)
        sides[key].append(row)

    if len(order) < 2:
        print(
            f"Comparison {args.comparison_id} has only one side "
            f"({order[0][0]}:{order[0][1]}). Cannot render delta table."
        )
        return 1

    a_key, b_key = order[0], order[1]
    label_a = f"{a_key[0]}:{a_key[1]}"
    label_b = f"{b_key[0]}:{b_key[1]}"

    benchmarks_seen: list[str] = []
    seen_set: set[str] = set()
    for run in runs:
        bid = str(run.get("benchmark_id", ""))
        if bid and bid not in seen_set:
            benchmarks_seen.append(bid)
            seen_set.add(bid)

    rows = _build_compare_rows(sides[a_key], sides[b_key], benchmarks_seen)
    print(f"Comparison ID: {args.comparison_id}")
    print(f"A: {label_a}")
    print(f"B: {label_b}")
    print("")
    _print_compare_table(label_a=label_a, label_b=label_b, rows=rows)
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
    p_run.add_argument(
        "--harnesses",
        nargs="+",
        default=None,
        help="Harnesses to run (space- or comma-separated): eliza hermes openclaw random_v1 perfect_v1 wrong_v1 half_v1",
    )
    p_run.add_argument(
        "--all-harnesses",
        action="store_true",
        help="Run each selected benchmark with eliza, hermes, and openclaw",
    )
    p_run.add_argument(
        "--include-random-baseline",
        action="store_true",
        help="Additionally run a phantom random_v1 baseline against each selected benchmark",
    )
    p_run.add_argument(
        "--include-calibration-harnesses",
        action="store_true",
        help="Additionally run perfect_v1, wrong_v1, and half_v1 calibration harnesses",
    )
    p_run.add_argument("--provider", default="cerebras", help="Model provider")
    p_run.add_argument("--model", default="gpt-oss-120b", help="Model name")
    p_run.add_argument("--extra", default=None, help="JSON object with benchmark-specific options")
    p_run.add_argument("--resume", action="store_true", help="Alias for idempotent run behavior")
    p_run.add_argument("--rerun-failed", action="store_true", help="Only re-run failed signatures")
    p_run.add_argument("--force", action="store_true", help="Force a new run regardless of existing success")
    p_run.add_argument(
        "--skip-incompatible",
        dest="skip_incompatible",
        action="store_true",
        default=True,
        help="Suppress incompatible-status outcomes from the printed summary (default: True; still recorded in SQLite)",
    )
    p_run.add_argument(
        "--show-incompatible",
        dest="skip_incompatible",
        action="store_false",
        help="Include incompatible (harness/benchmark mismatch) outcomes in the printed summary",
    )
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

    p_calibration = sub.add_parser(
        "calibration-report",
        help="Report calibration harness health and all-right/all-wrong benchmark patterns",
    )
    p_calibration.add_argument(
        "--tolerance",
        type=float,
        default=1e-6,
        help="Absolute/relative tolerance for score comparisons",
    )
    p_calibration.add_argument("--json", action="store_true", help="Print full JSON report")
    p_calibration.add_argument(
        "--fail-on-suspicious",
        action="store_true",
        help="Exit nonzero if calibration is missing/mismatched or real harnesses tie exactly",
    )
    p_calibration.set_defaults(func=_cmd_calibration_report)

    p_serve = sub.add_parser("serve-viewer", help="Serve benchmarks/viewer with live API data")
    p_serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=8877, help="Bind port (default: 8877)")
    p_serve.set_defaults(func=_cmd_serve_viewer)

    p_compare = sub.add_parser(
        "compare",
        help="Run benchmarks twice (A vs B) and print a side-by-side delta table",
    )
    p_compare.add_argument(
        "--a",
        required=True,
        help="Side A spec: '<provider>:<model>[@<base_url>]' (e.g. vllm:elizaos/eliza-1-2b@http://127.0.0.1:8001/v1)",
    )
    p_compare.add_argument(
        "--b",
        required=True,
        help="Side B spec: '<provider>:<model>[@<base_url>]'",
    )
    p_compare.add_argument(
        "--benchmarks",
        required=True,
        help="Comma-separated benchmark IDs (e.g. action-calling,bfcl,realm,context-bench)",
    )
    p_compare.add_argument(
        "--max-examples",
        type=int,
        default=None,
        help="Cap examples per benchmark when supported (forwarded as max_examples/max_tasks/sample)",
    )
    p_compare.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Sampling temperature (default: 0.0)",
    )
    p_compare.add_argument(
        "--out",
        default=None,
        help="Output directory for compare-<comparison_id>.json (default: benchmark_results/comparisons/)",
    )
    p_compare.set_defaults(func=_cmd_compare)

    p_view = sub.add_parser(
        "view-comparison",
        help="Print the delta table for a previously stored comparison",
    )
    p_view.add_argument("comparison_id", help="Comparison UUID returned by `compare`")
    p_view.set_defaults(func=_cmd_view_comparison)

    add_compare_vs_random_parser(sub)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
