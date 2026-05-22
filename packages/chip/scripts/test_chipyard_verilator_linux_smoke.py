#!/usr/bin/env python3
"""Unit tests for Chipyard Verilator Linux smoke path handling."""

from __future__ import annotations

import sys
import tempfile
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_chipyard_verilator_linux_smoke as smoke  # noqa: E402
import repair_chipyard_generated_paths as path_repair  # noqa: E402


def test_detects_container_paths_when_host_is_not_container_mount() -> None:
    text = "VM_PREFIX = /work/external/oss-cad-suite-linux-x64/bin\n"
    roots = smoke.detect_stale_absolute_roots(text, Path("/Users/example/npu_experiment"), False)
    if roots != ["/work/"]:
        raise AssertionError(f"expected /work/ stale root, got {roots}")


def test_allows_container_paths_when_running_inside_container_mount() -> None:
    text = "VM_PREFIX = /work/external/oss-cad-suite-linux-x64/bin\n"
    roots = smoke.detect_stale_absolute_roots(text, Path("/work"), False)
    if roots:
        raise AssertionError(f"expected no stale roots under /work host root, got {roots}")


def test_allow_env_semantics_suppress_container_path_block() -> None:
    text = "VM_PREFIX = /work/external/oss-cad-suite-linux-x64/bin\n"
    roots = smoke.detect_stale_absolute_roots(text, Path("/Users/example/npu_experiment"), True)
    if roots:
        raise AssertionError(f"expected allow flag to suppress stale roots, got {roots}")


def test_non_container_absolute_path_is_not_flagged_by_this_gate() -> None:
    text = "VM_PREFIX = /opt/conda/bin\n"
    roots = smoke.detect_stale_absolute_roots(text, Path("/Users/example/npu_experiment"), False)
    if roots:
        raise AssertionError(f"unexpected stale roots for unrelated path: {roots}")


def test_path_rewrite_replaces_work_root_deterministically() -> None:
    original = "/work/external/chipyard/foo.f\n+incdir+/work/generated\n"
    rewritten, replacements = path_repair.rewrite_text(original, "/work", ROOT)
    if replacements != 2:
        raise AssertionError(f"expected two replacements, got {replacements}")
    if "/work/" in rewritten:
        raise AssertionError(rewritten)
    if str(ROOT) not in rewritten:
        raise AssertionError(rewritten)


def test_path_repair_check_and_rewrite_modes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        generated = Path(tmp) / "sim_files.f"
        generated.write_text("/work/external/chipyard/generated.sv\n", encoding="utf-8")
        results, replacements = path_repair.inspect_or_rewrite(
            [generated], ["/work"], ROOT, rewrite=False
        )
        if replacements != 0:
            raise AssertionError("check mode must not apply replacements")
        if results[0]["stale_roots_found"] != ["/work"]:
            raise AssertionError(str(results))

        results, replacements = path_repair.inspect_or_rewrite(
            [generated], ["/work"], ROOT, rewrite=True
        )
        if replacements != 1 or not results[0]["rewritten"]:
            raise AssertionError(str(results))
        if "/work/" in generated.read_text(encoding="utf-8"):
            raise AssertionError("stale path survived rewrite")


def test_generated_model_artifact_failure_classifier_is_narrow() -> None:
    generated_failures = (
        "make: *** No rule to make target 'generated-src/mm/VTestDriver.d', needed by 'sim'.\n",
        "fatal error: generated-src/chipyard.harness.TestHarness.ElizaRocketConfig/"
        "VTestDriver___024root.h: No such file or directory\n",
        "cc1plus: fatal error: mm/VTestDriver__ALL.cpp: No such file or directory\n",
    )
    for log_text in generated_failures:
        if not smoke.is_generated_model_artifact_failure(log_text):
            raise AssertionError(f"expected generated artifact failure: {log_text}")

    unrelated_failures = (
        "fatal error: linux/init.h: No such file or directory\n",
        "make: *** No rule to make target 'payload.elf', needed by 'run-binary'.\n",
        "%Error: generated-src/TestDriver.v:147: Verilog $stop\n",
    )
    for log_text in unrelated_failures:
        if smoke.is_generated_model_artifact_failure(log_text):
            raise AssertionError(f"unexpected generated artifact classification: {log_text}")


