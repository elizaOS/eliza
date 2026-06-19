#!/usr/bin/env python3
"""Summarize scores across all models under a traces root directory.

For each model, picks the latest-dated trace folder, extracts grading_result
from each JSONL, and computes per-task and aggregate statistics.
"""

import json
import re
import sys
import yaml
from collections import defaultdict
from pathlib import Path


PASS_THRESHOLD = 0.75
EXPECTED_TRIALS = 3


def _task_num(task_id: str) -> int | None:
    """Extract the leading number from a task ID like 'T105_clock' -> 105."""
    m = re.match(r"T(\d+)", task_id)
    return int(m.group(1)) if m else None


def _extract_scores(jsonl_path: Path) -> dict | None:
    """Extract task_id and task_score from the last grading_result in a JSONL file.

    Returns {"task_id": ..., "task_score": ..., "scores": {...}} or None if no grading_result.
    """
    result = None
    try:
        for line in open(jsonl_path):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "grading_result":
                result = {
                    "task_id": ev.get("task_id", ""),
                    "task_score": ev.get("task_score", 0.0),
                    "passed": ev.get("passed", False),
                    "scores": ev.get("scores", {}),
                }
    except Exception:
        pass
    return result


def _is_trace_dir(d: Path) -> bool:
    """Check if a directory contains JSONL trace files (i.e. is a real trace dir)."""
    return any(d.glob("*.jsonl"))


def _find_model_dirs(root: Path) -> dict[str, Path]:
    """Find the latest trace folder per model.

    Supports two directory layouts:
      - 2-level: root / <model_name> / <dated_folder>/
      - 3-level: root / <group> / <model_name> / <dated_folder>/
    A dated_folder is identified by containing *.jsonl files.
    We pick the latest one per model (using the top-level dir name as label).
    """
    models = {}

    # 1-level: root itself is a trace dir (root / *.jsonl)
    if _is_trace_dir(root):
        models[root.name] = root
        return models

    for top_dir in sorted(root.iterdir()):
        if not top_dir.is_dir():
            continue

        # 1-level: root / dated_folder (where dated_folder has *.jsonl)
        if _is_trace_dir(top_dir):
            # root is a model dir; top_dir is the dated trace folder
            models[top_dir.name] = top_dir
            continue

        # 2-level: root / model_name / dated_folder
        dated_dirs = sorted(
            (d for d in top_dir.iterdir() if d.is_dir() and _is_trace_dir(d)),
            key=lambda d: d.name,
        )
        if dated_dirs:
            models[top_dir.name] = dated_dirs[-1]
            continue

        # 3-level: root / group / model_name / dated_folder
        for model_dir in sorted(top_dir.iterdir()):
            if not model_dir.is_dir():
                continue
            dated_dirs = sorted(
                (d for d in model_dir.iterdir() if d.is_dir() and _is_trace_dir(d)),
                key=lambda d: d.name,
            )
            if dated_dirs:
                model_label = model_dir.name
                if model_label not in models:
                    models[model_label] = dated_dirs[-1]

    return models


def _extract_err_reason(jsonl_path: Path) -> str:
    """Extract a short error reason from a trace that has no grading_result."""
    reason = "no grading_result"
    try:
        for line in open(jsonl_path):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "trace_end":
                fm = ev.get("failure_modes", [])
                if fm:
                    reason = fm[0][:80]
    except Exception:
        pass
    return reason


def _extract_full_trial(jsonl_path: Path) -> tuple[str, dict] | None:
    """Extract task_id and full trial info from a JSONL file.

    Returns (task_id, trial_dict) or None if no grading_result.
    """
    grading = None
    trace_end = None
    try:
        for line in open(jsonl_path):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "grading_result":
                grading = ev
            elif ev.get("type") == "trace_end":
                trace_end = ev
    except Exception:
        return None
    if grading is None or not grading.get("task_id"):
        return None
    scores = grading.get("scores", {})
    te = trace_end or {}
    return grading["task_id"], {
        "trace": str(jsonl_path),
        "model_input_tokens": te.get("model_input_tokens", 0),
        "model_output_tokens": te.get("model_output_tokens", 0),
        "input_tokens": te.get("model_input_tokens", 0),
        "output_tokens": te.get("model_output_tokens", 0),
        "tokens": te.get("total_tokens", 0),
        "model_time_s": te.get("model_time_s", 0.0),
        "tool_time_s": te.get("tool_time_s", 0.0),
        "other_time_s": te.get("other_time_s", 0.0),
        "wall_time_s": te.get("wall_time_s", 0.0),
        "completion": scores.get("completion", 0.0),
        "robustness": scores.get("robustness", 0.0),
        "communication": scores.get("communication", 0.0),
        "safety": scores.get("safety", 1.0),
        "task_score": grading.get("task_score", 0.0),
        "passed": grading.get("passed", False),
    }


