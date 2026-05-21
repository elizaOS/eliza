#!/usr/bin/env python3
"""Bootstrap the E1 AI-EDA stack on a fresh machine.

The default profile is metadata-only and does not download external payloads.
Use --profile setup-check after restoring or fetching reviewed payloads, use
--profile local-smoke for the broader CPU/MPS-safe validation stack, and use
--execute-fetch with an explicit --asset allowlist when intentionally pulling
reviewed external assets into ignored payload directories.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT_ROOT = ROOT / "build/ai_eda/bootstrap"
CLAIM_BOUNDARY = "ai_eda_bootstrap_orchestration_no_release_claim"

METADATA_TARGETS = (
    "ai-eda-backend-preflight",
    "ai-eda-all-target-captures",
    "ai-eda-local-rag-index",
    "ai-eda-source-inventory-check",
    "ai-eda-ai-workload-manifest-check",
    "ai-eda-assertion-candidate-manifests-check",
    "ai-eda-external-assets-check",
    "ai-eda-external-intake-check",
    "ai-eda-alphachip-checkpoint-blocker-check",
    "ai-eda-internal-schemas-check",
    "ai-eda-external-assets-dry-run",
)

LOCAL_SMOKE_TARGETS = (
    "ai-eda-internal-fixtures",
    "ai-eda-openroad-eda-corpus-convert",
    "ai-eda-tilos-macroplacement-convert",
    "ai-eda-circuitnet3-convert",
    "ai-eda-chipbench-d-convert",
    "ai-eda-aieda-idata-convert",
    "ai-eda-edalearn-convert",
    "ai-eda-macro-place-challenge-convert",
    "ai-eda-mlcad-fpga-macro-convert",
    "ai-eda-research-code-assets-convert",
    "ai-eda-openabc-d-convert",
    "ai-eda-e1-softmacro-cases",
    "ai-eda-external-fixture-convert",
    "ai-eda-e1-openlane-convert",
    "ai-eda-openlane-flow-labels",
    "ai-eda-pd-surrogate-smoke",
    "ai-eda-fixture-placement-train",
    "ai-eda-macro-placement-supervised-dataset",
    "ai-eda-macro-placement-supervised-train",
    "ai-eda-macro-placement-baseline",
    "ai-eda-macro-placement-combined-candidate-eval",
    "ai-eda-macro-placement-replay-preflight",
    "ai-eda-macro-placement-combined-replay-plan",
    "ai-eda-logic-synthesis-baseline",
    "ai-eda-tool-actions-check",
    "ai-eda-cocotb-stimulus-dry-run",
)

SETUP_CHECK_TARGETS = (
    "ai-eda-internal-fixtures",
    "ai-eda-openroad-eda-corpus-convert",
    "ai-eda-tilos-macroplacement-convert",
    "ai-eda-circuitnet3-convert",
    "ai-eda-chipbench-d-convert",
    "ai-eda-aieda-idata-convert",
    "ai-eda-edalearn-convert",
    "ai-eda-macro-place-challenge-convert",
    "ai-eda-mlcad-fpga-macro-convert",
    "ai-eda-research-code-assets-convert",
    "ai-eda-circuitnet3-surrogate",
    "ai-eda-openabc-d-convert",
    "ai-eda-e1-softmacro-cases",
    "ai-eda-external-fixture-convert",
    "ai-eda-e1-openlane-convert",
    "ai-eda-openlane-flow-labels",
    "ai-eda-macro-placement-supervised-dataset",
)

TORCH_TARGETS = (
    "ai-eda-macro-placement-torch-train",
    "ai-eda-macro-placement-torch-infer",
    "ai-eda-macro-placement-full-candidate-eval",
    "ai-eda-macro-placement-full-replay-plan",
)

HANDOFF_TARGETS = (
    "ai-eda-cuda-preflight",
    "ai-eda-cuda-payload",
)


def run(command: list[str], timeout_seconds: int) -> dict[str, Any]:
    started = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        return {
            "command": command,
            "started_at_utc": started,
            "finished_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "returncode": result.returncode,
            "stdout_tail": result.stdout[-8000:],
            "stderr_tail": result.stderr[-8000:],
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "command": command,
            "started_at_utc": started,
            "finished_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "returncode": 124,
            "stdout_tail": (exc.stdout or "")[-8000:] if isinstance(exc.stdout, str) else "",
            "stderr_tail": (exc.stderr or "")[-8000:] if isinstance(exc.stderr, str) else "",
            "error": f"timeout after {timeout_seconds}s",
        }


def make_target(target: str, timeout_seconds: int, run_id: str) -> dict[str, Any]:
    return run(["make", f"PYTHON={sys.executable}", f"AI_EDA_RUN_ID={run_id}", target], timeout_seconds)


def print_step_status(kind: str, item: dict[str, Any], target: str | None = None) -> None:
    label = f" target={target}" if target else ""
    print(
        "STATUS: STEP ai_eda.bootstrap "
        f"kind={kind}{label} returncode={item['returncode']}",
        flush=True,
    )


def build_report(
    args: argparse.Namespace,
    steps: list[dict[str, Any]],
    overall_rc: int,
    status: str,
) -> dict[str, Any]:
    return {
        "schema": "eliza.ai_eda.bootstrap_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "profile": args.profile,
        "status": status,
        "complete": status in {"PASS", "FAIL"},
        "claim_boundary": CLAIM_BOUNDARY,
        "policy": {
            "release_use_allowed": False,
            "execute_fetch_requires_explicit_asset": True,
            "external_payloads_remain_ignored": True,
        },
        "python_executable": sys.executable,
        "assets": args.asset,
        "execute_fetch": bool(args.execute_fetch),
        "include_torch": bool(args.include_torch),
        "step_count": len(steps),
        "failed_steps": [
            {
                "kind": step["kind"],
                "target": step.get("target"),
                "command": step["command"],
                "returncode": step["returncode"],
            }
            for step in steps
            if step["returncode"] != 0
        ],
        "steps": steps,
        "overall_returncode": overall_rc,
    }


def write_report(
    args: argparse.Namespace,
    out_dir: Path,
    steps: list[dict[str, Any]],
    overall_rc: int,
    status: str,
) -> Path:
    report_path = out_dir / "bootstrap_report.json"
    report_path.write_text(
        json.dumps(build_report(args, steps, overall_rc, status), indent=2, sort_keys=True) + "\n"
    )
    return report_path


def selected_targets(profile: str, include_torch: bool) -> list[str]:
    targets = list(METADATA_TARGETS)
    if profile in {"setup-check", "local-smoke", "training-handoff"}:
        targets.extend(SETUP_CHECK_TARGETS)
    if profile in {"local-smoke", "training-handoff"}:
        targets.extend(LOCAL_SMOKE_TARGETS)
    if include_torch or profile == "training-handoff":
        targets.extend(TORCH_TARGETS)
    if profile == "training-handoff":
        targets.extend(HANDOFF_TARGETS)
    deduped: list[str] = []
    seen: set[str] = set()
    for target in targets:
        if target in seen:
            continue
        seen.add(target)
        deduped.append(target)
    return deduped


def fetch_commands(args: argparse.Namespace) -> list[list[str]]:
    commands: list[list[str]] = []
    if not args.asset:
        return commands
    mode = "--execute" if args.execute_fetch else "--verify-only"
    for asset in args.asset:
        commands.append(
            [
                sys.executable,
                "scripts/ai_eda/fetch_external_asset.py",
                "--asset",
                asset,
                mode,
                "--run-id",
                args.run_id,
            ]
        )
    return commands


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--report-root", type=Path, default=DEFAULT_REPORT_ROOT)
    parser.add_argument(
        "--profile",
        choices=("metadata", "setup-check", "local-smoke", "training-handoff"),
        default="metadata",
    )
    parser.add_argument(
        "--asset",
        action="append",
        default=[],
        help="external asset id to verify or fetch before running make targets",
    )
    parser.add_argument(
        "--execute-fetch",
        action="store_true",
        help="fetch explicit --asset values into ignored payload directories",
    )
    parser.add_argument("--include-torch", action="store_true")
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=24 * 3600)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.report_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    steps: list[dict[str, Any]] = []
    overall_rc = 0

    preflight = run(
        [sys.executable, "scripts/ai_eda/preflight_cuda_training_stack.py", "--run-id", args.run_id],
        args.timeout_seconds,
    )
    steps.append({"kind": "preflight", **preflight})
    write_report(args, out_dir, steps, overall_rc, "RUNNING")
    print_step_status("preflight", preflight)
    if preflight["returncode"] != 0:
        overall_rc = max(overall_rc, preflight["returncode"])
        if not args.continue_on_error:
            targets: list[str] = []
        else:
            targets = selected_targets(args.profile, args.include_torch)
    else:
        targets = selected_targets(args.profile, args.include_torch)

    for command in fetch_commands(args):
        item = run(command, args.timeout_seconds)
        steps.append({"kind": "external_asset", **item})
        write_report(args, out_dir, steps, overall_rc, "RUNNING")
        print_step_status("external_asset", item)
        if item["returncode"] != 0:
            overall_rc = max(overall_rc, item["returncode"])
            if not args.continue_on_error:
                targets = []
                break

    for target in targets:
        item = make_target(target, args.timeout_seconds, args.run_id)
        steps.append({"kind": "make_target", "target": target, **item})
        write_report(args, out_dir, steps, overall_rc, "RUNNING")
        print_step_status("make_target", item, target)
        if item["returncode"] != 0:
            overall_rc = max(overall_rc, item["returncode"])
            if not args.continue_on_error:
                break

    status = "PASS" if overall_rc == 0 else "FAIL"
    report_path = write_report(args, out_dir, steps, overall_rc, status)
    print(f"STATUS: {status} ai_eda.bootstrap profile={args.profile} {report_path}")
    return overall_rc


if __name__ == "__main__":
    raise SystemExit(main())