def test_smoke_progress_classification_distinguishes_stages() -> None:
    complete_log = {"raw_transcript_closed": True}
    no_trace = {"bootrom_to_payload_handoff": False}
    payload_trace = {"bootrom_to_payload_handoff": True, "fresh_for_log": True}

    cases = {
        "cpu_progress_to_payload": ("SimDRAM loaded ELF entry=0x80000000\n", payload_trace),
        "opensbi_boot": ("OpenSBI v1.8.1\nDomain0 Next Address\n", payload_trace),
        "opensbi_banner_only": ("OpenSBI v1.8.1\n", payload_trace),
        "linux_boot": (
            "OpenSBI v1.8.1\nDomain0 Next Address\nLinux version 6.12.\nKernel command line:\n",
            payload_trace,
        ),
        "quiet_linux_workload_completed": (
            "eliza-evidence: payload=/tmp/linux-poweroff-quiet-bin-nodisk\n"
            "external/chipyard/generated-src/TestDriver.v:158: Verilog $finish\n",
            payload_trace,
        ),
        "linux_kernel_panic": (
            "OpenSBI v1.8.1\n"
            "Domain0 Next Address\n"
            "Linux version 6.12.\n"
            "Kernel panic - not syncing: memory_present: Failed to allocate memmap\n",
            payload_trace,
        ),
        "linux_banner_only": ("OpenSBI v1.8.1\nLinux version 6.12.\n", payload_trace),
        "payload_loaded_no_cpu_progress": (
            "SimDRAM loaded ELF entry=0x80000000\n",
            no_trace,
        ),
        "no_run": ("", no_trace),
    }
    for expected, (text, trace) in cases.items():
        metadata = dict(complete_log)
        if expected == "quiet_linux_workload_completed":
            metadata["payload"] = "/tmp/linux-poweroff-quiet-bin-nodisk"
            metadata["sim_success_finishes"] = [
                "external/chipyard/generated-src/TestDriver.v:158: Verilog $finish"
            ]
        classified = smoke.classify_smoke_progress(text, trace, metadata)
        if classified["stage"] != expected:
            raise AssertionError(f"expected {expected}, got {classified}")

    timeout_progress = smoke.classify_smoke_progress(
        "OpenSBI v1.8.1\nLinux version 6.12.\n*** FAILED *** (timeout) after 200 cycles\n",
        payload_trace,
        {"raw_transcript_closed": True, "sim_failures": ["*** FAILED *** (timeout)"]},
    )
    if timeout_progress["stage"] != "linux_banner_then_max_cycles":
        raise AssertionError(f"expected max-cycle timeout stage, got {timeout_progress}")
    if "CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES" not in timeout_progress["next_step"]:
        raise AssertionError(f"expected timeout-cycle guidance, got {timeout_progress}")

    no_dramsim_no_uart = smoke.classify_smoke_progress(
        "eliza-evidence: disable_dramsim=1\n"
        "eliza-evidence: raw_transcript_end\n"
        "eliza-evidence: exit_code=143\n",
        no_trace,
        {
            "raw_transcript_closed": True,
            "run_target": "run-binary-fast",
            "disable_dramsim": "1",
            "exit_code": "143",
        },
    )
    if no_dramsim_no_uart["stage"] != "no_dramsim_fast_timeout_no_uart":
        raise AssertionError(f"expected no-DRAMSim no-UART stage, got {no_dramsim_no_uart}")
    if (
        "run-binary" not in no_dramsim_no_uart["next_step"]
        or "PC-stage evidence" not in no_dramsim_no_uart["next_step"]
    ):
        raise AssertionError(f"expected traced rerun guidance, got {no_dramsim_no_uart}")

    dramsim_uart_only = smoke.classify_smoke_progress(
        "[UART] UART0 is here (stdin/stdout).\n"
        "DRAMSim2 Clock Frequency =666666666Hz, CPU Clock Frequency=500000000Hz\n",
        no_trace,
        {
            "raw_transcript_closed": True,
            "run_target": "run-binary-fast",
            "disable_dramsim": "0",
            "exit_code": "124",
        },
    )
    if dramsim_uart_only["stage"] != "dramsim_uart_only_no_observable_payload_entry":
        raise AssertionError(f"expected DRAMSim UART-only stage, got {dramsim_uart_only}")
    if "loadmem entry instrumentation" not in dramsim_uart_only["next_step"]:
        raise AssertionError(f"expected instrumentation guidance, got {dramsim_uart_only}")

    build_timeout = smoke.classify_smoke_progress(
        "[timeout-wrapper] label=chipyard-generated-ap-linux-smoke status=timeout\n"
        "g++ -include VTestDriver__pch.h.fast -c VTestDriver___024root__61.cpp\n",
        no_trace,
        {"raw_transcript_closed": True, "exit_code": "124"},
    )
    if build_timeout["stage"] != "simulator_model_build_timeout":
        raise AssertionError(f"expected model-build timeout stage, got {build_timeout}")
    if "CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS" not in build_timeout["next_step"]:
        raise AssertionError(f"expected wall-time guidance, got {build_timeout}")

    rebuild_interrupted = smoke.classify_smoke_progress(
        "cd /tmp/chipyard && java -jar scripts/sbt-launch.jar ';project chipyard; assembly'\n"
        "[info] Defining assembly / assemblyOutputPath\n"
        "make: *** [/tmp/chipyard/.classpath_cache/chipyard.jar] Terminated\n"
        "eliza-evidence: raw_transcript_end\n"
        "eliza-evidence: exit_code=143\n",
        payload_trace,
        {"raw_transcript_closed": True, "exit_code": "143"},
    )
    if rebuild_interrupted["stage"] != "simulator_rebuild_interrupted":
        raise AssertionError(f"expected rebuild-interrupted stage, got {rebuild_interrupted}")
    if "Verilator simulator rebuild" not in rebuild_interrupted["next_step"]:
        raise AssertionError(f"expected simulator rebuild guidance, got {rebuild_interrupted}")

    testdriver_assert = smoke.classify_smoke_progress(
        "OpenSBI v1.2\n"
        "[10000001000] %Fatal: TestDriver.v:147: Assertion failed in TestDriver\n"
        "%Error: generated-src/TestDriver.v:147: Verilog $stop\n",
        payload_trace,
        {
            "raw_transcript_closed": True,
            "fatal_errors": ["%Fatal: TestDriver.v:147: Assertion failed in TestDriver"],
            "sim_failures": [
                "%Fatal: TestDriver.v:147: Assertion failed in TestDriver",
                "%Error: generated-src/TestDriver.v:147: Verilog $stop",
            ],
        },
    )
    if testdriver_assert["stage"] != "opensbi_banner_then_testdriver_assert":
        raise AssertionError(f"expected TestDriver assertion stage, got {testdriver_assert}")
    if "CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES" not in testdriver_assert["next_step"]:
        raise AssertionError(f"expected timeout-cycle guidance, got {testdriver_assert}")

    opensbi_timeout = smoke.classify_smoke_progress(
        "OpenSBI v1.2\n"
        "Domain0 Name              : root\n"
        "*** FAILED ***                       (timeout) after 100000001 simulation cycles\n"
        "[100000001000] %Fatal: TestDriver.v:147: Assertion failed in TestDriver\n",
        payload_trace,
        {
            "raw_transcript_closed": True,
            "fatal_errors": ["[100000001000] %Fatal: TestDriver.v:147: Assertion failed"],
            "sim_failures": [
                "*** FAILED ***                       (timeout) after 100000001 simulation cycles",
                "[100000001000] %Fatal: TestDriver.v:147: Assertion failed in TestDriver",
            ],
        },
    )
    if opensbi_timeout["stage"] != "opensbi_banner_then_max_cycles":
        raise AssertionError(f"expected OpenSBI max-cycle stage, got {opensbi_timeout}")


