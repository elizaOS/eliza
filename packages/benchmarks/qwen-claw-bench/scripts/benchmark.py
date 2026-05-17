#!/usr/bin/env python3
"""
Run QwenClawBench tasks in batch using Docker containers with concurrency support.

Usage:
    # Run all tasks, 10 containers in parallel
    python scripts/benchmark.py --model dashscope/qwen3.6-plus --dataset qwenclawbench-v1.1-100 --concurrency 10

    # Custom Docker image
    python scripts/benchmark.py --model dashscope/qwen3.6-plus --docker-image myimage:latest
"""
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pyyaml>=6.0.1",
#     "tqdm>=4.0",
# ]
# ///

import argparse
import json
import logging
import os
import statistics
import subprocess
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from concurrent.futures import Future, ThreadPoolExecutor, wait, FIRST_COMPLETED
from tqdm import tqdm
from tqdm.contrib.logging import logging_redirect_tqdm

from lib_agent import slugify_model, THINKING_LEVELS, validate_thinking_level
from lib_anomalies import detect_anomalies
from lib_docker import execute_task_in_docker, cleanup_containers, DEFAULT_IMAGE
from lib_grading import GradeResult, grade_task, pass_k_stats, _load_openclaw_env
from lib_tasks import Task, TaskLoader

# Configure logging (file handler added later once model/dataset are known)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("benchmark")

# Docker workspace snapshots are restricted to this directory for safety
_WORKSPACE_SNAPSHOT_ROOT = Path("/tmp/qwenclawbench").resolve()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="QwenClawBench Runner")
    parser.add_argument(
        "--model",
        required=False,
        help="Model identifier (e.g. dashscope/qwen3.6-plus)"
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default="qwenclawbench-v1.1-100",
        help="The dataset name to use for evaluation; loaded tasks and assets will be sourced from <dataset>/tasks and <dataset>/assets",
    )
    parser.add_argument(
        "--output-dir",
        default="results",
        help="Results directory"
    )
    parser.add_argument(
        "--task",
        type=str,
        default=None,
        help="Single task ID shorthand; sets --suite=TASK_ID",
    )
    parser.add_argument(
        "--suite",
        default="all",
        help='Tasks to run: "all", "automated-only", or comma-separated task IDs',
    )
    parser.add_argument(
        "--concurrency",
        "-c",
        type=int,
        default=1,
        help="Max concurrent Docker containers"
    )
    parser.add_argument(
        "--docker-image",
        default=DEFAULT_IMAGE, 
        help="Docker image (default: %s)" % DEFAULT_IMAGE
    )
    parser.add_argument(
        "--timeout-multiplier",
        type=float,
        default=1.0,
        help="Scale all task timeouts"
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=1,
        help="Number of runs per task for averaging"
    )
    parser.add_argument(
        "--judge",
        default=None,
        help="Judge model identifier (default: anthropic/claude-opus-4.5)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Verbose logging"
    )
    parser.add_argument(
        "--no-grade",
        action="store_true",
        help="Skip grading, only execute"
    )
    parser.add_argument(
        "--thinking",
        type=str,
        default=None,
        help=(
            f"Thinking level to use (e.g. 'low', 'medium', 'high'). "
            f"Valid levels: {', '.join(THINKING_LEVELS)}. "
            "If not specified, runs without an explicit thinking level."
        ),
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="Force a fresh batch even if a resumable run exists in --output-dir",
    )
    parser.add_argument(
        "--rerun-anomalous",
        action="store_true",
        help="With resume: rerun all previously anomalous runs (WARNING + ERROR level).",
    )
    parser.add_argument(
        "--rerun-error",
        action="store_true",
        help=(
            "With resume: rerun only runs with ERROR-level anomalies (score-impacting failures "
            "such as timeout, crash, empty transcript). Use --rerun-anomalous to also rerun "
            "WARNING-only anomalies (e.g. transient rate limits that did not affect the score)."
        ),
    )
    parser.add_argument(
        "--cleanup",
        action="store_true",
        help="Remove all leftover Docker containers and exit",
    )
    parser.add_argument(
        "--log-file",
        default="benchmark.log",
        help="Path to log file (default: benchmark.log)",
    )
    parser.add_argument(
        "--simple-scoring",
        action="store_true",
        help=(
            "Use simple weighted average for hybrid tasks instead of the default penalized scoring "
            "(default: auto≤0.75 → LLM contribution zeroed out)"
        ),
    )
    return parser.parse_args()


