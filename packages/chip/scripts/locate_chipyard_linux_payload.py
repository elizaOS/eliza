#!/usr/bin/env python3
"""Locate or describe how to build a Chipyard Linux run-binary payload.

The generated Chipyard Verilator runner expects ``BINARY=...`` to point at a
RISC-V ELF boot binary. FireMarshal's ``*-bin-nodisk`` outputs are suitable for
the first bounded Linux smoke because they package firmware plus a Linux
initramfs into one loadable ELF for Chipyard/Firesim-style runs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import struct
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/chipyard/eliza_rocket/chipyard-linux-payload.json"
PAYLOAD_ENV = "CHIPYARD_LINUX_BINARY"
FIREMARSHAL = ROOT / "external/chipyard/software/firemarshal"
DEFAULT_WORKLOAD = FIREMARSHAL / "example-workloads/linux-poweroff.json"
DEFAULT_OUTPUT = FIREMARSHAL / "images/firechip/linux-poweroff/linux-poweroff-bin-nodisk"

DEFAULT_CANDIDATES = (
    DEFAULT_OUTPUT,
    FIREMARSHAL / "images/firechip/linux-poweroff/linux-poweroff-bin-dwarf-nodisk",
    FIREMARSHAL / "images/firechip/br-base/br-base-bin",
)
LINUX_POWEROFF_DWARF_OUTPUT = FIREMARSHAL / (
    "images/firechip/linux-poweroff/linux-poweroff-bin-dwarf-nodisk"
)
BR_BASE_OUTPUT = FIREMARSHAL / "images/firechip/br-base/br-base-bin"
PREFERRED_LINUX_SMOKE_PAYLOADS = frozenset({DEFAULT_OUTPUT.resolve()})


@dataclass(frozen=True)
class ElfInfo:
    path: Path
    size: int
    sha256: str
    elf_type: int
    machine: int
    entry: int
    flags: int
    contains_opensbi: bool
    contains_linux_version: bool

    @property
    def runnable(self) -> bool:
        return (
            self.size > 0
            and self.elf_type in {2, 3}
            and self.machine == 0xF3
            and self.entry != 0
            and self.contains_opensbi
            and self.contains_linux_version
        )


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_elf_info(path: Path) -> tuple[ElfInfo | None, str | None]:
    if not path.is_file():
        return None, "missing"
    data = path.read_bytes()
    if len(data) < 64:
        return None, "too small to be an ELF64 file"
    if data[:4] != b"\x7fELF":
        return None, "not an ELF file"
    if data[4] != 2:
        return None, "not ELF64"
    if data[5] != 1:
        return None, "not little-endian ELF"

    elf_type, machine = struct.unpack_from("<HH", data, 16)
    entry = struct.unpack_from("<Q", data, 24)[0]
    flags = struct.unpack_from("<I", data, 48)[0]
    return (
        ElfInfo(
            path=path,
            size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            elf_type=elf_type,
            machine=machine,
            entry=entry,
            flags=flags,
            contains_opensbi=b"OpenSBI" in data,
            contains_linux_version=b"Linux version" in data,
        ),
        None,
    )


def candidate_paths(extra: list[str], *, defaults: bool) -> list[Path]:
    paths: list[Path] = []
    env_value = os.environ.get(PAYLOAD_ENV)
    if env_value:
        paths.append(Path(env_value).expanduser())
    if defaults:
        paths.extend(DEFAULT_CANDIDATES)
    paths.extend(Path(item).expanduser() for item in extra)

    deduped: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        resolved = str(path if path.is_absolute() else (ROOT / path))
        if resolved not in seen:
            seen.add(resolved)
            deduped.append(Path(resolved))
    return deduped


def firemarshal_build_command() -> str:
    return (
        "cd external/chipyard/software/firemarshal && "
        "./marshal -v -d build example-workloads/linux-poweroff.json"
    )


def payload_role(path: Path) -> str:
    resolved = path.resolve()
    if resolved == DEFAULT_OUTPUT.resolve():
        return "preferred_linux_poweroff_nodisk"
    if resolved == LINUX_POWEROFF_DWARF_OUTPUT.resolve():
        return "linux_poweroff_dwarf_nodisk"
    if resolved == BR_BASE_OUTPUT.resolve():
        return "fallback_br_base"
    return "custom"


def preferred_for_linux_smoke(path: Path) -> bool:
    return path.resolve() in PREFERRED_LINUX_SMOKE_PAYLOADS


def manifest_for(
    *,
    selected: ElfInfo | None,
    candidates: list[dict[str, object]],
    errors: list[str],
    warnings: list[str],
) -> dict[str, object]:
    selected_is_preferred = selected is not None and preferred_for_linux_smoke(selected.path)
    return {
        "schema": "eliza.chipyard_linux_payload.v1",
        "status": "pass" if selected else "blocked",
        "payload_env": PAYLOAD_ENV,
        "selected_payload": rel(selected.path) if selected else "",
        "selected_payload_role": payload_role(selected.path) if selected else "",
        "selected_payload_preferred_for_linux_smoke": selected_is_preferred,
        "selected_payload_sha256": selected.sha256 if selected else "",
        "selected_payload_entry": f"0x{selected.entry:x}" if selected else "",
        "selected_payload_size_bytes": selected.size if selected else 0,
        "claim_boundary": (
            "Payload locator only. A valid payload allows Chipyard run-binary "
            "to be attempted; it is not Eliza AP boot evidence until the "
            "generated simulator produces verified OpenSBI/Linux transcripts."
        ),
        "expected_chipyard_command": (
            "CHIPYARD_LINUX_BINARY=<selected_payload> scripts/run_chipyard_eliza_linux_smoke.sh"
        ),
        "firemarshal_build_command": firemarshal_build_command(),
        "firemarshal_output": rel(DEFAULT_OUTPUT),
        "preferred_linux_smoke_payload": rel(DEFAULT_OUTPUT),
        "preferred_linux_smoke_payload_available": any(
            record.get("path") == rel(DEFAULT_OUTPUT) and record.get("status") == "pass"
            for record in candidates
        ),
        "host": {
            "system": platform.system(),
            "machine": platform.machine(),
        },
        "candidates": candidates,
        "errors": errors,
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--candidate",
        action="append",
        default=[],
        help="Additional candidate payload path to validate.",
    )
    parser.add_argument(
        "--no-defaults",
        action="store_true",
        help="Only consider CHIPYARD_LINUX_BINARY and explicit --candidate paths.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the full JSON manifest instead of the shell export line.",
    )
    parser.add_argument(
        "--export-env",
        action="store_true",
        help="Print 'export CHIPYARD_LINUX_BINARY=...' for shell eval.",
    )
    parser.add_argument(
        "--require",
        action="store_true",
        help="Exit nonzero if no runnable payload is found.",
    )
    parser.add_argument(
        "--require-preferred",
        action="store_true",
        help="Exit nonzero unless the selected payload is the preferred linux-poweroff nodisk image.",
    )
    args = parser.parse_args()

    selected: ElfInfo | None = None
    candidates: list[dict[str, object]] = []
    errors: list[str] = []
    warnings: list[str] = []

    for path in candidate_paths(args.candidate, defaults=not args.no_defaults):
        info, error = read_elf_info(path)
        record: dict[str, object] = {
            "path": rel(path),
            "role": payload_role(path),
            "preferred_for_linux_smoke": preferred_for_linux_smoke(path),
        }
        if info is None:
            record.update({"status": "blocked", "reason": error})
        else:
            record.update(
                {
                    "status": "pass" if info.runnable else "blocked",
                    "size_bytes": info.size,
                    "sha256": info.sha256,
                    "elf_type": info.elf_type,
                    "machine": f"0x{info.machine:x}",
                    "entry": f"0x{info.entry:x}",
                    "flags": f"0x{info.flags:x}",
                    "contains_opensbi": info.contains_opensbi,
                    "contains_linux_version": info.contains_linux_version,
                }
            )
            if info.runnable and selected is None:
                selected = info
        candidates.append(record)

    if selected is None:
        errors.append(
            "No runnable RISC-V ELF payload with OpenSBI and Linux version markers found. "
            f"Build one with: {firemarshal_build_command()}"
        )
    elif not preferred_for_linux_smoke(selected.path):
        warnings.append(
            "Selected payload is runnable but is not the preferred linux-poweroff nodisk "
            f"smoke payload; build {rel(DEFAULT_OUTPUT)} with: {firemarshal_build_command()}"
        )
        if args.require_preferred:
            errors.append(
                "Preferred linux-poweroff nodisk smoke payload is unavailable; "
                f"build it with: {firemarshal_build_command()}"
            )

    manifest = manifest_for(
        selected=selected,
        candidates=candidates,
        errors=errors,
        warnings=warnings,
    )
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    if args.json:
        print(json.dumps(manifest, indent=2, sort_keys=True))
    elif args.export_env:
        if errors:
            print(f"# BLOCKED: {errors[0]}")
        elif selected:
            print(f"export {PAYLOAD_ENV}={selected.path}")
        else:
            print(f"# BLOCKED: {errors[0]}")
    elif selected:
        print(f"STATUS: PASS chipyard.linux_payload - {rel(selected.path)}")
        print(f"  role: {payload_role(selected.path)}")
        print(f"  sha256: {selected.sha256}")
        print(f"  entry: 0x{selected.entry:x}")
        print(f"  export: export {PAYLOAD_ENV}={selected.path}")
        for warning in warnings:
            print(f"  warning: {warning}")
        print(f"  report: {rel(REPORT)}")
    else:
        print("STATUS: BLOCKED chipyard.linux_payload")
        for error in errors:
            print(f"  - {error}")
        print(f"  report: {rel(REPORT)}")

    if selected is None and args.require:
        return 2
    if args.require_preferred and errors:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
