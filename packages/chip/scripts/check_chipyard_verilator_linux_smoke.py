#!/usr/bin/env python3
"""Fail-closed gate for the next Chipyard Verilator OpenSBI/Linux smoke step."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import time
from pathlib import Path

import locate_chipyard_linux_payload
import repair_chipyard_generated_paths

ROOT = Path(__file__).resolve().parents[1]
CHECKOUT = ROOT / "external/chipyard"
SIM_DIR = CHECKOUT / "sims/verilator"
OUT_DIR = ROOT / "build/chipyard/eliza_rocket"
REPORT = OUT_DIR / "verilator-linux-smoke.json"
LOG = OUT_DIR / "verilator-linux-smoke.log"
LOCK_DIR = OUT_DIR / "verilator-linux-smoke.lock"
CONFIG = "ElizaRocketConfig"
CONFIG_PACKAGE = "eliza"
PAYLOAD_ENV = "CHIPYARD_LINUX_BINARY"

REQUIRED_GENERATED_ARTIFACTS = (
    OUT_DIR / "eliza_rocket_ap.v",
    OUT_DIR / "generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.fir",
    OUT_DIR / "generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.dts",
    OUT_DIR / "ElizaRocketConfig.manifest.json",
)
REQUIRED_LOG_MARKERS = ("OpenSBI", "Linux version")
OPENSBI_MARKERS = ("OpenSBI", "SBI specification", "Domain0 Next Address", "Boot HART ID")
OPENSBI_ACCEPTANCE_MARKERS = ("SBI specification", "Domain0 Next Address", "Boot HART ID")
LINUX_MARKERS = (
    "Linux version",
    "Kernel command line:",
    "Freeing unused kernel",
    "Run /init as init process",
    "initramfs",
)
LINUX_ACCEPTANCE_MARKERS = (
    "Kernel command line:",
    "Freeing unused kernel",
    "Run /init as init process",
    "initramfs",
)
PROGRESS_MARKERS = (
    "SimDRAM loaded ELF entry=",
    "SimDRAM loading ELF ",
    "[UART] UART0 is here",
    "eliza-evidence: command=",
    "eliza-evidence: timeout_after_seconds=",
    "eliza-evidence: exit_code=",
)
CONTAINER_PATH_ENV = "CHIPYARD_ALLOW_CONTAINER_GENERATED_PATHS"
GENERATED_CONFIG_DIR = SIM_DIR / "generated-src/chipyard.harness.TestHarness.ElizaRocketConfig"
GENERATED_DRIVER_MAKEFILE = (
    GENERATED_CONFIG_DIR / "chipyard.harness.TestHarness.ElizaRocketConfig" / "VTestDriver.mk"
)
GENERATED_DRIVER_DIR = GENERATED_DRIVER_MAKEFILE.parent
GENERATED_FILELISTS = (
    GENERATED_CONFIG_DIR / "sim_files.common.f",
    GENERATED_CONFIG_DIR / "sim_files.f",
)
GENERATED_SIMULATOR = SIM_DIR / f"simulator-chipyard.harness-{CONFIG}"
ARCHIVED_SIMULATOR_DIR = OUT_DIR / "simulator"
ARCHIVED_SIMULATOR = ARCHIVED_SIMULATOR_DIR / f"simulator-chipyard.harness-{CONFIG}"
SIMULATOR_CANDIDATES = (GENERATED_SIMULATOR, ARCHIVED_SIMULATOR)
GENERATED_METADATA_PATTERNS = repair_chipyard_generated_paths.GENERATED_METADATA_PATTERNS
STALE_ABSOLUTE_ROOTS = ("/work/", "/workspace/", "/__w/")
TRACE_LINE_RE = re.compile(
    r"^C(?P<hart>\d+):\s+(?P<cycle>\d+)\s+\[(?P<valid>[01])\]\s+pc=\[(?P<pc>[0-9a-fA-F]+)\]"
)
OBJDUMP_CANDIDATES = (
    ROOT / "build/riscv-chipyard-prefix/bin/riscv64-unknown-elf-objdump",
    ROOT / "tools/bin/riscv64-linux-gnu-objdump",
    ROOT / "tools/bin/llvm-objdump",
    ROOT / "external/riscv64-linux-gnu/usr/bin/riscv64-linux-gnu-objdump",
)
SYMBOL_LINE_RE = re.compile(
    r"^(?P<addr>[0-9a-fA-F]{8,16})\s+\S+\s+\S+\s+(?P<section>\S+)\s+"
    r"(?P<size>[0-9a-fA-F]{8,16})\s+(?P<name>\S+)$"
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def next_command(payload: str = f"${PAYLOAD_ENV}") -> str:
    return f"{PAYLOAD_ENV}={payload} scripts/run_chipyard_eliza_linux_smoke.sh"


def host_path_from_log(path_text: str | None) -> Path | None:
    if not path_text:
        return None
    if path_text.startswith("/work/"):
        return ROOT / path_text.removeprefix("/work/")
    return Path(path_text)


def detect_stale_absolute_roots(
    text: str, host_root: Path, allow_container_paths: bool
) -> list[str]:
    if allow_container_paths:
        return []
    host_root_text = str(host_root)
    return sorted(
        {
            token
            for token in STALE_ABSOLUTE_ROOTS
            if token in text and not host_root_text.startswith(token.rstrip("/"))
        }
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_objdump() -> Path | None:
    for candidate in OBJDUMP_CANDIDATES:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    for name in (
        "riscv64-unknown-elf-objdump",
        "riscv64-linux-gnu-objdump",
        "llvm-objdump",
    ):
        found = shutil.which(name)
        if found:
            return Path(found)
    return None


def resolve_payload_symbol(payload: str | None, pc: int | None) -> dict[str, object]:
    result: dict[str, object] = {
        "objdump": "",
        "symbol": None,
        "symbol_offset": None,
        "symbol_address": None,
    }
    if not payload or pc is None:
        return result
    payload_path = Path(payload)
    if not payload_path.is_file():
        return result
    objdump = find_objdump()
    if objdump is None:
        return result
    result["objdump"] = rel(objdump)
    try:
        proc = subprocess.run(
            [str(objdump), "-t", str(payload_path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return result
    best: tuple[int, int, str] | None = None
    for line in proc.stdout.splitlines():
        text = line.strip()
        match = SYMBOL_LINE_RE.match(text)
        if match:
            section = match.group("section")
            addr_text = match.group("addr")
            size_text = match.group("size")
            name = match.group("name")
        else:
            parts = text.split()
            if len(parts) >= 6 and parts[3] == ".text":
                addr_text, section, size_text, name = parts[0], parts[3], parts[4], parts[5]
            elif len(parts) >= 5 and parts[2] == ".text":
                addr_text, section, size_text, name = parts[0], parts[2], parts[3], parts[4]
            else:
                continue
        if section != ".text" or name.startswith("."):
            continue
        addr = int(addr_text, 16)
        size = int(size_text, 16)
        if addr > pc:
            continue
        if size and pc >= addr + size:
            continue
        if best is None or addr > best[0]:
            best = (addr, size, name)
    if best is None:
        return result
    addr, _size, name = best
    result.update(
        {
            "symbol": name,
            "symbol_offset": pc - addr,
            "symbol_address": f"0x{addr:016x}",
        }
    )
    return result


def generated_metadata_files() -> list[Path]:
    files = [path for path in (*GENERATED_FILELISTS, GENERATED_DRIVER_MAKEFILE) if path.is_file()]
    if GENERATED_CONFIG_DIR.exists():
        for pattern in GENERATED_METADATA_PATTERNS:
            files.extend(path for path in GENERATED_CONFIG_DIR.rglob(pattern) if path.is_file())
    return sorted(set(files))


def generated_path_blockers() -> list[str]:
    blockers: list[str] = []
    allow_container_paths = os.environ.get(CONTAINER_PATH_ENV) == "1"
    partial_generated = GENERATED_CONFIG_DIR.exists() and not GENERATED_DRIVER_MAKEFILE.is_file()
    stale_metadata: list[tuple[Path, list[str]]] = []
    for generated_file in generated_metadata_files():
        file_text = generated_file.read_text(encoding="utf-8", errors="replace")
        stale_roots = detect_stale_absolute_roots(file_text, ROOT, allow_container_paths)
        if stale_roots:
            stale_metadata.append((generated_file, stale_roots))
    if stale_metadata:
        roots = sorted({root for _path, stale_roots in stale_metadata for root in stale_roots})
        sample = ", ".join(rel(path) for path, _stale_roots in stale_metadata[:8])
        extra = "" if len(stale_metadata) <= 8 else f", ... +{len(stale_metadata) - 8} more"
        blockers.append(
            "generated Verilator metadata contains stale container/workspace absolute paths "
            f"({', '.join(roots)}): {sample}{extra}; run "
            "`python3 scripts/repair_chipyard_generated_paths.py --rewrite`, regenerate the "
            "full generated-src config directory on this host, or run "
            "`CHIPYARD_LINUX_SMOKE_USE_DOCKER=1 scripts/run_chipyard_eliza_linux_smoke.sh` "
            "inside the /work-mounted container path"
        )
    elif partial_generated:
        blockers.append(
            "partial generated Verilator output is missing the driver makefile after generation: "
            f"{rel(GENERATED_DRIVER_MAKEFILE)}; remove the generated config directory and rerun "
            "`scripts/run_chipyard_eliza_linux_smoke.sh` so Chipyard regenerates the model"
        )
    if GENERATED_DRIVER_DIR.is_dir():
        zero_outputs = sorted(
            path
            for pattern in ("VTestDriver*.o", "VTestDriver__ALL.*")
            for path in GENERATED_DRIVER_DIR.glob(pattern)
            if path.is_file() and path.stat().st_size == 0
        )
        if zero_outputs:
            blockers.append(
                "partial generated Verilator output contains zero-byte model artifacts: "
                + ", ".join(rel(path) for path in zero_outputs[:5])
                + "; remove the generated config directory and rerun "
                "`scripts/run_chipyard_eliza_linux_smoke.sh`"
            )
    if partial_generated:
        blockers.append(
            "partial generated Verilator config directory exists without a complete driver model: "
            f"{rel(GENERATED_CONFIG_DIR)}"
        )
    return blockers


def simulator_artifact_metadata() -> dict[str, object]:
    candidates: list[dict[str, object]] = []
    host_system = platform.system()
    host_machine = platform.machine()
    runnable_candidate = False
    executable_candidate = False
    for path in SIMULATOR_CANDIDATES:
        candidate: dict[str, object] = {
            "path": rel(path),
            "exists": path.is_file(),
            "size_bytes": None,
            "executable": False,
            "sha256": None,
            "elf_class": None,
            "elf_machine": None,
            "host_runnable": False,
            "host_blocker": "",
        }
        if path.is_file():
            stat_result = path.stat()
            executable = bool(stat_result.st_mode & 0o111)
            candidate["size_bytes"] = stat_result.st_size
            candidate["executable"] = executable
            candidate["sha256"] = sha256_file(path)
            executable_candidate = executable_candidate or executable
            header = path.read_bytes()[:20]
            if header.startswith(b"\x7fELF"):
                candidate["elf_class"] = "ELF64" if header[4] == 2 else "ELF32"
                machine = int.from_bytes(header[18:20], "little")
                candidate["elf_machine"] = {62: "x86_64", 183: "aarch64", 243: "riscv"}.get(
                    machine, f"em_{machine}"
                )
                if host_system != "Linux":
                    candidate["host_blocker"] = (
                        f"ELF simulator requires Linux host, got {host_system}"
                    )
                elif machine == 62 and host_machine not in {"x86_64", "amd64"}:
                    candidate["host_blocker"] = (
                        f"ELF x86_64 simulator requires x86_64 host, got {host_machine}"
                    )
                else:
                    candidate["host_runnable"] = executable
            else:
                candidate["host_blocker"] = "not an ELF executable"
            runnable_candidate = runnable_candidate or bool(candidate["host_runnable"])
        candidates.append(candidate)
    return {
        "candidates": candidates,
        "executable_candidate": executable_candidate,
        "host_runnable_candidate": runnable_candidate,
    }


def simulator_artifact_blockers(metadata: dict[str, object]) -> list[str]:
    blockers: list[str] = []
    candidates = metadata.get("candidates")
    existing = (
        [
            candidate
            for candidate in candidates
            if isinstance(candidate, dict) and bool(candidate.get("exists"))
        ]
        if isinstance(candidates, list)
        else []
    )
    if not existing:
        blockers.append(
            "missing generated simulator artifact: expected one of "
            + ", ".join(rel(path) for path in SIMULATOR_CANDIDATES)
        )
    elif not metadata.get("executable_candidate"):
        blockers.append(
            "generated simulator artifact exists but no executable candidate is present: "
            + ", ".join(str(candidate.get("path")) for candidate in existing)
        )
    return blockers


def has_marker_group(text: str, required: tuple[str, ...], any_of: tuple[str, ...]) -> bool:
    return all(marker in text for marker in required) and any(marker in text for marker in any_of)


def has_accepted_opensbi_markers(text: str) -> bool:
    return has_marker_group(text, ("OpenSBI",), OPENSBI_ACCEPTANCE_MARKERS)


def has_accepted_linux_markers(text: str) -> bool:
    return has_marker_group(text, ("Linux version",), LINUX_ACCEPTANCE_MARKERS)


def remove_path(path: Path) -> None:
    def fix_permissions_and_retry(function, path_value) -> None:
        try:
            os.chmod(path_value, stat.S_IRWXU)
            function(path_value)
        except FileNotFoundError:
            pass

    def onerror(function, path_value, _exc_info):
        fix_permissions_and_retry(function, path_value)

    if path.is_dir():
        # Docker/QEMU-backed Chipyard runs can still be tearing down object files
        # when a local repair is requested. Retry briefly, then leave the gate
        # blocked instead of raising a Python traceback.
        last_error: OSError | None = None
        for _attempt in range(3):
            try:
                shutil.rmtree(path, onerror=onerror)
                return
            except OSError as exc:
                last_error = exc
                time.sleep(0.25)
        raise RuntimeError(
            f"could not remove {rel(path)} after retries; generated files are likely "
            "being created by an active Chipyard smoke/generation job"
        ) from last_error
    else:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def active_lock_owner() -> int | None:
    pid_file = LOCK_DIR / "pid"
    if not pid_file.is_file():
        return None
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def repair_incomplete_attempt() -> int:
    if not LOG.is_file():
        print("STATUS: PASS chipyard.verilator_linux_smoke.incomplete_attempt - no smoke log")
        return 0
    log_metadata = parse_log_metadata()
    log_text = LOG.read_text(encoding="utf-8", errors="replace")
    if "eliza-evidence: raw_transcript_begin" not in log_text or log_metadata.get(
        "raw_transcript_closed"
    ):
        print("STATUS: PASS chipyard.verilator_linux_smoke.incomplete_attempt - log is complete")
        return 0
    owner = active_lock_owner()
    if owner is not None:
        print("STATUS: BLOCKED chipyard.verilator_linux_smoke.incomplete_attempt")
        print(f"  - active smoke runner still owns lock: pid={owner}")
        return 2
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    archived = LOG.with_name(f"{LOG.stem}.interrupted-{timestamp}{LOG.suffix}")
    LOG.replace(archived)
    print("STATUS: REPAIR chipyard.verilator_linux_smoke.incomplete_attempt")
    print(f"  archived: {rel(archived)}")
    print("  next: rerun scripts/run_chipyard_eliza_linux_smoke.sh for a complete transcript")
    return 0


def active_chipyard_containers() -> list[dict[str, str]]:
    if not shutil.which("docker"):
        return []
    completed = subprocess.run(
        [
            "docker",
            "ps",
            "--format",
            "{{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}\t{{.Command}}",
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    containers: list[dict[str, str]] = []
    for line in completed.stdout.splitlines():
        parts = line.split("\t", 4)
        if len(parts) != 5:
            continue
        container_id, image, status, name, command = parts
        haystack = f"{image} {command}".lower()
        if "chipyard" not in haystack and "eliza" not in haystack:
            continue
        containers.append(
            {
                "id": container_id,
                "image": image,
                "status": status,
                "name": name,
                "command": command,
            }
        )
    return containers


def repair_stale_generated_paths() -> int:
    blockers = generated_path_blockers()
    generated_files = generated_metadata_files()
    destructive_repair_needed = any(
        "partial generated Verilator" in blocker or "zero-byte model artifacts" in blocker
        for blocker in blockers
    )
    if generated_files:
        _results, replacements = repair_chipyard_generated_paths.inspect_or_rewrite(
            generated_files,
            repair_chipyard_generated_paths.default_stale_roots(ROOT),
            ROOT,
            rewrite=True,
        )
        if replacements:
            print(
                "STATUS: REPAIR chipyard.verilator_generated_paths - rewrote "
                f"{replacements} stale generated path occurrence(s)"
            )
            if not destructive_repair_needed:
                print("  next: rerun python3 scripts/check_chipyard_verilator_linux_smoke.py")
                return 0
    repairable = [
        blocker
        for blocker in blockers
        if "stale container/workspace absolute paths" in blocker
        or "partial generated Verilator" in blocker
        or "zero-byte model artifacts" in blocker
    ]
    if not repairable:
        print("STATUS: PASS chipyard.verilator_generated_paths")
        print(f"  generated_driver_makefile: {rel(GENERATED_DRIVER_MAKEFILE)}")
        return 0

    print("STATUS: REPAIR chipyard.verilator_generated_paths")
    for blocker in repairable:
        print(f"  - {blocker}")
    print(f"  removing: {rel(GENERATED_CONFIG_DIR)}")
    try:
        remove_path(GENERATED_CONFIG_DIR)
    except RuntimeError as exc:
        print("STATUS: BLOCKED chipyard.verilator_generated_paths")
        print(f"  - {exc}")
        print("  next: wait for active Chipyard Docker/simulator jobs to finish, then rerun")
        print(
            "    python3 scripts/check_chipyard_verilator_linux_smoke.py --repair-stale-generated"
        )
        return 2
    print(f"  removing: {rel(GENERATED_SIMULATOR)}")
    try:
        remove_path(GENERATED_SIMULATOR)
    except RuntimeError as exc:
        print("STATUS: BLOCKED chipyard.verilator_generated_paths")
        print(f"  - {exc}")
        print("  next: wait for active Chipyard Docker/simulator jobs to finish, then rerun")
        print(
            "    python3 scripts/check_chipyard_verilator_linux_smoke.py --repair-stale-generated"
        )
        return 2
    print("  next: rerun the Chipyard make target so VTestDriver.mk is regenerated on this host")
    return 0


def parse_log_metadata() -> dict[str, object]:
    metadata: dict[str, object] = {
        "exists": LOG.is_file(),
        "attempt": None,
        "clean_generated": None,
        "exit_code": None,
        "payload": None,
        "binary_arg": None,
        "command": None,
        "timeout_after_seconds": None,
        "timeout_cycles": None,
        "core_timeout_cycles": None,
        "tilelink_timeout_cycles": None,
        "run_target": None,
        "raw_transcript_closed": False,
        "lines_after_raw_transcript_end": 0,
        "fatal_errors": [],
        "exceptions": [],
        "sim_failures": [],
        "simdram_entry": None,
        "simdram_load_range": None,
        "last_progress_marker": "",
    }
    if not LOG.is_file():
        return metadata

    last_progress = ""
    raw_transcript_closed = False
    lines_after_raw_transcript_end = 0
    for line in LOG.read_text(encoding="utf-8", errors="replace").splitlines():
        if raw_transcript_closed and line.strip() and not line.startswith("eliza-evidence:"):
            lines_after_raw_transcript_end += 1
        if line.startswith("eliza-evidence: attempt="):
            metadata["attempt"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: clean_generated="):
            metadata["clean_generated"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: exit_code="):
            metadata["exit_code"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: payload="):
            metadata["payload"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: binary_arg="):
            metadata["binary_arg"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: command="):
            metadata["command"] = line.split("=", 1)[1].strip()
            last_progress = line
        elif line.startswith("eliza-evidence: timeout_after_seconds="):
            metadata["timeout_after_seconds"] = line.split("=", 1)[1].strip()
            last_progress = line
        elif line.startswith("eliza-evidence: timeout_cycles="):
            metadata["timeout_cycles"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: core_timeout_cycles="):
            metadata["core_timeout_cycles"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: tilelink_timeout_cycles="):
            metadata["tilelink_timeout_cycles"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: run_target="):
            metadata["run_target"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: raw_transcript_end"):
            metadata["raw_transcript_closed"] = True
            raw_transcript_closed = True
        elif line.startswith("SimDRAM loading ELF "):
            marker = " into mem="
            if marker in line:
                metadata["simdram_load_range"] = line.rsplit(marker, 1)[1].strip()
            last_progress = line
        elif line.startswith("SimDRAM loaded ELF entry="):
            metadata["simdram_entry"] = line.split("=", 1)[1].strip()
            last_progress = line
        elif any(marker in line for marker in PROGRESS_MARKERS):
            last_progress = line
        if "fatal error:" in line:
            fatal_errors = metadata["fatal_errors"]
            if isinstance(fatal_errors, list):
                fatal_errors.append(line.strip())
        if (
            "Exception in thread" in line
            or line.strip().startswith("Caused by:")
            or "NoSuchFileException" in line
        ):
            exceptions = metadata["exceptions"]
            if isinstance(exceptions, list):
                exceptions.append(line.strip())
        if "*** FAILED ***" in line:
            sim_failures = metadata["sim_failures"]
            if isinstance(sim_failures, list):
                sim_failures.append(line.strip())
    metadata["last_progress_marker"] = last_progress
    metadata["lines_after_raw_transcript_end"] = lines_after_raw_transcript_end
    return metadata


def output_stem_for_payload(payload: str | None) -> str:
    if not payload or payload == "none":
        return "none"
    return Path(payload).name


def trace_fresh_for_log(trace: Path, log_metadata: dict[str, object] | None = None) -> bool:
    if not LOG.is_file():
        return True
    trace_mtime = trace.stat().st_mtime
    log_mtime = LOG.stat().st_mtime
    if trace_mtime >= log_mtime:
        return True
    timeout_after = None if log_metadata is None else log_metadata.get("timeout_after_seconds")
    try:
        timeout_window = float(str(timeout_after)) if timeout_after is not None else 0.0
    except ValueError:
        timeout_window = 0.0
    return timeout_window > 0.0 and trace_mtime >= log_mtime - timeout_window - 30.0


def parse_instruction_trace(
    payload: str | None, log_metadata: dict[str, object] | None = None
) -> dict[str, object]:
    trace = (
        SIM_DIR
        / "output"
        / f"chipyard.harness.TestHarness.{CONFIG}"
        / f"{output_stem_for_payload(payload)}.out"
    )
    metadata: dict[str, object] = {
        "path": rel(trace),
        "exists": trace.is_file(),
        "fresh_for_log": False,
        "retired_instruction_count": 0,
        "first_pc": None,
        "last_pc": None,
        "last_symbol": None,
        "last_symbol_offset": None,
        "last_symbol_address": None,
        "last_symbol_objdump": "",
        "last_cycle": None,
        "entered_bootrom": False,
        "entered_payload": False,
        "bootrom_to_payload_handoff": False,
    }
    if not trace.is_file():
        return metadata
    metadata["fresh_for_log"] = trace_fresh_for_log(trace, log_metadata)

    first_pc: int | None = None
    last_pc: int | None = None
    last_cycle: int | None = None
    retired = 0
    entered_bootrom = False
    entered_payload = False
    for line in trace.read_text(encoding="utf-8", errors="replace").splitlines():
        match = TRACE_LINE_RE.match(line)
        if not match or match.group("valid") != "1":
            continue
        pc = int(match.group("pc"), 16)
        if first_pc is None:
            first_pc = pc
        last_pc = pc
        last_cycle = int(match.group("cycle"))
        retired += 1
        if 0x10000 <= pc < 0x20000:
            entered_bootrom = True
        if pc >= 0x80000000:
            entered_payload = True

    metadata.update(
        {
            "retired_instruction_count": retired,
            "first_pc": f"0x{first_pc:016x}" if first_pc is not None else None,
            "last_pc": f"0x{last_pc:016x}" if last_pc is not None else None,
            "last_cycle": last_cycle,
            "entered_bootrom": entered_bootrom,
            "entered_payload": entered_payload,
            "bootrom_to_payload_handoff": entered_bootrom and entered_payload,
        }
    )
    symbol = resolve_payload_symbol(payload, last_pc)
    metadata.update(
        {
            "last_symbol": symbol["symbol"],
            "last_symbol_offset": symbol["symbol_offset"],
            "last_symbol_address": symbol["symbol_address"],
            "last_symbol_objdump": symbol["objdump"],
        }
    )
    return metadata


def classify_smoke_progress(
    log_text: str, instruction_trace: dict[str, object], log_metadata: dict[str, object]
) -> dict[str, str]:
    if not log_text:
        return {
            "stage": "no_run",
            "next_step": "run scripts/run_chipyard_eliza_linux_smoke.sh with a real OpenSBI/Linux payload",
        }
    if has_accepted_linux_markers(log_text):
        return {
            "stage": "linux_boot",
            "next_step": "capture the complete generated-AP Linux boot transcript",
        }
    if "Linux version" in log_text:
        return {
            "stage": "linux_banner_only",
            "next_step": "continue until Linux command line/initramfs markers appear",
        }
    if has_accepted_opensbi_markers(log_text):
        return {
            "stage": "opensbi_boot",
            "next_step": "continue the smoke until the Linux kernel banner appears",
        }
    if "OpenSBI" in log_text:
        return {
            "stage": "opensbi_banner_only",
            "next_step": "continue until OpenSBI handoff markers and the Linux banner appear",
        }
    if instruction_trace.get("bootrom_to_payload_handoff") and instruction_trace.get(
        "fresh_for_log"
    ):
        last_symbol = str(instruction_trace.get("last_symbol") or "")
        retired_raw = instruction_trace.get("retired_instruction_count")
        cycle_raw = instruction_trace.get("last_cycle")
        retired_count = int(retired_raw) if isinstance(retired_raw, int | str) else 0
        last_cycle = int(cycle_raw) if isinstance(cycle_raw, int | str) else 0
        if last_symbol.startswith("fdt_") or last_symbol in {
            "sbi_memchr",
            "sbi_memcmp",
            "sbi_strncmp",
        }:
            if retired_count < 1_000_000 or last_cycle < 2_000_000:
                return {
                    "stage": "payload_fdt_parse_in_progress",
                    "next_step": (
                        "continue the generated AP traced smoke beyond early OpenSBI "
                        "FDT traversal before treating DTS or console compatibility as failed"
                    ),
                }
            return {
                "stage": "payload_fdt_parse_no_console",
                "next_step": (
                    "debug the boot ROM FDT handoff and generated DTS stdout/serial "
                    "compatibility before OpenSBI console initialization"
                ),
            }
        if last_symbol == "sifive_uart_putc":
            return {
                "stage": "payload_uart_tx_full_poll",
                "next_step": (
                    "debug the generated SiFive UART TXDATA full-bit behavior, "
                    "TX enable path, and UART host bridge before OpenSBI banner output"
                ),
            }
        if last_symbol in {
            "_bss_zero",
            "_scratch_init",
            "_fdt_reloc_again",
            "_fdt_reloc_done",
            "_relocate_done",
            "_try_lottery",
            "_wait_for_boot_hart",
            "_wait_relocate_copy_done",
        }:
            return {
                "stage": "payload_opensbi_early_init",
                "next_step": (
                    "continue the generated AP trace beyond OpenSBI early assembly "
                    "initialization, then classify the first console or FDT failure"
                ),
            }
        if "serial" in last_symbol or "console" in last_symbol or "uart" in last_symbol:
            return {
                "stage": "payload_console_init_no_banner",
                "next_step": (
                    "debug generated UART compatibility and OpenSBI console init before "
                    "expecting banner output"
                ),
            }
        return {
            "stage": "cpu_progress_to_payload",
            "next_step": "debug why the payload runs after boot ROM handoff but emits no OpenSBI/Linux UART markers",
        }
    if instruction_trace.get("bootrom_to_payload_handoff") and not instruction_trace.get(
        "fresh_for_log"
    ):
        return {
            "stage": "stale_instruction_trace",
            "next_step": (
                "rerun with CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary for fresh PC "
                "evidence, or rely on UART-only log evidence from run-binary-fast"
            ),
        }
    if (
        log_metadata.get("run_target") == "run-binary-fast"
        and log_metadata.get("exit_code")
        and log_metadata.get("exit_code") != "0"
        and not instruction_trace.get("exists")
        and not any(marker in log_text for marker in REQUIRED_LOG_MARKERS)
    ):
        return {
            "stage": "fast_timeout_no_trace",
            "next_step": (
                "rerun with CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary for fresh PC "
                "evidence, or extend the fast timeout only after a traced run identifies "
                "the current payload stage"
            ),
        }
    if log_metadata.get("simdram_entry") or "SimDRAM loaded ELF entry=" in log_text:
        return {
            "stage": "payload_loaded_no_cpu_progress",
            "next_step": "continue or debug the simulator after SimDRAM loads the ELF payload",
        }
    if log_metadata.get("raw_transcript_closed"):
        return {
            "stage": "simulator_attempt_complete",
            "next_step": "inspect the completed smoke transcript for build or simulator failure",
        }
    if LOG.is_file():
        return {
            "stage": "incomplete_attempt",
            "next_step": "rerun the smoke wrapper until raw_transcript_end and exit_code are recorded",
        }
    return {
        "stage": "no_run",
        "next_step": "run scripts/run_chipyard_eliza_linux_smoke.sh with a real OpenSBI/Linux payload",
    }


def write_report(status: str, blockers: list[str], payload: str | None) -> None:
    allow_container_paths = os.environ.get(CONTAINER_PATH_ENV) == "1"
    log_metadata = parse_log_metadata()
    instruction_trace = parse_instruction_trace(payload, log_metadata)
    simulator_artifact = simulator_artifact_metadata()
    log_text = LOG.read_text(encoding="utf-8", errors="replace") if LOG.is_file() else ""
    progress = classify_smoke_progress(log_text, instruction_trace, log_metadata)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report = {
        "schema": "eliza.chipyard_verilator_linux_smoke.v1",
        "status": status,
        "simulator_path": "external/chipyard/sims/verilator",
        "config": CONFIG,
        "config_package": CONFIG_PACKAGE,
        "payload_env": PAYLOAD_ENV,
        "payload": payload or "",
        "log": rel(LOG),
        "log_metadata": log_metadata,
        "instruction_trace": instruction_trace,
        "progress": progress,
        "host": {
            "system": platform.system(),
            "machine": platform.machine(),
        },
        "active_chipyard_containers": active_chipyard_containers(),
        "allow_container_generated_paths": allow_container_paths,
        "generated_driver_makefile": rel(GENERATED_DRIVER_MAKEFILE),
        "simulator_artifact": simulator_artifact,
        "required_log_markers": list(REQUIRED_LOG_MARKERS),
        "next_command": next_command(),
        "blockers": blockers,
        "claim_boundary": (
            "This gate only passes after a real Chipyard Verilator run-binary log "
            "contains OpenSBI and Linux markers from the generated ElizaRocketConfig. "
            "It does not create or substitute boot evidence."
        ),
    }
    tmp = REPORT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(REPORT)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repair-stale-generated",
        action="store_true",
        help=(
            "delete only stale generated Verilator driver outputs so the next "
            "Chipyard build regenerates host-correct absolute paths"
        ),
    )
    parser.add_argument(
        "--repair-incomplete-attempt",
        action="store_true",
        help="archive an interrupted smoke log only when no smoke runner owns the lock",
    )
    args = parser.parse_args()
    if args.repair_incomplete_attempt:
        return repair_incomplete_attempt()
    if args.repair_stale_generated:
        return repair_stale_generated_paths()

    blockers: list[str] = []
    log_metadata = parse_log_metadata()
    payload = os.environ.get(PAYLOAD_ENV)
    payload_source = "env"
    if not payload:
        logged_payload = log_metadata.get("payload")
        if isinstance(logged_payload, str):
            mapped_payload = host_path_from_log(logged_payload)
            if mapped_payload is not None:
                payload = str(mapped_payload)
                payload_source = "log"
    if not payload:
        for candidate in locate_chipyard_linux_payload.candidate_paths([], defaults=True):
            info, _error = locate_chipyard_linux_payload.read_elf_info(candidate)
            if info and info.runnable:
                payload = str(info.path)
                payload_source = "locator"
                break

    if not SIM_DIR.is_dir():
        blockers.append(f"missing Chipyard Verilator directory: {rel(SIM_DIR)}")

    blockers.extend(generated_path_blockers())
    simulator_metadata = simulator_artifact_metadata()
    blockers.extend(simulator_artifact_blockers(simulator_metadata))

    for artifact in REQUIRED_GENERATED_ARTIFACTS:
        if not artifact.is_file():
            blockers.append(f"missing generated Verilog artifact: {rel(artifact)}")

    if not payload:
        blockers.append(
            f"{PAYLOAD_ENV} is unset, {rel(LOG)} does not record a replayable payload, "
            "and no FireMarshal OpenSBI/Linux ELF payload was found; run "
            "python3 scripts/locate_chipyard_linux_payload.py --require for build guidance"
        )
    elif not Path(payload).is_file():
        blockers.append(
            f"{PAYLOAD_ENV} {payload_source} payload does not point to a file: {payload}"
        )

    instruction_trace = parse_instruction_trace(payload, log_metadata)
    log_text = ""
    if not LOG.is_file():
        blockers.append(f"missing Verilator OpenSBI/Linux smoke log: {rel(LOG)}")
    else:
        log_text = LOG.read_text(encoding="utf-8", errors="replace")
        if "eliza-evidence: raw_transcript_begin" in log_text and not log_metadata.get(
            "raw_transcript_closed"
        ):
            blockers.append(
                f"{rel(LOG)} has raw_transcript_begin but lacks raw_transcript_end; "
                "the smoke attempt was interrupted before the wrapper recorded a complete result"
            )
        lines_after_end = log_metadata.get("lines_after_raw_transcript_end")
        if isinstance(lines_after_end, int) and lines_after_end:
            blockers.append(
                f"{rel(LOG)} contains {lines_after_end} non-empty line(s) after "
                "raw_transcript_end; timeout handling allowed simulator output to outlive "
                "the evidence wrapper"
            )
        fatal_errors = log_metadata.get("fatal_errors")
        if isinstance(fatal_errors, list):
            for fatal_error in fatal_errors:
                blockers.append(f"{rel(LOG)} records build fatal error: {fatal_error}")
        exceptions = log_metadata.get("exceptions")
        if isinstance(exceptions, list):
            for exception in exceptions:
                blockers.append(f"{rel(LOG)} records generator exception: {exception}")
        sim_failures = log_metadata.get("sim_failures")
        if isinstance(sim_failures, list):
            for sim_failure in sim_failures:
                hint = ""
                if "timeout" in sim_failure and "max_core_cycles" not in log_text:
                    hint = (
                        "; pass +max_core_cycles=0 or a larger value through "
                        "CHIPYARD_LINUX_SMOKE_EXTRA_SIM_FLAGS"
                    )
                blockers.append(f"{rel(LOG)} records simulator failure: {sim_failure}{hint}")
        exit_code = log_metadata.get("exit_code")
        if exit_code and exit_code != "0":
            reason = f"{rel(LOG)} records simulator wrapper exit_code={exit_code}"
            timeout_after = log_metadata.get("timeout_after_seconds")
            if timeout_after:
                reason += f" after timeout_after_seconds={timeout_after}"
            blockers.append(reason)
        last_progress = log_metadata.get("last_progress_marker")
        if last_progress and not any(marker in log_text for marker in REQUIRED_LOG_MARKERS):
            blockers.append(f"last simulator progress before missing boot markers: {last_progress}")
        trace_is_fresh = bool(instruction_trace.get("fresh_for_log"))
        if instruction_trace.get("exists") and not trace_is_fresh:
            blockers.append(
                "instruction trace is older than the current smoke log; rerun "
                "with CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary for fresh PC evidence: "
                f"{instruction_trace.get('path')}"
            )
        if (
            trace_is_fresh
            and instruction_trace.get("bootrom_to_payload_handoff")
            and not any(marker in log_text for marker in REQUIRED_LOG_MARKERS)
        ):
            blockers.append(
                "instruction trace proves CPU forward progress through boot ROM "
                f"to payload: first_pc={instruction_trace.get('first_pc')} "
                f"last_pc={instruction_trace.get('last_pc')} "
                f"last_symbol={instruction_trace.get('last_symbol') or 'unknown'} "
                f"retired={instruction_trace.get('retired_instruction_count')} "
                f"trace={instruction_trace.get('path')}"
            )
        for marker in REQUIRED_LOG_MARKERS:
            if marker not in log_text:
                blockers.append(f"{rel(LOG)} lacks required marker: {marker}")
        if "OpenSBI" in log_text and not has_accepted_opensbi_markers(log_text):
            blockers.append(
                f"{rel(LOG)} has an OpenSBI banner but lacks accepted OpenSBI handoff markers: "
                + ", ".join(OPENSBI_ACCEPTANCE_MARKERS)
            )
        if "Linux version" in log_text and not has_accepted_linux_markers(log_text):
            blockers.append(
                f"{rel(LOG)} has a Linux banner but lacks accepted Linux boot markers: "
                + ", ".join(LINUX_ACCEPTANCE_MARKERS)
            )

    progress = classify_smoke_progress(log_text, instruction_trace, log_metadata)
    if blockers:
        write_report("blocked", blockers, payload)
        print(f"STATUS: BLOCKED chipyard.verilator_linux_smoke.{progress['stage']}")
        print(f"  simulator_path: {rel(SIM_DIR)}")
        print(f"  progress_stage: {progress['stage']}")
        print(f"  next_progress_step: {progress['next_step']}")
        print(f"  next_command: {next_command()}")
        for blocker in blockers:
            print(f"  - {blocker}")
        return 2

    write_report("pass", [], payload)
    print("STATUS: PASS chipyard.verilator_linux_smoke")
    print(f"  simulator_path: {rel(SIM_DIR)}")
    print(f"  progress_stage: {progress['stage']}")
    print(f"  log: {rel(LOG)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