def _select_task_ids(tasks: List[Task], suite: str) -> Optional[List[str]]:
    """Select task IDs based on suite specification.

    Args:
        tasks: List of all available tasks
        suite: Suite specification ("all", "automated-only", or comma-separated task IDs)

    Returns:
        None for all tasks, or list of task IDs to run
    """
    if suite == "all":
        return None
    if suite == "automated-only":
        return [t.task_id for t in tasks if t.grading_type == "automated"]
    return [tid.strip() for tid in suite.split(",") if tid.strip()]


def _load_existing_results(
    batch_dir: Path,
    tasks_to_run: List["Task"],
    runs_per_task: int,
    thinking_level: Optional[str],
    rerun_anomalous: bool,
    rerun_error: bool,
    model_slug: str,
    simple_scoring: bool = False,
) -> tuple:
    """Load previously completed run results from grading.json files.

    Args:
        batch_dir: Directory containing previous batch results
        tasks_to_run: List of tasks to execute
        runs_per_task: Number of runs per task
        thinking_level: Thinking level for this run (None = default)
        rerun_anomalous: Whether to rerun all anomalous runs (WARNING + ERROR level)
        rerun_error: Whether to rerun only ERROR-level (score-impacting) anomalous runs
        model_slug: Slugified model identifier

    Returns:
        Tuple of (execution_results, results, grades_by_task, skipped_count).
        Runs that are missing or flagged for rerun are omitted so work_items picks them up.
    """
    execution_results: Dict[str, List[tuple]] = {t.task_id: [] for t in tasks_to_run}
    results: List[Dict[str, Any]] = []
    grades_by_task: Dict[str, Dict[str, Any]] = {}
    skipped_count = 0

    for task in tasks_to_run:
        task_id = task.task_id
        for run_idx in range(runs_per_task):
            folder = _subfolder_name(task_id, run_idx, runs_per_task)
            task_dir = batch_dir / folder
            grading_file = task_dir / "grading.json"

            if not grading_file.exists():
                continue

            try:
                grading_data = json.loads(grading_file.read_text(encoding="utf-8"))
            except Exception:
                logger.warning("Could not read %s — will rerun", grading_file)
                continue

            anomalies = grading_data.get("anomalies", {})
            # --rerun-anomalous: rerun all anomalous runs (WARNING + ERROR)
            if rerun_anomalous and anomalies.get("is_anomalous", False):
                logger.info(
                    "   [resume] %s [%s] run %d is anomalous — will rerun",
                    task_id,
                    thinking_level or "default",
                    run_idx + 1,
                )
                continue
            # --rerun-error: rerun only ERROR-level (score-impacting) runs
            # Compat: old grading.json files use "has_critical", new ones use "has_error"
            has_error = anomalies.get("has_error", anomalies.get("has_critical", False))
            if rerun_error and has_error:
                logger.info(
                    "   [resume] %s [%s] run %d has ERROR anomaly — will rerun",
                    task_id,
                    thinking_level or "default",
                    run_idx + 1,
                )
                continue

            # Reconstruct execution result from saved data
            execution = grading_data.get("execution", {})
            transcript: List[Any] = []
            transcript_file = task_dir / "transcript.json"
            if transcript_file.exists():
                try:
                    transcript = json.loads(transcript_file.read_text(encoding="utf-8"))
                except Exception:
                    pass

            mock_result: Dict[str, Any] = {
                "agent_id": f"bench-{model_slug}",
                "task_id": task_id,
                "thinking_level": thinking_level,
                "status": execution.get("status", "success"),
                "transcript": transcript,
                "usage": {},
                "workspace": "",
                "exit_code": execution.get("exit_code"),
                "timed_out": execution.get("timed_out", False),
                "execution_time": execution.get("execution_time", 0.0),
                "stdout": "",
                "stderr": "",
                "_anomalies": anomalies,
            }

            mock_grade = GradeResult(
                task_id=grading_data["task_id"],
                score=grading_data["score"],
                score_simple=grading_data.get("score_simple"),
                max_score=grading_data.get("max_score", 1.0),
                grading_type=grading_data["grading_type"],
                breakdown=grading_data.get("breakdown", {}),
                notes=grading_data.get("notes", ""),
            )

            execution_results[task_id].append((run_idx, mock_result, mock_grade))
            results.append(mock_result)
            skipped_count += 1

        # Pre-aggregate if all runs for this task are loaded
        task_runs = execution_results[task_id]
        if len(task_runs) == runs_per_task:
            task_grades = [g for _, _, g in task_runs]
            if simple_scoring:
                scores = [g.score_simple if g.score_simple is not None else g.score for g in task_grades]
            else:
                scores = [g.score for g in task_grades]
            grades_by_task[task_id] = {
                "task_id": task_id,
                "thinking_level": thinking_level,
                "runs": [g.to_dict() for g in task_grades],
                "mean": statistics.mean(scores),
                "std": statistics.stdev(scores) if len(scores) > 1 else 0.0,
                "min": min(scores),
                "max": max(scores),
            }

    return execution_results, results, grades_by_task, skipped_count


