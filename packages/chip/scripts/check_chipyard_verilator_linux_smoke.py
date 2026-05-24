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
import shlex
import shutil
import stat
import subprocess
import time
from pathlib import Path

import locate_chipyard_linux_payload
import repair_chipyard_generated_paths
from cpu_ap_evidence_lib import reconstruct_uart_tx_text

ROOT = Path(__file__).resolve().parents[1]
CHECKOUT = ROOT / "external/chipyard"
SIM_DIR = CHECKOUT / "sims/verilator"
OUT_DIR = ROOT / "build/chipyard/eliza_rocket"
REPORT = OUT_DIR / "verilator-linux-smoke.json"
REPORT_MIRROR = ROOT / "build/reports/chipyard_verilator_linux_smoke.json"
LOG = OUT_DIR / "verilator-linux-smoke.log"
LOCK_DIR = OUT_DIR / "verilator-linux-smoke.lock"
CONFIG = "ElizaRocketConfig"
CONFIG_PACKAGE = "eliza"
PAYLOAD_ENV = "CHIPYARD_LINUX_BINARY"
LARGE_LOG_SAMPLE_HEAD_BYTES = 4 * 1024 * 1024
LARGE_LOG_SAMPLE_TAIL_BYTES = 64 * 1024 * 1024
LARGE_LOG_FULL_READ_LIMIT_BYTES = (
    LARGE_LOG_SAMPLE_HEAD_BYTES + LARGE_LOG_SAMPLE_TAIL_BYTES
)

