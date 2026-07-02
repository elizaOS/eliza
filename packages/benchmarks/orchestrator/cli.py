from __future__ import annotations

import argparse
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .adapters import discover_adapters
from .artifact_guard import build_artifact_guard_report
from .calibration_report import build_calibration_report, print_calibration_report
from .compare_vs_random import add_compare_vs_random_parser
from .db import (
    connect_database,
    initialize_database,
    list_runs_for_comparison,
    recover_stale_running_runs,
    repair_nonpublishable_success_statuses,
    repair_nonzero_returncode_statuses,
    tag_run_with_comparison,
)
from .latest_comparability import print_comparability_report, validate_latest_comparability
from .latest_publishability import print_publishability_report, validate_latest_publishability
from .latest_readiness import print_readiness_report, validate_latest_readiness
from .inventory import (
    build_inventory_report,
    report_to_json as inventory_report_to_json,
    report_to_markdown as inventory_report_to_markdown,
)
from .random_baseline_runner import CALIBRATION_HARNESSES, SYNTHETIC_HARNESSES
from .review_package import build_review_package, write_review_package
from .runner import _rebuild_latest_result_snapshots, _repair_current_compatibility_statuses, run_benchmarks
from .matrix_validation import build_cross_matrix_report, report_to_json, report_to_markdown
from .runtime_gates import build_runtime_gate_report, print_runtime_gate_report
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


def _profile_path(workspace_root: Path, raw: str) -> Path:
    value = raw.strip()
    candidate = Path(value)
    if candidate.exists():
        return candidate
    profiles_root = workspace_root / "benchmarks" / "orchestrator" / "profiles"
    name = value if value.endswith(".json") else f"{value}.json"
    return profiles_root / name


def _apply_model_profile(args: argparse.Namespace, workspace_root: Path) -> None:
    raw = getattr(args, "model_profile", None)
    if not raw:
        return
    path = _profile_path(workspace_root, str(raw))
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("--model-profile must point to a JSON object")
    provider = data.get("provider")
    model = data.get("model")
    if isinstance(provider, str) and provider.strip():
        args.provider = provider.strip()
    if isinstance(model, str) and model.strip():
        args.model = model.strip()
    extra = data.get("extra")
    if isinstance(extra, dict):
        current = _parse_json_arg(args.extra)
        merged = dict(extra)
        merged.update(current)
        args.extra = json.dumps(merged, ensure_ascii=True)