def test_quiet_completion_does_not_mask_nonquiet_payload_timeout() -> None:
    old_log = smoke.LOG
    old_sim_output_dir = smoke.SIM_OUTPUT_DIR
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            smoke.LOG = tmp_path / "verilator-linux-smoke.log"
            smoke.SIM_OUTPUT_DIR = (
                tmp_path
                / "output"
                / "chipyard.harness.TestHarness.ElizaRocketConfig"
            )
            smoke.SIM_OUTPUT_DIR.mkdir(parents=True)
            smoke.LOG.write_text(
                "eliza-evidence: target=generated_chipyard_ap\n"
                "eliza-evidence: payload=/tmp/eliza-e1-linux-smoke-bin-nodisk\n"
                "eliza-evidence: binary_arg=/tmp/eliza-e1-linux-smoke-bin-nodisk\n"
                "eliza-evidence: raw_transcript_begin\n"
                "[timeout-wrapper] label=chipyard-generated-ap-linux-smoke\n"
                "[UART] UART0 is here (stdin/stdout).\n"
                "Terminated\n"
                "eliza-evidence: raw_transcript_end\n"
                "eliza-evidence: exit_code=143\n"
                "eliza-evidence: signal=TERM\n"
                "eliza-evidence: status=BLOCKED\n",
                encoding="utf-8",
            )
            quiet_log = smoke.SIM_OUTPUT_DIR / "linux-poweroff-quiet-bin-nodisk.log"
            quiet_log.write_text(
                "[UART] UART0 is here (stdin/stdout).\n"
                "[    0.000000] Linux version 6.6.0\n"
                "[    0.000000] Forcing kernel command line to: console=ttyS0 earlycon quiet\n"
                "[    0.000000] SBI specification v1.0 detected\n"
                "[    0.000000] SBI implementation ID=0x1 Version=0x10002\n"
                "[    0.000000] SBI TIME extension detected\n"
                "[    0.000000] earlycon: sifive0 at MMIO 0x0000000010001000\n"
                "- generated-src/TestDriver.v:158: Verilog $finish\n",
                encoding="utf-8",
            )

            metadata = smoke.parse_log_metadata()
            log_text = smoke.LOG.read_text(encoding="utf-8")
            if smoke.has_quiet_linux_completion_evidence(log_text, metadata, None):
                raise AssertionError(f"unexpected quiet completion evidence, got {metadata}")
            classified = smoke.classify_smoke_progress(
                log_text,
                {"bootrom_to_payload_handoff": False},
                metadata,
            )
            if classified["stage"] == "quiet_linux_workload_completed":
                raise AssertionError(f"quiet completion masked nonquiet payload: {classified}")
            completion_logs = metadata.get("quiet_linux_completion_logs")
            if not isinstance(completion_logs, list) or len(completion_logs) != 1:
                raise AssertionError(f"expected one quiet completion log, got {metadata}")
    finally:
        smoke.LOG = old_log
        smoke.SIM_OUTPUT_DIR = old_sim_output_dir


