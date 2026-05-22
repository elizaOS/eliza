#!/usr/bin/env python3
"""Run generated single-solver SymbiYosys smoke checks for E1 formal specs.

This isolates solver failures without editing the checked-in .sby specs or
weakening the strict multi-solver formal gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/formal_solver_isolation"
SCHEMA = "eliza.ai_eda.formal_solver_isolation.v1"
CLAIM_BOUNDARY = "single_solver_smoke_evidence_only_no_release_or_deep_proof_claim"
DEFAULT_BLOCKS = ("e1_dbg_mmio_bridge", "e1_npu", "e1_dma", "e1_soc_top")
DEFAULT_SOLVERS = ("z3", "bitwuzla")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path, required: bool = True) -> dict[str, Any]:
    return {
        "path": rel(path),
        "required": required,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def output_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def render_single_solver_spec(source: Path, solver: str) -> str:
    lines = source.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    in_engines = False
    replaced = False
    for line in lines:
        if line.strip() == "[engines]":
            output.append(line)
            output.append(f"smtbmc {solver}")
            in_engines = True
            replaced = True
            continue
        if in_engines and line.startswith("[") and line.endswith("]"):
            in_engines = False
        if in_engines:
            continue
        output.append(line)
    if not replaced:
        raise ValueError(f"{rel(source)}: missing [engines] section")
    return "\n".join(output) + "\n"


def run_case(block: str, solver: str, out_dir: Path, timeout: int) -> dict[str, Any]:
    source = ROOT / f"verify/formal/{block}.sby"
    spec_dir = out_dir / "specs"
    work_dir = out_dir / "work" / f"{block}_{solver}"
    spec_dir.mkdir(parents=True, exist_ok=True)
    work_dir.parent.mkdir(parents=True, exist_ok=True)
    generated_spec = spec_dir / f"{block}_{solver}.sby"
    if not source.is_file():
        return {
            "block": block,
            "solver": solver,
            "status": "MISSING_SPEC",
            "returncode": None,
            "blockers": [f"{rel(source)} is missing"],
            "artifacts": {"source_spec": artifact(source)},
        }
    generated_spec.write_text(render_single_solver_spec(source, solver), encoding="utf-8")
    if work_dir.exists():
        shutil.rmtree(work_dir)
    command = ["sby", "--prefix", str(work_dir), "-f", str(generated_spec)]
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        timed_out = False
    except subprocess.TimeoutExpired as exc:
        completed = subprocess.CompletedProcess(
            command,
            124,
            stdout=output_text(exc.stdout),
            stderr=output_text(exc.stderr),
        )
        timed_out = True
    stdout_text = output_text(completed.stdout)
    stderr_text = output_text(completed.stderr)
    stdout_path = out_dir / "logs" / f"{block}_{solver}.stdout.log"
    stderr_path = out_dir / "logs" / f"{block}_{solver}.stderr.log"
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_path.write_text(stdout_text, encoding="utf-8")
    stderr_path.write_text(stderr_text, encoding="utf-8")
    status_path = work_dir / "status"
    logfile_path = work_dir / "logfile.txt"
    status_text = (
        status_path.read_text(encoding="utf-8", errors="ignore").strip()
        if status_path.is_file()
        else ""
    )
    log_text = (
        logfile_path.read_text(encoding="utf-8", errors="ignore") if logfile_path.is_file() else ""
    )
    combined = "\n".join([status_text, log_text, stdout_text, stderr_text])
    markers = sorted(
        {
            marker
            for marker in (
                "PASS",
                "FAIL",
                "ERROR",
                "Traceback",
                "BrokenPipeError",
                "Engine terminated without status",
            )
            if marker in combined
        }
    )
    if timed_out:
        status = "TIMEOUT"
    elif completed.returncode == 0 and "PASS" in markers:
        status = "PASS"
    elif "ERROR" in markers or "Traceback" in markers or completed.returncode not in (0, None):
        status = "ERROR"
    elif "FAIL" in markers:
        status = "FAIL"
    else:
        status = "UNKNOWN"
    blockers = (
        [] if status == "PASS" else [f"{block}/{solver}: single-solver smoke status is {status}"]
    )
    return {
        "block": block,
        "solver": solver,
        "status": status,
        "returncode": completed.returncode,
        "timeout_seconds": timeout,
        "timed_out": timed_out,
        "markers": markers,
        "command": " ".join(command),
        "blockers": blockers,
        "artifacts": {
            "source_spec": artifact(source),
            "generated_spec": artifact(generated_spec),
            "work_status": artifact(status_path, required=False),
            "work_log": artifact(logfile_path, required=False),
            "stdout": artifact(stdout_path),
            "stderr": artifact(stderr_path),
        },
    }


def parse_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--blocks", default=",".join(DEFAULT_BLOCKS))
    parser.add_argument("--solvers", default=",".join(DEFAULT_SOLVERS))
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    blockers: list[str] = []
    if shutil.which("sby") is None:
        blockers.append("sby is not available on PATH")
        cases: list[dict[str, Any]] = []
    else:
        cases = [
            run_case(block, solver, out_dir, args.timeout_seconds)
            for block in parse_csv(args.blocks)
            for solver in parse_csv(args.solvers)
        ]
        for case in cases:
            blockers.extend(case.get("blockers", []))
    passed = sum(1 for case in cases if case.get("status") == "PASS")
    errored = sum(1 for case in cases if case.get("status") == "ERROR")
    failed = sum(1 for case in cases if case.get("status") == "FAIL")
    timed_out = sum(1 for case in cases if case.get("status") == "TIMEOUT")
    status = (
        "SOLVER_ISOLATION_PASS"
        if cases and not blockers
        else "SOLVER_ISOLATION_RECORDED_WITH_BLOCKERS"
    )
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "formal_proof_claim_allowed": False,
        "status": status,
        "summary": {
            "case_count": len(cases),
            "passed": passed,
            "errored": errored,
            "failed": failed,
            "timed_out": timed_out,
        },
        "cases": cases,
        "blockers": blockers,
        "next_required_gates": [
            "resolve failing single-solver cases before trusting the strict multi-solver formal gate",
            "rerun scripts/run_formal.sh or make PYTHON=python3 formal-strict after solver/toolchain fixes",
            "do not use single-solver smoke evidence as a release proof",
        ],
    }
    path = out_dir / "formal_solver_isolation.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.formal_solver_isolation "
        f"status={status} cases={len(cases)} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
