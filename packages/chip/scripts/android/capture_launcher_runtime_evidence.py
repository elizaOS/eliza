#!/usr/bin/env python3
"""Capture booted Android launcher + local-agent runtime evidence.

This script writes the exact JSON shape consumed by
check_android_launcher_runtime_evidence.py. It is fail-closed: missing ADB,
offline devices, boot-incomplete targets, absent HOME resolution, unhealthy
agent, crashes, or SELinux denials produce a BLOCKED evidence file instead of
an inferred pass.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "docs/evidence/android/eliza_launcher_runtime_evidence.json"
DEFAULT_LOGCAT = ROOT / "docs/evidence/android/eliza_launcher_runtime_logcat.txt"
DEFAULT_TRANSCRIPT = ROOT / "docs/evidence/android/eliza_launcher_runtime_transcript.log"
ANDROID_SIM_BOOT_REPORT = ROOT / "build/reports/android_sim_boot.json"
SCHEMA = "eliza.android_launcher_runtime_evidence.v1"
CLAIM_BOUNDARY = "booted_android_launcher_agent_runtime_evidence_only"
DEFAULT_PACKAGE = "ai.elizaos.app"
DEFAULT_SERVICE = "ai.elizaos.app/.ElizaAgentService"
DEFAULT_SYSTEM_APK = "/system/priv-app/Eliza/Eliza.apk"
PERMISSION_FILE_PATHS = (
    "/system/etc/default-permissions/default-permissions-ai.elizaos.app.xml",
    "/system/etc/permissions/privapp-permissions-ai.elizaos.app.xml",
    "/system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
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
    Path(os.environ.get("AOSP_DIR", "/home/shaw/aosp")) / "out/target/product/eliza_ai_soc"
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


def adb_shell(prefix: list[str], timeout_seconds: int, *args: str) -> Probe:
    return run(prefix + ["shell", *args], timeout_seconds)


def parse_adb_targets(adb_devices_output: str) -> list[dict[str, str]]:
    targets: list[dict[str, str]] = []
    for raw in adb_devices_output.splitlines():
        line = raw.strip()
        if not line or line.startswith("List of devices attached"):
            continue
        fields = line.split()
        if len(fields) < 2:
            continue
        targets.append(
            {
                "serial": fields[0],
                "state": fields[1],
                "details": " ".join(fields[2:]),
            }
        )
    return targets


def file_snapshot(path: Path, *, tail_lines: int = 0) -> dict[str, object]:
    record: dict[str, object] = {"path": rel(path), "exists": path.exists()}
    if not path.exists():
        return record
    stat = path.stat()
    record["size_bytes"] = stat.st_size
    record["mtime_utc"] = (
        datetime.fromtimestamp(stat.st_mtime, UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
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
        "adb_targets": targets,
        "adb_ready_target_count": len(ready_targets),
        "adb_blocker": "no_ready_adb_device" if not ready_targets else "",
        "runtime_processes": process_probe.output.strip(),
        "tcp_listeners": listener_probe.output.strip(),
        "cuttlefish_runtime": cuttlefish_probe.output.strip(),
        "aosp_build_only": aosp_build_only_diagnostics(timeout_seconds),
    }


def last_line(probe: Probe) -> str:
    lines = [line.strip() for line in probe.output.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def count_lines(text: str, needles: tuple[str, ...]) -> int:
    return sum(1 for line in text.splitlines() if any(needle in line for needle in needles))


def matching_lines(text: str, needles: tuple[str, ...], limit: int = 80) -> list[str]:
    lines = [
        line.strip()
        for line in text.splitlines()
        if any(needle.lower() in line.lower() for needle in needles)
    ]
    return lines[-limit:]


def role_holders(
    prefix: list[str], timeout_seconds: int, roles: tuple[str, ...]
) -> dict[str, list[str]]:
    holders: dict[str, list[str]] = {}
    for role in roles:
        probe = adb_shell(prefix, timeout_seconds, "cmd", "role", "holders", role)
        values = [line.strip() for line in probe.output.splitlines() if line.strip()]
        holders[role] = values
    return holders


def extract_foreground(activity_dump: str, window_dump: str) -> str:
    for text in (activity_dump, window_dump):
        for pattern in (
            r"mResumedActivity:\s+(.+)",
            r"topResumedActivity=([^\n]+)",
            r"mCurrentFocus=([^\n]+)",
            r"mFocusedApp=([^\n]+)",
        ):
            match = re.search(pattern, text)
            if match:
                return match.group(1).strip()
    return ""


def probe_permission_files(
    prefix: list[str],
    timeout_seconds: int,
    recorder,
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    probes: dict[str, str] = {}
    targets: dict[str, dict[str, str]] = {}
    for path in PERMISSION_FILE_PATHS:
        ls_probe = recorder(
            prefix + ["shell", "ls", "-l", path],
            adb_shell(prefix, timeout_seconds, "ls", "-l", path),
        )
        readlink_probe = recorder(
            prefix + ["shell", "readlink", path],
            adb_shell(prefix, timeout_seconds, "readlink", path),
        )
        canonical_probe = recorder(
            prefix + ["shell", "readlink", "-f", path],
            adb_shell(prefix, timeout_seconds, "readlink", "-f", path),
        )
        probes[path] = ls_probe.output.strip()
        targets[path] = {
            "readlink": readlink_probe.output.strip() if readlink_probe.ok else "",
            "readlink_f": canonical_probe.output.strip() if canonical_probe.ok else "",
            "readlink_ok": "true" if readlink_probe.ok else "false",
            "readlink_f_ok": "true" if canonical_probe.ok else "false",
        }
    return probes, targets


def http_health(url: str, timeout_seconds: int) -> tuple[int, bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout_seconds) as response:
            raw = response.read().decode(errors="replace")
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = {}
            return response.status, body.get("ready") is True, raw
    except urllib.error.HTTPError as exc:
        return exc.code, False, exc.read().decode(errors="replace")
    except Exception as exc:  # noqa: BLE001 - capture evidence should not crash on host/network faults.
        return 0, False, str(exc)


def write_transcript(path: Path, commands: list[dict[str, object]], health_body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "eliza-evidence: transcript=android_launcher_runtime",
        f"eliza-evidence: claim_boundary={CLAIM_BOUNDARY}",
    ]
    for item in commands:
        lines.append(f"$ {' '.join(str(part) for part in item['command'])}")
        lines.append(str(item["output"]).rstrip())
        lines.append(f"[ok={item['ok']}]")
    lines.append("$ host-http /api/health")
    lines.append(health_body.rstrip())
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def choose_ready_serial(adb_devices_output: str) -> str | None:
    ready = [
        target["serial"]
        for target in parse_adb_targets(adb_devices_output)
        if target["state"] == "device"
    ]
    return ready[0] if len(ready) == 1 else None


def build_report(args: argparse.Namespace) -> dict[str, object]:
    started = utc_now()
    commands: list[dict[str, object]] = []

    def record(command: list[str], probe: Probe) -> Probe:
        commands.append({"command": command, "ok": probe.ok, "output": probe.output.strip()})
        return probe

    adb_devices = record(
        ["adb", "devices", "-l"], run(["adb", "devices", "-l"], args.timeout_seconds)
    )
    if not args.adb_serial and not choose_ready_serial(adb_devices.output):
        for address in args.adb_connect:
            record(
                ["adb", "connect", address], run(["adb", "connect", address], args.timeout_seconds)
            )
        if args.adb_connect:
            adb_devices = record(
                ["adb", "devices", "-l"],
                run(["adb", "devices", "-l"], args.timeout_seconds),
            )
    selected_serial = args.adb_serial or choose_ready_serial(adb_devices.output)
    prefix = adb_prefix(selected_serial)
    host_runtime = host_runtime_diagnostics(adb_devices, args.timeout_seconds)
    adb_state = record(prefix + ["get-state"], run(prefix + ["get-state"], args.timeout_seconds))
    boot = record(
        prefix + ["shell", "getprop", "sys.boot_completed"],
        adb_shell(prefix, args.timeout_seconds, "getprop", "sys.boot_completed"),
    )
    cpu_abi = record(
        prefix + ["shell", "getprop", "ro.product.cpu.abi"],
        adb_shell(prefix, args.timeout_seconds, "getprop", "ro.product.cpu.abi"),
    )
    cpu_abilist = record(
        prefix + ["shell", "getprop", "ro.product.cpu.abilist"],
        adb_shell(prefix, args.timeout_seconds, "getprop", "ro.product.cpu.abilist"),
    )
    uname_m = record(
        prefix + ["shell", "uname", "-m"], adb_shell(prefix, args.timeout_seconds, "uname", "-m")
    )
    build_id = record(
        prefix + ["shell", "getprop", "ro.build.id"],
        adb_shell(prefix, args.timeout_seconds, "getprop", "ro.build.id"),
    )
    sdk = record(
        prefix + ["shell", "getprop", "ro.build.version.sdk"],
        adb_shell(prefix, args.timeout_seconds, "getprop", "ro.build.version.sdk"),
    )
    system_apk = record(
        prefix + ["shell", "ls", "-l", args.system_apk_path],
        adb_shell(prefix, args.timeout_seconds, "ls", "-l", args.system_apk_path),
    )
    permission_file_probes, permission_file_symlink_targets = probe_permission_files(
        prefix,
        args.timeout_seconds,
        record,
    )
    package_list_eliza = record(
        prefix + ["shell", "sh", "-c", "pm list packages -f | grep -i eliza || true"],
        adb_shell(
            prefix, args.timeout_seconds, "sh", "-c", "pm list packages -f | grep -i eliza || true"
        ),
    )
    pm_path = record(
        prefix + ["shell", "pm", "path", args.package],
        adb_shell(prefix, args.timeout_seconds, "pm", "path", args.package),
    )
    home_resolve = record(
        prefix
        + [
            "shell",
            "cmd",
            "package",
            "resolve-activity",
            "--brief",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.HOME",
        ],
        adb_shell(
            prefix,
            args.timeout_seconds,
            "cmd",
            "package",
            "resolve-activity",
            "--brief",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.HOME",
        ),
    )
    activity_dump = record(
        prefix + ["shell", "dumpsys", "activity", "activities"],
        adb_shell(prefix, args.timeout_seconds, "dumpsys", "activity", "activities"),
    )
    window_dump = record(
        prefix + ["shell", "dumpsys", "window"],
        adb_shell(prefix, args.timeout_seconds, "dumpsys", "window"),
    )
    service_dump = record(
        prefix + ["shell", "dumpsys", "activity", "services", args.package],
        adb_shell(prefix, args.timeout_seconds, "dumpsys", "activity", "services", args.package),
    )
    pid_probe = record(
        prefix + ["shell", "pidof", args.package],
        adb_shell(prefix, args.timeout_seconds, "pidof", args.package),
    )
    forward_probe = record(
        prefix + ["forward", f"tcp:{args.host_port}", f"tcp:{args.agent_port}"],
        run(
            prefix + ["forward", f"tcp:{args.host_port}", f"tcp:{args.agent_port}"],
            args.timeout_seconds,
        ),
    )
    logcat_probe = record(
        prefix + ["shell", "logcat", "-d", "-b", "all"],
        adb_shell(prefix, args.timeout_seconds, "logcat", "-d", "-b", "all"),
    )

    args.logcat.parent.mkdir(parents=True, exist_ok=True)
    args.logcat.write_text(logcat_probe.output, encoding="utf-8")

    health_url = f"http://127.0.0.1:{args.host_port}/api/health"
    health_http, health_ready, health_body = (
        http_health(health_url, args.timeout_seconds)
        if forward_probe.ok
        else (0, False, forward_probe.output)
    )
    roles = role_holders(
        prefix,
        args.timeout_seconds,
        (
            "android.app.role.HOME",
            "android.app.role.ASSISTANT",
            "android.app.role.BROWSER",
            "android.app.role.SMS",
            "android.app.role.DIALER",
        ),
    )
    foreground = extract_foreground(activity_dump.output, window_dump.output)
    logcat = logcat_probe.output
    package_scan_excerpt = matching_lines(
        logcat,
        (
            "Eliza",
            args.package,
            "PackageManager",
            "PackageParsing",
            "Failed to parse",
            "INSTALL_FAILED",
        ),
    )
    fatal_count = count_lines(
        logcat, ("FATAL EXCEPTION", "signal 11 (SIGSEGV)", "--------- beginning of crash")
    )
    avc_count = count_lines(logcat, ("avc: denied",))
    try:
        service_pid = int(last_line(pid_probe).split()[0])
    except (ValueError, IndexError):
        service_pid = 0

    write_transcript(args.transcript, commands, health_body)

    cpu_abi_value = last_line(cpu_abi)
    required = {
        "sys_boot_completed": last_line(boot) == "1",
        f"cpu_abi_{args.expected_cpu_abi}": cpu_abi_value == args.expected_cpu_abi,
        "system_privapp_apk_present": system_apk.ok and args.system_apk_path in system_apk.output,
        "package_installed": last_line(pm_path).startswith("package:"),
        "home_resolves_to_package": args.package in home_resolve.output,
        "foreground_is_package": args.package in foreground,
        "role_holders_include_package": args.package in json.dumps(roles, sort_keys=True),
        "service_component_recorded": bool(args.service),
        "service_process_running": service_pid > 0 and args.package in service_dump.output,
        "adb_forward_ready": forward_probe.ok,
        "agent_health_http_200": health_http == 200,
        "agent_health_ready": health_ready,
        "fatal_crash_count_zero": fatal_count == 0,
        "selinux_denial_count_zero": avc_count == 0,
    }
    missing = sorted(name for name, ok in required.items() if not ok)
    status = "PASS" if not missing else "BLOCKED"

    report: dict[str, object] = {
        "schema": SCHEMA,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": status,
        "result": 0 if status == "PASS" else 2,
        "target_label": args.target_label,
        "started_utc": started,
        "ended_utc": utc_now(),
        "adb_serial": selected_serial or "default",
        "device": {
            "sys_boot_completed": last_line(boot),
            "cpu_abi": last_line(cpu_abi),
            "cpu_abilist": last_line(cpu_abilist),
            "uname_m": last_line(uname_m),
            "build_id": last_line(build_id),
            "sdk": last_line(sdk),
        },
        "app": {
            "package_name": args.package,
            "system_apk_path": args.system_apk_path,
            "system_apk_present": "present"
            if system_apk.ok and args.system_apk_path in system_apk.output
            else "missing",
            "system_apk_probe": system_apk.output.strip(),
            "permission_file_probes": permission_file_probes,
            "permission_file_symlink_targets": permission_file_symlink_targets,
            "pm_list_eliza": package_list_eliza.output.strip(),
            "pm_path": last_line(pm_path),
            "role_holders": roles,
            "home_resolve_activity": home_resolve.output.strip(),
            "foreground_activity": foreground,
            "service_component": args.service,
            "service_pid": service_pid,
        },
        "agent": {
            "health_url": health_url,
            "health_http": health_http,
            "health_ready": health_ready,
        },
        "logs": {
            "logcat_path": rel(args.logcat),
            "fatal_crash_count": fatal_count,
            "avc_denial_count": avc_count,
            "package_scan_excerpt": package_scan_excerpt,
        },
        "artifacts": {
            "transcript_path": rel(args.transcript),
        },
        "observations": {
            "adb_devices": adb_devices.output.strip(),
            "adb_get_state": adb_state.output.strip(),
            "adb_get_state_available": adb_state.ok,
            "host_runtime": host_runtime,
            "required": required,
            "missing_or_false": missing,
            "next_operator_commands": [
                AOSP_BUILD_ONLY_COMMAND,
                AOSP_FULL_RUNTIME_COMMAND,
                "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py",
                "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
            ],
        },
    }
    if args.artifact_id:
        report["artifact_id"] = args.artifact_id
    return report


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
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--service", default=DEFAULT_SERVICE)
    parser.add_argument("--system-apk-path", default=DEFAULT_SYSTEM_APK)
    parser.add_argument("--agent-port", type=int, default=31337)
    parser.add_argument("--host-port", type=int, default=31337)
    parser.add_argument(
        "--expected-cpu-abi",
        default="riscv64",
        help="expected ro.product.cpu.abi for this release target",
    )
    parser.add_argument(
        "--artifact-id",
        help="release manifest artifact id when writing target-specific release evidence",
    )
    parser.add_argument(
        "--target-label",
        default="chip-riscv64",
        help="human-readable release target label recorded in evidence for stale/cross-target checks",
    )
    parser.add_argument("--timeout-seconds", type=int, default=30)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--logcat", type=Path, default=DEFAULT_LOGCAT)
    parser.add_argument("--transcript", type=Path, default=DEFAULT_TRANSCRIPT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    for attr in ("output", "logcat", "transcript"):
        value = getattr(args, attr)
        if not value.is_absolute():
            setattr(args, attr, ROOT / value)
    report = build_report(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{report['status']}: android.launcher_runtime ({rel(args.output)})")
    if report["status"] != "PASS":
        missing = report.get("observations", {}).get("missing_or_false", [])
        print("missing_or_false=" + ",".join(str(item) for item in missing))
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
