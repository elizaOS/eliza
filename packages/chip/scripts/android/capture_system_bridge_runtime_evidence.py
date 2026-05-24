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
ANDROID_SIM_BOOT_REPORT = ROOT / "build/reports/android_sim_boot.json"
SCHEMA = "eliza.android_system_bridge_runtime_evidence.v1"
CLAIM_BOUNDARY = "booted_android_system_bridge_runtime_evidence_only"
DEFAULT_BRIDGE_SYSTEM_APK = "/system/priv-app/ElizaSystemBridge/ElizaSystemBridge.apk"
PERMISSION_FILE_PATHS = (
    "/system/etc/default-permissions/default-permissions-ai.milady.milady.xml",
    "/system/etc/permissions/privapp-permissions-ai.milady.milady.xml",
    "/system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
)
ANDROID_TARGET_PREFIXES = (
    "/system/",
    "/vendor/",
    "/product/",
    "/system_ext/",
    "/odm/",
    "/apex/",
    "/data/",
)
REQUIRED_PRIV_PERMISSIONS = (
    "android.permission.REBOOT",
    "android.permission.DEVICE_POWER",
    "android.permission.WRITE_SECURE_SETTINGS",
)
AOSP_BUILD_ONLY_COMMAND = (
    "AOSP_DIR=/home/shaw/aosp python3 packages/chip/scripts/run_with_timeout.py "
    "--timeout-seconds 2400 --label aosp-build-only-evidence -- "
    "packages/chip/scripts/boot_android_simulator.sh --build-only"
)
AOSP_FULL_RUNTIME_COMMAND = (
    "AOSP_DIR=/home/shaw/aosp packages/chip/scripts/boot_android_simulator.sh "
    "--run-cuttlefish --run-cts --run-vts --run-qemu --run-renode"
)
AOSP_EXPECTED_EVIDENCE = (
    ROOT / "docs/evidence/android/eliza_ai_soc_lunch.log",
    ROOT / "docs/evidence/android/eliza_ai_soc_vendorimage.log",
    ROOT / "docs/evidence/android/eliza_ai_soc_checkvintf.log",
    ROOT / "docs/evidence/android/eliza_ai_soc_sepolicy_build.log",
    ROOT / "docs/evidence/android/eliza_ai_soc_selinux_neverallow.log",
)
AOSP_PRODUCT_OUT = (
    Path(os.environ.get("AOSP_DIR", "/home/shaw/aosp"))
    / "out/target/product/eliza_ai_soc"
)
AOSP_EXPECTED_ARTIFACT_NAMES = (
    "vendor.img",
    "system.img",
    "product.img",
    "system_ext.img",
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


def available_tool(name: str, timeout_seconds: int) -> dict[str, object]:
    probe = run(["sh", "-lc", f"command -v {name}"], timeout_seconds)
    return {
        "name": name,
        "available": probe.ok and bool(probe.output.strip()),
        "path": probe.output.strip().splitlines()[-1] if probe.output.strip() else "",
    }


def parse_adb_targets(adb_devices_output: str) -> list[dict[str, str]]:
    targets: list[dict[str, str]] = []
    for raw in adb_devices_output.splitlines():
        line = raw.strip()
        if not line or line.startswith("List of devices attached"):
            continue
        fields = line.split()
        if len(fields) < 2:
            continue
        serial, state = fields[0], fields[1]
        details = " ".join(fields[2:])
        targets.append({"serial": serial, "state": state, "details": details})
    return targets


def choose_ready_serial(adb_devices_output: str) -> str | None:
    ready = [target["serial"] for target in parse_adb_targets(adb_devices_output) if target["state"] == "device"]
    return ready[0] if len(ready) == 1 else None


def maybe_connect_adb(args: argparse.Namespace, adb_devices: Probe) -> tuple[Probe, str | None, list[dict[str, object]]]:
    attempts: list[dict[str, object]] = [
        {"command": ["adb", "devices", "-l"], "ok": adb_devices.ok, "output": adb_devices.output.strip()}
    ]
    if args.adb_serial:
        return adb_devices, args.adb_serial, attempts
    selected = choose_ready_serial(adb_devices.output)
    if selected:
        return adb_devices, selected, attempts
    for address in args.adb_connect:
        command = ["adb", "connect", address]
        probe = run(command, args.timeout_seconds)
        attempts.append({"command": command, "ok": probe.ok, "output": probe.output.strip()})
    if args.adb_connect:
        adb_devices = run(["adb", "devices", "-l"], args.timeout_seconds)
        attempts.append(
            {"command": ["adb", "devices", "-l"], "ok": adb_devices.ok, "output": adb_devices.output.strip()}
        )
    return adb_devices, choose_ready_serial(adb_devices.output), attempts


def file_snapshot(path: Path, *, tail_lines: int = 0) -> dict[str, object]:
    try:
        display_path = rel(path)
    except ValueError:
        display_path = str(path)
    record: dict[str, object] = {"path": display_path, "exists": path.exists()}
    if not path.exists():
        return record
    stat = path.stat()
    record["size_bytes"] = stat.st_size
    record["mtime_utc"] = datetime.fromtimestamp(stat.st_mtime, UTC).replace(
        microsecond=0
    ).isoformat().replace("+00:00", "Z")
    if tail_lines:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        record["tail"] = lines[-tail_lines:]
    return record


def aosp_build_artifact_inventory() -> dict[str, object]:
    records = [
        {
            **file_snapshot(AOSP_PRODUCT_OUT / name),
            "name": name,
            "required_for_bootable_chip_archive": True,
        }
        for name in AOSP_EXPECTED_ARTIFACT_NAMES
    ]
    present = [record["name"] for record in records if record["exists"]]
    missing = [record["name"] for record in records if not record["exists"]]
    return {
        "status": "complete" if not missing else ("partial" if present else "missing"),
        "product_out": str(AOSP_PRODUCT_OUT),
        "present": present,
        "missing": missing,
        "records": records,
        "blocker_dependency": "repo_artifact_generation" if missing else "",
        "next_step": (
            "Finish the eliza_ai_soc AOSP build and produce every required image "
            "before staging a release archive."
            if missing
            else "Stage the generated images into the Android release archive and collect live boot evidence."
        ),
    }


def aosp_build_only_diagnostics(timeout_seconds: int) -> dict[str, object]:
    process_probe = run(
        [
            "sh",
            "-lc",
            "ps -eo pid,ppid,etime,stat,cmd | "
            "grep -E 'aosp-build-only-evidence|boot_android_simulator|capture-aosp-evidence|"
            "soong_ui|prebuilts/build-tools/.*/ninja|/bin/m vendorimage' | "
            "grep -v grep || true",
        ],
        timeout_seconds,
    )
    return {
        "purpose": "fail_closed_context_for_concurrent_android_build_only_attempt",
        "active_processes": process_probe.output.strip(),
        "stdout_stderr_access": (
            "run_with_timeout stdout/stderr are inherited pipes; use the evidence logs "
            "and android_sim_boot report below as durable artifacts"
        ),
        "expected_command": AOSP_BUILD_ONLY_COMMAND,
        "full_runtime_command_after_build_only": AOSP_FULL_RUNTIME_COMMAND,
        "validation_commands": [
            "python3 packages/chip/scripts/check_android_sim_boot.py",
            "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py",
            "python3 packages/chip/scripts/android/capture_system_bridge_runtime_evidence.py",
            "python3 packages/chip/scripts/check_android_system_bridge_contract.py",
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
        ],
        "expected_report": file_snapshot(ANDROID_SIM_BOOT_REPORT),
        "expected_evidence_logs": [
            file_snapshot(path, tail_lines=20) for path in AOSP_EXPECTED_EVIDENCE
        ],
        "artifact_inventory": aosp_build_artifact_inventory(),
    }


def host_runtime_diagnostics(adb_devices: Probe, timeout_seconds: int) -> dict[str, object]:
    targets = parse_adb_targets(adb_devices.output)
    ready_targets = [target for target in targets if target["state"] == "device"]
    process_probe = run(
        [
            "sh",
            "-lc",
            "ps -eo pid,ppid,etime,cmd | "
            "grep -E 'cuttlefish|launch_cvd|cvd|qemu-system|emulator|adb|"
            "aosp-build-only-evidence|boot_android_simulator|soong_ui|ninja' | "
            "grep -v grep || true",
        ],
        timeout_seconds,
    )
    listener_probe = run(
        [
            "sh",
            "-lc",
            "ss -ltnp 2>/dev/null | "
            "grep -E '(:5037|:5554|:5555|:6520|:6521|:6522|:1443|adb|qemu|emulator)' || true",
        ],
        timeout_seconds,
    )
    cuttlefish_probe = run(
        [
            "sh",
            "-lc",
            r"""
set -eu
rt="$(ls -dt /var/tmp/cvd/"$(id -u)"/*/home/cuttlefish/instances/cvd-* 2>/dev/null | head -1 || true)"
if [ -z "$rt" ]; then
  echo "latest_instance="
  exit 0
fi
echo "latest_instance=$rt"
for file in "$rt/logs/logcat" "$rt/logs/kernel.log" "$rt/logs/launcher.log"; do
  if [ -e "$file" ]; then
    bytes="$(wc -c < "$file" 2>/dev/null || echo 0)"
    echo "log_file=$file bytes=$bytes"
  fi
done
if [ -f "$rt/logs/kernel.log" ]; then
  grep -E 'android\.security\.maintenance|init: Service|adb|adbd|avc: denied|panic|FATAL|tombstone' "$rt/logs/kernel.log" | tail -40 || true
fi
if [ -f "$rt/logs/launcher.log" ]; then
  grep -E 'adb_connector|socket_vsock_proxy|Kernel log:|Logcat output:|launch failed|Aborted|cvd create rc=' "$rt/logs/launcher.log" | tail -40 || true
fi
""",
        ],
        timeout_seconds,
    )
    return {
        "tools": {
            name: available_tool(name, timeout_seconds)
            for name in ("adb", "cvd", "launch_cvd", "emulator")
        },
        "adb_targets": targets,
        "adb_ready_target_count": len(ready_targets),
        "adb_blocker": "no_ready_adb_device" if not ready_targets else "",
        "runtime_processes": process_probe.output.strip(),
        "tcp_listeners": listener_probe.output.strip(),
        "cuttlefish_runtime": cuttlefish_probe.output.strip(),
        "aosp_build_only": aosp_build_only_diagnostics(timeout_seconds),
    }


def adb_shell(prefix: list[str], timeout_seconds: int, *args: str) -> Probe:
    return run(prefix + ["shell", *args], timeout_seconds)


def permission_granted(package_dump: str, permission: str) -> bool:
    pattern = re.compile(rf"\b{re.escape(permission)}:\s+granted=true\b")
    return bool(pattern.search(package_dump))


def count_lines(text: str, needles: tuple[str, ...]) -> int:
    return sum(1 for line in text.splitlines() if any(needle in line for needle in needles))


def matching_lines(text: str, needles: tuple[str, ...], limit: int = 80) -> list[str]:
    lines = [
        line.strip()
        for line in text.splitlines()
        if any(needle.lower() in line.lower() for needle in needles)
    ]
    return lines[-limit:]


def contains_host_local_symlink(value: object) -> bool:
    text = json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else str(value)
    for target in re.findall(r"->\s+(/[^\s\"']+)", text):
        if not target.startswith(ANDROID_TARGET_PREFIXES):
            return True
    return any(marker in text for marker in (" -> /home/", " -> /tmp/", " -> /Users/"))


def probe_permission_files(
    prefix: list[str], timeout_seconds: int
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    probes: dict[str, str] = {}
    targets: dict[str, dict[str, str]] = {}
    for path in PERMISSION_FILE_PATHS:
        ls_probe = adb_shell(prefix, timeout_seconds, "ls", "-l", path)
        readlink_probe = adb_shell(prefix, timeout_seconds, "readlink", path)
        canonical_probe = adb_shell(prefix, timeout_seconds, "readlink", "-f", path)
        probes[path] = ls_probe.output.strip()
        targets[path] = {
            "readlink": readlink_probe.output.strip() if readlink_probe.ok else "",
            "readlink_f": canonical_probe.output.strip() if canonical_probe.ok else "",
            "readlink_ok": "true" if readlink_probe.ok else "false",
            "readlink_f_ok": "true" if canonical_probe.ok else "false",
        }
    return probes, targets


def build_report(args: argparse.Namespace) -> dict[str, object]:
    started = utc_now()
    adb_devices = run(["adb", "devices", "-l"], args.timeout_seconds)
    adb_devices, selected_serial, adb_connect_attempts = maybe_connect_adb(args, adb_devices)
    prefix = adb_prefix(selected_serial)
    host_diagnostics = host_runtime_diagnostics(adb_devices, args.timeout_seconds)
    adb_state = run(prefix + ["get-state"], args.timeout_seconds)
    boot = adb_shell(prefix, args.timeout_seconds, "getprop", "sys.boot_completed")
    system_apk = adb_shell(prefix, args.timeout_seconds, "ls", "-l", args.bridge_system_apk_path)
    permission_file_probes, permission_file_symlink_targets = probe_permission_files(
        prefix,
        args.timeout_seconds,
    )
    package_list_eliza = adb_shell(
        prefix,
        args.timeout_seconds,
        "sh",
        "-c",
        "pm list packages -f | grep -Ei 'eliza|milady|system.bridge' || true",
    )
    pm_path = adb_shell(prefix, args.timeout_seconds, "pm", "path", args.bridge_package)
    package_dump = adb_shell(
        prefix, args.timeout_seconds, "dumpsys", "package", args.bridge_package
    )
    service_dump = adb_shell(
        prefix, args.timeout_seconds, "dumpsys", "activity", "services", args.bridge_package
    )
    logcat_probe = adb_shell(prefix, args.timeout_seconds, "logcat", "-d", "-b", "all")
    logcat = logcat_probe.output
    package_scan_excerpt = matching_lines(
        logcat,
        (
            "ElizaSystemBridge",
            args.bridge_package,
            "PackageManager",
            "PackageParsing",
            "Failed to parse",
            "INSTALL_FAILED",
        ),
    )
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
    permission_xml_host_symlink_absent = not contains_host_local_symlink(
        {
            "permission_file_probes": permission_file_probes,
            "permission_file_symlink_targets": permission_file_symlink_targets,
        }
    )

    required = {
        "sys_boot_completed": sys_boot_completed,
        "system_privapp_apk_present": system_apk.ok
        and args.bridge_system_apk_path in system_apk.output,
        "package_installed": package_installed,
        "service_registered": service_registered,
        "privapp_permissions_granted": privapp_permissions_granted,
        "js_bridge_bound": js_bridge_bound,
        "launcher_consumed_live_state": launcher_consumed_live_state,
        "production_mock_fallback_absent": production_mock_fallback_absent,
        "permission_xml_host_symlink_absent": permission_xml_host_symlink_absent,
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
        "adb_serial": selected_serial or "default",
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
            "adb_connect_attempts": adb_connect_attempts,
            "host_runtime": host_diagnostics,
            "adb_get_state": adb_state.output.strip(),
            "adb_get_state_available": adb_state.ok,
            "boot_getprop": boot.output.strip(),
            "bridge_system_apk_path": args.bridge_system_apk_path,
            "bridge_system_apk_present": (
                "present"
                if system_apk.ok and args.bridge_system_apk_path in system_apk.output
                else "missing"
            ),
            "bridge_system_apk_probe": system_apk.output.strip(),
            "permission_file_probes": permission_file_probes,
            "permission_file_symlink_targets": permission_file_symlink_targets,
            "pm_list_eliza": package_list_eliza.output.strip(),
            "pm_path": pm_path.output.strip(),
            "package_scan_excerpt": package_scan_excerpt,
            "service_probe_matched": service_registered,
            "package_dump_available": package_dump.ok,
            "logcat_available": logcat_probe.ok,
            "missing_or_false": missing,
            "recapture_command": (
                "python3 packages/chip/scripts/android/capture_system_bridge_runtime_evidence.py "
                f"--launcher-package {args.launcher_package}"
                + (f" --adb-serial {selected_serial}" if selected_serial else "")
            ),
            "next_operator_commands": [
                AOSP_BUILD_ONLY_COMMAND,
                AOSP_FULL_RUNTIME_COMMAND,
                "python3 packages/chip/scripts/android/capture_system_bridge_runtime_evidence.py",
                "python3 packages/chip/scripts/check_android_system_bridge_contract.py",
            ],
        },
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb-serial")
    parser.add_argument(
        "--adb-connect",
        action="append",
        default=[],
        metavar="HOST:PORT",
        help="run `adb connect HOST:PORT` before probing when no online adb target is visible; may be repeated",
    )
    parser.add_argument("--bridge-package", default="ai.elizaos.system.bridge")
    parser.add_argument("--bridge-system-apk-path", default=DEFAULT_BRIDGE_SYSTEM_APK)
    parser.add_argument("--launcher-package", default="ai.milady.milady")
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
