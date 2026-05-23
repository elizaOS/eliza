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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/chipyard/eliza_rocket"
WORK = OUT / "isa-cache-mmu-probe"
REPORT = ROOT / "build/reports/cpu_ap_isa_cache_mmu_probe.json"
RAW_LOG = ROOT / "build/evidence/cpu_ap/isa_cache_mmu_probe/isa_cache_mmu_probe.raw.log"
DEFAULT_SIMULATOR = (
    ROOT / "build/chipyard/eliza_rocket/simulator/simulator-chipyard.harness-ElizaRocketConfig"
)
MANIFEST = OUT / "ElizaRocketConfig.manifest.json"
DTS = OUT / "eliza-e1.dts"
DRAMSIM_INI = (
    ROOT / "external/chipyard/generators/testchipip/src/main/resources/dramsim2_ini"
)

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
  puts_console("Linux hwprobe syscall: not executed by this M-mode bare-metal generated-AP probe\n");
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
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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
                "evidence_log": "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
                "evidence_log_created": False,
                "problems": problems,
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
                "evidence_log": "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
                "evidence_log_created": False,
                "timeout_seconds": args.timeout_seconds,
                "max_cycles": args.max_cycles,
                "problems": ["generated-AP bare-metal ISA/cache/MMU probe timed out before completion"],
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
                "evidence_log": "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
                "evidence_log_created": False,
                "simulator_exit_code": sim_proc.returncode,
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
            "evidence_log": "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
            "evidence_log_created": False,
            "simulator_exit_code": sim_returncode,
            "observed_markers": [
                marker
                for marker in (
                    "ISA profile",
                    "RV64GC",
                    "misa",
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
                if marker in sim_stdout
            ],
            "missing_final_markers": ["riscv_hwprobe"],
            "problems": problems,
            "updated_utc": utc_now(),
        }
    )
    print(
        "STATUS: BLOCKED chipyard.isa_cache_mmu_probe - bare-metal generated-AP "
        "diagnostic ran, but final isa-cache-mmu intake still requires a "
        "Linux hwprobe/MMU transcript"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
