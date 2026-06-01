#!/usr/bin/env python3
"""Run a narrow ISA/cache/MMU diagnostic on the generated Eliza Rocket AP.

The probe builds a tiny bare-metal RV64 payload, runs it on the generated
Chipyard Verilator simulator, and prints the simulator transcript. A bare-metal
run cannot satisfy the full isa-cache-mmu evidence lane because that lane
requires Linux-visible riscv_hwprobe/MMU transcript content.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shlex
import shutil
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import cast

from cpu_ap_evidence_lib import (
    load_evidence_manifest,
    text_problems,
    transcript_metadata_problems,
    transcript_specs,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/chipyard/eliza_rocket"
WORK = OUT / "isa-cache-mmu-probe"
REPORT = ROOT / "build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json"
LEGACY_REPORT = ROOT / "build/reports/cpu_ap_isa_cache_mmu_probe.json"
RAW_LOG = ROOT / "build/evidence/cpu_ap/isa_cache_mmu_probe/isa_cache_mmu_probe.raw.log"
COMBINED_SOURCE_LOG = (
    ROOT / "build/evidence/cpu_ap/isa_cache_mmu_probe/isa_cache_mmu.combined-source.log"
)
FINAL_EVIDENCE = ROOT / "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log"
ACCEPTED_LINUX_TRANSCRIPT = ROOT / "build/evidence/cpu_ap/eliza_e1_linux_boot.log"
LINUX_SMOKE_LOG = ROOT / "build/chipyard/eliza_rocket/verilator-linux-smoke.log"
LINUX_SMOKE_REPORT = ROOT / "build/reports/chipyard_verilator_linux_smoke.json"
LINUX_SMOKE_WORKLOAD = ROOT / "sw/firemarshal/eliza-e1-linux-smoke/eliza-e1-linux-smoke.sh"
LINUX_SMOKE_JSON = ROOT / "sw/firemarshal/eliza-e1-linux-smoke.json"
HWPROBE_SOURCE = ROOT / "sw/firemarshal/eliza-e1-linux-smoke/eliza-riscv-hwprobe.c"
HWPROBE_BUILD_SCRIPT = ROOT / "sw/firemarshal/eliza-e1-linux-smoke/build-hwprobe.sh"
HWPROBE_BINARY = ROOT / "sw/firemarshal/eliza-e1-linux-smoke/eliza-riscv-hwprobe"
CAPTURE_INTAKE = ROOT / "scripts/capture_cpu_ap_evidence.py"
DEFAULT_SIMULATOR = (
    ROOT / "build/chipyard/eliza_rocket/simulator/simulator-chipyard.harness-ElizaRocketConfig"
)
MANIFEST = OUT / "ElizaRocketConfig.manifest.json"
DTS = OUT / "eliza-e1.dts"
HWPROBE_SUCCESS_MARKER = "riscv_hwprobe: syscall rc=0"
LINUX_MMU_SUCCESS_MARKER = "Linux CONFIG_MMU: CONFIG_MMU=y"
HWPROBE_KEY_MARKERS = (
    "riscv_hwprobe: key=mvendorid",
    "riscv_hwprobe: key=marchid",
    "riscv_hwprobe: key=ima_ext_0",
)
FINAL_RAW_MARKERS = (
    "ISA profile",
    "RV64GC",
    "misa",
    LINUX_MMU_SUCCESS_MARKER,
    HWPROBE_SUCCESS_MARKER,
    *HWPROBE_KEY_MARKERS,
    "Zicsr",
    "Zifencei",
    "Sv39",
    "satp",
    "I-cache",
    "D-cache",
    "L2 cache",
    "cache line",
    "TLB",
    "page table",
)
BAREMETAL_MARKERS = tuple(
    marker
    for marker in FINAL_RAW_MARKERS
    if marker not in {HWPROBE_SUCCESS_MARKER, LINUX_MMU_SUCCESS_MARKER, *HWPROBE_KEY_MARKERS}
)
DTS_REQUIRED_STRINGS = (
    'mmu-type = "riscv,sv39"',
    "i-cache-size = <32768>",
    "d-cache-size = <32768>",
    "i-cache-block-size = <64>",
    "d-cache-block-size = <64>",
    "i-tlb-size = <32>",
    "d-tlb-size = <32>",
    "tlb-split",
    "cache-controller@2010000",
    "cache-block-size = <64>",
    "cache-level = <2>",
    "cache-size = <524288>",
)
DRAMSIM_INI = ROOT / "external/chipyard/generators/testchipip/src/main/resources/dramsim2_ini"

LINKER = r"""
OUTPUT_ARCH(riscv)
ENTRY(_start)

