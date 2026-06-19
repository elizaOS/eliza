`timescale 1ns/1ps

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
    localparam int unsigned NUM_BIG_CORES    = 1;
    localparam int unsigned NUM_MID_CORES    = 3;
    localparam int unsigned NUM_LITTLE_CORES = 4;
    localparam int unsigned NUM_CORES        = NUM_BIG_CORES + NUM_MID_CORES + NUM_LITTLE_CORES;

    localparam int unsigned NUM_MGMT_HARTS   = 1;

    // ------------------------------------------------------------------
    // Canonical CPU-cluster AXI4 master geometry
    // (docs/arch/ooo-cluster.md, rtl/cpu/cluster/e1_cluster_top.sv).
    // AXI_ADDR_W is the 64-bit RISC-V VA/PA carrier on the per-core master
    // ports. SOC_PHYS_ADDR_W is the narrowed post-translation physical
    // address used downstream in the SoC-top fabric.
    // ------------------------------------------------------------------
    localparam int unsigned AXI_ADDR_W      = 64;
    localparam int unsigned AXI_DATA_W      = 128;
    localparam int unsigned AXI_ID_W        = 8;
    localparam int unsigned SOC_PHYS_ADDR_W = 40;

endpackage : e1_topology_pkg
