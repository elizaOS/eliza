#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/android/capture_simulated_peripheral_evidence.py"


def run_capture(
    components: list[str], out_dir: Path, env_overrides: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["ELIZA_ANDROID_PERIPHERAL_OUT_DIR"] = str(out_dir)
    if env_overrides:
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


def test_unconfigured_component_writes_blocked_log() -> None:
    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        result = run_capture(["wifi"], out_dir)
        if result.returncode != 2:
            raise AssertionError(f"expected blocked return code, got {result.returncode}")
        text = (out_dir / "wifi_sim.log").read_text(encoding="utf-8")
        for marker in (
            "eliza-evidence: status=BLOCKED",
            "RESULT=2",
            "ELIZA_WIFI_SIM_COMMAND is unset",
        ):
            if marker not in text:
                raise AssertionError(f"blocked log missing marker {marker!r}:\n{text}")


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


if __name__ == "__main__":
    test_unconfigured_component_writes_blocked_log()
    test_component_pass_requires_command_markers()