def test_active_smoke_process_parser_keeps_commands_intact() -> None:
    rows = smoke.process_rows_from_ps(
        "  79801  1  04:17 python3 scripts/run_with_timeout.py --label chipyard-generated-ap-linux-smoke -- make run-binary-fast\n"
        "  79886  79885  04:17 /tmp/simulator-chipyard.harness-ElizaRocketConfig +loadmem=/tmp/eliza-e1-linux-smoke-bin-nodisk\n"
    )
    if len(rows) != 2:
        raise AssertionError(rows)
    if rows[0]["pid"] != 79801 or rows[0]["ppid"] != 1:
        raise AssertionError(rows)
    if "--label chipyard-generated-ap-linux-smoke" not in str(rows[0]["command"]):
        raise AssertionError(rows)
    if "+loadmem=/tmp/eliza-e1-linux-smoke-bin-nodisk" not in str(rows[1]["command"]):
        raise AssertionError(rows)


def test_active_simulator_artifact_users_detects_shared_simulator() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        sim = Path(tmp) / "simulator-chipyard.harness-ElizaRocketConfig"
        ps_stdout = (
            f"  1234  1  00:12 {sim} +loadmem=/tmp/trap_timer_irq.elf\n"
            "  9999  1  00:01 rg simulator-chipyard.harness-ElizaRocketConfig\n"
        )
        users = smoke.active_simulator_artifact_users((sim,), ps_stdout)
        if len(users) != 1:
            raise AssertionError(users)
        if users[0]["pid"] != 1234:
            raise AssertionError(users)
        if str(sim) not in users[0]["matched_simulator_paths"]:
            raise AssertionError(users)


