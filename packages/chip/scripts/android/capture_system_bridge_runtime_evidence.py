#!/usr/bin/env python3
"""Capture booted Android System UI bridge runtime evidence.

This script only promotes facts observed through ADB. Missing ADB, missing
packages, absent log markers, crashes, or SELinux denials produce a blocked
evidence JSON rather than a pass claim.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "docs/evidence/android/system_bridge_runtime_evidence.json"
DEFAULT_LOGCAT = ROOT / "docs/evidence/android/system_bridge_runtime_logcat.log"
SCHEMA = "eliza.android_system_bridge_runtime_evidence.v1"
CLAIM_BOUNDARY = "booted_android_system_bridge_runtime_evidence_only"
REQUIRED_PRIV_PERMISSIONS = (
    "android.permission.REBOOT",
    "android.permission.DEVICE_POWER",
    "android.permission.WRITE_SECURE_SETTINGS",
)


@dataclass(frozen=True)
class Probe:
    ok: bool
    output: str


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def adb_prefix(serial: str | None) -> list[str]:
    return ["adb", "-s", serial] if serial else ["adb"]


def run(command: list[str], timeout_seconds: int) -> Probe:
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as exc:
        return Probe(False, str(exc))
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        return Probe(False, stdout + f"\ncommand timed out after {timeout_seconds}s")
    return Probe(completed.returncode == 0, completed.stdout)


def adb_shell(prefix: list[str], timeout_seconds: int, *args: str) -> Probe:
    return run(prefix + ["shell", *args], timeout_seconds)


def permission_granted(package_dump: str, permission: str) -> bool:
    pattern = re.compile(rf"\b{re.escape(permission)}:\s+granted=true\b")
    return bool(pattern.search(package_dump))


def count_lines(text: str, needles: tuple[str, ...]) -> int:
    return sum(1 for line in text.splitlines() if any(needle in line for needle in needles))


def build_report(args: argparse.Namespace) -> dict[str, object]:
    started = utc_now()
    prefix = adb_prefix(args.adb_serial)
    adb_devices = run(["adb", "devices", "-l"], args.timeout_seconds)
    adb_state = run(prefix + ["get-state"], args.timeout_seconds)
    boot = adb_shell(prefix, args.timeout_seconds, "getprop", "sys.boot_completed")
    pm_path = adb_shell(prefix, args.timeout_seconds, "pm", "path", args.bridge_package)
    package_dump = adb_shell(
        prefix, args.timeout_seconds, "dumpsys", "package", args.bridge_package
    )
    service_dump = adb_shell(
        prefix, args.timeout_seconds, "dumpsys", "activity", "services", args.bridge_package
    )
    logcat_probe = adb_shell(prefix, args.timeout_seconds, "logcat", "-d", "-b", "all")
    logcat = logcat_probe.output
    args.logcat.parent.mkdir(parents=True, exist_ok=True)
    args.logcat.write_text(logcat, encoding="utf-8")

    bridge_bound_marker = args.bridge_bound_marker
    live_state_marker = args.live_state_marker
    mock_fallback_markers = tuple(args.mock_fallback_marker)
    crash_count = count_lines(
        logcat,
        ("FATAL EXCEPTION", "signal 11 (SIGSEGV)", "--------- beginning of crash"),
    )
    denial_count = count_lines(logcat, ("avc: denied",))

    sys_boot_completed = (
        boot.output.strip().splitlines()[-1:] == ["1"] if boot.output.strip() else False
    )
    package_installed = pm_path.output.strip().startswith("package:")
    service_registered = (
        args.bridge_service_marker in service_dump.output
        or args.bridge_package in service_dump.output
    )
    privapp_permissions_granted = all(
        permission_granted(package_dump.output, permission)
        for permission in REQUIRED_PRIV_PERMISSIONS
    )
    js_bridge_bound = bridge_bound_marker in logcat
    launcher_consumed_live_state = live_state_marker in logcat
    production_mock_fallback_absent = not any(marker in logcat for marker in mock_fallback_markers)

    required = {
        "sys_boot_completed": sys_boot_completed,
        "package_installed": package_installed,
        "service_registered": service_registered,
        "privapp_permissions_granted": privapp_permissions_granted,
        "js_bridge_bound": js_bridge_bound,
        "launcher_consumed_live_state": launcher_consumed_live_state,
        "production_mock_fallback_absent": production_mock_fallback_absent,
    }
    pass_status = all(required.values()) and crash_count == 0 and denial_count == 0
    missing = sorted(key for key, value in required.items() if not value)
    if crash_count:
        missing.append("logcat_crash_count_zero")
    if denial_count:
        missing.append("selinux_denial_count_zero")

    return {
        "schema": SCHEMA,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "PASS" if pass_status else "BLOCKED",
        "result": 0 if pass_status else 2,
        "started_utc": started,
        "ended_utc": utc_now(),
        "adb_serial": args.adb_serial or "default",
        "bridge_package": args.bridge_package,
        "launcher_package": args.launcher_package,
        "required_markers": {
            "bridge_bound_marker": bridge_bound_marker,
            "live_state_marker": live_state_marker,
            "mock_fallback_forbidden_markers": list(mock_fallback_markers),
        },
        **required,
        "logcat_crash_count": crash_count,
        "selinux_denial_count": denial_count,
        "artifacts": {
            "logcat_path": rel(args.logcat),
        },
        "observations": {
            "adb_devices": adb_devices.output.strip(),
            "adb_devices_available": adb_devices.ok,
            "adb_get_state": adb_state.output.strip(),
            "adb_get_state_available": adb_state.ok,
            "boot_getprop": boot.output.strip(),
            "pm_path": pm_path.output.strip(),
            "service_probe_matched": service_registered,
            "package_dump_available": package_dump.ok,
            "logcat_available": logcat_probe.ok,
            "missing_or_false": missing,
        },
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb-serial")
    parser.add_argument("--bridge-package", default="ai.elizaos.system.bridge")
    parser.add_argument("--launcher-package", default="ai.elizaos.app")
    parser.add_argument("--bridge-service-marker", default="ai.elizaos.system.bridge")
    parser.add_argument(
        "--bridge-bound-marker",
        default=os.environ.get("ELIZA_SYSTEM_BRIDGE_BOUND_MARKER", "ElizaSystemBridge: bound"),
    )
    parser.add_argument(
        "--live-state-marker",
        default=os.environ.get(
            "ELIZA_SYSTEM_BRIDGE_LIVE_STATE_MARKER", "AndroidSystemProvider: live-state"
        ),
    )
    parser.add_argument(
        "--mock-fallback-marker",
        action="append",
        default=[
            "native system bridge transport (__elizaAndroidBridge) is not bound",
            "MockSystemProvider",
        ],
        help="forbidden logcat marker; may be repeated",
    )
    parser.add_argument("--timeout-seconds", type=int, default=30)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--logcat", type=Path, default=DEFAULT_LOGCAT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if not args.output.is_absolute():
        args.output = ROOT / args.output
    if not args.logcat.is_absolute():
        args.logcat = ROOT / args.logcat
    report = build_report(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{report['status']}: android.system_bridge_runtime ({rel(args.output)})")
    if report["status"] != "PASS":
        observations = report.get("observations")
        missing = observations.get("missing_or_false", []) if isinstance(observations, dict) else []
        print("missing_or_false=" + ",".join(str(item) for item in missing))
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