def _build_request(args: argparse.Namespace, adapters: dict[str, Any]) -> RunRequest:
    if args.all:
        benchmarks = tuple(sorted(adapters.keys()))
    elif args.benchmarks:
        benchmarks = tuple(args.benchmarks)
    else:
        benchmarks = tuple(sorted(adapters.keys()))

    extra_config = _parse_json_arg(args.extra)
    for attr in ("expand_scenarios", "count_scenarios", "validate_scenarios"):
        if bool(getattr(args, attr, False)):
            extra_config[attr] = True

    return RunRequest(
        benchmarks=benchmarks,
        agent=args.agent,
        provider=args.provider,
        model=args.model,
        extra_config=extra_config,
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


def _cmd_validate_matrix(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    _apply_model_profile(args, workspace_root)
    report = build_cross_matrix_report(
        workspace_root.parent,
        provider=args.provider,
        model=args.model,
        extra_config=_parse_json_arg(args.extra),
    )
    if args.format == "json":
        print(report_to_json(report))
    else:
        print(report_to_markdown(report))
    return 1 if report.error_count else 0


def _cmd_inventory(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    report = build_inventory_report(workspace_root.parent)
    if args.format == "json":
        print(inventory_report_to_json(report))
    else:
        print(inventory_report_to_markdown(report))
    return 2 if report.has_gaps else 0


def _execute_run(args: argparse.Namespace) -> dict[str, int]:
    """Run the selected benchmarks/harnesses and print a summary.

    Returns the outcome counts by status so callers (``run`` and ``review``) can
    apply their own success criteria without reimplementing the run loop.
    """
    workspace_root = _workspace_root_from_here()
    _apply_model_profile(args, workspace_root)
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

    counts = {"succeeded": 0, "failed": 0, "skipped": 0, "incompatible": 0}
    # Default-on: suppress per-outcome printing for incompatible (harness/benchmark
    # mismatch) rows in the summary. They are always recorded in SQLite either way.
    skip_incompatible = bool(getattr(args, "skip_incompatible", True))

    for outcome in all_outcomes:
        if outcome.status == "incompatible" and skip_incompatible:
            counts["incompatible"] += 1
            continue
        print(
            f"- {outcome.benchmark_id:16s} "
            f"run_id={outcome.run_id} "
            f"status={outcome.status} "
            f"score={outcome.score}"
        )
        if outcome.status in counts:
            counts[outcome.status] += 1

    print("")
    print(
        f"Summary: succeeded={counts['succeeded']} failed={counts['failed']} "
        f"skipped={counts['skipped']} incompatible={counts['incompatible']}"
    )
    return counts


def _cmd_run(args: argparse.Namespace) -> int:
    counts = _execute_run(args)
    return 1 if counts["failed"] > 0 else 0


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
            if value not in {"eliza", "hermes", "openclaw", "smithers", "codex", *SYNTHETIC_HARNESSES}:
                raise SystemExit(
                    "Unknown harness "
                    f"'{value}'. Expected eliza, hermes, openclaw, smithers, "
                    "codex, random_v1, perfect_v1, wrong_v1, or half_v1."
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
    repair_nonpublishable_success_statuses(conn)
    discovery = discover_adapters(workspace_root)
    _repair_current_compatibility_statuses(conn, discovery.adapters)
    _rebuild_latest_result_snapshots(conn, output_root, discovery.adapters)
    out = _rebuild_viewer_json(
        workspace_root,
        conn,
        benchmark_ids=set(discovery.adapters),
    )
    conn.close()
    print(str(out))
    return 0


def _rebuild_viewer_json(
    workspace_root: Path,
    conn,
    *,
    benchmark_ids: set[str] | None = None,
) -> Path:
    data = build_viewer_dataset(conn, benchmark_ids=benchmark_ids)
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
    nonpublishable_repaired = repair_nonpublishable_success_statuses(conn)
    discovery = discover_adapters(workspace_root)
    compatibility_repaired = _repair_current_compatibility_statuses(conn, discovery.adapters)
    _rebuild_latest_result_snapshots(
        conn,
        workspace_root / "benchmarks" / "benchmark_results",
        discovery.adapters,
    )
    viewer_snapshot = _rebuild_viewer_json(
        workspace_root,
        conn,
        benchmark_ids=set(discovery.adapters),
    )
    conn.close()

    print(f"Recovered runs: {len(recovered)}")
    print(f"Repaired nonzero-return-code statuses: {repaired}")
    print(f"Repaired nonpublishable success statuses: {nonpublishable_repaired}")
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
            if row.get("missing_required_real_harnesses") or row.get("failed_required_real_harnesses"):
                return 1
            if row.get("real_pattern") in {
                "all_real_zero",
                "all_real_one",
                "all_real_equal",
                "single_real_zero",
            }:
                return 1
            if str(row.get("real_pattern") or "").endswith("_mixed_config"):
                return 1
    return 0


def _cmd_validate_latest_publishability(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    latest_dir = Path(args.latest_dir).expanduser() if args.latest_dir else None
    report = validate_latest_publishability(
        workspace_root,
        latest_dir=latest_dir,
        include_benchmarks=set(_split_csv(args.include_benchmarks)) or None,
        exclude_benchmarks=set(_split_csv(args.exclude_benchmarks)) or None,
    )
    if args.json:
        print(report.to_json())
    else:
        print_publishability_report(report)
    return 0 if report.ok else 1


def _cmd_validate_latest_comparability(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    latest_dir = Path(args.latest_dir).expanduser() if args.latest_dir else None
    report = validate_latest_comparability(
        workspace_root,
        tolerance=float(args.tolerance),
        latest_dir=latest_dir,
        include_benchmarks=set(_split_csv(args.include_benchmarks)) or None,
        exclude_benchmarks=set(_split_csv(args.exclude_benchmarks)) or None,
    )
    if args.json:
        print(report.to_json())
    else:
        print_comparability_report(report)
    return 0 if report.ok else 1


def _cmd_validate_latest_readiness(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    latest_dir = Path(args.latest_dir).expanduser() if args.latest_dir else None
    report = validate_latest_readiness(
        workspace_root,
        tolerance=float(args.tolerance),
        latest_dir=latest_dir,
        check_runtime_gates=not bool(args.skip_runtime_gates),
        include_benchmarks=set(_split_csv(args.include_benchmarks)) or None,
        exclude_benchmarks=set(_split_csv(args.exclude_benchmarks)) or None,
    )
    if args.json:
        print(report.to_json())
    else:
        print_readiness_report(report)
    return 0 if report.ok else 1


def _cmd_validate_runtime_gates(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    report = build_runtime_gate_report(workspace_root)
    if args.json:
        print(report.to_json())
    else:
        print_runtime_gate_report(report)
    return 0 if report.ok else 1


def _cmd_verify_artifacts(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    report = build_artifact_guard_report(workspace_root)
    print(report.to_markdown())
    return 0 if report.ok else 1


def _cmd_review(args: argparse.Namespace) -> int:
    """One operator wrapper (#10199): preflight -> run -> validate -> package -> verify.

    Chains the existing subcommands in order and fails clearly at the first step
    that cannot proceed. It never reimplements a step — each phase delegates to
    the same ``_cmd_*`` function the standalone subcommand uses. When the run
    step needs a provider key it does not have, that step fails loudly (a missing
    required env var is recorded as a ``failed`` run), so the wrapper exits
    nonzero rather than silently reporting success.
    """
    workspace_root = _workspace_root_from_here()
    _apply_model_profile(args, workspace_root)

    out_dir = Path(args.out).expanduser()
    steps_ran: list[str] = []

    def _emit(step: str, code: int) -> None:
        steps_ran.append(step)
        print(f"[review] {step}: {'ok' if code == 0 else f'FAILED (exit {code})'}")

    # --- 1. Preflight: static inventory. Fail on registry<->adapter drift. ---
    #
    # The trust concern (#10193) is that the registry and the adapters agree:
    # every registered benchmark must have an adapter. Legacy/vendored benchmark
    # directories that were never wired as adapters are a known, pre-existing
    # baseline (they predate this wrapper) and are NOT drift to block a review on
    # — so preflight fails only when a *registered* benchmark has no adapter.
    print("[review] step 1/5: preflight (inventory)")
    inventory = build_inventory_report(workspace_root.parent)
    print(inventory_report_to_markdown(inventory))
    if inventory.registry_entries_without_adapters:
        _emit("preflight (inventory)", 2)
        print(
            "[review] preflight failed: registered benchmarks have no orchestrator "
            "adapter (registry<->adapter drift): "
            f"{', '.join(inventory.registry_entries_without_adapters)}. "
            "Fix the drift before running."
        )
        return 2
    if inventory.benchmark_directories_without_adapters:
        print(
            "[review] note: "
            f"{len(inventory.benchmark_directories_without_adapters)} legacy "
            "benchmark directory(ies) have no adapter (pre-existing baseline, "
            "not blocking): "
            f"{', '.join(inventory.benchmark_directories_without_adapters)}"
        )
    _emit("preflight (inventory)", 0)

    # --- 2. Run the selected benchmarks/adapters/provider/model. ---
    #
    # The review is stricter than a bare `run`: a `run` exits 0 as long as
    # nothing *failed*, but a review must produce real graded runs. So any
    # failed outcome, OR a run that produced zero successes (every selected
    # benchmark was incompatible/skipped — the harness could not actually run
    # it), fails the review loudly rather than packaging an empty result.
    print("[review] step 2/5: run")
    run_args = _review_run_namespace(args)
    counts = _execute_run(run_args)
    if counts["failed"] > 0:
        _emit("run", 1)
        print(
            "[review] run failed: a harness could not run, a scorer could not "
            "parse, a provider key is absent, or trajectories are missing "
            f"(failed={counts['failed']}). Not packaging a blocked run."
        )
        return 1
    if counts["succeeded"] == 0:
        _emit("run", 1)
        print(
            "[review] run produced no graded results "
            f"(succeeded=0, incompatible={counts['incompatible']}, "
            f"skipped={counts['skipped']}): the selected harness cannot run the "
            "selected benchmark(s) here. Not packaging an empty result."
        )
        return 1
    _emit("run", 0)

    # --- 3. Validate gates: latest readiness (publishability + comparability). --
    print("[review] step 3/5: validate gates (latest readiness)")
    readiness_args = argparse.Namespace(
        tolerance=float(args.tolerance),
        latest_dir=None,
        skip_runtime_gates=bool(args.skip_runtime_gates),
        include_benchmarks=_review_selected_benchmarks_csv(args),
        exclude_benchmarks=None,
        json=False,
    )
    readiness_code = _cmd_validate_latest_readiness(readiness_args)
    _emit("validate gates (latest readiness)", readiness_code)
    if readiness_code != 0:
        print(
            "[review] validate failed: latest rows are not complete/publishable/"
            "comparable. Not packaging an unready matrix."
        )
        return readiness_code

    # --- 4. Review package: scorecard.md + manifest.json (needs reviewer note). --
    print("[review] step 4/5: review-package")
    package_args = argparse.Namespace(
        latest_dir=None,
        out_dir=str(out_dir),
        reviewed_by=args.reviewed_by,
        reviewer_note=args.reviewer_note,
        tolerance=float(args.tolerance),
        skip_runtime_gates=bool(args.skip_runtime_gates),
        include_benchmarks=_review_selected_benchmarks_csv(args),
        exclude_benchmarks=None,
    )
    package_code = _cmd_review_package(package_args)
    _emit("review-package", package_code)
    if package_code != 0:
        print(
            "[review] review-package is blocked; inspect blocking_findings in "
            f"{out_dir / 'manifest.json'}."
        )
        return package_code

    # --- 5. Verify artifacts: no generated benchmark output would be committed. --
    print("[review] step 5/5: verify-artifacts")
    verify_code = _cmd_verify_artifacts(argparse.Namespace())
    _emit("verify-artifacts", verify_code)
    if verify_code != 0:
        print(
            "[review] verify-artifacts failed: generated benchmark output is "
            "staged/committed. `git rm --cached` it; only the reviewed scorecard "
            "belongs in version control."
        )
        return verify_code

    print("")
    print(f"[review] all steps passed: {', '.join(steps_ran)}")
    print(f"[review] scorecard + manifest written to {out_dir}")
    return 0


def _review_selected_benchmarks_csv(args: argparse.Namespace) -> str | None:
    """The benchmark ids the review targets, as a CSV string (or None for all)."""
    if bool(getattr(args, "all", False)):
        return None
    benchmarks = getattr(args, "benchmarks", None)
    if not benchmarks:
        return None
    ids: list[str] = []
    for item in benchmarks:
        ids.extend(part.strip() for part in str(item).split(",") if part.strip())
    return ",".join(ids) if ids else None


def _review_run_namespace(args: argparse.Namespace) -> argparse.Namespace:
    """Build the ``run`` step's args from the review flags.

    ``--adapters`` selects the harness(es) via the run step's ``--harnesses``
    mechanism; ``--accounts`` is forwarded through ``--extra`` so the codex
    harness (and any account-aware harness) can iterate materialized CODEX_HOMEs.
    Benchmarks come from ``--all`` or ``--benchmarks``.
    """
    adapters = _split_review_adapters(getattr(args, "adapters", None))
    extra_config = _parse_json_arg(getattr(args, "extra", None))
    accounts = getattr(args, "accounts", None)
    if accounts not in (None, ""):
        extra_config["accounts"] = accounts
    return argparse.Namespace(
        all=bool(getattr(args, "all", False)),
        benchmarks=list(getattr(args, "benchmarks", None) or []) or None,
        agent=adapters[0] if adapters else "eliza",
        harnesses=list(adapters) if adapters else None,
        all_harnesses=False,
        include_random_baseline=False,
        include_calibration_harnesses=False,
        provider=args.provider,
        model=args.model,
        model_profile=None,  # already applied on the review args
        extra=json.dumps(extra_config, ensure_ascii=True) if extra_config else None,
        expand_scenarios=False,
        count_scenarios=False,
        validate_scenarios=False,
        resume=False,
        rerun_failed=bool(getattr(args, "rerun_failed", False)),
        force=bool(getattr(args, "force", False)),
        skip_incompatible=True,
    )


def _split_review_adapters(raw: object) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = [raw]
    values: list[str] = []
    for item in raw:
        values.extend(part.strip().lower() for part in str(item).split(",") if part.strip())
    deduped: list[str] = []
    for value in values:
        if value not in deduped:
            deduped.append(value)
    return deduped


def _cmd_review_package(args: argparse.Namespace) -> int:
    workspace_root = _workspace_root_from_here()
    latest_dir = Path(args.latest_dir).expanduser() if args.latest_dir else None
    package = build_review_package(
        workspace_root,
        latest_dir=latest_dir,
        reviewed_by=args.reviewed_by,
        reviewer_note=args.reviewer_note,
        tolerance=float(args.tolerance),
        check_runtime_gates=not bool(args.skip_runtime_gates),
        include_benchmarks=set(_split_csv(args.include_benchmarks)) or None,
        exclude_benchmarks=set(_split_csv(args.exclude_benchmarks)) or None,
    )
    manifest_path, scorecard_path = write_review_package(
        package,
        Path(args.out_dir).expanduser(),
    )
    print(f"Wrote manifest: {manifest_path}")
    print(f"Wrote scorecard: {scorecard_path}")
    if not package.ok:
        print(
            "Benchmark review package is blocked; inspect `blocking_findings` "
            "in the manifest or the scorecard section above."
        )
        return 1
    print("Benchmark review package is complete.")
    return 0


def _parse_model_spec(spec: str) -> tuple[str, str, str | None]:
    """Parse ``provider:model[@base_url]`` into ``(provider, model, base_url)``.

    Examples:
        ``vllm:elizaos/eliza-1@http://127.0.0.1:8001/v1``
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

    p_matrix = sub.add_parser(
        "validate-matrix",
        help="Dry-run validate adapter/harness command, env, locator, and trajectory contracts",
    )
    p_matrix.add_argument("--provider", default="cerebras", help="Model provider")
    p_matrix.add_argument("--model", default="gemma-4-31b", help="Model name")
    p_matrix.add_argument(
        "--model-profile",
        default=None,
        help="Model profile JSON path or name under benchmarks/orchestrator/profiles",
    )
    p_matrix.add_argument("--extra", default=None, help="JSON object merged into every dry-run request")
    p_matrix.add_argument("--format", choices=("markdown", "json"), default="markdown")
    p_matrix.set_defaults(func=_cmd_validate_matrix)

    p_inventory = sub.add_parser(
        "inventory",
        help="Generate the static benchmark registry/adapter/operator checklist",
    )
    p_inventory.add_argument("--format", choices=("markdown", "json"), default="markdown")
    p_inventory.set_defaults(func=_cmd_inventory)

    p_verify_artifacts = sub.add_parser(
        "verify-artifacts",
        help="Fail if generated benchmark output (results/DBs/trajectories) is committed",
    )
    p_verify_artifacts.set_defaults(func=_cmd_verify_artifacts)

    p_review = sub.add_parser(
        "review-package",
        help="Write the final reviewed benchmark scorecard and machine-readable manifest",
    )
    p_review.add_argument(
        "--latest-dir",
        default=None,
        help="Latest snapshot directory to package (default: benchmark_results/latest)",
    )
    p_review.add_argument(
        "--out-dir",
        required=True,
        help="Directory that receives manifest.json and scorecard.md",
    )
    p_review.add_argument(
        "--reviewed-by",
        default="",
        help="Human reviewer name or handle recorded in the manifest",
    )
    p_review.add_argument(
        "--reviewer-note",
        required=True,
        help="Manual note confirming trajectories/replays were opened and spot-reviewed",
    )
    p_review.add_argument(
        "--tolerance",
        type=float,
        default=0.08,
        help="Allowed absolute score spread across required real harnesses",
    )
    p_review.add_argument(
        "--skip-runtime-gates",
        action="store_true",
        help="Package latest artifacts without probing host runtime prerequisites",
    )
    p_review.add_argument(
        "--include-benchmarks",
        default=None,
        help="Comma-separated benchmark IDs to include in the review package",
    )
    p_review.add_argument(
        "--exclude-benchmarks",
        default=None,
        help="Comma-separated benchmark IDs to exclude from the review package",
    )
    p_review.set_defaults(func=_cmd_review_package)

    p_review_all = sub.add_parser(
        "review",
        help=(
            "One operator wrapper (#10199): preflight (inventory) -> run -> "
            "validate gates -> review-package -> verify-artifacts. Fails clearly "
            "at the first step that cannot proceed."
        ),
    )
    p_review_all.add_argument("--all", action="store_true", help="Run all registered benchmarks")
    p_review_all.add_argument(
        "--benchmarks",
        nargs="+",
        default=None,
        help="Benchmark IDs to run/package (space- or comma-separated)",
    )
    p_review_all.add_argument(
        "--adapters",
        nargs="+",
        default=None,
        help="Harness adapters to run (e.g. eliza hermes openclaw smithers codex)",
    )
    p_review_all.add_argument("--provider", default="cerebras", help="Model provider")
    p_review_all.add_argument("--model", default="gemma-4-31b", help="Model name")
    p_review_all.add_argument(
        "--model-profile",
        default=None,
        help=(
            "Model profile JSON path or name under benchmarks/orchestrator/profiles. "
            "Profile provider/model override --provider/--model."
        ),
    )
    p_review_all.add_argument(
        "--accounts",
        default=None,
        help=(
            "Account selection forwarded to account-aware harnesses (e.g. codex): "
            "an integer N (first N materialized CODEX_HOMEs) or a comma-separated "
            "account-id list. Omit to use all materialized accounts."
        ),
    )
    p_review_all.add_argument(
        "--extra", default=None, help="JSON object with benchmark-specific options"
    )
    p_review_all.add_argument("--rerun-failed", action="store_true", help="Only re-run failed signatures")
    p_review_all.add_argument(
        "--force", action="store_true", help="Force a new run regardless of existing success"
    )
    p_review_all.add_argument(
        "--out",
        required=True,
        help="Directory that receives the reviewed scorecard.md + manifest.json",
    )
    p_review_all.add_argument(
        "--reviewed-by",
        default="",
        help="Human reviewer name or handle recorded in the manifest",
    )
    p_review_all.add_argument(
        "--reviewer-note",
        required=True,
        help="Manual note confirming trajectories/replays were opened and spot-reviewed",
    )
    p_review_all.add_argument(
        "--tolerance",
        type=float,
        default=0.08,
        help="Allowed absolute score spread across required real harnesses",
    )
    p_review_all.add_argument(
        "--skip-runtime-gates",
        action="store_true",
        help="Validate/package without probing host runtime prerequisites",
    )
    p_review_all.set_defaults(func=_cmd_review)

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
    p_run.add_argument("--model", default="gemma-4-31b", help="Model name")
    p_run.add_argument(
        "--model-profile",
        default=None,
        help=(
            "Model profile JSON path or name under benchmarks/orchestrator/profiles. "
            "Profile provider/model override --provider/--model; CLI --extra overrides profile extra."
        ),
    )
    p_run.add_argument("--extra", default=None, help="JSON object with benchmark-specific options")
    p_run.add_argument(
        "--expand-scenarios",
        action="store_true",
        help="Forward benchmark-native edge scenario expansion where supported",
    )
    p_run.add_argument(
        "--count-scenarios",
        action="store_true",
        help="Forward benchmark-native scenario count mode where supported",
    )
    p_run.add_argument(
        "--validate-scenarios",
        action="store_true",
        help="Forward benchmark-native scenario validation mode where supported",
    )
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

    p_publishability = sub.add_parser(
        "validate-latest-publishability",
        help="Fail if published latest benchmark rows contain sample/demo/mock/stub markers",
    )
    p_publishability.add_argument(
        "--latest-dir",
        default=None,
        help="Explicit latest snapshot directory to validate (default: benchmark_results/latest)",
    )
    p_publishability.add_argument(
        "--include-benchmarks",
        default="",
        help="Comma-separated benchmark ids to include",
    )
    p_publishability.add_argument(
        "--exclude-benchmarks",
        default="",
        help="Comma-separated benchmark ids to exclude",
    )
    p_publishability.add_argument("--json", action="store_true", help="Print full JSON report")
    p_publishability.set_defaults(func=_cmd_validate_latest_publishability)

    p_latest_comparability = sub.add_parser(
        "validate-latest-comparability",
        help="Fail if required latest real harness scores are missing, mixed-config, or outside tolerance",
    )
    p_latest_comparability.add_argument(
        "--tolerance",
        type=float,
        default=0.08,
        help="Allowed absolute score spread across required real harnesses",
    )
    p_latest_comparability.add_argument(
        "--latest-dir",
        default=None,
        help="Explicit latest snapshot directory to validate (default: benchmark_results/latest)",
    )
    p_latest_comparability.add_argument(
        "--include-benchmarks",
        default="",
        help="Comma-separated benchmark ids to include",
    )
    p_latest_comparability.add_argument(
        "--exclude-benchmarks",
        default="",
        help="Comma-separated benchmark ids to exclude",
    )
    p_latest_comparability.add_argument("--json", action="store_true", help="Print full JSON report")
    p_latest_comparability.set_defaults(func=_cmd_validate_latest_comparability)

    p_latest_readiness = sub.add_parser(
        "validate-latest-readiness",
        help="Fail unless latest rows prove the full real harness matrix is complete, publishable, and comparable",
    )
    p_latest_readiness.add_argument(
        "--tolerance",
        type=float,
        default=0.08,
        help="Allowed absolute/relative score spread across required real harnesses",
    )
    p_latest_readiness.add_argument(
        "--latest-dir",
        default=None,
        help="Explicit latest snapshot directory to validate (default: benchmark_results/latest)",
    )
    p_latest_readiness.add_argument(
        "--skip-runtime-gates",
        action="store_true",
        help="Validate published latest artifacts without probing host runtime prerequisites",
    )
    p_latest_readiness.add_argument(
        "--include-benchmarks",
        default=None,
        help="Comma-separated benchmark IDs to include in readiness validation",
    )
    p_latest_readiness.add_argument(
        "--exclude-benchmarks",
        default=None,
        help="Comma-separated benchmark IDs to exclude from readiness validation",
    )
    p_latest_readiness.add_argument("--json", action="store_true", help="Print full JSON report")
    p_latest_readiness.set_defaults(func=_cmd_validate_latest_readiness)

    p_runtime_gates = sub.add_parser(
        "validate-runtime-gates",
        help="Probe external runtime prerequisites for benchmarks that cannot use sample/demo fallbacks",
    )
    p_runtime_gates.add_argument("--json", action="store_true", help="Print full JSON report")
    p_runtime_gates.set_defaults(func=_cmd_validate_runtime_gates)

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
        help="Side A spec: '<provider>:<model>[@<base_url>]' (e.g. vllm:elizaos/eliza-1@http://127.0.0.1:8001/v1)",
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
