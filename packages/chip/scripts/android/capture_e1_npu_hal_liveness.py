#!/usr/bin/env python3
"""Capture fail-closed Android E1 NPU HAL liveness evidence from adb."""

from __future__ import annotations

import argparse
import subprocess
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log"
EXPECTED_ACCELERATOR_TOKENS = (
    "e1",
    "eliza",
    "npu",
)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def run(args: list[str], timeout_seconds: int) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            args,
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError as exc:
        return 127, str(exc)
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout or ""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        return 124, output + f"\ncommand timed out after {timeout_seconds}s"
    return completed.returncode, completed.stdout


def ready_adb_serial(adb_devices_output: str) -> str | None:
    ready: list[str] = []
    for raw in adb_devices_output.splitlines():
        fields = raw.split()
        if len(fields) >= 2 and fields[1] == "device":
            ready.append(fields[0])
    return ready[0] if len(ready) == 1 else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb-connect", help="optional adb HOST:PORT to connect first")
    parser.add_argument("--adb-serial", help="adb serial to use directly")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument(
        "--expected-accelerator-token",
        action="append",
        default=[],
        help="case-insensitive token that must appear in the neuralnetworks output; defaults to e1/eliza/npu any-match",
    )
    args = parser.parse_args()

    transcript: list[str] = []
    start = utc_now()
    if args.adb_connect:
        rc, output = run(["adb", "connect", args.adb_connect], args.timeout_seconds)
        transcript.append(f"$ adb connect {args.adb_connect}\n{output.rstrip()}\n[rc={rc}]")

    selected = args.adb_serial
    rc, devices = run(["adb", "devices", "-l"], args.timeout_seconds)
    transcript.append(f"$ adb devices -l\n{devices.rstrip()}\n[rc={rc}]")
    if not selected:
        selected = ready_adb_serial(devices)

    if selected:
        command = ["adb", "-s", selected, "shell", "cmd", "neuralnetworks", "list"]
    else:
        command = ["adb", "shell", "cmd", "neuralnetworks", "list"]
    nn_rc, nn_output = run(command, args.timeout_seconds)
    transcript.append(f"$ {' '.join(command)}\n{nn_output.rstrip()}\n[rc={nn_rc}]")

    haystack = nn_output.lower()
    expected_tokens = tuple(args.expected_accelerator_token) or EXPECTED_ACCELERATOR_TOKENS
    accelerator_present = any(token.lower() in haystack for token in expected_tokens)
    service_present = nn_rc == 0 and bool(nn_output.strip())
    adb_ready = selected is not None
    status = "PASS" if adb_ready and service_present and accelerator_present else "BLOCKED"
    result = 0 if status == "PASS" else 2

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = ROOT / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "eliza-evidence: target=android artifact=e1_npu_hal_liveness",
        "eliza-evidence: claim_boundary=adb-backed Android NPU HAL liveness only",
        f"eliza-evidence: started_utc={start}",
        f"ADB_SERIAL={selected or '<none>'}",
        f"NNAPI_SERVICE={'present' if service_present else 'missing'}",
        f"E1_NPU_ACCELERATOR={'present' if accelerator_present else 'missing'}",
        "COMMAND_OUTPUT_BEGIN",
        "\n".join(transcript).rstrip(),
        "COMMAND_OUTPUT_END",
        f"eliza-evidence: ended_utc={utc_now()}",
        f"eliza-evidence: status={status}",
        f"RESULT={result}",
    ]
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{status.lower()}: wrote {rel(output_path)}")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
