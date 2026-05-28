#!/usr/bin/env python3
"""Unit tests for CPU/AP claim-boundary and evidence-gate semantics."""

from __future__ import annotations

import json
import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import capture_cpu_ap_evidence  # noqa: E402
import check_cpu_ap_completion_gate  # noqa: E402
import check_cpu_ap_evidence  # noqa: E402
import run_chipyard_eliza_isa_cache_mmu_probe as isa_cache_mmu_probe  # noqa: E402
import wire_cpu_ap_capture_commands  # noqa: E402
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


def accepted_linux_boot_text(
    hwprobe_line: str = "riscv_hwprobe: syscall rc=0 pair_count=6",
    generated_manifest: Path | None = None,
) -> str:
    manifest_lines: list[str] = []
    if generated_manifest is not None:
        manifest_rel = wire_cpu_ap_capture_commands.rel(generated_manifest)
        manifest_sha = hashlib.sha256(generated_manifest.read_bytes()).hexdigest()
        manifest_lines = [
            f"eliza-evidence: generated_manifest={manifest_rel}",
            f"eliza-evidence: generated_manifest_sha256={manifest_sha}",
        ]
    return "\n".join(
        [
            "eliza-evidence: target=cpu_ap artifact=eliza_e1_linux_boot",
            "eliza-evidence: command=scripts/run_chipyard_eliza_linux_smoke.sh",
            *(
                manifest_lines
                or [
                    "eliza-evidence: generated_manifest="
                    "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json"
                ]
            ),
            "eliza-evidence: intake_utc=2026-05-26T12:00:00Z",
            "OpenSBI v1.2",
            "Linux version 6.6.0",
            "Forcing kernel command line to: 'console=ttyS0 console=ttySIF0,3686400 quiet loglevel=3 panic=-1 rdinit=/init lpj=10000 mem=128M eliza_skip_unaligned_probe'",
            "Linux early console",
            "generated DTS hash",
            "memory node",
            "CPU node",
            "timer node",
            "interrupt-controller node",
            "UART node",
            "chosen stdout",
            "Linux CONFIG_MMU: CONFIG_MMU=y",
            "Run /init as init process",
            "initramfs start",
            hwprobe_line,
            "riscv_hwprobe: key=mvendorid value=0x0000000000000000",
            "riscv_hwprobe: key=marchid value=0x0000000000000000",
            "riscv_hwprobe: key=ima_ext_0 value=0x0000000000000000",
            "e1-npu-ml-smoke: PASS",
            "device=/dev/e1-npu",
            "require_npu=true",
            "CPU fallback percent=0",
            "e1 MMIO smoke result: PASS",
            "accepted generated AP userspace boot transcript with enough bytes for validation",
            "eliza-evidence: status=PASS",
            "",
        ]
    )


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


def test_completion_gate_blocked_report_names_cpu_ap_evidence_not_qemu_virt() -> None:
    report = check_cpu_ap_completion_gate.blocked_report(
        generated_detail="generated manifest present: build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json",
        manifest_errors=[],
        missing_logs=["build/evidence/cpu_ap/eliza_e1_linux_boot.log"],
        next_capture=["python3 scripts/capture_cpu_ap_evidence.py template linux-boot"],
    )

    if report["status"] != "blocked":
        raise AssertionError("completion gate blocked report must stay blocked")
    if "qemu_virt_linux_boot_is_reference_only" not in report["claim_boundary"]:
        raise AssertionError("completion gate must keep QEMU virt outside CPU/AP completion")
    if report["blocker_dependency_counts"]["live_device_validation"] != 1:
        raise AssertionError("missing CPU/AP transcript must be live validation")
    if "QEMU virt Linux boot evidence does not satisfy" not in report["next_step"]:
        raise AssertionError("next step must distinguish QEMU virt from generated CPU/AP evidence")


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

    isa_entry = entries["isa-cache-mmu"]
    if isa_entry["source"] != "generated_ap_isa_cache_mmu_probe":
        raise AssertionError("isa-cache-mmu should report the generated-AP probe blocker")
    assert_contains(isa_entry["blocked_report"], "cpu_ap_isa_cache_mmu_probe.json")
    assert_contains(
        isa_entry["required_linux_userspace_hwprobe_marker"],
        "riscv_hwprobe: syscall rc=0",
    )
    assert_contains(isa_entry["required_linux_config_mmu_marker"], "CONFIG_MMU=y")
    assert_contains(
        "\n".join(isa_entry["required_linux_userspace_hwprobe_key_markers"]),
        "riscv_hwprobe: key=ima_ext_0",
    )
    if isa_entry["status"] == "ready":
        assert_contains(isa_entry["command"], "scripts/run_chipyard_eliza_isa_cache_mmu_probe.py")
        if isa_entry.get("problems"):
            raise AssertionError("ready isa-cache-mmu wiring must not report problems")
    elif isa_entry["status"] == "blocked":
        isa_problems = "\n".join(isa_entry.get("problems", []))
        assert_contains(
            isa_problems, "generated-AP Linux smoke packages /usr/bin/eliza-riscv-hwprobe"
        )
        assert_contains(isa_problems, "accepted generated-AP Linux transcript")
        assert_contains(isa_problems, "riscv_hwprobe: syscall rc=0")
        report_path = ROOT / "build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json"
        if report_path.is_file():
            report = json.loads(report_path.read_text(encoding="utf-8"))
            hook = report.get("linux_userspace_hwprobe", {}).get("userspace_hook", {})
            if isinstance(hook, dict) and hook.get("workload_invokes_helper"):
                assert_contains(isa_problems, "has not reached userspace")
    else:
        raise AssertionError("isa-cache-mmu wiring must be ready or blocked")
    ap_entry = entries["ap-benchmarks"]
    if ap_entry["source"] != "generated_ap_benchmark_runner":
        raise AssertionError("ap-benchmarks must report generated-AP benchmark runner wiring")
    assert_contains(ap_entry["blocked_report"], "cpu_ap_benchmark_runner_wiring.json")

    report_path = ROOT / "build/reports/cpu_ap_benchmark_runner_wiring.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report["status"] != "blocked":
        raise AssertionError("AP benchmark runner report must stay blocked")
    linux_boot_evidence_ready = report.get("candidate_generated_ap_inputs", {}).get(
        "linux_boot_evidence_exists"
    )
    if report.get("derived_command_available") and linux_boot_evidence_ready:
        if ap_entry["status"] != "ready":
            raise AssertionError("ap-benchmarks should export the checked-in generated-AP runner")
        assert_contains(ap_entry["command"], "eliza-e1-ap-benchmarks-bin-nodisk")
        assert_contains(ap_entry["command"], "scripts/run_chipyard_eliza_linux_smoke.sh")
        if "ELIZA_AP_BENCHMARKS_CMD is unset" in "\n".join(report["blockers"]):
            raise AssertionError("derived AP benchmark command must not be reported as unset")
    else:
        if ap_entry["status"] != "blocked":
            raise AssertionError(
                "ap-benchmarks must block until runner and Linux/userland prerequisites are ready"
            )
        ap_problems = "\n".join(ap_entry.get("problems", []))
        if report.get("runner_command_derivable"):
            assert_contains(ap_problems, "Linux/userland boot transcript is not accepted")
        else:
            assert_contains(ap_problems, "ELIZA_AP_BENCHMARKS_CMD is unset")
    blocker_text = "\n".join(report["blockers"])
    if not linux_boot_evidence_ready:
        assert_contains(blocker_text, "generated-AP Linux/userland boot transcript is not accepted")
    else:
        assert_contains(blocker_text, "generated-AP benchmark")
    assert_contains("\n".join(report["blockers"]), "claim_level=L3")
    assert_contains("\n".join(report["required_raw_markers"]), "pdk signoff claim=none")
    prerequisites = json.dumps(report["source_build_prerequisites"], sort_keys=True)
    assert_contains(prerequisites, "CoreMark")
    assert_contains(prerequisites, "STREAM")
    assert_contains(prerequisites, "lmbench lat_mem_rd")
    assert_contains(prerequisites, "fio")
    assert_contains(prerequisites, "FireMarshal workload")
    assert_contains(
        "\n".join(report["required_commands"]),
        "build_firemarshal_eliza_ap_benchmarks_payload.sh",
    )
    assert_contains(
        "\n".join(report["required_commands"]),
        "CHIPYARD_LINUX_SMOKE_TRANSCRIPT_MODE=ap-benchmarks",
    )
    assert_contains(
        "\n".join(report["next_commands_after_prerequisites_exist"]),
        "build_firemarshal_eliza_ap_benchmarks_payload.sh",
    )
    assert_contains(
        "\n".join(report["next_commands_after_prerequisites_exist"]),
        "capture_cpu_ap_evidence.py intake ap-benchmarks",
    )
    if report["evidence_log_created"] and not (ROOT / report["evidence_log"]).is_file():
        raise AssertionError("wiring report marked a missing AP benchmark evidence log as present")