def _get_git_version(root: Path) -> str:
    """Get short git commit hash for benchmark version tracking."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            cwd=root,
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return ""


def _compute_efficiency(
    task_entries: List[Dict[str, Any]],
    grades_by_task_id: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Compute efficiency metrics: token usage, cost, and score-per-resource ratios."""
    total_input = total_output = total_tok = total_reqs = 0
    total_cost = total_time = 0.0
    per_task = []

    for entry in task_entries:
        usage = entry.get("usage", {})
        tid = entry["task_id"]
        score = float(grades_by_task_id.get(tid, {}).get("mean", 0.0))
        inp = int(usage.get("input_tokens", 0))
        out = int(usage.get("output_tokens", 0))
        tot = int(usage.get("total_tokens", 0))
        cost = float(usage.get("cost_usd", 0.0) or 0.0)
        reqs = int(usage.get("request_count", 0))
        exec_time = float(entry.get("execution_time", 0.0) or 0.0)

        total_input += inp
        total_output += out
        total_tok += tot
        total_cost += cost
        total_reqs += reqs
        total_time += exec_time
        per_task.append(
            {
                "task_id": tid,
                "score": round(score, 4),
                "total_tokens": tot,
                "cost_usd": round(cost, 6),
                "tokens_per_score_point": round(tot / score, 1) if score > 0 else None,
            }
        )

    all_scores = [float(g.get("mean", 0.0)) for g in grades_by_task_id.values()]
    total_score = sum(all_scores)
    n = len(all_scores)

    return {
        "total_tokens": total_tok,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cost_usd": round(total_cost, 6),
        "total_requests": total_reqs,
        "total_execution_time_seconds": round(total_time, 2),
        "tokens_per_task": round(total_tok / n, 1) if n else 0,
        "cost_per_task_usd": round(total_cost / n, 6) if n else 0,
        "score_per_1k_tokens": (
            round(total_score / (total_tok / 1000), 6) if total_tok > 0 else None
        ),
        "score_per_dollar": round(total_score / total_cost, 4) if total_cost > 0 else None,
        "per_task": per_task,
    }


def _write_anomaly_report(
    batch_dir: Path,
    execution_results: Dict[str, List[tuple]],
    model: str,
    thinking_level: Optional[str] = None,
) -> None:
    """Aggregate per-run anomaly data into a batch-level anomaly_report.json."""
    import datetime

    type_counts: Dict[str, int] = {}
    total_runs = 0
    anomalous_runs = 0
    error_runs = 0
    task_entries = []

    for task_id, runs in execution_results.items():
        task_anomalous = 0
        task_error = 0
        run_anomalies = []
        for run_idx, result, grade in sorted(runs, key=lambda x: x[0]):
            anomalies = result.get("_anomalies", {})
            items = anomalies.get("items", [])
            is_anom = anomalies.get("is_anomalous", False)
            # Compat: old grading.json files use "has_critical", new ones use "has_error"
            has_err = anomalies.get("has_error", anomalies.get("has_critical", False))
            total_runs += 1
            if is_anom:
                anomalous_runs += 1
                task_anomalous += 1
            if has_err:
                error_runs += 1
                task_error += 1
            for item in items:
                type_counts[item["id"]] = type_counts.get(item["id"], 0) + 1
            run_anomalies.append(
                {
                    "run_index": run_idx + 1,
                    "is_anomalous": is_anom,
                    "has_error": has_err,
                    "items": items,
                }
            )
        task_entries.append(
            {
                "task_id": task_id,
                "thinking_level": thinking_level,
                "total_runs": len(runs),
                "anomalous_runs": task_anomalous,
                "error_runs": task_error,
                "has_any_clean_run": task_anomalous < len(runs),
                "run_anomalies": run_anomalies,
            }
        )

    report = {
        "model": model,
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "total_runs": total_runs,
        "anomalous_runs": anomalous_runs,
        "error_runs": error_runs,
        "anomaly_type_counts": dict(sorted(type_counts.items(), key=lambda x: -x[1])),
        "tasks": sorted(task_entries, key=lambda t: (t["task_id"], t.get("thinking_level", ""))),
    }
    out = batch_dir / "anomaly_report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info(
        "📋 Anomaly report: %d/%d runs anomalous (%d error) → %s",
        anomalous_runs,
        total_runs,
        error_runs,
        out,
    )


