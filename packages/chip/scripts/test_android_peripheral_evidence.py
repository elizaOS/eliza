#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/android/capture_simulated_peripheral_evidence.py"
DEFAULT_PROBE_DIR = ROOT / "sw/aosp-device/peripherals"
SCRIPT_DIR = ROOT / "scripts" / "android"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_simulated_peripheral_evidence as capture  # noqa: E402


def run_capture(
    components: list[str], out_dir: Path, env_overrides: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["ELIZA_ANDROID_PERIPHERAL_OUT_DIR"] = str(out_dir)
    if env_overrides is None:
        env_overrides = {}
    # Ensure no inherited ELIZA_*_SIM_COMMAND values leak into the subprocess
    # so the default-resolution path is deterministic.
    for spec_env in (
        "ELIZA_REAR_CAMERA_SIM_COMMAND",
        "ELIZA_FRONT_CAMERA_SIM_COMMAND",
        "ELIZA_MICROPHONE_SIM_COMMAND",
        "ELIZA_SPEAKERS_SIM_COMMAND",
        "ELIZA_WIFI_SIM_COMMAND",
        "ELIZA_BLUETOOTH_SIM_COMMAND",
        "ELIZA_CELLULAR_5G_LTE_SIM_COMMAND",
    ):
        env.pop(spec_env, None)
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *components],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_empty_env_var_writes_blocked_log() -> None:
    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        result = run_capture(["wifi"], out_dir, {"ELIZA_WIFI_SIM_COMMAND": ""})
        if result.returncode != 2:
            raise AssertionError(f"expected blocked return code, got {result.returncode}")
        text = (out_dir / "wifi_sim.log").read_text(encoding="utf-8")
        for marker in (
            "eliza-evidence: status=BLOCKED",
            "RESULT=2",
            "ELIZA_WIFI_SIM_COMMAND is set to an empty value",
        ):
            if marker not in text:
                raise AssertionError(f"blocked log missing marker {marker!r}:\n{text}")


def test_unset_env_var_resolves_to_default_probe() -> None:
    """When the env var is unset, the capture script must invoke the canonical
    default probe script. We only assert the resolved command points at the
    bundled probe — the PASS/FAIL outcome depends on whether the host has a
    connected Cuttlefish device, which is not a precondition of this test."""
    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        run_capture(["wifi"], out_dir)
        text = (out_dir / "wifi_sim.log").read_text(encoding="utf-8")
        expected_probe = (DEFAULT_PROBE_DIR / "probe-wifi.sh").as_posix()
        if expected_probe not in text:
            raise AssertionError(
                f"default-probe path missing from log; expected {expected_probe!r}:\n{text}"
            )
        if "command_env=ELIZA_WIFI_SIM_COMMAND" not in text:
            raise AssertionError(f"expected env-var label in log:\n{text[:500]}")


def test_component_pass_requires_command_markers() -> None:
    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        command = (
            "printf '%s\\n' 'COMPONENT=wifi' 'IP_CONNECTIVITY=pass' 'ANDROID_DUMPSYS_WIFI=pass'"
        )
        result = run_capture(["wifi"], out_dir, {"ELIZA_WIFI_SIM_COMMAND": command})
        if result.returncode != 0:
            raise AssertionError(f"expected pass return code, got {result.returncode}")
        text = (out_dir / "wifi_sim.log").read_text(encoding="utf-8")
        for marker in (
            "eliza-evidence: status=PASS",
            "RESULT=0",
            "COMPONENT=wifi",
            "IP_CONNECTIVITY=pass",
            "ANDROID_DUMPSYS_WIFI=pass",
        ):
            if marker not in text:
                raise AssertionError(f"pass log missing marker {marker!r}:\n{text}")


def test_probe_exit_two_writes_blocked_log() -> None:
    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        command = "printf '%s\\n' 'PROBE_ERROR=adb device unavailable'; exit 2"
        result = run_capture(["wifi"], out_dir, {"ELIZA_WIFI_SIM_COMMAND": command})
        if result.returncode != 2:
            raise AssertionError(f"expected blocked return code, got {result.returncode}")
        text = (out_dir / "wifi_sim.log").read_text(encoding="utf-8")
        for marker in (
            "eliza-evidence: status=BLOCKED",
            "RESULT=2",
            "PROBE_ERROR=adb device unavailable",
        ):
            if marker not in text:
                raise AssertionError(f"blocked probe log missing marker {marker!r}:\n{text}")