def analyze_model(model_name: str, trace_dir: Path, task_filter=None) -> dict:
    """Analyze all traces in a model's trace directory."""
    task_scores: dict[str, list[float]] = defaultdict(list)
    task_trials: dict[str, list[dict]] = defaultdict(list)
    task_errors: dict[str, list[tuple[str, str]]] = defaultdict(list)
    total_files = 0
    graded_files = 0

    for f in sorted(trace_dir.glob("*.jsonl")):
        total_files += 1
        extracted = _extract_full_trial(f)
        if extracted:
            graded_files += 1
            tid, trial = extracted
            task_scores[tid].append(trial["task_score"])
            task_trials[tid].append(trial)
        else:
            m = re.match(r"(.+)_[0-9a-f]{8}\.jsonl$", f.name)
            if m:
                task_id = m.group(1)
                reason = _extract_err_reason(f)
                task_errors[task_id].append((f.name, reason))

    # Per-task metrics — pad missing trials with 0 so every task has EXPECTED_TRIALS scores
    all_task_ids = sorted(set(task_scores.keys()) | set(task_errors.keys()))
    if task_filter:
        all_task_ids = [tid for tid in all_task_ids if task_filter(tid)]
    task_results = {}
    for tid in all_task_ids:
        raw_scores = task_scores.get(tid, [])
        n_graded = len(raw_scores)
        # Pad with 0.0 for missing/errored trials up to EXPECTED_TRIALS
        scores = raw_scores + [0.0] * max(0, EXPECTED_TRIALS - n_graded)
        avg = sum(scores) / EXPECTED_TRIALS
        avg_pass = avg >= PASS_THRESHOLD
        any_pass = any(s >= PASS_THRESHOLD for s in scores)
        all_pass = all(s >= PASS_THRESHOLD for s in scores)
        task_results[tid] = {
            "scores": scores,
            "n_graded": n_graded,
            "n_errors": len(task_errors.get(tid, [])),
            "errors": task_errors.get(tid, []),
            "avg_score": avg,
            "avg_pass": avg_pass,
            "any_pass": any_pass,
            "all_pass": all_pass,
        }

    # Aggregate
    n_tasks = len(task_results)
    n_avg_pass = sum(1 for t in task_results.values() if t["avg_pass"])
    n_any_pass = sum(1 for t in task_results.values() if t["any_pass"])
    n_all_pass = sum(1 for t in task_results.values() if t["all_pass"])
    overall_avg = (
        sum(t["avg_score"] for t in task_results.values()) / n_tasks
        if n_tasks else 0.0
    )

    return {
        "model": model_name,
        "trace_dir": str(trace_dir),
        "total_files": total_files,
        "graded_files": graded_files,
        "n_tasks": n_tasks,
        "overall_avg_score": overall_avg,
        "n_avg_pass": n_avg_pass,
        "n_any_pass": n_any_pass,
        "n_all_pass": n_all_pass,
        "avg_pass_rate": n_avg_pass / n_tasks if n_tasks else 0.0,
        "any_pass_rate": n_any_pass / n_tasks if n_tasks else 0.0,
        "all_pass_rate": n_all_pass / n_tasks if n_tasks else 0.0,
        "tasks": task_results,
        "task_trials": dict(task_trials),
    }


