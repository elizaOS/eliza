#!/usr/bin/env python3
"""Run local Yosys/ABC recipe baselines over small E1 RTL modules."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = ROOT / "build/ai_eda/logic_synthesis_recipes/validation/recipe_corpus.json"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/logic_synthesis_baselines"
CLAIM_BOUNDARY = "logic_synthesis_baseline_only_no_ppa_equivalence_or_release_claim"


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def yosys_version(yosys_bin: str) -> str:
    completed = subprocess.run([yosys_bin, "-V"], capture_output=True, text=True, check=True)
    return completed.stdout.strip() or completed.stderr.strip()


def parse_stat(log_text: str, top: str) -> dict[str, Any]:
    module_header = f"=== {top} ==="
    start = log_text.rfind(module_header)
    section = log_text[start:] if start >= 0 else log_text
    metrics: dict[str, Any] = {}
    for key, pattern in {
        "wire_count": r"^\s*(\d+)\s+wires$",
        "wire_bits": r"^\s*(\d+)\s+wire bits$",
        "cell_count": r"^\s*(\d+)\s+cells$",
    }.items():
        match = re.search(pattern, section, flags=re.MULTILINE)
        if match:
            metrics[key] = int(match.group(1))
    cell_histogram: dict[str, int] = {}
    for count, cell_type in re.findall(
        r"^\s*(\d+)\s+(\$[A-Za-z0-9_]+)\s*$", section, flags=re.MULTILINE
    ):
        cell_histogram[cell_type] = int(count)
    if cell_histogram:
        metrics["cell_histogram"] = cell_histogram
    return metrics


def run_recipe(
    yosys_bin: str,
    target: dict[str, Any],
    recipe: dict[str, Any],
    out_dir: Path,
    timeout_s: int,
) -> dict[str, Any]:
    recipe_id = str(recipe["id"])
    target_id = str(target["id"])
    result_id = f"{target_id}--{recipe_id}"
    log_path = out_dir / f"{result_id}.yosys.log"
    script_path = out_dir / f"{result_id}.ys"

    if recipe.get("requires_external_assets"):
        return {
            "id": result_id,
            "target": target_id,
            "recipe": recipe_id,
            "status": "BLOCKED_EXTERNAL_ASSET_NOT_FETCHED",
            "blockers": recipe.get("blocked_until", []),
            "claim_boundary": CLAIM_BOUNDARY,
        }

    rtl_reads = [f"read_verilog -sv {path}" for path in target["rtl"]]
    lines = [
        *rtl_reads,
        f"hierarchy -top {target['top']}",
        *recipe["passes"],
    ]
    script_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    process = subprocess.Popen(
        [yosys_bin, "-l", str(log_path), str(script_path)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        _stdout, stderr = process.communicate(timeout=timeout_s)
        returncode = process.returncode
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            _stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            _stdout, stderr = process.communicate()
        log_text = (
            log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        )
        return {
            "id": result_id,
            "target": target_id,
            "recipe": recipe_id,
            "status": "BLOCKED_RECIPE_TIMEOUT",
            "timeout_s": timeout_s,
            "script": str(script_path.relative_to(ROOT)),
            "log": str(log_path.relative_to(ROOT)),
            "metrics": parse_stat(log_text, str(target["top"])),
            "stderr_tail": stderr[-2000:],
            "claim_boundary": CLAIM_BOUNDARY,
        }
    log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    status = "PASS_YOSYS_RECIPE_SMOKE" if returncode == 0 else "FAIL_YOSYS_RECIPE"
    return {
        "id": result_id,
        "target": target_id,
        "recipe": recipe_id,
        "status": status,
        "returncode": returncode,
        "script": str(script_path.relative_to(ROOT)),
        "log": str(log_path.relative_to(ROOT)),
        "metrics": parse_stat(log_text, str(target["top"])),
        "stderr_tail": stderr[-2000:],
        "claim_boundary": CLAIM_BOUNDARY,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--timeout-s", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    yosys_bin = shutil.which("yosys")
    corpus = load_json(args.corpus)

    if yosys_bin is None:
        report = {
            "schema": "eliza.ai_eda.logic_synthesis_policy_baseline.v1",
            "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "run_id": args.run_id,
            "claim_boundary": CLAIM_BOUNDARY,
            "status": "BLOCKED_YOSYS_NOT_FOUND",
            "results": [],
            "release_use_allowed": False,
        }
        report_path = out_dir / "baseline_report.json"
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        print(f"STATUS: BLOCKED ai_eda.logic_synthesis_policy_baseline {report_path}")
        return 0

    results = [
        run_recipe(yosys_bin, target, recipe, out_dir, args.timeout_s)
        for target in corpus["target_modules"]
        for recipe in corpus["recipes"]
    ]
    failed = [item for item in results if str(item["status"]).startswith("FAIL")]
    passed = [item for item in results if str(item["status"]).startswith("PASS")]
    blocked = [item for item in results if str(item["status"]).startswith("BLOCKED")]
    report = {
        "schema": "eliza.ai_eda.logic_synthesis_policy_baseline.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "PASS_WITH_BLOCKED_OPENABC_D" if not failed else "FAIL",
        "yosys": {"path": yosys_bin, "version": yosys_version(yosys_bin)},
        "corpus": str(args.corpus.relative_to(ROOT)),
        "summary": {
            "passed": len(passed),
            "blocked": len(blocked),
            "failed": len(failed),
        },
        "results": results,
        "release_use_allowed": False,
    }
    report_path = out_dir / "baseline_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if failed:
        print(f"STATUS: FAIL ai_eda.logic_synthesis_policy_baseline {report_path}")
        return 1
    print(f"STATUS: PASS ai_eda.logic_synthesis_policy_baseline {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
