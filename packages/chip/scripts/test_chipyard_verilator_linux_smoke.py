#!/usr/bin/env python3
"""Unit tests for Chipyard Verilator Linux smoke path handling."""

from __future__ import annotations

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


def test_smoke_progress_classification_distinguishes_stages() -> None:
    complete_log = {"raw_transcript_closed": True}
    no_trace = {"bootrom_to_payload_handoff": False}
    payload_trace = {"bootrom_to_payload_handoff": True, "fresh_for_log": True}

    cases = {
        "cpu_progress_to_payload": ("SimDRAM loaded ELF entry=0x80000000\n", payload_trace),
        "opensbi_boot": ("OpenSBI v1.5\nDomain0 Next Address\n", payload_trace),
        "opensbi_banner_only": ("OpenSBI v1.5\n", payload_trace),
        "linux_boot": (
            "OpenSBI v1.5\nDomain0 Next Address\nLinux version 6.6.0\nKernel command line:\n",
            payload_trace,
        ),
        "linux_banner_only": ("OpenSBI v1.5\nLinux version 6.6.0\n", payload_trace),
        "payload_loaded_no_cpu_progress": (
            "SimDRAM loaded ELF entry=0x80000000\n",
            no_trace,
        ),
        "no_run": ("", no_trace),
    }
    for expected, (text, trace) in cases.items():
        classified = smoke.classify_smoke_progress(text, trace, complete_log)
        if classified["stage"] != expected:
            raise AssertionError(f"expected {expected}, got {classified}")

    timeout_progress = smoke.classify_smoke_progress(
        "OpenSBI v1.5\nLinux version 6.6.0\n*** FAILED *** (timeout) after 200 cycles\n",
        payload_trace,
        {"raw_transcript_closed": True, "sim_failures": ["*** FAILED *** (timeout)"]},
    )
    if timeout_progress["stage"] != "linux_banner_then_max_cycles":
        raise AssertionError(f"expected max-cycle timeout stage, got {timeout_progress}")
    if "CHIPYARD_LINUX_SMOKE_TIMEOUT_CYCLES" not in timeout_progress["next_step"]:
        raise AssertionError(f"expected timeout-cycle guidance, got {timeout_progress}")


def main() -> int:
    tests = (
        test_detects_container_paths_when_host_is_not_container_mount,
        test_allows_container_paths_when_running_inside_container_mount,
        test_allow_env_semantics_suppress_container_path_block,
        test_non_container_absolute_path_is_not_flagged_by_this_gate,
        test_path_rewrite_replaces_work_root_deterministically,
        test_path_repair_check_and_rewrite_modes,
        test_smoke_progress_classification_distinguishes_stages,
    )
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
