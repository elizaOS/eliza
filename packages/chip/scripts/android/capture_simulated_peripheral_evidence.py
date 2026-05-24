#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PROBE_DIR = ROOT / "sw/aosp-device/peripherals"


def configured_out_dir() -> Path:
    raw = os.environ.get("ELIZA_ANDROID_PERIPHERAL_OUT_DIR")
    if not raw:
        return ROOT / "docs/evidence/android/peripherals"
    path = Path(raw)
    return path if path.is_absolute() else ROOT / path


@dataclass(frozen=True)
class PeripheralSpec:
    component: str
    env_var: str
    log_name: str
    markers: tuple[str, ...]
    default_probe: str


def _probe(relpath: str) -> str:
    """Return the shell command that runs a canonical probe script."""
    return f'"{(DEFAULT_PROBE_DIR / relpath).as_posix()}"'


SPECS = (
    PeripheralSpec(
        component="rear_camera",
        env_var="ELIZA_REAR_CAMERA_SIM_COMMAND",
        log_name="rear_camera_sim.log",
        markers=("COMPONENT=rear_camera", "FRAME_SOURCE=simulated_sensor", "CAPTURE_COUNT=2"),
        default_probe=_probe("probe-rear-camera.sh"),
    ),
    PeripheralSpec(
        component="front_camera",
        env_var="ELIZA_FRONT_CAMERA_SIM_COMMAND",
        log_name="front_camera_sim.log",
        markers=("COMPONENT=front_camera", "FRAME_SOURCE=simulated_sensor", "CAPTURE_COUNT=2"),
        default_probe=_probe("probe-front-camera.sh"),
    ),
    PeripheralSpec(
        component="microphone",
        env_var="ELIZA_MICROPHONE_SIM_COMMAND",
        log_name="microphone_input_sim.log",
        markers=("COMPONENT=microphone", "AUDIO_CAPTURE=pcm_s16le", "INPUT_RMS_DBFS="),
        default_probe=_probe("probe-microphone.sh"),
    ),
    PeripheralSpec(
        component="speakers",
        env_var="ELIZA_SPEAKERS_SIM_COMMAND",
        log_name="speaker_output_sim.log",
        markers=("COMPONENT=speakers", "AUDIO_OUTPUT=stereo_pcm", "LOOPBACK_VERIFIED=true"),
        default_probe=_probe("probe-speakers.sh"),
    ),
    PeripheralSpec(
        component="wifi",
        env_var="ELIZA_WIFI_SIM_COMMAND",
        log_name="wifi_sim.log",
        markers=("COMPONENT=wifi", "IP_CONNECTIVITY=pass", "ANDROID_DUMPSYS_WIFI=pass"),
        default_probe=_probe("probe-wifi.sh"),
    ),
    PeripheralSpec(
        component="bluetooth",
        env_var="ELIZA_BLUETOOTH_SIM_COMMAND",
        log_name="bluetooth_sim.log",
        markers=("COMPONENT=bluetooth", "HCI_ATTACH=pass", "BLE_SCAN=pass"),
        default_probe=_probe("probe-bluetooth.sh"),
    ),
    PeripheralSpec(
        component="cellular_5g_lte",
        env_var="ELIZA_CELLULAR_5G_LTE_SIM_COMMAND",
        log_name="cellular_5g_lte_sim.log",
        markers=("COMPONENT=cellular_5g_lte", "LTE_REGISTRATION=pass", "NR5G_REGISTRATION=pass"),
        default_probe=_probe("probe-cellular-5g.sh"),
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run_shell(command: str, timeout_seconds: int) -> tuple[int, str]:
    result = subprocess.run(
        command,
        cwd=ROOT,
        shell=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=timeout_seconds,
    )
    return result.returncode, result.stdout


def run_command(args: list[str], timeout_seconds: int) -> tuple[int, str]:
    result = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=timeout_seconds,
    )
    return result.returncode, result.stdout


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


def choose_ready_serial(adb_devices_output: str) -> str | None:
    ready = [target["serial"] for target in parse_adb_targets(adb_devices_output) if target["state"] == "device"]
    return ready[0] if len(ready) == 1 else None


def prepare_adb(args: argparse.Namespace) -> str | None:
    transcript: list[str] = []
    if args.adb_serial:
        os.environ["ELIZA_ANDROID_PERIPHERAL_ADB_PREP"] = f"ADB_SERIAL={args.adb_serial}"
        return args.adb_serial
    try:
        rc, devices = run_command(["adb", "devices", "-l"], args.timeout_seconds)
        transcript.append(f"$ adb devices -l\n{devices.rstrip()}\n[rc={rc}]")
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        os.environ["ELIZA_ANDROID_PERIPHERAL_ADB_PREP"] = f"adb devices failed: {exc}"
        return None
    serial = choose_ready_serial(devices)
    if serial:
        transcript.append(f"SELECTED_ADB_SERIAL={serial}")
        os.environ["ELIZA_ANDROID_PERIPHERAL_ADB_PREP"] = "\n".join(transcript)
        return serial
    for address in args.adb_connect:
        try:
            rc, output = run_command(["adb", "connect", address], args.timeout_seconds)
            transcript.append(f"$ adb connect {address}\n{output.rstrip()}\n[rc={rc}]")
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            transcript.append(f"$ adb connect {address}\n{exc}\n[rc=blocked]")
            continue
    if not args.adb_connect:
        os.environ["ELIZA_ANDROID_PERIPHERAL_ADB_PREP"] = "\n".join(transcript)
        return None
    try:
        rc, devices = run_command(["adb", "devices", "-l"], args.timeout_seconds)
        transcript.append(f"$ adb devices -l\n{devices.rstrip()}\n[rc={rc}]")
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        transcript.append(f"adb devices after connect failed: {exc}")
        os.environ["ELIZA_ANDROID_PERIPHERAL_ADB_PREP"] = "\n".join(transcript)
        return None
    serial = choose_ready_serial(devices)
    transcript.append(f"SELECTED_ADB_SERIAL={serial or '<none>'}")
    os.environ["ELIZA_ANDROID_PERIPHERAL_ADB_PREP"] = "\n".join(transcript)
    return serial


def write_log(
    spec: PeripheralSpec,
    *,
    command: str,
    command_source: str,
    status: str,
    result: int,
    body: str,
    missing_markers: list[str],
) -> Path:
    out_dir = configured_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / spec.log_name
    lines = [
        f"eliza-evidence: target=android_simulated_peripheral component={spec.component}",
        "eliza-evidence: claim_boundary=adb-backed Android simulator peripheral evidence only",
        f"eliza-evidence: command_env={spec.env_var}",
        f"eliza-evidence: command_source={command_source}",
        f"eliza-evidence: command={command or '<unset>'}",
        f"eliza-evidence: started_utc={utc_now()}",
        f"COMPONENT={spec.component}",
        "COMMAND_OUTPUT_BEGIN",
        body.rstrip(),
        "COMMAND_OUTPUT_END",
    ]
    if missing_markers:
        lines.append("MISSING_MARKERS=" + ",".join(missing_markers))
    lines.extend(
        [
            f"eliza-evidence: ended_utc={utc_now()}",
            f"eliza-evidence: status={status}",
            f"RESULT={result}",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def resolve_command(spec: PeripheralSpec) -> tuple[str, str]:
    """Return (command, source) for the peripheral.

    Precedence:
      1. ``ELIZA_<NAME>_SIM_COMMAND`` set to a non-empty value → use it (source=env).
      2. ``ELIZA_<NAME>_SIM_COMMAND`` set to empty string → no command (source=blocked).
      3. Env var unset → fall back to the canonical default probe script (source=default).
    """
    raw = os.environ.get(spec.env_var)
    if raw is None:
        return spec.default_probe, "default"
    command = raw.strip()
    if not command:
        return "", "blocked"
    return command, "env"


def capture_one(spec: PeripheralSpec, timeout_seconds: int, dry_run: bool) -> tuple[str, Path]:
    command, source = resolve_command(spec)
    if dry_run:
        path = configured_out_dir() / spec.log_name
        return "blocked", path
    if source == "blocked":
        path = write_log(
            spec,
            command="",
            command_source=source,
            status="BLOCKED",
            result=2,
            body=(
                f"{spec.env_var} is set to an empty value; export it unset to use the default "
                f"probe script ({spec.default_probe}) or set it to a custom adb-backed command."
            ),
            missing_markers=list(spec.markers),
        )
        return "blocked", path
    try:
        result, output = run_shell(command, timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        output = stdout + f"\ncommand timed out after {timeout_seconds}s"
        path = write_log(
            spec,
            command=command,
            command_source=source,
            status="BLOCKED",
            result=124,
            body=output,
            missing_markers=list(spec.markers),
        )
        return "blocked", path
    prep = os.environ.get("ELIZA_ANDROID_PERIPHERAL_ADB_PREP", "").strip()
    if prep:
        output = f"ADB_PREP_BEGIN\n{prep}\nADB_PREP_END\n{output}"
    missing = [marker for marker in spec.markers if marker not in output]
    if result == 0 and not missing:
        status = "PASS"
    elif result == 2:
        status = "BLOCKED"
    else:
        status = "FAIL"
    path = write_log(
        spec,
        command=command,
        command_source=source,
        status=status,
        result=result,
        body=output,
        missing_markers=missing,
    )
    if status == "PASS":
        return "pass", path
    if status == "BLOCKED":
        return "blocked", path
    return "fail", path


def selected_specs(names: list[str]) -> list[PeripheralSpec]:
    by_name = {spec.component: spec for spec in SPECS}
    if not names:
        return list(SPECS)
    missing = sorted(set(names) - set(by_name))
    if missing:
        raise SystemExit("unknown component(s): " + ", ".join(missing))
    return [by_name[name] for name in names]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("components", nargs="*", help="Optional component ids to capture")
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--dry-run", action="store_true", help="List required commands only")
    parser.add_argument("--adb-serial", help="adb serial to pass to canonical probes via ADB_SERIAL")
    parser.add_argument(
        "--adb-connect",
        action="append",
        default=[],
        metavar="HOST:PORT",
        help="run `adb connect HOST:PORT` before probing when no online adb target is visible; may be repeated",
    )
    args = parser.parse_args()

    specs = selected_specs(args.components)
    selected_serial = prepare_adb(args)
    if selected_serial:
        os.environ["ADB_SERIAL"] = selected_serial
    if args.dry_run:
        for spec in specs:
            path = configured_out_dir() / spec.log_name
            command, source = resolve_command(spec)
            print(
                f"{spec.component}: source={source} command={command or '<unset>'} "
                f"env={spec.env_var} adb_serial={selected_serial or '<default>'} log={rel(path)}"
            )
            for marker in spec.markers:
                print(f"  requires: {marker}")
        return 0

    statuses: list[str] = []
    for spec in specs:
        status, path = capture_one(spec, max(1, args.timeout_seconds), args.dry_run)
        statuses.append(status)
        print(f"{spec.component}: {status} ({rel(path)})")
    if all(status == "pass" for status in statuses):
        return 0
    if any(status == "fail" for status in statuses):
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