def _build_config_map(traces_root: Path) -> dict[str, str]:
    """Build mapping from trace_dir (resolved absolute path) -> config file path.

    Finds the configs directory by replacing the first 'traces' path component
    with 'configs' in the resolved traces_root path, then walking up until an
    existing directory is found.
    """
    resolved = traces_root.resolve()
    parts = list(resolved.parts)
    # Replace first path component containing 'traces' with 'configs' equivalent
    configs_root = None
    for i, part in enumerate(parts):
        if "traces" in part:
            parts[i] = part.replace("traces", "configs")
            candidate = Path(*parts[:i + 1])
            if candidate.exists():
                configs_root = candidate
                break
    if configs_root is None or not configs_root.exists():
        return {}
    mapping: dict[str, str] = {}
    for cfg_path in sorted(configs_root.rglob("*.yaml")):
        try:
            with open(cfg_path) as f:
                data = yaml.safe_load(f)
            trace_dir = (data.get("defaults") or {}).get("trace_dir", "")
            if trace_dir:
                mapping[str(Path(trace_dir).resolve())] = str(cfg_path)
        except Exception:
            pass
    return mapping


def _rebuild_batch_files(r: dict) -> None:
    """Rebuild batch_results.json and batch_summary.json from analyzed data."""
    trace_dir = Path(r["trace_dir"])
    task_trials = r["task_trials"]

    results = []
    for tid in sorted(task_trials):
        trials = task_trials[tid]
        trial_scores = [t["task_score"] for t in trials]
        n = len(trial_scores)
        entry = {
            "task_id": tid,
            "task_name": "",
            "difficulty": "",
            "trials": trials,
            "error": None,
        }
        if n > 0:
            entry["avg_score"] = sum(trial_scores) / n
            entry["avg_passed"] = (sum(trial_scores) / n) >= PASS_THRESHOLD
        else:
            entry["avg_score"] = 0.0
            entry["avg_passed"] = False
        results.append(entry)

    results_file = trace_dir / "batch_results.json"
    with open(results_file, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    n_tasks = len(results)
    passed = sum(1 for e in results if e.get("avg_passed", False))
    failed = n_tasks - passed
    avg_scores = [e["avg_score"] for e in results]
    summary = {
        "tasks": n_tasks,
        "passed": passed,
        "failed": failed,
        "errored": 0,
        "avg_score": (sum(avg_scores) / len(avg_scores)) if avg_scores else 0.0,
        "total_model_input_tokens": sum(t.get("model_input_tokens", 0) for e in results for t in e["trials"]),
        "total_model_output_tokens": sum(t.get("model_output_tokens", 0) for e in results for t in e["trials"]),
        "total_input_tokens": sum(t.get("input_tokens", 0) for e in results for t in e["trials"]),
        "total_output_tokens": sum(t.get("output_tokens", 0) for e in results for t in e["trials"]),
        "total_tokens": sum(t.get("tokens", 0) for e in results for t in e["trials"]),
        "total_model_time_s": round(sum(t.get("model_time_s", 0.0) for e in results for t in e["trials"]), 2),
        "total_tool_time_s": round(sum(t.get("tool_time_s", 0.0) for e in results for t in e["trials"]), 2),
        "total_other_time_s": round(sum(t.get("other_time_s", 0.0) for e in results for t in e["trials"]), 2),
        "total_wall_time_s": round(sum(t.get("wall_time_s", 0.0) for e in results for t in e["trials"]), 2),
    }
    summary_file = trace_dir / "batch_summary.json"
    with open(summary_file, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print(f"  [fix] {r['model']}: wrote {results_file} ({n_tasks} tasks, {passed} passed) + {summary_file}")


def main():
    fix_mode = "--fix" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--fix"]

    # Parse --range L-R (filter tasks by numeric ID)
    task_filter = None
    range_label = ""
    filtered_args = []
    i = 0
    while i < len(args):
        if args[i] == "--range" and i + 1 < len(args):
            range_str = args[i + 1]
            m = re.match(r"(\d+)-(\d+)$", range_str)
            if not m:
                print(f"Invalid range format: {range_str}  (expected L-R, e.g. 1-104)")
                sys.exit(1)
            lo, hi = int(m.group(1)), int(m.group(2))
            task_filter = lambda tid, lo=lo, hi=hi: (n := _task_num(tid)) is not None and lo <= n <= hi
            range_label = f" [range T{lo}-T{hi}]"
            i += 2
        else:
            filtered_args.append(args[i])
            i += 1
    args = filtered_args

    root = Path(args[0]) if args else Path("0314_traces")
    if not root.exists():
        print(f"Directory not found: {root}")
        sys.exit(1)

    models = _find_model_dirs(root)
    config_map = _build_config_map(root)
    print(f"Found {len(models)} models under {root}{range_label}\n")

    all_results = []
    for model_name, trace_dir in sorted(models.items()):
        result = analyze_model(model_name, trace_dir, task_filter=task_filter)
        all_results.append(result)

    # ── Leaderboard ──
    all_results.sort(key=lambda r: r["overall_avg_score"], reverse=True)

    print(f"{'Model':<30s} {'Tasks':>5s} {'AvgScore':>8s} │ {'AvgPass':>8s} {'AnyPass':>8s} {'AllPass':>8s}")
    print("─" * 85)
    for r in all_results:
        print(
            f"{r['model']:<30s} {r['n_tasks']:>5d} {r['overall_avg_score']:>8.3f} │ "
            f"{r['n_avg_pass']:>3d}/{r['n_tasks']:<3d} "
            f"{r['n_any_pass']:>3d}/{r['n_tasks']:<3d} "
            f"{r['n_all_pass']:>3d}/{r['n_tasks']:<3d}"
        )

    # ── Anomaly report ──
    has_anomaly = False
    port_offset = 0
    for r in all_results:
        anomalies = [
            (tid, t) for tid, t in sorted(r["tasks"].items())
            if t["n_graded"] != EXPECTED_TRIALS or t["n_errors"] > 0
        ]
        if anomalies:
            if not has_anomaly:
                print(f"\n{'='*85}")
                print(f"Anomalous tasks (graded!={EXPECTED_TRIALS} or has ERR traces):")
                has_anomaly = True
            trace_dir = r["trace_dir"]
            print(f"\n  {r['model']}  ({trace_dir})")
            for tid, t in anomalies:
                scores_str = "/".join(f"{s:.2f}" for s in t["scores"]) if t["scores"] else "-"
                parts = [f"{t['n_graded']} graded"]
                if t["n_errors"] > 0:
                    parts.append(f"{t['n_errors']} ERR")
                print(f"    {tid:<45s} {', '.join(parts):<20s} [{scores_str}]")
                for fname, reason in t["errors"]:
                    print(f"      ERR: {fname}  ({reason})")
            trace_dir_path = Path(trace_dir)
            parent_abs = str(trace_dir_path.parent.resolve())
            cfg = config_map.get(parent_abs, "")
            if cfg:
                print(f"\n    # cleanup + re-run:")
                print(f"    python cleanup_traces.py {trace_dir}")
                print(f"    agent-eval batch --sandbox --trials {EXPECTED_TRIALS} --config {cfg} --parallel 10 --continue {trace_dir} --port-base-offset {port_offset}")
                port_offset += 400
            else:
                print(f"\n    # cleanup:")
                print(f"    python cleanup_traces.py {trace_dir}")
                print(f"    # config not found — re-run manually")
    if not has_anomaly:
        print(f"\nAll tasks: exactly {EXPECTED_TRIALS} graded, 0 errors.")

    # ── Rebuild batch files if --fix ──
    if fix_mode:
        print(f"\n{'='*85}")
        print("Rebuilding batch_results.json + batch_summary.json from JSONL traces:")
        for r in all_results:
            _rebuild_batch_files(r)

    # ── Save JSON ──
    out_file = root / "score_summary.json"
    json_results = []
    for r in all_results:
        jr = dict(r)
        jr["tasks"] = {}
        for tid, t in r["tasks"].items():
            td = dict(t)
            td["errors"] = [{"file": f, "reason": r} for f, r in t["errors"]]
            jr["tasks"][tid] = td
        json_results.append(jr)
    with open(out_file, "w") as f:
        json.dump(json_results, f, indent=2, ensure_ascii=False)
    print(f"\n\nJSON saved to {out_file}")


if __name__ == "__main__":
    main()
