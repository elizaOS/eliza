#!/usr/bin/env python3
"""Unit tests for CPU/AP claim-boundary and evidence-gate semantics."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import capture_cpu_ap_evidence  # noqa: E402
import run_chipyard_eliza_isa_cache_mmu_probe as isa_cache_mmu_probe  # noqa: E402
from cpu_ap_evidence_lib import (  # noqa: E402
    EVIDENCE_MANIFEST,
    GENERATED_MANIFEST,
    SELECTED_MANIFEST,
    load_json,
    reconstruct_uart_tx_text,
    text_problems,
    transcript_specs,
    validate_evidence_manifest,
)


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in output:\n{text}")


def test_evidence_manifest_blocks_phone_class_claims() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    errors: list[str] = []
    validate_evidence_manifest(manifest, errors)
    if errors:
        raise AssertionError("\n".join(errors))

    policy = manifest["target_policy"]
    if policy["initial_linux_bringup_claim"] != "single_hart_rocket_rv64gc_linux_smoke_only":
        raise AssertionError("initial Rocket target claim boundary drifted")
    if policy["phone_2028_ap_claim"] != "blocked_until_phone_class_artifacts_and_evidence_pass":
        raise AssertionError("2028 phone-class AP claim is no longer blocked")
    required = set(policy["phone_2028_claim_requires"])
    for item in (
        "riscv_application_profile_and_extension_matrix",
        "cache_hierarchy_and_coherency_evidence",
        "mmu_page_table_and_tlb_evidence",
        "sustained_boot_and_benchmark_evidence",
        "power_thermal_voltage_frequency_evidence",
        "process_14a_corner_benchmark_derate_evidence",
        "android_cts_vts_and_userspace_evidence",
    ):
        if item not in required:
            raise AssertionError(f"missing 2028 phone-class requirement: {item}")


def test_selected_manifest_keeps_single_rocket_as_bringup_only() -> None:
    manifest = json.loads(SELECTED_MANIFEST.read_text())
    selected = manifest["selected_path"]
    if selected["claim_level"] != "initial_linux_bringup_only":
        raise AssertionError("single Rocket target must remain bring-up only")
    assert_contains(
        selected["not_phone_class_reason"],
        "not competitive with a 2028 phone application processor",
    )

    phone_target = manifest["phone_2028_target_boundary"]
    if phone_target["status"] != "blocked_not_selected_for_product_claims":
        raise AssertionError("phone-class target boundary must remain blocked")
    joined = "\n".join(phone_target["minimum_claim_evidence"])
    for token in ("ISA compliance", "cache hierarchy", "MMU", "CoreMark", "CTS/VTS"):
        assert_contains(joined, token)


def test_capture_helper_knows_new_cpu_ap_transcripts() -> None:
    modes = capture_cpu_ap_evidence.MODE_TO_TRANSCRIPT
    if modes["isa-cache-mmu"] != ("isa_cache_mmu_log", "eliza_e1_isa_cache_mmu"):
        raise AssertionError("isa-cache-mmu capture mode drifted")
    if modes["ap-benchmarks"] != ("ap_benchmark_log", "eliza_e1_ap_benchmarks"):
        raise AssertionError("ap-benchmarks capture mode drifted")
    if capture_cpu_ap_evidence.MODE_ENV["linux-boot"] != "ELIZA_LINUX_BOOT_CMD":
        raise AssertionError("Linux boot command env drifted")


def test_capture_template_lists_required_markers_and_no_pass_claim() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/capture_cpu_ap_evidence.py", "template", "linux-boot"],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    assert_contains(result.stdout, "destination: build/evidence/cpu_ap/eliza_e1_linux_boot.log")
    assert_contains(result.stdout, "command env: ELIZA_LINUX_BOOT_CMD")
    assert_contains(result.stdout, "Linux early console")
    assert_contains(
        result.stdout, "eliza-evidence: replace_this_file_with_real_generated_ap_output=true"
    )
    if "eliza-evidence: status=PASS" in result.stdout:
        raise AssertionError("template must not claim PASS evidence")


def test_capture_plan_json_is_machine_readable() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "scripts/capture_cpu_ap_evidence.py",
            "plan",
            "all",
            "--format",
            "json",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    plan = json.loads(result.stdout)
    if plan["schema"] != "eliza.cpu_ap_capture_plan.v1":
        raise AssertionError("capture plan schema drifted")
    entries = {entry["mode"]: entry for entry in plan["entries"]}
    for mode, env_name in capture_cpu_ap_evidence.MODE_ENV.items():
        if entries[mode]["command_env"] != env_name:
            raise AssertionError(f"capture plan env drifted for {mode}")
        if not entries[mode]["raw_required_strings"]:
            raise AssertionError(f"capture plan lacks required markers for {mode}")
    assert_contains(result.stdout, "scripts/capture_chipyard_linux_evidence.sh")


def test_capture_wrapper_preflight_reports_missing_command_envs() -> None:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ELIZA_")}
    result = subprocess.run(
        ["scripts/capture_chipyard_linux_evidence.sh", "preflight"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode != 2:
        raise AssertionError(result.stdout + result.stderr)
    assert_contains(result.stdout, "STATUS: BLOCKED cpu_ap.capture_preflight")
    assert_contains(result.stdout, "ELIZA_OPENSBI_BOOT_CMD")
    assert_contains(result.stdout, "ELIZA_AP_BENCHMARKS_CMD")


def test_capture_command_wiring_derives_available_generated_ap_lanes() -> None:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ELIZA_")}
    result = subprocess.run(
        [
            sys.executable,
            "scripts/wire_cpu_ap_capture_commands.py",
            "--format",
            "json",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    wiring = json.loads(result.stdout)
    if wiring["schema"] != "eliza.cpu_ap_capture_command_wiring.v1":
        raise AssertionError("CPU/AP command wiring schema drifted")
    entries = {entry["mode"]: entry for entry in wiring["entries"]}
    for mode in ("opensbi-boot", "linux-boot"):
        if not GENERATED_MANIFEST.is_file():
            if entries[mode]["status"] != "blocked":
                raise AssertionError(f"{mode} must block while generated manifest is missing")
            assert_contains(
                "\n".join(entries[mode].get("problems", [])), "missing generated manifest"
            )
            continue
        if entries[mode]["status"] == "blocked":
            assert_contains(
                "\n".join(entries[mode].get("problems", [])),
                "No runnable RISC-V ELF payload",
            )
            continue
        if entries[mode]["source"] != "generated_ap_linux_smoke":
            raise AssertionError(f"{mode} should derive from the generated AP smoke runner")
        assert_contains(entries[mode]["command"], "scripts/run_chipyard_eliza_linux_smoke.sh")
        assert_contains(
            entries[mode]["command"],
            "cat build/chipyard/eliza_rocket/verilator-linux-smoke.log",
        )
    trap_entry = entries["trap-timer-irq"]
    if trap_entry["status"] == "ready":
        if trap_entry["source"] != "generated_ap_trap_timer_irq_runner":
            raise AssertionError("trap-timer-irq should derive from the checked-in runner")
        assert_contains(trap_entry["command"], "scripts/run_chipyard_trap_timer_irq.sh")
    else:
        trap_problems = "\n".join(trap_entry.get("problems", []))
        assert_contains(trap_problems, "missing")

    if entries["isa-cache-mmu"]["status"] != "blocked":
        raise AssertionError(
            "isa-cache-mmu must stay blocked without Linux userspace hwprobe evidence"
        )
    isa_entry = entries["isa-cache-mmu"]
    if isa_entry["source"] != "generated_ap_isa_cache_mmu_probe":
        raise AssertionError("isa-cache-mmu should report the generated-AP probe blocker")
    assert_contains(isa_entry["blocked_report"], "cpu_ap_isa_cache_mmu_probe.json")
    isa_problems = "\n".join(isa_entry.get("problems", []))
    assert_contains(isa_problems, "generated-AP bare-metal diagnostic emits ISA/cache/MMU")
    assert_contains(isa_problems, "Linux userspace hwprobe output")
    report_path = ROOT / "build/reports/cpu_ap_isa_cache_mmu_probe.json"
    if report_path.is_file():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        hook = report.get("linux_userspace_hwprobe", {}).get("userspace_hook", {})
        if isinstance(hook, dict) and hook.get("workload_invokes_helper"):
            assert_contains(isa_problems, "has not reached userspace")
    ap_entry = entries["ap-benchmarks"]
    if ap_entry["source"] != "generated_ap_benchmark_runner":
        raise AssertionError("ap-benchmarks must report generated-AP benchmark runner wiring")
    assert_contains(ap_entry["blocked_report"], "cpu_ap_benchmark_runner_wiring.json")

    report_path = ROOT / "build/reports/cpu_ap_benchmark_runner_wiring.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report["status"] != "blocked":
        raise AssertionError("AP benchmark runner report must stay blocked")
    if report.get("derived_command_available"):
        if ap_entry["status"] != "ready":
            raise AssertionError("ap-benchmarks should export the checked-in generated-AP runner")
        assert_contains(ap_entry["command"], "eliza-e1-ap-benchmarks-bin-nodisk")
        assert_contains(ap_entry["command"], "scripts/run_chipyard_eliza_linux_smoke.sh")
        if "ELIZA_AP_BENCHMARKS_CMD is unset" in "\n".join(report["blockers"]):
            raise AssertionError("derived AP benchmark command must not be reported as unset")
    else:
        if ap_entry["status"] != "blocked":
            raise AssertionError("ap-benchmarks must block when no real runner can be derived")
        ap_problems = "\n".join(ap_entry.get("problems", []))
        assert_contains(ap_problems, "ELIZA_AP_BENCHMARKS_CMD is unset")
    assert_contains(
        "\n".join(report["blockers"]),
        "generated-AP Linux/userland boot transcript is still missing",
    )
    assert_contains("\n".join(report["blockers"]), "claim_level=L3")
    assert_contains("\n".join(report["required_raw_markers"]), "pdk signoff claim=none")
    prerequisites = json.dumps(report["source_build_prerequisites"], sort_keys=True)
    assert_contains(prerequisites, "CoreMark")
    assert_contains(prerequisites, "STREAM")
    assert_contains(prerequisites, "lmbench lat_mem_rd")
    assert_contains(prerequisites, "fio")
    assert_contains(prerequisites, "FireMarshal workload")
    assert_contains(
        "\n".join(report["next_commands_after_prerequisites_exist"]),
        "capture_cpu_ap_evidence.py intake ap-benchmarks",
    )
    if report["evidence_log_created"]:
        raise AssertionError("wiring must not create eliza_e1_ap_benchmarks.log")


def test_linux_smoke_packages_real_riscv_hwprobe_helper() -> None:
    workload = json.loads((ROOT / "sw/firemarshal/eliza-e1-linux-smoke.json").read_text())
    files = {tuple(item) for item in workload.get("files", [])}
    if workload.get("host-init") != "build-hwprobe.sh":
        raise AssertionError("linux smoke workload must build the hwprobe helper before packaging")
    firmware = workload.get("firmware", {})
    opensbi_args = firmware.get("opensbi-build-args")
    if "FW_OPTIONS=0" not in str(opensbi_args).split():
        raise AssertionError("linux smoke workload must leave OpenSBI boot prints enabled")
    if "FW_PAYLOAD_FDT_ADDR=0x88000000" not in str(opensbi_args).split():
        raise AssertionError("linux smoke workload must relocate the DTB to writable DRAM")
    if ("eliza-riscv-hwprobe", "/usr/bin/eliza-riscv-hwprobe") not in files:
        raise AssertionError("linux smoke workload must package /usr/bin/eliza-riscv-hwprobe")
    if ("e1-npu-ml-smoke", "/usr/bin/e1-npu-ml-smoke") not in files:
        raise AssertionError("linux smoke workload must package /usr/bin/e1-npu-ml-smoke")

    smoke_script = (
        ROOT / "sw/firemarshal/eliza-e1-linux-smoke/eliza-e1-linux-smoke.sh"
    ).read_text()
    assert_contains(smoke_script, "/usr/bin/eliza-riscv-hwprobe")
    assert_contains(smoke_script, "riscv_hwprobe: FAIL userspace helper exited nonzero")
    assert_contains(smoke_script, "/usr/bin/e1-npu-ml-smoke --device /dev/e1-npu")
    assert_contains(smoke_script, "CPU fallback percent=0")
    if "device=/dev/mem generated-mmio" in smoke_script:
        raise AssertionError("linux smoke workload must not synthesize NPU PASS through /dev/mem")

    source = (ROOT / "sw/firemarshal/eliza-e1-linux-smoke/eliza-riscv-hwprobe.c").read_text()
    assert_contains(source, "__NR_riscv_hwprobe")
    assert_contains(source, "syscall(__NR_riscv_hwprobe")

    build_script = (ROOT / "sw/firemarshal/eliza-e1-linux-smoke/build-hwprobe.sh").read_text()
    assert_contains(build_script, "e1-npu-ml-smoke")
    assert_contains(build_script, "sw/buildroot/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c")


def test_isa_cache_mmu_probe_requires_successful_hwprobe_syscall() -> None:
    old_values = {
        "LINUX_SMOKE_LOG": isa_cache_mmu_probe.LINUX_SMOKE_LOG,
        "LINUX_SMOKE_WORKLOAD": isa_cache_mmu_probe.LINUX_SMOKE_WORKLOAD,
        "LINUX_SMOKE_JSON": isa_cache_mmu_probe.LINUX_SMOKE_JSON,
        "HWPROBE_SOURCE": isa_cache_mmu_probe.HWPROBE_SOURCE,
        "HWPROBE_BUILD_SCRIPT": isa_cache_mmu_probe.HWPROBE_BUILD_SCRIPT,
        "HWPROBE_BINARY": isa_cache_mmu_probe.HWPROBE_BINARY,
        "LINUX_SMOKE_REPORT": isa_cache_mmu_probe.LINUX_SMOKE_REPORT,
    }
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            log = tmp_path / "linux.log"
            workload = tmp_path / "eliza-e1-linux-smoke.sh"
            workload_json = tmp_path / "eliza-e1-linux-smoke.json"
            source = tmp_path / "eliza-riscv-hwprobe.c"
            build_script = tmp_path / "build-hwprobe.sh"
            binary = tmp_path / "eliza-riscv-hwprobe"
            report = tmp_path / "linux-report.json"

            workload.write_text("/usr/bin/eliza-riscv-hwprobe\n", encoding="utf-8")
            workload_json.write_text(
                '{"host-init":"build-hwprobe.sh","files":[["eliza-riscv-hwprobe",'
                '"/usr/bin/eliza-riscv-hwprobe"]]}',
                encoding="utf-8",
            )
            source.write_text("__NR_riscv_hwprobe\n", encoding="utf-8")
            build_script.write_text("#!/bin/sh\n", encoding="utf-8")
            build_script.chmod(0o755)
            binary.write_text("placeholder binary\n", encoding="utf-8")
            binary.chmod(0o755)
            report.write_text('{"status":"blocked"}\n', encoding="utf-8")

            isa_cache_mmu_probe.LINUX_SMOKE_LOG = log
            isa_cache_mmu_probe.LINUX_SMOKE_WORKLOAD = workload
            isa_cache_mmu_probe.LINUX_SMOKE_JSON = workload_json
            isa_cache_mmu_probe.HWPROBE_SOURCE = source
            isa_cache_mmu_probe.HWPROBE_BUILD_SCRIPT = build_script
            isa_cache_mmu_probe.HWPROBE_BINARY = binary
            isa_cache_mmu_probe.LINUX_SMOKE_REPORT = report

            log.write_text(
                "riscv_hwprobe: FAIL userspace helper exited nonzero\n", encoding="utf-8"
            )
            failed_scan = isa_cache_mmu_probe.linux_hwprobe_scan()
            if not failed_scan["contains_riscv_hwprobe"]:
                raise AssertionError("scan should record that hwprobe text was present")
            if failed_scan["contains_riscv_hwprobe_success"]:
                raise AssertionError("failed hwprobe output must not unlock final intake")
            assert_contains(
                "\n".join(failed_scan["missing_hwprobe_markers"]),
                "riscv_hwprobe: syscall rc=0",
            )

            log.write_text("riscv_hwprobe: syscall rc=0 pair_count=6\n", encoding="utf-8")
            passed_scan = isa_cache_mmu_probe.linux_hwprobe_scan()
            if not passed_scan["contains_riscv_hwprobe_success"]:
                raise AssertionError("successful hwprobe syscall marker should unlock scan")
    finally:
        for name, value in old_values.items():
            setattr(isa_cache_mmu_probe, name, value)


def test_ap_benchmark_workload_packages_marker_emitter_and_tools() -> None:
    workload = json.loads((ROOT / "sw/firemarshal/eliza-e1-ap-benchmarks.json").read_text())
    files = {tuple(item) for item in workload.get("files", [])}
    expected_files = {
        ("eliza-e1-ap-benchmarks.sh", "/usr/bin/eliza-e1-ap-benchmarks"),
        ("bin/coremark", "/usr/bin/coremark"),
        ("bin/stream_c.exe", "/usr/bin/stream_c.exe"),
        ("bin/lat_mem_rd", "/usr/bin/lat_mem_rd"),
        ("bin/fio", "/usr/bin/fio"),
        ("ufs-dram-contention.fio", "/root/ufs-dram-contention.fio"),
    }
    missing_files = sorted(expected_files - files)
    if missing_files:
        raise AssertionError(f"AP benchmark workload missing packaged files: {missing_files}")
    if workload.get("command") != "/usr/bin/eliza-e1-ap-benchmarks":
        raise AssertionError("AP benchmark workload must run the marker-emitting wrapper")

    script = (ROOT / "sw/firemarshal/eliza-e1-ap-benchmarks/eliza-e1-ap-benchmarks.sh").read_text()
    manifest = json.loads((ROOT / "docs/evidence/cpu-ap-evidence-manifest.json").read_text())
    raw_markers = manifest["transcripts"]["ap_benchmark_log"]["raw_required_strings"]
    missing_markers = [marker for marker in raw_markers if marker not in script]
    if missing_markers:
        raise AssertionError(f"AP benchmark marker emitter missing markers: {missing_markers}")

    assert_contains(script, "ap-benchmarks: BLOCKED missing_target_artifact=")
    assert_contains(script, "eliza-evidence: status=PASS")
    for forbidden in ("qemu-virt", "software reference only", "no real transcript"):
        if forbidden in script:
            raise AssertionError(
                f"AP benchmark marker emitter contains forbidden term: {forbidden}"
            )


def test_capture_wire_preflight_reports_remaining_unwired_lanes() -> None:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ELIZA_")}
    result = subprocess.run(
        ["scripts/capture_chipyard_linux_evidence.sh", "wire-preflight"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode != 2:
        raise AssertionError(result.stdout + result.stderr)
    if GENERATED_MANIFEST.is_file() and "READY opensbi-boot" in result.stdout:
        assert_contains(result.stdout, "READY opensbi-boot: ELIZA_OPENSBI_BOOT_CMD is set")
        assert_contains(result.stdout, "READY linux-boot: ELIZA_LINUX_BOOT_CMD is set")
    else:
        assert_contains(result.stdout, "BLOCKED opensbi-boot: ELIZA_OPENSBI_BOOT_CMD is unset")
        assert_contains(result.stdout, "BLOCKED linux-boot: ELIZA_LINUX_BOOT_CMD is unset")
    if "READY trap-timer-irq" in result.stdout:
        assert_contains(result.stdout, "READY trap-timer-irq: ELIZA_TRAP_TIMER_IRQ_CMD is set")
    else:
        assert_contains(result.stdout, "BLOCKED trap-timer-irq: ELIZA_TRAP_TIMER_IRQ_CMD is unset")


def test_capture_wrapper_all_reports_every_missing_command_env() -> None:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ELIZA_")}
    result = subprocess.run(
        ["scripts/capture_chipyard_linux_evidence.sh", "all"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode != 2:
        raise AssertionError(result.stdout + result.stderr)
    for name in (
        "ELIZA_OPENSBI_BOOT_CMD",
        "ELIZA_LINUX_BOOT_CMD",
        "ELIZA_TRAP_TIMER_IRQ_CMD",
        "ELIZA_ISA_CACHE_MMU_CMD",
        "ELIZA_AP_BENCHMARKS_CMD",
    ):
        assert_contains(result.stdout, name)


def test_opensbi_capture_failure_writes_precise_blocker_report() -> None:
    if not GENERATED_MANIFEST.is_file():
        return

    env = {key: value for key, value in os.environ.items() if not key.startswith("ELIZA_")}
    env["ELIZA_OPENSBI_BOOT_CMD"] = "printf 'OpenSBI v1.2\\n'"
    result = subprocess.run(
        ["scripts/capture_chipyard_linux_evidence.sh", "opensbi-boot"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode == 0:
        raise AssertionError("incomplete OpenSBI transcript must not be archived")
    assert_contains(result.stdout, "STATUS: FAIL cpu_ap.transcript_intake")
    assert_contains(result.stdout, "cpu_ap_opensbi_boot_regeneration_blocked.json")

    report_path = ROOT / "build/reports/cpu_ap_opensbi_boot_regeneration_blocked.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report["status"] != "blocked":
        raise AssertionError("OpenSBI regeneration report must remain blocked")
    if report["diagnosis"] != "opensbi_banner_only_no_platform_or_handoff_table":
        raise AssertionError(json.dumps(report, indent=2, sort_keys=True))
    assert_contains("\n".join(report["present_raw_markers"]), "OpenSBI v")
    assert_contains("\n".join(report["missing_raw_markers"]), "Domain0 Next Address")
    assert_contains("\n".join(report["blockers"]), "intake refused")
    if report["evidence_log_rewritten"]:
        raise AssertionError("blocked OpenSBI report must not claim evidence rewrite")


def test_dts_audit_separates_ap_boot_from_e1_peripherals() -> None:
    dts_path = ROOT / "build/chipyard/eliza_rocket/eliza-e1.dts"
    if not dts_path.is_file():
        return

    boot_only = subprocess.run(
        [
            sys.executable,
            "scripts/capture_cpu_ap_evidence.py",
            "dts-audit",
            "--require-bootable",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if boot_only.returncode != 0:
        raise AssertionError(boot_only.stdout + boot_only.stderr)
    assert_contains(boot_only.stdout, "STATUS: PASS cpu_ap.dts_boot_audit")

    with_e1 = subprocess.run(
        [
            sys.executable,
            "scripts/capture_cpu_ap_evidence.py",
            "dts-audit",
            "--require-bootable",
            "--require-e1-peripherals",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if with_e1.returncode == 0:
        assert_contains(with_e1.stdout, "STATUS: PASS cpu_ap.dts_boot_audit")
        return
    if with_e1.returncode != 1:
        raise AssertionError(with_e1.stdout + with_e1.stderr)
    assert_contains(with_e1.stdout, "missing e1 npu mmio")


def test_new_transcripts_reject_placeholder_or_incomplete_text() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    specs = transcript_specs(manifest)
    for key in ("isa_cache_mmu_log", "ap_benchmark_log"):
        with_placeholder = "placeholder\neliza-evidence: status=PASS\n"
        problems = text_problems(with_placeholder, specs[key], key, raw=True)
        joined = "\n".join(problems)
        assert_contains(joined, "contains forbidden placeholder/failure markers")
        assert_contains(joined, "missing required transcript markers")


def test_raw_transcript_validation_uses_real_uart_tx_reconstruction() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    spec = transcript_specs(manifest)["opensbi_boot_log"]
    required = "\n".join(str(token) for token in spec["raw_required_strings"])
    uart_trace = "\n".join(f"UART TX ({byte:02x}): {chr(byte)}" for byte in required.encode())
    if reconstruct_uart_tx_text(uart_trace) != required:
        raise AssertionError("UART TX reconstruction did not round-trip the required markers")
    problems = text_problems(uart_trace, spec, "opensbi_boot_log", raw=True)
    if problems:
        raise AssertionError("\n".join(problems))

    banner_only = "\n".join(f"UART TX ({byte:02x}): {chr(byte)}" for byte in b"OpenSBI v1.2\n")
    problems = text_problems(banner_only, spec, "opensbi_boot_log", raw=True)
    joined = "\n".join(problems)
    assert_contains(joined, "Domain0 Next Address")


def test_ap_benchmark_transcript_requires_process_corner_markers() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    spec = transcript_specs(manifest)["ap_benchmark_log"]
    required = "\n".join(str(token) for token in spec["raw_required_strings"])
    for token in (
        "process effects contract",
        "process corner count",
        "worst process corner",
        "frequency derate",
        "pdk signoff claim=none",
    ):
        assert_contains(required, token)

    missing_process = "\n".join(
        str(token)
        for token in spec["raw_required_strings"]
        if not str(token).startswith(("process ", "worst process", "frequency derate", "pdk "))
    )
    missing_process += "\n" + ("generated AP benchmark transcript line\n" * 20)
    problems = text_problems(missing_process, spec, "ap_benchmark_log", raw=True)
    joined = "\n".join(problems)
    assert_contains(joined, "process effects contract")
    assert_contains(joined, "worst process corner")
    assert_contains(joined, "pdk signoff claim=none")


def test_raw_ap_transcript_markers_have_positive_and_negative_paths() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    spec = transcript_specs(manifest)["linux_boot_log"]
    valid_raw = "\n".join(str(token) for token in spec["raw_required_strings"])
    valid_raw += "\n" + ("generated AP Linux transcript line\n" * 20)
    problems = text_problems(valid_raw, spec, "linux_boot_log", raw=True)
    if problems:
        raise AssertionError("\n".join(problems))

    placeholder_command = "/exact/external/boot command\n" + valid_raw
    problems = text_problems(placeholder_command, spec, "linux_boot_log", raw=True)
    assert_contains("\n".join(problems), "contains forbidden placeholder/failure markers")


def test_chipyard_generator_check_rejects_duplicate_json_keys() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_chipyard_generator_manifest.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    if "duplicate JSON keys" in result.stdout + result.stderr:
        raise AssertionError(result.stdout + result.stderr)


def test_scaffold_check_lists_new_missing_evidence_paths() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_cpu_ap_evidence.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    assert_contains(result.stdout, "STATUS: PASS cpu_ap.scaffold")
    assert_contains(result.stdout, "eliza_e1_isa_cache_mmu.log")
    assert_contains(result.stdout, "eliza_e1_ap_benchmarks.log")
    assert_contains(result.stdout, "capture commands:")
    assert_contains(result.stdout, "intake ap-benchmarks")


def test_payload_path_uses_cpu_ap_manifest_transcripts_only() -> None:
    env = os.environ.copy()
    env["CHIPYARD_PAYLOAD_PATH_REPORT"] = "benchmarks/results/test-temp/chipyard_payload_path.json"
    result = subprocess.run(
        [sys.executable, "scripts/check_chipyard_payload_path.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode not in (0, 2):
        raise AssertionError(result.stdout + result.stderr)
    assert_contains(result.stdout, "STATUS: BLOCKED chipyard.payload_path")
    assert_contains(result.stdout, "eliza_e1_ap_benchmarks.log")
    if "u_boot_eliza_build.log" in result.stdout:
        raise AssertionError("Chipyard payload path gate should not own U-Boot BSP evidence")


def main() -> int:
    tests = [
        test_evidence_manifest_blocks_phone_class_claims,
        test_selected_manifest_keeps_single_rocket_as_bringup_only,
        test_capture_helper_knows_new_cpu_ap_transcripts,
        test_capture_template_lists_required_markers_and_no_pass_claim,
        test_capture_plan_json_is_machine_readable,
        test_capture_wrapper_preflight_reports_missing_command_envs,
        test_capture_command_wiring_derives_available_generated_ap_lanes,
        test_linux_smoke_packages_real_riscv_hwprobe_helper,
        test_isa_cache_mmu_probe_requires_successful_hwprobe_syscall,
        test_ap_benchmark_workload_packages_marker_emitter_and_tools,
        test_capture_wire_preflight_reports_remaining_unwired_lanes,
        test_capture_wrapper_all_reports_every_missing_command_env,
        test_opensbi_capture_failure_writes_precise_blocker_report,
        test_dts_audit_separates_ap_boot_from_e1_peripherals,
        test_new_transcripts_reject_placeholder_or_incomplete_text,
        test_ap_benchmark_transcript_requires_process_corner_markers,
        test_raw_transcript_validation_uses_real_uart_tx_reconstruction,
        test_raw_ap_transcript_markers_have_positive_and_negative_paths,
        test_chipyard_generator_check_rejects_duplicate_json_keys,
        test_scaffold_check_lists_new_missing_evidence_paths,
        test_payload_path_uses_cpu_ap_manifest_transcripts_only,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