def test_linux_smoke_packages_real_riscv_hwprobe_helper() -> None:
    workload = json.loads((ROOT / "sw/firemarshal/eliza-e1-linux-smoke.json").read_text())
    files = {tuple(item) for item in workload.get("files", [])}
    if workload.get("host-init") != "build-hwprobe.sh":
        raise AssertionError("linux smoke workload must build the hwprobe helper before packaging")
    firmware = workload.get("firmware", {})
    opensbi_args = firmware.get("opensbi-build-args")
    if "FW_OPTIONS=0" not in str(opensbi_args).split():
        raise AssertionError("linux smoke workload must leave OpenSBI boot prints enabled")
    stale_fdt_args = [
        token
        for token in str(opensbi_args).split()
        if token.startswith("FW_PAYLOAD_FDT_ADDR=")
        and token != "FW_PAYLOAD_FDT_ADDR=0x80b00000"
    ]
    if stale_fdt_args:
        raise AssertionError(
            f"linux smoke workload must use the low-FDT handoff path: {stale_fdt_args}"
        )
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
        "ACCEPTED_LINUX_TRANSCRIPT": isa_cache_mmu_probe.ACCEPTED_LINUX_TRANSCRIPT,
        "MANIFEST": isa_cache_mmu_probe.MANIFEST,
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
            accepted_linux = tmp_path / "eliza_e1_linux_boot.log"
            generated_manifest = tmp_path / "generated_manifest.json"
            stale_manifest = tmp_path / "old_generated_manifest.json"

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
            generated_manifest.write_text("{}", encoding="utf-8")
            stale_manifest.write_text('{"old":true}', encoding="utf-8")

            isa_cache_mmu_probe.LINUX_SMOKE_LOG = log
            isa_cache_mmu_probe.LINUX_SMOKE_WORKLOAD = workload
            isa_cache_mmu_probe.LINUX_SMOKE_JSON = workload_json
            isa_cache_mmu_probe.HWPROBE_SOURCE = source
            isa_cache_mmu_probe.HWPROBE_BUILD_SCRIPT = build_script
            isa_cache_mmu_probe.HWPROBE_BINARY = binary
            isa_cache_mmu_probe.LINUX_SMOKE_REPORT = report
            isa_cache_mmu_probe.ACCEPTED_LINUX_TRANSCRIPT = accepted_linux
            isa_cache_mmu_probe.MANIFEST = generated_manifest

            log.write_text(
                "\n".join(
                    [
                        "Linux CONFIG_MMU: CONFIG_MMU=y",
                        "riscv_hwprobe: syscall rc=0 pair_count=6",
                        "riscv_hwprobe: key=mvendorid value=0x0",
                        "riscv_hwprobe: key=marchid value=0x0",
                        "riscv_hwprobe: key=ima_ext_0 value=0x0",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            accepted_linux.write_text(
                "riscv_hwprobe: FAIL userspace helper exited nonzero\n", encoding="utf-8"
            )
            failed_scan = isa_cache_mmu_probe.linux_hwprobe_scan()
            assert_contains(
                failed_scan["required_success_marker"],
                "riscv_hwprobe: syscall rc=0",
            )
            assert_contains(
                failed_scan["required_success_marker_source"],
                "accepted real generated-AP Linux userspace",
            )
            if not failed_scan["contains_riscv_hwprobe"]:
                raise AssertionError("scan should record that hwprobe text was present")
            if failed_scan["contains_riscv_hwprobe_success"]:
                raise AssertionError(
                    "diagnostic hwprobe output must not unlock without accepted transcript"
                )
            if not failed_scan["live_smoke_log_diagnostic"]["contains_riscv_hwprobe_success"]:
                raise AssertionError("live smoke log should be reported as diagnostic only")
            assert_contains(
                "\n".join(failed_scan["missing_hwprobe_markers"]),
                "riscv_hwprobe: syscall rc=0",
            )

            accepted_linux.write_text(
                accepted_linux_boot_text(generated_manifest=stale_manifest),
                encoding="utf-8",
            )
            stale_scan = isa_cache_mmu_probe.linux_hwprobe_scan()
            if stale_scan["contains_riscv_hwprobe_success"]:
                raise AssertionError("stale accepted Linux transcript must not unlock scan")
            if stale_scan["accepted_linux_transcript"]["accepted"]:
                raise AssertionError("stale Linux transcript should fail manifest validation")
            assert_contains(
                "\n".join(stale_scan["accepted_linux_transcript"]["problems"]),
                "generated_manifest_sha256 must match",
            )

            accepted_linux.write_text(
                accepted_linux_boot_text(generated_manifest=generated_manifest),
                encoding="utf-8",
            )
            passed_scan = isa_cache_mmu_probe.linux_hwprobe_scan()
            if not passed_scan["contains_riscv_hwprobe_success"]:
                raise AssertionError(
                    "accepted successful hwprobe syscall marker should unlock scan"
                )
            if not passed_scan["contains_config_mmu_y"]:
                raise AssertionError("accepted CONFIG_MMU=y marker should unlock scan")
            if not passed_scan["contains_riscv_hwprobe_key_markers"]:
                raise AssertionError("accepted hwprobe key markers should unlock scan")
            if not passed_scan["accepted_linux_transcript"]["accepted"]:
                raise AssertionError("accepted Linux transcript should pass validation")
    finally:
        for name, value in old_values.items():
            setattr(isa_cache_mmu_probe, name, value)


def test_isa_cache_mmu_probe_audits_generated_dts_cache_mmu_contract() -> None:
    old_dts = isa_cache_mmu_probe.DTS
    try:
        with tempfile.TemporaryDirectory() as tmp:
            dts = Path(tmp) / "eliza-e1.dts"
            isa_cache_mmu_probe.DTS = dts

            missing = isa_cache_mmu_probe.dts_contract_status()
            if missing["accepted"]:
                raise AssertionError("missing generated DTS must not pass ISA/cache/MMU audit")
            assert_contains(
                "\n".join(missing["missing_strings"]),
                'mmu-type = "riscv,sv39"',
            )

            dts.write_text(
                "\n".join(isa_cache_mmu_probe.DTS_REQUIRED_STRINGS) + "\n",
                encoding="utf-8",
            )
            accepted = isa_cache_mmu_probe.dts_contract_status()
            if not accepted["accepted"]:
                raise AssertionError(
                    "generated DTS with required cache/MMU markers should pass audit: "
                    + "\n".join(accepted["missing_strings"])
                )

            dts.write_text(
                "\n".join(
                    marker
                    for marker in isa_cache_mmu_probe.DTS_REQUIRED_STRINGS
                    if "cache-controller@2010000" not in marker
                )
                + "\n",
                encoding="utf-8",
            )
            incomplete = isa_cache_mmu_probe.dts_contract_status()
            if incomplete["accepted"]:
                raise AssertionError("DTS audit must fail without the generated L2 cache node")
            assert_contains(
                "\n".join(incomplete["missing_strings"]),
                "cache-controller@2010000",
            )
    finally:
        isa_cache_mmu_probe.DTS = old_dts


def test_isa_cache_mmu_wiring_fails_closed_until_accepted_linux_hwprobe_success() -> None:
    old_values = {
        "GENERATED_MANIFEST": wire_cpu_ap_capture_commands.GENERATED_MANIFEST,
        "ISA_CACHE_MMU_REPORT": wire_cpu_ap_capture_commands.ISA_CACHE_MMU_REPORT,
        "AP_BENCHMARK_LINUX_BOOT_EVIDENCE": wire_cpu_ap_capture_commands.AP_BENCHMARK_LINUX_BOOT_EVIDENCE,
    }
    old_env = os.environ.get("ELIZA_ISA_CACHE_MMU_CMD")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            generated_manifest = tmp_path / "generated_manifest.json"
            report = tmp_path / "cpu_ap_isa_cache_mmu_probe.json"
            linux_boot = tmp_path / "eliza_e1_linux_boot.log"
            generated_manifest.write_text("{}", encoding="utf-8")
            wire_cpu_ap_capture_commands.GENERATED_MANIFEST = generated_manifest
            wire_cpu_ap_capture_commands.ISA_CACHE_MMU_REPORT = report
            wire_cpu_ap_capture_commands.AP_BENCHMARK_LINUX_BOOT_EVIDENCE = linux_boot
            args = type("Args", (), {"use_docker": "0"})()
            os.environ["ELIZA_ISA_CACHE_MMU_CMD"] = "printf manual-isa-cache-mmu"

            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                        "status": "blocked",
                        "baremetal_probe": {"status": "pass"},
                        "linux_userspace_hwprobe": {
                            "contains_riscv_hwprobe_success": False,
                            "userspace_hook": {"workload_invokes_helper": True},
                        },
                    }
                ),
                encoding="utf-8",
            )
            blocked_entries = wire_cpu_ap_capture_commands.build_entries(args)
            blocked = {
                entry["mode"]: entry for entry in blocked_entries
            }["isa-cache-mmu"]
            if blocked["status"] != "blocked":
                raise AssertionError(
                    "ISA/cache/MMU wiring must fail closed without hwprobe success"
                )
            assert_contains(
                "\n".join(blocked.get("problems", [])),
                "ELIZA_ISA_CACHE_MMU_CMD is set",
            )
            assert_contains(
                "\n".join(blocked.get("problems", [])),
                "has not reached userspace",
            )

            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                        "status": "blocked",
                        "baremetal_probe": {"status": "pass"},
                        "linux_userspace_hwprobe": {
                            "contains_riscv_hwprobe_success": True,
                            "contains_config_mmu_y": True,
                            "contains_riscv_hwprobe_key_markers": True,
                        },
                    }
                ),
                encoding="utf-8",
            )
            still_blocked_entries = wire_cpu_ap_capture_commands.build_entries(args)
            still_blocked = {
                entry["mode"]: entry for entry in still_blocked_entries
            }["isa-cache-mmu"]
            if still_blocked["status"] != "blocked":
                raise AssertionError(
                    "ISA/cache/MMU wiring must not unlock before final intake passes"
                )
            assert_contains(
                "\n".join(still_blocked.get("problems", [])),
                "final isa-cache-mmu intake has not passed",
            )

            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                        "status": "pass",
                        "baremetal_probe": {"status": "pass"},
                        "linux_userspace_hwprobe": {
                            "contains_riscv_hwprobe_success": True,
                        },
                    }
                ),
                encoding="utf-8",
            )
            pass_without_accepted_entries = wire_cpu_ap_capture_commands.build_entries(args)
            pass_without_accepted = {
                entry["mode"]: entry for entry in pass_without_accepted_entries
            }["isa-cache-mmu"]
            if pass_without_accepted["status"] != "blocked":
                raise AssertionError(
                    "ISA/cache/MMU wiring must not unlock without accepted Linux transcript"
                )
            assert_contains(
                "\n".join(pass_without_accepted.get("problems", [])),
                "accepted generated-AP Linux/userspace transcript has not passed validation",
            )

            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_isa_cache_mmu_probe.v1",
                        "status": "pass",
                        "baremetal_probe": {"status": "pass"},
                        "linux_userspace_hwprobe": {
                            "contains_riscv_hwprobe_success": True,
                            "accepted_linux_transcript": {
                                "accepted": True,
                                "contains_riscv_hwprobe_success": True,
                                "contains_config_mmu_y": True,
                                "contains_riscv_hwprobe_key_markers": True,
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            stale_manifest = tmp_path / "old_generated_manifest.json"
            stale_manifest.write_text('{"old":true}', encoding="utf-8")
            linux_boot.write_text(
                accepted_linux_boot_text(generated_manifest=stale_manifest),
                encoding="utf-8",
            )
            stale_entries = wire_cpu_ap_capture_commands.build_entries(args)
            stale = {entry["mode"]: entry for entry in stale_entries}["isa-cache-mmu"]
            if stale["status"] != "blocked":
                raise AssertionError("ISA/cache/MMU wiring must not unlock from stale Linux")
            assert_contains(
                "\n".join(stale.get("problems", [])),
                "current generated-AP Linux/userspace transcript is missing, stale, or invalid",
            )

            linux_boot.write_text(
                accepted_linux_boot_text(generated_manifest=generated_manifest),
                encoding="utf-8",
            )
            ready_entries = wire_cpu_ap_capture_commands.build_entries(args)
            ready = {entry["mode"]: entry for entry in ready_entries}["isa-cache-mmu"]
            if ready["status"] != "ready":
                raise AssertionError(
                    "ISA/cache/MMU wiring should unlock after accepted Linux hwprobe success"
                )
            if ready["command"] != "printf manual-isa-cache-mmu":
                raise AssertionError("ISA/cache/MMU wiring command drifted")

            os.environ.pop("ELIZA_ISA_CACHE_MMU_CMD", None)
            derived_entries = wire_cpu_ap_capture_commands.build_entries(args)
            derived = {entry["mode"]: entry for entry in derived_entries}["isa-cache-mmu"]
            if derived["status"] != "ready":
                raise AssertionError(
                    "ISA/cache/MMU wiring should derive a capture command after accepted Linux"
                )
            assert_contains(
                str(derived["command"]),
                "scripts/run_chipyard_eliza_isa_cache_mmu_probe.py",
            )
            assert_contains(
                str(derived["command"]),
                "isa_cache_mmu.combined-source.log",
            )
    finally:
        for name, value in old_values.items():
            setattr(wire_cpu_ap_capture_commands, name, value)
        if old_env is None:
            os.environ.pop("ELIZA_ISA_CACHE_MMU_CMD", None)
        else:
            os.environ["ELIZA_ISA_CACHE_MMU_CMD"] = old_env


def test_ap_benchmark_wiring_requires_accepted_linux_userspace_transcript() -> None:
    old_values = {
        "GENERATED_MANIFEST": wire_cpu_ap_capture_commands.GENERATED_MANIFEST,
        "AP_BENCHMARK_REPORT": wire_cpu_ap_capture_commands.AP_BENCHMARK_REPORT,
        "AP_BENCHMARK_WORKLOAD": wire_cpu_ap_capture_commands.AP_BENCHMARK_WORKLOAD,
        "AP_BENCHMARK_KFRAG": wire_cpu_ap_capture_commands.AP_BENCHMARK_KFRAG,
        "AP_BENCHMARK_PAYLOAD": wire_cpu_ap_capture_commands.AP_BENCHMARK_PAYLOAD,
        "AP_BENCHMARK_FRESHNESS_MANIFEST": wire_cpu_ap_capture_commands.AP_BENCHMARK_FRESHNESS_MANIFEST,
        "AP_BENCHMARK_LINUX_CONFIG": wire_cpu_ap_capture_commands.AP_BENCHMARK_LINUX_CONFIG,
        "AP_BENCHMARK_DISK_PAYLOAD": wire_cpu_ap_capture_commands.AP_BENCHMARK_DISK_PAYLOAD,
        "AP_BENCHMARK_LINUX_BOOT_EVIDENCE": wire_cpu_ap_capture_commands.AP_BENCHMARK_LINUX_BOOT_EVIDENCE,
        "GENERATED_SIMULATOR": wire_cpu_ap_capture_commands.GENERATED_SIMULATOR,
        "SMOKE_RUNNER": wire_cpu_ap_capture_commands.SMOKE_RUNNER,
        "AP_BENCHMARK_TOOLS": wire_cpu_ap_capture_commands.AP_BENCHMARK_TOOLS,
    }
    old_env = os.environ.get("ELIZA_AP_BENCHMARKS_CMD")
    try:
        os.environ.pop("ELIZA_AP_BENCHMARKS_CMD", None)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            generated_manifest = tmp_path / "generated_manifest.json"
            report = tmp_path / "cpu_ap_benchmark_runner_wiring.json"
            workload = tmp_path / "eliza-e1-ap-benchmarks.json"
            kfrag = tmp_path / "eliza-e1-ap-benchmarks-kfrag"
            payload = tmp_path / "eliza-e1-ap-benchmarks-bin-nodisk"
            freshness_manifest = tmp_path / "payload_freshness_manifest.json"
            linux_config = tmp_path / "linux_config"
            disk_payload = tmp_path / "eliza-e1-ap-benchmarks-bin"
            linux_boot = tmp_path / "eliza_e1_linux_boot.log"
            simulator = tmp_path / "simulator-chipyard.harness-ElizaRocketConfig"
            runner = tmp_path / "run_chipyard_eliza_linux_smoke.sh"

            generated_manifest.write_text("{}", encoding="utf-8")
            workload.write_text(
                "eliza-e1-ap-benchmarks\nstream_c.exe\nufs-dram-contention.fio\n",
                encoding="utf-8",
            )
            kfrag.write_text('CONFIG_CMDLINE="console=ttySIF0 rdinit=/init"\n', encoding="utf-8")
            linux_config.write_text(
                'CONFIG_CMDLINE="console=ttySIF0 rdinit=/init"\n',
                encoding="utf-8",
            )
            payload.write_text("payload\n", encoding="utf-8")
            simulator.write_text("simulator\n", encoding="utf-8")
            runner.write_text(
                "#!/bin/sh\n"
                "echo 'STATUS: PASS chipyard.verilator_ap_benchmarks'\n"
                "exit 0\n",
                encoding="utf-8",
            )
            runner.chmod(0o755)

            wire_cpu_ap_capture_commands.GENERATED_MANIFEST = generated_manifest
            wire_cpu_ap_capture_commands.AP_BENCHMARK_REPORT = report
            wire_cpu_ap_capture_commands.AP_BENCHMARK_WORKLOAD = workload
            wire_cpu_ap_capture_commands.AP_BENCHMARK_KFRAG = kfrag
            wire_cpu_ap_capture_commands.AP_BENCHMARK_PAYLOAD = payload
            wire_cpu_ap_capture_commands.AP_BENCHMARK_FRESHNESS_MANIFEST = freshness_manifest
            wire_cpu_ap_capture_commands.AP_BENCHMARK_LINUX_CONFIG = linux_config
            wire_cpu_ap_capture_commands.AP_BENCHMARK_DISK_PAYLOAD = disk_payload
            wire_cpu_ap_capture_commands.AP_BENCHMARK_LINUX_BOOT_EVIDENCE = linux_boot
            wire_cpu_ap_capture_commands.GENERATED_SIMULATOR = simulator
            wire_cpu_ap_capture_commands.SMOKE_RUNNER = runner
            wire_cpu_ap_capture_commands.AP_BENCHMARK_TOOLS = ()
            args = type("Args", (), {"use_docker": "0"})()

            missing_entries = wire_cpu_ap_capture_commands.build_entries(args)
            missing_entry = {
                entry["mode"]: entry for entry in missing_entries
            }["ap-benchmarks"]
            if missing_entry["status"] != "blocked":
                raise AssertionError("AP benchmark export must block without Linux transcript")
            assert_contains(
                "\n".join(missing_entry.get("problems", [])),
                "generated-AP Linux/userland boot transcript is missing",
            )

            linux_boot.write_text("eliza-evidence: status=PASS\n", encoding="utf-8")
            incomplete_entries = wire_cpu_ap_capture_commands.build_entries(args)
            incomplete_entry = {
                entry["mode"]: entry for entry in incomplete_entries
            }["ap-benchmarks"]
            if incomplete_entry["status"] != "blocked":
                raise AssertionError("AP benchmark export must block on incomplete transcript")
            incomplete_report = json.loads(report.read_text(encoding="utf-8"))
            assert_contains(
                "\n".join(
                    incomplete_report["candidate_generated_ap_inputs"][
                        "linux_boot_evidence_problems"
                    ]
                ),
                "missing required transcript markers",
            )
            if incomplete_report["derived_command_available"]:
                raise AssertionError("AP benchmark command must not derive from incomplete Linux")

            stale_manifest = tmp_path / "old_generated_manifest.json"
            stale_manifest.write_text('{"old":true}', encoding="utf-8")
            linux_boot.write_text(
                accepted_linux_boot_text(generated_manifest=stale_manifest),
                encoding="utf-8",
            )
            stale_entries = wire_cpu_ap_capture_commands.build_entries(args)
            stale_entry = {entry["mode"]: entry for entry in stale_entries}["ap-benchmarks"]
            if stale_entry["status"] != "blocked":
                raise AssertionError("AP benchmark export must block on stale Linux transcript")
            stale_report = json.loads(report.read_text(encoding="utf-8"))
            assert_contains(
                "\n".join(
                    stale_report["candidate_generated_ap_inputs"][
                        "linux_boot_evidence_problems"
                    ]
                ),
                "generated_manifest_sha256 must match",
            )
            if stale_report["derived_command_available"]:
                raise AssertionError("AP benchmark command must not derive from stale Linux")

            linux_boot.write_text(
                accepted_linux_boot_text(generated_manifest=generated_manifest),
                encoding="utf-8",
            )
            missing_sidecar_entries = wire_cpu_ap_capture_commands.build_entries(args)
            missing_sidecar_entry = {
                entry["mode"]: entry for entry in missing_sidecar_entries
            }["ap-benchmarks"]
            if missing_sidecar_entry["status"] != "blocked":
                raise AssertionError(
                    "AP benchmark export must block without payload freshness sidecar"
                )
            missing_sidecar_report = json.loads(report.read_text(encoding="utf-8"))
            freshness = missing_sidecar_report["candidate_generated_ap_inputs"][
                "benchmark_payload_freshness"
            ]
            assert_contains(
                "\n".join(freshness["problems"]),
                "missing generated-AP benchmark payload freshness sidecar",
            )

            def write_freshness_sidecar() -> None:
                inputs = wire_cpu_ap_capture_commands.ap_payload_source_inputs()
                freshness_manifest.write_text(
                    json.dumps(
                        {
                            "schema": (
                                "eliza.firemarshal_ap_benchmarks_payload_freshness.v1"
                            ),
                            "generated_utc": "2026-05-26T12:01:00Z",
                            "payload": {
                                "path": wire_cpu_ap_capture_commands.rel(payload),
                                "sha256": hashlib.sha256(payload.read_bytes()).hexdigest(),
                            },
                            "accepted_linux_boot": {
                                "path": str(linux_boot),
                                "sha256": hashlib.sha256(linux_boot.read_bytes()).hexdigest(),
                                "intake_utc": "2026-05-26T12:00:00Z",
                                "generated_manifest_sha256": hashlib.sha256(
                                    generated_manifest.read_bytes()
                                ).hexdigest(),
                            },
                            "generated_manifest": {
                                "path": str(generated_manifest),
                                "sha256": hashlib.sha256(
                                    generated_manifest.read_bytes()
                                ).hexdigest(),
                            },
                            "inputs": {
                                wire_cpu_ap_capture_commands.rel(path): {
                                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest()
                                }
                                for path in inputs
                                if path.is_file()
                            },
                        }
                    ),
                    encoding="utf-8",
                )

            write_freshness_sidecar()
            kfrag.write_text(
                'CONFIG_CMDLINE="console=ttySIF0 rdinit=/init keep_bootcon"\n',
                encoding="utf-8",
            )
            stale_payload_entries = wire_cpu_ap_capture_commands.build_entries(args)
            stale_payload_entry = {
                entry["mode"]: entry for entry in stale_payload_entries
            }["ap-benchmarks"]
            if stale_payload_entry["status"] != "blocked":
                raise AssertionError("AP benchmark export must block on stale benchmark payload")
            stale_payload_report = json.loads(report.read_text(encoding="utf-8"))
            freshness = stale_payload_report["candidate_generated_ap_inputs"][
                "benchmark_payload_freshness"
            ]
            if freshness["fresh"]:
                raise AssertionError("AP benchmark freshness report should reject stale payload")
            assert_contains(
                "\n".join(freshness["problems"]),
                "generated-AP benchmark payload linux_config cmdline is stale",
            )

            linux_config.write_text(
                'CONFIG_CMDLINE="console=ttySIF0 rdinit=/init keep_bootcon"\n',
                encoding="utf-8",
            )
            payload.write_text("payload rebuilt after kfrag\n", encoding="utf-8")
            write_freshness_sidecar()
            sidecar = json.loads(freshness_manifest.read_text(encoding="utf-8"))
            sidecar["generated_utc"] = "2026-05-26T11:59:59Z"
            freshness_manifest.write_text(json.dumps(sidecar), encoding="utf-8")
            stale_sidecar_entries = wire_cpu_ap_capture_commands.build_entries(args)
            stale_sidecar_entry = {
                entry["mode"]: entry for entry in stale_sidecar_entries
            }["ap-benchmarks"]
            if stale_sidecar_entry["status"] != "blocked":
                raise AssertionError(
                    "AP benchmark export must block on a payload older than linux-boot intake"
                )
            stale_sidecar_report = json.loads(report.read_text(encoding="utf-8"))
            freshness = stale_sidecar_report["candidate_generated_ap_inputs"][
                "benchmark_payload_freshness"
            ]
            assert_contains(
                "\n".join(freshness["problems"]),
                "older than accepted linux-boot intake",
            )
            write_freshness_sidecar()
            os.environ["ELIZA_AP_BENCHMARKS_CMD"] = "printf stale-ap-benchmark"
            env_blocked_entries = wire_cpu_ap_capture_commands.build_entries(args)
            env_blocked_entry = {
                entry["mode"]: entry for entry in env_blocked_entries
            }["ap-benchmarks"]
            if env_blocked_entry["status"] != "blocked":
                raise AssertionError(
                    "AP benchmark export must not trust a manual environment command"
                )
            assert_contains(
                "\n".join(env_blocked_entry.get("problems", [])),
                "ELIZA_AP_BENCHMARKS_CMD is set by the environment",
            )
            os.environ.pop("ELIZA_AP_BENCHMARKS_CMD", None)
            ready_entries = wire_cpu_ap_capture_commands.build_entries(args)
            ready_entry = {entry["mode"]: entry for entry in ready_entries}["ap-benchmarks"]
            if ready_entry["status"] != "ready":
                raise AssertionError(
                    "AP benchmark export should unlock after accepted Linux/userspace transcript: "
                    + " | ".join(str(item) for item in ready_entry.get("problems", []))
                )
            assert_contains(
                str(ready_entry["command"]),
                "CHIPYARD_LINUX_SMOKE_TRANSCRIPT_MODE=ap-benchmarks",
            )
    finally:
        for name, value in old_values.items():
            setattr(wire_cpu_ap_capture_commands, name, value)
        if old_env is None:
            os.environ.pop("ELIZA_AP_BENCHMARKS_CMD", None)
        else:
            os.environ["ELIZA_AP_BENCHMARKS_CMD"] = old_env


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
    wrapper_marker = wire_cpu_ap_capture_commands.AP_BENCHMARK_WRAPPER_PASS_MARKER
    missing_markers = [
        marker for marker in raw_markers if marker != wrapper_marker and marker not in script
    ]
    if missing_markers:
        raise AssertionError(f"AP benchmark marker emitter missing markers: {missing_markers}")

    assert_contains(script, "ap-benchmarks: BLOCKED missing_target_artifact=")
    assert_contains(script, "eliza-evidence: status=PASS")
    for forbidden in ("qemu-virt", "software reference only", "no real transcript"):
        if forbidden in script:
            raise AssertionError(
                f"AP benchmark marker emitter contains forbidden term: {forbidden}"
            )


def test_ap_benchmark_evidence_must_be_intaken_after_linux_boot() -> None:
    linux_text = "\n".join(
        [
            "eliza-evidence: target=cpu_ap artifact=eliza_e1_linux_boot",
            "eliza-evidence: intake_utc=2026-05-26T12:00:00Z",
        ]
    )
    stale_ap_text = "\n".join(
        [
            "eliza-evidence: target=cpu_ap artifact=eliza_e1_ap_benchmarks",
            "eliza-evidence: intake_utc=2026-05-26T11:59:59Z",
        ]
    )
    problem = check_cpu_ap_evidence.transcript_intake_order_problem(
        prerequisite_text=linux_text,
        prerequisite_path="build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        dependent_text=stale_ap_text,
        dependent_path="build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
        dependency_label="linux-boot",
    )
    if problem is None:
        raise AssertionError("stale AP benchmark transcript must be rejected")
    assert_contains(problem, "before linux-boot")
    assert_contains(problem, "regenerate the dependent transcript")

    fresh_ap_text = stale_ap_text.replace("11:59:59Z", "12:00:01Z")
    problem = check_cpu_ap_evidence.transcript_intake_order_problem(
        prerequisite_text=linux_text,
        prerequisite_path="build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        dependent_text=fresh_ap_text,
        dependent_path="build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
        dependency_label="linux-boot",
    )
    if problem is not None:
        raise AssertionError(problem)

    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "ap.log"
        source.write_text("ap benchmark raw transcript\n", encoding="utf-8")
        os.utime(source, (1_779_796_799, 1_779_796_799))
        source_problem = capture_cpu_ap_evidence.ap_benchmark_source_freshness_problem(
            source=source,
            linux_text=linux_text,
            linux_path="build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        )
        if source_problem is None:
            raise AssertionError("AP benchmark source older than linux-boot intake must fail")
        assert_contains(source_problem, "older than accepted linux-boot intake")

        os.utime(source, (1_779_796_801, 1_779_796_801))
        source_problem = capture_cpu_ap_evidence.ap_benchmark_source_freshness_problem(
            source=source,
            linux_text=linux_text,
            linux_path="build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        )
        if source_problem is not None:
            raise AssertionError(source_problem)


def test_ap_benchmark_wrapper_mode_avoids_linux_smoke_checker_and_forbidden_notes() -> None:
    wrapper = (ROOT / "scripts/run_chipyard_eliza_linux_smoke.sh").read_text()
    assert_contains(wrapper, 'transcript_mode="${CHIPYARD_LINUX_SMOKE_TRANSCRIPT_MODE:-linux-smoke}"')
    assert_contains(wrapper, "linux-smoke|ap-benchmarks")
    assert_contains(wrapper, 'if [ "$transcript_mode" = "ap-benchmarks" ]; then')
    assert_contains(wrapper, wire_cpu_ap_capture_commands.AP_BENCHMARK_WRAPPER_PASS_MARKER)
    assert_contains(wrapper, '>>"$log"')
    assert_contains(wrapper, "eliza-evidence: ap_benchmark_wrapper_marker=present")
    assert_contains(wrapper, "scripts/capture_cpu_ap_evidence.py intake ap-benchmarks")

    header_note = "note=software reference transcripts are excluded from generated AP evidence intake"
    assert_contains(wrapper, header_note)
    forbidden_ap_terms = ("note=qemu-virt", "Renode reference transcripts")
    for forbidden in forbidden_ap_terms:
        if forbidden in wrapper:
            raise AssertionError(
                f"generated AP wrapper header contains AP-intake-forbidden note: {forbidden}"
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


def test_isa_cache_mmu_transcript_requires_successful_hwprobe_syscall() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    spec = transcript_specs(manifest)["isa_cache_mmu_log"]
    required = "\n".join(str(token) for token in spec["raw_required_strings"])
    assert_contains(required, "riscv_hwprobe: syscall rc=0")
    assert_contains(required, "Linux CONFIG_MMU: CONFIG_MMU=y")
    assert_contains(required, "riscv_hwprobe: key=mvendorid")
    assert_contains(required, "riscv_hwprobe: key=marchid")
    assert_contains(required, "riscv_hwprobe: key=ima_ext_0")

    baremetal_only = required.replace(
        "riscv_hwprobe: syscall rc=0",
        "Linux hwprobe syscall: not executed by this M-mode bare-metal generated-AP probe",
    )
    baremetal_only += "\n" + ("generated AP ISA/cache/MMU transcript line\n" * 20)
    problems = text_problems(baremetal_only, spec, "isa_cache_mmu_log", raw=True)
    joined = "\n".join(problems)
    assert_contains(joined, "missing required transcript markers")
    assert_contains(joined, "contains forbidden placeholder/failure markers")

    failed_hwprobe = required.replace(
        "riscv_hwprobe: syscall rc=0",
        "riscv_hwprobe: FAIL userspace helper exited nonzero",
    )
    failed_hwprobe += "\n" + ("generated AP ISA/cache/MMU transcript line\n" * 20)
    problems = text_problems(failed_hwprobe, spec, "isa_cache_mmu_log", raw=True)
    joined = "\n".join(problems)
    assert_contains(joined, "missing required transcript markers")
    assert_contains(joined, "contains forbidden placeholder/failure markers")

    missing_key_marker = required.replace(
        "riscv_hwprobe: key=ima_ext_0",
        "riscv_hwprobe: key=missing_ima_ext_0",
    )
    missing_key_marker += "\n" + ("generated AP ISA/cache/MMU transcript line\n" * 20)
    problems = text_problems(missing_key_marker, spec, "isa_cache_mmu_log", raw=True)
    assert_contains("\n".join(problems), "missing required transcript markers")

    valid = required + "\n" + ("generated AP ISA/cache/MMU transcript line\n" * 20)
    problems = text_problems(valid, spec, "isa_cache_mmu_log", raw=True)
    if problems:
        raise AssertionError("\n".join(problems))


def test_raw_transcript_validation_uses_real_uart_tx_reconstruction() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    spec = transcript_specs(manifest)["opensbi_boot_log"]
    required = "\n".join(str(token) for token in spec["raw_required_strings"])
    valid_opensbi = (
        required
        + "\nOpenSBI v1.2\n"
        + "Domain0 Next Address      : 0x0000000080200000\n"
        + "Domain0 Next Arg1         : 0x0000000080b00000\n"
        + "Domain0 Next Mode         : S-mode\n"
    )
    uart_trace = "\n".join(
        f"UART TX ({byte:02x}): {chr(byte)}" for byte in valid_opensbi.encode()
    )
    if reconstruct_uart_tx_text(uart_trace) != valid_opensbi:
        raise AssertionError("UART TX reconstruction did not round-trip the required markers")
    problems = text_problems(uart_trace, spec, "opensbi_boot_log", raw=True)
    if problems:
        raise AssertionError("\n".join(problems))

    banner_only = "\n".join(f"UART TX ({byte:02x}): {chr(byte)}" for byte in b"OpenSBI v1.2\n")
    problems = text_problems(banner_only, spec, "opensbi_boot_log", raw=True)
    joined = "\n".join(problems)
    assert_contains(joined, "Domain0 Next Address")


def test_opensbi_boot_transcript_requires_v12_domain0_fdt_handoff() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    spec = transcript_specs(manifest)["opensbi_boot_log"]
    required = "\n".join(str(token) for token in spec["raw_required_strings"])
    assert_contains(required, "OpenSBI v1.2")
    assert_contains(required, "Domain0 Next Arg1")
    assert_contains(required, "0x0000000080b00000")

    complete = (
        required
        + "\nOpenSBI v1.2\n"
        + "Domain0 Next Address      : 0x0000000080200000\n"
        + "Domain0 Next Arg1         : 0x0000000080b00000\n"
        + "Domain0 Next Mode         : S-mode\n"
        + ("generated AP OpenSBI handoff transcript line\n" * 20)
    )
    problems = text_problems(complete, spec, "opensbi_boot_log", raw=True)
    if problems:
        raise AssertionError("\n".join(problems))

    wrong_version = complete.replace("OpenSBI v1.2", "OpenSBI v1.7")
    problems = text_problems(wrong_version, spec, "opensbi_boot_log", raw=True)
    joined = "\n".join(problems)
    assert_contains(joined, "OpenSBI v1.2")
    assert_contains(joined, "observed OpenSBI versions: v1.7")

    wrong_arg1 = complete.replace("0x0000000080b00000", "0x0000000088000000")
    problems = text_problems(wrong_arg1, spec, "opensbi_boot_log", raw=True)
    joined = "\n".join(problems)
    assert_contains(joined, "Domain0 Next Arg1 FDT handoff")
    assert_contains(joined, "0x0000000088000000")

    diagnostic = complete + "\ndiagnostic only fallback OpenSBI banner-only log\n"
    problems = text_problems(diagnostic, spec, "opensbi_boot_log", raw=True)
    assert_contains(
        "\n".join(problems),
        "contains forbidden placeholder/failure markers",
    )


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
    valid_raw += "\nForcing kernel command line to: 'console=ttyS0 rdinit=/init'"
    valid_raw += "\nRun /init as init process"
    valid_raw += "\n".join(["", *[str(token) for token in spec["raw_ordered_required_strings"][3:]]])
    valid_raw += "\n" + ("generated AP Linux transcript line\n" * 20)
    problems = text_problems(valid_raw, spec, "linux_boot_log", raw=True)
    if problems:
        raise AssertionError("\n".join(problems))

    placeholder_command = "/exact/external/boot command\n" + valid_raw
    problems = text_problems(placeholder_command, spec, "linux_boot_log", raw=True)
    assert_contains("\n".join(problems), "contains forbidden placeholder/failure markers")


def test_linux_boot_transcript_requires_ordered_userland_completion() -> None:
    manifest = load_json(EVIDENCE_MANIFEST)
    spec = transcript_specs(manifest)["linux_boot_log"]
    stuffed_header = "\n".join(str(token) for token in spec["raw_required_strings"])
    stuffed_header += "\nForcing kernel command line to: 'console=ttyS0 rdinit=/init'"
    stuffed_header += "\nRun /init as init process\n"
    stuffed_header += "generated AP Linux transcript line\n" * 20
    problems = text_problems(stuffed_header, spec, "linux_boot_log", raw=True)
    assert_contains(
        "\n".join(problems),
        "missing ordered transcript sequence markers: initramfs start",
    )

    complete = "\n".join(str(token) for token in spec["raw_required_strings"])
    complete += "\nForcing kernel command line to: 'console=ttyS0 rdinit=/init'"
    complete += "\n" + "\n".join(str(token) for token in spec["raw_ordered_required_strings"])
    complete += "\n" + ("generated AP Linux transcript line\n" * 20)
    problems = text_problems(complete, spec, "linux_boot_log", raw=True)
    if problems:
        raise AssertionError("\n".join(problems))

    fallback = complete + "\ndevice=/dev/mem generated-mmio\n"
    problems = text_problems(fallback, spec, "linux_boot_log", raw=True)
    assert_contains(
        "\n".join(problems),
        "contains forbidden placeholder/failure markers",
    )

    diagnostic = complete + "\neliza-kmain: after setup_arch\n"
    problems = text_problems(diagnostic, spec, "linux_boot_log", raw=True)
    assert_contains(
        "\n".join(problems),
        "contains forbidden placeholder/failure markers",
    )

    debug_cmdline = (
        complete
        + "\nKernel command line: console=ttyS0 rdinit=/init ignore_loglevel initcall_debug\n"
    )
    problems = text_problems(debug_cmdline, spec, "linux_boot_log", raw=True)
    assert_contains(
        "\n".join(problems),
        "contains forbidden placeholder/failure markers",
    )


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
    if "STATUS: PASS cpu_ap.linux_evidence" in result.stdout:
        return
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
    if "STATUS: PASS chipyard.payload_path" in result.stdout:
        return
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
        test_isa_cache_mmu_probe_audits_generated_dts_cache_mmu_contract,
        test_isa_cache_mmu_wiring_fails_closed_until_accepted_linux_hwprobe_success,
        test_ap_benchmark_wiring_requires_accepted_linux_userspace_transcript,
        test_ap_benchmark_workload_packages_marker_emitter_and_tools,
        test_ap_benchmark_evidence_must_be_intaken_after_linux_boot,
        test_ap_benchmark_wrapper_mode_avoids_linux_smoke_checker_and_forbidden_notes,
        test_capture_wire_preflight_reports_remaining_unwired_lanes,
        test_capture_wrapper_all_reports_every_missing_command_env,
        test_opensbi_capture_failure_writes_precise_blocker_report,
        test_dts_audit_separates_ap_boot_from_e1_peripherals,
        test_new_transcripts_reject_placeholder_or_incomplete_text,
        test_ap_benchmark_transcript_requires_process_corner_markers,
        test_isa_cache_mmu_transcript_requires_successful_hwprobe_syscall,
        test_raw_transcript_validation_uses_real_uart_tx_reconstruction,
        test_opensbi_boot_transcript_requires_v12_domain0_fdt_handoff,
        test_raw_ap_transcript_markers_have_positive_and_negative_paths,
        test_linux_boot_transcript_requires_ordered_userland_completion,
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