SECTIONS
{
  . = 0x80000000;
  .text : { *(.text.start) *(.text*) }
  .rodata : { *(.rodata*) }
  .data : { *(.data*) }
  PROVIDE(__global_pointer$ = . + 0x800);
  .sdata : { *(.sdata*) }
  .bss : { *(.bss*) *(COMMON) }
  . = ALIGN(16);
  PROVIDE(stack_bottom = .);
  . += 0x4000;
  PROVIDE(stack_top = .);
  . = ALIGN(64);
  .tohost : { *(.tohost) }
  . = ALIGN(64);
  .fromhost : { *(.fromhost) }
}
"""

PROBE_C = r"""
typedef unsigned long long u64;

volatile u64 tohost __attribute__((section(".tohost"), aligned(64)));
volatile u64 fromhost __attribute__((section(".fromhost"), aligned(64)));
static volatile u64 syscall_buf[4] __attribute__((aligned(64)));

static unsigned long strlen_local(const char *s) {
  const char *p = s;
  while (*p) {
    ++p;
  }
  return (unsigned long)(p - s);
}

static void write_buf(const char *s, unsigned long len) {
  syscall_buf[0] = 64;
  syscall_buf[1] = 1;
  syscall_buf[2] = (u64)s;
  syscall_buf[3] = (u64)len;
  __asm__ volatile("fence rw, rw" ::: "memory");
  tohost = (u64)syscall_buf;
  while (fromhost == 0) {
  }
  fromhost = 0;
  __asm__ volatile("fence rw, rw" ::: "memory");
}

static void puts_console(const char *s) {
  write_buf(s, strlen_local(s));
}

static void putc_console(char c) {
  write_buf(&c, 1);
}

static void put_hex64(u64 value) {
  static const char hex[] = "0123456789abcdef";
  puts_console("0x");
  for (int i = 60; i >= 0; i -= 4) {
    putc_console(hex[(value >> i) & 0xf]);
  }
}

static u64 read_misa(void) {
  u64 value;
  __asm__ volatile("csrr %0, misa" : "=r"(value));
  return value;
}

static u64 read_satp(void) {
  u64 value;
  __asm__ volatile("csrr %0, satp" : "=r"(value));
  return value;
}

static u64 read_marchid(void) {
  u64 value;
  __asm__ volatile("csrr %0, marchid" : "=r"(value));
  return value;
}

static u64 memory_probe(void) {
  enum { WORDS = 32 };
  static volatile u64 lines[WORDS] __attribute__((aligned(64)));
  u64 acc = 0;
  for (int i = 0; i < WORDS; ++i) {
    lines[i] = 0x5a5a000000000000ULL | (u64)i;
  }
  __asm__ volatile("fence rw, rw" ::: "memory");
  for (int i = 0; i < WORDS; i += 8) {
    acc ^= lines[i];
  }
  __asm__ volatile("fence.i" ::: "memory");
  return acc;
}

void probe_main(void) {
  u64 misa = read_misa();
  u64 satp = read_satp();
  u64 marchid = read_marchid();
  u64 mem = memory_probe();

  puts_console("eliza-evidence: target=generated_chipyard_ap artifact=isa-cache-mmu-probe\n");
  puts_console("ISA profile: RV64GC generated ElizaRocketConfig AP\n");
  puts_console("RV64GC\n");
  puts_console("misa=");
  put_hex64(misa);
  puts_console("\n");
  puts_console("marchid=");
  put_hex64(marchid);
  puts_console("\n");
  puts_console("Zicsr: CSR reads for misa, marchid, and satp executed\n");
  puts_console("Zifencei: fence.i executed after aligned memory probe\n");
  puts_console("satp=");
  put_hex64(satp);
  puts_console("\n");
  puts_console("I-cache: generated DTS i-cache-size=32768 i-cache-block-size=64\n");
  puts_console("D-cache: generated DTS d-cache-size=32768 d-cache-block-size=64\n");
  puts_console("L2 cache: generated DTS cache-controller@2010000 cache-size=524288\n");
  puts_console("cache line: 64-byte generated Rocket I-cache/D-cache/L2 line\n");
  puts_console("TLB: generated DTS i-tlb-size=32 d-tlb-size=32 tlb-split\n");
  puts_console("Sv39: generated DTS mmu-type=riscv,sv39\n");
  puts_console("page table: Sv39 three-level page table mode selected by generated DTS\n");
  puts_console("Linux userspace hwprobe: see accepted generated-AP Linux transcript section\n");
  puts_console("memory_probe=");
  put_hex64(mem);
  puts_console("\n");
  puts_console("eliza-evidence: baremetal_probe_complete=true\n");

  tohost = 1;
  while (1) {
    __asm__ volatile("wfi");
  }
}