def test_live_sim_output_metadata_reports_latest_progress() -> None:
    old_sim_output_dir = smoke.SIM_OUTPUT_DIR
    try:
        with tempfile.TemporaryDirectory() as tmp:
            smoke.SIM_OUTPUT_DIR = Path(tmp)
            live = smoke.SIM_OUTPUT_DIR / "eliza-e1-linux-smoke-bin-nodisk.log"
            live.write_text(
                "[UART] UART0 is here (stdin/stdout).\n"
                "OpenSBI v1.8.1\n"
                "Domain0 Next Address\n",
                encoding="utf-8",
            )
            metadata = smoke.live_sim_output_metadata(
                "/tmp/eliza-e1-linux-smoke-bin-nodisk",
                {"binary_arg": "/tmp/eliza-e1-linux-smoke-bin-nodisk"},
            )
            latest = metadata.get("latest")
            if not isinstance(latest, dict):
                raise AssertionError(metadata)
            if latest.get("path") != str(live):
                raise AssertionError(metadata)
            if latest.get("has_opensbi_handoff") is not True:
                raise AssertionError(metadata)
            if latest.get("last_progress_marker") != "Domain0 Next Address":
                raise AssertionError(metadata)
    finally:
        smoke.SIM_OUTPUT_DIR = old_sim_output_dir


def test_active_attempt_metadata_prefers_current_rebuild_temp_log() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        old_raw = tmp_path / "verilator-linux-smoke.old.raw.tmp"
        old_raw.write_text("[UART] UART0 is here (stdin/stdout).\n", encoding="utf-8")
        new_raw = tmp_path / "verilator-linux-smoke.new.raw.tmp"
        new_raw.write_text(
            "make VM_PARALLEL_BUILDS=1 -C generated -f VTestDriver.mk\n"
            "g++ -include VTestDriver__pch.h.fast -c VTestDriver___024root__42.cpp\n",
            encoding="utf-8",
        )
        os.utime(old_raw, (1_700_000_000, 1_700_000_000))
        os.utime(new_raw, (1_700_000_100, 1_700_000_100))
        metadata = smoke.active_smoke_attempt_metadata(tmp_path)
        if metadata["path"] != str(new_raw):
            raise AssertionError(metadata)
        if metadata["stage"] != "simulator_rebuild_in_progress":
            raise AssertionError(metadata)
        if "VTestDriver___024root__42.cpp" not in metadata["last_progress_marker"]:
            raise AssertionError(metadata)
        if metadata["reached_simulator_runtime"] is not False:
            raise AssertionError(metadata)


def test_simdram_audit_requires_observable_loadmem_marker() -> None:
    audit = smoke.sim_memory_model_audit()
    simdram = audit.get("simdram")
    if not isinstance(simdram, dict):
        raise AssertionError(audit)
    if simdram.get("emits_loadmem_entry_marker") is not True:
        raise AssertionError(audit)


