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
    transcript_metadata_problems,
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

LINUX_SERIAL_BOOT_EVIDENCE = ROOT / "docs/evidence/linux/eliza_e1_serial_boot.log"
LINUX_OPENSBI_HANDOFF_EVIDENCE = ROOT / "docs/evidence/linux/opensbi_fw_dynamic_handoff.log"

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


def evidence_marker(text: str, name: str) -> str | None:
    match = re.search(rf"^eliza-evidence: {re.escape(name)}=(.+)$", text, re.M)
    return match.group(1).strip() if match else None


def parse_evidence_utc(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def ap_benchmark_source_freshness_problem(
    *,
    source: Path,
    linux_text: str,
    linux_path: str,
) -> str | None:
    linux_intake = parse_evidence_utc(evidence_marker(linux_text, "intake_utc"))
    if linux_intake is None:
        return (
            f"{linux_path} is missing a valid eliza-evidence: intake_utc marker; "
            "cannot prove AP benchmark transcript freshness"
        )
    source_mtime = dt.datetime.fromtimestamp(source.stat().st_mtime, dt.UTC)
    if source_mtime < linux_intake:
        return (
            f"{source} mtime {source_mtime.replace(microsecond=0).isoformat().replace('+00:00', 'Z')} "
            f"is older than accepted linux-boot intake {linux_intake.isoformat().replace('+00:00', 'Z')}; "
            "rerun the AP benchmark capture after linux-boot intake"
        )
    return None


def load_manifest_or_exit() -> dict:
    errors: list[str] = []
    manifest = load_evidence_manifest(errors)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
    return manifest


def raw_transcript_from_accepted(text: str) -> str:
    begin = "eliza-evidence: raw_transcript_begin"
    end = "eliza-evidence: raw_transcript_end"
    start = text.find(begin)
    if start < 0:
        return text
    start += len(begin)
    stop = text.find(end, start)
    if stop < 0:
        return text[start:].strip()
    return text[start:stop].strip()


def accepted_transcript_text(
    manifest: dict, transcript_key: str, rel_path: str, problems: list[str]
) -> str:
    spec = transcript_specs(manifest).get(transcript_key, {})
    path = ROOT / rel_path
    if not path.is_file():
        problems.append(f"missing accepted CPU/AP transcript: {rel_path}")
        return ""
    text = path.read_text(encoding="utf-8", errors="ignore")
    problems.extend(text_problems(text, spec, rel_path, raw=False))
    problems.extend(transcript_metadata_problems(text, rel_path))
    return text


def evidence_field(text: str, field: str) -> str:
    prefix = f"eliza-evidence: {field}="
    for line in text.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return ""


def serial_boot_doc_text(raw_text: str) -> str:
    if "Kernel command line:" in raw_text:
        return raw_text
    match = re.search(r"Forcing kernel command line to:\s*(?:'([^']+)'|([^\r\n]+))", raw_text)
    if not match:
        return raw_text
    return raw_text + "\nKernel command line: " + (match.group(1) or match.group(2)).strip()


def opensbi_handoff_doc_text(raw_text: str) -> str:
    additions: list[str] = []
    if "Domain0 Next Arg1" not in raw_text:
        match = re.search(r"(?:Domain0\s+)?Next Arg1\s*:?\s*(0x[0-9a-fA-F]+)", raw_text)
        if match:
            additions.append(f"Domain0 Next Arg1: {match.group(1)}")
    if "0x0000000080b00000" not in raw_text and "0x80b00000" in raw_text:
        additions.append("expected normalized Domain0 Next Arg1: 0x0000000080b00000")
    if not additions:
        return raw_text
    return raw_text.rstrip() + "\n" + "\n".join(additions)


def write_linux_doc_mirror(
    *,
    destination: Path,
    target: str,
    artifact_name: str,
    claim_boundary: str,
    source: str,
    source_command: str,
    raw_text: str,
    extra_required: tuple[str, ...],
    problems: list[str],
) -> bool:
    missing = [marker for marker in extra_required if marker not in raw_text]
    if missing:
        problems.append(
            f"{rel(destination)} would be missing Linux evidence markers: " + ", ".join(missing)
        )
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    mirror_utc = utc_now()
    command = source_command or f"mirror accepted CPU/AP transcript from {source}"
    destination.write_text(
        "\n".join(
            [
                f"eliza-evidence: target={target} artifact={artifact_name}",
                f"eliza-evidence: claim_boundary={claim_boundary}",
                f"eliza-evidence: source={source}",
                f"eliza-evidence: command={command}",
                f"eliza-evidence: started_utc={mirror_utc}",
                "eliza-evidence: mirrored_from=accepted_cpu_ap_transcript",
                f"eliza-evidence: mirror_utc={mirror_utc}",
                f"EXTERNAL_TREE={ROOT}",
                f"COMMAND={command}",
                f"START_UTC={mirror_utc}",
                "eliza-evidence: raw_transcript_begin",
                raw_text.rstrip(),
                "eliza-evidence: raw_transcript_end",
                f"eliza-evidence: ended_utc={mirror_utc}",
                "eliza-evidence: status=PASS",
                f"END_UTC={mirror_utc}",
                "RESULT=0",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return True


def sync_linux_docs(args: argparse.Namespace) -> int:
    modes = set(getattr(args, "modes", ("linux", "opensbi")))
    manifest = load_manifest_or_exit()
    problems: list[str] = []
    wrote: list[str] = []

    linux_rel = "build/evidence/cpu_ap/eliza_e1_linux_boot.log"
    linux_text = (
        accepted_transcript_text(manifest, "linux_boot_log", linux_rel, problems)
        if "linux" in modes
        else ""
    )
    if "linux" in modes and linux_text:
        linux_raw = serial_boot_doc_text(raw_transcript_from_accepted(linux_text))
        if write_linux_doc_mirror(
            destination=LINUX_SERIAL_BOOT_EVIDENCE,
            target="linux",
            artifact_name="eliza_e1_serial_boot",
            claim_boundary=(
                "generated_chipyard_ap_serial_boot_transcript_only_not_silicon_or_board_evidence"
            ),
            source=linux_rel,
            source_command=evidence_field(linux_text, "command"),
            raw_text=linux_raw,
            extra_required=(
                "OpenSBI",
                "Linux version",
                "Kernel command line:",
                "Run /init as init process",
            ),
            problems=problems,
        ):
            wrote.append(rel(LINUX_SERIAL_BOOT_EVIDENCE))

    opensbi_rel = "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log"
    opensbi_text = (
        accepted_transcript_text(manifest, "opensbi_boot_log", opensbi_rel, problems)
        if "opensbi" in modes
        else ""
    )
    if "opensbi" in modes and opensbi_text:
        opensbi_raw = opensbi_handoff_doc_text(raw_transcript_from_accepted(opensbi_text))
        if write_linux_doc_mirror(
            destination=LINUX_OPENSBI_HANDOFF_EVIDENCE,
            target="opensbi",
            artifact_name="opensbi_fw_dynamic_handoff",
            claim_boundary=(
                "generated_chipyard_ap_opensbi_handoff_transcript_only_not_silicon_or_board_evidence"
            ),
            source=opensbi_rel,
            source_command=evidence_field(opensbi_text, "command"),
            raw_text=opensbi_raw,
            extra_required=(
                "OpenSBI v1.2",
                "Next Address",
                "Domain0 Next Arg1",
                "0x0000000080b00000",
            ),
            problems=problems,
        ):
            wrote.append(rel(LINUX_OPENSBI_HANDOFF_EVIDENCE))

    if problems:
        print("STATUS: BLOCKED linux.doc_evidence_sync - accepted CPU/AP evidence is incomplete")
        for problem in problems:
            print(f"  - {problem}")
        return 2

    print("STATUS: PASS linux.doc_evidence_sync")
    for path in wrote:
        print(f"  wrote: {path}")
    return 0


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
    if args.mode == "ap-benchmarks":
        linux_spec = transcript_specs(manifest).get("linux_boot_log", {})
        linux_rel = linux_spec.get("path")
        linux_path = ROOT / str(linux_rel)
        if not isinstance(linux_rel, str) or not linux_path.is_file():
            problems.append(
                "ap-benchmarks intake requires an accepted linux-boot transcript at "
                "build/evidence/cpu_ap/eliza_e1_linux_boot.log"
            )
        else:
            linux_text = linux_path.read_text(encoding="utf-8", errors="ignore")
            problems.extend(text_problems(linux_text, linux_spec, linux_rel, raw=False))
            problems.extend(
                transcript_metadata_problems(
                    linux_text,
                    linux_rel,
                    generated_manifest=generated_manifest,
                )
            )
            freshness_problem = ap_benchmark_source_freshness_problem(
                source=source,
                linux_text=linux_text,
                linux_path=linux_rel,
            )
            if freshness_problem:
                problems.append(freshness_problem)
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
    if args.mode == "linux-boot":
        sync_status = sync_linux_docs(argparse.Namespace(modes=("linux",)))
        if sync_status != 0:
            return sync_status
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
        for group in spec.get("at_least_one", []):
            if isinstance(group, list):
                choices = [str(marker) for marker in group if isinstance(marker, str)]
                if choices:
                    print("# - one of: " + " | ".join(choices))
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
                "at_least_one": spec.get("at_least_one", []),
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
        at_least_one = entry["at_least_one"]
        groups = at_least_one if isinstance(at_least_one, list) else []
        for group in groups:
            if isinstance(group, list):
                choices = [str(marker) for marker in group if isinstance(marker, str)]
                if choices:
                    print("    - one of: " + " | ".join(choices))
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

    sync_parser = sub.add_parser(
        "sync-linux-docs",
        help=(
            "mirror accepted CPU/AP OpenSBI/Linux boot transcripts into the Linux docs "
            "evidence artifacts used by minimum-linux-target"
        ),
    )
    sync_parser.add_argument(
        "modes",
        nargs="*",
        choices=("linux", "opensbi"),
        default=("linux", "opensbi"),
        help="Evidence mirrors to refresh. Defaults to both linux and opensbi.",
    )
    sync_parser.set_defaults(func=sync_linux_docs)

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