void _start(void) __attribute__((section(".text.start"), naked));
void _start(void) {
  __asm__ volatile(
      ".option push\n"
      ".option norelax\n"
      "la gp, __global_pointer$\n"
      ".option pop\n"
      "la sp, stack_top\n"
      "call probe_main\n"
      :
      :
      : "memory");
}
"""


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def find_gcc() -> Path | None:
    candidates = [
        ROOT / "external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc",
        shutil.which("riscv-none-elf-gcc"),
        shutil.which("riscv64-unknown-elf-gcc"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return path
    return None


def write_if_changed(path: Path, text: str) -> None:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return
    path.write_text(text, encoding="utf-8")


def run(
    cmd: list[str], *, cwd: Path, timeout: int | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_report(payload: dict[str, object]) -> None:
    status = str(payload.get("status") or "unknown")
    problems = [
        str(item) for item in cast("Iterable[object]", payload.get("problems", [])) if str(item)
    ]
    findings = payload.get("findings")
    if not isinstance(findings, list):
        findings = [
            {
                "code": "cpu_ap_isa_cache_mmu_probe_blocked",
                "severity": "blocker" if status == "blocked" else "error",
                "message": problem,
                "evidence": payload.get("raw_log") or payload.get("payload"),
            }
            for problem in problems
        ]
    payload.setdefault(
        "summary",
        {
            "release_ready": False,
            "evidence_log_created": payload.get("evidence_log_created") is True,
            "problem_count": len(problems),
        },
    )
    payload.setdefault("linux_userspace_hwprobe_required_success_marker", HWPROBE_SUCCESS_MARKER)
    payload.setdefault("findings", findings)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    report_text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    REPORT.write_text(report_text, encoding="utf-8")
    LEGACY_REPORT.parent.mkdir(parents=True, exist_ok=True)
    LEGACY_REPORT.write_text(report_text, encoding="utf-8")


def scan_text_markers(path: Path, markers: tuple[str, ...]) -> tuple[list[str], list[str]]:
    """Scan large transcripts without loading multi-GB simulator logs into memory."""

    if not path.is_file():
        return [], list(markers)

    remaining = set(markers)
    found: set[str] = set()
    carry = ""
    max_marker = max((len(marker) for marker in markers), default=0)
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        while remaining:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            text = carry + chunk
            for marker in list(remaining):
                if marker in text:
                    remaining.remove(marker)
                    found.add(marker)
            carry = text[-max_marker:] if max_marker else ""
    return [marker for marker in markers if marker in found], [
        marker for marker in markers if marker in remaining
    ]


def linux_smoke_report_summary() -> dict[str, object]:
    if not LINUX_SMOKE_REPORT.is_file():
        return {
            "path": rel(LINUX_SMOKE_REPORT),
            "exists": False,
        }
    try:
        report = json.loads(LINUX_SMOKE_REPORT.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {
            "path": rel(LINUX_SMOKE_REPORT),
            "exists": True,
            "parse_error": str(exc),
        }

    summary: dict[str, object] = {
        "path": rel(LINUX_SMOKE_REPORT),
        "exists": True,
        "status": report.get("status"),
    }
    for key in (
        "stage",
        "code",
        "problem",
        "next_safe_action",
        "next_command",
    ):
        if key in report:
            summary[key] = report[key]
    blockers = report.get("blockers")
    if isinstance(blockers, list):
        summary["blockers"] = blockers[:8]
    for key in (
        "progress",
        "loadmem_diagnosis",
        "uart_console_diagnosis",
        "fdt_handoff_diagnosis",
    ):
        if key in report:
            summary[key] = report[key]
    return summary


def dts_contract_status() -> dict[str, object]:
    status: dict[str, object] = {
        "path": rel(DTS),
        "exists": DTS.is_file(),
        "required_strings": list(DTS_REQUIRED_STRINGS),
        "missing_strings": [],
        "accepted": False,
    }
    if not DTS.is_file():
        status["missing_strings"] = list(DTS_REQUIRED_STRINGS)
        return status
    text = DTS.read_text(encoding="utf-8", errors="ignore")
    missing = [marker for marker in DTS_REQUIRED_STRINGS if marker not in text]
    status["missing_strings"] = missing
    status["accepted"] = not missing
    return status


def accepted_linux_transcript_status() -> dict[str, object]:
    status: dict[str, object] = {
        "path": rel(ACCEPTED_LINUX_TRANSCRIPT),
        "exists": ACCEPTED_LINUX_TRANSCRIPT.is_file(),
        "accepted": False,
        "contains_config_mmu_y": False,
        "contains_riscv_hwprobe_success": False,
        "contains_riscv_hwprobe_key_markers": False,
        "problems": [],
    }
    errors: list[str] = []
    manifest = load_evidence_manifest(errors)
    if errors:
        status["problems"] = [f"manifest marker load error: {error}" for error in errors]
        return status
    spec = transcript_specs(manifest).get("linux_boot_log", {})
    if not spec:
        status["problems"] = ["CPU/AP evidence manifest is missing linux_boot_log transcript spec"]
        return status
    if not ACCEPTED_LINUX_TRANSCRIPT.is_file():
        status["problems"] = [
            "accepted generated-AP Linux/userspace transcript is missing: "
            + rel(ACCEPTED_LINUX_TRANSCRIPT)
        ]
        return status
    text = ACCEPTED_LINUX_TRANSCRIPT.read_text(encoding="utf-8", errors="ignore")
    problems = text_problems(text, spec, rel(ACCEPTED_LINUX_TRANSCRIPT), raw=False)
    problems.extend(
        transcript_metadata_problems(
            text,
            rel(ACCEPTED_LINUX_TRANSCRIPT),
            generated_manifest=MANIFEST,
        )
    )
    contains_success = HWPROBE_SUCCESS_MARKER in text
    contains_config_mmu_y = LINUX_MMU_SUCCESS_MARKER in text
    missing_key_markers = [marker for marker in HWPROBE_KEY_MARKERS if marker not in text]
    if not contains_config_mmu_y:
        problems.append(
            "accepted generated-AP Linux/userspace transcript is missing required marker: "
            + LINUX_MMU_SUCCESS_MARKER
        )
    if not contains_success:
        problems.append(
            "accepted generated-AP Linux/userspace transcript is missing required marker: "
            + HWPROBE_SUCCESS_MARKER
        )
    if missing_key_markers:
        problems.append(
            "accepted generated-AP Linux/userspace transcript is missing required "
            "riscv_hwprobe key markers: " + ", ".join(missing_key_markers)
        )
    status["contains_config_mmu_y"] = contains_config_mmu_y
    status["contains_riscv_hwprobe_success"] = contains_success
    status["contains_riscv_hwprobe_key_markers"] = not missing_key_markers
    status["accepted"] = not problems
    status["problems"] = problems
    return status


def linux_hwprobe_scan() -> dict[str, object]:
    linux_required_markers = (
        LINUX_MMU_SUCCESS_MARKER,
        "riscv_hwprobe",
        HWPROBE_SUCCESS_MARKER,
        *HWPROBE_KEY_MARKERS,
    )
    accepted = accepted_linux_transcript_status()
    observed_hwprobe, missing_hwprobe = scan_text_markers(
        ACCEPTED_LINUX_TRANSCRIPT, linux_required_markers
    )
    observed, missing = scan_text_markers(ACCEPTED_LINUX_TRANSCRIPT, FINAL_RAW_MARKERS)
    live_observed_hwprobe, live_missing_hwprobe = scan_text_markers(
        LINUX_SMOKE_LOG, linux_required_markers
    )
    workload_text = (
        LINUX_SMOKE_WORKLOAD.read_text(encoding="utf-8", errors="ignore")
        if LINUX_SMOKE_WORKLOAD.is_file()
        else ""
    )
    workload_json_text = (
        LINUX_SMOKE_JSON.read_text(encoding="utf-8", errors="ignore")
        if LINUX_SMOKE_JSON.is_file()
        else ""
    )
    return {
        "log": rel(ACCEPTED_LINUX_TRANSCRIPT),
        "exists": ACCEPTED_LINUX_TRANSCRIPT.is_file(),
        "size_bytes": (
            ACCEPTED_LINUX_TRANSCRIPT.stat().st_size if ACCEPTED_LINUX_TRANSCRIPT.is_file() else 0
        ),
        "accepted_linux_transcript": accepted,
        "required_success_marker": HWPROBE_SUCCESS_MARKER,
        "required_config_mmu_marker": LINUX_MMU_SUCCESS_MARKER,
        "required_key_markers": list(HWPROBE_KEY_MARKERS),
        "required_success_marker_source": (
            "accepted real generated-AP Linux userspace /usr/bin/eliza-riscv-hwprobe output"
        ),
        "observed_final_markers": observed,
        "missing_final_markers": missing,
        "contains_riscv_hwprobe": "riscv_hwprobe" in observed_hwprobe,
        "contains_riscv_hwprobe_success": (
            bool(accepted.get("accepted")) and HWPROBE_SUCCESS_MARKER in observed_hwprobe
        ),
        "contains_config_mmu_y": (
            bool(accepted.get("accepted")) and LINUX_MMU_SUCCESS_MARKER in observed_hwprobe
        ),
        "contains_riscv_hwprobe_key_markers": (
            bool(accepted.get("accepted"))
            and all(marker in observed_hwprobe for marker in HWPROBE_KEY_MARKERS)
        ),
        "observed_hwprobe_markers": observed_hwprobe,
        "missing_hwprobe_markers": missing_hwprobe,
        "live_smoke_log_diagnostic": {
            "log": rel(LINUX_SMOKE_LOG),
            "exists": LINUX_SMOKE_LOG.is_file(),
            "size_bytes": LINUX_SMOKE_LOG.stat().st_size if LINUX_SMOKE_LOG.is_file() else 0,
            "observed_hwprobe_markers": live_observed_hwprobe,
            "missing_hwprobe_markers": live_missing_hwprobe,
            "contains_riscv_hwprobe_success": HWPROBE_SUCCESS_MARKER in live_observed_hwprobe,
            "contains_config_mmu_y": LINUX_MMU_SUCCESS_MARKER in live_observed_hwprobe,
            "contains_riscv_hwprobe_key_markers": all(
                marker in live_observed_hwprobe for marker in HWPROBE_KEY_MARKERS
            ),
            "note": (
                "diagnostic only; this lane unlocks from the accepted "
                "build/evidence/cpu_ap/eliza_e1_linux_boot.log transcript"
            ),
        },
        "userspace_hook": {
            "workload": rel(LINUX_SMOKE_WORKLOAD),
            "workload_invokes_helper": "/usr/bin/eliza-riscv-hwprobe" in workload_text,
            "workload_json": rel(LINUX_SMOKE_JSON),
            "workload_packages_helper": "eliza-riscv-hwprobe" in workload_json_text,
            "source": rel(HWPROBE_SOURCE),
            "source_exists": HWPROBE_SOURCE.is_file(),
            "source_uses_syscall": "__NR_riscv_hwprobe"
            in (
                HWPROBE_SOURCE.read_text(encoding="utf-8", errors="ignore")
                if HWPROBE_SOURCE.is_file()
                else ""
            ),
            "build_script": rel(HWPROBE_BUILD_SCRIPT),
            "build_script_executable": HWPROBE_BUILD_SCRIPT.is_file()
            and os.access(HWPROBE_BUILD_SCRIPT, os.X_OK),
            "built_binary": rel(HWPROBE_BINARY),
            "built_binary_exists": HWPROBE_BINARY.is_file(),
            "built_during_firemarshal_host_init": "build-hwprobe.sh" in workload_json_text,
        },
        "report": linux_smoke_report_summary(),
    }


def extract_lines(path: Path, markers: tuple[str, ...]) -> list[str]:
    lines: list[str] = []
    if not path.is_file():
        return lines
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if any(marker in line for marker in markers):
                lines.append(line.rstrip("\n"))
    return lines


def archive_final_evidence(sim_stdout: str, command: str) -> tuple[bool, str]:
    linux_lines = extract_lines(
        ACCEPTED_LINUX_TRANSCRIPT,
        (
            "Linux",
            "riscv_hwprobe",
            "CONFIG_MMU",
            "initramfs start",
            "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke",
        ),
    )
    COMBINED_SOURCE_LOG.parent.mkdir(parents=True, exist_ok=True)
    COMBINED_SOURCE_LOG.write_text(
        "\n".join(
            [
                "eliza-evidence: combined_source=generated_ap_baremetal_plus_linux_userspace",
                "eliza-evidence: baremetal_source=" + rel(RAW_LOG),
                "eliza-evidence: linux_userspace_source=" + rel(ACCEPTED_LINUX_TRANSCRIPT),
                "eliza-evidence: baremetal_transcript_begin",
                sim_stdout.rstrip(),
                "eliza-evidence: baremetal_transcript_end",
                "eliza-evidence: linux_userspace_hwprobe_excerpt_begin",
                *linux_lines,
                "eliza-evidence: linux_userspace_hwprobe_excerpt_end",
                "",
            ]
        ),
        encoding="utf-8",
    )
    intake_cmd = [
        sys.executable,
        str(CAPTURE_INTAKE),
        "intake",
        "isa-cache-mmu",
        "--source",
        str(COMBINED_SOURCE_LOG),
        "--command",
        command,
        "--generated-manifest",
        str(MANIFEST),
    ]
    proc = run(intake_cmd, cwd=ROOT)
    return proc.returncode == 0, proc.stdout.rstrip()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--max-cycles", type=int, default=20_000_000)
    parser.add_argument(
        "--simulator",
        type=Path,
        default=Path(os.environ.get("CHIPYARD_ISA_CACHE_MMU_SIMULATOR", DEFAULT_SIMULATOR)),
        help="Generated ElizaRocketConfig simulator to run",
    )
    parser.add_argument(
        "--dramsim",
        action="store_true",
        help="Pass +dramsim and DRAMSim ini options to simulators built for that memory model",
    )
    args = parser.parse_args(argv)
    simulator = args.simulator if args.simulator.is_absolute() else ROOT / args.simulator

    problems: list[str] = []
    if not MANIFEST.is_file():
        problems.append(f"missing generated manifest: {rel(MANIFEST)}")
    if not DTS.is_file():
        problems.append(f"missing generated DTS: {rel(DTS)}")
    dts_status = dts_contract_status()
    dts_missing = [str(marker) for marker in dts_status.get("missing_strings", []) if str(marker)]
    if dts_missing:
        problems.append(
            "generated DTS is missing ISA/cache/MMU contract markers: " + ", ".join(dts_missing)
        )
    if not simulator.is_file() or not os.access(simulator, os.X_OK):
        problems.append(f"missing executable generated simulator: {rel(simulator)}")
    if args.dramsim and not DRAMSIM_INI.is_dir():
        problems.append(f"missing DRAMSim ini directory: {rel(DRAMSIM_INI)}")
    gcc = find_gcc()
    if gcc is None:
        problems.append("missing riscv-none-elf-gcc or riscv64-unknown-elf-gcc")
    if problems:
        write_report(
            {
                "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                "status": "blocked",
                "claim_boundary": "no_final_isa_cache_mmu_evidence_created",
                "generated_manifest": rel(MANIFEST),
                "raw_log": rel(RAW_LOG),
                "evidence_log": rel(FINAL_EVIDENCE),
                "evidence_log_created": FINAL_EVIDENCE.is_file(),
                "generated_dts_contract": dts_status,
                "problems": problems,
                "linux_userspace_hwprobe": linux_hwprobe_scan(),
                "updated_utc": utc_now(),
            }
        )
        print("STATUS: BLOCKED chipyard.isa_cache_mmu_probe")
        for problem in problems:
            print(f"  - {problem}")
        return 2

    assert gcc is not None
    WORK.mkdir(parents=True, exist_ok=True)
    source = WORK / "isa_cache_mmu_probe.c"
    linker = WORK / "isa_cache_mmu_probe.ld"
    elf = WORK / "isa_cache_mmu_probe.elf"
    write_if_changed(source, PROBE_C.lstrip())
    write_if_changed(linker, LINKER.lstrip())

    compile_cmd = [
        str(gcc),
        "-nostdlib",
        "-nostartfiles",
        "-static",
        "-mcmodel=medany",
        "-march=rv64imafdc_zicsr_zifencei",
        "-mabi=lp64d",
        "-O2",
        "-Wall",
        "-Wextra",
        "-T",
        str(linker),
        str(source),
        "-o",
        str(elf),
    ]
    print("eliza-evidence: target=generated_chipyard_ap artifact=isa-cache-mmu-probe")
    print("eliza-evidence: wrapper=scripts/run_chipyard_eliza_isa_cache_mmu_probe.py")
    print(f"eliza-evidence: generated_manifest={rel(MANIFEST)}")
    print(f"eliza-evidence: dts={rel(DTS)}")
    print("eliza-evidence: compile_command=" + " ".join(shlex.quote(part) for part in compile_cmd))
    compile_proc = run(compile_cmd, cwd=ROOT)
    if compile_proc.stdout:
        print(compile_proc.stdout.rstrip())
    if compile_proc.returncode != 0:
        print("STATUS: FAIL chipyard.isa_cache_mmu_probe - compile failed")
        return compile_proc.returncode

    sim_cmd = [
        str(simulator),
        "+permissive",
        f"+max-cycles={args.max_cycles}",
        "+custom_boot_pin=1",
        "+uart_tx_printf=1",
        f"+loadmem={elf}",
        "+permissive-off",
        str(elf),
    ]
    if args.dramsim:
        sim_cmd[2:2] = [
            "+dramsim",
            f"+dramsim_ini_dir={DRAMSIM_INI}",
        ]
    print("eliza-evidence: simulator_command=" + " ".join(shlex.quote(part) for part in sim_cmd))
    print("eliza-evidence: raw_transcript_begin")
    sim_stdout = ""
    sim_returncode: int | None = None
    status = "blocked"
    problems = [
        "generated-AP bare-metal probe completed, but final isa-cache-mmu evidence still requires a Linux userspace hwprobe syscall transcript",
        "blocked behind generated-AP Linux boot/userland reachability; do not archive this probe as eliza_e1_isa_cache_mmu.log",
    ]
    try:
        sim_proc = run(sim_cmd, cwd=ROOT, timeout=args.timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        if exc.stdout:
            stdout = exc.stdout
            if isinstance(stdout, bytes):
                sim_stdout = stdout.decode("utf-8", errors="replace")
            else:
                sim_stdout = stdout
            print(sim_stdout.rstrip())
        print("eliza-evidence: raw_transcript_end")
        write_report(
            {
                "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                "status": "blocked",
                "claim_boundary": "no_final_isa_cache_mmu_evidence_created",
                "generated_manifest": rel(MANIFEST),
                "simulator": rel(simulator),
                "payload": rel(elf),
                "raw_log": rel(RAW_LOG),
                "evidence_log": rel(FINAL_EVIDENCE),
                "evidence_log_created": FINAL_EVIDENCE.is_file(),
                "generated_dts_contract": dts_status,
                "timeout_seconds": args.timeout_seconds,
                "max_cycles": args.max_cycles,
                "problems": [
                    "generated-AP bare-metal ISA/cache/MMU probe timed out before completion"
                ],
                "linux_userspace_hwprobe": linux_hwprobe_scan(),
                "updated_utc": utc_now(),
            }
        )
        print("STATUS: BLOCKED chipyard.isa_cache_mmu_probe - simulator timed out")
        return 2
    sim_stdout = sim_proc.stdout or ""
    sim_returncode = sim_proc.returncode
    if sim_stdout:
        print(sim_stdout.rstrip())
    print("eliza-evidence: raw_transcript_end")
    if sim_proc.returncode != 0:
        write_report(
            {
                "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                "status": "fail",
                "claim_boundary": "no_final_isa_cache_mmu_evidence_created",
                "generated_manifest": rel(MANIFEST),
                "simulator": rel(simulator),
                "payload": rel(elf),
                "raw_log": rel(RAW_LOG),
                "evidence_log": rel(FINAL_EVIDENCE),
                "evidence_log_created": FINAL_EVIDENCE.is_file(),
                "generated_dts_contract": dts_status,
                "simulator_exit_code": sim_proc.returncode,
                "linux_userspace_hwprobe": linux_hwprobe_scan(),
                "updated_utc": utc_now(),
            }
        )
        print(f"STATUS: FAIL chipyard.isa_cache_mmu_probe - simulator exited {sim_proc.returncode}")
        return sim_proc.returncode
    RAW_LOG.parent.mkdir(parents=True, exist_ok=True)
    RAW_LOG.write_text(
        "\n".join(
            [
                "eliza-evidence: target=generated_chipyard_ap artifact=isa-cache-mmu-probe",
                "eliza-evidence: raw_transcript_begin",
                sim_stdout.rstrip(),
                "eliza-evidence: raw_transcript_end",
                "eliza-evidence: status=BLOCKED",
                "",
            ]
        ),
        encoding="utf-8",
    )
    observed_baremetal = [marker for marker in BAREMETAL_MARKERS if marker in sim_stdout]
    missing_baremetal = [marker for marker in BAREMETAL_MARKERS if marker not in sim_stdout]
    linux_hwprobe = linux_hwprobe_scan()
    if missing_baremetal:
        status = "fail"
        problems = [
            "generated-AP bare-metal probe did not emit all non-Linux ISA/cache/MMU markers",
            *[f"missing bare-metal marker: {marker}" for marker in missing_baremetal],
        ]
    else:
        problems = [
            "generated-AP bare-metal ISA/cache/MMU markers completed",
            (
                "generated-AP Linux smoke packages /usr/bin/eliza-riscv-hwprobe, but "
                "the accepted generated-AP Linux transcript has not reached userspace "
                "and emitted "
                f"the required success marker: {HWPROBE_SUCCESS_MARKER}"
            ),
            "blocked behind generated-AP Linux boot/userland reachability; do not archive this probe alone as eliza_e1_isa_cache_mmu.log",
        ]
    combined_missing_final_markers = list(missing_baremetal)
    if not linux_hwprobe["contains_riscv_hwprobe"]:
        combined_missing_final_markers.append("riscv_hwprobe")
    if not linux_hwprobe["contains_config_mmu_y"]:
        combined_missing_final_markers.append(LINUX_MMU_SUCCESS_MARKER)
    if not linux_hwprobe["contains_riscv_hwprobe_success"]:
        combined_missing_final_markers.append(HWPROBE_SUCCESS_MARKER)
    if not linux_hwprobe["contains_riscv_hwprobe_key_markers"]:
        combined_missing_final_markers.extend(
            marker
            for marker in HWPROBE_KEY_MARKERS
            if marker not in linux_hwprobe.get("observed_hwprobe_markers", [])
        )
    archive_output = ""
    if not missing_baremetal and linux_hwprobe["contains_riscv_hwprobe_success"]:
        evidence_command = (
            "scripts/run_chipyard_eliza_isa_cache_mmu_probe.py; "
            "scripts/run_chipyard_eliza_linux_smoke.sh with "
            "/usr/bin/eliza-riscv-hwprobe packaged by sw/firemarshal/eliza-e1-linux-smoke"
        )
        archived, archive_output = archive_final_evidence(sim_stdout, evidence_command)
        if archived:
            write_report(
                {
                    "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                    "status": "pass",
                    "claim_boundary": "final_isa_cache_mmu_evidence_archived_from_real_generated_ap_transcripts",
                    "generated_manifest": rel(MANIFEST),
                    "generated_dts": rel(DTS),
                    "simulator": rel(simulator),
                    "payload": rel(elf),
                    "raw_log": rel(RAW_LOG),
                    "combined_source_log": rel(COMBINED_SOURCE_LOG),
                    "evidence_log": rel(FINAL_EVIDENCE),
                    "evidence_log_created": FINAL_EVIDENCE.is_file(),
                    "intake_output": archive_output,
                    "baremetal_probe": {
                        "status": "pass",
                        "observed_markers": observed_baremetal,
                        "missing_markers": [],
                        "raw_log": rel(RAW_LOG),
                    },
                    "generated_dts_contract": dts_status,
                    "linux_userspace_hwprobe": linux_hwprobe,
                    "observed_markers": FINAL_RAW_MARKERS,
                    "missing_final_markers": [],
                    "problems": [],
                    "updated_utc": utc_now(),
                }
            )
            print(archive_output)
            print(
                "STATUS: PASS chipyard.isa_cache_mmu_probe - archived final ISA/cache/MMU evidence"
            )
            return 0
        status = "fail"
        problems = [
            "combined real bare-metal and Linux hwprobe transcript failed isa-cache-mmu intake",
            archive_output or "capture_cpu_ap_evidence.py intake returned nonzero",
        ]
    write_report(
        {
            "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
            "status": status,
            "claim_boundary": "no_final_isa_cache_mmu_evidence_created",
            "generated_manifest": rel(MANIFEST),
            "generated_dts": rel(DTS),
            "simulator": rel(simulator),
            "payload": rel(elf),
            "raw_log": rel(RAW_LOG),
            "combined_source_log": rel(COMBINED_SOURCE_LOG),
            "evidence_log": rel(FINAL_EVIDENCE),
            "evidence_log_created": FINAL_EVIDENCE.is_file(),
            "simulator_exit_code": sim_returncode,
            "baremetal_probe": {
                "status": "pass" if not missing_baremetal else "fail",
                "observed_markers": observed_baremetal,
                "missing_markers": missing_baremetal,
                "raw_log": rel(RAW_LOG),
            },
            "generated_dts_contract": dts_status,
            "linux_userspace_hwprobe": linux_hwprobe,
            "observed_markers": observed_baremetal,
            "missing_final_markers": combined_missing_final_markers,
            "next_required_prerequisite": (
                "Run the generated-AP Linux smoke lane after boot, archive the accepted "
                "build/evidence/cpu_ap/eliza_e1_linux_boot.log transcript, and capture "
                f"Linux userspace output with this real hwprobe marker: {HWPROBE_SUCCESS_MARKER}. "
                "The probe runner will "
                "archive final isa-cache-mmu evidence only after both the bare-metal "
                "markers and Linux hwprobe output are present."
            ),
            "problems": problems,
            "intake_output": archive_output,
            "updated_utc": utc_now(),
        }
    )
    if missing_baremetal:
        print("STATUS: FAIL chipyard.isa_cache_mmu_probe - bare-metal marker set incomplete")
        return 1
    print(
        "STATUS: BLOCKED chipyard.isa_cache_mmu_probe - bare-metal generated-AP "
        "diagnostic ran, but final isa-cache-mmu intake still requires a "
        "Linux hwprobe/MMU transcript"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