def test_simulator_artifact_blocks_when_simdram_source_is_newer() -> None:
    old_simdram_source = smoke.SIMDRAM_SOURCE
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            simdram = tmp_path / "SimDRAM.cc"
            simdram.write_text(smoke.SIMDRAM_LOADMEM_ENTRY_MARKER + "\n", encoding="utf-8")
            simulator = tmp_path / "simulator"
            simulator.write_text("sim\n", encoding="utf-8")
            smoke.SIMDRAM_SOURCE = simdram
            old_time = 1_700_000_000
            new_time = old_time + 100
            os.utime(simulator, (old_time, old_time))
            os.utime(simdram, (new_time, new_time))
            blockers = smoke.simulator_artifact_blockers(
                {
                    "executable_candidate": True,
                    "candidates": [
                        {
                            "path": str(simulator),
                            "exists": True,
                            "mtime": simulator.stat().st_mtime,
                        }
                    ],
                }
            )
            if not any("predates SimDRAM loadmem instrumentation" in item for item in blockers):
                raise AssertionError(blockers)
    finally:
        smoke.SIMDRAM_SOURCE = old_simdram_source


def test_loadmem_diagnosis_explains_trace_entry_without_marker() -> None:
    old_simdram_source = smoke.SIMDRAM_SOURCE
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            simdram = tmp_path / "SimDRAM.cc"
            simdram.write_text(smoke.SIMDRAM_LOADMEM_ENTRY_MARKER + "\n", encoding="utf-8")
            smoke.SIMDRAM_SOURCE = simdram
            os.utime(simdram, (1_700_000_100, 1_700_000_100))
            diagnosis = smoke.loadmem_diagnosis(
                "make BINARY=/tmp/payload LOADMEM=1 run-binary\n",
                {"command": "make BINARY=/tmp/payload LOADMEM=1 run-binary"},
                {
                    "entered_payload": True,
                    "first_payload_pc": "0x0000000080000000",
                    "first_payload_cycle": 148,
                    "last_pc": "0x000000008000e0ee",
                    "last_symbol": "fdt_offset_ptr",
                },
                {
                    "candidates": [
                        {
                            "exists": True,
                            "mtime": 1_700_000_000,
                        }
                    ]
                },
            )
            if diagnosis["plus_loadmem_in_command"] is not True:
                raise AssertionError(diagnosis)
            if diagnosis["simdram_loaded_elf_marker_observed"] is not False:
                raise AssertionError(diagnosis)
            if diagnosis["trace_entered_payload"] is not True:
                raise AssertionError(diagnosis)
            if diagnosis["first_payload_pc"] != "0x0000000080000000":
                raise AssertionError(diagnosis)
            if diagnosis["simdram_source_newer_than_simulator"] is not True:
                raise AssertionError(diagnosis)
            if "predates the SimDRAM loadmem entry printf" not in str(diagnosis["reason"]):
                raise AssertionError(diagnosis)
    finally:
        smoke.SIMDRAM_SOURCE = old_simdram_source


def test_generated_fdt_audit_covers_current_generated_dts() -> None:
    audit = smoke.generated_fdt_audit()
    if audit.get("exists") is not True:
        raise AssertionError(audit)
    if audit.get("dtc_status") != "pass":
        raise AssertionError(audit)
    if audit.get("fits_bootrom_region") is not True:
        raise AssertionError(audit)
    if audit.get("missing_required_tokens"):
        raise AssertionError(audit)
    required = audit.get("required_tokens")
    if not isinstance(required, dict) or required.get("npu") is not True:
        raise AssertionError(audit)


def test_next_command_requests_rebuild_for_stale_simdram_instrumentation() -> None:
    old_simdram_source = smoke.SIMDRAM_SOURCE
    old_simulator_candidates = smoke.SIMULATOR_CANDIDATES
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            simdram = tmp_path / "SimDRAM.cc"
            simdram.write_text(smoke.SIMDRAM_LOADMEM_ENTRY_MARKER + "\n", encoding="utf-8")
            simulator = tmp_path / "simulator-chipyard.harness-ElizaRocketConfig"
            simulator.write_bytes(b"\x7fELF" + bytes(16))
            simulator.chmod(0o755)
            os.utime(simulator, (1_700_000_000, 1_700_000_000))
            os.utime(simdram, (1_700_000_100, 1_700_000_100))
            smoke.SIMDRAM_SOURCE = simdram
            smoke.SIMULATOR_CANDIDATES = (simulator,)
            command = smoke.next_command("/tmp/payload")
            if "CHIPYARD_LINUX_SMOKE_BREAK_SIM_PREREQ=0" not in command:
                raise AssertionError(command)
            if "CHIPYARD_LINUX_SMOKE_RUN_TARGET=run-binary" not in command:
                raise AssertionError(command)
    finally:
        smoke.SIMDRAM_SOURCE = old_simdram_source
        smoke.SIMULATOR_CANDIDATES = old_simulator_candidates