REQUIRED_GENERATED_ARTIFACTS = (
    OUT_DIR / "eliza_rocket_ap.v",
    OUT_DIR / "generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.fir",
    OUT_DIR / "generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.dts",
    OUT_DIR / "ElizaRocketConfig.manifest.json",
)
REQUIRED_LOG_MARKERS = ("OpenSBI/SBI handoff", "Linux version")
OPENSBI_MARKERS = ("OpenSBI", "SBI specification", "Domain0 Next Address", "Boot HART ID")
OPENSBI_ACCEPTANCE_MARKERS = ("SBI specification", "Domain0 Next Address", "Boot HART ID")
EXPECTED_OPENSBI_FDT_ADDR = 0x88000000
EXPECTED_KERNEL_ENTRY = 0x80200000
DRAM_BASE = 0x80000000
DRAM_SIZE = 0x10000000
DRAM_END = DRAM_BASE + DRAM_SIZE
KERNEL_LOW_WINDOW_BYTES = 64 * 1024 * 1024
LINUX_MARKERS = (
    "Linux version",
    "Kernel command line:",
    "Forcing kernel command line to:",
    "Freeing unused kernel",
    "Run /init as init process",
    "initramfs",
)
LINUX_ACCEPTANCE_MARKERS = (
    "Kernel command line:",
    "Forcing kernel command line to:",
    "Freeing unused kernel",
    "Run /init as init process",
    "initramfs",
)
PROGRESS_MARKERS = (
    "SimDRAM loaded ELF entry=",
    "SimDRAM loading ELF ",
    "[UART] UART0 is here",
    "OpenSBI v",
    "Linux version",
    "Machine model:",
    "Domain0 Next Address",
    "Forcing kernel command line to:",
    "SBI specification",
    "SBI implementation ID=",
    "SBI TIME extension detected",
    "SBI IPI extension detected",
    "SBI RFENCE extension detected",
    "SBI SRST extension detected",
    "earlycon:",
    "printk: bootconsole",
    "Kernel panic - not syncing",
    "OF: reserved mem:",
    "Zone ranges:",
    "Early memory node ranges",
    "Initmem setup node",
    "SBI HSM extension detected",
    "riscv: base ISA extensions",
    "riscv: ELF capabilities",
    "percpu:",
    "Kernel command line:",
    "random: crng init done",
    "Dentry cache hash table entries:",
    "Inode-cache hash table entries:",
    "Built 1 zonelists",
    "mem auto-init:",
    "Freeing unused kernel",
    "Run /init as init process",
    "initramfs",
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
GENERATED_DTS = OUT_DIR / "generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.dts"
GENERATED_SIMULATOR = SIM_DIR / f"simulator-chipyard.harness-{CONFIG}"
ARCHIVED_SIMULATOR_DIR = OUT_DIR / "simulator"
ARCHIVED_SIMULATOR = ARCHIVED_SIMULATOR_DIR / f"simulator-chipyard.harness-{CONFIG}"
SIMULATOR_CANDIDATES = (GENERATED_SIMULATOR, ARCHIVED_SIMULATOR)
SIM_OUTPUT_DIR = SIM_DIR / "output" / f"chipyard.harness.TestHarness.{CONFIG}"
SIMAXIMEM_SOURCE = CHECKOUT / "generators/rocket-chip/src/main/scala/system/SimAXIMem.scala"
SIMDRAM_SOURCE = CHECKOUT / "generators/testchipip/src/main/resources/testchipip/csrc/SimDRAM.cc"
SIMDRAM_LOADMEM_ENTRY_MARKER = "SimDRAM loaded ELF entry="
FIREMARSHAL_SMOKE_KFRAG = (
    ROOT / "sw/firemarshal/eliza-e1-linux-smoke/eliza-e1-linux-smoke-kfrag"
)
FIREMARSHAL_SMOKE_LINUX_CONFIG = (
    CHECKOUT / "software/firemarshal/images/firechip/eliza-e1-linux-smoke/linux_config"
)
FIREMARSHAL_SMOKE_PAYLOAD = (
    CHECKOUT
    / "software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk"
)
FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST = (
    CHECKOUT
    / "software/firemarshal/images/firechip/eliza-e1-linux-smoke/payload_freshness_manifest.json"
)
FIREMARSHAL_SMOKE_JSON = ROOT / "sw/firemarshal/eliza-e1-linux-smoke.json"
FIREMARSHAL_SMOKE_DIR = ROOT / "sw/firemarshal/eliza-e1-linux-smoke"
FIREMARSHAL_SMOKE_WORKLOAD = FIREMARSHAL_SMOKE_DIR / "eliza-e1-linux-smoke.sh"
FIREMARSHAL_HWPROBE_BUILD_SCRIPT = FIREMARSHAL_SMOKE_DIR / "build-hwprobe.sh"
FIREMARSHAL_HWPROBE_SOURCE = FIREMARSHAL_SMOKE_DIR / "eliza-riscv-hwprobe.c"
FIREMARSHAL_HWPROBE_BINARY = FIREMARSHAL_SMOKE_DIR / "eliza-riscv-hwprobe"
FIREMARSHAL_NPU_ML_SMOKE_BINARY = FIREMARSHAL_SMOKE_DIR / "e1-npu-ml-smoke"
BOOTROM_RV64_IMAGE = (
    CHECKOUT / "generators/testchipip/src/main/resources/testchipip/bootrom/bootrom.rv64.img"
)
ABSTRACT_CONFIG_SOURCE = CHECKOUT / "generators/chipyard/src/main/scala/config/AbstractConfig.scala"
GENERATED_METADATA_PATTERNS = repair_chipyard_generated_paths.GENERATED_METADATA_PATTERNS
STALE_ABSOLUTE_ROOTS = ("/work/", "/workspace/", "/__w/")
TRACE_LINE_RE = re.compile(
    r"^C(?P<hart>\d+):\s+(?P<cycle>\d+)\s+\[(?P<valid>[01])\]\s+pc=\[(?P<pc>[0-9a-fA-F]+)\]"
)
OPENSBI_DOMAIN_FIELD_RE = re.compile(
    r"^\s*(Domain0 Next (?:Address|Arg1|Mode))\s*:\s*(?P<value>\S+)",
    re.MULTILINE,
)
OBJDUMP_CANDIDATES = (
    ROOT / "build/riscv-chipyard-prefix/bin/riscv64-unknown-elf-objdump",
    ROOT / "tools/bin/riscv64-linux-gnu-objdump",
    ROOT / "tools/bin/llvm-objdump",
    ROOT / "external/riscv64-linux-gnu/usr/bin/riscv64-linux-gnu-objdump",
)
OBJDUMP_LIBRARY_DIRS = (
    ROOT / "external/riscv64-linux-gnu/usr/lib/x86_64-linux-gnu",
    ROOT / "external/riscv64-linux-gnu/usr/lib",
    ROOT / "tools/lib",
)
SYMBOL_LINE_RE = re.compile(
    r"^(?P<addr>[0-9a-fA-F]{8,16})\s+\S+\s+\S+\s+(?P<section>\S+)\s+"
    r"(?P<size>[0-9a-fA-F]{8,16})\s+(?P<name>\S+)$"
)
GENERATED_MODEL_FAILURE_PATTERNS = (
    re.compile(r"No rule to make target .*(?:mm|VTestDriver)[^\s]*\.(?:d|mk|cpp|h)"),
    re.compile(
        r"fatal error: .*(?:mm|VTestDriver)[^\s]*\.(?:d|mk|cpp|h): "
        r"No such file or directory"
    ),
    re.compile(r"No such file or directory.*(?:mm|VTestDriver)[^\s]*\.(?:d|mk|cpp|h)"),
)


def read_text_sample(path: Path) -> str:
    """Read all of a normal text file, or head+tail for huge verbose logs."""
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    if size <= LARGE_LOG_FULL_READ_LIMIT_BYTES:
        return path.read_text(encoding="utf-8", errors="replace")
    with path.open("rb") as handle:
        head = handle.read(LARGE_LOG_SAMPLE_HEAD_BYTES)
        handle.seek(max(0, size - LARGE_LOG_SAMPLE_TAIL_BYTES))
        tail = handle.read(LARGE_LOG_SAMPLE_TAIL_BYTES)
    omitted = size - len(head) - len(tail)
    marker = (
        f"\n[eliza-checker: omitted {omitted} bytes from middle of large log "
        f"{rel(path)}]\n"
    ).encode()
    return (head + marker + tail).decode("utf-8", errors="replace")
KERNEL_PANIC_MARKERS = ("Kernel panic - not syncing", "panic - not syncing")
TESTDRIVER_SUCCESS_FINISH_MARKER = "TestDriver.v:158: Verilog $finish"
SIM_RUNTIME_MARKERS = (
    "SimDRAM loading ELF ",
    SIMDRAM_LOADMEM_ENTRY_MARKER,
    "[UART] UART0 is here",
    "DRAMSim2 Clock Frequency",
    "OpenSBI",
    "Linux version",
)
DTC_CANDIDATES = (
    ROOT / "tools/bin/dtc",
    ROOT / "external/deb-tools/dtc/usr/bin/dtc",
)
ACTIVE_SMOKE_PROCESS_MARKERS = (
    "run_chipyard_eliza_linux_smoke.sh",
    "chipyard-generated-ap-linux-smoke",
    "run-binary-fast",
    "run-binary",
    f"simulator-chipyard.harness-{CONFIG}",
)
FDT_LOOP_SYMBOLS = {
    "fdt_offset_ptr",
    "fdt_next_tag",
    "fdt_string",
    "fdt_get_string",
    "fdt_check_header",
    "fdt_next_node",
    "sbi_memchr",
    "sbi_memcmp",
    "sbi_strncmp",
}
FDT_LOOP_RETIRED_THRESHOLD = 5_000_000
FDT_LOOP_CYCLE_THRESHOLD = 5_000_000


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def newest_simulator_mtime(metadata: dict[str, object]) -> float:
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
    return max(
        (
            float(candidate.get("mtime") or 0.0)
            for candidate in existing
            if isinstance(candidate.get("mtime"), (int, float))
        ),
        default=0.0,
    )


def simdram_source_newer_than_simulator(metadata: dict[str, object] | None = None) -> bool:
    simulator_metadata = metadata if metadata is not None else simulator_artifact_metadata()
    newest_sim_mtime = newest_simulator_mtime(simulator_metadata)
    return (
        SIMDRAM_SOURCE.is_file()
        and newest_sim_mtime > 0.0
        and SIMDRAM_SOURCE.stat().st_mtime > newest_sim_mtime
    )


def config_cmdline(path: Path) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("CONFIG_CMDLINE="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def kfrag_options_missing_from_linux_config(kfrag: Path, linux_config: Path) -> list[str]:
    if not kfrag.is_file() or not linux_config.is_file():
        return []
    built_lines = linux_config.read_text(encoding="utf-8", errors="replace").splitlines()
    built = set(built_lines)
    built_enabled_symbols = {
        line.split("=", 1)[0].strip()
        for line in built_lines
        if line.strip().startswith("CONFIG_") and "=" in line
    }
    missing: list[str] = []
    for line in kfrag.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        unset_match = re.fullmatch(r"# (CONFIG_[A-Za-z0-9_]+) is not set", stripped)
        if unset_match:
            symbol = unset_match.group(1)
            if stripped in built or symbol not in built_enabled_symbols:
                continue
        if stripped not in built:
            missing.append(stripped)
    return missing


def firemarshal_payload_config_blockers() -> list[str]:
    blockers: list[str] = []
    if not FIREMARSHAL_SMOKE_KFRAG.is_file():
        return blockers
    workload_json: dict[str, object] = {}
    if not FIREMARSHAL_SMOKE_JSON.is_file():
        blockers.append(
            "preferred FireMarshal eliza-e1 Linux smoke workload JSON is missing: "
            f"{rel(FIREMARSHAL_SMOKE_JSON)}"
        )
    else:
        try:
            loaded = json.loads(FIREMARSHAL_SMOKE_JSON.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                workload_json = loaded
            else:
                blockers.append(
                    "preferred FireMarshal eliza-e1 Linux smoke workload JSON must be an object: "
                    f"{rel(FIREMARSHAL_SMOKE_JSON)}"
                )
        except json.JSONDecodeError as exc:
            blockers.append(
                "preferred FireMarshal eliza-e1 Linux smoke workload JSON is invalid: "
                f"{rel(FIREMARSHAL_SMOKE_JSON)}: {exc}"
            )
    if workload_json:
        files = workload_json.get("files")
        file_sources: set[str] = set()
        file_targets: set[str] = set()
        if isinstance(files, list):
            for item in files:
                if (
                    isinstance(item, list)
                    and len(item) >= 2
                    and isinstance(item[0], str)
                    and isinstance(item[1], str)
                ):
                    file_sources.add(item[0])
                    file_targets.add(item[1])
        if workload_json.get("host-init") != "build-hwprobe.sh":
            blockers.append(
                "preferred FireMarshal eliza-e1 Linux smoke workload does not run "
                "build-hwprobe.sh as host-init; generated-AP userspace cannot prove "
                "riscv_hwprobe packaging"
            )
        firmware = workload_json.get("firmware")
        opensbi_args = ""
        if isinstance(firmware, dict) and isinstance(firmware.get("opensbi-build-args"), str):
            opensbi_args = firmware["opensbi-build-args"]
        opensbi_tokens = shlex.split(opensbi_args)
        if "FW_OPTIONS=0" not in opensbi_tokens:
            blockers.append(
                "preferred FireMarshal eliza-e1 Linux smoke workload must build OpenSBI "
                "with FW_OPTIONS=0 so Platform/Domain boot prints remain observable"
            )
        if "FW_PAYLOAD_FDT_ADDR=0x88000000" not in opensbi_tokens:
            blockers.append(
                "preferred FireMarshal eliza-e1 Linux smoke workload must override "
                "FW_PAYLOAD_FDT_ADDR=0x88000000 so OpenSBI copies the boot ROM DTB "
                "to writable DRAM before applying fixups"
            )
        if (
            "eliza-riscv-hwprobe" not in file_sources
            or "/usr/bin/eliza-riscv-hwprobe" not in file_targets
        ):
            blockers.append(
                "preferred FireMarshal eliza-e1 Linux smoke workload does not package "
                "eliza-riscv-hwprobe at /usr/bin/eliza-riscv-hwprobe"
            )
        if "e1-npu-ml-smoke" not in file_sources or "/usr/bin/e1-npu-ml-smoke" not in file_targets:
            blockers.append(
                "preferred FireMarshal eliza-e1 Linux smoke workload does not package "
                "e1-npu-ml-smoke at /usr/bin/e1-npu-ml-smoke"
            )
    for path, label, executable in (
        (FIREMARSHAL_SMOKE_WORKLOAD, "workload script", True),
        (FIREMARSHAL_HWPROBE_BUILD_SCRIPT, "hwprobe host-init build script", True),
        (FIREMARSHAL_HWPROBE_SOURCE, "hwprobe source", False),
        (FIREMARSHAL_HWPROBE_BINARY, "built hwprobe helper", True),
        (FIREMARSHAL_NPU_ML_SMOKE_BINARY, "built NPU ML smoke helper", True),
    ):
        if not path.is_file():
            blockers.append(
                f"preferred FireMarshal eliza-e1 Linux smoke {label} is missing: {rel(path)}"
            )
        elif executable and not os.access(path, os.X_OK):
            blockers.append(
                f"preferred FireMarshal eliza-e1 Linux smoke {label} is not executable: {rel(path)}"
            )
    if not FIREMARSHAL_SMOKE_LINUX_CONFIG.is_file():
        blockers.append(
            "preferred FireMarshal eliza-e1 Linux smoke payload has no built linux_config; "
            "run scripts/build_firemarshal_eliza_linux_smoke_payload.sh before using it "
            "as generated-AP boot evidence"
        )
        return blockers
    missing_kfrag_options = kfrag_options_missing_from_linux_config(
        FIREMARSHAL_SMOKE_KFRAG, FIREMARSHAL_SMOKE_LINUX_CONFIG
    )
    if FIREMARSHAL_SMOKE_PAYLOAD.is_file() and missing_kfrag_options:
        blockers.append(
            "preferred FireMarshal eliza-e1 Linux smoke payload is missing current "
            f"{rel(FIREMARSHAL_SMOKE_KFRAG)} option(s): "
            + ", ".join(missing_kfrag_options[:5])
            + (
                ""
                if len(missing_kfrag_options) <= 5
                else f", +{len(missing_kfrag_options) - 5} more"
            )
            + "; rebuild with "
            "scripts/build_firemarshal_eliza_linux_smoke_payload.sh so the next smoke "
            "uses the current console/debug kernel fragment"
        )
    kfrag_cmdline = config_cmdline(FIREMARSHAL_SMOKE_KFRAG)
    built_cmdline = config_cmdline(FIREMARSHAL_SMOKE_LINUX_CONFIG)
    if kfrag_cmdline and built_cmdline and kfrag_cmdline != built_cmdline:
        blockers.append(
            "preferred FireMarshal eliza-e1 Linux smoke payload kernel cmdline is stale: "
            f"built linux_config has {built_cmdline!r}, source kfrag has {kfrag_cmdline!r}; "
            "rebuild with scripts/build_firemarshal_eliza_linux_smoke_payload.sh before "
            "claiming missing UART markers reflect the current payload"
        )
    if FIREMARSHAL_SMOKE_PAYLOAD.is_file():
        payload_mtime = FIREMARSHAL_SMOKE_PAYLOAD.stat().st_mtime
        freshness_inputs = firemarshal_payload_freshness_inputs()
        newer_inputs = [
            rel(path)
            for path in freshness_inputs
            if path.is_file() and path.stat().st_mtime > payload_mtime
        ]
        if newer_inputs and not firemarshal_payload_freshness_manifest_matches(
            FIREMARSHAL_SMOKE_PAYLOAD,
            FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST,
            freshness_inputs,
        ):
            blockers.append(
                "preferred FireMarshal eliza-e1 Linux smoke payload predates packaged "
                "userspace/helper inputs: "
                + ", ".join(newer_inputs[:6])
                + ("" if len(newer_inputs) <= 6 else f", +{len(newer_inputs) - 6} more")
                + (
                    "; rebuild with scripts/build_firemarshal_eliza_linux_smoke_payload.sh "
                    "so payload_freshness_manifest.json records the exact current "
                    "hwprobe/MMIO/NPU userspace inputs"
                )
            )
    return blockers


def firemarshal_payload_freshness_inputs() -> list[Path]:
    return [
        FIREMARSHAL_SMOKE_JSON,
        FIREMARSHAL_SMOKE_KFRAG,
        FIREMARSHAL_SMOKE_WORKLOAD,
        FIREMARSHAL_HWPROBE_BUILD_SCRIPT,
        FIREMARSHAL_HWPROBE_SOURCE,
        FIREMARSHAL_HWPROBE_BINARY,
        FIREMARSHAL_NPU_ML_SMOKE_BINARY,
    ]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def firemarshal_payload_freshness_manifest_matches(
    payload: Path, manifest: Path, inputs: list[Path]
) -> bool:
    if not payload.is_file() or not manifest.is_file():
        return False
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    if data.get("schema") != "eliza.firemarshal_linux_smoke_payload_freshness.v1":
        return False
    payload_record = data.get("payload")
    if not isinstance(payload_record, dict):
        return False
    if payload_record.get("sha256") != sha256_file(payload):
        return False
    input_records = data.get("inputs")
    if not isinstance(input_records, dict):
        return False
    for path in inputs:
        if not path.is_file():
            return False
        record = input_records.get(rel(path))
        if not isinstance(record, dict):
            return False
        if record.get("sha256") != sha256_file(path):
            return False
    return True


def next_command(payload: str | None = None) -> str:
    payload_value = shlex.quote(payload) if payload else f"${PAYLOAD_ENV}"
    prefix = f"{PAYLOAD_ENV}={payload_value}"
    if simdram_source_newer_than_simulator():
        prefix = (
            f"{prefix} CHIPYARD_LINUX_SMOKE_BREAK_SIM_PREREQ=0 "
            "CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary"
        )
    return f"{prefix} scripts/run_chipyard_eliza_linux_smoke.sh"


def rebuild_blocked_by_active_simulator_users(
    simulator_metadata: dict[str, object],
    active_simulator_users: list[dict[str, object]],
) -> bool:
    return simdram_source_newer_than_simulator(simulator_metadata) and bool(active_simulator_users)


def next_safe_action(
    simulator_metadata: dict[str, object],
    active_simulator_users: list[dict[str, object]],
    active_processes: list[dict[str, object]] | None = None,
    active_attempt: dict[str, object] | None = None,
    payload: str | None = None,
) -> str:
    if active_processes:
        stage = active_attempt.get("stage") if isinstance(active_attempt, dict) else None
        progress = (
            active_attempt.get("last_progress_marker") if isinstance(active_attempt, dict) else None
        )
        detail = f"; active attempt stage={stage}" if stage else ""
        if progress:
            detail += f"; progress={progress}"
        return f"wait for active generated AP Linux smoke to finish{detail}"
    if rebuild_blocked_by_active_simulator_users(simulator_metadata, active_simulator_users):
        users = ", ".join(
            f"pid={user.get('pid')} elapsed={user.get('elapsed')}"
            for user in active_simulator_users[:5]
        )
        extra = (
            "" if len(active_simulator_users) <= 5 else f", +{len(active_simulator_users) - 5} more"
        )
        return (
            "wait for active ElizaRocketConfig simulator user(s) to finish before rebuilding: "
            f"{users}{extra}"
        )
    return next_command(payload)


def progress_with_active_attempt(
    progress: dict[str, str],
    active_processes: list[dict[str, object]],
    active_attempt: dict[str, object],
) -> dict[str, str]:
    if not active_processes:
        return progress
    if progress.get("stage") == "payload_fdt_parse_loop":
        next_step = progress["next_step"] + "; leave the active smoke running for final status"
        return {"stage": "active_payload_fdt_parse_loop", "next_step": next_step}
    if progress.get("stage") == "kernel_virtual_execution_no_console":
        next_step = progress["next_step"] + "; leave the active smoke running for final status"
        return {"stage": "active_kernel_virtual_execution_no_console", "next_step": next_step}
    stage = active_attempt.get("stage") if isinstance(active_attempt, dict) else None
    if not stage:
        return progress
    progress_marker = str(active_attempt.get("last_progress_marker") or "")
    next_step = "wait for the active generated AP Linux smoke wrapper to finish"
    if progress_marker:
        next_step += f"; latest active progress: {progress_marker}"
    return {"stage": str(stage), "next_step": next_step}


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


def is_generated_model_artifact_failure(log_text: str) -> bool:
    return any(pattern.search(log_text) is not None for pattern in GENERATED_MODEL_FAILURE_PATTERNS)


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
    if not payload or pc is None or pc >= 0xFFFF_FFFF_8000_0000:
        return result
    payload_path = Path(payload)
    if not payload_path.is_file():
        return result
    objdump = find_objdump()
    if objdump is None:
        return result
    result["objdump"] = rel(objdump)
    env = os.environ.copy()
    library_dirs = [str(path) for path in OBJDUMP_LIBRARY_DIRS if path.is_dir()]
    if library_dirs:
        current = env.get("LD_LIBRARY_PATH")
        env["LD_LIBRARY_PATH"] = (
            ":".join(library_dirs) if not current else ":".join([*library_dirs, current])
        )
    try:
        proc = subprocess.run(
            [str(objdump), "-t", str(payload_path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
            env=env,
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
            "mtime": None,
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
            candidate["mtime"] = stat_result.st_mtime
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
    if simdram_source_newer_than_simulator(metadata):
        blockers.append(
            "generated simulator artifact predates SimDRAM loadmem instrumentation; "
            "rebuild the ElizaRocketConfig Verilator simulator before claiming "
            "generated-AP Linux boot evidence"
        )
    return blockers


def sim_memory_model_audit() -> dict[str, object]:
    simaxi_text = (
        SIMAXIMEM_SOURCE.read_text(encoding="utf-8", errors="replace")
        if SIMAXIMEM_SOURCE.is_file()
        else ""
    )
    simdram_text = (
        SIMDRAM_SOURCE.read_text(encoding="utf-8", errors="replace")
        if SIMDRAM_SOURCE.is_file()
        else ""
    )
    abstract_text = (
        ABSTRACT_CONFIG_SOURCE.read_text(encoding="utf-8", errors="replace")
        if ABSTRACT_CONFIG_SOURCE.is_file()
        else ""
    )
    simaxi_loader_markers = ("+loadmem=", "load_elf", "loadmem_file")
    return {
        "default_config_memory_path": "WithBlackBoxSimMem/SimDRAM via chipyard.config.AbstractConfig",
        "fast_sim_config_memory_path": "WithSimAXIMem/AXI4RAM",
        "abstract_config": {
            "source": rel(ABSTRACT_CONFIG_SOURCE),
            "exists": ABSTRACT_CONFIG_SOURCE.is_file(),
            "uses_blackbox_simmem": "WithBlackBoxSimMem" in abstract_text,
        },
        "simdram": {
            "source": rel(SIMDRAM_SOURCE),
            "exists": SIMDRAM_SOURCE.is_file(),
            "supports_plus_loadmem": "+loadmem=" in simdram_text,
            "loads_elf": "load_elf" in simdram_text,
            "emits_loadmem_entry_marker": SIMDRAM_LOADMEM_ENTRY_MARKER in simdram_text,
            "has_no_dramsim_magic_memory_fallback": "mm_magic_t" in simdram_text,
            "has_dramsim_model": "mm_dramsim2_t" in simdram_text,
        },
        "simaximem": {
            "source": rel(SIMAXIMEM_SOURCE),
            "exists": SIMAXIMEM_SOURCE.is_file(),
            "uses_axi4ram": "AXI4RAM" in simaxi_text,
            "supports_plus_loadmem": any(marker in simaxi_text for marker in simaxi_loader_markers),
        },
        "claim_boundary": (
            "Generated AP Linux/userland proof must use the default ElizaRocketConfig "
            "SimDRAM path, with or without +dramsim. ElizaRocketFastSimConfig is "
            "experimental until an ELF/loadmem-equivalent preload path exists for "
            "SimAXIMem/AXI4RAM and reaches the same boot markers."
        ),
    }


def find_dtc() -> Path | None:
    for candidate in DTC_CANDIDATES:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("dtc")
    return Path(found) if found else None


def generated_fdt_audit(dts_path: Path = GENERATED_DTS) -> dict[str, object]:
    text = dts_path.read_text(encoding="utf-8", errors="replace") if dts_path.is_file() else ""
    dtc = find_dtc()
    dtc_status = "not_run"
    dtc_output = ""
    dtb_size_bytes: int | None = None
    if dts_path.is_file() and dtc is not None:
        out = OUT_DIR / "generated-src" / f"{dts_path.stem}.audit.dtb"
        try:
            completed = subprocess.run(
                [str(dtc), "-I", "dts", "-O", "dtb", "-o", str(out), str(dts_path)],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=20,
            )
            dtc_status = "pass" if completed.returncode == 0 else "fail"
            dtc_output = completed.stdout.strip()
            if out.is_file():
                dtb_size_bytes = out.stat().st_size
        except (OSError, subprocess.TimeoutExpired) as exc:
            dtc_status = "error"
            dtc_output = str(exc)
    bootrom_size = BOOTROM_RV64_IMAGE.stat().st_size if BOOTROM_RV64_IMAGE.is_file() else None
    total_bootrom_dtb_bytes = (
        bootrom_size + dtb_size_bytes
        if bootrom_size is not None and dtb_size_bytes is not None
        else None
    )
    required_tokens = {
        "root_compatible": 'compatible = "ucb-bar,chipyard-dev"' in text,
        "chosen_stdout": "stdout-path" in text and "serial@10001000" in text,
        "bootargs_console": "bootargs" in text and "console=" in text,
        "cpu_node": "cpu@0" in text and 'device_type = "cpu"' in text,
        "riscv_isa": "riscv,isa" in text,
        "memory_dram": "memory@80000000" in text,
        "clint": "clint@2000000" in text and "riscv,clint0" in text,
        "plic": "interrupt-controller@c000000" in text and "riscv,plic0" in text,
        "uart": "serial@10001000" in text and "sifive,uart0" in text,
        "npu": "npu@10020000" in text and "eliza,e1-npu" in text,
        "dma": "dma@10010000" in text and "eliza,e1-dma" in text,
        "display": "display@10030000" in text and "eliza,e1-display" in text,
    }
    return {
        "path": rel(dts_path),
        "exists": dts_path.is_file(),
        "size_bytes": dts_path.stat().st_size if dts_path.is_file() else None,
        "dtc": rel(dtc) if dtc is not None else "",
        "dtc_status": dtc_status,
        "dtc_output": dtc_output,
        "dtb_size_bytes": dtb_size_bytes,
        "bootrom_image": rel(BOOTROM_RV64_IMAGE),
        "bootrom_size_bytes": bootrom_size,
        "bootrom_plus_dtb_bytes": total_bootrom_dtb_bytes,
        "bootrom_region_size_bytes": 0x10000,
        "fits_bootrom_region": (
            total_bootrom_dtb_bytes is not None and total_bootrom_dtb_bytes <= 0x10000
        ),
        "expected_opensbi_payload_fdt_addr": f"0x{EXPECTED_OPENSBI_FDT_ADDR:08x}",
        "expected_opensbi_payload_fdt_addr_in_dram": (
            DRAM_BASE <= EXPECTED_OPENSBI_FDT_ADDR < DRAM_END
        ),
        "expected_opensbi_payload_fdt_addr_fits_dram": (
            dtb_size_bytes is not None
            and DRAM_BASE <= EXPECTED_OPENSBI_FDT_ADDR
            and EXPECTED_OPENSBI_FDT_ADDR + dtb_size_bytes <= DRAM_END
        ),
        "expected_kernel_entry": f"0x{EXPECTED_KERNEL_ENTRY:08x}",
        "expected_opensbi_payload_fdt_addr_clear_of_kernel_low_window": not (
            EXPECTED_KERNEL_ENTRY
            <= EXPECTED_OPENSBI_FDT_ADDR
            < EXPECTED_KERNEL_ENTRY + KERNEL_LOW_WINDOW_BYTES
        ),
        "required_tokens": required_tokens,
        "missing_required_tokens": [
            name for name, present in required_tokens.items() if not present
        ],
    }


def parse_opensbi_domain_handoff(text: str, dtb_size_bytes: int | None = None) -> dict[str, object]:
    fields = {
        match.group(1): match.group("value")
        for match in OPENSBI_DOMAIN_FIELD_RE.finditer(text)
    }

    def parse_hex(value: str | None) -> int | None:
        if not value or not value.startswith("0x"):
            return None
        try:
            return int(value, 16)
        except ValueError:
            return None

    next_addr = parse_hex(fields.get("Domain0 Next Address"))
    next_arg1 = parse_hex(fields.get("Domain0 Next Arg1"))
    fdt_fits_dram = (
        next_arg1 is not None
        and dtb_size_bytes is not None
        and DRAM_BASE <= next_arg1
        and next_arg1 + dtb_size_bytes <= DRAM_END
    )
    fdt_clear_of_kernel_low_window = (
        next_arg1 is not None
        and next_addr is not None
        and not (next_addr <= next_arg1 < next_addr + KERNEL_LOW_WINDOW_BYTES)
    )
    return {
        "observed": bool(fields),
        "domain0_next_address": fields.get("Domain0 Next Address", ""),
        "domain0_next_arg1": fields.get("Domain0 Next Arg1", ""),
        "domain0_next_mode": fields.get("Domain0 Next Mode", ""),
        "expected_domain0_next_arg1": f"0x{EXPECTED_OPENSBI_FDT_ADDR:016x}",
        "domain0_next_arg1_matches_expected": next_arg1 == EXPECTED_OPENSBI_FDT_ADDR,
        "domain0_next_arg1_in_dram": (
            next_arg1 is not None and DRAM_BASE <= next_arg1 < DRAM_END
        ),
        "domain0_next_arg1_fits_dram": fdt_fits_dram,
        "domain0_next_arg1_clear_of_kernel_low_window": fdt_clear_of_kernel_low_window,
        "expected_domain0_next_address": f"0x{EXPECTED_KERNEL_ENTRY:016x}",
        "domain0_next_address_matches_expected": next_addr == EXPECTED_KERNEL_ENTRY,
        "bounded_bad_dtb_fix": (
            "If Linux still receives a bad DTB with this handoff, keep FW_PAYLOAD_FDT_ADDR "
            "in writable DRAM and regenerate only the generated DTS/BootROM DTB collateral; "
            "do not preserve the ROM a1 pointer because OpenSBI mutates the FDT during fixups."
        ),
    }


def has_marker_group(text: str, required: tuple[str, ...], any_of: tuple[str, ...]) -> bool:
    return all(marker in text for marker in required) and any(marker in text for marker in any_of)


def observable_boot_text(text: str) -> str:
    reconstructed = reconstruct_uart_tx_text(text)
    if not reconstructed:
        return text
    return "\n".join((text, reconstructed))


def has_accepted_opensbi_markers(text: str) -> bool:
    return has_marker_group(text, ("OpenSBI",), OPENSBI_ACCEPTANCE_MARKERS) or has_marker_group(
        text,
        ("SBI specification",),
        ("SBI implementation ID=0x1", "SBI TIME extension detected", "SBI SRST extension detected"),
    )


def has_accepted_linux_markers(text: str) -> bool:
    return has_marker_group(text, ("Linux version",), LINUX_ACCEPTANCE_MARKERS)


def has_kernel_panic(text: str) -> bool:
    return any(marker in text for marker in KERNEL_PANIC_MARKERS)


def has_simulator_success_finish(text: str, log_metadata: dict[str, object]) -> bool:
    sim_success_finishes = log_metadata.get("sim_success_finishes")
    return (
        isinstance(sim_success_finishes, list)
        and bool(sim_success_finishes)
        and "Assertion failed in TestDriver" not in text
        and "Verilog $stop" not in text
    )


def has_quiet_linux_completion_evidence(
    text: str, log_metadata: dict[str, object], payload: str | None
) -> bool:
    payload_text = payload or str(
        log_metadata.get("payload") or log_metadata.get("binary_arg") or ""
    )
    if "linux-poweroff-quiet" not in payload_text:
        return False
    quiet_completion_logs = log_metadata.get("quiet_linux_completion_logs")
    if isinstance(quiet_completion_logs, list) and quiet_completion_logs:
        return True
    return has_simulator_success_finish(text, log_metadata) and not has_kernel_panic(text)


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
    log_text = read_text_sample(LOG)
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


def sim_output_log_for_payload(payload: str | None) -> Path | None:
    if not payload:
        return None
    return SIM_OUTPUT_DIR / f"{Path(payload).name}.log"


def collect_quiet_linux_completion_logs() -> list[dict[str, object]]:
    evidence: list[dict[str, object]] = []
    if not SIM_OUTPUT_DIR.is_dir():
        return evidence
    for sim_log in sorted(SIM_OUTPUT_DIR.glob("*linux-poweroff-quiet*.log")):
        try:
            text = sim_log.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if TESTDRIVER_SUCCESS_FINISH_MARKER not in text:
            continue
        if (
            has_kernel_panic(text)
            or "Assertion failed in TestDriver" in text
            or "Verilog $stop" in text
        ):
            continue
        if not has_accepted_linux_markers(text):
            continue
        if not has_accepted_opensbi_markers(text) and "earlycon:" not in text:
            continue
        finish_line = next(
            (
                line.strip()
                for line in text.splitlines()
                if TESTDRIVER_SUCCESS_FINISH_MARKER in line
            ),
            TESTDRIVER_SUCCESS_FINISH_MARKER,
        )
        evidence.append(
            {
                "path": rel(sim_log),
                "finish": finish_line,
                "size_bytes": sim_log.stat().st_size,
                "mtime": sim_log.stat().st_mtime,
            }
        )
    return evidence


def process_rows_from_ps(stdout: str) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for line in stdout.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) != 4:
            continue
        pid_text, ppid_text, elapsed, command = parts
        with contextlib.suppress(ValueError):
            rows.append(
                {
                    "pid": int(pid_text),
                    "ppid": int(ppid_text),
                    "elapsed": elapsed,
                    "command": command,
                }
            )
    return rows


def active_chipyard_smoke_processes() -> list[dict[str, object]]:
    try:
        completed = subprocess.run(
            ["ps", "-eo", "pid,ppid,etime,cmd"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    active: list[dict[str, object]] = []
    for row in process_rows_from_ps(completed.stdout):
        command = str(row.get("command") or "")
        if "check_chipyard_verilator_linux_smoke.py" in command:
            continue
        if not any(marker in command for marker in ACTIVE_SMOKE_PROCESS_MARKERS):
            continue
        if (
            "eliza-e1-linux-smoke" not in command
            and "chipyard-generated-ap-linux-smoke" not in command
            and "run_chipyard_eliza_linux_smoke.sh" not in command
        ):
            continue
        active.append(row)
    return active


def active_simulator_artifact_users(
    candidates: tuple[Path, ...] = SIMULATOR_CANDIDATES,
    ps_stdout: str | None = None,
) -> list[dict[str, object]]:
    if ps_stdout is None:
        try:
            completed = subprocess.run(
                ["ps", "-eo", "pid,ppid,etime,cmd"],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        ps_stdout = completed.stdout
    candidate_texts = {str(path) for path in candidates}
    candidate_texts.update(str(path.resolve()) for path in candidates)
    users: list[dict[str, object]] = []
    own_pid = os.getpid()
    for row in process_rows_from_ps(ps_stdout):
        if row.get("pid") == own_pid:
            continue
        command = str(row.get("command") or "")
        matched = sorted(path for path in candidate_texts if path and path in command)
        if not matched:
            continue
        users.append({**row, "matched_simulator_paths": matched})
    return users


def progress_metadata_for_text(path: Path, text: str) -> dict[str, object]:
    last_progress = ""
    sim_failures: list[str] = []
    sim_success_finishes: list[str] = []
    observable_text = observable_boot_text(text)
    for line in observable_text.splitlines():
        if any(marker in line for marker in PROGRESS_MARKERS):
            last_progress = clean_progress_marker(line)
        if (
            "*** FAILED ***" in line
            or "Assertion failed in TestDriver" in line
            or "Verilog $stop" in line
        ):
            sim_failures.append(line.strip())
        if TESTDRIVER_SUCCESS_FINISH_MARKER in line:
            sim_success_finishes.append(line.strip())
            last_progress = line.strip()
    return {
        "path": rel(path),
        "exists": True,
        "size_bytes": path.stat().st_size,
        "mtime": path.stat().st_mtime,
        "last_progress_marker": last_progress,
        "has_opensbi_banner": "OpenSBI" in observable_text,
        "has_opensbi_handoff": has_accepted_opensbi_markers(observable_text),
        "has_linux_banner": "Linux version" in observable_text,
        "has_linux_boot_markers": has_accepted_linux_markers(observable_text),
        "has_kernel_panic": has_kernel_panic(observable_text),
        "sim_failures": sim_failures[-8:],
        "sim_success_finishes": sim_success_finishes[-8:],
    }


def live_sim_output_metadata(
    payload: str | None, log_metadata: dict[str, object]
) -> dict[str, object]:
    candidates: list[Path] = []
    for value in (log_metadata.get("binary_arg"), payload, log_metadata.get("payload")):
        if isinstance(value, str) and value:
            candidate = sim_output_log_for_payload(value)
            if candidate is not None:
                candidates.append(candidate)
    if SIM_OUTPUT_DIR.is_dir():
        candidates.extend(sorted(SIM_OUTPUT_DIR.glob("*eliza-e1-linux-smoke*.log")))
    seen: set[Path] = set()
    logs: list[dict[str, object]] = []
    for candidate in candidates:
        if candidate in seen or not candidate.is_file():
            continue
        seen.add(candidate)
        try:
            text = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        logs.append(progress_metadata_for_text(candidate, text))

    def log_mtime(item: dict[str, object]) -> float:
        value = item.get("mtime")
        return float(value) if isinstance(value, (int, float, str)) else 0.0

    logs.sort(key=log_mtime, reverse=True)
    return {
        "output_dir": rel(SIM_OUTPUT_DIR),
        "logs": logs,
        "latest": logs[0] if logs else None,
    }


def active_attempt_temp_logs(out_dir: Path = OUT_DIR) -> list[Path]:
    if not out_dir.is_dir():
        return []
    return sorted(
        out_dir.glob("verilator-linux-smoke.*.raw.tmp"),
        key=lambda path: path.stat().st_mtime if path.exists() else 0.0,
        reverse=True,
    )


def active_attempt_payload_from_text(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("eliza-evidence: payload=") or line.startswith(
            "eliza-evidence: binary_arg="
        ):
            return line.split("=", 1)[1].strip()
        if "+loadmem=" in line:
            for token in line.split():
                if token.startswith("+loadmem="):
                    return token.split("=", 1)[1].strip()
    return None


def classify_active_attempt_text(
    text: str, instruction_trace: dict[str, object] | None = None
) -> tuple[str, str]:
    observable_text = observable_boot_text(text)
    if (
        instruction_trace
        and instruction_trace.get("entered_kernel_virtual")
        and not has_accepted_opensbi_markers(observable_text)
        and "Linux version" not in observable_text
    ):
        last_pc = instruction_trace.get("last_pc") or "unknown"
        retired = instruction_trace.get("retired_instruction_count") or 0
        return (
            "active_kernel_virtual_execution_no_console",
            f"kernel virtual execution without console: last_pc={last_pc} retired={retired}",
        )
    if simulator_log_reached_runtime(text):
        progress = ""
        for line in observable_text.splitlines():
            if any(marker in line for marker in PROGRESS_MARKERS):
                progress = clean_progress_marker(line)
        return "simulator_runtime_in_progress", progress
    if "VTestDriver.mk" in text or "verilator " in text or "verilator_bin" in text:
        compile_unit = ""
        for line in text.splitlines():
            if " -c " not in line:
                continue
            for token in line.split():
                if token.endswith((".cpp", ".cc", ".cxx", ".o")):
                    compile_unit = Path(token).name
        progress = (
            f"Verilator model compile in progress: {compile_unit}"
            if compile_unit
            else "Verilator model compile in progress"
        )
        return "simulator_rebuild_in_progress", progress
    if "chipyard.Generator" in text or "firtool" in text or "ExportSplitVerilog" in text:
        return "chipyard_generation_in_progress", "Chipyard generator/firtool in progress"
    if "sbt-launch.jar" in text or ".classpath_cache/chipyard.jar" in text:
        return "chipyard_sbt_assembly_in_progress", "Chipyard sbt assembly in progress"
    if text:
        return "wrapper_command_in_progress", "wrapper command started"
    return "wrapper_waiting_for_output", ""


def active_smoke_attempt_metadata(out_dir: Path = OUT_DIR) -> dict[str, object]:
    for raw_log in active_attempt_temp_logs(out_dir):
        try:
            text = read_text_sample(raw_log)
        except OSError:
            continue
        payload = active_attempt_payload_from_text(text)
        trace = trace_metadata_template(raw_log)
        trace["exists"] = True
        trace["fresh_for_log"] = True
        trace = parse_trace_text(raw_log, text, payload, trace)
        stage, progress = classify_active_attempt_text(text, trace)
        return {
            "path": rel(raw_log),
            "exists": True,
            "size_bytes": raw_log.stat().st_size,
            "mtime": raw_log.stat().st_mtime,
            "stage": stage,
            "last_progress_marker": progress,
            "reached_simulator_runtime": simulator_log_reached_runtime(text),
            "payload": payload,
            "entered_bootrom": trace.get("entered_bootrom"),
            "entered_payload": trace.get("entered_payload"),
            "entered_kernel_virtual": trace.get("entered_kernel_virtual"),
            "bootrom_to_payload_handoff": trace.get("bootrom_to_payload_handoff"),
            "first_pc": trace.get("first_pc"),
            "first_payload_pc": trace.get("first_payload_pc"),
            "first_payload_cycle": trace.get("first_payload_cycle"),
            "last_pc": trace.get("last_pc"),
            "last_cycle": trace.get("last_cycle"),
            "retired_instruction_count": trace.get("retired_instruction_count"),
            "last_symbol": trace.get("last_symbol"),
            "last_symbol_offset": trace.get("last_symbol_offset"),
            "last_symbol_address": trace.get("last_symbol_address"),
            "last_symbol_objdump": trace.get("last_symbol_objdump"),
        }
    return {"exists": False}


def append_sim_output_markers(
    path: Path,
    metadata: dict[str, object],
    *,
    include_failures: bool,
) -> str:
    last_progress = ""
    if not path.is_file():
        return last_progress
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if any(marker in line for marker in PROGRESS_MARKERS):
            last_progress = clean_progress_marker(line)
        if include_failures and (
            "*** FAILED ***" in line
            or "Assertion failed in TestDriver" in line
            or "Verilog $stop" in line
        ):
            sim_failures = metadata["sim_failures"]
            if isinstance(sim_failures, list):
                sim_failures.append(line.strip())
        if TESTDRIVER_SUCCESS_FINISH_MARKER in line:
            sim_success_finishes = metadata["sim_success_finishes"]
            if isinstance(sim_success_finishes, list):
                sim_success_finishes.append(line.strip())
            last_progress = line
    return last_progress


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
        "disable_dramsim": None,
        "trace_verbose": None,
        "extra_sim_flags": None,
        "raw_transcript_closed": False,
        "lines_after_raw_transcript_end": 0,
        "fatal_errors": [],
        "exceptions": [],
        "kernel_panics": [],
        "sim_failures": [],
        "sim_passes": [],
        "sim_success_finishes": [],
        "quiet_linux_completion_logs": [],
        "simdram_entry": None,
        "simdram_load_range": None,
        "last_progress_marker": "",
    }
    last_progress = ""
    quiet_completion_logs = collect_quiet_linux_completion_logs()
    metadata["quiet_linux_completion_logs"] = quiet_completion_logs
    metadata["last_progress_marker"] = last_progress
    if not LOG.is_file():
        return metadata

    raw_transcript_closed = False
    lines_after_raw_transcript_end = 0
    log_text = read_text_sample(LOG)
    for line in log_text.splitlines():
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
        elif line.startswith("eliza-evidence: disable_dramsim="):
            metadata["disable_dramsim"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: trace_verbose="):
            metadata["trace_verbose"] = line.split("=", 1)[1].strip()
        elif line.startswith("eliza-evidence: extra_sim_flags="):
            metadata["extra_sim_flags"] = line.split("=", 1)[1].strip()
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
            last_progress = clean_progress_marker(line)
        if "fatal error:" in line or "%Fatal:" in line:
            fatal_errors = metadata["fatal_errors"]
            if isinstance(fatal_errors, list):
                fatal_errors.append(line.strip())
        if any(marker in line for marker in KERNEL_PANIC_MARKERS):
            kernel_panics = metadata["kernel_panics"]
            if isinstance(kernel_panics, list):
                kernel_panics.append(line.strip())
        if (
            "Exception in thread" in line
            or line.strip().startswith("Caused by:")
            or "NoSuchFileException" in line
        ):
            exceptions = metadata["exceptions"]
            if isinstance(exceptions, list):
                exceptions.append(line.strip())
        if (
            "*** FAILED ***" in line
            or "Assertion failed in TestDriver" in line
            or "Verilog $stop" in line
        ):
            sim_failures = metadata["sim_failures"]
            if isinstance(sim_failures, list):
                sim_failures.append(line.strip())
        if "*** PASSED ***" in line:
            sim_passes = metadata["sim_passes"]
            if isinstance(sim_passes, list):
                sim_passes.append(line.strip())
            last_progress = line
        if TESTDRIVER_SUCCESS_FINISH_MARKER in line:
            sim_success_finishes = metadata["sim_success_finishes"]
            if isinstance(sim_success_finishes, list):
                sim_success_finishes.append(line.strip())
            last_progress = line
    binary_arg = metadata.get("binary_arg")
    payload_text = str(metadata.get("payload") or binary_arg or "")
    if "linux-poweroff-quiet" in payload_text:
        for quiet_log in quiet_completion_logs:
            finish = quiet_log.get("finish")
            if isinstance(finish, str):
                sim_success_finishes = metadata["sim_success_finishes"]
                if isinstance(sim_success_finishes, list) and finish not in sim_success_finishes:
                    sim_success_finishes.append(finish)
                last_progress = finish
    if isinstance(binary_arg, str) and binary_arg and simulator_log_reached_runtime(log_text):
        sim_log = sim_output_log_for_payload(binary_arg)
        if sim_log is not None:
            sim_progress = append_sim_output_markers(sim_log, metadata, include_failures=True)
            last_progress = sim_progress or last_progress
    metadata["last_progress_marker"] = last_progress
    metadata["lines_after_raw_transcript_end"] = lines_after_raw_transcript_end
    return metadata


def clean_progress_marker(line: str) -> str:
    marker = line.strip()
    for suffix in ("make: ***", "[timeout-wrapper]", "eliza-evidence: raw_transcript_end"):
        if suffix in marker:
            marker = marker.split(suffix, 1)[0].rstrip()
    return marker


def output_stem_for_payload(payload: str | None) -> str:
    if not payload or payload == "none":
        return "none"
    return Path(payload).name


def trace_metadata_template(trace: Path) -> dict[str, object]:
    return {
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
        "first_payload_pc": None,
        "first_payload_cycle": None,
        "entered_bootrom": False,
        "entered_payload": False,
        "entered_kernel_virtual": False,
        "bootrom_to_payload_handoff": False,
    }


def simulator_log_reached_runtime(log_text: str) -> bool:
    return any(marker in log_text for marker in SIM_RUNTIME_MARKERS)


def simulator_rebuild_was_interrupted(log_text: str, log_metadata: dict[str, object]) -> bool:
    exit_code = log_metadata.get("exit_code")
    return (
        bool(exit_code and exit_code != "0")
        and "Terminated" in log_text
        and (
            ".classpath_cache/chipyard.jar" in log_text
            or "assembly / assemblyOutputPath" in log_text
            or "sbt-launch.jar" in log_text
        )
        and not simulator_log_reached_runtime(log_text)
    )


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
    metadata = parse_trace_file(trace, payload, log_metadata)
    if metadata.get("exists"):
        return metadata
    trace_verbose = "" if log_metadata is None else str(log_metadata.get("trace_verbose") or "")
    extra_sim_flags = "" if log_metadata is None else str(log_metadata.get("extra_sim_flags") or "")
    if LOG.is_file() and (trace_verbose == "1" or "+verbose" in extra_sim_flags):
        metadata = trace_metadata_template(LOG)
        metadata["exists"] = True
        metadata["fresh_for_log"] = True
        metadata["source"] = "sampled_smoke_log"
        metadata["sampled"] = LOG.stat().st_size > LARGE_LOG_FULL_READ_LIMIT_BYTES
        return parse_trace_text(LOG, read_text_sample(LOG), payload, metadata)
    return metadata


def parse_trace_file(
    trace: Path, payload: str | None, log_metadata: dict[str, object] | None = None
) -> dict[str, object]:
    metadata = trace_metadata_template(trace)
    if not trace.is_file():
        return metadata
    metadata["fresh_for_log"] = trace_fresh_for_log(trace, log_metadata)
    try:
        with trace.open("r", encoding="utf-8", errors="replace") as handle:
            return parse_trace_lines(trace, handle, payload, metadata)
    except OSError:
        return metadata


def parse_trace_text(
    trace: Path,
    text: str,
    payload: str | None,
    metadata: dict[str, object] | None = None,
) -> dict[str, object]:
    if metadata is None:
        metadata = trace_metadata_template(trace)
    return parse_trace_lines(trace, text.splitlines(), payload, metadata)


def parse_trace_lines(
    trace: Path,
    lines,
    payload: str | None,
    metadata: dict[str, object],
) -> dict[str, object]:
    first_pc: int | None = None
    last_pc: int | None = None
    last_cycle: int | None = None
    first_payload_pc: int | None = None
    first_payload_cycle: int | None = None
    retired = 0
    entered_bootrom = False
    entered_payload = False
    entered_kernel_virtual = False
    for line in lines:
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
            if first_payload_pc is None:
                first_payload_pc = pc
                first_payload_cycle = last_cycle
        if pc >= 0xFFFF_FFFF_8000_0000:
            entered_kernel_virtual = True

    metadata.update(
        {
            "retired_instruction_count": retired,
            "first_pc": f"0x{first_pc:016x}" if first_pc is not None else None,
            "last_pc": f"0x{last_pc:016x}" if last_pc is not None else None,
            "last_cycle": last_cycle,
            "first_payload_pc": (
                f"0x{first_payload_pc:016x}" if first_payload_pc is not None else None
            ),
            "first_payload_cycle": first_payload_cycle,
            "entered_bootrom": entered_bootrom,
            "entered_payload": entered_payload,
            "entered_kernel_virtual": entered_kernel_virtual,
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


def diagnostic_instruction_trace(
    payload: str | None, log_metadata: dict[str, object] | None = None
) -> dict[str, object]:
    output_dir = SIM_DIR / "output" / f"chipyard.harness.TestHarness.{CONFIG}"
    stem = output_stem_for_payload(payload)
    candidates = sorted(
        output_dir.glob(f"{stem}.diag-trace-*.out"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        missing = output_dir / f"{stem}.diag-trace-*.out"
        metadata = trace_metadata_template(missing)
        metadata["diagnostic_only"] = True
        return metadata
    metadata = parse_trace_file(candidates[0], payload, log_metadata)
    metadata["diagnostic_only"] = True
    metadata["candidate_count"] = len(candidates)
    return metadata


def loadmem_diagnosis(
    log_text: str,
    log_metadata: dict[str, object],
    instruction_trace: dict[str, object],
    simulator_artifact: dict[str, object],
) -> dict[str, object]:
    command = str(log_metadata.get("command") or "")
    newest_sim_mtime = newest_simulator_mtime(simulator_artifact)
    simdram_source_mtime = SIMDRAM_SOURCE.stat().st_mtime if SIMDRAM_SOURCE.is_file() else None
    simdram_source_newer = (
        simdram_source_mtime is not None
        and newest_sim_mtime > 0.0
        and simdram_source_mtime > newest_sim_mtime
    )
    simdram_marker_observed = SIMDRAM_LOADMEM_ENTRY_MARKER in log_text
    plus_loadmem_in_command = (
        "+loadmem=" in log_text
        or "+loadmem=" in command
        or "LOADMEM=1" in log_text
        or "LOADMEM=1" in command
    )
    reason = ""
    if (
        plus_loadmem_in_command
        and instruction_trace.get("entered_payload")
        and not simdram_marker_observed
    ):
        if simdram_source_newer:
            reason = (
                "fresh instruction trace proves payload entry, but the current simulator "
                "binary predates the SimDRAM loadmem entry printf, so +loadmem success is "
                "not observable through the SimDRAM marker in this run"
            )
        else:
            reason = (
                "fresh instruction trace proves payload entry, but this run did not emit "
                "the SimDRAM loadmem entry marker; inspect simulator stdout/stderr capture "
                "and SimDRAM loadmem instrumentation"
            )
    elif plus_loadmem_in_command and simdram_marker_observed:
        reason = "SimDRAM loadmem entry marker was observed in the wrapper log"
    elif plus_loadmem_in_command:
        reason = "wrapper command included +loadmem, but no trace-backed payload entry was observed"

    return {
        "plus_loadmem_in_command": plus_loadmem_in_command,
        "simdram_loaded_elf_marker_observed": simdram_marker_observed,
        "simdram_source_mtime": simdram_source_mtime,
        "newest_simulator_mtime": newest_sim_mtime or None,
        "simdram_source_newer_than_simulator": simdram_source_newer,
        "trace_entered_payload": bool(instruction_trace.get("entered_payload")),
        "first_payload_pc": instruction_trace.get("first_payload_pc"),
        "first_payload_cycle": instruction_trace.get("first_payload_cycle"),
        "last_pc": instruction_trace.get("last_pc"),
        "last_symbol": instruction_trace.get("last_symbol"),
        "reason": reason,
    }


def fdt_handoff_diagnosis(
    instruction_trace: dict[str, object],
    fdt_audit: dict[str, object],
) -> dict[str, object]:
    last_symbol = str(instruction_trace.get("last_symbol") or "")
    retired_raw = instruction_trace.get("retired_instruction_count")
    cycle_raw = instruction_trace.get("last_cycle")
    try:
        retired_count = int(retired_raw) if retired_raw is not None else 0
    except (TypeError, ValueError):
        retired_count = 0
    try:
        last_cycle = int(cycle_raw) if cycle_raw is not None else 0
    except (TypeError, ValueError):
        last_cycle = 0
    in_fdt_symbol = last_symbol.startswith("fdt_") or last_symbol in FDT_LOOP_SYMBOLS
    generated_dtb_plausible = (
        fdt_audit.get("dtc_status") == "pass"
        and fdt_audit.get("fits_bootrom_region") is True
        and not fdt_audit.get("missing_required_tokens")
    )
    loop_detected = bool(
        instruction_trace.get("fresh_for_log")
        and instruction_trace.get("bootrom_to_payload_handoff")
        and in_fdt_symbol
        and (
            retired_count >= FDT_LOOP_RETIRED_THRESHOLD
            or last_cycle >= FDT_LOOP_CYCLE_THRESHOLD
        )
    )
    if loop_detected and generated_dtb_plausible:
        reason = (
            "fresh CPU trace is stuck in OpenSBI/libfdt after boot ROM handoff even "
            "though the generated DTS compiles, required Linux/OpenSBI tokens are "
            "present, and bootrom+DTB fits the BootROM region; investigate runtime "
            "FDT handoff/copy corruption or OpenSBI FDT relocation, not payload load"
        )
    elif loop_detected:
        reason = (
            "fresh CPU trace is stuck in OpenSBI/libfdt after boot ROM handoff; fix "
            "the generated DTS/DTB audit blockers first, then rerun the traced smoke"
        )
    elif in_fdt_symbol:
        reason = "fresh trace is in OpenSBI/libfdt but has not crossed the loop threshold"
    else:
        reason = ""
    return {
        "loop_detected": loop_detected,
        "last_symbol": last_symbol,
        "last_pc": instruction_trace.get("last_pc"),
        "retired_instruction_count": retired_count,
        "last_cycle": last_cycle,
        "first_payload_pc": instruction_trace.get("first_payload_pc"),
        "generated_dtb_plausible": generated_dtb_plausible,
        "dtc_status": fdt_audit.get("dtc_status"),
        "dtb_size_bytes": fdt_audit.get("dtb_size_bytes"),
        "bootrom_plus_dtb_bytes": fdt_audit.get("bootrom_plus_dtb_bytes"),
        "bootrom_region_size_bytes": fdt_audit.get("bootrom_region_size_bytes"),
        "missing_required_tokens": fdt_audit.get("missing_required_tokens"),
        "reason": reason,
    }


def uart_console_diagnosis(
    log_text: str,
    log_metadata: dict[str, object],
    instruction_trace: dict[str, object],
    fdt_audit: dict[str, object],
) -> dict[str, object]:
    command = str(log_metadata.get("command") or "")
    built_cmdline = config_cmdline(FIREMARSHAL_SMOKE_LINUX_CONFIG) or ""
    hvc_sbi_console = "console=hvc0" in built_cmdline and "earlycon=sbi" in built_cmdline
    sifive_uart_console = "console=ttySIF0" in built_cmdline
    hvc_sbi_config = False
    if FIREMARSHAL_SMOKE_LINUX_CONFIG.is_file():
        linux_config = FIREMARSHAL_SMOKE_LINUX_CONFIG.read_text(
            encoding="utf-8", errors="replace"
        )
        hvc_sbi_config = (
            "CONFIG_RISCV_SBI_V01=y" in linux_config
            and "CONFIG_HVC_RISCV_SBI=y" in linux_config
            and "CONFIG_SERIAL_EARLYCON_RISCV_SBI=y" in linux_config
        )
    uart_bridge_alive = "[UART] UART0 is here" in log_text
    uart_tx_printf_enabled = "+uart_tx_printf=1" in log_text or "+uart_tx_printf=1" in command
    uart_tx_events = log_text.count("UART TX (")
    reconstructed_uart = reconstruct_uart_tx_text(log_text)
    observable_text = observable_boot_text(log_text)
    kernel_virtual = bool(instruction_trace.get("entered_kernel_virtual"))
    chosen_stdout = False
    required = fdt_audit.get("required_tokens")
    if isinstance(required, dict):
        chosen_stdout = bool(required.get("chosen_stdout"))
    no_observable_uart_tx = bool(
        kernel_virtual
        and uart_bridge_alive
        and uart_tx_printf_enabled
        and uart_tx_events == 0
        and not has_accepted_opensbi_markers(observable_text)
        and "Linux version" not in observable_text
    )
    reason = ""
    if no_observable_uart_tx:
        reason = (
            "CPU reached kernel virtual-address execution with UART bridge initialized "
            "and +uart_tx_printf enabled, but no UART TX FIFO writes were printed; "
            "debug OpenSBI/Linux console selection, earlycon/SBI console availability, "
            "and whether the kernel is intentionally quiet before claiming serial boot evidence"
        )
    return {
        "uart_bridge_alive": uart_bridge_alive,
        "uart_tx_printf_enabled": uart_tx_printf_enabled,
        "uart_tx_event_count": uart_tx_events,
        "reconstructed_uart_size_bytes": len(reconstructed_uart.encode("utf-8")),
        "reconstructed_uart_preview": reconstructed_uart[:512],
        "reconstructed_uart_has_opensbi_banner": "OpenSBI" in reconstructed_uart,
        "reconstructed_uart_has_opensbi_handoff": has_accepted_opensbi_markers(
            reconstructed_uart
        ),
        "reconstructed_uart_has_linux_banner": "Linux version" in reconstructed_uart,
        "reconstructed_uart_has_linux_boot_markers": has_accepted_linux_markers(
            reconstructed_uart
        ),
        "built_cmdline": built_cmdline,
        "hvc_sbi_console": hvc_sbi_console,
        "hvc_sbi_config": hvc_sbi_config,
        "sifive_uart_console": sifive_uart_console,
        "entered_kernel_virtual": kernel_virtual,
        "chosen_stdout_token_present": chosen_stdout,
        "no_observable_uart_tx": no_observable_uart_tx,
        "reason": reason,
    }


def classify_smoke_progress(
    log_text: str, instruction_trace: dict[str, object], log_metadata: dict[str, object]
) -> dict[str, str]:
    if not log_text:
        return {
            "stage": "no_run",
            "next_step": "run scripts/run_chipyard_eliza_linux_smoke.sh with a real OpenSBI/Linux payload",
        }
    observable_text = observable_boot_text(log_text)
    if has_kernel_panic(observable_text):
        return {
            "stage": "linux_kernel_panic",
            "next_step": (
                "debug the generated AP Linux panic before claiming boot; inspect kernel "
                "memory map, initramfs, and generated DTS handoff evidence"
            ),
        }
    if has_accepted_linux_markers(observable_text):
        return {
            "stage": "linux_boot",
            "next_step": "capture the complete generated-AP Linux boot transcript",
        }
    if has_quiet_linux_completion_evidence(log_text, log_metadata, None):
        return {
            "stage": "quiet_linux_workload_completed",
            "next_step": (
                "use the quiet workload as generated-AP Linux completion evidence; "
                "capture target-side NPU MMIO/GEMM evidence next"
            ),
        }
    if simulator_rebuild_was_interrupted(log_text, log_metadata):
        return {
            "stage": "simulator_rebuild_interrupted",
            "next_step": (
                "rerun the generated AP smoke with enough wall time for Chipyard "
                "generation and Verilator simulator rebuild to finish before evaluating "
                "OpenSBI/Linux runtime progress"
            ),
        }
    sim_failures = log_metadata.get("sim_failures")
    sim_timeout = isinstance(sim_failures, list) and any(
        "timeout" in str(failure) for failure in sim_failures
    )
    wrapper_timeout = (
        str(log_metadata.get("exit_code") or "") == "124"
        or "[timeout-wrapper]" in log_text
        and "status=timeout" in log_text
    )
    if "Linux version" in observable_text:
        if sim_timeout:
            return {
                "stage": "linux_banner_then_max_cycles",
                "next_step": (
                    "rerun the generated AP smoke with a larger "
                    "CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES budget and enough wall time "
                    "to reach Linux command line/initramfs markers"
                ),
            }
        if wrapper_timeout:
            last_progress = str(log_metadata.get("last_progress_marker") or "").strip()
            progress_detail = f"; last progress marker: {last_progress}" if last_progress else ""
            return {
                "stage": "linux_early_boot_then_wall_timeout",
                "next_step": (
                    "generated AP reached the Linux banner but the smoke wrapper hit "
                    "CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS before accepted command-line/"
                    "initramfs/userspace markers appeared"
                    f"{progress_detail}; increase the wall-clock budget only if the "
                    "same marker is still making forward progress, otherwise debug "
                    "the Linux early memory/platform handoff"
                ),
            }
        return {
            "stage": "linux_banner_only",
            "next_step": "continue until Linux command line/initramfs markers appear",
        }
    if "*** PASSED ***" in log_text:
        return {
            "stage": "sim_pass_no_linux_console",
            "next_step": (
                "treat the simulator pass marker as non-Linux evidence; rerun with "
                "cycle-accurate UART serial enabled or a Linux boot marker source "
                "before claiming generated AP Linux boot"
            ),
        }
    if "OpenSBI" in observable_text and (
        "Assertion failed in TestDriver" in log_text or "Verilog $stop" in log_text
    ):
        if sim_timeout:
            return {
                "stage": "opensbi_banner_then_max_cycles",
                "next_step": (
                    "rerun the generated AP smoke with a larger "
                    "CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES budget and enough wall time "
                    "to reach OpenSBI handoff and Linux boot markers, or debug why "
                    "OpenSBI console output is too slow to reach Domain0 handoff"
                ),
            }
        return {
            "stage": "opensbi_banner_then_testdriver_assert",
            "next_step": (
                "debug the generated TestDriver assertion after the OpenSBI banner; "
                "if this is the generated max-cycle watchdog, rerun with a larger "
                "CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES budget and enough wall time "
                "to reach OpenSBI handoff and Linux boot markers"
            ),
        }
    if has_accepted_opensbi_markers(observable_text):
        return {
            "stage": "opensbi_boot",
            "next_step": "continue the smoke until the Linux kernel banner appears",
        }
    if "OpenSBI" in observable_text:
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
            if retired_count >= FDT_LOOP_RETIRED_THRESHOLD or last_cycle >= FDT_LOOP_CYCLE_THRESHOLD:
                return {
                    "stage": "payload_fdt_parse_loop",
                    "next_step": (
                        "debug the boot ROM FDT handoff/copy and OpenSBI FDT "
                        "relocation path; CPU is spending millions of instructions "
                        "inside OpenSBI/libfdt before any OpenSBI banner"
                    ),
                }
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
        if instruction_trace.get("entered_kernel_virtual"):
            return {
                "stage": "kernel_virtual_execution_no_console",
                "next_step": (
                    "debug why OpenSBI/Linux reached kernel virtual-address execution "
                    "without UART boot markers; inspect console DT stdout-path, SBI "
                    "console handoff, and UART host bridge capture"
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
        and not (
            has_accepted_opensbi_markers(observable_text)
            or "Linux version" in observable_text
        )
    ):
        if log_metadata.get("disable_dramsim") == "1" and "[UART] UART0 is here" not in log_text:
            return {
                "stage": "no_dramsim_fast_timeout_no_uart",
                "next_step": (
                    "the no-DRAMSim run-binary-fast attempt emitted no UART boot "
                    "markers and produced no instruction trace; rerun the default "
                    "ElizaRocketConfig SimDRAM path, or rerun with "
                    "CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary for PC-stage evidence "
                    "before classifying the memory-model blocker"
                ),
            }
        if (
            log_metadata.get("disable_dramsim") == "0"
            and "[UART] UART0 is here" in log_text
            and "DRAMSim2 Clock Frequency" in log_text
            and "SimDRAM loaded ELF entry=" not in log_text
        ):
            return {
                "stage": "dramsim_uart_only_no_observable_payload_entry",
                "next_step": (
                    "rerun with CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary for "
                    "instruction trace evidence, and rebuild with SimDRAM loadmem "
                    "entry instrumentation because UART and DRAMSim initialized but "
                    "no observable payload entry or OpenSBI/Linux marker was recorded"
                ),
            }
        built_cmdline = config_cmdline(FIREMARSHAL_SMOKE_LINUX_CONFIG) or ""
        if (
            log_metadata.get("disable_dramsim") == "0"
            and "[UART] UART0 is here" in log_text
            and "SimDRAM loaded ELF entry=" in log_text
            and "+uart_tx_printf=1" in str(log_metadata.get("extra_sim_flags") or "")
            and "UART TX (" not in log_text
            and "console=ttySIF0" in built_cmdline
        ):
            return {
                "stage": "sifive_uart_fast_timeout_no_tx",
                "next_step": (
                    "run a short traced generated-AP smoke to locate the payload PC, then "
                    "debug the SiFive UART console path because the rebuilt payload uses "
                    "console=ttySIF0, SimDRAM loaded the ELF, DRAMSim and the UART bridge "
                    "initialized, but no OpenSBI/Linux text or UART TX events were observed "
                    "before timeout"
                ),
            }
        if (
            log_metadata.get("disable_dramsim") == "0"
            and "[UART] UART0 is here" in log_text
            and "SimDRAM loaded ELF entry=" in log_text
            and "+uart_tx_printf=1" in str(log_metadata.get("extra_sim_flags") or "")
            and "UART TX (" not in log_text
            and "console=hvc0" in built_cmdline
            and "earlycon=sbi" in built_cmdline
        ):
            return {
                "stage": "hvc_sbi_fast_timeout_no_target_console",
                "next_step": (
                    "run a short traced generated-AP smoke to locate the payload PC, then "
                    "debug the HTIF/SBI console path because the rebuilt payload uses "
                    "console=hvc0 earlycon=sbi, SimDRAM loaded the ELF, DRAMSim and the "
                    "UART bridge initialized, but no OpenSBI/Linux/HVC text or UART TX "
                    "events were observed before timeout"
                ),
            }
        return {
            "stage": "fast_timeout_no_trace",
            "next_step": (
                "rerun with CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary for fresh PC "
                "evidence, or extend the fast timeout only after a traced run identifies "
                "the current payload stage"
            ),
        }
    if (
        "[timeout-wrapper]" in log_text
        and "status=timeout" in log_text
        and not log_metadata.get("simdram_entry")
        and "SimDRAM loaded ELF entry=" not in log_text
    ):
        return {
            "stage": "simulator_model_build_timeout",
            "next_step": (
                "rerun after the generated Verilator model has finished compiling, "
                "or increase CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS so the wall-clock "
                "budget covers model build plus Linux simulation"
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
    diagnostic_trace = diagnostic_instruction_trace(payload, log_metadata)
    simulator_artifact = simulator_artifact_metadata()
    log_text = read_text_sample(LOG) if LOG.is_file() else ""
    loadmem = loadmem_diagnosis(log_text, log_metadata, instruction_trace, simulator_artifact)
    active_processes = active_chipyard_smoke_processes()
    active_simulator_users = active_simulator_artifact_users()
    active_attempt = active_smoke_attempt_metadata()
    live_output = live_sim_output_metadata(payload, log_metadata)
    fdt_audit = generated_fdt_audit()
    opensbi_fdt_handoff = parse_opensbi_domain_handoff(
        observable_boot_text(log_text),
        fdt_audit.get("dtb_size_bytes") if isinstance(fdt_audit.get("dtb_size_bytes"), int) else None,
    )
    fdt_handoff = fdt_handoff_diagnosis(instruction_trace, fdt_audit)
    diagnostic_fdt_handoff = fdt_handoff_diagnosis(diagnostic_trace, fdt_audit)
    uart_console = uart_console_diagnosis(
        log_text, log_metadata, instruction_trace, fdt_audit
    )
    deferred_next_command = next_command(payload)
    safe_action = next_safe_action(
        simulator_artifact, active_simulator_users, active_processes, active_attempt, payload
    )
    quiet_linux_completion = has_quiet_linux_completion_evidence(log_text, log_metadata, payload)
    progress = progress_with_active_attempt(
        classify_smoke_progress(log_text, instruction_trace, log_metadata),
        active_processes,
        active_attempt,
    )
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
        "diagnostic_instruction_trace": diagnostic_trace,
        "progress": progress,
        "quiet_linux_completion_evidence": quiet_linux_completion,
        "host": {
            "system": platform.system(),
            "machine": platform.machine(),
        },
        "active_chipyard_containers": active_chipyard_containers(),
        "active_chipyard_smoke_processes": active_processes,
        "active_smoke_attempt": active_attempt,
        "active_simulator_artifact_users": active_simulator_users,
        "live_sim_output": live_output,
        "allow_container_generated_paths": allow_container_paths,
        "generated_driver_makefile": rel(GENERATED_DRIVER_MAKEFILE),
        "simulator_artifact": simulator_artifact,
        "sim_memory_model_audit": sim_memory_model_audit(),
        "loadmem_diagnosis": loadmem,
        "generated_fdt_audit": fdt_audit,
        "opensbi_fdt_handoff_audit": opensbi_fdt_handoff,
        "fdt_handoff_diagnosis": fdt_handoff,
        "diagnostic_fdt_handoff_diagnosis": diagnostic_fdt_handoff,
        "uart_console_diagnosis": uart_console,
        "required_log_markers": list(REQUIRED_LOG_MARKERS),
        "next_safe_action": safe_action,
        "next_command": safe_action if safe_action == deferred_next_command else "",
        "next_command_after_active_simulator_users": deferred_next_command,
        "blockers": blockers,
        "claim_boundary": (
            "This gate only passes after a real Chipyard Verilator run-binary log "
            "contains OpenSBI/Linux markers or an intentionally quiet FireMarshal "
            "Linux workload reaches the generated TestDriver success finish from "
            "the generated ElizaRocketConfig. It does not create or substitute "
            "boot evidence."
        ),
    }
    for output in (REPORT, REPORT_MIRROR):
        output.parent.mkdir(parents=True, exist_ok=True)
        tmp = output.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(output)


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
    parser.add_argument(
        "--classify-generated-artifact-failure",
        metavar="LOG",
        help=(
            "exit 0 only when LOG shows a stale/partial generated Verilator model "
            "artifact failure that is safe to repair and retry once"
        ),
    )
    args = parser.parse_args()
    if args.classify_generated_artifact_failure:
        log_text = read_text_sample(Path(args.classify_generated_artifact_failure))
        return 0 if is_generated_model_artifact_failure(log_text) else 1
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
    blockers.extend(firemarshal_payload_config_blockers())

    initial_log_text = read_text_sample(LOG) if LOG.is_file() else ""
    initial_observable_text = observable_boot_text(initial_log_text)
    quiet_linux_completion = has_quiet_linux_completion_evidence(
        initial_log_text, log_metadata, payload
    )

    if not payload and not quiet_linux_completion:
        blockers.append(
            f"{PAYLOAD_ENV} is unset, {rel(LOG)} does not record a replayable payload, "
            "and no FireMarshal OpenSBI/Linux ELF payload was found; run "
            "python3 scripts/locate_chipyard_linux_payload.py --require for build guidance"
        )
    elif payload and not Path(payload).is_file():
        blockers.append(
            f"{PAYLOAD_ENV} {payload_source} payload does not point to a file: {payload}"
        )

    instruction_trace = parse_instruction_trace(payload, log_metadata)
    diagnostic_trace = diagnostic_instruction_trace(payload, log_metadata)
    active_processes = active_chipyard_smoke_processes()
    active_simulator_users = active_simulator_artifact_users()
    active_attempt = active_smoke_attempt_metadata()
    live_output = live_sim_output_metadata(payload, log_metadata)
    fdt_audit = generated_fdt_audit()
    opensbi_fdt_handoff = parse_opensbi_domain_handoff(
        initial_observable_text,
        fdt_audit.get("dtb_size_bytes") if isinstance(fdt_audit.get("dtb_size_bytes"), int) else None,
    )
    fdt_handoff = fdt_handoff_diagnosis(instruction_trace, fdt_audit)
    diagnostic_fdt_handoff = fdt_handoff_diagnosis(diagnostic_trace, fdt_audit)
    uart_console = uart_console_diagnosis(
        initial_log_text, log_metadata, instruction_trace, fdt_audit
    )
    latest_live = live_output.get("latest")
    if active_processes:
        blocker = (
            "generated AP Linux smoke is currently running; canonical evidence remains "
            "blocked until the wrapper records raw_transcript_end and status=PASS"
        )
        active_stage = active_attempt.get("stage") if isinstance(active_attempt, dict) else None
        active_progress = (
            active_attempt.get("last_progress_marker") if isinstance(active_attempt, dict) else None
        )
        reached_runtime = (
            active_attempt.get("reached_simulator_runtime")
            if isinstance(active_attempt, dict)
            else False
        )
        if active_stage:
            blocker += f"; active attempt stage: {active_stage}"
        if active_progress:
            blocker += f"; active attempt progress: {active_progress}"
        if isinstance(latest_live, dict) and reached_runtime:
            live_progress = latest_live.get("last_progress_marker")
            if live_progress:
                blocker += f"; latest live simulator progress: {live_progress}"
            blocker += f"; live log: {latest_live.get('path')}"
        if instruction_trace.get("fresh_for_log") and instruction_trace.get(
            "bootrom_to_payload_handoff"
        ):
            blocker += (
                "; active instruction trace: "
                f"first_payload_pc={instruction_trace.get('first_payload_pc')} "
                f"last_pc={instruction_trace.get('last_pc')} "
                f"last_symbol={instruction_trace.get('last_symbol') or 'unknown'} "
                f"retired={instruction_trace.get('retired_instruction_count')} "
                f"trace={instruction_trace.get('path')}"
            )
        blockers.append(blocker)
    if fdt_handoff.get("loop_detected"):
        blockers.append(
            "generated AP CPU trace is stuck in OpenSBI/libfdt before the OpenSBI "
            f"banner: last_symbol={fdt_handoff.get('last_symbol')} "
            f"last_pc={fdt_handoff.get('last_pc')} "
            f"retired={fdt_handoff.get('retired_instruction_count')} "
            f"last_cycle={fdt_handoff.get('last_cycle')}; "
            f"{fdt_handoff.get('reason')}"
        )
    if (
        not instruction_trace.get("exists")
        and diagnostic_trace.get("bootrom_to_payload_handoff")
        and diagnostic_fdt_handoff.get("last_symbol")
    ):
        blockers.append(
            "latest diagnostic-only generated AP trace is not current acceptance "
            "evidence, but it shows BootROM-to-payload handoff followed by "
            f"OpenSBI/libfdt execution: first_payload_pc={diagnostic_trace.get('first_payload_pc')} "
            f"last_pc={diagnostic_trace.get('last_pc')} "
            f"last_symbol={diagnostic_fdt_handoff.get('last_symbol')} "
            f"retired={diagnostic_trace.get('retired_instruction_count')} "
            f"last_cycle={diagnostic_trace.get('last_cycle')} "
            f"entered_kernel_virtual={diagnostic_trace.get('entered_kernel_virtual')} "
            f"trace={diagnostic_trace.get('path')}"
        )
    if uart_console.get("no_observable_uart_tx"):
        blockers.append(
            "generated AP run reached kernel virtual-address execution with no "
            "observable SiFive UART TX writes: "
            f"uart_bridge_alive={uart_console.get('uart_bridge_alive')} "
            f"uart_tx_printf_enabled={uart_console.get('uart_tx_printf_enabled')} "
            f"uart_tx_event_count={uart_console.get('uart_tx_event_count')}; "
            f"{uart_console.get('reason')}"
        )
    if simdram_source_newer_than_simulator(simulator_metadata) and active_simulator_users:
        users = ", ".join(
            f"pid={user.get('pid')} elapsed={user.get('elapsed')}"
            for user in active_simulator_users[:5]
        )
        extra = (
            "" if len(active_simulator_users) <= 5 else f", +{len(active_simulator_users) - 5} more"
        )
        blockers.append(
            "cannot safely rebuild stale ElizaRocketConfig simulator while active "
            f"simulator user(s) are running: {users}{extra}"
        )
    if fdt_audit.get("dtc_status") == "fail":
        blockers.append(f"generated DTS fails dtc compilation: {fdt_audit.get('dtc_output')}")
    missing_dts_tokens = fdt_audit.get("missing_required_tokens")
    if isinstance(missing_dts_tokens, list) and missing_dts_tokens:
        blockers.append(
            "generated DTS is missing required Linux/OpenSBI token(s): "
            + ", ".join(str(item) for item in missing_dts_tokens)
        )
    if fdt_audit.get("fits_bootrom_region") is False:
        blockers.append(
            "generated bootrom plus DTB does not fit the BootROM region: "
            f"{fdt_audit.get('bootrom_plus_dtb_bytes')} > "
            f"{fdt_audit.get('bootrom_region_size_bytes')}"
        )
    if opensbi_fdt_handoff.get("observed"):
        if not opensbi_fdt_handoff.get("domain0_next_arg1_matches_expected"):
            blockers.append(
                "OpenSBI Domain0 handoff does not pass Linux the expected writable "
                "DRAM FDT address: "
                f"observed a1={opensbi_fdt_handoff.get('domain0_next_arg1') or '<missing>'} "
                f"expected={opensbi_fdt_handoff.get('expected_domain0_next_arg1')}"
            )
        elif not opensbi_fdt_handoff.get("domain0_next_arg1_fits_dram"):
            blockers.append(
                "OpenSBI Domain0 handoff FDT address does not fit inside generated "
                "DRAM with the audited DTB size: "
                f"a1={opensbi_fdt_handoff.get('domain0_next_arg1')} "
                f"dtb_size={fdt_audit.get('dtb_size_bytes')}"
            )
        elif not opensbi_fdt_handoff.get("domain0_next_arg1_clear_of_kernel_low_window"):
            blockers.append(
                "OpenSBI Domain0 handoff FDT address collides with the kernel low "
                "load window: "
                f"kernel={opensbi_fdt_handoff.get('domain0_next_address')} "
                f"a1={opensbi_fdt_handoff.get('domain0_next_arg1')}"
            )
    log_text = ""
    if not LOG.is_file():
        if not quiet_linux_completion:
            blockers.append(f"missing Verilator OpenSBI/Linux smoke log: {rel(LOG)}")
    else:
        log_text = initial_log_text
        observable_text = initial_observable_text
        if (
            not quiet_linux_completion
            and "eliza-evidence: raw_transcript_begin" in log_text
            and not log_metadata.get("raw_transcript_closed")
        ):
            blockers.append(
                f"{rel(LOG)} has raw_transcript_begin but lacks raw_transcript_end; "
                "the smoke attempt was interrupted before the wrapper recorded a complete result"
            )
        lines_after_end = log_metadata.get("lines_after_raw_transcript_end")
        if not quiet_linux_completion and isinstance(lines_after_end, int) and lines_after_end:
            blockers.append(
                f"{rel(LOG)} contains {lines_after_end} non-empty line(s) after "
                "raw_transcript_end; timeout handling allowed simulator output to outlive "
                "the evidence wrapper"
            )
        fatal_errors = log_metadata.get("fatal_errors")
        if not quiet_linux_completion and isinstance(fatal_errors, list):
            for fatal_error in fatal_errors:
                blockers.append(f"{rel(LOG)} records fatal error: {fatal_error}")
        exceptions = log_metadata.get("exceptions")
        if not quiet_linux_completion and isinstance(exceptions, list):
            for exception in exceptions:
                blockers.append(f"{rel(LOG)} records generator exception: {exception}")
        kernel_panics = log_metadata.get("kernel_panics")
        if not quiet_linux_completion and isinstance(kernel_panics, list):
            for kernel_panic in kernel_panics:
                blockers.append(f"{rel(LOG)} records Linux kernel panic: {kernel_panic}")
        sim_failures = log_metadata.get("sim_failures")
        if not quiet_linux_completion and isinstance(sim_failures, list):
            for sim_failure in sim_failures:
                hint = ""
                if "timeout" in sim_failure and "+max-cycles=" in log_text:
                    hint = (
                        "; increase CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES "
                        "and CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS for this payload"
                    )
                elif "timeout" in sim_failure and "max_core_cycles" not in log_text:
                    hint = (
                        "; pass +max_core_cycles=0 or a larger value through "
                        "CHIPYARD_LINUX_SMOKE_EXTRA_SIM_FLAGS"
                    )
                blockers.append(f"{rel(LOG)} records simulator failure: {sim_failure}{hint}")
        exit_code = log_metadata.get("exit_code")
        if exit_code and exit_code != "0" and not quiet_linux_completion:
            reason = f"{rel(LOG)} records simulator wrapper exit_code={exit_code}"
            timeout_after = log_metadata.get("timeout_after_seconds")
            if timeout_after:
                reason += f" after timeout_after_seconds={timeout_after}"
            blockers.append(reason)
        last_progress = log_metadata.get("last_progress_marker")
        if exit_code and exit_code != "0" and last_progress and not quiet_linux_completion:
            blockers.append(f"last simulator progress before wrapper exit: {last_progress}")
        if last_progress and not (
            quiet_linux_completion
            or has_accepted_opensbi_markers(observable_text)
            or "Linux version" in observable_text
        ):
            blockers.append(f"last simulator progress before missing boot markers: {last_progress}")
        trace_is_fresh = bool(instruction_trace.get("fresh_for_log"))
        if not quiet_linux_completion and instruction_trace.get("exists") and not trace_is_fresh:
            blockers.append(
                "instruction trace is older than the current smoke log; rerun "
                "with CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary for fresh PC evidence: "
                f"{instruction_trace.get('path')}"
            )
        extra_sim_flags = str(log_metadata.get("extra_sim_flags") or "")
        if (
            not quiet_linux_completion
            and simulator_log_reached_runtime(log_text)
            and not instruction_trace.get("exists")
            and "+verbose" not in extra_sim_flags
        ):
            blockers.append(
                "current generated AP smoke reached simulator runtime without a "
                "fresh instruction trace; rerun with "
                "CHIPYARD_LINUX_SMOKE_TRACE_VERBOSE=1 and +verbose for PC-stage "
                "diagnostics only if the longer non-traced evidence attempt still "
                "lacks OpenSBI/Linux markers"
            )
        if (
            not quiet_linux_completion
            and simulator_log_reached_runtime(log_text)
            and trace_is_fresh
            and instruction_trace.get("bootrom_to_payload_handoff")
            and not (
                has_accepted_opensbi_markers(observable_text)
                or "Linux version" in observable_text
            )
        ):
            blockers.append(
                "instruction trace proves CPU forward progress through boot ROM "
                f"to payload: first_pc={instruction_trace.get('first_pc')} "
                f"last_pc={instruction_trace.get('last_pc')} "
                f"last_symbol={instruction_trace.get('last_symbol') or 'unknown'} "
                f"retired={instruction_trace.get('retired_instruction_count')} "
                f"trace={instruction_trace.get('path')}"
            )
        if (
            not quiet_linux_completion
            and trace_is_fresh
            and instruction_trace.get("entered_kernel_virtual")
            and not (
                has_accepted_opensbi_markers(observable_text)
                or "Linux version" in observable_text
            )
        ):
            blockers.append(
                "instruction trace reached kernel virtual-address execution but UART "
                "boot markers are still absent: "
                f"last_pc={instruction_trace.get('last_pc')} "
                f"retired={instruction_trace.get('retired_instruction_count')} "
                f"trace={instruction_trace.get('path')}"
            )
        if not has_accepted_opensbi_markers(observable_text) and not quiet_linux_completion:
            blockers.append(f"{rel(LOG)} lacks required marker: OpenSBI/SBI handoff")
        if "OpenSBI" in observable_text and not has_accepted_opensbi_markers(observable_text):
            blockers.append(
                f"{rel(LOG)} has an OpenSBI banner but lacks accepted OpenSBI handoff markers: "
                + ", ".join(OPENSBI_ACCEPTANCE_MARKERS)
            )
        if (
            "SBI specification" in observable_text
            and "OpenSBI" not in observable_text
            and not has_accepted_opensbi_markers(observable_text)
        ):
            blockers.append(
                f"{rel(LOG)} has Linux-observed SBI markers but lacks accepted implementation markers"
            )
        if "Linux version" not in observable_text and not quiet_linux_completion:
            blockers.append(f"{rel(LOG)} lacks required marker: Linux version")
        if (
            "Linux version" in observable_text
            and not has_accepted_linux_markers(observable_text)
            and not quiet_linux_completion
        ):
            blockers.append(
                f"{rel(LOG)} has a Linux banner but lacks accepted Linux boot markers: "
                + ", ".join(LINUX_ACCEPTANCE_MARKERS)
            )

    progress = progress_with_active_attempt(
        classify_smoke_progress(observable_boot_text(log_text), instruction_trace, log_metadata),
        active_processes,
        active_attempt,
    )
    if blockers:
        write_report("blocked", blockers, payload)
        print(f"STATUS: BLOCKED chipyard.verilator_linux_smoke.{progress['stage']}")
        print(f"  simulator_path: {rel(SIM_DIR)}")
        print(f"  progress_stage: {progress['stage']}")
        print(f"  next_progress_step: {progress['next_step']}")
        safe_action = next_safe_action(
            simulator_metadata, active_simulator_users, active_processes, active_attempt, payload
        )
        deferred_next_command = next_command(payload)
        print(f"  next_safe_action: {safe_action}")
        if safe_action != deferred_next_command:
            print(f"  next_command_after_active_simulator_users: {deferred_next_command}")
        else:
            print(f"  next_command: {deferred_next_command}")
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