def _subfolder_name(task_id: str, run_idx: int, runs_per_task: int) -> str:
    """Generate subfolder name for a task run: task_id[_run_N]."""
    parts = [task_id]
    if runs_per_task > 1:
        parts.append(f"run_{run_idx + 1}")
    return "_".join(parts)


def main():
    """Main entry point for the benchmark script."""

    logger.info("🦞🦀🦐 QwenClawBench - OpenClaw Benchmarking")

    args = _parse_args()
    code_dir = Path(__file__).parent.parent

    # Attach file handler now that we know the log path
    log_file = Path(args.log_file)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    logging.getLogger().addHandler(file_handler)

    if args.task:
        args.suite = args.task

    # Register cleanup handlers for abnormal exits (Ctrl+C, SIGTERM)
    import atexit
    import signal

    def _cleanup_on_exit(*_args):
        logger.info("🧹 Cleaning up Docker containers...")
        cleanup_containers()

    atexit.register(_cleanup_on_exit)
    signal.signal(signal.SIGINT, lambda *a: (cleanup_containers(), sys.exit(130)))
    signal.signal(signal.SIGTERM, lambda *a: (cleanup_containers(), sys.exit(143)))

    # Handle --cleanup: remove orphan containers and exit
    if args.cleanup:
        n = cleanup_containers()
        logger.info("Cleanup done. Removed %d container(s).", n)
        return

    if not args.model:
        logger.error("--model is required (unless using --cleanup)")
        sys.exit(2)

    # Resolve tasks directory and assets directories
    if args.dataset:
        tasks_dir = code_dir / "data" / args.dataset / "tasks"
        assets_dir = code_dir / "data" / args.dataset / "assets"
    else:
        tasks_dir = code_dir / "tasks"
        assets_dir = code_dir / "assets"
    if not tasks_dir.exists():
        logger.error("Tasks directory not found: %s", tasks_dir)
        sys.exit(1)
    if not assets_dir.exists():
        logger.warning("Assets directory not found: %s — continuing without assets", assets_dir)

    # Load tasks
    loader = TaskLoader(tasks_dir)
    all_tasks = loader.load_all_tasks()
    logger.info("Loaded %d tasks from %s", len(all_tasks), tasks_dir)

    task_ids = _select_task_ids(all_tasks, args.suite)
    tasks_to_run = all_tasks if task_ids is None else [t for t in all_tasks if t.task_id in task_ids]
    if not tasks_to_run:
        logger.error("No tasks matched suite '%s'", args.suite)
        sys.exit(1)

    tasks_by_id = {t.task_id: t for t in tasks_to_run}
    model_slug = slugify_model(args.model)
    runs_per_task = max(1, args.runs)
    concurrency = max(1, args.concurrency)

    # Pre-flight: fail fast if LLM judge credentials are missing
    if not args.no_grade:
        judge_tasks = [t for t in tasks_to_run if t.grading_type in ("llm_judge", "hybrid")]
        if judge_tasks:
            host_env = _load_openclaw_env()
            judge_base_url = os.environ.get("JUDGE_BASE_URL") or host_env.get("JUDGE_BASE_URL")
            judge_api_key = os.environ.get("JUDGE_API_KEY") or host_env.get("JUDGE_API_KEY")
            if not judge_base_url or not judge_api_key:
                logger.error(
                    "❌ %d task(s) require an LLM judge (%s) but JUDGE_BASE_URL / JUDGE_API_KEY "
                    "are not set. Add them to openclaw_config/.env or set as environment variables.",
                    len(judge_tasks),
                    ", ".join(t.task_id for t in judge_tasks[:3])
                    + (" ..." if len(judge_tasks) > 3 else ""),
                )
                sys.exit(1)

    thinking_level: Optional[str] = None
    if args.thinking:
        thinking_level = validate_thinking_level(args.thinking.strip(), args.model)
        if thinking_level is None:
            logger.error(
                "Invalid or incompatible thinking level '%s'. Valid levels: %s",
                args.thinking,
                ", ".join(THINKING_LEVELS),
            )
            sys.exit(2)
    
    logger.info(
        "🐳 Batch run: %d tasks × %d runs = %d total, concurrency=%d, image=%s",
        len(tasks_to_run),
        runs_per_task,
        len(tasks_to_run) * runs_per_task,
        concurrency,
        args.docker_image,
    )
    if args.thinking:
        logger.info("🧠 Thinking level: %s", thinking_level)

    # Build batch output directory before execution (for incremental writes)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Resume: find existing batch for this model unless --no-resume
    batch_dir = output_dir / (f"{model_slug}_{thinking_level}" if thinking_level else model_slug)
    resumable = not args.no_resume and batch_dir.is_dir()

    if resumable:
        logger.info("▶️  Resuming from %s", batch_dir)
        execution_results, results, grades_by_task, skipped = _load_existing_results(
            batch_dir,
            tasks_to_run,
            runs_per_task,
            thinking_level,
            args.rerun_anomalous,
            args.rerun_error,
            model_slug,
            simple_scoring=args.simple_scoring,
        )
        logger.info("   Skipping %d already-completed run(s)", skipped)
    else:
        batch_dir.mkdir(parents=True, exist_ok=True)
        execution_results = {t.task_id: [] for t in tasks_to_run}
        results = []
        grades_by_task = {}

    # Build work items: (task, run_index), skipping already-completed runs
    work_items = [
        (task, run_idx)
        for task in tasks_to_run
        for run_idx in range(runs_per_task)
        if run_idx not in {r[0] for r in execution_results.get(task.task_id, [])}
    ]
    if resumable and not work_items:
        logger.info("✅ All runs already complete — nothing to do.")

    # Concurrent Docker execution; grade each task immediately when it completes
    output_path = batch_dir / "summary.json"

    def _write_summary(elapsed: float) -> None:
        task_entries = [
            {
                "task_id": r["task_id"],
                "thinking_level": r.get("thinking_level"),
                "status": r["status"],
                "timed_out": r["timed_out"],
                "execution_time": r["execution_time"],
                "transcript_length": len(r["transcript"]),
                "usage": r.get("usage", {}),
                "workspace": r["workspace"],
                "grading": grades_by_task[r["task_id"]],
                "frontmatter": tasks_by_id[r["task_id"]].frontmatter,
            }
            for r in results
            if r["task_id"] in grades_by_task
        ]
        efficiency = _compute_efficiency(
            task_entries,
            {task_id: {"mean": g["mean"]} for task_id, g in grades_by_task.items()},
        )
        all_means = [g["mean"] for g in grades_by_task.values()]
        mean_score = statistics.mean(all_means) if all_means else 0.0
        pk = pass_k_stats(grades_by_task, runs_per_task)

        aggregate = {
            "model": args.model,
            "benchmark_version": _get_git_version(code_dir),
            "timestamp": time.time(),
            "suite": args.suite,
            "runs_per_task": runs_per_task,
            "thinking_level": thinking_level,
            "concurrency": concurrency,
            "batch_wall_clock_seconds": round(elapsed, 2),
            "tasks_total": len(tasks_to_run),
            "tasks_completed": len(grades_by_task),
            "scoring": "simple" if args.simple_scoring else "penalized",
            "mean_score": round(mean_score, 4),
            **pk,
            "tasks": task_entries,
            "efficiency": efficiency,
        }
        output_path.write_text(
            json.dumps(aggregate, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    def _run_one(item):
        task, run_idx = item
        return execute_task_in_docker(
            task=task,
            model_id=args.model,
            run_id=str(run_idx + 1),
            skill_dir=code_dir,
            timeout_multiplier=args.timeout_multiplier,
            image=args.docker_image,
            verbose=args.verbose,
            asset_dirs=[assets_dir],
            thinking_level=thinking_level,
        )

    batch_start = time.time()
    total_runs = len(tasks_to_run) * runs_per_task
    skipped_runs = total_runs - len(work_items)
    pbar = tqdm(
        total=total_runs,
        initial=skipped_runs,
        desc="evaluating",
        unit="run",
        dynamic_ncols=True,
    )

    def _process_grade(task, run_idx: int, result: dict, grade: GradeResult) -> None:
        """Handle post-grade processing: anomalies, state, file writes, progress."""
        anomalies = detect_anomalies(
            {**result, "transcript_length": len(result["transcript"])},
            grade.notes,
        )
        result["_anomalies"] = anomalies

        for anom_item in anomalies["items"]:
            msg = "   [anomaly] %s [%s] run %d — %s: %s"
            anom_args = (
                task.task_id,
                thinking_level or "default",
                run_idx + 1,
                anom_item["id"],
                anom_item["description"],
            )
            if anom_item["severity"] == "error":
                logger.error(msg, *anom_args)
            else:
                logger.warning(msg, *anom_args)

        execution_results[task.task_id].append((run_idx, result, grade))
        results.append(result)

        pct = grade.score / grade.max_score * 100 if grade.max_score > 0 else 0
        emoji = "❌" if anomalies["has_error"] else "⚠️" if anomalies["is_anomalous"] else "✅"
        anom_tag = (
            " [ANOMALY:error]" if anomalies["has_error"]
            else (" [ANOMALY]" if anomalies["is_anomalous"] else "")
        )
        logger.info(
            "🐳 %s %s (run %d/%d)%s — %s, %.1fs → %.2f/%.2f (%.0f%%) [%s]%s",
            emoji, task.task_id, run_idx + 1, runs_per_task,
            f" [{thinking_level}]" if args.thinking else "",
            result["status"], result["execution_time"],
            grade.score, grade.max_score, pct, grade.grading_type, anom_tag,
        )

        task_dir = batch_dir / _subfolder_name(task.task_id, run_idx, runs_per_task)
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "transcript.json").write_text(
            json.dumps(result["transcript"], indent=2, ensure_ascii=False), encoding="utf-8"
        )
        grading_data = {
            **grade.to_dict(),
            "thinking_level": thinking_level,
            "anomalies": anomalies,
            "execution": {
                "status": result["status"],
                "execution_time": result["execution_time"],
                "exit_code": result.get("exit_code"),
                "timed_out": result.get("timed_out", False),
                "transcript_length": len(result["transcript"]),
            },
        }
        (task_dir / "grading.json").write_text(
            json.dumps(grading_data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        ws_raw = (result.get("workspace") or "").strip()
        if ws_raw:
            ws_src = Path(ws_raw).resolve()
            ws_dst = (task_dir / "workspace").resolve()
            if not ws_src.is_dir():
                logger.warning("Skipping workspace copy for %s: not a directory: %s", task.task_id, ws_src)
            elif not ws_src.is_relative_to(_WORKSPACE_SNAPSHOT_ROOT):
                logger.warning(
                    "Skipping workspace copy for %s: outside snapshot root %s: %s",
                    task.task_id, _WORKSPACE_SNAPSHOT_ROOT, ws_src,
                )
            elif ws_dst == ws_src or ws_dst.is_relative_to(ws_src):
                logger.warning(
                    "Skipping workspace copy for %s: destination inside source tree (%s in %s)",
                    task.task_id, ws_dst, ws_src,
                )
            else:
                if ws_dst.exists():
                    shutil.rmtree(ws_dst)
                shutil.copytree(ws_src, ws_dst, symlinks=True)

        task_runs_done = sorted(execution_results[task.task_id], key=lambda x: x[0])
        if len(task_runs_done) == runs_per_task:
            task_grades = [g for _, _, g in task_runs_done]
            scores = [
                g.score_simple if g.score_simple is not None else g.score
                for g in task_grades
            ] if args.simple_scoring else [g.score for g in task_grades]
            grades_by_task[task.task_id] = {
                "task_id": task.task_id,
                "thinking_level": thinking_level,
                "runs": [g.to_dict() for g in task_grades],
                "mean": statistics.mean(scores),
                "std": statistics.stdev(scores) if len(scores) > 1 else 0.0,
                "min": min(scores),
                "max": max(scores),
            }
            _write_summary(elapsed=time.time() - batch_start)

            curr_means = [g["mean"] for g in grades_by_task.values()]
            curr_avg = statistics.mean(curr_means)
            logger.info(
                "   📈 avg: %.4f | progress %d/%d",
                curr_avg, len(grades_by_task), len(tasks_to_run),
            )
            pbar.set_postfix({"mean": f"{curr_avg:.3f}", "done": f"{len(grades_by_task)}/{len(tasks_to_run)}"})

        pbar.update(1)

    # exec_futures: future → (task, run_idx)
    # grade_futures: future → (task, run_idx, result)
    exec_futures: Dict[Future, tuple] = {}
    grade_futures: Dict[Future, tuple] = {}

    with logging_redirect_tqdm():
        with ThreadPoolExecutor(max_workers=concurrency) as exec_pool, \
             ThreadPoolExecutor(max_workers=concurrency) as grade_pool:

            for item in work_items:
                f = exec_pool.submit(_run_one, item)
                exec_futures[f] = item

            pending: set = set(exec_futures)

            while pending:
                done, pending = wait(pending, return_when=FIRST_COMPLETED)

                for f in done:
                    if f in exec_futures:
                        task, run_idx = exec_futures.pop(f)
                        try:
                            result = f.result()
                        except Exception as exc:
                            logger.warning(
                                "Execution failed for %s run %d: %s", task.task_id, run_idx + 1, exc
                            )
                            result = {
                                "agent_id": f"bench-{model_slug}",
                                "task_id": task.task_id,
                                "thinking_level": thinking_level,
                                "status": "error",
                                "transcript": [],
                                "usage": {},
                                "workspace": "",
                                "exit_code": -1,
                                "timed_out": False,
                                "execution_time": 0.0,
                                "stdout": "",
                                "stderr": str(exc),
                            }
                        result["thinking_level"] = thinking_level

                        if args.no_grade:
                            _process_grade(task, run_idx, result, GradeResult(
                                task_id=task.task_id,
                                score=0.0,
                                max_score=1.0,
                                grading_type=task.grading_type,
                                breakdown={},
                                notes="Grading skipped (--no-grade)",
                            ))
                        else:
                            gf = grade_pool.submit(
                                grade_task,
                                task=task,
                                execution_result=result,
                                skill_dir=code_dir,
                                verbose=args.verbose,
                            )
                            grade_futures[gf] = (task, run_idx, result)
                            pending.add(gf)

                    else:  # grade future
                        task, run_idx, result = grade_futures.pop(f)
                        try:
                            grade = f.result()
                        except Exception as exc:
                            logger.warning("Grading failed for %s: %s", task.task_id, exc)
                            grade = GradeResult(
                                task_id=task.task_id,
                                score=0.0,
                                max_score=1.0,
                                grading_type=task.grading_type,
                                breakdown={},
                                notes=f"Grading failed: {exc}",
                            )
                        _process_grade(task, run_idx, result, grade)

    pbar.close()
    batch_exec_time = time.time() - batch_start
    logger.info("⏱️  All executions finished in %.1fs (wall clock)", batch_exec_time)

    # Write final summary and anomaly report
    _write_summary(elapsed=batch_exec_time)
    logger.info("📄 Results saved to %s", batch_dir)
    _write_anomaly_report(batch_dir, execution_results, args.model, thinking_level)

    # Log summary statistics
    all_means = [g["mean"] for g in grades_by_task.values()]
    mean_score = statistics.mean(all_means) if all_means else 0.0

    logger.info("\n%s", "=" * 70)
    logger.info("📊 SUMMARY — %s", args.model)
    logger.info(
        "   Tasks: %d | Runs/task: %d | Concurrency: %d",
        len(tasks_to_run),
        runs_per_task,
        concurrency,
    )
    if args.thinking:
        logger.info("   Thinking level: %s", thinking_level)
    scoring_label = "simple avg" if args.simple_scoring else "penalized (auto≤0.75→llm=0)"
    logger.info(
        "   Mean score: %.4f [%s] | Wall clock: %.1fs",
        mean_score,
        scoring_label,
        batch_exec_time,
    )
    logger.info("%s", "=" * 70)


if __name__ == "__main__":
    main()
