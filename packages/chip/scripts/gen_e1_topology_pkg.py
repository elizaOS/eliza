#!/usr/bin/env python3
"""Generate ``rtl/top/e1_topology_pkg.sv`` from the nameplate source of truth.

Emits SystemVerilog ``localparam`` constants for the CPU core counts and the
canonical CPU-cluster AXI master geometry from
``docs/spec-db/chip-topology.yaml``. This is the RTL-side projection of the
single nameplate so SoC top and the cluster wrapper can ``import
e1_topology_pkg::*`` instead of re-declaring literals.

Run with ``--check`` to fail closed if the committed ``.sv`` is out of sync
with the YAML (used by the consistency / docs gates and CI).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from spec_db_models import ChipTopology, load_chip_topology

ROOT = Path(__file__).resolve().parents[1]
PKG_OUT = ROOT / "rtl/top/e1_topology_pkg.sv"


def render_package(topo: ChipTopology) -> str:
    cpu = topo.cpu
    fab = topo.fabric
    return f"""`timescale 1ns/1ps

// e1_topology_pkg
//
// GENERATED FILE — do not hand-edit.
// Source of truth: docs/spec-db/chip-topology.yaml (eliza.chip_topology.v1).
// Regenerate:      python3 scripts/gen_e1_topology_pkg.py
// Sync gate:       python3 scripts/gen_e1_topology_pkg.py --check
//
// RTL-side projection of the chip nameplate. SoC top and the CPU cluster
// wrapper import these constants instead of re-declaring core-count and AXI
// geometry literals (which previously drifted: see E1_SOTA_TAPEOUT_DOSSIER
// section 6). Keep self-contained: no upstream package imports.

package e1_topology_pkg;

    // ------------------------------------------------------------------
    // CPU application-hart topology (1 + 3 + 4 nameplate).
    // The always-on Ibex management/security hart is NOT counted in
    // NUM_CORES; it is a separate boot/RoT island.
    // ------------------------------------------------------------------
    localparam int unsigned NUM_BIG_CORES    = {cpu.big_cores};
    localparam int unsigned NUM_MID_CORES    = {cpu.mid_cores};
    localparam int unsigned NUM_LITTLE_CORES = {cpu.little_cores};
    localparam int unsigned NUM_CORES        = NUM_BIG_CORES + NUM_MID_CORES + NUM_LITTLE_CORES;

    localparam int unsigned NUM_MGMT_HARTS   = {cpu.management_security_harts};

    // ------------------------------------------------------------------
    // Canonical CPU-cluster AXI4 master geometry
    // (docs/arch/ooo-cluster.md, rtl/cpu/cluster/e1_cluster_top.sv).
    // AXI_ADDR_W is the 64-bit RISC-V VA/PA carrier on the per-core master
    // ports. SOC_PHYS_ADDR_W is the narrowed post-translation physical
    // address used downstream in the SoC-top fabric.
    // ------------------------------------------------------------------
    localparam int unsigned AXI_ADDR_W      = {fab.axi_addr_w};
    localparam int unsigned AXI_DATA_W      = {fab.axi_data_w};
    localparam int unsigned AXI_ID_W        = {fab.axi_id_w};
    localparam int unsigned SOC_PHYS_ADDR_W = {fab.soc_phys_addr_w};

endpackage : e1_topology_pkg
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail closed if the committed .sv is out of sync with the YAML",
    )
    args = parser.parse_args()

    topo = load_chip_topology()
    rendered = render_package(topo)

    if args.check:
        if not PKG_OUT.exists():
            print(f"STATUS: FAIL {PKG_OUT.relative_to(ROOT)} missing; run gen_e1_topology_pkg.py")
            return 1
        current = PKG_OUT.read_text(encoding="utf-8")
        if current != rendered:
            print(
                f"STATUS: FAIL {PKG_OUT.relative_to(ROOT)} out of sync with "
                "docs/spec-db/chip-topology.yaml; regenerate with "
                "python3 scripts/gen_e1_topology_pkg.py"
            )
            return 1
        print(f"STATUS: PASS {PKG_OUT.relative_to(ROOT)} in sync with chip-topology.yaml")
        return 0

    PKG_OUT.parent.mkdir(parents=True, exist_ok=True)
    PKG_OUT.write_text(rendered, encoding="utf-8")
    print(f"wrote {PKG_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
