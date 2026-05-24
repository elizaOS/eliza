#!/usr/bin/env python3
"""Intake real CPU/AP transcripts and print generated-artifact hashes.

This helper does not run Chipyard, OpenSBI, or Linux. It only validates and
archives transcripts produced by an external generated RV64GC AP run.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from cpu_ap_evidence_lib import (
    GENERATED_MANIFEST,
    ROOT,
    artifact_specs,
    load_evidence_manifest,
    reconstruct_uart_tx_text,
    rel,
    sha256_path,
    text_problems,
    transcript_specs,
)

MODE_TO_TRANSCRIPT = {
    "ap-benchmarks": ("ap_benchmark_log", "eliza_e1_ap_benchmarks"),
    "isa-cache-mmu": ("isa_cache_mmu_log", "eliza_e1_isa_cache_mmu"),
    "opensbi-boot": ("opensbi_boot_log", "eliza_e1_opensbi_boot"),
    "linux-boot": ("linux_boot_log", "eliza_e1_linux_boot"),
    "trap-timer-irq": ("trap_timer_irq_log", "eliza_e1_trap_timer_irq"),
}

MODE_ENV = {
    "ap-benchmarks": "ELIZA_AP_BENCHMARKS_CMD",
    "isa-cache-mmu": "ELIZA_ISA_CACHE_MMU_CMD",
    "opensbi-boot": "ELIZA_OPENSBI_BOOT_CMD",
    "linux-boot": "ELIZA_LINUX_BOOT_CMD",
    "trap-timer-irq": "ELIZA_TRAP_TIMER_IRQ_CMD",
}

DTS_BOOT_REQUIREMENTS = {
    "cpu node": [r"\bcpus\s*\{", r"device_type\s*=\s*\"cpu\""],
    "memory node": [r"memory@[0-9a-fA-F]+", r"device_type\s*=\s*\"memory\""],
    "timer node": [r"riscv,clint0", r"riscv,aclint-mtimer", r"riscv,aclint-mswi"],
    "interrupt controller": [r"interrupt-controller", r"riscv,plic0"],
    "uart console": [r"serial@[0-9a-fA-F]+", r"ns16550", r"sifive,uart"],
    "chosen stdout": [r"stdout-path", r"bootargs\s*=.*console="],
}

E1_PERIPHERAL_REQUIREMENTS = {
    "e1 npu mmio": [r"eliza,e1-npu"],
    "e1 dma mmio": [r"eliza,e1-dma"],
    "e1 display mmio": [r"eliza,e1-display"],
}


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_manifest_or_exit() -> dict:
    errors: list[str] = []
    manifest = load_evidence_manifest(errors)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
    return manifest


def strip_dts_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//.*", "", text)


def dts_audit(args: argparse.Namespace) -> int:
    path = Path(args.path).expanduser()
    if not path.is_absolute():
        path = ROOT / path
    if not path.is_file():
        print(f"STATUS: BLOCKED cpu_ap.dts_boot_audit - DTS is missing: {rel(path)}")
        return 1 if args.require_bootable else 0

    text = path.read_text(encoding="utf-8", errors="ignore")
    uncommented = strip_dts_comments(text)
    missing: list[str] = []
    for label, patterns in DTS_BOOT_REQUIREMENTS.items():
        if not any(re.search(pattern, uncommented, flags=re.I | re.S) for pattern in patterns):
            missing.append(label)
    missing_e1: list[str] = []
    for label, patterns in E1_PERIPHERAL_REQUIREMENTS.items():
        if not any(re.search(pattern, uncommented, flags=re.I | re.S) for pattern in patterns):
            missing_e1.append(label)
    if args.require_e1_peripherals:
        missing.extend(missing_e1)
    serial_blocks = re.findall(
        r"serial@[0-9a-fA-F]+\s*\{.*?\n\s*\};", uncommented, flags=re.I | re.S
    )
    if serial_blocks and not any(
        "status" not in block or "disabled" not in block for block in serial_blocks
    ):
        missing.append("enabled uart console")

    dtc_rc = 0
    dtc_msg = "dtc not available"
    if args.run_dtc and shutil.which("dtc"):
        with tempfile.NamedTemporaryFile(suffix=".dtb") as tmp:
            proc = subprocess.run(
                ["dtc", "-I", "dts", "-O", "dtb", "-o", tmp.name, str(path)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            dtc_rc = proc.returncode
            dtc_msg = (proc.stderr or proc.stdout).strip() or "dtc compiled DTS"

    if dtc_rc != 0:
        print(f"STATUS: FAIL cpu_ap.dts_boot_audit - dtc failed for {rel(path)}")
        print(dtc_msg)
        return 1

    if missing:
        print(f"STATUS: BLOCKED cpu_ap.dts_boot_audit - {rel(path)} is not a complete AP boot DTB")
        for item in missing:
            print(f"  - missing {item}")
        if args.run_dtc:
            print(f"  dtc: {dtc_msg}")
        return 1 if args.require_bootable else 0

    print(f"STATUS: PASS cpu_ap.dts_boot_audit - {rel(path)} has AP boot DTB markers")
    if missing_e1:
        print("  note: generated DTS lacks e1 peripheral smoke markers: " + ", ".join(missing_e1))
        print(
            "  note: linux-boot evidence still needs a real e1 MMIO smoke result "
            "from the selected AP/software integration"
        )
    if args.run_dtc:
        print(f"  dtc: {dtc_msg}")
    return 0


def intake(args: argparse.Namespace) -> int:
    manifest = load_manifest_or_exit()
    transcript_key, artifact_name = MODE_TO_TRANSCRIPT[args.mode]
    spec = transcript_specs(manifest)[transcript_key]
    generated_manifest = Path(args.generated_manifest)
    if not generated_manifest.is_absolute():
        generated_manifest = ROOT / generated_manifest
    if not generated_manifest.is_file():
        print(
            f"error: generated import manifest does not exist: {rel(generated_manifest)}",
            file=sys.stderr,
        )
        print(
            "STATUS: BLOCKED cpu_ap.transcript_intake - generate/import ElizaRocketConfig before archiving boot evidence"
        )
        return 2
    source = Path(args.source).expanduser()
    if not source.is_file():
        print(f"error: source transcript does not exist: {source}", file=sys.stderr)
        return 1

    raw_text = source.read_text(encoding="utf-8", errors="ignore")
    reconstructed_uart = reconstruct_uart_tx_text(raw_text)
    validation_text = str(args.command) + "\n" + raw_text
    if reconstructed_uart:
        validation_text += (
            "\neliza-evidence: reconstructed_uart_tx_begin\n"
            + reconstructed_uart
            + "\neliza-evidence: reconstructed_uart_tx_end\n"
        )
    problems = text_problems(validation_text, spec, str(source), raw=True)
    if problems:
        print("STATUS: FAIL cpu_ap.transcript_intake - source transcript is not acceptable")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    generated_manifest_rel = (
        rel(generated_manifest.resolve())
        if generated_manifest.is_absolute()
        else str(generated_manifest)
    )
    generated_manifest_sha = sha256_path(generated_manifest)

    destination = ROOT / str(spec["path"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    captured = "\n".join(
        [
            f"eliza-evidence: target=cpu_ap artifact={artifact_name}",
            f"eliza-evidence: source={source}",
            f"eliza-evidence: command={args.command}",
            f"eliza-evidence: generated_manifest={generated_manifest_rel}",
            f"eliza-evidence: generated_manifest_sha256={generated_manifest_sha}",
            f"eliza-evidence: intake_utc={utc_now()}",
            "eliza-evidence: raw_transcript_begin",
            raw_text.rstrip(),
            *(
                [
                    "eliza-evidence: reconstructed_uart_tx_begin",
                    reconstructed_uart.rstrip(),
                    "eliza-evidence: reconstructed_uart_tx_end",
                ]
                if reconstructed_uart
                else []
            ),
            "eliza-evidence: raw_transcript_end",
            "eliza-evidence: status=PASS",
            "",
        ]
    )
    destination.write_text(captured, encoding="utf-8")
    digest = sha256_path(destination)
    print(f"STATUS: PASS cpu_ap.transcript_intake - archived {rel(destination)} sha256={digest}")
    print(f"  update generated import manifest evidence_sha256.{spec['sha256_key']}={digest}")
    return 0


def hashes(_: argparse.Namespace) -> int:
    manifest = load_manifest_or_exit()
    print("CPU/AP generated artifact hashes for import manifest:")
    for name, spec in artifact_specs(manifest).items():
        path = ROOT / str(spec["path"])
        if path.exists():
            print(f"  artifact_sha256.{spec['sha256_key']}={sha256_path(path)}  # {name}")
        else:
            print(f"  missing {spec['path']}  # {name}")
    print("CPU/AP transcript hashes for import manifest:")
    for name, spec in transcript_specs(manifest).items():
        path = ROOT / str(spec["path"])
        if path.exists():
            print(f"  evidence_sha256.{spec['sha256_key']}={sha256_path(path)}  # {name}")
        else:
            print(f"  missing {spec['path']}  # {name}")
    return 0


def template(args: argparse.Namespace) -> int:
    manifest = load_manifest_or_exit()
    modes = [args.mode] if args.mode != "all" else sorted(MODE_TO_TRANSCRIPT)
    for mode in modes:
        transcript_key, artifact_name = MODE_TO_TRANSCRIPT[mode]
        spec = transcript_specs(manifest)[transcript_key]
        print(f"# {mode}: {spec['artifact']}")
        print(f"# destination: {spec['path']}")
        print(f"# command env: {MODE_ENV[mode]}")
        print("# Raw transcript from the generated AP simulator must contain these markers:")
        for marker in spec.get("raw_required_strings", []):
            print(f"# - {marker}")
        print("#")
        print(f"eliza-evidence: template_for={artifact_name}")
        print("eliza-evidence: replace_this_file_with_real_generated_ap_output=true")
        print()
    return 0


def capture_plan(args: argparse.Namespace) -> int:
    manifest = load_manifest_or_exit()
    modes = [args.mode] if args.mode != "all" else sorted(MODE_TO_TRANSCRIPT)
    entries: list[dict[str, object]] = []
    for mode in modes:
        transcript_key, artifact_name = MODE_TO_TRANSCRIPT[mode]
        spec = transcript_specs(manifest)[transcript_key]
        entries.append(
            {
                "mode": mode,
                "artifact": artifact_name,
                "artifact_label": spec.get("artifact"),
                "destination": spec.get("path"),
                "command_env": MODE_ENV[mode],
                "raw_required_strings": spec.get("raw_required_strings", []),
                "intake_command": (
                    "python3 scripts/capture_cpu_ap_evidence.py intake "
                    f'{mode} --source /path/to/{mode}.log --command "$'
                    f'{MODE_ENV[mode]}"'
                ),
            }
        )

    if args.format == "json":
        print(
            json.dumps(
                {
                    "schema": "eliza.cpu_ap_capture_plan.v1",
                    "generated_manifest": str(GENERATED_MANIFEST.relative_to(ROOT)),
                    "wrapper": "scripts/capture_chipyard_linux_evidence.sh",
                    "claim_boundary": "plan_only_no_boot_claim",
                    "entries": entries,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    if args.format == "shell":
        print("# Fill these with commands that run the generated AP simulator/tests.")
        print("# The capture wrapper archives only transcripts that pass marker validation.")
        for entry in entries:
            print(f"# {entry['mode']} -> {entry['destination']}")
            print(f"export {entry['command_env']}=''")
        print("scripts/capture_chipyard_linux_evidence.sh all")
        return 0

    print("CPU/AP generated-AP capture plan")
    print(f"Generated manifest: {GENERATED_MANIFEST.relative_to(ROOT)}")
    print("Wrapper: scripts/capture_chipyard_linux_evidence.sh all")
    for entry in entries:
        print(f"- {entry['mode']}: {entry['destination']}")
        print(f"  command env: {entry['command_env']}")
        print("  required raw markers:")
        raw_required_strings = entry["raw_required_strings"]
        markers = raw_required_strings if isinstance(raw_required_strings, list) else []
        for marker in markers:
            print(f"    - {marker}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    intake_parser = sub.add_parser("intake", help="validate and archive a real transcript")
    intake_parser.add_argument("mode", choices=sorted(MODE_TO_TRANSCRIPT))
    intake_parser.add_argument(
        "--source", required=True, help="Path to the captured external transcript"
    )
    intake_parser.add_argument(
        "--command",
        required=True,
        help="Exact command that produced the transcript; this is recorded as evidence metadata",
    )
    intake_parser.add_argument(
        "--generated-manifest",
        default=str(GENERATED_MANIFEST.relative_to(ROOT)),
        help="Generated import manifest used for this run",
    )
    intake_parser.set_defaults(func=intake)

    hashes_parser = sub.add_parser("hashes", help="print hashes for existing CPU/AP artifacts")
    hashes_parser.set_defaults(func=hashes)

    template_parser = sub.add_parser(
        "template",
        help="print required marker checklists for raw generated-AP transcripts",
    )
    template_parser.add_argument("mode", choices=["all", *sorted(MODE_TO_TRANSCRIPT)])
    template_parser.set_defaults(func=template)

    plan_parser = sub.add_parser(
        "plan",
        help="print the generated-AP capture plan and command environment variables",
    )
    plan_parser.add_argument("mode", choices=["all", *sorted(MODE_TO_TRANSCRIPT)])
    plan_parser.add_argument("--format", choices=["text", "json", "shell"], default="text")
    plan_parser.set_defaults(func=capture_plan)

    dts_parser = sub.add_parser(
        "dts-audit",
        help="check whether a DTS has the CPU/memory/timer/IRQ/UART markers needed for AP boot",
    )
    dts_parser.add_argument(
        "--path",
        default=str((ROOT / "build/chipyard/eliza_rocket/eliza-e1.dts").relative_to(ROOT)),
        help="DTS path to audit; defaults to the generated selected AP DTS",
    )
    dts_parser.add_argument(
        "--run-dtc",
        action="store_true",
        help="Also compile the DTS with dtc when dtc is available in PATH",
    )
    dts_parser.add_argument(
        "--require-bootable",
        action="store_true",
        help="Return nonzero when AP boot markers are missing",
    )
    dts_parser.add_argument(
        "--require-e1-peripherals",
        action="store_true",
        help="Also require e1 NPU/DMA/display MMIO markers used by the Linux smoke claim",
    )
    dts_parser.set_defaults(func=dts_audit)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
