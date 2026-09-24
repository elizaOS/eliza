#!/usr/bin/env python3
"""Qualify exact-image virtual USB readback and two-boot home persistence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

QEMU = {
    "amd64": "qemu-system-x86_64",
    "arm64": "qemu-system-aarch64",
    "riscv64": "qemu-system-riscv64",
}
MACHINES = {
    "amd64": "q35,accel=kvm:tcg",
    "arm64": "virt,accel=kvm:tcg,gic-version=max",
    "riscv64": "virt,accel=kvm:tcg",
}
REQUIRED_MARKERS = (
    "Linux version",
    "Started gdm.service - GNOME Display Manager",
    "Reached target Graphical Interface",
)
FORBIDDEN_MARKERS = (
    "Kernel panic - not syncing",
    "Entering emergency mode",
    "You are in emergency mode",
    "Failed to start initrd-switch-root.service",
    "VFS: Unable to mount root fs",
    "Cannot open root device",
    "No bootable device",
    "Boot failed",
    "Dependency failed for Graphical Interface",
)
SCHEMA = "ai.elizaos.mkosi-persistence-evidence.v1"
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


class QualificationError(RuntimeError):
    pass


def normalized_console_text(text: str) -> str:
    """Remove terminal control sequences before evaluating boot markers."""
    return ANSI_ESCAPE.sub("", text).replace("\r", "")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path, limit: int | None = None) -> str:
    digest = hashlib.sha256()
    remaining = limit
    with path.open("rb", buffering=0) as stream:
        while remaining is None or remaining > 0:
            size = 1024 * 1024 if remaining is None else min(1024 * 1024, remaining)
            chunk = stream.read(size)
            if not chunk:
                break
            digest.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    if remaining not in (None, 0):
        raise QualificationError(f"short read from {path}: {remaining} bytes missing")
    return digest.hexdigest()


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        text=True,
        capture_output=capture,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise QualificationError(
            f"command failed ({result.returncode}): {' '.join(command)}"
            + (f": {detail}" if detail else "")
        )
    return result


def write_evidence(path: Path, document: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


@contextmanager
def attached_loop(image: Path) -> Iterator[Path]:
    result = run(
        ["losetup", "--find", "--show", "--partscan", "--nooverlap", str(image)],
        capture=True,
    )
    loop = Path(result.stdout.strip())
    if not re.fullmatch(r"/dev/loop[0-9]+", str(loop)):
        raise QualificationError(f"losetup returned an unsafe device: {loop}")
    created_nodes: list[Path] = []
    try:
        run(["udevadm", "settle"])
        for device_file in sorted(Path("/sys/class/block").glob(f"{loop.name}p*/dev")):
            partition_name = device_file.parent.name
            if not re.fullmatch(rf"{re.escape(loop.name)}p[0-9]+", partition_name):
                continue
            partition = Path("/dev") / partition_name
            if partition.exists():
                if not partition.is_block_device():
                    raise QualificationError(
                        f"partition path exists but is not a block device: {partition}"
                    )
                continue
            match = re.fullmatch(r"([0-9]+):([0-9]+)\n?", device_file.read_text())
            if not match:
                raise QualificationError(f"invalid device number for {partition}")
            os.mknod(
                partition,
                stat.S_IFBLK | 0o600,
                os.makedev(int(match.group(1)), int(match.group(2))),
            )
            created_nodes.append(partition)
        yield loop
    finally:
        for partition in reversed(created_nodes):
            partition.unlink(missing_ok=True)
        subprocess.run(["losetup", "--detach", str(loop)], check=False)


def home_partition(loop: Path) -> tuple[Path, int]:
    result = run(
        ["sfdisk", "--json", str(loop)],
        capture=True,
    )
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise QualificationError("sfdisk returned invalid JSON") from exc
    table = data.get("partitiontable", {})
    if not isinstance(table, dict):
        raise QualificationError("sfdisk returned no partition table")
    partitions = table.get("partitions", [])
    matches = [
        partition
        for partition in partitions
        if isinstance(partition, dict) and partition.get("name") == "elizaos-home"
    ]
    if len(matches) != 1:
        raise QualificationError(
            f"expected exactly one elizaos-home partition on {loop}; found {len(matches)}"
        )
    path = Path(str(matches[0].get("node", "")))
    size_value = matches[0].get("size")
    sector_size = table.get("sectorsize")
    try:
        size = int(size_value) * int(sector_size)
    except (TypeError, ValueError) as exc:
        raise QualificationError("elizaos-home partition size is invalid") from exc
    if (
        not re.fullmatch(rf"{re.escape(str(loop))}p[0-9]+", str(path))
        or not path.is_block_device()
        or size <= 0
    ):
        raise QualificationError("elizaos-home partition identity or size is invalid")
    filesystem = run(["blkid", "-s", "TYPE", "-o", "value", str(path)], capture=True)
    if filesystem.stdout.strip() != "ext4":
        raise QualificationError("elizaos-home must contain ext4")
    return path, size


def ext4_size(partition: Path) -> int:
    result = run(["dumpe2fs", "-h", str(partition)], capture=True)
    fields: dict[str, int] = {}
    for line in result.stdout.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key in {"Block count", "Block size"}:
            try:
                fields[key] = int(value.strip())
            except ValueError as exc:
                raise QualificationError(f"invalid ext4 {key.lower()}") from exc
    if set(fields) != {"Block count", "Block size"}:
        raise QualificationError("cannot determine ext4 filesystem size")
    return fields["Block count"] * fields["Block size"]


@contextmanager
def mounted_home(partition: Path, *, read_only: bool) -> Iterator[Path]:
    mountpoint = Path(tempfile.mkdtemp(prefix="elizaos-persistence-mount-"))
    options = "ro,noload,nodev,nosuid" if read_only else "rw,nodev,nosuid"
    try:
        run(["mount", "--types", "ext4", "--options", options, str(partition), str(mountpoint)])
        yield mountpoint
    finally:
        subprocess.run(["umount", str(mountpoint)], check=False)
        mountpoint.rmdir()


def qemu_command(
    args: argparse.Namespace,
    qemu: str,
    firmware_vars: Path | None,
) -> list[str]:
    command = [
        qemu,
        "-machine", MACHINES[args.architecture],
        "-m", str(args.memory_mib),
        "-smp", str(args.cpus),
        "-display", "none",
        "-monitor", "none",
        "-serial", "stdio",
        "-no-reboot",
    ]
    if args.cpu:
        command.extend(("-cpu", args.cpu))
    if args.firmware_mode == "pflash":
        assert args.firmware_code is not None and firmware_vars is not None
        command.extend(
            (
                "-drive", f"if=pflash,format=raw,readonly=on,file={args.firmware_code.resolve()}",
                "-drive", f"if=pflash,format=raw,file={firmware_vars.resolve()}",
            )
        )
    else:
        assert args.bios is not None
        command.extend(("-bios", str(args.bios.resolve())))
    command.extend(
        (
            "-drive", f"if=none,id=elizaosdisk,format=raw,file={args.work_image.resolve()}",
            "-device", "qemu-xhci,id=elizaos-xhci",
            "-device", "usb-storage,bus=elizaos-xhci.0,drive=elizaosdisk,removable=true,bootindex=1",
        )
    )
    return command


def boot(command: list[str], transcript: Path, timeout: int) -> dict[str, object]:
    transcript.parent.mkdir(parents=True, exist_ok=True)
    with transcript.open("wb") as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + timeout
        reason = "qemu-exit"
        while process.poll() is None:
            if time.monotonic() >= deadline:
                reason = "timeout"
                break
            time.sleep(1)
            text = normalized_console_text(
                transcript.read_text(encoding="utf-8", errors="replace")
            )
            if any(marker in text for marker in FORBIDDEN_MARKERS):
                reason = "forbidden-marker"
                break
            if all(marker in text for marker in REQUIRED_MARKERS):
                reason = "required-markers"
                break
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    text = normalized_console_text(
        transcript.read_text(encoding="utf-8", errors="replace")
    )
    found = [marker for marker in REQUIRED_MARKERS if marker in text]
    forbidden = [marker for marker in FORBIDDEN_MARKERS if marker in text]
    if reason != "required-markers" or len(found) != len(REQUIRED_MARKERS) or forbidden:
        raise QualificationError(
            f"QEMU boot failed: reason={reason}, missing={set(REQUIRED_MARKERS) - set(found)}, forbidden={forbidden}"
        )
    return {
        "terminationReason": reason,
        "returnCode": process.returncode,
        "markersFound": found,
        "forbiddenMarkersFound": forbidden,
        "transcript": {
            "path": str(transcript.resolve()),
            "size": transcript.stat().st_size,
            "sha256": sha256_file(transcript),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--architecture", choices=sorted(QEMU), required=True)
    parser.add_argument("--source-image", type=Path, required=True)
    parser.add_argument("--work-image", type=Path, required=True)
    parser.add_argument("--transcript-directory", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--firmware-mode", choices=("pflash", "bios"), default="pflash")
    parser.add_argument("--firmware-code", type=Path)
    parser.add_argument("--firmware-vars", type=Path)
    parser.add_argument("--bios", type=Path)
    parser.add_argument("--cpu")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--memory-mib", type=int, default=4096)
    parser.add_argument("--cpus", type=int, default=4)
    parser.add_argument("--extra-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()

    started = time.monotonic()
    errors: list[str] = []
    document: dict[str, object] = {
        "schema": SCHEMA,
        "claimBoundary": "virtual_usb_write_readback_and_two_boot_home_persistence_no_installer_desktop_or_physical_hardware_claim",
        "architecture": args.architecture,
        "host": {"system": platform.system(), "machine": platform.machine()},
        "startedAt": now(),
        "completedAt": None,
        "durationSeconds": None,
        "preflightOnly": args.preflight_only,
        "success": False,
        "errors": errors,
    }

    qemu = shutil.which(QEMU[args.architecture])
    required_commands = ("losetup", "udevadm", "sfdisk", "blkid", "dumpe2fs", "mount", "umount", "dd")
    if platform.system() != "Linux":
        errors.append("persistence qualification requires Linux")
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        errors.append("persistence qualification requires root")
    if not qemu:
        errors.append(f"required emulator is unavailable: {QEMU[args.architecture]}")
    for command in required_commands:
        if not shutil.which(command):
            errors.append(f"required command is unavailable: {command}")
    if not args.source_image.is_file() or args.source_image.is_symlink():
        errors.append("source image must be a regular non-symlink file")
    if args.source_image.suffix in {".zst", ".xz", ".gz"}:
        errors.append("source image must be explicitly expanded raw bytes")
    if args.work_image.exists() or args.work_image.is_symlink():
        errors.append("work image must not already exist")
    if args.work_image.resolve() == args.source_image.resolve():
        errors.append("work image must be distinct from the immutable source image")
    if args.extra_bytes < 1024 * 1024 * 1024:
        errors.append("at least 1 GiB of virtual USB expansion is required")
    if args.timeout < 30 or args.memory_mib < 1024 or args.cpus < 1:
        errors.append("timeout must be >=30s, memory >=1024 MiB, and CPUs >=1")
    firmware_paths: list[Path | None]
    if args.firmware_mode == "pflash":
        firmware_paths = [args.firmware_code, args.firmware_vars]
        if args.bios:
            errors.append("--bios cannot be combined with pflash mode")
    else:
        firmware_paths = [args.bios]
        if args.firmware_code or args.firmware_vars:
            errors.append("pflash files cannot be combined with bios mode")
    for firmware in firmware_paths:
        if firmware is None or not firmware.is_file() or firmware.is_symlink():
            errors.append(f"firmware input is missing, linked, or not regular: {firmware}")

    try:
        if not errors and not args.preflight_only:
            source_size = args.source_image.stat().st_size
            source_digest = sha256_file(args.source_image)
            args.work_image.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(args.work_image, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.ftruncate(descriptor, source_size + args.extra_bytes)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            with attached_loop(args.work_image) as loop:
                run(["dd", f"if={args.source_image}", f"of={loop}", "bs=4M", "conv=fsync", "status=none"])
                readback_digest = sha256_file(loop, source_size)
            if readback_digest != source_digest:
                raise QualificationError("virtual USB expanded-byte readback digest mismatch")

            with attached_loop(args.work_image) as loop:
                home, home_partition_before = home_partition(loop)
                home_filesystem_before = ext4_size(home)

            boots: list[dict[str, object]] = []
            with tempfile.TemporaryDirectory(prefix="elizaos-persistence-firmware-") as temporary:
                firmware_vars: Path | None = None
                if args.firmware_mode == "pflash":
                    assert args.firmware_vars is not None
                    firmware_vars = Path(temporary) / "VARS.fd"
                    shutil.copyfile(args.firmware_vars, firmware_vars)
                command = qemu_command(args, qemu or QEMU[args.architecture], firmware_vars)
                boots.append(boot(command, args.transcript_directory / "boot-1.log", args.timeout))

                with attached_loop(args.work_image) as loop:
                    home, home_partition_after = home_partition(loop)
                    home_filesystem_after = ext4_size(home)
                    if home_partition_after <= home_partition_before:
                        raise QualificationError("home partition did not grow on first boot")
                    if home_filesystem_after <= home_filesystem_before:
                        raise QualificationError("home filesystem did not grow on first boot")
                    token = f"elizaos-persistence-{uuid.uuid4().hex}\n"
                    with mounted_home(home, read_only=False) as mountpoint:
                        sentinel = mountpoint / ".elizaos-qualification" / "persistence.txt"
                        sentinel.parent.mkdir(mode=0o700, exist_ok=False)
                        sentinel.write_text(token, encoding="utf-8")
                        with sentinel.open("rb") as stream:
                            os.fsync(stream.fileno())
                        directory = os.open(sentinel.parent, os.O_RDONLY)
                        try:
                            os.fsync(directory)
                        finally:
                            os.close(directory)

                boots.append(boot(command, args.transcript_directory / "boot-2.log", args.timeout))
                with attached_loop(args.work_image) as loop:
                    home, home_partition_second = home_partition(loop)
                    home_filesystem_second = ext4_size(home)
                    with mounted_home(home, read_only=True) as mountpoint:
                        sentinel = mountpoint / ".elizaos-qualification" / "persistence.txt"
                        if sentinel.read_text(encoding="utf-8") != token:
                            raise QualificationError("home sentinel did not survive the second boot")
                if home_partition_second != home_partition_after or home_filesystem_second != home_filesystem_after:
                    raise QualificationError("home sizing changed unexpectedly on the second boot")

            document["sourceImage"] = {
                "path": str(args.source_image.resolve()),
                "size": source_size,
                "sha256": source_digest,
            }
            document["virtualUsbReadback"] = {
                "bytes": source_size,
                "sha256": readback_digest,
                "interface": "loop-block-written-then-qemu-removable-usb",
            }
            document["home"] = {
                "partitionBytesBefore": home_partition_before,
                "partitionBytesAfter": home_partition_after,
                "filesystemBytesBefore": home_filesystem_before,
                "filesystemBytesAfter": home_filesystem_after,
                "sentinelSha256": hashlib.sha256(token.encode()).hexdigest(),
                "survivedSecondBoot": True,
            }
            document["boots"] = boots
            document["success"] = True
        elif not errors:
            document["success"] = True
    except (OSError, QualificationError, subprocess.SubprocessError) as exc:
        errors.append(str(exc))

    document["completedAt"] = now()
    document["durationSeconds"] = round(time.monotonic() - started, 3)
    write_evidence(args.evidence, document)
    if errors:
        for error in errors:
            print(f"[mkosi-persistence] {error}", file=sys.stderr)
        return 1
    if args.preflight_only:
        print("[mkosi-persistence] Linux persistence prerequisites satisfied")
    else:
        print(f"[mkosi-persistence] evidence: {args.evidence}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
