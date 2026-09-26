#!/usr/bin/env python3
"""Boot an uncompressed mkosi disk in QEMU and emit bounded evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from mkosi_console import FORBIDDEN_MARKERS, GRAPHICAL_MARKERS, normalized_console_text
from qemu_arguments import qemu_guest_arguments, qemu_path_value


QEMU = {
    "amd64": "qemu-system-x86_64",
    "arm64": "qemu-system-aarch64",
    "riscv64": "qemu-system-riscv64",
}
LINUX_MACHINES = {
    "amd64": "q35,accel=kvm:tcg",
    "arm64": "virt,accel=kvm:tcg,gic-version=max",
    "riscv64": "virt,accel=kvm:tcg",
}
RECOVERY_MARKERS = (
    "Linux version",
    "elizaOS recovery boundary verified: Eliza agent and privileged broker unavailable",
)
SCHEMA = "ai.elizaos.mkosi-qemu-evidence.v1"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_evidence(path: Path, document: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(json.dumps(document, indent=2, sort_keys=True) + "\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.link(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def send_recovery_hotkey(monitor_socket: Path) -> bool:
    """Send the recovery hotkey through QEMU's keyboard monitor boundary."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.2)
            connection.connect(str(monitor_socket))
            connection.sendall(b"sendkey r\n")
        return True
    except OSError:
        return False


