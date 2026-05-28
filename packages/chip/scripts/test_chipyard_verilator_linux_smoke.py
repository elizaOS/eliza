#!/usr/bin/env python3
"""Unit tests for Chipyard Verilator Linux smoke path handling."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
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


def test_next_command_uses_exact_located_payload() -> None:
    command = smoke.next_command(
        "external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk"
    )
    if (
        "CHIPYARD_LINUX_BINARY=external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk"
        not in command
    ):
        raise AssertionError(command)
    if "$CHIPYARD_LINUX_BINARY" in command:
        raise AssertionError(command)


def test_report_provenance_sanitizer_strips_host_local_paths() -> None:
    payload = {
        "payload": "/home/shaw/milady/eliza/packages/chip/external/chipyard/software/firemarshal/images/firechip/eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk",
        "dtc_output": "/home/shaw/milady/eliza/packages/chip/build/chipyard/eliza_rocket/generated-src/foo.dts:90: warning",
        "tmp": "/tmp/simulator-chipyard.harness-ElizaRocketConfig +loadmem=/tmp/eliza-e1-linux-smoke-bin-nodisk",
    }

    sanitized = smoke.provenance_safe_value(payload)
    text = json.dumps(sanitized)
    if "/home/shaw" in text or "/tmp/" in text:
        raise AssertionError(text)
    if sanitized["payload"] != (
        "packages/chip/external/chipyard/software/firemarshal/images/firechip/"
        "eliza-e1-linux-smoke/eliza-e1-linux-smoke-bin-nodisk"
    ):
        raise AssertionError(sanitized)


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


def test_firemarshal_payload_config_blockers_detect_stale_payload() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        workload_json = tmp_path / "eliza-e1-linux-smoke.json"
        workload = tmp_path / "eliza-e1-linux-smoke.sh"
        build_hwprobe = tmp_path / "build-hwprobe.sh"
        overlay_init = tmp_path / "eliza-e1-linux-smoke-overlay/etc/init.d/S00eliza-e1-linux-smoke"
        opensbi_defconfig = tmp_path / "opensbi-eliza_defconfig"
        opensbi_patch = tmp_path / "opensbi-eliza-platform-fast-final.patch"
        hwprobe_source = tmp_path / "eliza-riscv-hwprobe.c"
        hwprobe = tmp_path / "eliza-riscv-hwprobe"
        npu_smoke = tmp_path / "e1-npu-ml-smoke"
        kfrag = tmp_path / "eliza-e1-linux-smoke-kfrag"
        linux_config = tmp_path / "linux_config"
        payload = tmp_path / "eliza-e1-linux-smoke-bin-nodisk"
        workload_json.write_text(
            '{"host-init":"build-hwprobe.sh","files":'
            '[["eliza-e1-linux-smoke.sh","/usr/bin/eliza-e1-linux-smoke"],'
            '["eliza-riscv-hwprobe","/usr/bin/eliza-riscv-hwprobe"],'
            '["e1-npu-ml-smoke","/usr/bin/e1-npu-ml-smoke"]]}\n',
            encoding="utf-8",
        )
        for executable in (workload, build_hwprobe, hwprobe, npu_smoke):
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
        hwprobe_source.write_text("int main(void) { return 0; }\n", encoding="utf-8")
        kfrag.write_text(
            'CONFIG_CMDLINE="console=ttySIF0,3686400n8 quiet loglevel=0 mem=192M"\n',
            encoding="utf-8",
        )
        linux_config.write_text(
            'CONFIG_CMDLINE="console=ttySIF0,3686400n8 quiet loglevel=4 mem=192M"\n',
            encoding="utf-8",
        )
        payload.write_text("ELF placeholder for mtime test\n", encoding="utf-8")
        os.utime(payload, (payload.stat().st_atime - 10, payload.stat().st_mtime - 10))

        old_json = smoke.FIREMARSHAL_SMOKE_JSON
        old_workload = smoke.FIREMARSHAL_SMOKE_WORKLOAD
        old_build_hwprobe = smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT
        old_hwprobe_source = smoke.FIREMARSHAL_HWPROBE_SOURCE
        old_hwprobe = smoke.FIREMARSHAL_HWPROBE_BINARY
        old_npu_smoke = smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY
        old_kfrag = smoke.FIREMARSHAL_SMOKE_KFRAG
        old_config = smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG
        old_payload = smoke.FIREMARSHAL_SMOKE_PAYLOAD
        old_manifest = smoke.FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST
        try:
            smoke.FIREMARSHAL_SMOKE_JSON = workload_json
            smoke.FIREMARSHAL_SMOKE_WORKLOAD = workload
            smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT = build_hwprobe
            smoke.FIREMARSHAL_HWPROBE_SOURCE = hwprobe_source
            smoke.FIREMARSHAL_HWPROBE_BINARY = hwprobe
            smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY = npu_smoke
            smoke.FIREMARSHAL_SMOKE_KFRAG = kfrag
            smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = linux_config
            smoke.FIREMARSHAL_SMOKE_PAYLOAD = payload
            smoke.FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST = tmp_path / "missing-manifest.json"
            blockers = smoke.firemarshal_payload_config_blockers()
        finally:
            smoke.FIREMARSHAL_SMOKE_JSON = old_json
            smoke.FIREMARSHAL_SMOKE_WORKLOAD = old_workload
            smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT = old_build_hwprobe
            smoke.FIREMARSHAL_HWPROBE_SOURCE = old_hwprobe_source
            smoke.FIREMARSHAL_HWPROBE_BINARY = old_hwprobe
            smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY = old_npu_smoke
            smoke.FIREMARSHAL_SMOKE_KFRAG = old_kfrag
            smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = old_config
            smoke.FIREMARSHAL_SMOKE_PAYLOAD = old_payload
            smoke.FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST = old_manifest

        joined = "\n".join(blockers)
        if "missing current" not in joined:
            raise AssertionError(joined)
        if "kernel cmdline is stale" not in joined:
            raise AssertionError(joined)
        if "payload predates packaged userspace/helper inputs" not in joined:
            raise AssertionError(joined)


def test_firemarshal_payload_freshness_manifest_satisfies_mtime_drift() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        workload_json = tmp_path / "eliza-e1-linux-smoke.json"
        workload = tmp_path / "eliza-e1-linux-smoke.sh"
        build_hwprobe = tmp_path / "build-hwprobe.sh"
        overlay_init = tmp_path / "eliza-e1-linux-smoke-overlay/etc/init.d/S00eliza-e1-linux-smoke"
        opensbi_defconfig = tmp_path / "opensbi-eliza_defconfig"
        opensbi_patch = tmp_path / "opensbi-eliza-platform-fast-final.patch"
        hwprobe_source = tmp_path / "eliza-riscv-hwprobe.c"
        hwprobe = tmp_path / "eliza-riscv-hwprobe"
        npu_smoke = tmp_path / "e1-npu-ml-smoke"
        kfrag = tmp_path / "eliza-e1-linux-smoke-kfrag"
        linux_config = tmp_path / "linux_config"
        payload = tmp_path / "eliza-e1-linux-smoke-bin-nodisk"
        manifest = tmp_path / "payload_freshness_manifest.json"
        workload_json.write_text(
            '{"host-init":"build-hwprobe.sh","files":'
            '[["eliza-e1-linux-smoke.sh","/usr/bin/eliza-e1-linux-smoke"],'
            '["eliza-riscv-hwprobe","/usr/bin/eliza-riscv-hwprobe"],'
            '["e1-npu-ml-smoke","/usr/bin/e1-npu-ml-smoke"]]}\n',
            encoding="utf-8",
        )
        overlay_init.parent.mkdir(parents=True)
        for executable in (workload, build_hwprobe, overlay_init, hwprobe, npu_smoke):
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
        opensbi_defconfig.write_text("# CONFIG_FDT_IRQCHIP is not set\n", encoding="utf-8")
        opensbi_patch.write_text(
            "diff --git a/platform/generic/platform.c b/platform/generic/platform.c\n",
            encoding="utf-8",
        )
        hwprobe_source.write_text("int main(void) { return 0; }\n", encoding="utf-8")
        kfrag.write_text(
            'CONFIG_CMDLINE="console=ttySIF0,3686400n8 quiet loglevel=4 mem=192M"\n',
            encoding="utf-8",
        )
        linux_config.write_text(
            'CONFIG_CMDLINE="console=ttySIF0,3686400n8 quiet loglevel=4 mem=192M"\n',
            encoding="utf-8",
        )
        payload.write_text("ELF placeholder for manifest test\n", encoding="utf-8")
        os.utime(payload, (payload.stat().st_atime - 10, payload.stat().st_mtime - 10))

        def digest(path: Path) -> str:
            return hashlib.sha256(path.read_bytes()).hexdigest()

        inputs = [
            workload_json,
            kfrag,
            workload,
            build_hwprobe,
            overlay_init,
            opensbi_defconfig,
            hwprobe_source,
            hwprobe,
            npu_smoke,
            opensbi_patch,
        ]
        manifest.write_text(
            json.dumps(
                {
                    "schema": "eliza.firemarshal_linux_smoke_payload_freshness.v1",
                    "payload": {"sha256": digest(payload)},
                    "inputs": {smoke.rel(path): {"sha256": digest(path)} for path in inputs},
                }
            )
            + "\n",
            encoding="utf-8",
        )

        old_json = smoke.FIREMARSHAL_SMOKE_JSON
        old_workload = smoke.FIREMARSHAL_SMOKE_WORKLOAD
        old_overlay_init = smoke.FIREMARSHAL_SMOKE_OVERLAY_INIT
        old_build_hwprobe = smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT
        old_hwprobe_source = smoke.FIREMARSHAL_HWPROBE_SOURCE
        old_hwprobe = smoke.FIREMARSHAL_HWPROBE_BINARY
        old_npu_smoke = smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY
        old_opensbi_defconfig = smoke.FIREMARSHAL_OPENSBI_DEFCONFIG
        old_opensbi_patch = smoke.FIREMARSHAL_OPENSBI_FAST_FINAL_PATCH
        old_kfrag = smoke.FIREMARSHAL_SMOKE_KFRAG
        old_config = smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG
        old_payload = smoke.FIREMARSHAL_SMOKE_PAYLOAD
        old_manifest = smoke.FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST
        try:
            smoke.FIREMARSHAL_SMOKE_JSON = workload_json
            smoke.FIREMARSHAL_SMOKE_WORKLOAD = workload
            smoke.FIREMARSHAL_SMOKE_OVERLAY_INIT = overlay_init
            smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT = build_hwprobe
            smoke.FIREMARSHAL_HWPROBE_SOURCE = hwprobe_source
            smoke.FIREMARSHAL_HWPROBE_BINARY = hwprobe
            smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY = npu_smoke
            smoke.FIREMARSHAL_OPENSBI_DEFCONFIG = opensbi_defconfig
            smoke.FIREMARSHAL_OPENSBI_FAST_FINAL_PATCH = opensbi_patch
            smoke.FIREMARSHAL_SMOKE_KFRAG = kfrag
            smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = linux_config
            smoke.FIREMARSHAL_SMOKE_PAYLOAD = payload
            smoke.FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST = manifest
            blockers = smoke.firemarshal_payload_config_blockers()
        finally:
            smoke.FIREMARSHAL_SMOKE_JSON = old_json
            smoke.FIREMARSHAL_SMOKE_WORKLOAD = old_workload
            smoke.FIREMARSHAL_SMOKE_OVERLAY_INIT = old_overlay_init
            smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT = old_build_hwprobe
            smoke.FIREMARSHAL_HWPROBE_SOURCE = old_hwprobe_source
            smoke.FIREMARSHAL_HWPROBE_BINARY = old_hwprobe
            smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY = old_npu_smoke
            smoke.FIREMARSHAL_OPENSBI_DEFCONFIG = old_opensbi_defconfig
            smoke.FIREMARSHAL_OPENSBI_FAST_FINAL_PATCH = old_opensbi_patch
            smoke.FIREMARSHAL_SMOKE_KFRAG = old_kfrag
            smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = old_config
            smoke.FIREMARSHAL_SMOKE_PAYLOAD = old_payload
            smoke.FIREMARSHAL_SMOKE_PAYLOAD_MANIFEST = old_manifest

        joined = "\n".join(blockers)
        if "payload predates packaged userspace/helper inputs" in joined:
            raise AssertionError(joined)


def test_firemarshal_payload_config_blockers_detect_missing_hwprobe_packaging() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        workload_json = tmp_path / "eliza-e1-linux-smoke.json"
        workload = tmp_path / "eliza-e1-linux-smoke.sh"
        build_hwprobe = tmp_path / "build-hwprobe.sh"
        hwprobe_source = tmp_path / "eliza-riscv-hwprobe.c"
        hwprobe = tmp_path / "eliza-riscv-hwprobe"
        npu_smoke = tmp_path / "e1-npu-ml-smoke"
        kfrag = tmp_path / "eliza-e1-linux-smoke-kfrag"
        linux_config = tmp_path / "linux_config"
        payload = tmp_path / "eliza-e1-linux-smoke-bin-nodisk"
        workload_json.write_text(
            '{"host-init":"noop.sh","files":[["eliza-e1-linux-smoke.sh",'
            '"/usr/bin/eliza-e1-linux-smoke"]]}\n',
            encoding="utf-8",
        )
        for executable in (workload, build_hwprobe, npu_smoke):
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
        hwprobe_source.write_text("int main(void) { return 0; }\n", encoding="utf-8")
        kfrag.write_text('CONFIG_CMDLINE="earlycon=sbi mem=192M"\n', encoding="utf-8")
        linux_config.write_text('CONFIG_CMDLINE="earlycon=sbi mem=192M"\n', encoding="utf-8")
        payload.write_text("ELF placeholder\n", encoding="utf-8")

        old_json = smoke.FIREMARSHAL_SMOKE_JSON
        old_workload = smoke.FIREMARSHAL_SMOKE_WORKLOAD
        old_build_hwprobe = smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT
        old_hwprobe_source = smoke.FIREMARSHAL_HWPROBE_SOURCE
        old_hwprobe = smoke.FIREMARSHAL_HWPROBE_BINARY
        old_npu_smoke = smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY
        old_kfrag = smoke.FIREMARSHAL_SMOKE_KFRAG
        old_config = smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG
        old_payload = smoke.FIREMARSHAL_SMOKE_PAYLOAD
        try:
            smoke.FIREMARSHAL_SMOKE_JSON = workload_json
            smoke.FIREMARSHAL_SMOKE_WORKLOAD = workload
            smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT = build_hwprobe
            smoke.FIREMARSHAL_HWPROBE_SOURCE = hwprobe_source
            smoke.FIREMARSHAL_HWPROBE_BINARY = hwprobe
            smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY = npu_smoke
            smoke.FIREMARSHAL_SMOKE_KFRAG = kfrag
            smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = linux_config
            smoke.FIREMARSHAL_SMOKE_PAYLOAD = payload
            blockers = smoke.firemarshal_payload_config_blockers()
        finally:
            smoke.FIREMARSHAL_SMOKE_JSON = old_json
            smoke.FIREMARSHAL_SMOKE_WORKLOAD = old_workload
            smoke.FIREMARSHAL_HWPROBE_BUILD_SCRIPT = old_build_hwprobe
            smoke.FIREMARSHAL_HWPROBE_SOURCE = old_hwprobe_source
            smoke.FIREMARSHAL_HWPROBE_BINARY = old_hwprobe
            smoke.FIREMARSHAL_NPU_ML_SMOKE_BINARY = old_npu_smoke
            smoke.FIREMARSHAL_SMOKE_KFRAG = old_kfrag
            smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = old_config
            smoke.FIREMARSHAL_SMOKE_PAYLOAD = old_payload

        joined = "\n".join(blockers)
        if "does not run build-hwprobe.sh as host-init" not in joined:
            raise AssertionError(joined)
        if "does not package eliza-riscv-hwprobe" not in joined:
            raise AssertionError(joined)
        if "built hwprobe helper is missing" not in joined:
            raise AssertionError(joined)


def test_kfrag_absent_disabled_symbol_is_not_missing() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        kfrag = tmp_path / "eliza-e1-linux-smoke-kfrag"
        linux_config = tmp_path / "linux_config"
        kfrag.write_text(
            "\n".join(
                [
                    'CONFIG_CMDLINE="earlycon=sbi console=ttySIF0,3686400n8 ignore_loglevel loglevel=7 mem=192M"',
                    "CONFIG_DEVMEM=y",
                    "# CONFIG_IO_STRICT_DEVMEM is not set",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        linux_config.write_text(
            "\n".join(
                [
                    'CONFIG_CMDLINE="earlycon=sbi console=ttySIF0,3686400n8 ignore_loglevel loglevel=7 mem=192M"',
                    "CONFIG_DEVMEM=y",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        missing = smoke.kfrag_options_missing_from_linux_config(kfrag, linux_config)
        if missing:
            raise AssertionError(missing)


def test_firemarshal_overlay_init_is_payload_freshness_input() -> None:
    overlay_init = "eliza-e1-linux-smoke-overlay/etc/init.d/S00eliza-e1-linux-smoke"
    for script in (
        ROOT / "scripts/build_firemarshal_eliza_linux_smoke_payload.sh",
        ROOT / "scripts/run_chipyard_eliza_linux_smoke.sh",
    ):
        text = script.read_text(encoding="utf-8")
        if overlay_init not in text:
            raise AssertionError(f"{overlay_init} is not tracked by {script}")
    freshness_inputs = {path.name for path in smoke.firemarshal_payload_freshness_inputs()}
    if "S00eliza-e1-linux-smoke" not in freshness_inputs:
        raise AssertionError("overlay init is not tracked by checker freshness inputs")
    if "opensbi-eliza_defconfig" not in freshness_inputs:
        raise AssertionError("OpenSBI defconfig is not tracked by checker freshness inputs")
    if "opensbi-eliza-platform-fast-final.patch" not in freshness_inputs:
        raise AssertionError("OpenSBI patch is not tracked by checker freshness inputs")


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
        metadata: dict[str, object] = dict(complete_log)
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

    wall_timeout_progress = smoke.classify_smoke_progress(
        "OpenSBI v1.8.1\n"
        "Linux version 6.12.\n"
        "Forcing kernel command line to: console=ttySIF0 earlycon quiet mem=128M\n"
        "[    0.000000] Initmem setup node 0 [mem 0x0000000080000000-0x000000008bffffff]\n"
        "[timeout-wrapper] label=chipyard-generated-ap-linux-smoke status=timeout\n",
        payload_trace,
        {
            "raw_transcript_closed": True,
            "exit_code": "124",
            "timeout_after_seconds": "3600",
            "last_progress_marker": (
                "[    0.000000] Initmem setup node 0 [mem 0x0000000080000000-0x000000008bffffff]"
            ),
        },
    )
    if wall_timeout_progress["stage"] != "linux_early_boot_then_wall_timeout":
        raise AssertionError(f"expected Linux wall-timeout stage, got {wall_timeout_progress}")
    if (
        "CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS" not in wall_timeout_progress["next_step"]
        or "Initmem setup node 0" not in wall_timeout_progress["next_step"]
    ):
        raise AssertionError(
            f"expected wall-timeout guidance with Initmem marker, got {wall_timeout_progress}"
        )

    interrupted_progress = smoke.classify_smoke_progress(
        "OpenSBI v1.8.1\n"
        "Linux version 6.12.\n"
        "Forcing kernel command line to: console=ttySIF0 earlycon mem=128M\n"
        "Terminated\n",
        payload_trace,
        {
            "raw_transcript_closed": True,
            "exit_code": "143",
            "signal": "TERM",
            "last_progress_marker": "Forcing kernel command line to: console=ttySIF0 earlycon mem=128M",
        },
    )
    if interrupted_progress["stage"] != "linux_early_boot_interrupted":
        raise AssertionError(f"expected interrupted Linux stage, got {interrupted_progress}")

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

    old_linux_config = smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG
    try:
        with tempfile.TemporaryDirectory() as tmp:
            linux_config = Path(tmp) / "linux_config"
            linux_config.write_text(
                'CONFIG_CMDLINE="console=ttySIF0,3686400n8 quiet loglevel=0 mem=192M"\n'
                "CONFIG_RISCV_SBI_V01=y\n"
                "CONFIG_HVC_RISCV_SBI=y\n"
                "CONFIG_SERIAL_EARLYCON_RISCV_SBI=y\n",
                encoding="utf-8",
            )
            smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = linux_config
            sifive_uart_timeout = smoke.classify_smoke_progress(
                "[UART] UART0 is here (stdin/stdout).\n"
                "SimDRAM loaded ELF entry=0x0000000080000000\n"
                "DRAMSim2 Clock Frequency =666666666Hz\n"
                "[timeout-wrapper] status=timeout\n",
                no_trace,
                {
                    "disable_dramsim": "0",
                    "exit_code": "124",
                    "extra_sim_flags": "+custom_boot_pin=1 +uart_tx_printf=1",
                    "run_target": "run-binary-fast",
                },
            )
    finally:
        smoke.FIREMARSHAL_SMOKE_LINUX_CONFIG = old_linux_config
    if sifive_uart_timeout["stage"] != "sifive_uart_fast_timeout_no_tx":
        raise AssertionError(f"expected SiFive UART no-TX stage, got {sifive_uart_timeout}")
    if "SiFive UART console path" not in sifive_uart_timeout["next_step"]:
        raise AssertionError(f"expected SiFive UART guidance, got {sifive_uart_timeout}")

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
                tmp_path / "output" / "chipyard.harness.TestHarness.ElizaRocketConfig"
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
                "[UART] UART0 is here (stdin/stdout).\nOpenSBI v1.8.1\nDomain0 Next Address\n",
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


def test_live_sim_output_metadata_reports_linux_memory_progress() -> None:
    old_sim_output_dir = smoke.SIM_OUTPUT_DIR
    try:
        with tempfile.TemporaryDirectory() as tmp:
            smoke.SIM_OUTPUT_DIR = Path(tmp)
            live = smoke.SIM_OUTPUT_DIR / "eliza-e1-linux-smoke-bin-nodisk.log"
            live.write_text(
                "\n".join(
                    [
                        "OpenSBI v1.2",
                        "Domain0 Next Address      : 0x0000000080200000",
                        "[    0.000000] Linux version 6.6.0",
                        "[    0.000000] Memory limited to 128MB",
                        "[    0.000000] memblock_reserve: [0x0000000080b00000-0x0000000080b00fff] dtb",
                        "[    0.000000] OF: reserved mem: 0x0000000080000000..0x000000008003ffff",
                        "[    0.000000] Zone ranges:",
                        "[    0.000000] Initmem setup node 0 [mem 0x0000000080000000-0x0000000087ffffff]",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            metadata = smoke.live_sim_output_metadata(
                "/tmp/eliza-e1-linux-smoke-bin-nodisk",
                {"binary_arg": "/tmp/eliza-e1-linux-smoke-bin-nodisk"},
            )
            latest = metadata.get("latest")
            if not isinstance(latest, dict):
                raise AssertionError(metadata)
            memory = latest.get("linux_memory_progress")
            if not isinstance(memory, dict):
                raise AssertionError(latest)
            if memory.get("observed") is not True:
                raise AssertionError(memory)
            if "Initmem setup node 0" not in str(memory.get("last_marker")):
                raise AssertionError(memory)
            counts = memory.get("marker_counts")
            if not isinstance(counts, dict) or counts.get("memblock_reserve") != 1:
                raise AssertionError(memory)
    finally:
        smoke.SIM_OUTPUT_DIR = old_sim_output_dir


def test_uart_tx_reconstruction_classifies_opensbi_banner_only() -> None:
    banner = "OpenSBI v1.2\n"
    uart_trace = "\n".join(f"UART TX ({byte:02x}): {chr(byte)}" for byte in banner.encode())
    diagnosis = smoke.uart_console_diagnosis(
        "[UART] UART0 is here (stdin/stdout).\n+uart_tx_printf=1\n" + uart_trace,
        {"command": "+uart_tx_printf=1"},
        {"entered_kernel_virtual": False},
        {"required_tokens": {"chosen_stdout": True}},
    )
    if diagnosis["reconstructed_uart_has_opensbi_banner"] is not True:
        raise AssertionError(diagnosis)
    if diagnosis["reconstructed_uart_has_opensbi_handoff"] is not False:
        raise AssertionError(diagnosis)
    progress = smoke.classify_smoke_progress(
        uart_trace,
        {"fresh_for_log": True, "bootrom_to_payload_handoff": True},
        {},
    )
    if progress["stage"] != "opensbi_banner_only":
        raise AssertionError(progress)


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


def test_active_attempt_metadata_reports_live_kernel_virtual_trace() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        raw = tmp_path / "verilator-linux-smoke.live.raw.tmp"
        raw.write_text(
            "\n".join(
                [
                    "eliza-evidence: payload=/tmp/eliza-e1-linux-smoke-bin-nodisk",
                    "SimDRAM loaded ELF entry=0x0000000080000000",
                    "C0:        10 [1] pc=[0000000000010000] W[r 0=0000000000000000][0] R[r 0=0000000000000000] inst=[00000013] nop",
                    "C0:       148 [1] pc=[0000000080000000] W[r 0=0000000000000000][0] R[r 0=0000000000000000] inst=[00000013] nop",
                    "C0:  13580547 [1] pc=[ffffffff80794220] W[r 0=0000000000000000][0] R[r 0=0000000000000000] inst=[00000013] nop",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        metadata = smoke.active_smoke_attempt_metadata(tmp_path)
        if metadata["stage"] != "active_kernel_virtual_execution_no_console":
            raise AssertionError(metadata)
        if metadata["entered_bootrom"] is not True:
            raise AssertionError(metadata)
        if metadata["entered_payload"] is not True:
            raise AssertionError(metadata)
        if metadata["entered_kernel_virtual"] is not True:
            raise AssertionError(metadata)
        if metadata["bootrom_to_payload_handoff"] is not True:
            raise AssertionError(metadata)
        if metadata["first_payload_pc"] != "0x0000000080000000":
            raise AssertionError(metadata)
        if metadata["last_pc"] != "0xffffffff80794220":
            raise AssertionError(metadata)
        if metadata["last_cycle"] != 13_580_547:
            raise AssertionError(metadata)
        if metadata["retired_instruction_count"] != 3:
            raise AssertionError(metadata)
        if "last_pc=0xffffffff80794220" not in str(metadata["last_progress_marker"]):
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
    if audit.get("expected_opensbi_payload_fdt_addr") != "0x80b00000":
        raise AssertionError(audit)
    if audit.get("expected_opensbi_payload_fdt_addr_fits_dram") is not True:
        raise AssertionError(audit)
    if audit.get("expected_opensbi_payload_fdt_addr_clear_of_kernel_low_window") is not False:
        raise AssertionError(audit)


def test_opensbi_domain_handoff_audit_requires_writable_dram_fdt() -> None:
    handoff = smoke.parse_opensbi_domain_handoff(
        """
