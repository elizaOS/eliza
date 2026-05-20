#!/usr/bin/env python3
"""
Babylon training stack preflight.

This runs the current production-facing training commands instead of poking
legacy internals:
1. Canonical local SFT prepare-only smoke run against a local export.
2. Pinned dependency audit.
3. Rollback tooling status commands.
4. Nebius dry-run plan rendering.
5. Tinker dry-run environment validation.
6. Optional alert webhook ping.
7. Optional throughput report validation.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent

sys.path.insert(0, str(PYTHON_ROOT))

from src.training.tinker_client import TINKER_API_KEY_ENV_VARS, resolve_tinker_api_key

CheckStatus = Literal["passed", "failed", "blocked"]


@dataclass
class CheckResult:
    name: str
    status: CheckStatus
    message: str
    details: dict[str, Any] = field(default_factory=dict)


def run_command(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: int = 600,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout_seconds,
    )


def trim_output(value: str, *, limit: int = 1200) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def parse_required_gpus(value: str) -> list[str]:
    if not value.strip():
        return []
    parsed = [item.strip().lower() for item in value.split(",") if item.strip()]
    invalid = [item for item in parsed if item not in {"h100", "h200"}]
    if invalid:
        raise argparse.ArgumentTypeError(
            f"Unsupported throughput GPU(s): {', '.join(sorted(set(invalid)))}"
        )
    return parsed


def validate_throughput_report(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Throughput report must be a JSON object: {path}")

    required_fields = (
        "gpu",
        "model",
        "max_seq_length",
        "effective_tokens_per_second",
        "batch_size",
        "gradient_accumulation_steps",
        "measured_at",
        "command",
    )
    missing = [field for field in required_fields if field not in payload]
    if missing:
        raise ValueError(
            f"Throughput report is missing required field(s) {', '.join(missing)}: {path}"
        )

    gpu = str(payload["gpu"]).strip().lower()
    if gpu not in {"h100", "h200"}:
        raise ValueError(f"Throughput report gpu must be h100 or h200: {path}")
    if not str(payload["model"]).strip():
        raise ValueError(f"Throughput report model must be non-empty: {path}")
    if int(payload["max_seq_length"]) <= 0:
        raise ValueError(f"Throughput report max_seq_length must be positive: {path}")
    if float(payload["effective_tokens_per_second"]) <= 0.0:
        raise ValueError(f"Throughput report effective_tokens_per_second must be positive: {path}")
    if int(payload["batch_size"]) <= 0:
        raise ValueError(f"Throughput report batch_size must be positive: {path}")
    if int(payload["gradient_accumulation_steps"]) <= 0:
        raise ValueError(f"Throughput report gradient_accumulation_steps must be positive: {path}")
    if not str(payload["measured_at"]).strip():
        raise ValueError(f"Throughput report measured_at must be non-empty: {path}")
    if not str(payload["command"]).strip():
        raise ValueError(f"Throughput report command must be non-empty: {path}")

    normalized = dict(payload)
    normalized["gpu"] = gpu
    normalized["path"] = str(path)
    normalized["max_seq_length"] = int(payload["max_seq_length"])
    normalized["effective_tokens_per_second"] = float(payload["effective_tokens_per_second"])
    normalized["batch_size"] = int(payload["batch_size"])
    normalized["gradient_accumulation_steps"] = int(payload["gradient_accumulation_steps"])
    return normalized


def check_local_pipeline_smoke(local_export_dir: Path | None) -> CheckResult:
    if local_export_dir is None:
        return CheckResult(
            name="local_pipeline_smoke",
            status="blocked",
            message="No --local-export-dir was provided for the canonical prepare-only smoke run.",
        )
    if not local_export_dir.exists():
        return CheckResult(
            name="local_pipeline_smoke",
            status="failed",
            message=f"Local export directory does not exist: {local_export_dir}",
        )
    if not (local_export_dir / "trajectories.jsonl").exists():
        return CheckResult(
            name="local_pipeline_smoke",
            status="failed",
            message=f"Local export is missing trajectories.jsonl: {local_export_dir}",
        )

    with tempfile.TemporaryDirectory(prefix="babylon-preflight-local-") as output_dir:
        command = [
            sys.executable,
            str(SCRIPT_DIR / "run_pipeline.py"),
            "--mode",
            "train",
            "--output",
            output_dir,
            "--prepare-only",
            "--trajectory-source",
            "local_export",
            "--source-dir",
            str(local_export_dir),
            "--skip-scambench",
            "--no-wandb",
        ]
        completed = run_command(command, cwd=PYTHON_ROOT, timeout_seconds=900)
        if completed.returncode != 0:
            return CheckResult(
                name="local_pipeline_smoke",
                status="failed",
                message="Canonical prepare-only smoke run failed.",
                details={
                    "returncode": completed.returncode,
                    "stdout": trim_output(completed.stdout),
                    "stderr": trim_output(completed.stderr),
                },
            )

        report_path = Path(output_dir) / "pipeline_report.json"
        if not report_path.exists():
            return CheckResult(
                name="local_pipeline_smoke",
                status="failed",
                message="Canonical smoke run succeeded but did not write pipeline_report.json.",
                details={"stdout": trim_output(completed.stdout)},
            )

        report = json.loads(report_path.read_text(encoding="utf-8"))
        sft_stage = dict(report.get("stages", {}).get("sft") or {})
        status = str(sft_stage.get("status") or "")
        training_status = str(sft_stage.get("training_status") or "")
        if status != "completed" or training_status != "prepared_data":
            return CheckResult(
                name="local_pipeline_smoke",
                status="failed",
                message="Canonical smoke run completed, but SFT stage state was not prepared_data.",
                details={
                    "sft_stage": sft_stage,
                    "stdout": trim_output(completed.stdout),
                },
            )

        return CheckResult(
            name="local_pipeline_smoke",
            status="passed",
            message="Canonical prepare-only smoke run completed.",
            details={
                "sft_status": status,
                "training_status": training_status,
                "training_artifact": sft_stage.get("training_artifact"),
            },
        )


def check_dependency_audit() -> CheckResult:
    command = [sys.executable, str(SCRIPT_DIR / "analysis" / "audit_prod_dependencies.py")]
    completed = run_command(command, cwd=PYTHON_ROOT, timeout_seconds=900)
    if completed.returncode != 0:
        return CheckResult(
            name="dependency_audit",
            status="failed",
            message="Pinned dependency audit failed.",
            details={
                "returncode": completed.returncode,
                "stdout": trim_output(completed.stdout),
                "stderr": trim_output(completed.stderr),
            },
        )

    payload = json.loads(completed.stdout or "{}")
    dependency_entries = payload.get("dependencies", []) if isinstance(payload, dict) else []
    vulnerable_dependencies = [
        entry for entry in dependency_entries if isinstance(entry, dict) and entry.get("vulns")
    ]
    fixes = payload.get("fixes", []) if isinstance(payload, dict) else payload
    if vulnerable_dependencies or fixes:
        return CheckResult(
            name="dependency_audit",
            status="failed",
            message="Pinned dependency audit reported vulnerabilities.",
            details={"findings": payload},
        )

    return CheckResult(
        name="dependency_audit",
        status="passed",
        message="Pinned dependency audit returned no known vulnerabilities.",
    )


def check_release_status_commands() -> CheckResult:
    with tempfile.TemporaryDirectory(prefix="babylon-preflight-release-") as tmp_dir:
        root = Path(tmp_dir)
        commands = {
            "scam_defense": [
                sys.executable,
                str(SCRIPT_DIR / "releases" / "manage_scam_defense_release.py"),
                "status",
                "--release-root",
                str(root / "scam-defense"),
            ],
            "rlvr": [
                sys.executable,
                str(SCRIPT_DIR / "releases" / "manage_rlvr_release.py"),
                "status",
                "--release-root",
                str(root / "rlvr"),
            ],
        }

        details: dict[str, Any] = {}
        for label, command in commands.items():
            completed = run_command(command, cwd=PYTHON_ROOT, timeout_seconds=120)
            if completed.returncode != 0:
                return CheckResult(
                    name="release_status",
                    status="failed",
                    message=f"Release status command failed for {label}.",
                    details={
                        "label": label,
                        "returncode": completed.returncode,
                        "stdout": trim_output(completed.stdout),
                        "stderr": trim_output(completed.stderr),
                    },
                )
            payload = json.loads(completed.stdout or "{}")
            if "current" not in payload or "previous" not in payload:
                return CheckResult(
                    name="release_status",
                    status="failed",
                    message=f"Release status output for {label} was malformed.",
                    details={"payload": payload},
                )
            details[label] = payload

        return CheckResult(
            name="release_status",
            status="passed",
            message="Rollback status commands executed cleanly.",
            details=details,
        )


def check_nebius_dry_run(base_model: str, gpu_type: str) -> CheckResult:
    command = [
        sys.executable,
        str(SCRIPT_DIR / "tools" / "run_nebius_unified_matrix.py"),
        "--base-model",
        base_model,
        "--gpu-type",
        gpu_type,
        "--dry-run",
    ]
    completed = run_command(command, cwd=PYTHON_ROOT, timeout_seconds=300)
    if completed.returncode != 0:
        return CheckResult(
            name="nebius_dry_run",
            status="failed",
            message="Nebius dry-run failed.",
            details={
                "returncode": completed.returncode,
                "stdout": trim_output(completed.stdout),
                "stderr": trim_output(completed.stderr),
            },
        )

    stdout = completed.stdout
    expected_platform = f"gpu-{gpu_type}-sxm"
    if expected_platform not in stdout or "1gpu-16vcpu-200gb" not in stdout:
        return CheckResult(
            name="nebius_dry_run",
            status="failed",
            message="Nebius dry-run did not resolve the expected single-VM shape.",
            details={"stdout": trim_output(stdout)},
        )

    return CheckResult(
        name="nebius_dry_run",
        status="passed",
        message="Nebius dry-run resolved the expected VM shape.",
        details={"stdout": trim_output(stdout)},
    )


def check_tinker_dry_run() -> CheckResult:
    if not resolve_tinker_api_key():
        return CheckResult(
            name="tinker_dry_run",
            status="blocked",
            message=(
                "Tinker dry-run is blocked because no API key alias is set. "
                f"Set one of {', '.join(TINKER_API_KEY_ENV_VARS)}."
            ),
        )

    missing = [
        env_name for env_name in ("DATABASE_URL", "OPENAI_API_KEY") if not os.getenv(env_name)
    ]
    if missing:
        return CheckResult(
            name="tinker_dry_run",
            status="blocked",
            message=(
                "Tinker dry-run is blocked because required environment variables are missing: "
                + ", ".join(missing)
            ),
        )

    command = [sys.executable, str(SCRIPT_DIR / "run_tinker_training.py"), "--dry-run"]
    completed = run_command(command, cwd=PYTHON_ROOT, timeout_seconds=300)
    if completed.returncode != 0:
        return CheckResult(
            name="tinker_dry_run",
            status="failed",
            message="Tinker dry-run failed.",
            details={
                "returncode": completed.returncode,
                "stdout": trim_output(completed.stdout),
                "stderr": trim_output(completed.stderr),
            },
        )

    return CheckResult(
        name="tinker_dry_run",
        status="passed",
        message="Tinker dry-run environment check passed.",
        details={"stdout": trim_output(completed.stdout)},
    )


def check_alert_webhook(
    alert_webhook_url: str | None,
    *,
    ping: bool,
) -> CheckResult:
    if not alert_webhook_url:
        return CheckResult(
            name="alert_webhook",
            status="blocked",
            message="Alert webhook is not configured.",
        )

    if not ping:
        return CheckResult(
            name="alert_webhook",
            status="passed",
            message="Alert webhook is configured.",
            details={"url": alert_webhook_url},
        )

    payload = {
        "event": "training_preflight_ping",
        "source": "packages/training/python/scripts/test_pipeline.py",
    }
    request = urllib.request.Request(
        alert_webhook_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status_code = getattr(response, "status", None) or response.getcode()
    except urllib.error.HTTPError as exc:
        return CheckResult(
            name="alert_webhook",
            status="failed",
            message=f"Alert webhook ping failed with HTTP {exc.code}.",
            details={"url": alert_webhook_url},
        )
    except urllib.error.URLError as exc:
        return CheckResult(
            name="alert_webhook",
            status="failed",
            message=f"Alert webhook ping failed: {exc.reason}",
            details={"url": alert_webhook_url},
        )

    return CheckResult(
        name="alert_webhook",
        status="passed",
        message=f"Alert webhook ping returned HTTP {status_code}.",
        details={"url": alert_webhook_url, "status_code": status_code},
    )


def check_throughput_reports(
    throughput_reports: list[Path],
    required_gpus: list[str],
) -> CheckResult:
    if not throughput_reports:
        if required_gpus:
            return CheckResult(
                name="throughput_reports",
                status="blocked",
                message=(
                    "Throughput qualification is required but no --throughput-report files were provided."
                ),
                details={"required_gpus": required_gpus},
            )
        return CheckResult(
            name="throughput_reports",
            status="passed",
            message="No throughput reports were requested.",
        )

    try:
        validated = [validate_throughput_report(path) for path in throughput_reports]
    except Exception as exc:
        return CheckResult(
            name="throughput_reports",
            status="failed",
            message=str(exc),
        )

    present_gpus = sorted({str(item["gpu"]) for item in validated})
    missing_gpus = sorted(set(required_gpus) - set(present_gpus))
    if missing_gpus:
        return CheckResult(
            name="throughput_reports",
            status="blocked",
            message=("Throughput reports were provided, but required GPU coverage is incomplete."),
            details={"required_gpus": required_gpus, "present_gpus": present_gpus},
        )

    return CheckResult(
        name="throughput_reports",
        status="passed",
        message="Throughput report files passed schema validation.",
        details={"reports": validated},
    )


def render_human_summary(results: list[CheckResult]) -> str:
    lines = [
        "=" * 72,
        "BABYLON TRAINING STACK PREFLIGHT",
        "=" * 72,
    ]
    for result in results:
        icon = {
            "passed": "PASS",
            "failed": "FAIL",
            "blocked": "BLOCK",
        }[result.status]
        lines.append(f"{icon:5} {result.name}: {result.message}")
    passed = sum(result.status == "passed" for result in results)
    failed = sum(result.status == "failed" for result in results)
    blocked = sum(result.status == "blocked" for result in results)
    lines.append("=" * 72)
    lines.append(f"passed={passed} failed={failed} blocked={blocked}")
    lines.append("=" * 72)
    return "\n".join(lines)


def build_args() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run production-style preflight checks for the Babylon training stack."
    )
    parser.add_argument(
        "--local-export-dir",
        default="",
        help="Local export directory for the canonical prepare-only smoke run.",
    )
    parser.add_argument(
        "--skip-local-smoke",
        action="store_true",
        help="Skip the canonical prepare-only smoke run.",
    )
    parser.add_argument(
        "--skip-dependency-audit",
        action="store_true",
        help="Skip the pinned dependency audit.",
    )
    parser.add_argument(
        "--skip-release-status",
        action="store_true",
        help="Skip rollback status command checks.",
    )
    parser.add_argument(
        "--skip-nebius-dry-run",
        action="store_true",
        help="Skip the Nebius dry-run plan check.",
    )
    parser.add_argument(
        "--skip-tinker-dry-run",
        action="store_true",
        help="Skip the Tinker dry-run check.",
    )
    parser.add_argument(
        "--skip-alert-check",
        action="store_true",
        help="Skip alert webhook validation.",
    )
    parser.add_argument(
        "--ping-alert-webhook",
        action="store_true",
        help="POST a test event to the configured alert webhook.",
    )
    parser.add_argument(
        "--alert-webhook-url",
        default=os.getenv("CANONICAL_PIPELINE_ALERT_WEBHOOK_URL", ""),
        help="Override the alert webhook URL for this run.",
    )
    parser.add_argument(
        "--nebius-base-model",
        default="Qwen/Qwen3.5-9B",
        help="Base model to use for the Nebius dry-run plan.",
    )
    parser.add_argument(
        "--nebius-gpu-type",
        choices=["h100", "h200"],
        default="h100",
        help="Nebius GPU type to use for the dry-run plan.",
    )
    parser.add_argument(
        "--throughput-report",
        dest="throughput_reports",
        action="append",
        default=[],
        help="Path to a measured H100/H200 throughput report JSON artifact. Repeat for multiple GPUs.",
    )
    parser.add_argument(
        "--require-throughput-gpus",
        type=parse_required_gpus,
        default=[],
        help="Comma-separated GPU list that must be covered by throughput reports (e.g. h100,h200).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of a human summary.",
    )
    return parser


def main() -> int:
    parser = build_args()
    args = parser.parse_args()

    local_export_dir = Path(args.local_export_dir).resolve() if args.local_export_dir else None
    throughput_reports = [Path(value).resolve() for value in args.throughput_reports]

    results: list[CheckResult] = []
    if not args.skip_local_smoke:
        results.append(check_local_pipeline_smoke(local_export_dir))
    if not args.skip_dependency_audit:
        results.append(check_dependency_audit())
    if not args.skip_release_status:
        results.append(check_release_status_commands())
    if not args.skip_nebius_dry_run:
        results.append(check_nebius_dry_run(args.nebius_base_model, args.nebius_gpu_type))
    if not args.skip_tinker_dry_run:
        results.append(check_tinker_dry_run())
    if not args.skip_alert_check:
        results.append(
            check_alert_webhook(
                args.alert_webhook_url.strip() or None,
                ping=args.ping_alert_webhook,
            )
        )
    results.append(
        check_throughput_reports(
            throughput_reports,
            args.require_throughput_gpus,
        )
    )

    payload = {
        "results": [asdict(result) for result in results],
        "summary": {
            "passed": sum(result.status == "passed" for result in results),
            "failed": sum(result.status == "failed" for result in results),
            "blocked": sum(result.status == "blocked" for result in results),
        },
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(render_human_summary(results))

    return 0 if payload["summary"]["failed"] == 0 and payload["summary"]["blocked"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
