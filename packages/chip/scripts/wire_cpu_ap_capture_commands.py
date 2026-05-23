#!/usr/bin/env python3
"""Derive CPU/AP evidence capture commands from real generated-AP runners."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from typing import cast

from capture_cpu_ap_evidence import MODE_ENV, MODE_TO_TRANSCRIPT
from cpu_ap_evidence_lib import (
    GENERATED_MANIFEST,
    ROOT,
    load_evidence_manifest,
    rel,
    transcript_specs,
)

SMOKE_LOG = Path("build/chipyard/eliza_rocket/verilator-linux-smoke.log")
SMOKE_RUNNER = Path("scripts/run_chipyard_eliza_linux_smoke.sh")
TRAP_TIMER_IRQ_RUNNER = Path("scripts/run_chipyard_trap_timer_irq.sh")
ISA_CACHE_MMU_PROBE = Path("scripts/run_chipyard_eliza_isa_cache_mmu_probe.py")
ISA_CACHE_MMU_REPORT = ROOT / "build/reports/cpu_ap_isa_cache_mmu_probe.json"
PAYLOAD_LOCATOR = Path("scripts/locate_chipyard_linux_payload.py")
GENERATED_DTS = Path("build/chipyard/eliza_rocket/eliza-e1.dts")
GENERATED_SIMULATOR = Path(
    "build/chipyard/eliza_rocket/simulator/simulator-chipyard.harness-ElizaRocketConfig"
)
BAREMETAL_GCC = Path("tools/bin/riscv64-unknown-elf-gcc")
AP_BENCHMARK_REPORT = ROOT / "build/reports/cpu_ap_benchmark_runner_wiring.json"
AP_BENCHMARK_WORKLOAD = Path("sw/firemarshal/eliza-e1-ap-benchmarks.json")
AP_BENCHMARK_PAYLOAD = Path(
    "external/chipyard/software/firemarshal/images/firechip/"
    "eliza-e1-ap-benchmarks/eliza-e1-ap-benchmarks-bin-nodisk"
)
LINUX_SMOKE_WORKLOAD = Path("sw/firemarshal/eliza-e1-linux-smoke/eliza-e1-linux-smoke.sh")
AP_BENCHMARK_TOOLS = ("coremark", "stream_c.exe", "lat_mem_rd", "fio")
AP_REFERENCE_INPUTS = (
    Path("docs/evidence/cpu_ap/cva6-coremark-qemu.json"),
    Path("docs/evidence/cpu_ap/cva6-coremark-verilator.json"),
    Path("benchmarks/results/local-host-benchmark-evidence.json"),
    Path("build/reports/local-host-coremark-probe.json"),
)
AP_REQUIRED_COMMANDS = (
    "ELIZA_AP_BENCHMARKS_CMD",
    "marshal -v build sw/firemarshal/eliza-e1-ap-benchmarks.json",
    "CHIPYARD_LINUX_BINARY=external/chipyard/software/firemarshal/images/firechip/"
    "eliza-e1-ap-benchmarks/eliza-e1-ap-benchmarks-bin-nodisk "
    "scripts/run_chipyard_eliza_linux_smoke.sh",
    "scripts/capture_cpu_ap_evidence.py intake ap-benchmarks --source "
    "build/chipyard/eliza_rocket/verilator-linux-smoke.log --command "
    "\"$ELIZA_AP_BENCHMARKS_CMD\" --generated-manifest "
    "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json",
)
DERIVED_SMOKE_MODES = ("opensbi-boot", "linux-boot")
UNWIRED_MODES = ("ap-benchmarks",)


def quote(value: str) -> str:
    return shlex.quote(value)


def locate_payload() -> tuple[str | None, str | None]:
    locator = ROOT / PAYLOAD_LOCATOR
    if not locator.is_file():
        return None, f"missing payload locator: {PAYLOAD_LOCATOR}"
    proc = subprocess.run(
        [sys.executable, str(locator), "--export-env"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout).strip() or "payload locator failed"
    line = proc.stdout.strip()
    prefix = "export CHIPYARD_LINUX_BINARY="
    if not line.startswith(prefix):
        return None, line or "payload locator did not emit CHIPYARD_LINUX_BINARY"
    payload = line[len(prefix) :]
    payload_path = Path(payload)
    if not payload_path.is_file():
        return None, f"payload does not exist: {payload}"
    return str(payload_path), None


def smoke_command(payload: str, *, use_docker: str) -> str:
    return (
        f"CHIPYARD_LINUX_BINARY={quote(payload)} "
        f"CHIPYARD_LINUX_SMOKE_USE_DOCKER={quote(use_docker)} "
        f"{SMOKE_RUNNER.as_posix()}; "
        "status=$?; "
        f"if [ -f {quote(SMOKE_LOG.as_posix())} ]; then "
        f"cat {quote(SMOKE_LOG.as_posix())}; "
        "fi; "
        "exit $status"
    )


def is_riscv_elf(path: Path) -> bool:
    try:
        data = path.read_bytes()[:64]
    except OSError:
        return False
    if len(data) < 20 or data[:4] != b"\x7fELF":
        return False
    if data[5] != 1:
        return False
    return struct.unpack_from("<H", data, 18)[0] == 0xF3


def tool_candidates(name: str) -> list[Path]:
    candidates = [
        ROOT / "benchmarks/tools" / name,
        ROOT / "tools/bin" / name,
        ROOT / ".venv/bin" / name,
    ]
    found = shutil.which(name)
    if found:
        candidates.append(Path(found))

    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        resolved = str(candidate.resolve()) if candidate.exists() else str(candidate)
        if resolved not in seen:
            seen.add(resolved)
            deduped.append(candidate)
    return deduped


def classify_tool(path: Path) -> str:
    if not path.exists():
        return "missing"
    try:
        prefix = path.read_bytes()[:256 * 1024]
    except OSError:
        return "unreadable"
    if b"eliza-host-smoke" in prefix or path.resolve().is_relative_to(
        (ROOT / "benchmarks/tools").resolve()
    ):
        return "repo_local_host_smoke_not_generated_ap"
    if prefix.startswith(b"#!") and b"python" in prefix[:128].lower():
        return "script_not_target_riscv_binary"
    if is_riscv_elf(path):
        return "riscv_elf"
    if prefix.startswith(b"\x7fELF"):
        return "non_riscv_elf"
    return "non_elf_or_unknown"


def rooted(path: Path) -> Path:
    return path if path.is_absolute() else ROOT / path


def ap_required_markers() -> tuple[list[str], list[str]]:
    errors: list[str] = []
    manifest = load_evidence_manifest(errors)
    spec = transcript_specs(manifest).get("ap_benchmark_log", {})
    markers = spec.get("raw_required_strings", [])
    return ([str(marker) for marker in markers if isinstance(marker, str)], errors)


def ap_benchmark_runner_report() -> dict[str, object]:
    markers, marker_errors = ap_required_markers()
    smoke_script = ROOT / LINUX_SMOKE_WORKLOAD
    smoke_text = smoke_script.read_text(encoding="utf-8", errors="ignore") if smoke_script.is_file() else ""

    tools: list[dict[str, object]] = []
    target_ready_tools: list[str] = []
    for name in AP_BENCHMARK_TOOLS:
        records: list[dict[str, object]] = []
        for candidate in tool_candidates(name):
            kind = classify_tool(candidate)
            records.append(
                {
                    "path": rel(candidate),
                    "exists": candidate.exists(),
                    "kind": kind,
                    "acceptable_for_generated_ap": kind == "riscv_elf",
                }
            )
            if kind == "riscv_elf":
                target_ready_tools.append(name)
        tools.append(
            {
                "name": name,
                "required_for_marker": "STREAM Triad" if name == "stream_c.exe" else name,
                "candidates": records,
                "status": "ready" if name in target_ready_tools else "blocked",
            }
        )

    missing_tools = sorted(set(AP_BENCHMARK_TOOLS) - set(target_ready_tools))
    workload_path = rooted(AP_BENCHMARK_WORKLOAD)
    payload_path = rooted(AP_BENCHMARK_PAYLOAD)
    simulator_path = rooted(GENERATED_SIMULATOR)
    smoke_runner_path = rooted(SMOKE_RUNNER)
    evidence_path = ROOT / "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log"

    blockers: list[str] = []
    if os.environ.get(MODE_ENV["ap-benchmarks"], ""):
        blockers.append(
            f"{MODE_ENV['ap-benchmarks']} is set by the environment, but wiring cannot "
            "verify it as a checked-in generated-AP benchmark runner"
        )
    else:
        blockers.append(f"{MODE_ENV['ap-benchmarks']} is unset")
    if not simulator_path.is_file():
        blockers.append(f"missing generated-AP simulator: {GENERATED_SIMULATOR}")
    if not smoke_runner_path.is_file() or not os.access(smoke_runner_path, os.X_OK):
        blockers.append(f"missing executable generated-AP simulator wrapper: {SMOKE_RUNNER}")
    if not workload_path.is_file():
        blockers.append(f"missing generated-AP benchmark FireMarshal workload: {AP_BENCHMARK_WORKLOAD}")
    if not payload_path.is_file():
        blockers.append(f"missing generated-AP benchmark payload: {AP_BENCHMARK_PAYLOAD}")
    if missing_tools:
        blockers.append(
            "missing target-runnable RISC-V benchmark binaries for generated AP: "
            + ", ".join(missing_tools)
        )
    if smoke_text and not all(token in smoke_text for token in AP_BENCHMARK_TOOLS):
        blockers.append(
            "existing generated-AP Linux smoke payload runs MMIO smoke only; it does not run "
            "CoreMark, STREAM, lat_mem_rd, or fio"
        )
    blockers.append(
        "no generated-AP command currently emits the L3 benchmark raw markers: "
        "claim_level=L3, report hash, CPU frequency, run count, thermal state, "
        "power method, and process-corner/pdk boundary"
    )
    blockers.extend(f"manifest marker load error: {error}" for error in marker_errors)

    report: dict[str, object] = {
        "schema": "eliza.cpu_ap_benchmark_runner_wiring.v1",
        "status": "blocked",
        "command_env": MODE_ENV["ap-benchmarks"],
        "command_env_set": bool(os.environ.get(MODE_ENV["ap-benchmarks"], "")),
        "required_commands": list(AP_REQUIRED_COMMANDS),
        "claim_boundary": "blocked_report_only_no_benchmark_evidence_created",
        "evidence_log": "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
        "evidence_log_created": evidence_path.is_file(),
        "generated_manifest": rel(GENERATED_MANIFEST),
        "generated_manifest_exists": GENERATED_MANIFEST.is_file(),
        "required_raw_markers": markers,
        "candidate_generated_ap_inputs": {
            "simulator": "build/chipyard/eliza_rocket/simulator/simulator-chipyard.harness-ElizaRocketConfig",
            "simulator_exists": simulator_path.is_file(),
            "smoke_runner": str(SMOKE_RUNNER),
            "smoke_runner_executable": smoke_runner_path.is_file()
            and os.access(smoke_runner_path, os.X_OK),
            "linux_smoke_workload": str(LINUX_SMOKE_WORKLOAD),
            "benchmark_workload": str(AP_BENCHMARK_WORKLOAD),
            "benchmark_workload_exists": workload_path.is_file(),
            "benchmark_payload": str(AP_BENCHMARK_PAYLOAD),
            "benchmark_payload_exists": payload_path.is_file(),
        },
        "benchmark_tools": tools,
        "excluded_reference_inputs": [
            {
                "path": rel(rooted(path)),
                "exists": rooted(path).is_file(),
                "reason": "reference_only_not_generated_ap_l3_benchmark_proof",
            }
            for path in AP_REFERENCE_INPUTS
        ],
        "blockers": blockers,
        "next_required_prerequisite": (
            "Add a generated-AP FireMarshal/Linux benchmark workload with target-built "
            "CoreMark, STREAM, lmbench lat_mem_rd, and fio binaries plus calibrated "
            "frequency, run-count, thermal, power, and process-corner metadata; then "
            "wire ELIZA_AP_BENCHMARKS_CMD to that real simulator command and intake it."
        ),
    }
    AP_BENCHMARK_REPORT.parent.mkdir(parents=True, exist_ok=True)
    AP_BENCHMARK_REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def trap_timer_irq_problems() -> list[str]:
    problems: list[str] = []
    runner = ROOT / TRAP_TIMER_IRQ_RUNNER
    dts = ROOT / GENERATED_DTS
    simulator = ROOT / GENERATED_SIMULATOR
    gcc = ROOT / BAREMETAL_GCC

    if not GENERATED_MANIFEST.is_file():
        problems.append(f"missing generated manifest: {rel(GENERATED_MANIFEST)}")
    if not runner.is_file() or not os.access(runner, os.X_OK):
        problems.append(f"missing executable trap/timer/IRQ runner: {TRAP_TIMER_IRQ_RUNNER}")
    if not dts.is_file():
        problems.append(f"missing generated DTS: {GENERATED_DTS}")
    else:
        dts_text = dts.read_text(encoding="utf-8", errors="ignore")
        for token in ("interrupt-controller@c000000", "clint@2000000", "serial@10001000"):
            if token not in dts_text:
                problems.append(f"generated DTS lacks required trap/timer/IRQ node: {token}")
    if not simulator.is_file() or not os.access(simulator, os.X_OK):
        problems.append(f"missing executable generated simulator: {GENERATED_SIMULATOR}")
    if not gcc.is_file() or not os.access(gcc, os.X_OK):
        problems.append(f"missing riscv64 bare-metal compiler: {BAREMETAL_GCC}")
    return problems


def build_entries(args: argparse.Namespace) -> list[dict[str, object]]:
    manifest_ok = GENERATED_MANIFEST.is_file()
    payload, payload_problem = locate_payload()
    runner = ROOT / SMOKE_RUNNER
    runner_ok = runner.is_file() and os.access(runner, os.X_OK)
    ap_report = ap_benchmark_runner_report()

    entries: list[dict[str, object]] = []
    for mode in sorted(MODE_TO_TRANSCRIPT):
        env_name = MODE_ENV[mode]
        existing = os.environ.get(env_name, "")
        problems: list[str] = []
        entry: dict[str, object] = {
            "mode": mode,
            "command_env": env_name,
            "status": "blocked",
            "source": "unwired",
            "command": existing,
            "problems": problems,
        }

        if existing:
            entry["status"] = "ready"
            entry["source"] = "environment"
        elif mode in DERIVED_SMOKE_MODES:
            if not manifest_ok:
                problems.append(f"missing generated manifest: {rel(GENERATED_MANIFEST)}")
            if not runner_ok:
                problems.append(f"missing executable smoke runner: {SMOKE_RUNNER}")
            if payload_problem:
                problems.append(payload_problem)
            if not problems and payload:
                entry["status"] = "ready"
                entry["source"] = "generated_ap_linux_smoke"
                entry["command"] = smoke_command(payload, use_docker=args.use_docker)
        elif mode == "isa-cache-mmu":
            probe = ROOT / ISA_CACHE_MMU_PROBE
            entry["source"] = "generated_ap_isa_cache_mmu_probe"
            entry["command"] = ISA_CACHE_MMU_PROBE.as_posix()
            entry["blocked_report"] = rel(ISA_CACHE_MMU_REPORT)
            if not manifest_ok:
                problems.append(f"missing generated manifest: {rel(GENERATED_MANIFEST)}")
            if not probe.is_file() or not os.access(probe, os.X_OK):
                problems.append(f"missing executable ISA/cache/MMU probe: {ISA_CACHE_MMU_PROBE}")
            else:
                problems.append(
                    "checked-in generated-AP bare-metal diagnostic emits ISA/cache/MMU "
                    "markers, but final evidence still needs generated-AP Linux userspace "
                    "hwprobe output before ELIZA_ISA_CACHE_MMU_CMD can be exported"
                )
        elif mode == "trap-timer-irq":
            entry["source"] = "generated_ap_trap_timer_irq_runner"
            entry["command"] = TRAP_TIMER_IRQ_RUNNER.as_posix()
            problems.extend(trap_timer_irq_problems())
            if not problems:
                entry["status"] = "ready"
        elif mode in UNWIRED_MODES:
            if mode == "ap-benchmarks":
                entry["source"] = "blocked_generated_ap_benchmark_runner_report"
                entry["blocked_report"] = rel(AP_BENCHMARK_REPORT)
                problems.extend(cast(list[str], ap_report.get("blockers", [])))
            else:
                problems.append(
                    "no checked-in generated-AP test runner is available for this lane; "
                    f"set {env_name} to a real command that emits the required markers"
                )
        entries.append(entry)
    return entries


def print_shell(entries: list[dict[str, object]]) -> None:
    print("# Source this on the Linux host before scripts/capture_chipyard_linux_evidence.sh.")
    print("# Only real generated-AP runner commands are exported; missing lanes stay blocked.")
    print(f"export ELIZA_GENERATED_MANIFEST={quote(rel(GENERATED_MANIFEST))}")
    for entry in entries:
        env_name = str(entry["command_env"])
        command = str(entry.get("command") or "")
        if command and entry["status"] == "ready":
            print(f"export {env_name}={quote(command)}")
        else:
            problem_items = cast(list[str], entry.get("problems", []))
            problems = "; ".join(str(item).replace("\n", " | ") for item in problem_items)
            print(f"# BLOCKED {entry['mode']}: {env_name} unset. {problems}")


def print_text(entries: list[dict[str, object]]) -> None:
    print("CPU/AP capture command wiring")
    print(f"Generated manifest: {rel(GENERATED_MANIFEST)}")
    print("Claim boundary: command wiring only; no evidence is created")
    for entry in entries:
        print(f"- {entry['mode']}: {entry['status']} ({entry['source']})")
        print(f"  command env: {entry['command_env']}")
        for problem in cast(list[str], entry.get("problems", [])):
            print(f"  - {problem}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=["text", "json", "shell"], default="text")
    parser.add_argument(
        "--use-docker",
        choices=["0", "1", "auto"],
        default="0",
        help="Value embedded in derived CHIPYARD_LINUX_SMOKE_USE_DOCKER commands.",
    )
    parser.add_argument("--require-all", action="store_true")
    args = parser.parse_args(argv)

    entries = build_entries(args)
    if args.format == "json":
        print(
            json.dumps(
                {
                    "schema": "eliza.cpu_ap_capture_command_wiring.v1",
                    "generated_manifest": rel(GENERATED_MANIFEST),
                    "claim_boundary": "command_wiring_only_no_evidence_created",
                    "entries": entries,
                },
                indent=2,
                sort_keys=True,
            )
        )
    elif args.format == "shell":
        print_shell(entries)
    else:
        print_text(entries)

    blocked = [entry for entry in entries if entry["status"] != "ready"]
    return 2 if args.require_all and blocked else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