def test_env_override_wins_over_default_probe() -> None:
    """Operator-supplied env command must override the default probe even when
    the default probe script exists on disk."""
    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        command = (
            "printf '%s\\n' 'COMPONENT=bluetooth' 'HCI_ATTACH=pass' 'BLE_SCAN=pass' "
            "'OPERATOR_OVERRIDE=true'"
        )
        result = run_capture(["bluetooth"], out_dir, {"ELIZA_BLUETOOTH_SIM_COMMAND": command})
        if result.returncode != 0:
            raise AssertionError(f"expected pass return code, got {result.returncode}")
        text = (out_dir / "bluetooth_sim.log").read_text(encoding="utf-8")
        if "OPERATOR_OVERRIDE=true" not in text:
            raise AssertionError(f"operator override not honored:\n{text}")
        if "probe-bluetooth.sh" in text:
            raise AssertionError(f"default probe ran instead of override:\n{text}")


def test_all_default_probes_exist_and_are_syntactically_valid() -> None:
    """Every spec must point at a probe script that exists, is executable, and
    passes `bash -n`."""
    probes = (
        "probe-rear-camera.sh",
        "probe-front-camera.sh",
        "probe-microphone.sh",
        "probe-speakers.sh",
        "probe-wifi.sh",
        "probe-bluetooth.sh",
        "probe-cellular-5g.sh",
    )
    for probe in probes:
        path = DEFAULT_PROBE_DIR / probe
        if not path.is_file():
            raise AssertionError(f"missing probe script: {path}")
        if not os.access(path, os.X_OK):
            raise AssertionError(f"probe script not executable: {path}")
        rc = subprocess.run(["bash", "-n", str(path)], check=False).returncode
        if rc != 0:
            raise AssertionError(f"bash -n failed for {path}")


def test_speaker_tone_fixture_is_valid_wav() -> None:
    fixture = DEFAULT_PROBE_DIR / "fixtures/tone-440hz.wav"
    if not fixture.is_file():
        raise AssertionError(f"missing tone fixture: {fixture}")
    header = fixture.read_bytes()[:12]
    if not (header[:4] == b"RIFF" and header[8:12] == b"WAVE"):
        raise AssertionError(f"tone fixture is not a RIFF/WAVE file: {header!r}")


def test_prepare_adb_connects_when_no_ready_device() -> None:
    calls: list[list[str]] = []

    def fake_run_command(args: list[str], timeout_seconds: int) -> tuple[int, str]:
        del timeout_seconds
        calls.append(args)
        if args == ["adb", "devices", "-l"] and len(calls) == 1:
            return 0, "List of devices attached\n"
        if args == ["adb", "connect", "127.0.0.1:6520"]:
            return 0, "connected to 127.0.0.1:6520\n"
        if args == ["adb", "devices", "-l"]:
            return 0, "List of devices attached\n127.0.0.1:6520 device product:cf_riscv64\n"
        return 1, "unexpected\n"

    args = type(
        "Args",
        (),
        {"adb_serial": None, "adb_connect": ["127.0.0.1:6520"], "timeout_seconds": 1},
    )()
    with mock.patch.object(capture, "run_command", side_effect=fake_run_command):
        serial = capture.prepare_adb(args)
    if serial != "127.0.0.1:6520":
        raise AssertionError(f"expected connected serial, got {serial!r}")
    if ["adb", "connect", "127.0.0.1:6520"] not in calls:
        raise AssertionError(f"adb connect was not attempted: {calls}")
    transcript = os.environ.get("ELIZA_ANDROID_PERIPHERAL_ADB_PREP", "")
    if "adb connect 127.0.0.1:6520" not in transcript:
        raise AssertionError(f"adb prep transcript did not record connect attempt: {transcript}")


if __name__ == "__main__":
    test_empty_env_var_writes_blocked_log()
    test_unset_env_var_resolves_to_default_probe()
    test_component_pass_requires_command_markers()
    test_probe_exit_two_writes_blocked_log()
    test_env_override_wins_over_default_probe()
    test_all_default_probes_exist_and_are_syntactically_valid()
    test_speaker_tone_fixture_is_valid_wav()
    test_prepare_adb_connects_when_no_ready_device()
    print("OK")