def test_next_safe_action_waits_for_active_simulator_users() -> None:
    old_simdram_source = smoke.SIMDRAM_SOURCE
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            simdram = tmp_path / "SimDRAM.cc"
            simdram.write_text(smoke.SIMDRAM_LOADMEM_ENTRY_MARKER + "\n", encoding="utf-8")
            os.utime(simdram, (1_700_000_100, 1_700_000_100))
            smoke.SIMDRAM_SOURCE = simdram
            simulator_metadata = {
                "candidates": [
                    {
                        "exists": True,
                        "mtime": 1_700_000_000,
                    }
                ]
            }
            users = [{"pid": 1234, "elapsed": "00:10"}]
            action = smoke.next_safe_action(simulator_metadata, users)
            if "wait for active ElizaRocketConfig simulator user" not in action:
                raise AssertionError(action)
            if "pid=1234" not in action:
                raise AssertionError(action)
    finally:
        smoke.SIMDRAM_SOURCE = old_simdram_source


def test_active_attempt_overrides_stale_canonical_progress() -> None:
    progress = smoke.progress_with_active_attempt(
        {
            "stage": "simulator_rebuild_interrupted",
            "next_step": "rerun the generated AP smoke",
        },
        [{"pid": 1234, "command": "scripts/run_chipyard_eliza_linux_smoke.sh"}],
        {
            "exists": True,
            "stage": "simulator_runtime_in_progress",
            "last_progress_marker": "SimDRAM loaded ELF entry=0x0000000080000000",
        },
    )
    if progress["stage"] != "simulator_runtime_in_progress":
        raise AssertionError(progress)
    if "wait for the active generated AP Linux smoke wrapper" not in progress["next_step"]:
        raise AssertionError(progress)
    action = smoke.next_safe_action(
        {"candidates": []},
        [],
        [{"pid": 1234, "command": "scripts/run_chipyard_eliza_linux_smoke.sh"}],
        {
            "stage": "simulator_runtime_in_progress",
            "last_progress_marker": "SimDRAM loaded ELF entry=0x0000000080000000",
        },
    )
    if "wait for active generated AP Linux smoke to finish" not in action:
        raise AssertionError(action)
    if "simulator_runtime_in_progress" not in action:
        raise AssertionError(action)


def main() -> int:
    tests = (
        test_detects_container_paths_when_host_is_not_container_mount,
        test_allows_container_paths_when_running_inside_container_mount,
        test_allow_env_semantics_suppress_container_path_block,
        test_non_container_absolute_path_is_not_flagged_by_this_gate,
        test_path_rewrite_replaces_work_root_deterministically,
        test_path_repair_check_and_rewrite_modes,
        test_generated_model_artifact_failure_classifier_is_narrow,
        test_smoke_progress_classification_distinguishes_stages,
        test_quiet_completion_does_not_mask_nonquiet_payload_timeout,
        test_active_smoke_process_parser_keeps_commands_intact,
        test_active_simulator_artifact_users_detects_shared_simulator,
        test_live_sim_output_metadata_reports_latest_progress,
        test_active_attempt_metadata_prefers_current_rebuild_temp_log,
        test_simdram_audit_requires_observable_loadmem_marker,
        test_simulator_artifact_blocks_when_simdram_source_is_newer,
        test_loadmem_diagnosis_explains_trace_entry_without_marker,
        test_generated_fdt_audit_covers_current_generated_dts,
        test_next_command_requests_rebuild_for_stale_simdram_instrumentation,
        test_next_safe_action_waits_for_active_simulator_users,
        test_active_attempt_overrides_stale_canonical_progress,
    )
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