def capture_screenshot(monitor_socket: Path, output: Path) -> None:
    """Capture the VM framebuffer through QEMU's monitor, not the host desktop."""
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"screenshot already exists: {output}")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(monitor_socket))
        def wait_for_prompt() -> None:
            response = b""
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                chunk = connection.recv(4096)
                if not chunk:
                    raise RuntimeError("QEMU closed the framebuffer monitor")
                response += chunk
                if b"(qemu) " in response:
                    return
            raise RuntimeError("QEMU framebuffer monitor did not finish its command")

        wait_for_prompt()
        command = f"screendump {json.dumps(str(output.resolve()))}\n"
        connection.sendall(command.encode("utf-8"))
        wait_for_prompt()
        if output.is_file() and output.stat().st_size > 0:
            return
    raise RuntimeError("QEMU did not produce the requested framebuffer screenshot")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--architecture", choices=sorted(QEMU), required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--boot-mode", choices=("graphical", "recovery"), default="graphical")
    parser.add_argument("--firmware-mode", choices=("pflash", "bios"), default="pflash")
    parser.add_argument("--firmware-code", type=Path)
    parser.add_argument("--firmware-vars", type=Path)
    parser.add_argument("--bios", type=Path, help="one combined firmware image for bios mode")
    parser.add_argument("--cpu", help="override the portable CPU model (or host under HVF)")
    parser.add_argument("--disk-interface", choices=("usb", "virtio"), default="usb")
    parser.add_argument("--transcript", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--screenshot", type=Path, help="save the VM framebuffer as PPM before stopping it")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--memory-mib", type=int, default=4096)
    parser.add_argument("--cpus", type=int, default=4)
    parser.add_argument("--required-marker", action="append", dest="markers")
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()
    default_markers = (
        RECOVERY_MARKERS if args.boot_mode == "recovery" else GRAPHICAL_MARKERS
    )
    markers = tuple((*default_markers, *(args.markers or ())))
    forbidden_markers = (
        (*FORBIDDEN_MARKERS, *GRAPHICAL_MARKERS[1:])
        if args.boot_mode == "recovery"
        else FORBIDDEN_MARKERS
    )
    started = time.monotonic()
    selection_attempts = 0
    errors: list[str] = []
    document: dict[str, object] = {
        "schema": SCHEMA,
        "claimBoundary": (
            "qemu_recovery_selection_and_service_unavailability_only_no_repair_or_hardware_claim"
            if args.boot_mode == "recovery"
            else "qemu_graphical_target_only_no_login_agent_computer_control_or_hardware_claim"
        ),
        "architecture": args.architecture,
        "bootMode": args.boot_mode,
        "host": {"system": platform.system(), "machine": platform.machine()},
        "startedAt": now(),
        "completedAt": None,
        "durationSeconds": None,
        "preflightOnly": args.preflight_only,
        "diskInterface": args.disk_interface,
        "firmwareMode": args.firmware_mode,
        "requiredMarkers": list(markers),
        "markersFound": [],
        "forbiddenMarkersFound": [],
        "success": False,
        "errors": errors,
        "command": None,
        "returnCode": None,
        "selectionMethod": "grub-hotkey-r" if args.boot_mode == "recovery" else "firmware-default",
        "selectionAttempts": 0,
    }

    host_system = platform.system()
    host_machine = platform.machine().lower()
    if host_system == "Linux":
        machine = LINUX_MACHINES[args.architecture]
        acceleration = "kvm-with-tcg-fallback"
    elif host_system == "Darwin" and host_machine in ("arm64", "aarch64") and args.architecture == "arm64":
        machine = "virt,accel=hvf,gic-version=max"
        acceleration = "hvf"
    else:
        machine = LINUX_MACHINES[args.architecture]
        acceleration = "unsupported"
        errors.append(
            "QEMU qualification requires Linux, or native arm64 on Apple Silicon with HVF"
        )
    document["acceleration"] = acceleration
    document["machine"] = machine
    qemu = shutil.which(QEMU[args.architecture])
    if not qemu:
        errors.append(f"required emulator is not on PATH: {QEMU[args.architecture]}")
    else:
        version = subprocess.run(
            [qemu, "--version"],
            text=True,
            capture_output=True,
            check=False,
        )
        version_line = version.stdout.splitlines()[0].strip() if version.stdout else ""
        if version.returncode != 0 or not version_line:
            errors.append(f"cannot determine emulator version: {qemu}")
        else:
            document["emulator"] = {
                "path": str(Path(qemu).resolve()),
                "version": version_line,
            }
    required_paths: list[tuple[str, Path | None]] = [("image", args.image)]
    if args.firmware_mode == "pflash":
        required_paths.extend(
            (("firmware code", args.firmware_code), ("firmware variables template", args.firmware_vars))
        )
        if args.bios:
            errors.append("--bios cannot be combined with pflash firmware mode")
    else:
        required_paths.append(("combined BIOS firmware", args.bios))
        if args.firmware_code or args.firmware_vars:
            errors.append("--firmware-code/--firmware-vars cannot be combined with bios firmware mode")
    for label, path in required_paths:
        if path is None:
            errors.append(f"{label} is required for {args.firmware_mode} firmware mode")
            continue
        if not path.is_file() or path.is_symlink():
            errors.append(f"{label} is missing, not regular, or a symlink: {path}")
    if args.image.suffix in (".zst", ".xz", ".gz"):
        errors.append("QEMU qualification requires an explicitly decompressed raw disk")
    if args.timeout < 30 or args.memory_mib < 1024 or args.cpus < 1:
        errors.append("timeout must be >=30s, memory >=1024 MiB, and CPUs >=1")
    if any(not marker.strip() for marker in markers) or len(set(markers)) != len(markers):
        errors.append("required QEMU markers must be nonempty and unique")

    if errors or args.preflight_only:
        document["success"] = not errors
    else:
        args.transcript.parent.mkdir(parents=True, exist_ok=True)
        image_digest_before = sha256_file(args.image)
        with tempfile.TemporaryDirectory(prefix="elizaos-qemu-") as temporary:
            command = [
                qemu,
                "-machine", machine,
                "-m", str(args.memory_mib),
                "-smp", str(args.cpus),
                "-display", "none",
                "-serial", "stdio",
                "-no-reboot",
                "-snapshot",
            ]
            monitor_socket: Path | None = None
            if args.boot_mode == "recovery" or args.screenshot:
                monitor_socket = Path(temporary) / "monitor.sock"
                command.extend(
                    ("-monitor", f"unix:{qemu_path_value(monitor_socket)},server=on,wait=off")
                )
            else:
                command.extend(("-monitor", "none"))
            command.extend(qemu_guest_arguments(
                args.architecture, args.cpu or ("host" if acceleration == "hvf" else None)))
            if args.firmware_mode == "pflash":
                assert args.firmware_code is not None and args.firmware_vars is not None
                vars_copy = Path(temporary) / "firmware-vars.fd"
                shutil.copyfile(args.firmware_vars, vars_copy)
                command.extend(
                    (
                        "-drive", f"if=pflash,format=raw,readonly=on,file={qemu_path_value(args.firmware_code)}",
                        "-drive", f"if=pflash,format=raw,file={qemu_path_value(vars_copy)}",
                    )
                )
            else:
                assert args.bios is not None
                command.extend(("-bios", str(args.bios.resolve())))
            if args.disk_interface == "usb":
                command.extend(
                    (
                        "-drive", f"if=none,id=elizaosdisk,format=raw,file={qemu_path_value(args.image)}",
                        "-device", "qemu-xhci,id=elizaos-xhci",
                        "-device", "usb-storage,bus=elizaos-xhci.0,drive=elizaosdisk,removable=true,bootindex=1",
                    )
                )
            else:
                command.extend(
                    ("-drive", f"if=virtio,format=raw,file={qemu_path_value(args.image)}")
                )
            document["command"] = command
            with args.transcript.open("wb") as transcript:
                termination_reason = "launch-failed"
                try:
                    process = subprocess.Popen(
                        command,
                        stdin=subprocess.DEVNULL,
                        stdout=transcript,
                        stderr=subprocess.STDOUT,
                    )
                except OSError as exc:
                    errors.append(f"QEMU launch failed: {exc}")
                    process = None
                if process is not None:
                    try:
                        deadline = time.monotonic() + args.timeout
                        termination_reason = "qemu-exit"
                        while process.poll() is None:
                            if time.monotonic() >= deadline:
                                termination_reason = "timeout"
                                break
                            if (
                                args.boot_mode == "recovery"
                                and monitor_socket is not None
                                and send_recovery_hotkey(monitor_socket)
                            ):
                                selection_attempts += 1
                                document["selectionAttempts"] = selection_attempts
                            time.sleep(0.25 if args.boot_mode == "recovery" else 1)
                            text = normalized_console_text(
                                args.transcript.read_text(encoding="utf-8", errors="replace")
                            )
                            if any(marker in text for marker in forbidden_markers):
                                termination_reason = "forbidden-marker"
                                break
                            if all(marker in text for marker in markers):
                                termination_reason = "required-markers"
                                break
                        if process.poll() is None:
                            if args.screenshot and monitor_socket is not None:
                                try:
                                    capture_screenshot(monitor_socket, args.screenshot)
                                    document["screenshot"] = {
                                        "path": str(args.screenshot.resolve()),
                                        "sha256": sha256_file(args.screenshot),
                                        "size": args.screenshot.stat().st_size,
                                    }
                                except (OSError, RuntimeError) as exc:
                                    errors.append(f"QEMU screenshot failed: {exc}")
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=10)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
                    document["returnCode"] = process.returncode
                document["terminationReason"] = termination_reason

        transcript_text = normalized_console_text(
            args.transcript.read_text(encoding="utf-8", errors="replace")
        )
        found = [marker for marker in markers if marker in transcript_text]
        forbidden = [marker for marker in forbidden_markers if marker in transcript_text]
        document["markersFound"] = found
        document["forbiddenMarkersFound"] = forbidden
        if len(found) != len(markers):
            errors.append("QEMU transcript is missing one or more required boot markers")
        if args.boot_mode == "recovery" and selection_attempts < 1:
            errors.append("QEMU recovery hotkey was never accepted by the monitor")
        if document.get("terminationReason") != "required-markers":
            errors.append("QEMU did not reach markers under harness control")
        if forbidden:
            errors.append("QEMU transcript contains a forbidden boot-failure marker")
        image_digest_after = sha256_file(args.image)
        if image_digest_after != image_digest_before:
            errors.append("QEMU changed the source disk despite snapshot mode")
        document["inputs"] = {
            "image": {"path": str(args.image.resolve()), "sha256": image_digest_before, "size": args.image.stat().st_size},
        }
        if args.firmware_mode == "pflash":
            assert args.firmware_code is not None and args.firmware_vars is not None
            document["inputs"]["firmwareCode"] = {  # type: ignore[index]
                "path": str(args.firmware_code.resolve()), "sha256": sha256_file(args.firmware_code)
            }
            document["inputs"]["firmwareVarsTemplate"] = {  # type: ignore[index]
                "path": str(args.firmware_vars.resolve()), "sha256": sha256_file(args.firmware_vars)
            }
        else:
            assert args.bios is not None
            document["inputs"]["bios"] = {  # type: ignore[index]
                "path": str(args.bios.resolve()), "sha256": sha256_file(args.bios)
            }
        document["transcript"] = {
            "path": str(args.transcript.resolve()),
            "sha256": sha256_file(args.transcript),
            "size": args.transcript.stat().st_size,
        }
        document["success"] = not errors

    document["completedAt"] = now()
    document["durationSeconds"] = round(time.monotonic() - started, 3)
    try:
        write_evidence(args.evidence, document)
    except OSError as exc:
        print(f"[mkosi-qemu] evidence publication failed: {exc}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(f"[mkosi-qemu] {error}", file=sys.stderr)
        return 1
    if args.preflight_only:
        print("[mkosi-qemu] Linux host prerequisites satisfied")
    else:
        print(f"[mkosi-qemu] evidence: {args.evidence}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