OpenSBI v1.2
Domain0 Next Address      : 0x0000000080200000
Domain0 Next Arg1         : 0x0000000080b00000
Domain0 Next Mode         : S-mode
""",
        4231,
    )
    if handoff["domain0_next_arg1_matches_expected"] is not True:
        raise AssertionError(handoff)
    if handoff["domain0_next_arg1_fits_dram"] is not True:
        raise AssertionError(handoff)
    if handoff["domain0_next_arg1_clear_of_kernel_low_window"] is not False:
        raise AssertionError(handoff)

    bad_handoff = smoke.parse_opensbi_domain_handoff(
        """
Domain0 Next Address      : 0x0000000080200000
Domain0 Next Arg1         : 0x00000000000100d4
Domain0 Next Mode         : S-mode
""",
        4231,
    )
    if bad_handoff["domain0_next_arg1_matches_expected"] is not False:
        raise AssertionError(bad_handoff)
    if bad_handoff["domain0_next_arg1_in_dram"] is not False:
        raise AssertionError(bad_handoff)


def test_active_live_handoff_overrides_stale_canonical_log() -> None:
    old_root = smoke.ROOT
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            live_log = tmp_path / "external/chipyard/sims/verilator/output/live.log"
            live_log.parent.mkdir(parents=True)
            live_log.write_text(
                "\n".join(
                    [
                        "OpenSBI v1.2",
                        "Domain0 Next Address      : 0x0000000080200000",
                        "Domain0 Next Arg1         : 0x0000000080b00000",
                        "Domain0 Next Mode         : S-mode",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            smoke.ROOT = tmp_path
            text, source = smoke.handoff_observable_text_for_report(
                "Domain0 Next Arg1         : 0x0000000088000000\n",
                [{"pid": 1234}],
                {"path": "external/chipyard/sims/verilator/output/live.log"},
            )
            if source != "active_live_log":
                raise AssertionError((source, text))
            handoff = smoke.parse_opensbi_domain_handoff(text, 4096)
            if handoff["domain0_next_arg1_matches_expected"] is not True:
                raise AssertionError(handoff)
    finally:
        smoke.ROOT = old_root


def test_fdt_handoff_diagnosis_classifies_long_libfdt_loop() -> None:
    trace = {
        "fresh_for_log": True,
        "bootrom_to_payload_handoff": True,
        "first_payload_pc": "0x0000000080000000",
        "last_pc": "0x000000008000e0a2",
        "last_symbol": "fdt_offset_ptr",
        "retired_instruction_count": 9_050_771,
        "last_cycle": 9_936_622,
    }
    audit = {
        "dtc_status": "pass",
        "fits_bootrom_region": True,
        "missing_required_tokens": [],
        "dtb_size_bytes": 4201,
        "bootrom_plus_dtb_bytes": 4393,
        "bootrom_region_size_bytes": 65536,
    }
    diagnosis = smoke.fdt_handoff_diagnosis(trace, audit)
    if diagnosis["loop_detected"] is not True:
        raise AssertionError(diagnosis)
    if diagnosis["generated_dtb_plausible"] is not True:
        raise AssertionError(diagnosis)
    if "runtime FDT handoff" not in str(diagnosis["reason"]):
        raise AssertionError(diagnosis)
    progress = smoke.classify_smoke_progress(
        "SimDRAM loaded ELF entry=0x0000000080000000\n",
        trace,
        {"sim_failures": ["timeout"]},
    )
    if progress["stage"] != "payload_fdt_parse_loop":
        raise AssertionError(progress)


def test_active_attempt_preserves_fdt_loop_classification() -> None:
    progress = smoke.progress_with_active_attempt(
        {
            "stage": "payload_fdt_parse_loop",
            "next_step": "debug FDT handoff",
        },
        [{"pid": 1234, "command": "scripts/run_chipyard_eliza_linux_smoke.sh"}],
        {
            "exists": True,
            "stage": "simulator_runtime_in_progress",
            "last_progress_marker": "SimDRAM loaded ELF entry=0x0000000080000000",
        },
    )
    if progress["stage"] != "active_payload_fdt_parse_loop":
        raise AssertionError(progress)
    if "active smoke running" not in progress["next_step"]:
        raise AssertionError(progress)


def test_kernel_virtual_execution_without_console_is_distinct_stage() -> None:
    trace = {
        "fresh_for_log": True,
        "bootrom_to_payload_handoff": True,
        "entered_kernel_virtual": True,
        "first_payload_pc": "0x0000000080000000",
        "last_pc": "0xffffffff8012deb0",
        "last_symbol": None,
        "retired_instruction_count": 11_760_325,
        "last_cycle": 13_580_547,
    }
    progress = smoke.classify_smoke_progress(
        "SimDRAM loaded ELF entry=0x0000000080000000\n",
        trace,
        {"sim_failures": ["timeout"]},
    )
    if progress["stage"] != "kernel_virtual_execution_no_console":
        raise AssertionError(progress)
    active = smoke.progress_with_active_attempt(
        progress,
        [{"pid": 1234, "command": "scripts/run_chipyard_eliza_linux_smoke.sh"}],
        {"stage": "simulator_runtime_in_progress"},
    )
    if active["stage"] != "active_kernel_virtual_execution_no_console":
        raise AssertionError(active)


def test_diagnostic_instruction_trace_is_supplemental() -> None:
    old_sim_dir = smoke.SIM_DIR
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            output_dir = tmp_path / "output" / f"chipyard.harness.TestHarness.{smoke.CONFIG}"
            output_dir.mkdir(parents=True)
            trace = output_dir / "payload.elf.diag-trace-20260522.out"
            trace.write_text(
                "C0:         19 [1] pc=[0000000000010000] "
                "W[r10=0000000000010000][1] R[r 0=0000000000000000] "
                "R[r 0=0000000000000000] inst=[00000517] auipc a0, 0x0\n"
                "C0:       1071 [1] pc=[0000000080000000] "
                "W[r 8=0000000000000000][1] R[r10=0000000000000000] "
                "R[r 0=0000000000000000] inst=[00050433] add s0, a0, zero\n"
                "C0:       1200 [1] pc=[ffffffff80001000] "
                "W[r 0=0000000000000000][0] R[r 0=0000000000000000] "
                "R[r 0=0000000000000000] inst=[00000013] nop\n",
                encoding="utf-8",
            )
            smoke.SIM_DIR = tmp_path
            metadata = smoke.diagnostic_instruction_trace("/tmp/payload.elf")
            if metadata["diagnostic_only"] is not True:
                raise AssertionError(metadata)
            if metadata["candidate_count"] != 1:
                raise AssertionError(metadata)
            if metadata["bootrom_to_payload_handoff"] is not True:
                raise AssertionError(metadata)
            if metadata["entered_kernel_virtual"] is not True:
                raise AssertionError(metadata)
    finally:
        smoke.SIM_DIR = old_sim_dir


def test_uart_console_diagnosis_flags_no_tx_after_kernel_entry() -> None:
    diagnosis = smoke.uart_console_diagnosis(
        "[UART] UART0 is here (stdin/stdout).\nSimDRAM loaded ELF entry=0x0000000080000000\n",
        {"command": "make EXTRA_SIM_FLAGS='+custom_boot_pin=1 +uart_tx_printf=1' run-binary"},
        {
            "entered_kernel_virtual": True,
            "last_pc": "0xffffffff8012deb0",
        },
        {"required_tokens": {"chosen_stdout": True}},
    )
    if diagnosis["no_observable_uart_tx"] is not True:
        raise AssertionError(diagnosis)
    if diagnosis["uart_tx_event_count"] != 0:
        raise AssertionError(diagnosis)
    if "no UART TX FIFO writes" not in str(diagnosis["reason"]):
        raise AssertionError(diagnosis)


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
        test_next_command_uses_exact_located_payload,
        test_report_provenance_sanitizer_strips_host_local_paths,
        test_non_container_absolute_path_is_not_flagged_by_this_gate,
        test_path_rewrite_replaces_work_root_deterministically,
        test_path_repair_check_and_rewrite_modes,
        test_firemarshal_payload_config_blockers_detect_stale_payload,
        test_firemarshal_payload_freshness_manifest_satisfies_mtime_drift,
        test_firemarshal_payload_config_blockers_detect_missing_hwprobe_packaging,
        test_kfrag_absent_disabled_symbol_is_not_missing,
        test_firemarshal_overlay_init_is_payload_freshness_input,
        test_generated_model_artifact_failure_classifier_is_narrow,
        test_smoke_progress_classification_distinguishes_stages,
        test_quiet_completion_does_not_mask_nonquiet_payload_timeout,
        test_active_smoke_process_parser_keeps_commands_intact,
        test_active_simulator_artifact_users_detects_shared_simulator,
        test_live_sim_output_metadata_reports_latest_progress,
        test_live_sim_output_metadata_reports_linux_memory_progress,
        test_uart_tx_reconstruction_classifies_opensbi_banner_only,
        test_active_attempt_metadata_prefers_current_rebuild_temp_log,
        test_active_attempt_metadata_reports_live_kernel_virtual_trace,
        test_simdram_audit_requires_observable_loadmem_marker,
        test_simulator_artifact_blocks_when_simdram_source_is_newer,
        test_loadmem_diagnosis_explains_trace_entry_without_marker,
        test_generated_fdt_audit_covers_current_generated_dts,
        test_opensbi_domain_handoff_audit_requires_writable_dram_fdt,
        test_fdt_handoff_diagnosis_classifies_long_libfdt_loop,
        test_active_attempt_preserves_fdt_loop_classification,
        test_kernel_virtual_execution_without_console_is_distinct_stage,
        test_diagnostic_instruction_trace_is_supplemental,
        test_uart_console_diagnosis_flags_no_tx_after_kernel_entry,
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
