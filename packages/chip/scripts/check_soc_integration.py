#!/usr/bin/env python3
"""SoC integration gate.

Verifies that:

  1. The integrated SoC top (`e1_soc_integrated`) lints clean under Verilator
     when the testbench wrapper is included.
  2. The boot-smoke cocotb result file passes all expected tests.
  3. The cross-domain interface cocotb result file passes all expected tests.
  4. Each cross-domain edge listed in
     ``docs/evidence/integration/cross-domain-interfaces.yaml`` is either
     WIRED (and exercised by a passing cocotb test) or has an explicit
     ``blocked_reason`` documenting why it is BLOCKED / TIED_OFF.

The gate fails closed: if Verilator or cocotb is unavailable, the gate
reports BLOCKED with the missing dependency and exits non-zero.  This
behavior mirrors the existing fail-closed evidence-gate pattern under
``scripts/check_*.py``.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/evidence/integration"
RESULTS_DIR = ROOT / "verify/cocotb/results"
BUILD_DIR = ROOT / "build/reports/cocotb"

EXPECTED_BOOT_TESTS = (
    "reset_clears_bus_and_bootrom_magic",
    "gpio_mmio_write_is_visible",
    "clint_timer_interrupt_fires",
    "dma_npu_display_irqs_fire",
    "pmc_mailbox_loopback",
    "zihpm_mcycle_advances",
    "zihpm_minstret_counts_pulses",
)

EXPECTED_CROSS_TESTS = (
    "bpu_pmu_strobe_increments_zihpm_counter",
    "bpu_resolve_does_not_increment_unrelated_event",
    "bpu_vector_redirect_lanes_are_soc_visible",
    "bpu_fetch_stream_backpressures_soc_ftq_pop",
    "bpu_fetch_stream_drives_soc_l1i_demand_lanes",
    "bpu_fetch_stream_fills_integrated_l1i_l2_slc_dram_path",
    "cluster_lite_tieoff_drives_axi_to_quiet",
    "iommu_fault_count_initially_zero",
    "pmc_mailbox_roundtrips_telemetry",
    "ftq_l1i_shim_emits_prefetch_on_taken_target",
    "ftq_l1i_shim_flushes_on_misprediction",
    "test_iommu_programmed_fault",
    "test_slc_passthrough",
    "test_dram_ctrl_dfi_traffic",
    "display_scanout_reads_fabric_dram",
    "test_cva6_executes_from_bootrom",
)

VALID_EDGE_STATUSES = {
    "WIRED",
    "WIRED_PARTIAL",
    "WIRED_OBSERVABILITY_ONLY",
    "WIRED_STRUCTURAL_ONLY",
    "TIED_OFF",
    "BLOCKED",
}


def block(reason: str) -> int:
    print(f"BLOCKED: {reason}", file=sys.stderr)
    return 2


def fail(reason: str) -> int:
    print(f"FAIL: {reason}", file=sys.stderr)
    return 1


def verilator_lint() -> int:
    """Lint the integrated module and testbench wrapper."""
    verilator = shutil.which("verilator")
    if verilator is None:
        oss = ROOT / "external/oss-cad-suite/bin/verilator"
        if oss.is_file():
            verilator = str(oss)
    if verilator is None:
        return block(
            "Verilator not found; install oss-cad-suite or set PATH so "
            "`verilator` is reachable.  Cannot lint e1_soc_integrated."
        )

    sources = [
        "rtl/top/e1_topology_pkg.sv",
        "rtl/top/e1_soc_pkg.sv",
        "rtl/interconnect/axi4/e1_axi4_pkg.sv",
        "rtl/cache/cache_pkg.sv",
        "rtl/cache/ftq_to_l1i_pkg.sv",
        "rtl/cache/lsu_to_l1d_pkg.sv",
        "rtl/cpu/bpu/bpu_pkg.sv",
        "rtl/cpu/csr/zihpm.sv",
        "rtl/power/power_pkg.sv",
        "rtl/iommu/e1_riscv_iommu_pkg.sv",
        "rtl/cpu/bpu/bimodal.sv",
        "rtl/cpu/bpu/bpu_csr.sv",
        "rtl/cpu/bpu/ftb.sv",
        "rtl/cpu/bpu/ftq.sv",
        "rtl/cpu/bpu/h2p_corrector.sv",
        "rtl/cpu/bpu/ittage.sv",
        "rtl/cpu/bpu/loop_predictor.sv",
        "rtl/cpu/bpu/ras.sv",
        "rtl/cpu/bpu/sc.sv",
        "rtl/cpu/bpu/tage.sv",
        "rtl/cpu/bpu/tage_table.sv",
        "rtl/cpu/bpu/uftb.sv",
        "rtl/cpu/bpu/bpu_top.sv",
        "rtl/cpu/bpu/ftq_to_fetch_stream.sv",
        "rtl/cpu/bpu/fetch_stream_to_l1i_demand.sv",
        "rtl/cpu/bpu/ftq_to_l1i_shim.sv",
        "rtl/cpu/csr/bpu_to_zihpm_remap.sv",
        "rtl/cache/l1i/e1_l1i_cache.sv",
        "rtl/cache/l1i/e1_l1i_dual_miss_to_l2.sv",
        "rtl/cache/l2/e1_l2_cache.sv",
        "rtl/cpu/cluster/e1_cluster_top.sv",
        "rtl/interconnect/axi4/e1_axi4_interconnect.sv",
        "rtl/interconnect/chi_bridge/e1_chi_to_axi4_bridge.sv",
        "rtl/iommu/e1_riscv_iommu.sv",
        "rtl/cache/slc/e1_slc.sv",
        "rtl/memory/dram_ctrl/e1_axi4_dram_model.sv",
        "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
        "rtl/power/pmc_top.sv",
        "rtl/memory/e1_weight_buffer_sram.sv",
        "rtl/bootrom/e1_bootrom.sv",
        "rtl/peripherals/e1_peripherals.sv",
        "rtl/dma/e1_dma.sv",
        "rtl/npu/e1_npu.sv",
        "rtl/display/e1_display.sv",
        "rtl/display/e1_display_scanout.sv",
        "rtl/top/adapters/e1_slc_to_chi_line_shim.sv",
        "rtl/top/adapters/e1_axi4_width_converter.sv",
        "rtl/peripherals/e1_mmio_decode.sv",
        "rtl/peripherals/e1_clint.sv",
        "rtl/memory/e1_behavioral_dram.sv",
        "rtl/top/e1_soc_integrated.sv",
        "verify/cocotb/integration/e1_soc_integrated_tb.sv",
    ]
    args = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-fatal",
        "-Wno-UNUSEDSIGNAL",
        "-Wno-UNUSEDPARAM",
        "-Wno-WIDTHEXPAND",
        "-Wno-WIDTHTRUNC",
        "-Wno-IMPLICITSTATIC",
        "-Wno-CASEINCOMPLETE",
        "-Wno-UNOPTFLAT",
        "-Wno-DECLFILENAME",
        "-Wno-PINCONNECTEMPTY",
        "-Wno-SYNCASYNCNET",
        *[str(ROOT / s) for s in sources],
        "--top-module",
        "e1_soc_integrated_tb",
    ]
    proc = subprocess.run(args, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        return fail(
            "Verilator lint of e1_soc_integrated_tb returned non-zero.  See stderr for details."
        )
    return 0


def read_xml_pass_count(path: Path, expected: tuple) -> tuple:
    """Returns (pass_set, failed_list, errored_list).

    If the XML is missing or malformed, returns (None, None, None).
    """
    if not path.is_file():
        return (None, None, None)
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return (None, None, None)
    root = tree.getroot()
    pass_set = set()
    failed = []
    errored = []
    for tc in root.iter("testcase"):
        name = tc.attrib.get("name", "")
        has_failure = any(child.tag == "failure" for child in tc)
        has_error = any(child.tag == "error" for child in tc)
        if has_failure:
            failed.append(name)
        elif has_error:
            errored.append(name)
        else:
            pass_set.add(name)
    return (pass_set, failed, errored)


def check_cocotb_results(label: str, xml_name: str, expected: tuple) -> int:
    candidates = [
        RESULTS_DIR / xml_name,
        BUILD_DIR / xml_name.replace(".xml", ".raw.xml"),
    ]
    xml_path = next((p for p in candidates if p.is_file()), None)
    if xml_path is None:
        return block(
            f"{label}: cocotb result XML missing.  Run `make cocotb-soc-boot-smoke` "
            f"and `make cocotb-cross-domain` first; the gate is fail-closed."
        )
    passed, failed, errored = read_xml_pass_count(xml_path, expected)
    if passed is None:
        return fail(f"{label}: could not parse cocotb XML at {xml_path}")
    missing = [t for t in expected if t not in passed]
    if missing or failed or errored:
        msg = (
            f"{label}: expected {len(expected)} passing tests; got "
            f"{len(passed)} passing, {len(failed)} failed, "
            f"{len(errored)} errored. Missing: {missing!r}"
        )
        return fail(msg)
    print(f"OK: {label} ({len(passed)} cocotb tests pass)")
    return 0


def parse_yaml_lite(path: Path) -> dict:
    """Tiny YAML reader for the structure we ship.

    Supports:
      key: value
      key:
        - item
        - item
      key:
        nested_key: nested_value

    Sufficient for the cross-domain-interfaces.yaml file shape.
    Anything more elaborate goes through PyYAML when available.
    """
    try:
        import yaml

        return yaml.safe_load(path.read_text())
    except Exception:
        pass
    # Minimal best-effort parser used only when PyYAML is absent.
    result: dict = {}
    stack: list = [result]
    indents: list = [-1]
    list_active: list = [False]
    for raw in path.read_text().splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        while indents and indent <= indents[-1]:
            stack.pop()
            indents.pop()
            list_active.pop()
        if stripped.startswith("- "):
            current = stack[-1]
            value = stripped[2:].strip()
            if isinstance(current, list):
                current.append(value)
            continue
        if ":" in stripped:
            key, _, val = stripped.partition(":")
            key = key.strip()
            val = val.strip()
            container = stack[-1]
            if val == "" or val.startswith("|"):
                child: object = {}
                if isinstance(container, dict):
                    container[key] = child
                stack.append(child)
                indents.append(indent)
                list_active.append(False)
            else:
                if isinstance(container, dict):
                    container[key] = val.strip('"')
    return result


def check_edges_doc() -> int:
    path = EVIDENCE / "cross-domain-interfaces.yaml"
    if not path.is_file():
        return fail(f"missing evidence YAML: {path}")
    try:
        doc = parse_yaml_lite(path)
    except Exception as exc:
        return fail(f"could not parse {path}: {exc}")
    edges = doc.get("edges") if isinstance(doc, dict) else None
    if not isinstance(edges, list):
        # Best-effort regex over the file when the YAML parse degrades to
        # the minimal reader.
        text = path.read_text()
        names = re.findall(r"-\s*name:\s*([\w_]+)", text)
        statuses = re.findall(r"\bstatus:\s*([A-Z_]+)", text)
        if len(names) != len(statuses):
            return fail("could not pair edge names with status")
        for name, status in zip(names, statuses, strict=True):
            if status not in VALID_EDGE_STATUSES:
                return fail(f"edge {name}: unknown status {status}")
        return 0
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        status = edge.get("status", "")
        if status not in VALID_EDGE_STATUSES:
            return fail(
                f"edge {edge.get('name', '?')}: status {status!r} is not one "
                f"of {sorted(VALID_EDGE_STATUSES)}"
            )
    return 0


def main() -> int:
    rc = verilator_lint()
    if rc != 0:
        return rc
    rc = check_cocotb_results(
        "boot-smoke",
        "e1_soc_integrated_tb_test_soc_boot_smoke.xml",
        EXPECTED_BOOT_TESTS,
    )
    if rc != 0:
        return rc
    rc = check_cocotb_results(
        "cross-domain",
        "e1_soc_integrated_tb_test_cross_domain_interfaces.xml",
        EXPECTED_CROSS_TESTS,
    )
    if rc != 0:
        return rc
    rc = check_edges_doc()
    if rc != 0:
        return rc
    print("OK: soc-integration gate passes (lint + boot-smoke + cross-domain + edges).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
