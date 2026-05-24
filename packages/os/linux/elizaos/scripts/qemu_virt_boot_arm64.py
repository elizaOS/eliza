#!/usr/bin/env python3
"""Boot the arm64 live ISO under qemu-system-aarch64 and write evidence JSON."""

from __future__ import annotations

import argparse
import fcntl
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
VARIANT_DIR = HERE.parent
EVIDENCE_SCHEMA = "eliza.os.linux.qemu_virt_boot.v1"
CLAIM_BOUNDARY = "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim"
PROVENANCE = "qemu_virt_arm64"

REQUIRED_MARKERS = (
    "elizaOS Linux (Linux aarch64)",
    "elizaos-firstboot-ready",
    "elizaos-curl-health-ready",
    "elizaos-agent-ready",
    "elizaos-tui-ready",
)
FORBIDDEN_MARKERS = (
    "Kernel panic",
    "Oops",
    "BUG",
    "unhandled signal 4",
    "Illegal instruction",
)
ISO_BOOT_ARTIFACT_PATTERNS = {
    "arm64_removable_uefi_loader": "*/efi/boot/bootaa64.efi",
    "grub_config": "*/boot/grub/grub.cfg",
    "arm64_live_kernel": "*/live/vmlinuz-*arm64",
    "arm64_live_initrd": "*/live/initrd.img-*arm64",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel_to_variant(path: Path) -> str:
    try:
        return path.resolve().relative_to(VARIANT_DIR.resolve()).as_posix()
    except ValueError:
        return str(path)


def latest_iso() -> Path | None:
    out = VARIANT_DIR / "out"
    if not out.is_dir():
        return None
    candidates = sorted(
        out.glob("elizaos-linux-arm64-*.iso"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def list_iso_paths(iso: Path) -> list[str]:
    commands: list[list[str]] = []
    if shutil.which("bsdtar"):
        commands.append(["bsdtar", "-tf", str(iso)])
    if shutil.which("isoinfo"):
        commands.extend(
            [
                ["isoinfo", "-R", "-f", "-i", str(iso)],
                ["isoinfo", "-f", "-i", str(iso)],
            ]
        )
    if shutil.which("xorriso"):
        commands.append(["xorriso", "-indev", str(iso), "-find", "/"])
    if not commands:
        raise RuntimeError("bsdtar, isoinfo, or xorriso is required to inspect ISO contents")

    errors: list[str] = []
    for command in commands:
        proc = subprocess.run(command, text=True, capture_output=True, check=False)
        if proc.returncode == 0 and proc.stdout.strip():
            paths = []
            for raw in proc.stdout.splitlines():
                line = raw.strip().strip("'").strip('"')
                if line:
                    paths.append("/" + line.lstrip("/"))
            return paths
        errors.append(proc.stderr.strip() or f"{command!r} returned {proc.returncode}")
    raise RuntimeError("could not list ISO contents: " + " | ".join(errors))


def inspect_iso_boot_artifacts(iso: Path) -> dict[str, Any]:
    paths = list_iso_paths(iso)
    lower_paths = [path.lower() for path in paths]
    found: dict[str, str] = {}
    missing: list[str] = []
    for key, pattern in ISO_BOOT_ARTIFACT_PATTERNS.items():
        match = next(
            (
                paths[index]
                for index, path in enumerate(lower_paths)
                if fnmatch.fnmatch(path, pattern)
            ),
            None,
        )
        if match is None:
            missing.append(key)
        else:
            found[key] = match
    return {"found": found, "missing": missing}


def find_firmware(explicit: str | None, candidates: tuple[str, ...]) -> Path:
    if explicit:
        path = Path(explicit)
        if path.is_file():
            return path
        raise FileNotFoundError(f"arm64 firmware not found: {path}")
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file():
            return path
    raise FileNotFoundError("arm64 AAVMF firmware not found")


def marker_state(transcript: str) -> tuple[list[str], list[str], list[str], bool]:
    found = [marker for marker in REQUIRED_MARKERS if marker in transcript]
    missing = [marker for marker in REQUIRED_MARKERS if marker not in found]
    forbidden = [marker for marker in FORBIDDEN_MARKERS if marker in transcript]
    completed = not missing and not forbidden
    return found, missing, forbidden, completed


def write_evidence(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def acquire_output_lock(evidence: Path, transcript: Path):
    lock_path = evidence.with_suffix(evidence.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_handle = lock_path.open("w", encoding="utf-8")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_handle.close()
        raise RuntimeError(
            "another arm64 QEMU boot evidence run is active for "
            f"{evidence} / {transcript}"
        )
    lock_handle.write(f"{os.getpid()}\n")
    lock_handle.flush()
    return lock_handle


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iso", type=Path, default=None)
    parser.add_argument("--memory", type=int, default=4096)
    parser.add_argument("--cpus", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument(
        "--evidence",
        type=Path,
        default=VARIANT_DIR / "evidence/arm64_qemu_virt_boot.json",
    )
    parser.add_argument(
        "--transcript",
        type=Path,
        default=VARIANT_DIR / "evidence/arm64_qemu_virt_boot.transcript.log",
    )
    parser.add_argument("--firmware-code", default=os.environ.get("ELIZAOS_AAVMF_CODE"))
    parser.add_argument("--firmware-vars", default=os.environ.get("ELIZAOS_AAVMF_VARS"))
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    iso = args.iso if args.iso is not None else latest_iso()
    if iso is None:
        print("qemu_virt_boot_arm64: ERROR: no arm64 ISO under out/", file=sys.stderr)
        return 2
    if not iso.is_file():
        print(f"qemu_virt_boot_arm64: ERROR: ISO not found: {iso}", file=sys.stderr)
        return 2
    if args.memory < 256 or args.cpus < 1 or args.timeout < 1:
        print("qemu_virt_boot_arm64: ERROR: invalid memory/cpus/timeout", file=sys.stderr)
        return 2
    qemu = shutil.which("qemu-system-aarch64")
    if qemu is None:
        print("qemu_virt_boot_arm64: ERROR: qemu-system-aarch64 not on PATH", file=sys.stderr)
        return 2

    try:
        iso_boot_artifacts = inspect_iso_boot_artifacts(iso)
        code = find_firmware(
            args.firmware_code,
            (
                "/usr/share/AAVMF/AAVMF_CODE.fd",
                "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd",
            ),
        )
        vars_template = find_firmware(
            args.firmware_vars,
            (
                "/usr/share/AAVMF/AAVMF_VARS.fd",
                "/usr/share/AAVMF/AAVMF_VARS.ms.fd",
            ),
        )
    except (FileNotFoundError, RuntimeError) as exc:
        print(f"qemu_virt_boot_arm64: ERROR: {exc}", file=sys.stderr)
        return 2

    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.transcript.parent.mkdir(parents=True, exist_ok=True)
    try:
        output_lock = acquire_output_lock(args.evidence, args.transcript)
    except RuntimeError as exc:
        print(f"qemu_virt_boot_arm64: ERROR: {exc}", file=sys.stderr)
        return 75
    iso_sha = sha256_file(iso)
    start = datetime.now(UTC).replace(microsecond=0)
    start_epoch = time.monotonic()

    with tempfile.NamedTemporaryFile(prefix="elizaos-aavmf-vars-", delete=False) as vars_file:
        vars_runtime = Path(vars_file.name)
    shutil.copyfile(vars_template, vars_runtime)

    cmd = [
        qemu,
        "-machine",
        "virt",
        "-cpu",
        "max",
        "-nographic",
        "-m",
        str(args.memory),
        "-smp",
        str(args.cpus),
        "-drive",
        f"if=pflash,format=raw,unit=0,readonly=on,file={code}",
        "-drive",
        f"if=pflash,format=raw,unit=1,file={vars_runtime}",
        "-drive",
        f"file={iso},if=virtio,format=raw,media=cdrom,readonly=on",
        "-device",
        "virtio-gpu-device",
        "-netdev",
        "user,id=net0",
        "-device",
        "virtio-net-device,netdev=net0",
        "-monitor",
        "none",
        "-serial",
        "mon:stdio",
        "-no-reboot",
    ]

    header = "\n".join(
        [
            "## qemu_virt_boot_arm64 transcript",
            f"## start_utc: {start.isoformat().replace('+00:00', 'Z')}",
            f"## iso: {iso}",
            f"## iso_sha256: {iso_sha}",
            f"## memory_mb: {args.memory}",
            f"## cpus: {args.cpus}",
            f"## timeout_secs: {args.timeout}",
            f"## firmware: {code}",
            f"## cmd: {' '.join(cmd)}",
            "##",
            "",
        ]
    )
    args.transcript.write_text(header, encoding="utf-8")

    rc = 124
    try:
        with args.transcript.open("a", encoding="utf-8", errors="replace") as transcript:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=transcript,
                stderr=subprocess.STDOUT,
                text=True,
            )
            last_enter = 0.0
            while proc.poll() is None:
                elapsed = time.monotonic() - start_epoch
                if elapsed - last_enter >= 8 and proc.stdin is not None:
                    try:
                        proc.stdin.write("\n")
                        proc.stdin.flush()
                    except BrokenPipeError:
                        pass
                    last_enter = elapsed
                text = args.transcript.read_text(encoding="utf-8", errors="replace")
                _, _, forbidden, completed = marker_state(text)
                if completed or forbidden:
                    rc = 0 if completed else 1
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=10)
                    break
                if elapsed >= args.timeout:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=10)
                    rc = 124
                    break
                time.sleep(2)
            if proc.poll() is not None and rc == 124:
                rc = int(proc.returncode or 0)
    finally:
        vars_runtime.unlink(missing_ok=True)

    duration = int(time.monotonic() - start_epoch)
    transcript_text = args.transcript.read_text(encoding="utf-8", errors="replace")
    markers_found, markers_missing, forbidden_present, boot_completed = marker_state(
        transcript_text
    )
    if iso_boot_artifacts.get("missing"):
        boot_completed = False
    doc = {
        "schema": EVIDENCE_SCHEMA,
        "arch": "arm64",
        "claim_boundary": CLAIM_BOUNDARY,
        "iso_path": str(iso),
        "iso_sha256": iso_sha,
        "transcript_path": rel_to_variant(args.transcript),
        "transcript_sha256": sha256_file(args.transcript),
        "memory_mb": args.memory,
        "cpus": args.cpus,
        "timeout_s": args.timeout,
        "duration_s": duration,
        "start_utc": start.isoformat().replace("+00:00", "Z"),
        "qemu_exit_code": rc,
        "u_boot_path": None,
        "boot_completed": boot_completed,
        "markers_found": markers_found,
        "markers_missing": markers_missing,
        "forbidden_markers_present": forbidden_present,
        "iso_boot_artifacts": iso_boot_artifacts,
        "provenance": PROVENANCE,
    }
    write_evidence(args.evidence, doc)
    fcntl.flock(output_lock, fcntl.LOCK_UN)
    output_lock.close()
    print(f"qemu_virt_boot_arm64: transcript={args.transcript}")
    print(f"qemu_virt_boot_arm64: evidence={args.evidence}")
    print(
        "qemu_virt_boot_arm64: "
        f"boot_completed={str(boot_completed).lower()} "
        f"duration_s={duration} qemu_rc={rc}"
    )
    return 0 if boot_completed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
