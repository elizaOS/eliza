`timescale 1ns/1ps

// e1_soc_integrated
//
// Integrated 2028 phone-class SoC top.  This is the magnum-opus structural
// integration of the eight domain agent deliverables under `rtl/cpu/`,
// `rtl/cache/`, `rtl/interconnect/`, `rtl/iommu/`, `rtl/memory/`,
// `rtl/power/`, and the existing peripherals.  The boot-vector path through
// the original v0 top (`e1_chip_top` + `e1_soc_top`) is intentionally kept
// runnable in parallel.  This file does NOT replace v0; it is a new top
// that demonstrates the cross-domain interfaces wire up at the
// SystemVerilog level.
//
// What this top proves (per docs/arch/soc-integration.md):
//
//   - BPU `bpu_top` produces `pmu_event_e` strobes that are remapped via
//     `bpu_to_zihpm_remap` and consumed by `zihpm` as a 256-bit event bus.
//     Prediction-time and delayed vector redirect lanes are exposed at the
//     SoC boundary so widened fetch-control consumers can be wired without
//     reopening this top.
//     The ordered two-lane fetch-control stream is also exposed with a ready
//     signal, so target-block lane-1 predictions can backpressure FTQ pop
//     instead of being observation-only.
//     An optional fetch-stream-to-L1I-demand bridge exposes lane-0/lane-1 IFU
//     demand ports at the SoC boundary, including FTQ/segment/kind provenance,
//     so downstream cache wrappers can wire the widened L1I miss path directly.
//   - BPU FTQ entry pop is translated via `ftq_to_l1i_shim` to the L1I
//     prefetch contract (`e1_ftq_to_l1i_pkg::ftq_prefetch_req_t`).  The
//     prefetch port is exposed on the SoC boundary so downstream cache RTL
//     can be slotted in without re-wiring the BPU.
//   - The CPU cluster (`e1_cluster_top` in lite tie-off mode) presents
//     eight AXI4 master interfaces.  This top routes them through the
//     production AXI4 fabric `e1_axi4_interconnect`.
//   - A single SLC slice (`e1_slc`, 64 KB / 4-way / 2-bank) drives line
//     transactions through the `e1_slc_to_chi_line_shim` adapter into
//     the `e1_chi_to_axi4_bridge` request side; the bridge issues AXI4
//     bursts on fabric master[0].  An MMIO fixture at 0x1008_0000 lets
//     cocotb trigger a single line read / write so the CHI → AXI4 →
//     DRAM-ctrl path traverses end-to-end.
//   - Non-coherent masters (NPU, DMA, display) sit behind
//     `e1_riscv_iommu`, which produces a single translated AXI4 master
//     that the fabric routes alongside the CPU and CHI bridge masters.
//   - `e1_dram_ctrl` (controller side) wraps `e1_axi4_dram_model`
//     (behavioural DRAM) so the AXI4 fabric terminates in deterministic
//     storage that the cocotb integration tests can read back.
//   - `pmc_top` (Ibex on AON, mailbox + droop + AVFS telemetry) is
//     instantiated and the mailbox is exposed as a memory-mapped peripheral
//     to a CPU-class master.  Droop/AVFS rail sensors are tied off; the
//     real droop/clock-stretcher/dLDO RTL stays per `rtl/power/`.
//   - The legacy MMIO peripherals (bootrom, peripherals, dma, npu, display,
//     weight-buffer SRAM, CLINT) remain reachable via the existing
//     AXI-Lite scaffold so the cocotb boot-smoke can drive the same MMIO
//     window the v0 path uses.
//
// What this top does NOT prove (BLOCKED per docs/evidence/integration):
//
//   - Real CPU execution — the cluster is in lite tie-off mode; the BPU is
//     a directly-driven verification surface, not driven by a fetched
//     instruction stream.  Linux boot, SPEC, GB6, etc. are BLOCKED until
//     the cluster gets a real big/mid/little core wrapper.
//   - True coherent MESI traffic — the TL-C/CHI bridge is exercised as a
//     functional translator; the L1/L2/L3/SLC cores are not instantiated
//     in this top (their port-counts exceed what a single integration test
//     surface can drive deterministically).  Cache coherence remains tested
//     under `verify/cocotb/cache/`.
//   - Real PHY traffic — `e1_dram_ctrl` north side is AXI4; the south DFI
//     5.0 PHY is BLOCKED under docs/evidence/memory/lpddr-phy-procurement.
//   - Any IPC / GB6 / MLPerf number.  Those gates remain failing-closed
//     until silicon.
//
// Boot-smoke surface (cocotb test_soc_boot_smoke.py):
//   The integration top exposes the same 32-bit MMIO debug aperture as
//   `e1_soc_top`.  The boot ROM, peripherals (uart/timer/GPIO), DMA, NPU,
//   display, CLINT, and weight-buffer SRAM remain reachable so that the
//   end-to-end "reset -> bootrom fetch -> MMIO write -> IRQ" smoke test
//   can run without instantiating a real CPU.  This is the same scaffold
//   as v0; the additional cross-domain ports surface the new cross-domain
//   evidence.

module e1_soc_integrated
    import e1_soc_pkg::*;
    import e1_axi4_pkg::*;
    import e1_ftq_to_l1i_pkg::*;
    import e1_lsu_to_l1d_pkg::*;
    import e1_cache_pkg::*;
    import bpu_pkg::*;
    import zihpm_pkg::*;
    import power_pkg::*;
(
    input  logic        clk,
    input  logic        clk_aon,
    input  logic        clk_sample,
    input  logic        rst_n,

    // Same debug MMIO aperture as e1_soc_top so the existing v0 cocotb
    // smoke flow can hit the integrated top with no edits.
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,
    output logic [31:0] mmio_rdata,
    output logic        mmio_ready,

    // Peripheral IRQs (timer, dma, npu, vsync) and CLINT software/timer
    output logic        irq_timer,
    output logic        irq_dma,
    output logic        irq_npu,
    output logic        irq_vsync,
    output logic        msip_o,
    output logic        mtip_o,
    output logic [7:0]  gpio_out,

    // BPU lookup / resolve surface (one core, exposed at the SoC boundary
    // so an integration test can drive it deterministically).
    input  logic                lkp_valid_i,
    input  logic [VADDR_W-1:0]  lkp_pc_i,
    output logic                pred_valid_o,
    output logic [MAX_BR_PER_BLOCK-1:0] pred_redirect_valid_o,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] pred_redirect_pc_o,
    input  bpu_resolve_t        resolve_i,
    input  logic                fetch_pop_i,
    output logic                fetch_valid_o,
    input  logic                fetch_stream_ready_i,
    output logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_valid_o,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] fetch_stream_pc_o,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] fetch_stream_target_pc_o,
    output logic [MAX_BR_PER_BLOCK-1:0][FTQ_IDX_W-1:0] fetch_stream_ftq_idx_o,
    output logic [MAX_BR_PER_BLOCK-1:0][$clog2(MAX_BR_PER_BLOCK)-1:0]
        fetch_stream_segment_idx_o,
    output logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_taken_o,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] fetch_stream_kind_o,
    input  logic                l1i_demand_enable_i,
    output logic                l1i_demand_valid_o,
    input  logic                l1i_demand_ready_i,
    output logic [39:0]         l1i_demand_paddr_o,
    output logic [FTQ_IDX_W-1:0] l1i_demand_ftq_idx_o,
    output logic [$clog2(MAX_BR_PER_BLOCK)-1:0] l1i_demand_segment_idx_o,
    output logic [2:0]          l1i_demand_kind_o,
    output logic                l1i_demand_valid_lane1_o,
    input  logic                l1i_demand_ready_lane1_i,
    output logic [39:0]         l1i_demand_paddr_lane1_o,
    output logic [FTQ_IDX_W-1:0] l1i_demand_ftq_idx_lane1_o,
    output logic [$clog2(MAX_BR_PER_BLOCK)-1:0] l1i_demand_segment_idx_lane1_o,
    output logic [2:0]          l1i_demand_kind_lane1_o,
    output logic [2:0]          l1i_demand_occupancy_o,
    output logic                l1i_demand_overflow_o,
    output logic                late_redirect_valid_o,
    output logic [VADDR_W-1:0]  late_redirect_pc_o,
    output logic [FTQ_IDX_W-1:0] late_redirect_ftq_idx_o,
    output logic [MAX_BR_PER_BLOCK-1:0] late_redirect_valid_lanes_o,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] late_redirect_pc_lanes_o,
    output logic [MAX_BR_PER_BLOCK-1:0][FTQ_IDX_W-1:0] late_redirect_ftq_idx_lanes_o,

    // L1I prefetch request emitted by the BPU FTQ shim — cocotb integration
    // test verifies these bits track the BPU's resolved targets.
    output ftq_prefetch_req_t   l1i_prefetch_req_o,
    output logic                l1i_prefetch_valid_o,
    output logic                l1i_prefetch_flush_o,
    output logic                l1i_cache_resp_valid_o,
    output logic                l1i_cache_resp_valid_lane1_o,
    output logic                l1i_cache_miss_valid_o,
    output logic                l1i_cache_miss_valid_lane1_o,
    output logic                l1i_l2_acq_valid_o,
    output logic                l1i_l2_active_lane1_o,
    output logic                l2_l3_acq_valid_o,
    output logic                l2_l3_grant_valid_o,

    // Zihpm read port exposed so the integration test can verify the
    // remapped event bus actually increments counters when the BPU fires
    // PMU strobes.
    input  logic        zihpm_csr_we_i,
    input  logic [11:0] zihpm_csr_addr_i,
    input  logic [63:0] zihpm_csr_wdata_i,
    input  logic [11:0] zihpm_csr_raddr_i,
    output logic [63:0] zihpm_csr_rdata_o,
    output logic        zihpm_csr_rvalid_o,
    input  logic        zihpm_instret_pulse_i,

    // PMC mailbox observability — the integration test routes mailbox
    // writes from the MMIO aperture through to here for the PMC↔CPU
    // mailbox interface check.
    output logic        pmc_wake_irq_o,
    output logic        pmc_thermal_irq_o,

    // IOMMU fault telemetry — surfaced so the cross-domain test can verify
    // an unmapped DMA hits a non-zero fault count.
    output logic        iommu_fault_irq_o,
    output logic [31:0] iommu_fault_count_o,

    // CVA6 slot-0 AXI4 traffic counters — surfaced only when the SoC is
    // compiled with `+define+E1_CLUSTER_SLOT0_CVA6`.  When that define is
    // not set the wrapper synthesises to a stub that drives the counters
    // to zero so the SoC harness can read the ports unconditionally.  The
    // counters increment per-handshake at the 128-bit downstream side of
    // the CVA6 → width-converter → cluster slot-0 path, so they measure
    // the end-to-end traffic that reaches the slot-0 receiver (in
    // contrast to the standalone wrapper TB which counts at the 64-bit
    // upstream side).  The cocotb in-band SoC boot test
    // (`test_cva6_boots_in_soc.py`) uses these counters as structural
    // proof that CVA6 came out of reset, fetched code from the slot-0
    // boot ROM, and executed the store/load program through the SoC
    // fabric path.
    output logic [31:0] cva6_slot0_ar_xfers_o,
    output logic [31:0] cva6_slot0_aw_xfers_o,
    output logic [31:0] cva6_slot0_w_xfers_o,
    output logic [31:0] cva6_slot0_r_xfers_o,
    output logic [31:0] cva6_slot0_b_xfers_o,
    // First three 128-bit boot-ROM words mirrored for cocotb preload
    // verification.  Same role as `boot_rom_word{0,1,2}_o` in the
    // standalone `e1_cva6_unit_tb`: Verilator's GPI does not always
    // surface every element of an unpacked logic array, so we re-export
    // the words the cocotb test cares about as flat ports.
    output logic [127:0] cva6_slot0_rom_word0_o,
    output logic [127:0] cva6_slot0_rom_word1_o,
    output logic [127:0] cva6_slot0_rom_word2_o
);

    // ----------------------------------------------------------------------
    // Local parameters mirroring the production geometry (see docs/arch).
    //
    // AXI_ADDR_W / AXI_ID_W here are the *downstream-narrowed* SoC-fabric
    // geometry, not the cluster master geometry: AXI_ADDR_W mirrors the
    // nameplate SOC_PHYS_ADDR_W (40-bit post-translation PA) and AXI_ID_W is
    // the narrowed fabric ID. AXI_DATA_W (128) matches the nameplate fabric
    // width. NUM_CPU_CORES is sourced from the generated nameplate package
    // (e1_topology_pkg::NUM_CORES = NUM_BIG + NUM_MID + NUM_LITTLE) instead of
    // a hard literal so the cluster instance can never silently drift from
    // docs/spec-db/chip-topology.yaml.
    // ----------------------------------------------------------------------
    localparam int unsigned AXI_ADDR_W       = e1_topology_pkg::SOC_PHYS_ADDR_W;
    localparam int unsigned AXI_DATA_W       = 128;
    localparam int unsigned AXI_ID_W         = 4;
    localparam int unsigned AXI_USER_W       = 8;
    localparam int unsigned BURST_LEN_W      = 8;
    localparam int unsigned NUM_CPU_CORES    = e1_topology_pkg::NUM_CORES;
    // Fabric masters:
    //   0..0 : CHI->AXI4 bridge (CPU-side cache miss south boundary)
    //   1..1 : IOMMU translated master (NPU/DMA/display)
    localparam int unsigned FABRIC_MASTERS   = 2;
    // Fabric slaves:
    //   0 : DRAM controller
    //   1..3 : Decode-err sentinels (UNMAP — never matched).  We carry
    //          NUM_SLAVES=4 to align with the burst-fabric default array
    //          shape; only slot 0 is mapped.
    localparam int unsigned FABRIC_SLAVES    = 4;

    // ----------------------------------------------------------------------
    // V0 MMIO scaffold — keep the existing peripherals reachable through the
    // 32-bit debug aperture.  This is exactly the same wiring as
    // `e1_soc_top`; the additional cross-domain interfaces are layered on
    // top.  Anything that the v0 smoke exercises continues to work.
    //
    // DRAM_WORDS / DRAM_INDEX_BITS, the bring-up CLINT, the common MMIO
    // decode, and the behavioural scratch-DRAM are the same shared blocks
    // e1_soc_top uses (e1_soc_pkg / e1_mmio_decode / e1_clint /
    // e1_behavioral_dram); only the extra cross-domain selects below are
    // local to this top.
    // ----------------------------------------------------------------------
    logic [31:0] bootrom_rdata;
    logic [31:0] dma_rdata;
    logic [31:0] npu_rdata;
    logic [31:0] display_rdata;
    logic [31:0] periph_rdata;
    logic [31:0] clint_rdata;
    logic [31:0] pmc_mbox_rdata;
    logic [31:0] wbuf_rdata;
    logic [31:0] iommu_aper_rdata;
    logic [31:0] iommu_dma_rdata;
    logic [31:0] slc_aper_rdata;

    // DMA → MMIO DRAM master (AXI-Lite)
    logic        dma_m_awvalid;
    logic        dma_m_awready;
    logic [31:0] dma_m_awaddr;
    logic        dma_m_wvalid;
    logic        dma_m_wready;
    logic [31:0] dma_m_wdata;
    logic [3:0]  dma_m_wstrb;
    logic        dma_m_bvalid;
    logic        dma_m_bready;
    logic [1:0]  dma_m_bresp;
    logic        dma_m_arvalid;
    logic        dma_m_arready;
    logic [31:0] dma_m_araddr;
    logic        dma_m_rvalid;
    logic        dma_m_rready;
    logic [31:0] dma_m_rdata;
    logic [1:0]  dma_m_rresp;

    // NPU → MMIO DRAM master (AXI-Lite)
    logic        npu_m_awvalid;
    logic        npu_m_awready;
    logic [31:0] npu_m_awaddr;
    logic        npu_m_wvalid;
    logic        npu_m_wready;
    logic [31:0] npu_m_wdata;
    logic [3:0]  npu_m_wstrb;
    logic        npu_m_bvalid;
    logic        npu_m_bready;
    logic [1:0]  npu_m_bresp;
    logic        npu_m_arvalid;
    logic        npu_m_arready;
    logic [31:0] npu_m_araddr;
    logic        npu_m_rvalid;
    logic        npu_m_rready;
    logic [31:0] npu_m_rdata;
    logic [1:0]  npu_m_rresp;

    // Display framebuffer read port
    logic        display_scan_hsync;
    logic        display_scan_vsync;
    logic        display_scan_active;
    logic [15:0] display_scan_x;
    logic [15:0] display_scan_y;
    logic [31:0] display_scan_fb_addr;
    logic [23:0] display_scan_rgb;
    logic        display_fb_read_valid;
    logic [31:0] display_fb_read_addr;
    logic [31:0] display_fb_read_data;
    logic        display_fb_read_ready;

    // MMIO decode
    logic bootrom_sel;
    logic dma_sel;
    logic npu_sel;
    logic display_sel;
    logic periph_sel;
    logic dram_sel;
    logic clint_sel;
    logic wbuf_sel;
    logic pmc_sel;
    // IOMMU MMIO register window @ 0x1006_0000 (4 KiB, 64-bit registers
    // mirrored at consecutive 32-bit MMIO words).  Documented in
    // docs/arch/soc-integration.md.
    logic iommu_sel;
    // IOMMU DMA fixture trigger @ 0x1007_0000 (256 B).  A small set of
    // registers that drive a single AXI4 master into the IOMMU upstream
    // port[0], so the cocotb integration test can exercise the
    // unauthorised-IOVA fault path.
    logic iommu_dma_sel;
    // SLC fixture trigger @ 0x1008_0000 (256 B).  Drives a single SLC
    // client request through the line shim and CHI bridge so the cocotb
    // integration test can exercise the CHI→AXI4 path.
    logic slc_sel;
    logic word_aligned;
    logic implemented_window;

    // Behavioural scratch DRAM read-data for the CPU/debug MMIO window. The
    // backing array now lives in the shared e1_behavioral_dram instance below;
    // this stays the v0 path while the burst-capable AXI4 fabric sits
    // alongside, terminating in `u_dram_model` and exercised by the
    // cross-domain test.
    logic [31:0] mmio_dram_rdata;
    logic [63:0] clint_mtime;
    logic [63:0] clint_mtimecmp;

    // Common MMIO decode (rtl/peripherals/e1_mmio_decode.sv); the extra
    // cross-domain selects below are local to the integrated top.
    e1_mmio_decode u_mmio_decode (
        .mmio_addr          (mmio_addr),
        .word_aligned       (word_aligned),
        .implemented_window (implemented_window),
        .bootrom_sel        (bootrom_sel),
        .periph_sel         (periph_sel),
        .dma_sel            (dma_sel),
        .npu_sel            (npu_sel),
        .display_sel        (display_sel),
        .wbuf_sel           (wbuf_sel),
        .clint_sel          (clint_sel),
        .dram_sel           (dram_sel)
    );

    // PMC mailbox window: 0x1005_0000 (4 KiB, AHB-Lite-equivalent).
    // Documented in docs/arch/soc-integration.md.
    assign pmc_sel     = word_aligned && mmio_addr[31:12] == 20'h1005_0;
    assign iommu_sel   = word_aligned && mmio_addr[31:12] == 20'h1006_0;
    assign iommu_dma_sel = implemented_window && mmio_addr[31:12] == 20'h1007_0;
    assign slc_sel     = implemented_window && mmio_addr[31:12] == 20'h1008_0;

    assign mtip_o = clint_mtime >= clint_mtimecmp;

    // Shared bring-up CLINT (rtl/peripherals/e1_clint.sv).
    e1_clint u_clint (
        .clk            (clk),
        .rst_n          (rst_n),
        .mmio_valid     (mmio_valid),
        .mmio_write     (mmio_write),
        .mmio_word_addr (mmio_addr[15:2]),
        .mmio_wdata     (mmio_wdata),
        .sel_i          (clint_sel),
        .clint_rdata    (clint_rdata),
        .msip_o         (msip_o),
        .mtime_o        (clint_mtime),
        .mtimecmp_o     (clint_mtimecmp)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_display_scanout;
    assign unused_display_scanout = ^{
        display_scan_hsync,
        display_scan_vsync,
        display_scan_active,
        display_scan_x,
        display_scan_y,
        display_scan_fb_addr,
        display_scan_rgb
    };
    /* verilator lint_on UNUSEDSIGNAL */

    // Shared behavioural scratch-DRAM model (rtl/memory/e1_behavioral_dram.sv);
    // identical instance to e1_soc_top's. Backs the DMA / NPU AXI-Lite masters,
    // the display framebuffer read port, and the CPU/debug MMIO DRAM window.
    e1_behavioral_dram u_behavioral_dram (
        .clk                   (clk),
        .rst_n                 (rst_n),
        .mmio_valid            (mmio_valid),
        .mmio_write            (mmio_write),
        .mmio_addr             (mmio_addr),
        .mmio_wdata            (mmio_wdata),
        .dram_sel              (dram_sel),
        .mmio_dram_rdata       (mmio_dram_rdata),
        .dma_m_awvalid         (dma_m_awvalid),
        .dma_m_awready         (dma_m_awready),
        .dma_m_awaddr          (dma_m_awaddr),
        .dma_m_wvalid          (dma_m_wvalid),
        .dma_m_wready          (dma_m_wready),
        .dma_m_wdata           (dma_m_wdata),
        .dma_m_wstrb           (dma_m_wstrb),
        .dma_m_bvalid          (dma_m_bvalid),
        .dma_m_bready          (dma_m_bready),
        .dma_m_bresp           (dma_m_bresp),
        .dma_m_arvalid         (dma_m_arvalid),
        .dma_m_arready         (dma_m_arready),
        .dma_m_araddr          (dma_m_araddr),
        .dma_m_rvalid          (dma_m_rvalid),
        .dma_m_rready          (dma_m_rready),
        .dma_m_rdata           (dma_m_rdata),
        .dma_m_rresp           (dma_m_rresp),
        .npu_m_awvalid         (npu_m_awvalid),
        .npu_m_awready         (npu_m_awready),
        .npu_m_awaddr          (npu_m_awaddr),
        .npu_m_wvalid          (npu_m_wvalid),
        .npu_m_wready          (npu_m_wready),
        .npu_m_wdata           (npu_m_wdata),
        .npu_m_wstrb           (npu_m_wstrb),
        .npu_m_bvalid          (npu_m_bvalid),
        .npu_m_bready          (npu_m_bready),
        .npu_m_bresp           (npu_m_bresp),
        .npu_m_arvalid         (npu_m_arvalid),
        .npu_m_arready         (npu_m_arready),
        .npu_m_araddr          (npu_m_araddr),
        .npu_m_rvalid          (npu_m_rvalid),
        .npu_m_rready          (npu_m_rready),
        .npu_m_rdata           (npu_m_rdata),
        .npu_m_rresp           (npu_m_rresp),
        .display_fb_read_valid (display_fb_read_valid),
        .display_fb_read_addr  (display_fb_read_addr),
        .display_fb_read_data  (display_fb_read_data),
        .display_fb_read_ready (display_fb_read_ready)
    );

    // ----------------------------------------------------------------------
    // BPU + FTQ shim + Zihpm event-bus remap.
    //
    // Cross-domain wires:
    //
    //     bpu_top.pmu_strb  --(name+id remap)-->  bpu_to_zihpm_remap  -->
    //         zihpm.event_bus_i (slot ids match `zihpm_pkg::hpm_event_e`)
    //
    //     bpu_top.fetch_entry --(serialized)--> ftq_to_l1i_shim -->
    //         L1I prefetch port (out of this top, into cache RTL)
    //
    // Both shim and remap are owned by the BPU/CSR domain agents; this top
    // wires them and exposes the L1I prefetch and Zihpm CSR ports at the
    // SoC boundary so a single cocotb integration test can drive them.
    // ----------------------------------------------------------------------
    bpu_lookup_t  bpu_pred;
    ftq_entry_t   bpu_fetch_entry;
    logic [PMU_EVENTS-1:0] bpu_pmu_strb;
    logic [MAX_BR_PER_BLOCK-1:0][2:0] bpu_pred_redirect_kind;
    logic [255:0]          bpu_remapped_evbus;
    bpu_context_t          bpu_default_context_w;
    bpu_flush_t            bpu_predictor_flush_w;
    logic                  bpu_fetch_accept_w;
    logic                  l1i_demand_fetch_stream_ready_w;
    logic                  l1i_cache_ifu_req_ready_w;
    logic                  l1i_cache_ifu_req_ready_lane1_w;
    logic                  l1i_cache_ftq_req_ready_w;
    logic                  l1i_demand_ready_w;
    logic                  l1i_demand_ready_lane1_w;

    assign bpu_default_context_w = bpu_default_context();
    assign bpu_predictor_flush_w = '0;
    assign bpu_fetch_accept_w = fetch_pop_i && fetch_stream_ready_i &&
                                l1i_demand_fetch_stream_ready_w;
    assign l1i_demand_ready_w = l1i_demand_ready_i && l1i_cache_ifu_req_ready_w;
    assign l1i_demand_ready_lane1_w =
        l1i_demand_ready_lane1_i && l1i_cache_ifu_req_ready_lane1_w;

    // BPU CSR read tap (unused at this top, but documented for the wave
    // viewer). Tied off; the integration test reads counters via the Zihpm
    // CSR interface.
    /* verilator lint_off UNUSEDSIGNAL */
    logic [63:0] bpu_csr_rdata_unused;
    /* verilator lint_on UNUSEDSIGNAL */

    bpu_top u_bpu (
        .clk         (clk),
        .rst_n       (rst_n),
        .lkp_valid   (lkp_valid_i),
        .lkp_pc      (lkp_pc_i),
        .lkp_context (bpu_default_context_w),
        .pred_valid  (pred_valid_o),
        .pred        (bpu_pred),
        .pred_redirect_valid(pred_redirect_valid_o),
        .pred_redirect_pc(pred_redirect_pc_o),
        .pred_redirect_kind(bpu_pred_redirect_kind),
        .fetch_pop   (bpu_fetch_accept_w),
        .fetch_valid (fetch_valid_o),
        .fetch_entry (bpu_fetch_entry),
        .late_redirect_valid(late_redirect_valid_o),
        .late_redirect_pc(late_redirect_pc_o),
        .late_redirect_ftq_idx(late_redirect_ftq_idx_o),
        .late_redirect_valid_lanes(late_redirect_valid_lanes_o),
        .late_redirect_pc_lanes(late_redirect_pc_lanes_o),
        .late_redirect_ftq_idx_lanes(late_redirect_ftq_idx_lanes_o),
        .resolve     (resolve_i),
        .predictor_flush(bpu_predictor_flush_w),
        .csr_re      (1'b0),
        .csr_addr    (5'h0),
        .csr_rdata   (bpu_csr_rdata_unused),
        .pmu_strb    (bpu_pmu_strb)
    );

    ftq_to_fetch_stream u_ftq_fetch_stream (
        .clk                     (clk),
        .rst_n                   (rst_n),
        .pred_valid              (pred_valid_o),
        .pred                    (bpu_pred),
        .pred_redirect_valid     (pred_redirect_valid_o),
        .pred_redirect_pc        (pred_redirect_pc_o),
        .pred_redirect_kind      (bpu_pred_redirect_kind),
        .fetch_entry_valid       (fetch_valid_o),
        .fetch_entry             (bpu_fetch_entry),
        .fetch_accept            (bpu_fetch_accept_w),
        .flush_valid             (resolve_i.valid && resolve_i.misprediction),
        .fetch_stream_valid_o    (fetch_stream_valid_o),
        .fetch_stream_pc_o       (fetch_stream_pc_o),
        .fetch_stream_target_pc_o(fetch_stream_target_pc_o),
        .fetch_stream_ftq_idx_o  (fetch_stream_ftq_idx_o),
        .fetch_stream_segment_idx_o(fetch_stream_segment_idx_o),
        .fetch_stream_taken_o    (fetch_stream_taken_o),
        .fetch_stream_kind_o     (fetch_stream_kind_o)
    );

    fetch_stream_to_l1i_demand #(
        .PADDR_W(40),
        .QUEUE_DEPTH(4)
    ) u_fetch_stream_l1i_demand (
        .clk                   (clk),
        .rst_n                 (rst_n),
        .enable                (l1i_demand_enable_i),
        .flush_valid           (resolve_i.valid && resolve_i.misprediction),
        .fetch_stream_valid    (fetch_stream_valid_o),
        .fetch_stream_target_pc(fetch_stream_target_pc_o),
        .fetch_stream_ftq_idx  (fetch_stream_ftq_idx_o),
        .fetch_stream_segment_idx(fetch_stream_segment_idx_o),
        .fetch_stream_taken    (fetch_stream_taken_o),
        .fetch_stream_kind     (fetch_stream_kind_o),
        .fetch_stream_accept   (bpu_fetch_accept_w),
        .fetch_stream_ready    (l1i_demand_fetch_stream_ready_w),
        .ifu_req_valid         (l1i_demand_valid_o),
        .ifu_req_ready         (l1i_demand_ready_w),
        .ifu_req_paddr         (l1i_demand_paddr_o),
        .ifu_req_ftq_idx       (l1i_demand_ftq_idx_o),
        .ifu_req_segment_idx   (l1i_demand_segment_idx_o),
        .ifu_req_kind          (l1i_demand_kind_o),
        .ifu_req_valid_lane1   (l1i_demand_valid_lane1_o),
        .ifu_req_ready_lane1   (l1i_demand_ready_lane1_w),
        .ifu_req_paddr_lane1   (l1i_demand_paddr_lane1_o),
        .ifu_req_ftq_idx_lane1 (l1i_demand_ftq_idx_lane1_o),
        .ifu_req_segment_idx_lane1(l1i_demand_segment_idx_lane1_o),
        .ifu_req_kind_lane1    (l1i_demand_kind_lane1_o),
        .queue_occupancy       (l1i_demand_occupancy_o),
        .queue_overflow        (l1i_demand_overflow_o)
    );

    // bpu_pred fields are observable in waves but not otherwise consumed at
    // this top because the integration test treats the BPU as a stand-alone
    // domain driver. Avoid lint warnings.
    /* verilator lint_off UNUSEDSIGNAL */
    bpu_lookup_t bpu_pred_unused;
    assign bpu_pred_unused = bpu_pred;
    /* verilator lint_on UNUSEDSIGNAL */

    bpu_to_zihpm_remap u_bpu_remap (
        .bpu_strobes_i (bpu_pmu_strb),
        .zihpm_evbus_o (bpu_remapped_evbus)
    );

    // FTQ → L1I shim. The shim serializes multi-segment FTQ entries; flush
    // comes from the resolver's misprediction signal so a misprediction drops
    // any in-flight L1I prefetch.
    ftq_to_l1i_shim u_ftq_l1i (
        .clk               (clk),
        .rst_n             (rst_n),
        .fetch_entry_valid (fetch_valid_o && bpu_fetch_accept_w),
        .fetch_entry       (bpu_fetch_entry),
        .flush_valid       (resolve_i.valid && resolve_i.misprediction),
        .l1i_ready_i       (l1i_cache_ftq_req_ready_w),
        .l1i_req_o         (l1i_prefetch_req_o),
        .l1i_valid_o       (l1i_prefetch_valid_o),
        .l1i_ready_vec_i   ('0),
        .l1i_bundle_o      (),
        .l1i_flush_o       (l1i_prefetch_flush_o)
    );

    // Zihpm counter file. The integration test programs an mhpmevent CSR
    // to select a BPU strobe ID, then drives the BPU and verifies the
    // counter increments.
    zihpm #(
        .NUM_COUNTERS (13),
        .EVT_BUS_W    (256)
    ) u_zihpm (
        .clk_i              (clk),
        .rst_ni             (rst_n),
        .event_bus_i        (bpu_remapped_evbus),
        .mcountinhibit_i    (16'h0),
        .instret_pulse_i    (zihpm_instret_pulse_i),
        .csr_we_i           (zihpm_csr_we_i),
        .csr_addr_i         (zihpm_csr_addr_i),
        .csr_wdata_i        (zihpm_csr_wdata_i),
        .csr_raddr_i        (zihpm_csr_raddr_i),
        .csr_rdata_o        (zihpm_csr_rdata_o),
        .csr_rvalid_o       (zihpm_csr_rvalid_o),
        .counter_overflow_o ()
    );

    // ----------------------------------------------------------------------
    // CPU cluster.  Lite tie-off — every AXI4 master is quiet.  Production
    // cores are gated by E1_HAVE_KUNMINGHU / E1_HAVE_BOOM
    // / E1_HAVE_CVA6 inside `e1_cluster_top.sv`.  Until those defines are
    // set the cluster presents the contract interfaces only; this top
    // routes them to the AXI4 fabric so the moment a real core wrapper
    // lands, the fabric stays intact.
    // ----------------------------------------------------------------------

    // Per-core AXI4 master nets.  The cluster always drives these to safe
    // idle values in lite mode.
    logic [NUM_CPU_CORES-1:0][AXI_ID_W-1:0]    cluster_axi_aw_id;
    logic [NUM_CPU_CORES-1:0][AXI_ADDR_W-1:0]  cluster_axi_aw_addr;
    logic [NUM_CPU_CORES-1:0][7:0]             cluster_axi_aw_len;
    logic [NUM_CPU_CORES-1:0][2:0]             cluster_axi_aw_size;
    logic [NUM_CPU_CORES-1:0][1:0]             cluster_axi_aw_burst;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_aw_lock;
    logic [NUM_CPU_CORES-1:0][3:0]             cluster_axi_aw_cache;
    logic [NUM_CPU_CORES-1:0][2:0]             cluster_axi_aw_prot;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_aw_valid;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_aw_ready;
    logic [NUM_CPU_CORES-1:0][AXI_DATA_W-1:0]  cluster_axi_w_data;
    logic [NUM_CPU_CORES-1:0][AXI_DATA_W/8-1:0]cluster_axi_w_strb;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_w_last;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_w_valid;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_w_ready;
    logic [NUM_CPU_CORES-1:0][AXI_ID_W-1:0]    cluster_axi_b_id;
    logic [NUM_CPU_CORES-1:0][1:0]             cluster_axi_b_resp;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_b_valid;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_b_ready;
    logic [NUM_CPU_CORES-1:0][AXI_ID_W-1:0]    cluster_axi_ar_id;
    logic [NUM_CPU_CORES-1:0][AXI_ADDR_W-1:0]  cluster_axi_ar_addr;
    logic [NUM_CPU_CORES-1:0][7:0]             cluster_axi_ar_len;
    logic [NUM_CPU_CORES-1:0][2:0]             cluster_axi_ar_size;
    logic [NUM_CPU_CORES-1:0][1:0]             cluster_axi_ar_burst;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_ar_lock;
    logic [NUM_CPU_CORES-1:0][3:0]             cluster_axi_ar_cache;
    logic [NUM_CPU_CORES-1:0][2:0]             cluster_axi_ar_prot;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_ar_valid;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_ar_ready;
    logic [NUM_CPU_CORES-1:0][AXI_ID_W-1:0]    cluster_axi_r_id;
    logic [NUM_CPU_CORES-1:0][AXI_DATA_W-1:0]  cluster_axi_r_data;
    logic [NUM_CPU_CORES-1:0][1:0]             cluster_axi_r_resp;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_r_last;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_r_valid;
    logic [NUM_CPU_CORES-1:0]                  cluster_axi_r_ready;

    // FTQ-to-L1I per-core nets exposed by the cluster.  These remain
    // tied off until the per-core cluster wrappers ship; the integration
    // test still consumes the BPU shim output above (which is per-core)
    // via the SoC-level port to avoid coupling the test to the cluster
    // tie-off.
    ftq_prefetch_req_t [NUM_CPU_CORES-1:0]       cluster_ftq_l1i_req;
    logic              [NUM_CPU_CORES-1:0]       cluster_ftq_l1i_valid;
    logic              [NUM_CPU_CORES-1:0]       cluster_ftq_l1i_ready;
    logic              [NUM_CPU_CORES-1:0]       cluster_ftq_l1i_flush;
    lsu_l1d_req_t      [NUM_CPU_CORES-1:0][1:0]  cluster_lsu_l1d_req;
    logic              [NUM_CPU_CORES-1:0][1:0]  cluster_lsu_l1d_valid;
    lsu_l1d_resp_t     [NUM_CPU_CORES-1:0][1:0]  cluster_lsu_l1d_resp;

    // Cluster handles ready/last by tying them to safe defaults — when a
    // real core wrapper lands, these become the fabric responses.
    assign cluster_axi_aw_ready = '0;
    assign cluster_axi_w_ready  = '0;
    assign cluster_axi_b_id     = '0;
    assign cluster_axi_b_resp   = '0;
    assign cluster_axi_b_valid  = '0;
    assign cluster_axi_ar_ready = '0;
    assign cluster_axi_r_id     = '0;
    assign cluster_axi_r_data   = '0;
    assign cluster_axi_r_resp   = '0;
    assign cluster_axi_r_last   = '0;
    assign cluster_axi_r_valid  = '0;
    assign cluster_ftq_l1i_ready = {NUM_CPU_CORES{1'b1}};
    assign cluster_lsu_l1d_resp = '0;

    e1_cluster_top #(
        .NUM_BIG_CORES    (1),
        .NUM_MID_CORES    (3),
        .NUM_LITTLE_CORES (4),
        .AXI_ADDR_W       (AXI_ADDR_W),
        .AXI_DATA_W       (AXI_DATA_W),
        .AXI_ID_W         (AXI_ID_W)
    ) u_cluster (
        .core_clk_i              ({NUM_CPU_CORES{clk}}),
        .core_rst_ni             ({NUM_CPU_CORES{rst_n}}),
        .pwr_island_en_i         ({NUM_CPU_CORES{1'b1}}),
        .pwr_retention_i         ({NUM_CPU_CORES{1'b0}}),
        .core_irq_ext_i          ('0),
        .core_irq_timer_i        ('0),
        .core_irq_software_i     ('0),
        .core_debug_req_i        ('0),
        .core_hart_id_i          ('0),
        .axi_aw_id_o             (cluster_axi_aw_id),
        .axi_aw_addr_o           (cluster_axi_aw_addr),
        .axi_aw_len_o            (cluster_axi_aw_len),
        .axi_aw_size_o           (cluster_axi_aw_size),
        .axi_aw_burst_o          (cluster_axi_aw_burst),
        .axi_aw_lock_o           (cluster_axi_aw_lock),
        .axi_aw_cache_o          (cluster_axi_aw_cache),
        .axi_aw_prot_o           (cluster_axi_aw_prot),
        .axi_aw_valid_o          (cluster_axi_aw_valid),
        .axi_aw_ready_i          (cluster_axi_aw_ready),
        .axi_w_data_o            (cluster_axi_w_data),
        .axi_w_strb_o            (cluster_axi_w_strb),
        .axi_w_last_o            (cluster_axi_w_last),
        .axi_w_valid_o           (cluster_axi_w_valid),
        .axi_w_ready_i           (cluster_axi_w_ready),
        .axi_b_id_i              (cluster_axi_b_id),
        .axi_b_resp_i            (cluster_axi_b_resp),
        .axi_b_valid_i           (cluster_axi_b_valid),
        .axi_b_ready_o           (cluster_axi_b_ready),
        .axi_ar_id_o             (cluster_axi_ar_id),
        .axi_ar_addr_o           (cluster_axi_ar_addr),
        .axi_ar_len_o            (cluster_axi_ar_len),
        .axi_ar_size_o           (cluster_axi_ar_size),
        .axi_ar_burst_o          (cluster_axi_ar_burst),
        .axi_ar_lock_o           (cluster_axi_ar_lock),
        .axi_ar_cache_o          (cluster_axi_ar_cache),
        .axi_ar_prot_o           (cluster_axi_ar_prot),
        .axi_ar_valid_o          (cluster_axi_ar_valid),
        .axi_ar_ready_i          (cluster_axi_ar_ready),
        .axi_r_id_i              (cluster_axi_r_id),
        .axi_r_data_i            (cluster_axi_r_data),
        .axi_r_resp_i            (cluster_axi_r_resp),
        .axi_r_last_i            (cluster_axi_r_last),
        .axi_r_valid_i           (cluster_axi_r_valid),
        .axi_r_ready_o           (cluster_axi_r_ready),
        .ftq_l1i_req_o           (cluster_ftq_l1i_req),
        .ftq_l1i_valid_o         (cluster_ftq_l1i_valid),
        .ftq_l1i_ready_i         (cluster_ftq_l1i_ready),
        .ftq_l1i_flush_o         (cluster_ftq_l1i_flush),
        .lsu_l1d_req_o           (cluster_lsu_l1d_req),
        .lsu_l1d_valid_o         (cluster_lsu_l1d_valid),
        .lsu_l1d_resp_i          (cluster_lsu_l1d_resp),
        .cluster_qos_class_i     (QOS_CPU_LATENCY),
        .core_pc_committed_o     (),
        .core_pc_committed_valid_o (),
        .core_halted_o           (),
        .cluster_event_bus_o     ()
    );

    // Suppress lint on the cluster outputs we intentionally do not route
    // (they are quiet in lite tie-off mode).
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_cluster_outs;
    assign unused_cluster_outs = ^{
        cluster_axi_aw_id, cluster_axi_aw_addr, cluster_axi_aw_len,
        cluster_axi_aw_size, cluster_axi_aw_burst, cluster_axi_aw_lock,
        cluster_axi_aw_cache, cluster_axi_aw_prot, cluster_axi_aw_valid,
        cluster_axi_w_data, cluster_axi_w_strb, cluster_axi_w_last,
        cluster_axi_w_valid, cluster_axi_b_ready,
        cluster_axi_ar_id, cluster_axi_ar_addr, cluster_axi_ar_len,
        cluster_axi_ar_size, cluster_axi_ar_burst, cluster_axi_ar_lock,
        cluster_axi_ar_cache, cluster_axi_ar_prot, cluster_axi_ar_valid,
        cluster_axi_r_ready,
        cluster_ftq_l1i_req, cluster_ftq_l1i_valid, cluster_ftq_l1i_flush,
        cluster_lsu_l1d_req, cluster_lsu_l1d_valid
    };
    /* verilator lint_on UNUSEDSIGNAL */

    // ----------------------------------------------------------------------
    // Optional cluster slot 0 CVA6 little-core instance.
    //
    // When `+define+E1_CLUSTER_SLOT0_CVA6` is set the e1_cpu_subsystem
    // wrapper (which wraps the OpenHW Group CVA6 v5.3.0 core under
    // `+define+E1_HAVE_CVA6`) is instantiated here as a structural
    // declaration.  The wrapper's AXI4 master is currently NOT routed
    // into the cluster's slot-0 AXI ports because CVA6 issues 64-bit
    // data while the cluster's per-core port is 128-bit
    // (AXI_DATA_W=128, matching the L1D cache line port).
    //
    // The remaining gap is a 64↔128 AXI4 data-width converter; once that
    // adapter lands the slot-0 cluster signals (`cluster_axi_*[0]`) can
    // be driven from `u_cva6_slot0`'s AXI master and the integration
    // becomes truly WIRED rather than WIRED_OBSERVABILITY_ONLY.
    //
    // Until the data-width converter lands, the wrapper's master ties off
    // to a safe-idle AXI4 sink so
    // the structural instantiation elaborates cleanly under Verilator.
    // The wrapper's `dbg_pc_o` / `dbg_valid_o` are exposed via the
    // top-level testbench harness to give cocotb a structural anchor.
    // ----------------------------------------------------------------------
`ifdef E1_CLUSTER_SLOT0_CVA6
    localparam int unsigned CVA6_AXI_ID_W   = 4;
    localparam int unsigned CVA6_AXI_ADDR_W = 64;
    localparam int unsigned CVA6_AXI_DATA_W = 64;
    localparam int unsigned CVA6_AXI_USER_W = 1;

    logic [CVA6_AXI_ID_W-1:0]         cva6_ar_id;
    logic [CVA6_AXI_ADDR_W-1:0]       cva6_ar_addr;
    logic [7:0]                       cva6_ar_len;
    logic [2:0]                       cva6_ar_size;
    logic [1:0]                       cva6_ar_burst;
    logic                             cva6_ar_lock;
    logic [3:0]                       cva6_ar_cache;
    logic [2:0]                       cva6_ar_prot;
    logic [3:0]                       cva6_ar_qos;
    logic [3:0]                       cva6_ar_region;
    logic [CVA6_AXI_USER_W-1:0]       cva6_ar_user;
    logic                             cva6_ar_valid;
    logic                             cva6_r_ready;
    logic [CVA6_AXI_ID_W-1:0]         cva6_aw_id;
    logic [CVA6_AXI_ADDR_W-1:0]       cva6_aw_addr;
    logic [7:0]                       cva6_aw_len;
    logic [2:0]                       cva6_aw_size;
    logic [1:0]                       cva6_aw_burst;
    logic                             cva6_aw_lock;
    logic [3:0]                       cva6_aw_cache;
    logic [2:0]                       cva6_aw_prot;
    logic [3:0]                       cva6_aw_qos;
    logic [3:0]                       cva6_aw_region;
    logic [5:0]                       cva6_aw_atop;
    logic [CVA6_AXI_USER_W-1:0]       cva6_aw_user;
    logic                             cva6_aw_valid;
    logic [CVA6_AXI_DATA_W-1:0]       cva6_w_data;
    logic [(CVA6_AXI_DATA_W/8)-1:0]   cva6_w_strb;
    logic                             cva6_w_last;
    logic [CVA6_AXI_USER_W-1:0]       cva6_w_user;
    logic                             cva6_w_valid;
    logic                             cva6_b_ready;

    // CVA6 -> width-converter -> 128-bit slot-0 bus.
    //
    // The CVA6 wrapper exposes a 64-bit AXI4 master.  The cluster slot 0
    // per-core port is 128-bit (`AXI_DATA_W` at this top), matching the
    // L1D cache-line width.  `e1_axi4_width_converter` runs in upsize
    // mode (UPSTREAM_DATA_W=64, DOWNSTREAM_DATA_W=128, AXI4 IHI 0022
    // A8.4.1): AxLEN/AxSIZE are passed through; per-beat data is placed
    // on the byte lane selected by the address.  Read data is muxed
    // back to the upstream lane.
    //
    // The downstream 128-bit side terminates on a quiet AXI4 sink at
    // this top because the cluster's slot 0 master is itself driven by
    // `e1_cluster_top` (the cluster owns those output ports).  The
    // converter's structural presence + cocotb coverage under
    // `verify/cocotb/axi4/test_width_converter.py` establishes the
    // 64<->128 conversion path; once the cluster transitions out of
    // lite tie-off mode the 128-bit downstream nets below connect into
    // the cluster's slot-0 input ports without further adapter work.
    // CVA6's cv64a6 executable-PMA region 1 starts at 0x1_0000 (length
    // 0x10000).  The standalone wrapper TB uses the same vector; the
    // in-band SoC instance has to honour the same PMA contract because
    // the CVA6 PMA/PMP check fires before any AR is issued.  Sitting
    // outside an executable region triggers INSTR_ACCESS_FAULT before
    // the slot-0 memory ever gets a chance to serve a fetch.
    e1_cpu_subsystem #(
        .BOOT_ADDR  (64'h0000_0000_0001_0000),
        .AXI_ID_W   (CVA6_AXI_ID_W),
        .AXI_ADDR_W (CVA6_AXI_ADDR_W),
        .AXI_DATA_W (CVA6_AXI_DATA_W),
        .AXI_USER_W (CVA6_AXI_USER_W)
    ) u_cva6_slot0 (
        .clk_i         (clk),
        .rst_ni        (rst_n),
        .irq_i         (2'b00),
        .ipi_i         (1'b0),
        .time_irq_i    (1'b0),
        .debug_req_i   (1'b0),
        .axi_ar_id     (cva6_ar_id),
        .axi_ar_addr   (cva6_ar_addr),
        .axi_ar_len    (cva6_ar_len),
        .axi_ar_size   (cva6_ar_size),
        .axi_ar_burst  (cva6_ar_burst),
        .axi_ar_lock   (cva6_ar_lock),
        .axi_ar_cache  (cva6_ar_cache),
        .axi_ar_prot   (cva6_ar_prot),
        .axi_ar_qos    (cva6_ar_qos),
        .axi_ar_region (cva6_ar_region),
        .axi_ar_user   (cva6_ar_user),
        .axi_ar_valid  (cva6_ar_valid),
        .axi_ar_ready  (cva6_ar_ready_wire),
        .axi_r_id      (cva6_r_id_wire),
        .axi_r_data    (cva6_r_data_wire),
        .axi_r_resp    (cva6_r_resp_wire),
        .axi_r_last    (cva6_r_last_wire),
        .axi_r_user    (cva6_r_user_wire),
        .axi_r_valid   (cva6_r_valid_wire),
        .axi_r_ready   (cva6_r_ready),
        .axi_aw_id     (cva6_aw_id),
        .axi_aw_addr   (cva6_aw_addr),
        .axi_aw_len    (cva6_aw_len),
        .axi_aw_size   (cva6_aw_size),
        .axi_aw_burst  (cva6_aw_burst),
        .axi_aw_lock   (cva6_aw_lock),
        .axi_aw_cache  (cva6_aw_cache),
        .axi_aw_prot   (cva6_aw_prot),
        .axi_aw_qos    (cva6_aw_qos),
        .axi_aw_region (cva6_aw_region),
        .axi_aw_atop   (cva6_aw_atop),
        .axi_aw_user   (cva6_aw_user),
        .axi_aw_valid  (cva6_aw_valid),
        .axi_aw_ready  (cva6_aw_ready_wire),
        .axi_w_data    (cva6_w_data),
        .axi_w_strb    (cva6_w_strb),
        .axi_w_last    (cva6_w_last),
        .axi_w_user    (cva6_w_user),
        .axi_w_valid   (cva6_w_valid),
        .axi_w_ready   (cva6_w_ready_wire),
        .axi_b_id      (cva6_b_id_wire),
        .axi_b_resp    (cva6_b_resp_wire),
        .axi_b_user    (cva6_b_user_wire),
        .axi_b_valid   (cva6_b_valid_wire),
        .axi_b_ready   (cva6_b_ready),
        .hart_id_i     (64'h0),
        .dbg_pc_o      (),
        .dbg_valid_o   ()
    );

    // ── Converter response wires (sourced from the converter's upstream port)
    logic                             cva6_ar_ready_wire;
    logic [CVA6_AXI_ID_W-1:0]         cva6_r_id_wire;
    logic [CVA6_AXI_DATA_W-1:0]       cva6_r_data_wire;
    logic [1:0]                       cva6_r_resp_wire;
    logic                             cva6_r_last_wire;
    logic [CVA6_AXI_USER_W-1:0]       cva6_r_user_wire;
    logic                             cva6_r_valid_wire;
    logic                             cva6_aw_ready_wire;
    logic                             cva6_w_ready_wire;
    logic [CVA6_AXI_ID_W-1:0]         cva6_b_id_wire;
    logic [1:0]                       cva6_b_resp_wire;
    logic [CVA6_AXI_USER_W-1:0]       cva6_b_user_wire;
    logic                             cva6_b_valid_wire;

    // ── 128-bit downstream slot-0 AXI4 net (target shape: cluster slot 0)
    logic [CVA6_AXI_ID_W-1:0]         slot0_ar_id;
    logic [CVA6_AXI_ADDR_W-1:0]       slot0_ar_addr;
    logic [7:0]                       slot0_ar_len;
    logic [2:0]                       slot0_ar_size;
    logic [1:0]                       slot0_ar_burst;
    logic                             slot0_ar_lock;
    logic [3:0]                       slot0_ar_cache;
    logic [2:0]                       slot0_ar_prot;
    logic [3:0]                       slot0_ar_qos;
    logic [3:0]                       slot0_ar_region;
    logic [CVA6_AXI_USER_W-1:0]       slot0_ar_user;
    logic                             slot0_ar_valid;
    logic [CVA6_AXI_ID_W-1:0]         slot0_aw_id;
    logic [CVA6_AXI_ADDR_W-1:0]       slot0_aw_addr;
    logic [7:0]                       slot0_aw_len;
    logic [2:0]                       slot0_aw_size;
    logic [1:0]                       slot0_aw_burst;
    logic                             slot0_aw_lock;
    logic [3:0]                       slot0_aw_cache;
    logic [2:0]                       slot0_aw_prot;
    logic [3:0]                       slot0_aw_qos;
    logic [3:0]                       slot0_aw_region;
    logic [5:0]                       slot0_aw_atop;
    logic [CVA6_AXI_USER_W-1:0]       slot0_aw_user;
    logic                             slot0_aw_valid;
    logic [127:0]                     slot0_w_data;
    logic [15:0]                      slot0_w_strb;
    logic                             slot0_w_last;
    logic [CVA6_AXI_USER_W-1:0]       slot0_w_user;
    logic                             slot0_w_valid;
    logic                             slot0_b_ready;
    logic                             slot0_r_ready;

    // Downstream-side AXI4 response signals (driven by the slot-0 memory
    // model below).  Declared as wires so the converter's `dn_*_ready` /
    // `dn_r_data` / `dn_b_*` inputs see the memory's outputs.
    logic                             slot0_aw_ready;
    logic                             slot0_w_ready;
    logic [CVA6_AXI_ID_W-1:0]         slot0_b_id;
    logic [1:0]                       slot0_b_resp;
    logic [CVA6_AXI_USER_W-1:0]       slot0_b_user;
    logic                             slot0_b_valid;
    logic                             slot0_ar_ready;
    logic [CVA6_AXI_ID_W-1:0]         slot0_r_id;
    logic [127:0]                     slot0_r_data;
    logic [1:0]                       slot0_r_resp;
    logic                             slot0_r_last;
    logic [CVA6_AXI_USER_W-1:0]       slot0_r_user;
    logic                             slot0_r_valid;

    e1_axi4_width_converter #(
        .UPSTREAM_DATA_W  (CVA6_AXI_DATA_W),  // 64
        .DOWNSTREAM_DATA_W(128),
        .ID_W             (CVA6_AXI_ID_W),
        .ADDR_W           (CVA6_AXI_ADDR_W),
        .USER_W           (CVA6_AXI_USER_W),
        .BURST_LEN_W      (8)
    ) u_cva6_slot0_width (
        .clk_i      (clk),
        .rst_ni     (rst_n),
        // Upstream from CVA6
        .up_aw_id   (cva6_aw_id),
        .up_aw_addr (cva6_aw_addr),
        .up_aw_len  (cva6_aw_len),
        .up_aw_size (cva6_aw_size),
        .up_aw_burst(cva6_aw_burst),
        .up_aw_lock (cva6_aw_lock),
        .up_aw_cache(cva6_aw_cache),
        .up_aw_prot (cva6_aw_prot),
        .up_aw_qos  (cva6_aw_qos),
        .up_aw_region(cva6_aw_region),
        .up_aw_atop (cva6_aw_atop),
        .up_aw_user (cva6_aw_user),
        .up_aw_valid(cva6_aw_valid),
        .up_aw_ready(cva6_aw_ready_wire),
        .up_w_data  (cva6_w_data),
        .up_w_strb  (cva6_w_strb),
        .up_w_last  (cva6_w_last),
        .up_w_user  (cva6_w_user),
        .up_w_valid (cva6_w_valid),
        .up_w_ready (cva6_w_ready_wire),
        .up_b_id    (cva6_b_id_wire),
        .up_b_resp  (cva6_b_resp_wire),
        .up_b_user  (cva6_b_user_wire),
        .up_b_valid (cva6_b_valid_wire),
        .up_b_ready (cva6_b_ready),
        .up_ar_id   (cva6_ar_id),
        .up_ar_addr (cva6_ar_addr),
        .up_ar_len  (cva6_ar_len),
        .up_ar_size (cva6_ar_size),
        .up_ar_burst(cva6_ar_burst),
        .up_ar_lock (cva6_ar_lock),
        .up_ar_cache(cva6_ar_cache),
        .up_ar_prot (cva6_ar_prot),
        .up_ar_qos  (cva6_ar_qos),
        .up_ar_region(cva6_ar_region),
        .up_ar_user (cva6_ar_user),
        .up_ar_valid(cva6_ar_valid),
        .up_ar_ready(cva6_ar_ready_wire),
        .up_r_id    (cva6_r_id_wire),
        .up_r_data  (cva6_r_data_wire),
        .up_r_resp  (cva6_r_resp_wire),
        .up_r_last  (cva6_r_last_wire),
        .up_r_user  (cva6_r_user_wire),
        .up_r_valid (cva6_r_valid_wire),
        .up_r_ready (cva6_r_ready),
        // Downstream 128-bit slot-0 net.  In production this would land on
        // the cluster's slot-0 per-core AXI4 input ports.  Until the
        // cluster's per-core wrappers ship (see `e1_cluster_top.sv` lite
        // tie-off), we attach a thin AXI4-slave memory model directly on
        // the downstream net so cocotb can exercise the end-to-end
        // CVA6 → wrapper → adapter → width converter → memory loop.  The
        // memory serves the same boot-ROM + DRAM contract as the
        // standalone `e1_cva6_unit_tb.sv`, but at the 128-bit downstream
        // width (so the test exercises the actual converter beats).
        .dn_aw_id   (slot0_aw_id),
        .dn_aw_addr (slot0_aw_addr),
        .dn_aw_len  (slot0_aw_len),
        .dn_aw_size (slot0_aw_size),
        .dn_aw_burst(slot0_aw_burst),
        .dn_aw_lock (slot0_aw_lock),
        .dn_aw_cache(slot0_aw_cache),
        .dn_aw_prot (slot0_aw_prot),
        .dn_aw_qos  (slot0_aw_qos),
        .dn_aw_region(slot0_aw_region),
        .dn_aw_atop (slot0_aw_atop),
        .dn_aw_user (slot0_aw_user),
        .dn_aw_valid(slot0_aw_valid),
        .dn_aw_ready(slot0_aw_ready),
        .dn_w_data  (slot0_w_data),
        .dn_w_strb  (slot0_w_strb),
        .dn_w_last  (slot0_w_last),
        .dn_w_user  (slot0_w_user),
        .dn_w_valid (slot0_w_valid),
        .dn_w_ready (slot0_w_ready),
        .dn_b_id    (slot0_b_id),
        .dn_b_resp  (slot0_b_resp),
        .dn_b_user  (slot0_b_user),
        .dn_b_valid (slot0_b_valid),
        .dn_b_ready (slot0_b_ready),
        .dn_ar_id   (slot0_ar_id),
        .dn_ar_addr (slot0_ar_addr),
        .dn_ar_len  (slot0_ar_len),
        .dn_ar_size (slot0_ar_size),
        .dn_ar_burst(slot0_ar_burst),
        .dn_ar_lock (slot0_ar_lock),
        .dn_ar_cache(slot0_ar_cache),
        .dn_ar_prot (slot0_ar_prot),
        .dn_ar_qos  (slot0_ar_qos),
        .dn_ar_region(slot0_ar_region),
        .dn_ar_user (slot0_ar_user),
        .dn_ar_valid(slot0_ar_valid),
        .dn_ar_ready(slot0_ar_ready),
        .dn_r_id    (slot0_r_id),
        .dn_r_data  (slot0_r_data),
        .dn_r_resp  (slot0_r_resp),
        .dn_r_last  (slot0_r_last),
        .dn_r_user  (slot0_r_user),
        .dn_r_valid (slot0_r_valid),
        .dn_r_ready (slot0_r_ready)
    );

    // ── Slot-0 memory model + AXI4 traffic counters (128-bit downstream) ──
    //
    // Serves the same ROM @ 0x1_0000 / DRAM @ 0x8000_0000 contract as the
    // standalone `e1_cva6_unit_tb`, but at the 128-bit downstream width so
    // the in-band SoC test exercises the CVA6 → wrapper → adapter → width
    // converter → memory chain end-to-end.  Preloaded via `$readmemh` from
    // a hex file written by the cocotb test at module-import time (same
    // mechanism + same `boot_rom.hex` filename as the standalone TB), and
    // the first three 128-bit words are mirrored to top-level flat ports so
    // the test can assert the preload landed before releasing reset.
    //
    // The model is a simple single-inflight FSM mirroring the standalone
    // TB's read/write handling.  CVA6 cv64a6 issues at most one outstanding
    // AR/AW; the width converter is single-inflight, so a single-FSM model
    // matches the actual traffic shape.
    localparam int unsigned SLOT0_ROM_BYTES = 4096;   // 4 KiB
    localparam int unsigned SLOT0_DRAM_BYTES = 16384; // 16 KiB
    localparam int unsigned SLOT0_ROM_WORDS_128  = SLOT0_ROM_BYTES / 16;
    localparam int unsigned SLOT0_DRAM_WORDS_128 = SLOT0_DRAM_BYTES / 16;
    localparam logic [CVA6_AXI_ADDR_W-1:0] SLOT0_ROM_BASE  =
        64'h0000_0000_0001_0000;
    localparam logic [CVA6_AXI_ADDR_W-1:0] SLOT0_DRAM_BASE =
        64'h0000_0000_8000_0000;

    logic [127:0] slot0_rom  [0:SLOT0_ROM_WORDS_128-1];
    logic [127:0] slot0_dram [0:SLOT0_DRAM_WORDS_128-1];

    // `$readmemh` reads big-endian-by-default; the cocotb hex writer must
    // emit one 128-bit word per line (32 hex chars).  Path is taken from
    // the `SLOT0_BOOT_ROM_HEX` plusarg (default `boot_rom.hex` relative to
    // the simulator cwd) — same default as the standalone TB so a single
    // file shared between tests works in the common case.
    initial begin : init_slot0_mem
        string rom_path;
        for (int i = 0; i < SLOT0_ROM_WORDS_128;  i++) slot0_rom[i]  = 128'h0;
        for (int i = 0; i < SLOT0_DRAM_WORDS_128; i++) slot0_dram[i] = 128'h0;
        if (!$value$plusargs("SLOT0_BOOT_ROM_HEX=%s", rom_path)) begin
            rom_path = "boot_rom.hex";
        end
        $readmemh(rom_path, slot0_rom);
    end

    assign cva6_slot0_rom_word0_o = slot0_rom[0];
    assign cva6_slot0_rom_word1_o = slot0_rom[1];
    assign cva6_slot0_rom_word2_o = slot0_rom[2];

    function automatic logic slot0_is_rom_addr(input logic [CVA6_AXI_ADDR_W-1:0] addr);
        return (addr >= SLOT0_ROM_BASE) &&
               (addr <  (SLOT0_ROM_BASE + SLOT0_ROM_BYTES));
    endfunction
    function automatic logic slot0_is_dram_addr(input logic [CVA6_AXI_ADDR_W-1:0] addr);
        return (addr >= SLOT0_DRAM_BASE) &&
               (addr <  (SLOT0_DRAM_BASE + SLOT0_DRAM_BYTES));
    endfunction

    // Read FSM
    //
    // AXI4 IHI 0022 A8.4.1 (upsizing): the slave receives the master's
    // AxLEN/AxSIZE unchanged.  Each downstream beat must serve the
    // 128-bit word that contains the *current* beat address.  For a CVA6
    // 64-bit master (AxSIZE=3) the address advances 8 bytes per beat, so
    // two consecutive upstream beats land in the same 128-bit slot (the
    // width converter's `r_lane_q` picks the right 64-bit half).  Using a
    // simple `slot0_rom[beat_idx]` lookup walks the ROM at 128-bit
    // strides regardless of AxSIZE, which mis-serves upsize bursts.  The
    // fix is to track the per-beat byte address and index by `(addr >> 4)`.
    typedef enum logic [1:0] {SLOT0_R_IDLE, SLOT0_R_RESPOND} slot0_read_state_t;
    slot0_read_state_t       slot0_r_state;
    logic [CVA6_AXI_ID_W-1:0]   slot0_r_pending_id;
    logic [CVA6_AXI_ADDR_W-1:0] slot0_r_cur_addr;
    logic [7:0]                 slot0_r_pending_beats;
    logic [2:0]                 slot0_r_size;
    logic [7:0]                 slot0_r_beat_idx;

    assign slot0_ar_ready = (slot0_r_state == SLOT0_R_IDLE);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            slot0_r_state         <= SLOT0_R_IDLE;
            slot0_r_pending_id    <= '0;
            slot0_r_cur_addr      <= '0;
            slot0_r_pending_beats <= '0;
            slot0_r_size          <= 3'd0;
            slot0_r_beat_idx      <= '0;
            slot0_r_valid         <= 1'b0;
            slot0_r_id            <= '0;
            slot0_r_data          <= '0;
            slot0_r_resp          <= 2'b00;
            slot0_r_last          <= 1'b0;
            slot0_r_user          <= '0;
        end else begin
            unique case (slot0_r_state)
                SLOT0_R_IDLE: begin
                    slot0_r_valid <= 1'b0;
                    slot0_r_last  <= 1'b0;
                    if (slot0_ar_valid && slot0_ar_ready) begin
                        slot0_r_state         <= SLOT0_R_RESPOND;
                        slot0_r_pending_id    <= slot0_ar_id;
                        slot0_r_cur_addr      <= slot0_ar_addr;
                        slot0_r_pending_beats <= slot0_ar_len;
                        slot0_r_size          <= slot0_ar_size;
                        slot0_r_beat_idx      <= 8'd0;
                    end
                end
                SLOT0_R_RESPOND: begin
                    slot0_r_valid <= 1'b1;
                    slot0_r_id    <= slot0_r_pending_id;
                    if (slot0_is_rom_addr(slot0_r_cur_addr)) begin
                        slot0_r_data <= slot0_rom[
                            (slot0_r_cur_addr - SLOT0_ROM_BASE) >> 4];
                        slot0_r_resp <= 2'b00;
                    end else if (slot0_is_dram_addr(slot0_r_cur_addr)) begin
                        slot0_r_data <= slot0_dram[
                            (slot0_r_cur_addr - SLOT0_DRAM_BASE) >> 4];
                        slot0_r_resp <= 2'b00;
                    end else begin
                        slot0_r_data <= 128'h0;
                        slot0_r_resp <= 2'b11; // DECERR for unmapped
                    end
                    slot0_r_last <= (slot0_r_beat_idx == slot0_r_pending_beats);
                    if (slot0_r_valid && slot0_r_ready) begin
                        if (slot0_r_beat_idx == slot0_r_pending_beats) begin
                            slot0_r_state <= SLOT0_R_IDLE;
                            slot0_r_valid <= 1'b0;
                            slot0_r_last  <= 1'b0;
                        end else begin
                            slot0_r_beat_idx <= slot0_r_beat_idx + 8'd1;
                            slot0_r_cur_addr <= slot0_r_cur_addr +
                                ({{(CVA6_AXI_ADDR_W-1){1'b0}}, 1'b1} << slot0_r_size);
                        end
                    end
                end
                default: slot0_r_state <= SLOT0_R_IDLE;
            endcase
        end
    end

    // Write FSM
    //
    // Same upsize convention as the read side: the slave receives the
    // master's AxLEN/AxSIZE and the width converter places the per-beat
    // upstream WSTRB+W_DATA on the byte lane selected by the per-beat
    // address.  We track the current beat byte-address and merge each
    // 128-bit beat into the destination 128-bit slot using WSTRB
    // byte-wise (covers both DRAM and any stray ROM write — though ROM
    // writes are silently dropped because the SoC contract leaves the
    // boot-vector region read-only).
    typedef enum logic [1:0] {SLOT0_W_IDLE, SLOT0_W_DATA, SLOT0_W_RESP}
        slot0_write_state_t;
    slot0_write_state_t      slot0_w_state;
    logic [CVA6_AXI_ID_W-1:0]   slot0_w_pending_id;
    logic [CVA6_AXI_ADDR_W-1:0] slot0_w_cur_addr;
    logic [7:0]                 slot0_w_pending_beats;
    logic [2:0]                 slot0_w_size;
    logic [7:0]                 slot0_w_beat_idx;

    assign slot0_aw_ready = (slot0_w_state == SLOT0_W_IDLE);
    assign slot0_w_ready  = (slot0_w_state == SLOT0_W_DATA);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            slot0_w_state         <= SLOT0_W_IDLE;
            slot0_w_pending_id    <= '0;
            slot0_w_cur_addr      <= '0;
            slot0_w_pending_beats <= '0;
            slot0_w_size          <= 3'd0;
            slot0_w_beat_idx      <= '0;
            slot0_b_valid         <= 1'b0;
            slot0_b_id            <= '0;
            slot0_b_resp          <= 2'b00;
            slot0_b_user          <= '0;
        end else begin
            unique case (slot0_w_state)
                SLOT0_W_IDLE: begin
                    slot0_b_valid <= 1'b0;
                    if (slot0_aw_valid && slot0_aw_ready) begin
                        slot0_w_state         <= SLOT0_W_DATA;
                        slot0_w_pending_id    <= slot0_aw_id;
                        slot0_w_cur_addr      <= slot0_aw_addr;
                        slot0_w_pending_beats <= slot0_aw_len;
                        slot0_w_size          <= slot0_aw_size;
                        slot0_w_beat_idx      <= 8'd0;
                    end
                end
                SLOT0_W_DATA: begin
                    if (slot0_w_valid && slot0_w_ready) begin
                        if (slot0_is_dram_addr(slot0_w_cur_addr)) begin
                            for (int b = 0; b < 16; b++) begin
                                if (slot0_w_strb[b]) begin
                                    slot0_dram[
                                        (slot0_w_cur_addr - SLOT0_DRAM_BASE) >> 4
                                    ][b*8 +: 8] <= slot0_w_data[b*8 +: 8];
                                end
                            end
                        end
                        // ROM writes are silently dropped (tests should not
                        // target the ROM with writes; the SoC contract is
                        // read-only for the boot-vector region).
                        if (slot0_w_last) begin
                            slot0_w_state <= SLOT0_W_RESP;
                            slot0_b_id    <= slot0_w_pending_id;
                            slot0_b_resp  <= 2'b00;
                            slot0_b_valid <= 1'b1;
                        end else begin
                            slot0_w_beat_idx <= slot0_w_beat_idx + 8'd1;
                            slot0_w_cur_addr <= slot0_w_cur_addr +
                                ({{(CVA6_AXI_ADDR_W-1){1'b0}}, 1'b1} << slot0_w_size);
                        end
                    end
                end
                SLOT0_W_RESP: begin
                    if (slot0_b_valid && slot0_b_ready) begin
                        slot0_w_state <= SLOT0_W_IDLE;
                        slot0_b_valid <= 1'b0;
                    end
                end
                default: slot0_w_state <= SLOT0_W_IDLE;
            endcase
        end
    end

    // AXI4 traffic counters at the 128-bit downstream side.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            cva6_slot0_ar_xfers_o <= '0;
            cva6_slot0_aw_xfers_o <= '0;
            cva6_slot0_w_xfers_o  <= '0;
            cva6_slot0_r_xfers_o  <= '0;
            cva6_slot0_b_xfers_o  <= '0;
        end else begin
            if (slot0_ar_valid && slot0_ar_ready)
                cva6_slot0_ar_xfers_o <= cva6_slot0_ar_xfers_o + 32'd1;
            if (slot0_aw_valid && slot0_aw_ready)
                cva6_slot0_aw_xfers_o <= cva6_slot0_aw_xfers_o + 32'd1;
            if (slot0_w_valid && slot0_w_ready)
                cva6_slot0_w_xfers_o  <= cva6_slot0_w_xfers_o + 32'd1;
            if (slot0_r_valid && slot0_r_ready)
                cva6_slot0_r_xfers_o  <= cva6_slot0_r_xfers_o + 32'd1;
            if (slot0_b_valid && slot0_b_ready)
                cva6_slot0_b_xfers_o  <= cva6_slot0_b_xfers_o + 32'd1;
        end
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_cva6_slot0_outs;
    assign unused_cva6_slot0_outs = ^{
        slot0_b_user, slot0_r_user, slot0_b_id, slot0_b_resp, slot0_r_id,
        slot0_r_resp, slot0_r_last,
        slot0_aw_lock, slot0_aw_cache, slot0_aw_prot, slot0_aw_qos,
        slot0_aw_region, slot0_aw_atop, slot0_aw_user, slot0_aw_size,
        slot0_aw_burst, slot0_ar_lock, slot0_ar_cache, slot0_ar_prot,
        slot0_ar_qos, slot0_ar_region, slot0_ar_user, slot0_ar_size,
        slot0_ar_burst
    };
    /* verilator lint_on UNUSEDSIGNAL */
`endif // E1_CLUSTER_SLOT0_CVA6

`ifndef E1_CLUSTER_SLOT0_CVA6
    // Stub the CVA6 slot-0 observability ports to zero so the SoC top has a
    // single elaboration shape regardless of the define.
    assign cva6_slot0_ar_xfers_o   = 32'h0;
    assign cva6_slot0_aw_xfers_o   = 32'h0;
    assign cva6_slot0_w_xfers_o    = 32'h0;
    assign cva6_slot0_r_xfers_o    = 32'h0;
    assign cva6_slot0_b_xfers_o    = 32'h0;
    assign cva6_slot0_rom_word0_o  = 128'h0;
    assign cva6_slot0_rom_word1_o  = 128'h0;
    assign cva6_slot0_rom_word2_o  = 128'h0;
`endif // !E1_CLUSTER_SLOT0_CVA6

    // ----------------------------------------------------------------------
    // SLC → line shim → CHI → AXI4 cache south-side path.  Demonstrates
    // that the cache domain's line-grained `dram_acq` wires translate
    // into AXI4 bursts the fabric accepts.  Full MESI coherence traffic
    // stays under `verify/cocotb/cache/`; this top exercises only the
    // request/response side of the CHI bridge through one SLC slice.
    //
    // Request-side chain (declared here; instantiated below):
    //
    //     e1_slc.dram_acq_*        (line transaction)
    //       → e1_slc_to_chi_line_shim
    //         → e1_chi_to_axi4_bridge (CHI request side)
    //           → fabric master[0]
    // ----------------------------------------------------------------------
    logic chi_req_valid;
    logic chi_req_ready;
    logic chi_req_is_write;
    logic chi_req_is_exclusive;
    logic chi_req_stash;
    logic [AXI_ADDR_W-1:0] chi_req_addr;
    logic [5:0]            chi_req_id;     // CHI bridge ID_WIDTH default = 6
    logic [AXI_USER_W-1:0] chi_req_user;
    logic chi_wd_valid, chi_wd_ready, chi_wd_last;
    logic [AXI_DATA_W-1:0] chi_wd_data;
    logic [AXI_DATA_W/8-1:0] chi_wd_strb;
    logic chi_rd_valid, chi_rd_ready, chi_rd_last;
    logic [AXI_DATA_W-1:0] chi_rd_data;
    logic [5:0]            chi_rd_id;
    logic [1:0]            chi_rd_resp;
    logic chi_wc_valid, chi_wc_ready;
    logic [5:0]            chi_wc_id;
    logic [1:0]            chi_wc_resp;

    // ----------------------------------------------------------------------
    // SLC slice + line-to-CHI shim.  One small SLC bank (64 KB / 4-way /
    // 1 bank) absorbs requests from a tiny MMIO-controlled fixture and
    // drives `dram_acq_*` line transactions to the line shim, which in
    // turn drives the `chi_to_axi4_bridge` request side.  This advances
    // the chi_to_axi4_bridge edge from TIED_OFF to WIRED so a cocotb
    // request flows: SLC client → SLC bank → line shim → CHI bridge →
    // fabric m[0] → DRAM controller → DRAM model.
    //
    // The SLC bank dimensions match `e1_cache_pkg::SLC_LINE_BYTES` (64);
    // we only shrink SIZE_BYTES / WAYS / BANKS to keep elaboration time
    // bounded inside the integration top.  Production SLC is exercised
    // under `verify/cocotb/cache/`.
    // ----------------------------------------------------------------------
    localparam int unsigned SLC_INT_SIZE  = 64 * 1024;
    localparam int unsigned SLC_INT_WAYS  = 4;
    localparam int unsigned SLC_INT_LINE  = 64;
    // SLC parameter logic relies on `$clog2(BANKS) >= 1` and
    // `$clog2(NUM_CLIENTS) >= 1`; honour those floors here so the
    // generated bit ranges stay positive under Verilator.
    localparam int unsigned SLC_INT_BANKS = 2;
    localparam int unsigned SLC_INT_NUM_CLIENTS = 2;

    // SLC client fixture (MMIO 0x1008_0000): one outstanding line read or
    // write into the SLC.  Programmer registers:
    //   0x00  PADDR_LINE_LO  : low 32 bits of the line-aligned address
    //   0x04  PADDR_LINE_HI  : high 8 bits (40-bit PADDR)
    //   0x08  CTRL           : bit0=trigger_read, bit1=trigger_write
    //   0x0C  STATUS         : bit0=req_busy, bit1=grant_seen
    //   0x10  GRANT_LO       : low 32 bits of the most recent grant data
    //
    // The fixture issues exactly one acq beat then waits for the grant
    // pulse; cocotb polls STATUS to confirm the SLC→CHI path traversed.
    logic [PADDR_W_DEFAULT-1:0] slc_fix_paddr;
    logic                       slc_fix_busy;
    logic                       slc_fix_is_write;
    logic                       slc_fix_grant_seen;
    logic [31:0]                slc_fix_grant_lo;

    logic                       slc_req_valid;
    logic                       slc_req_ready;
    logic                       slc_req_is_write;
    logic                       slc_resp_valid;
    logic                       slc_resp_ready;
    logic [PADDR_W_DEFAULT-1:0] slc_resp_paddr_line;
    logic [8*SLC_INT_LINE-1:0]  slc_resp_data;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            slc_fix_paddr      <= '0;
            slc_fix_busy       <= 1'b0;
            slc_fix_is_write   <= 1'b0;
            slc_fix_grant_seen <= 1'b0;
            slc_fix_grant_lo   <= 32'h0;
        end else begin
            if (mmio_valid && mmio_write && slc_sel) begin
                unique case (mmio_addr[7:2])
                    6'h00: slc_fix_paddr[31:0]                 <= mmio_wdata;
                    6'h01: slc_fix_paddr[PADDR_W_DEFAULT-1:32] <=
                              mmio_wdata[PADDR_W_DEFAULT-32-1:0];
                    6'h02: begin
                        if (!slc_fix_busy) begin
                            if (mmio_wdata[0]) begin
                                slc_fix_busy       <= 1'b1;
                                slc_fix_is_write   <= 1'b0;
                                slc_fix_grant_seen <= 1'b0;
                            end else if (mmio_wdata[1]) begin
                                slc_fix_busy       <= 1'b1;
                                slc_fix_is_write   <= 1'b1;
                                slc_fix_grant_seen <= 1'b0;
                            end
                        end
                    end
                    6'h03: begin
                        // W1C status flags.
                        if (mmio_wdata[0]) slc_fix_busy       <= 1'b0;
                        if (mmio_wdata[1]) slc_fix_grant_seen <= 1'b0;
                    end
                    default: begin end
                endcase
            end
            // Clear req_busy once the SLC accepts the line request.
            if (slc_req_valid && slc_req_ready) begin
                slc_fix_busy <= 1'b0;
            end
            // Latch grant data when the SLC responds.
            if (slc_resp_valid && slc_resp_ready) begin
                slc_fix_grant_seen <= 1'b1;
                slc_fix_grant_lo   <= slc_resp_data[31:0];
            end
        end
    end

    assign slc_req_valid    = slc_fix_busy;
    assign slc_req_is_write = slc_fix_is_write;
    assign slc_resp_ready   = 1'b1;

    always_comb begin
        unique case (mmio_addr[7:2])
            6'h00:   slc_aper_rdata = slc_fix_paddr[31:0];
            6'h01:   slc_aper_rdata = {{(64-PADDR_W_DEFAULT){1'b0}},
                                        slc_fix_paddr[PADDR_W_DEFAULT-1:32]};
            6'h02:   slc_aper_rdata = 32'h0;
            6'h03:   slc_aper_rdata = {30'h0, slc_fix_grant_seen, slc_fix_busy};
            6'h04:   slc_aper_rdata = slc_fix_grant_lo;
            default: slc_aper_rdata = 32'h0;
        endcase
    end

    // SLC bank, way-mask configuration drives all-ways-enabled and
    // all-classes-allocate-all-ways (no isolation in the integration top).
    logic [SLC_INT_WAYS-1:0] slc_way_enable [SLC_INT_BANKS];
    logic [SLC_INT_WAYS-1:0] slc_way_alloc  [8];
    /* verilator lint_off UNUSEDSIGNAL */
    logic                    slc_hpm_access;
    logic                    slc_hpm_miss;
    logic                    slc_hpm_display_hold;
    logic                    slc_hpm_bdi;
    /* verilator lint_on UNUSEDSIGNAL */

    for (genvar gb = 0; gb < SLC_INT_BANKS; gb++) begin : g_slc_way_enable
        assign slc_way_enable[gb] = {SLC_INT_WAYS{1'b1}};
    end
    for (genvar gq = 0; gq < 8; gq++) begin : g_slc_way_alloc
        assign slc_way_alloc[gq] = {SLC_INT_WAYS{1'b1}};
    end

    // SLC→line-shim nets (declared up front so both the SLC and the shim
    // can reference them).
    logic                       slc_to_shim_acq_valid;
    logic                       slc_to_shim_acq_ready;
    logic [PADDR_W_DEFAULT-1:0] slc_to_shim_acq_paddr;
    logic                       slc_to_shim_acq_is_write;
    logic [8*SLC_INT_LINE-1:0]  slc_to_shim_acq_wb_data;
    logic                       slc_to_shim_grant_valid;
    logic                       slc_to_shim_grant_ready;
    logic [PADDR_W_DEFAULT-1:0] slc_to_shim_grant_paddr;
    logic [8*SLC_INT_LINE-1:0]  slc_to_shim_grant_data;

    /* verilator lint_off UNUSEDSIGNAL */
    logic [PADDR_W_DEFAULT-1:0] slc_to_shim_grant_paddr_unused;
    assign slc_to_shim_grant_paddr_unused = slc_to_shim_grant_paddr;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_slc #(
        .SIZE_BYTES (SLC_INT_SIZE),
        .WAYS       (SLC_INT_WAYS),
        .LINE_BYTES (SLC_INT_LINE),
        .BANKS      (SLC_INT_BANKS),
        .PADDR_W    (PADDR_W_DEFAULT),
        .NUM_CLIENTS(SLC_INT_NUM_CLIENTS)
    ) u_slc (
        .clk                   (clk),
        .rst_n                 (rst_n),
        .req_valid             (slc_req_valid),
        .req_ready             (slc_req_ready),
        .req_paddr_line        (slc_fix_paddr),
        .req_is_write          (slc_req_is_write),
        .req_qos               (QOS_CPU_FG),
        .req_client_id         ('0),
        .req_wb_data           ('0),
        .resp_valid            (slc_resp_valid),
        .resp_ready            (slc_resp_ready),
        .resp_paddr_line       (slc_resp_paddr_line),
        .resp_data             (slc_resp_data),
        .resp_client_id        (),
        .dram_acq_valid        (slc_to_shim_acq_valid),
        .dram_acq_ready        (slc_to_shim_acq_ready),
        .dram_acq_paddr_line   (slc_to_shim_acq_paddr),
        .dram_acq_is_write     (slc_to_shim_acq_is_write),
        .dram_acq_wb_data      (slc_to_shim_acq_wb_data),
        .dram_grant_valid      (slc_to_shim_grant_valid),
        .dram_grant_ready      (slc_to_shim_grant_ready),
        .dram_grant_paddr_line (slc_to_shim_grant_paddr),
        .dram_grant_data       (slc_to_shim_grant_data),
        .way_enable_mask       (slc_way_enable),
        .way_alloc_mask        (slc_way_alloc),
        .display_window_cycles (8'd32),
        .hpm_slc_access        (slc_hpm_access),
        .hpm_slc_miss          (slc_hpm_miss),
        .hpm_slc_display_hold  (slc_hpm_display_hold),
        .hpm_slc_bdi_compress  (slc_hpm_bdi)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic [PADDR_W_DEFAULT-1:0] slc_resp_paddr_line_unused;
    assign slc_resp_paddr_line_unused = slc_resp_paddr_line;
    /* verilator lint_on UNUSEDSIGNAL */

    // Line shim: 512-bit SLC line ↔ 4×128-bit AXI4 beats over CHI.
    e1_slc_to_chi_line_shim #(
        .PADDR_W    (PADDR_W_DEFAULT),
        .LINE_BYTES (SLC_INT_LINE),
        .DATA_WIDTH (AXI_DATA_W),
        .ID_WIDTH   (6),
        .USER_WIDTH (AXI_USER_W),
        .REQ_ID     (6'h05)
    ) u_slc_chi_shim (
        .clk   (clk),
        .rst_n (rst_n),
        .slc_acq_valid        (slc_to_shim_acq_valid),
        .slc_acq_ready        (slc_to_shim_acq_ready),
        .slc_acq_paddr_line   (slc_to_shim_acq_paddr),
        .slc_acq_is_write     (slc_to_shim_acq_is_write),
        .slc_acq_wb_data      (slc_to_shim_acq_wb_data),
        .slc_grant_valid      (slc_to_shim_grant_valid),
        .slc_grant_ready      (slc_to_shim_grant_ready),
        .slc_grant_paddr_line (slc_to_shim_grant_paddr),
        .slc_grant_data       (slc_to_shim_grant_data),
        .chi_req_valid        (chi_req_valid),
        .chi_req_ready        (chi_req_ready),
        .chi_req_is_write     (chi_req_is_write),
        .chi_req_is_exclusive (chi_req_is_exclusive),
        .chi_req_stash        (chi_req_stash),
        .chi_req_addr         (chi_req_addr),
        .chi_req_id           (chi_req_id),
        .chi_req_user         (chi_req_user),
        .chi_wd_valid         (chi_wd_valid),
        .chi_wd_ready         (chi_wd_ready),
        .chi_wd_data          (chi_wd_data),
        .chi_wd_strb          (chi_wd_strb),
        .chi_wd_last          (chi_wd_last),
        .chi_rd_valid         (chi_rd_valid),
        .chi_rd_ready         (chi_rd_ready),
        .chi_rd_data          (chi_rd_data),
        .chi_rd_id            (chi_rd_id),
        .chi_rd_last          (chi_rd_last),
        .chi_rd_resp          (chi_rd_resp),
        .chi_wc_valid         (chi_wc_valid),
        .chi_wc_ready         (chi_wc_ready),
        .chi_wc_id            (chi_wc_id),
        .chi_wc_resp          (chi_wc_resp)
    );

    // CHI bridge → fabric master[0].  Note: the bridge declares 6-bit IDs;
    // the fabric uses 4-bit IDs.  Width drift is absorbed by an adapter:
    // we slice the low 4 bits of the CHI ID (the high 2 bits encode the
    // CHI cluster ID and are reserved until multi-cluster ships).
    logic                  chi_m_awvalid;
    logic                  chi_m_awready;
    logic [5:0]            chi_m_awid;
    logic [AXI_ADDR_W-1:0] chi_m_awaddr;
    logic [BURST_LEN_W-1:0] chi_m_awlen;
    logic [2:0]            chi_m_awsize;
    logic [1:0]            chi_m_awburst;
    logic                  chi_m_awlock;
    logic [3:0]            chi_m_awcache;
    logic [2:0]            chi_m_awprot;
    logic [3:0]            chi_m_awqos;
    logic [AXI_USER_W-1:0] chi_m_awuser;
    logic                  chi_m_wvalid, chi_m_wready, chi_m_wlast;
    logic [AXI_DATA_W-1:0] chi_m_wdata;
    logic [AXI_DATA_W/8-1:0] chi_m_wstrb;
    logic                  chi_m_bvalid, chi_m_bready;
    logic [5:0]            chi_m_bid;
    logic [1:0]            chi_m_bresp;
    logic                  chi_m_arvalid, chi_m_arready;
    logic [5:0]            chi_m_arid;
    logic [AXI_ADDR_W-1:0] chi_m_araddr;
    logic [BURST_LEN_W-1:0] chi_m_arlen;
    logic [2:0]            chi_m_arsize;
    logic [1:0]            chi_m_arburst;
    logic                  chi_m_arlock;
    logic [3:0]            chi_m_arcache;
    logic [2:0]            chi_m_arprot;
    logic [3:0]            chi_m_arqos;
    logic [AXI_USER_W-1:0] chi_m_aruser;
    logic                  chi_m_rvalid, chi_m_rready, chi_m_rlast;
    logic [5:0]            chi_m_rid;
    logic [AXI_DATA_W-1:0] chi_m_rdata;
    logic [1:0]            chi_m_rresp;

    e1_chi_to_axi4_bridge #(
        .ID_WIDTH   (6),
        .ADDR_WIDTH (AXI_ADDR_W),
        .DATA_WIDTH (AXI_DATA_W),
        .USER_WIDTH (AXI_USER_W),
        .BURST_LEN_W(BURST_LEN_W),
        .LINE_BYTES (64)
    ) u_chi_bridge (
        .clk (clk),
        .rst_n (rst_n),
        .chi_req_valid       (chi_req_valid),
        .chi_req_ready       (chi_req_ready),
        .chi_req_is_write    (chi_req_is_write),
        .chi_req_is_exclusive(chi_req_is_exclusive),
        .chi_req_stash       (chi_req_stash),
        .chi_req_addr        (chi_req_addr),
        .chi_req_id          (chi_req_id),
        .chi_req_user        (chi_req_user),
        .chi_wd_valid        (chi_wd_valid),
        .chi_wd_ready        (chi_wd_ready),
        .chi_wd_data         (chi_wd_data),
        .chi_wd_strb         (chi_wd_strb),
        .chi_wd_last         (chi_wd_last),
        .chi_rd_valid        (chi_rd_valid),
        .chi_rd_ready        (chi_rd_ready),
        .chi_rd_data         (chi_rd_data),
        .chi_rd_id           (chi_rd_id),
        .chi_rd_last         (chi_rd_last),
        .chi_rd_resp         (chi_rd_resp),
        .chi_wc_valid        (chi_wc_valid),
        .chi_wc_ready        (chi_wc_ready),
        .chi_wc_id           (chi_wc_id),
        .chi_wc_resp         (chi_wc_resp),
        .m_awvalid (chi_m_awvalid),
        .m_awready (chi_m_awready),
        .m_awid    (chi_m_awid),
        .m_awaddr  (chi_m_awaddr),
        .m_awlen   (chi_m_awlen),
        .m_awsize  (chi_m_awsize),
        .m_awburst (chi_m_awburst),
        .m_awlock  (chi_m_awlock),
        .m_awcache (chi_m_awcache),
        .m_awprot  (chi_m_awprot),
        .m_awqos   (chi_m_awqos),
        .m_awuser  (chi_m_awuser),
        .m_wvalid  (chi_m_wvalid),
        .m_wready  (chi_m_wready),
        .m_wdata   (chi_m_wdata),
        .m_wstrb   (chi_m_wstrb),
        .m_wlast   (chi_m_wlast),
        .m_bvalid  (chi_m_bvalid),
        .m_bready  (chi_m_bready),
        .m_bid     (chi_m_bid),
        .m_bresp   (chi_m_bresp),
        .m_arvalid (chi_m_arvalid),
        .m_arready (chi_m_arready),
        .m_arid    (chi_m_arid),
        .m_araddr  (chi_m_araddr),
        .m_arlen   (chi_m_arlen),
        .m_arsize  (chi_m_arsize),
        .m_arburst (chi_m_arburst),
        .m_arlock  (chi_m_arlock),
        .m_arcache (chi_m_arcache),
        .m_arprot  (chi_m_arprot),
        .m_arqos   (chi_m_arqos),
        .m_aruser  (chi_m_aruser),
        .m_rvalid  (chi_m_rvalid),
        .m_rready  (chi_m_rready),
        .m_rid     (chi_m_rid),
        .m_rdata   (chi_m_rdata),
        .m_rresp   (chi_m_rresp),
        .m_rlast   (chi_m_rlast)
    );

    // ----------------------------------------------------------------------
    // IOMMU + non-coherent master leg.
    //
    // The integration test surfaces a single non-coherent master (a tied
    // off representative for NPU / DMA / display) behind the RISC-V IOMMU
    // v1.0.1.  The IOMMU emits one downstream AXI4 master into the fabric.
    // Cross-domain check: writing the IOMMU MMIO register (via the v0 MMIO
    // aperture) configures DDT; raising an unmapped DMA stimulates the
    // fault queue and surfaces `fault_irq`.
    // ----------------------------------------------------------------------
    localparam int unsigned IOMMU_NUM_MASTERS = 1;
    localparam int unsigned IOMMU_DEVID_W     = 24;
    localparam int unsigned IOMMU_PASID_W     = 20;

    // Upstream master (tied to AW-stable idle in the SoC; the integration
    // test pokes the IOMMU MMIO directly via the v0 aperture for the
    // cross-domain proof).  The non-coherent master is tied off because
    // the production NPU/DMA wrappers in the existing tree drive the
    // AXI-Lite scaffold above; this leg is the IOMMU translation surface
    // for the future per-engine masters.
    logic [IOMMU_NUM_MASTERS-1:0] iom_awvalid, iom_awready;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_ID_W-1:0]   iom_awid;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_ADDR_W-1:0] iom_awaddr;
    logic [IOMMU_NUM_MASTERS-1:0][BURST_LEN_W-1:0] iom_awlen;
    logic [IOMMU_NUM_MASTERS-1:0][2:0]            iom_awsize;
    logic [IOMMU_NUM_MASTERS-1:0][1:0]            iom_awburst;
    logic [IOMMU_NUM_MASTERS-1:0][3:0]            iom_awcache;
    logic [IOMMU_NUM_MASTERS-1:0][2:0]            iom_awprot;
    logic [IOMMU_NUM_MASTERS-1:0][3:0]            iom_awqos;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_USER_W-1:0] iom_awuser;
    logic [IOMMU_NUM_MASTERS-1:0][IOMMU_DEVID_W-1:0] iom_aw_devid;
    logic [IOMMU_NUM_MASTERS-1:0][IOMMU_PASID_W-1:0] iom_aw_pasid;
    logic [IOMMU_NUM_MASTERS-1:0] iom_wvalid, iom_wready, iom_wlast;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_DATA_W-1:0] iom_wdata;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_DATA_W/8-1:0] iom_wstrb;
    logic [IOMMU_NUM_MASTERS-1:0] iom_bvalid, iom_bready;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_ID_W-1:0] iom_bid;
    logic [IOMMU_NUM_MASTERS-1:0][1:0]          iom_bresp;
    logic [IOMMU_NUM_MASTERS-1:0] iom_arvalid, iom_arready;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_ID_W-1:0]    iom_arid;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_ADDR_W-1:0]  iom_araddr;
    logic [IOMMU_NUM_MASTERS-1:0][BURST_LEN_W-1:0] iom_arlen;
    logic [IOMMU_NUM_MASTERS-1:0][2:0]             iom_arsize;
    logic [IOMMU_NUM_MASTERS-1:0][1:0]             iom_arburst;
    logic [IOMMU_NUM_MASTERS-1:0][3:0]             iom_arcache;
    logic [IOMMU_NUM_MASTERS-1:0][2:0]             iom_arprot;
    logic [IOMMU_NUM_MASTERS-1:0][3:0]             iom_arqos;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_USER_W-1:0]  iom_aruser;
    logic [IOMMU_NUM_MASTERS-1:0][IOMMU_DEVID_W-1:0] iom_ar_devid;
    logic [IOMMU_NUM_MASTERS-1:0][IOMMU_PASID_W-1:0] iom_ar_pasid;
    logic [IOMMU_NUM_MASTERS-1:0] iom_rvalid, iom_rready, iom_rlast;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_ID_W-1:0]   iom_rid;
    logic [IOMMU_NUM_MASTERS-1:0][AXI_DATA_W-1:0] iom_rdata;
    logic [IOMMU_NUM_MASTERS-1:0][1:0]            iom_rresp;

    // ----------------------------------------------------------------------
    // IOMMU DMA fixture (one upstream master).  A small MMIO-controlled
    // master driving a single AXI4 transaction so the cocotb integration
    // test can exercise the IOMMU translation / fault path without
    // requiring a real DMA / NPU engine.  Programmer registers (relative
    // to 0x1007_0000):
    //
    //   0x00  IOVA       : 32-bit transaction address
    //   0x04  CTRL       : bit0=trigger_write, bit1=trigger_read
    //   0x08  STATUS     : bit0=busy, bit2:1=last_bresp, bit4:3=last_rresp
    //                       (write-1-to-clear bit0)
    //   0x0C  DEV_ID     : 24-bit device-id passed in u_a*_devid
    //
    // The fixture issues exactly one beat (axlen=0); B / R responses are
    // captured to STATUS and the unit returns to idle.  When the IOMMU is
    // not BARE and DEV_ID is not in the allowlist, this generates a fault
    // record observable via the IOMMU MMIO bridge.
    // ----------------------------------------------------------------------
    logic [31:0] dma_fix_iova;
    logic [23:0] dma_fix_dev_id;
    logic        dma_fix_busy;
    logic        dma_fix_is_write;
    logic        dma_fix_aw_done;
    logic        dma_fix_w_done;
    logic        dma_fix_ar_done;
    logic [1:0]  dma_fix_last_bresp;
    logic [1:0]  dma_fix_last_rresp;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            dma_fix_iova        <= 32'h0;
            dma_fix_dev_id      <= 24'h0;
            dma_fix_busy        <= 1'b0;
            dma_fix_is_write    <= 1'b0;
            dma_fix_aw_done     <= 1'b0;
            dma_fix_w_done      <= 1'b0;
            dma_fix_ar_done     <= 1'b0;
            dma_fix_last_bresp  <= 2'b00;
            dma_fix_last_rresp  <= 2'b00;
        end else begin
            if (mmio_valid && mmio_write && iommu_dma_sel) begin
                unique case (mmio_addr[7:2])
                    6'h00: dma_fix_iova   <= mmio_wdata;
                    6'h01: begin
                        if (!dma_fix_busy) begin
                            if (mmio_wdata[0]) begin
                                dma_fix_busy     <= 1'b1;
                                dma_fix_is_write <= 1'b1;
                                dma_fix_aw_done  <= 1'b0;
                                dma_fix_w_done   <= 1'b0;
                            end else if (mmio_wdata[1]) begin
                                dma_fix_busy     <= 1'b1;
                                dma_fix_is_write <= 1'b0;
                                dma_fix_ar_done  <= 1'b0;
                            end
                        end
                    end
                    6'h02: begin
                        // W1C status[0] to clear busy after completion (in
                        // case the fixture stalls).  Real systems poll the
                        // status; cocotb uses it as an explicit ack.
                        if (mmio_wdata[0]) begin
                            dma_fix_busy <= 1'b0;
                        end
                    end
                    6'h03: dma_fix_dev_id <= mmio_wdata[23:0];
                    default: begin end
                endcase
            end
            // Track AW / W / AR fires.
            if (dma_fix_busy && dma_fix_is_write) begin
                if (iom_awvalid[0] && iom_awready[0]) dma_fix_aw_done <= 1'b1;
                if (iom_wvalid[0]  && iom_wready[0])  dma_fix_w_done  <= 1'b1;
                if (iom_bvalid[0]  && iom_bready[0]) begin
                    dma_fix_busy       <= 1'b0;
                    dma_fix_last_bresp <= iom_bresp[0];
                end
            end
            if (dma_fix_busy && !dma_fix_is_write) begin
                if (iom_arvalid[0] && iom_arready[0]) dma_fix_ar_done <= 1'b1;
                if (iom_rvalid[0]  && iom_rready[0] && iom_rlast[0]) begin
                    dma_fix_busy       <= 1'b0;
                    dma_fix_last_rresp <= iom_rresp[0];
                end
            end
        end
    end

    // Drive the IOMMU's upstream master[0] from the fixture.  The fixture
    // emits a single-beat transaction with axlen=0.
    assign iom_awvalid[0]  = dma_fix_busy && dma_fix_is_write && !dma_fix_aw_done;
    assign iom_awid[0]     = 4'h1;
    assign iom_awaddr[0]   = {{(AXI_ADDR_W-32){1'b0}}, dma_fix_iova};
    assign iom_awlen[0]    = '0;
    assign iom_awsize[0]   = 3'd4;       // 16 bytes per beat (matches DATA_WIDTH/8)
    assign iom_awburst[0]  = 2'b01;      // INCR
    assign iom_awcache[0]  = 4'h0;
    assign iom_awprot[0]   = 3'b001;     // privileged
    assign iom_awqos[0]    = 4'h0;
    assign iom_awuser[0]   = '0;
    assign iom_aw_devid[0] = dma_fix_dev_id;
    assign iom_aw_pasid[0] = '0;
    assign iom_wvalid[0]   = dma_fix_busy && dma_fix_is_write && !dma_fix_w_done;
    assign iom_wdata[0]    = {AXI_DATA_W{1'b0}} | 128'hDEAD_BEEF_F00D_CAFE_DEAD_BEEF_F00D_CAFE;
    assign iom_wstrb[0]    = '1;
    assign iom_wlast[0]    = 1'b1;
    assign iom_bready[0]   = dma_fix_busy && dma_fix_is_write;
    assign iom_arvalid[0]  = dma_fix_busy && !dma_fix_is_write && !dma_fix_ar_done;
    assign iom_arid[0]     = 4'h1;
    assign iom_araddr[0]   = {{(AXI_ADDR_W-32){1'b0}}, dma_fix_iova};
    assign iom_arlen[0]    = '0;
    assign iom_arsize[0]   = 3'd4;
    assign iom_arburst[0]  = 2'b01;
    assign iom_arcache[0]  = 4'h0;
    assign iom_arprot[0]   = 3'b001;
    assign iom_arqos[0]    = 4'h0;
    assign iom_aruser[0]   = '0;
    assign iom_ar_devid[0] = dma_fix_dev_id;
    assign iom_ar_pasid[0] = '0;
    assign iom_rready[0]   = dma_fix_busy && !dma_fix_is_write;

    // 32-bit readback of the fixture state.
    always_comb begin
        unique case (mmio_addr[7:2])
            6'h00:   iommu_dma_rdata = dma_fix_iova;
            6'h01:   iommu_dma_rdata = 32'h0;
            6'h02:   iommu_dma_rdata = {26'h0, dma_fix_last_rresp,
                                        dma_fix_last_bresp, dma_fix_busy};
            6'h03:   iommu_dma_rdata = {8'h0, dma_fix_dev_id};
            default: iommu_dma_rdata = 32'h0;
        endcase
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_iom_upstream;
    assign unused_iom_upstream = ^{
        iom_awready, iom_wready, iom_bvalid, iom_bid, iom_bresp,
        iom_arready, iom_rvalid, iom_rid, iom_rdata, iom_rresp, iom_rlast
    };
    /* verilator lint_on UNUSEDSIGNAL */

    // IOMMU downstream → fabric master[1]
    logic                  iom_d_awvalid, iom_d_awready;
    logic [5:0]            iom_d_awid;
    logic [AXI_ADDR_W-1:0] iom_d_awaddr;
    logic [BURST_LEN_W-1:0] iom_d_awlen;
    logic [2:0]            iom_d_awsize;
    logic [1:0]            iom_d_awburst;
    logic [3:0]            iom_d_awcache;
    logic [2:0]            iom_d_awprot;
    logic [3:0]            iom_d_awqos;
    logic [AXI_USER_W-1:0] iom_d_awuser;
    logic                  iom_d_wvalid, iom_d_wready, iom_d_wlast;
    logic [AXI_DATA_W-1:0] iom_d_wdata;
    logic [AXI_DATA_W/8-1:0] iom_d_wstrb;
    logic                  iom_d_bvalid, iom_d_bready;
    logic [5:0]            iom_d_bid;
    logic [1:0]            iom_d_bresp;
    logic                  iom_d_arvalid, iom_d_arready;
    logic [5:0]            iom_d_arid;
    logic [AXI_ADDR_W-1:0] iom_d_araddr;
    logic [BURST_LEN_W-1:0] iom_d_arlen;
    logic [2:0]            iom_d_arsize;
    logic [1:0]            iom_d_arburst;
    logic [3:0]            iom_d_arcache;
    logic [2:0]            iom_d_arprot;
    logic [3:0]            iom_d_arqos;
    logic [AXI_USER_W-1:0] iom_d_aruser;
    logic                  iom_d_rvalid, iom_d_rready, iom_d_rlast;
    logic [5:0]            iom_d_rid;
    logic [AXI_DATA_W-1:0] iom_d_rdata;
    logic [1:0]            iom_d_rresp;

    // IOMMU MMIO (AXI-Lite-style 12-bit window) bridged onto the v0 32-bit
    // debug aperture at 0x1006_0000.  The IOMMU's slave is 64-bit-data
    // wide but accepts 4-byte-aligned addressing.  Programming model:
    //
    //  - Write low half  (mmio_addr[2]==0): stash the 32-bit data.  No
    //    AXI-Lite cycle is launched; the bridge holds the value.
    //  - Write high half (mmio_addr[2]==1): launch an AXI-Lite write with
    //    address `{mmio_addr[11:3], 3'h0}` (the 8-byte-aligned register
    //    base) and `wdata = {mmio_wdata, stash_low}`.  This is the
    //    canonical path for 64-bit IOMMU registers (DDTP, CQB, FQB, ...).
    //  - Read at any 4-byte boundary: launch an AXI-Lite read with
    //    `araddr = mmio_addr[11:0]` and latch the 64-bit response in
    //    `iommu_mmio_latched_rdata`.  The MMIO read returns the latched
    //    low or high half depending on `mmio_addr[2]`.  This handles
    //    32-bit registers (FQT/FQH/CQH/...) directly via their own
    //    4-byte offset.
    logic        iommu_mmio_awvalid;
    logic        iommu_mmio_awready;
    logic [11:0] iommu_mmio_awaddr;
    logic        iommu_mmio_wvalid;
    logic        iommu_mmio_wready;
    logic [63:0] iommu_mmio_wdata;
    logic [7:0]  iommu_mmio_wstrb;
    logic        iommu_mmio_bvalid;
    logic        iommu_mmio_bready;
    logic [1:0]  iommu_mmio_bresp;
    logic        iommu_mmio_arvalid;
    logic        iommu_mmio_arready;
    logic [11:0] iommu_mmio_araddr;
    logic        iommu_mmio_rvalid;
    logic        iommu_mmio_rready;
    logic [63:0] iommu_mmio_rdata;
    logic [1:0]  iommu_mmio_rresp;

    logic [31:0] iommu_mmio_stash_lo;
    logic [63:0] iommu_mmio_latched_rdata;
    logic        iommu_mmio_aw_pending;
    logic        iommu_mmio_w_pending;
    logic        iommu_mmio_ar_pending;
    logic [11:0] iommu_mmio_pending_addr;
    logic [63:0] iommu_mmio_pending_wdata;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            iommu_mmio_stash_lo       <= 32'h0;
            iommu_mmio_latched_rdata  <= 64'h0;
            iommu_mmio_aw_pending     <= 1'b0;
            iommu_mmio_w_pending      <= 1'b0;
            iommu_mmio_ar_pending     <= 1'b0;
            iommu_mmio_pending_addr   <= 12'h0;
            iommu_mmio_pending_wdata  <= 64'h0;
        end else begin
            // Latch the IOMMU's AXI-Lite read response.
            if (iommu_mmio_rvalid) begin
                iommu_mmio_latched_rdata <= iommu_mmio_rdata;
            end
            // Lower the AW pending flag once the IOMMU accepts it.
            if (iommu_mmio_aw_pending && iommu_mmio_awready) begin
                iommu_mmio_aw_pending <= 1'b0;
            end
            if (iommu_mmio_w_pending && iommu_mmio_wready) begin
                iommu_mmio_w_pending <= 1'b0;
            end
            if (iommu_mmio_ar_pending && iommu_mmio_arready) begin
                iommu_mmio_ar_pending <= 1'b0;
            end
            // CPU-side MMIO write to the IOMMU window.
            if (mmio_valid && mmio_write && iommu_sel) begin
                if (mmio_addr[2] == 1'b0) begin
                    iommu_mmio_stash_lo <= mmio_wdata;
                end else begin
                    iommu_mmio_aw_pending    <= 1'b1;
                    iommu_mmio_w_pending     <= 1'b1;
                    iommu_mmio_pending_addr  <= {mmio_addr[11:3], 3'h0};
                    iommu_mmio_pending_wdata <= {mmio_wdata, iommu_mmio_stash_lo};
                end
            end
            // CPU-side MMIO read issues an AR with the full 4-byte aligned
            // offset.  Only re-arm the AR when none is already in flight
            // so a back-to-back read sequence (trigger / fetch) doesn't
            // overwrite the in-flight pending address.
            if (mmio_valid && !mmio_write && iommu_sel
                && !iommu_mmio_ar_pending) begin
                iommu_mmio_ar_pending   <= 1'b1;
                iommu_mmio_pending_addr <= mmio_addr[11:0];
            end
        end
    end

    assign iommu_mmio_awvalid = iommu_mmio_aw_pending;
    assign iommu_mmio_awaddr  = iommu_mmio_pending_addr;
    assign iommu_mmio_wvalid  = iommu_mmio_w_pending;
    assign iommu_mmio_wdata   = iommu_mmio_pending_wdata;
    assign iommu_mmio_wstrb   = 8'hFF;
    assign iommu_mmio_bready  = 1'b1;
    assign iommu_mmio_arvalid = iommu_mmio_ar_pending;
    assign iommu_mmio_araddr  = iommu_mmio_pending_addr;
    assign iommu_mmio_rready  = 1'b1;

    // 32-bit read-back to the v0 aperture: the IOMMU's AXI-Lite slave
    // always packs the 32-bit register value into the low half of its
    // 64-bit response (see e1_riscv_iommu.sv, e.g. `64'(reg_fqt)`).  We
    // return that low half here regardless of `mmio_addr[2]`.  The bridge
    // re-arms the AR on every read so each 4-byte MMIO read fetches a
    // fresh response at the matching IOMMU offset.
    assign iommu_aper_rdata = iommu_mmio_latched_rdata[31:0];

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_iommu_mmio_resp;
    assign unused_iommu_mmio_resp = ^{
        iommu_mmio_bvalid, iommu_mmio_bresp, iommu_mmio_rresp
    };
    /* verilator lint_on UNUSEDSIGNAL */

    logic        iommu_page_req_irq;
    logic        iommu_cmd_complete_irq;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [31:0] iommu_page_req_count;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_riscv_iommu #(
        .ID_WIDTH    (6),
        .ADDR_WIDTH  (AXI_ADDR_W),
        .DATA_WIDTH  (AXI_DATA_W),
        .USER_WIDTH  (AXI_USER_W),
        .BURST_LEN_W (BURST_LEN_W),
        .NUM_MASTERS (IOMMU_NUM_MASTERS),
        .DEVICE_ID_W (IOMMU_DEVID_W),
        .PASID_W     (IOMMU_PASID_W)
    ) u_iommu (
        .clk (clk),
        .rst_n (rst_n),
        // Upstream masters
        .u_awvalid (iom_awvalid),
        .u_awready (iom_awready),
        // Upstream master AxID is 4-bit; the IOMMU declares 6-bit IDs.
        // Pad the high 2 bits to zero.
        .u_awid    ({iom_awid[0], 2'b00}),
        .u_awaddr  (iom_awaddr),
        .u_awlen   (iom_awlen),
        .u_awsize  (iom_awsize),
        .u_awburst (iom_awburst),
        .u_awcache (iom_awcache),
        .u_awprot  (iom_awprot),
        .u_awqos   (iom_awqos),
        .u_awuser  (iom_awuser),
        .u_aw_devid(iom_aw_devid),
        .u_aw_pasid(iom_aw_pasid),
        .u_wvalid  (iom_wvalid),
        .u_wready  (iom_wready),
        .u_wdata   (iom_wdata),
        .u_wstrb   (iom_wstrb),
        .u_wlast   (iom_wlast),
        .u_bvalid  (iom_bvalid),
        .u_bready  (iom_bready),
        .u_bid     (iom_bid),
        .u_bresp   (iom_bresp),
        .u_arvalid (iom_arvalid),
        .u_arready (iom_arready),
        .u_arid    ({iom_arid[0], 2'b00}),
        .u_araddr  (iom_araddr),
        .u_arlen   (iom_arlen),
        .u_arsize  (iom_arsize),
        .u_arburst (iom_arburst),
        .u_arcache (iom_arcache),
        .u_arprot  (iom_arprot),
        .u_arqos   (iom_arqos),
        .u_aruser  (iom_aruser),
        .u_ar_devid(iom_ar_devid),
        .u_ar_pasid(iom_ar_pasid),
        .u_rvalid  (iom_rvalid),
        .u_rready  (iom_rready),
        .u_rid     (iom_rid),
        .u_rdata   (iom_rdata),
        .u_rresp   (iom_rresp),
        .u_rlast   (iom_rlast),
        // Downstream master
        .d_awvalid (iom_d_awvalid),
        .d_awready (iom_d_awready),
        .d_awid    (iom_d_awid),
        .d_awaddr  (iom_d_awaddr),
        .d_awlen   (iom_d_awlen),
        .d_awsize  (iom_d_awsize),
        .d_awburst (iom_d_awburst),
        .d_awcache (iom_d_awcache),
        .d_awprot  (iom_d_awprot),
        .d_awqos   (iom_d_awqos),
        .d_awuser  (iom_d_awuser),
        .d_wvalid  (iom_d_wvalid),
        .d_wready  (iom_d_wready),
        .d_wdata   (iom_d_wdata),
        .d_wstrb   (iom_d_wstrb),
        .d_wlast   (iom_d_wlast),
        .d_bvalid  (iom_d_bvalid),
        .d_bready  (iom_d_bready),
        .d_bid     (iom_d_bid),
        .d_bresp   (iom_d_bresp),
        .d_arvalid (iom_d_arvalid),
        .d_arready (iom_d_arready),
        .d_arid    (iom_d_arid),
        .d_araddr  (iom_d_araddr),
        .d_arlen   (iom_d_arlen),
        .d_arsize  (iom_d_arsize),
        .d_arburst (iom_d_arburst),
        .d_arcache (iom_d_arcache),
        .d_arprot  (iom_d_arprot),
        .d_arqos   (iom_d_arqos),
        .d_aruser  (iom_d_aruser),
        .d_rvalid  (iom_d_rvalid),
        .d_rready  (iom_d_rready),
        .d_rid     (iom_d_rid),
        .d_rdata   (iom_d_rdata),
        .d_rresp   (iom_d_rresp),
        .d_rlast   (iom_d_rlast),
        // MMIO
        .mmio_awvalid (iommu_mmio_awvalid),
        .mmio_awready (iommu_mmio_awready),
        .mmio_awaddr  (iommu_mmio_awaddr),
        .mmio_wvalid  (iommu_mmio_wvalid),
        .mmio_wready  (iommu_mmio_wready),
        .mmio_wdata   (iommu_mmio_wdata),
        .mmio_wstrb   (iommu_mmio_wstrb),
        .mmio_bvalid  (iommu_mmio_bvalid),
        .mmio_bready  (iommu_mmio_bready),
        .mmio_bresp   (iommu_mmio_bresp),
        .mmio_arvalid (iommu_mmio_arvalid),
        .mmio_arready (iommu_mmio_arready),
        .mmio_araddr  (iommu_mmio_araddr),
        .mmio_rvalid  (iommu_mmio_rvalid),
        .mmio_rready  (iommu_mmio_rready),
        .mmio_rdata   (iommu_mmio_rdata),
        .mmio_rresp   (iommu_mmio_rresp),
        // Observability
        .fault_irq           (iommu_fault_irq_o),
        .page_req_irq        (iommu_page_req_irq),
        .cmd_complete_irq    (iommu_cmd_complete_irq),
        .fault_count_dbg     (iommu_fault_count_o),
        .page_req_count_dbg  (iommu_page_req_count)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_iommu_irqs;
    assign unused_iommu_irqs = iommu_page_req_irq | iommu_cmd_complete_irq;
    /* verilator lint_on UNUSEDSIGNAL */

    // ----------------------------------------------------------------------
    // AXI4 fabric (production-path burst interconnect).
    //
    // Masters:
    //   m[0] : CHI→AXI4 bridge (cache south-side traffic)
    //   m[1] : IOMMU translated traffic (non-coherent engines)
    //
    // Slaves:
    //   s[0] : DRAM (e1_dram_ctrl → e1_axi4_dram_model)
    //   s[1] : decode-error sentinel (UNMAP)
    // ----------------------------------------------------------------------
    localparam logic [AXI_ADDR_W-1:0] DRAM_BASE   =
        {{(AXI_ADDR_W-32){1'b0}}, 32'h8000_0000};
    localparam logic [AXI_ADDR_W-1:0] DRAM_MASK   = {{(AXI_ADDR_W-32){1'b0}}, 32'h0000_FFFF};
    localparam logic [AXI_ADDR_W-1:0] UNMAP_BASE  = {AXI_ADDR_W{1'b1}};
    localparam logic [AXI_ADDR_W-1:0] UNMAP_MASK  = {AXI_ADDR_W{1'b0}};

    // Fabric master arrays (FABRIC_MASTERS = 2)
    logic [FABRIC_MASTERS-1:0]                    fab_m_awvalid;
    logic [FABRIC_MASTERS-1:0]                    fab_m_awready;
    logic [FABRIC_MASTERS-1:0][AXI_ID_W-1:0]      fab_m_awid;
    logic [FABRIC_MASTERS-1:0][AXI_ADDR_W-1:0]    fab_m_awaddr;
    logic [FABRIC_MASTERS-1:0][BURST_LEN_W-1:0]   fab_m_awlen;
    logic [FABRIC_MASTERS-1:0][2:0]               fab_m_awsize;
    logic [FABRIC_MASTERS-1:0][1:0]               fab_m_awburst;
    logic [FABRIC_MASTERS-1:0]                    fab_m_awlock;
    logic [FABRIC_MASTERS-1:0][3:0]               fab_m_awcache;
    logic [FABRIC_MASTERS-1:0][2:0]               fab_m_awprot;
    logic [FABRIC_MASTERS-1:0][3:0]               fab_m_awqos;
    logic [FABRIC_MASTERS-1:0][AXI_USER_W-1:0]    fab_m_awuser;
    logic [FABRIC_MASTERS-1:0]                    fab_m_wvalid;
    logic [FABRIC_MASTERS-1:0]                    fab_m_wready;
    logic [FABRIC_MASTERS-1:0][AXI_DATA_W-1:0]    fab_m_wdata;
    logic [FABRIC_MASTERS-1:0][AXI_DATA_W/8-1:0]  fab_m_wstrb;
    logic [FABRIC_MASTERS-1:0]                    fab_m_wlast;
    logic [FABRIC_MASTERS-1:0]                    fab_m_bvalid;
    logic [FABRIC_MASTERS-1:0]                    fab_m_bready;
    logic [FABRIC_MASTERS-1:0][AXI_ID_W-1:0]      fab_m_bid;
    logic [FABRIC_MASTERS-1:0][1:0]               fab_m_bresp;
    logic [FABRIC_MASTERS-1:0]                    fab_m_arvalid;
    logic [FABRIC_MASTERS-1:0]                    fab_m_arready;
    logic [FABRIC_MASTERS-1:0][AXI_ID_W-1:0]      fab_m_arid;
    logic [FABRIC_MASTERS-1:0][AXI_ADDR_W-1:0]    fab_m_araddr;
    logic [FABRIC_MASTERS-1:0][BURST_LEN_W-1:0]   fab_m_arlen;
    logic [FABRIC_MASTERS-1:0][2:0]               fab_m_arsize;
    logic [FABRIC_MASTERS-1:0][1:0]               fab_m_arburst;
    logic [FABRIC_MASTERS-1:0]                    fab_m_arlock;
    logic [FABRIC_MASTERS-1:0][3:0]               fab_m_arcache;
    logic [FABRIC_MASTERS-1:0][2:0]               fab_m_arprot;
    logic [FABRIC_MASTERS-1:0][3:0]               fab_m_arqos;
    logic [FABRIC_MASTERS-1:0][AXI_USER_W-1:0]    fab_m_aruser;
    logic [FABRIC_MASTERS-1:0]                    fab_m_rvalid;
    logic [FABRIC_MASTERS-1:0]                    fab_m_rready;
    logic [FABRIC_MASTERS-1:0][AXI_ID_W-1:0]      fab_m_rid;
    logic [FABRIC_MASTERS-1:0][AXI_DATA_W-1:0]    fab_m_rdata;
    logic [FABRIC_MASTERS-1:0][1:0]               fab_m_rresp;
    logic [FABRIC_MASTERS-1:0]                    fab_m_rlast;

    // Pack CHI bridge → master 0.  CHI declares 6-bit IDs; the fabric
    // uses 4-bit IDs.  Slice the bottom 4 bits.  This adapter is the
    // documented width drift between domains; see
    // `rtl/top/adapters/README.md` and docs/arch/soc-integration.md.
    assign fab_m_awvalid [0] = chi_m_awvalid;
    assign fab_m_awid    [0] = chi_m_awid[AXI_ID_W-1:0];
    assign fab_m_awaddr  [0] = chi_m_awaddr;
    assign fab_m_awlen   [0] = chi_m_awlen;
    assign fab_m_awsize  [0] = chi_m_awsize;
    assign fab_m_awburst [0] = chi_m_awburst;
    assign fab_m_awlock  [0] = chi_m_awlock;
    assign fab_m_awcache [0] = chi_m_awcache;
    assign fab_m_awprot  [0] = chi_m_awprot;
    assign fab_m_awqos   [0] = chi_m_awqos;
    assign fab_m_awuser  [0] = chi_m_awuser;
    assign chi_m_awready     = fab_m_awready[0];
    assign fab_m_wvalid  [0] = chi_m_wvalid;
    assign fab_m_wdata   [0] = chi_m_wdata;
    assign fab_m_wstrb   [0] = chi_m_wstrb;
    assign fab_m_wlast   [0] = chi_m_wlast;
    assign chi_m_wready      = fab_m_wready[0];
    assign chi_m_bvalid      = fab_m_bvalid[0];
    assign chi_m_bid         = {2'b00, fab_m_bid[0]};
    assign chi_m_bresp       = fab_m_bresp[0];
    assign fab_m_bready  [0] = chi_m_bready;
    assign fab_m_arvalid [0] = chi_m_arvalid;
    assign fab_m_arid    [0] = chi_m_arid[AXI_ID_W-1:0];
    assign fab_m_araddr  [0] = chi_m_araddr;
    assign fab_m_arlen   [0] = chi_m_arlen;
    assign fab_m_arsize  [0] = chi_m_arsize;
    assign fab_m_arburst [0] = chi_m_arburst;
    assign fab_m_arlock  [0] = chi_m_arlock;
    assign fab_m_arcache [0] = chi_m_arcache;
    assign fab_m_arprot  [0] = chi_m_arprot;
    assign fab_m_arqos   [0] = chi_m_arqos;
    assign fab_m_aruser  [0] = chi_m_aruser;
    assign chi_m_arready     = fab_m_arready[0];
    assign chi_m_rvalid      = fab_m_rvalid[0];
    assign chi_m_rid         = {2'b00, fab_m_rid[0]};
    assign chi_m_rdata       = fab_m_rdata[0];
    assign chi_m_rresp       = fab_m_rresp[0];
    assign chi_m_rlast       = fab_m_rlast[0];
    assign fab_m_rready  [0] = chi_m_rready;

    // Pack IOMMU downstream → master 1.  Same width-adapter; the IOMMU
    // is 6-bit IDs.  See `rtl/top/adapters/README.md`.
    assign fab_m_awvalid [1] = iom_d_awvalid;
    assign fab_m_awid    [1] = iom_d_awid[AXI_ID_W-1:0];
    assign fab_m_awaddr  [1] = iom_d_awaddr;
    assign fab_m_awlen   [1] = iom_d_awlen;
    assign fab_m_awsize  [1] = iom_d_awsize;
    assign fab_m_awburst [1] = iom_d_awburst;
    assign fab_m_awlock  [1] = 1'b0;
    assign fab_m_awcache [1] = iom_d_awcache;
    assign fab_m_awprot  [1] = iom_d_awprot;
    assign fab_m_awqos   [1] = iom_d_awqos;
    assign fab_m_awuser  [1] = iom_d_awuser;
    assign iom_d_awready     = fab_m_awready[1];
    assign fab_m_wvalid  [1] = iom_d_wvalid;
    assign fab_m_wdata   [1] = iom_d_wdata;
    assign fab_m_wstrb   [1] = iom_d_wstrb;
    assign fab_m_wlast   [1] = iom_d_wlast;
    assign iom_d_wready      = fab_m_wready[1];
    assign iom_d_bvalid      = fab_m_bvalid[1];
    assign iom_d_bid         = {2'b00, fab_m_bid[1]};
    assign iom_d_bresp       = fab_m_bresp[1];
    assign fab_m_bready  [1] = iom_d_bready;
    assign fab_m_arvalid [1] = iom_d_arvalid;
    assign fab_m_arid    [1] = iom_d_arid[AXI_ID_W-1:0];
    assign fab_m_araddr  [1] = iom_d_araddr;
    assign fab_m_arlen   [1] = iom_d_arlen;
    assign fab_m_arsize  [1] = iom_d_arsize;
    assign fab_m_arburst [1] = iom_d_arburst;
    assign fab_m_arlock  [1] = 1'b0;
    assign fab_m_arcache [1] = iom_d_arcache;
    assign fab_m_arprot  [1] = iom_d_arprot;
    assign fab_m_arqos   [1] = iom_d_arqos;
    assign fab_m_aruser  [1] = iom_d_aruser;
    assign iom_d_arready     = fab_m_arready[1];
    assign iom_d_rvalid      = fab_m_rvalid[1];
    assign iom_d_rid         = {2'b00, fab_m_rid[1]};
    assign iom_d_rdata       = fab_m_rdata[1];
    assign iom_d_rresp       = fab_m_rresp[1];
    assign iom_d_rlast       = fab_m_rlast[1];
    assign fab_m_rready  [1] = iom_d_rready;

    // Fabric slave arrays — packed
    localparam int unsigned WIDE_ID_W = AXI_ID_W + $clog2(FABRIC_MASTERS + 1);
    logic [FABRIC_SLAVES-1:0]                    fab_s_awvalid;
    logic [FABRIC_SLAVES-1:0]                    fab_s_awready;
    logic [FABRIC_SLAVES-1:0][WIDE_ID_W-1:0]     fab_s_awid;
    logic [FABRIC_SLAVES-1:0][AXI_ADDR_W-1:0]    fab_s_awaddr;
    logic [FABRIC_SLAVES-1:0][BURST_LEN_W-1:0]   fab_s_awlen;
    logic [FABRIC_SLAVES-1:0][2:0]               fab_s_awsize;
    logic [FABRIC_SLAVES-1:0][1:0]               fab_s_awburst;
    logic [FABRIC_SLAVES-1:0]                    fab_s_awlock;
    logic [FABRIC_SLAVES-1:0][3:0]               fab_s_awcache;
    logic [FABRIC_SLAVES-1:0][2:0]               fab_s_awprot;
    logic [FABRIC_SLAVES-1:0][3:0]               fab_s_awqos;
    logic [FABRIC_SLAVES-1:0][AXI_USER_W-1:0]    fab_s_awuser;
    logic [FABRIC_SLAVES-1:0]                    fab_s_wvalid;
    logic [FABRIC_SLAVES-1:0]                    fab_s_wready;
    logic [FABRIC_SLAVES-1:0][AXI_DATA_W-1:0]    fab_s_wdata;
    logic [FABRIC_SLAVES-1:0][AXI_DATA_W/8-1:0]  fab_s_wstrb;
    logic [FABRIC_SLAVES-1:0]                    fab_s_wlast;
    logic [FABRIC_SLAVES-1:0]                    fab_s_bvalid;
    logic [FABRIC_SLAVES-1:0]                    fab_s_bready;
    logic [FABRIC_SLAVES-1:0][WIDE_ID_W-1:0]     fab_s_bid;
    logic [FABRIC_SLAVES-1:0][1:0]               fab_s_bresp;
    logic [FABRIC_SLAVES-1:0]                    fab_s_arvalid;
    logic [FABRIC_SLAVES-1:0]                    fab_s_arready;
    logic [FABRIC_SLAVES-1:0][WIDE_ID_W-1:0]     fab_s_arid;
    logic [FABRIC_SLAVES-1:0][AXI_ADDR_W-1:0]    fab_s_araddr;
    logic [FABRIC_SLAVES-1:0][BURST_LEN_W-1:0]   fab_s_arlen;
    logic [FABRIC_SLAVES-1:0][2:0]               fab_s_arsize;
    logic [FABRIC_SLAVES-1:0][1:0]               fab_s_arburst;
    logic [FABRIC_SLAVES-1:0]                    fab_s_arlock;
    logic [FABRIC_SLAVES-1:0][3:0]               fab_s_arcache;
    logic [FABRIC_SLAVES-1:0][2:0]               fab_s_arprot;
    logic [FABRIC_SLAVES-1:0][3:0]               fab_s_arqos;
    logic [FABRIC_SLAVES-1:0][AXI_USER_W-1:0]    fab_s_aruser;
    logic [FABRIC_SLAVES-1:0]                    fab_s_rvalid;
    logic [FABRIC_SLAVES-1:0]                    fab_s_rready;
    logic [FABRIC_SLAVES-1:0][WIDE_ID_W-1:0]     fab_s_rid;
    logic [FABRIC_SLAVES-1:0][AXI_DATA_W-1:0]    fab_s_rdata;
    logic [FABRIC_SLAVES-1:0][1:0]               fab_s_rresp;
    logic [FABRIC_SLAVES-1:0]                    fab_s_rlast;

    /* verilator lint_off UNUSEDSIGNAL */
    logic [FABRIC_MASTERS-1:0]      fab_decode_err_irq;
    logic [FABRIC_MASTERS-1:0]      fab_exclusive_fail_irq;
    logic [FABRIC_MASTERS-1:0][31:0] fab_outstanding_count;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_axi4_interconnect #(
        .NUM_MASTERS (FABRIC_MASTERS),
        .NUM_SLAVES  (FABRIC_SLAVES),
        .ADDR_WIDTH  (AXI_ADDR_W),
        .DATA_WIDTH  (AXI_DATA_W),
        .ID_WIDTH    (AXI_ID_W),
        .USER_WIDTH  (AXI_USER_W),
        .MAX_OUTST   (8),
        .BURST_LEN_W (BURST_LEN_W),
        .SLAVE_BASE  ('{DRAM_BASE, UNMAP_BASE, UNMAP_BASE, UNMAP_BASE}),
        .SLAVE_MASK  ('{DRAM_MASK, UNMAP_MASK, UNMAP_MASK, UNMAP_MASK})
    ) u_fabric (
        .clk   (clk),
        .rst_n (rst_n),
        .m_awvalid (fab_m_awvalid),
        .m_awready (fab_m_awready),
        .m_awid    (fab_m_awid),
        .m_awaddr  (fab_m_awaddr),
        .m_awlen   (fab_m_awlen),
        .m_awsize  (fab_m_awsize),
        .m_awburst (fab_m_awburst),
        .m_awlock  (fab_m_awlock),
        .m_awcache (fab_m_awcache),
        .m_awprot  (fab_m_awprot),
        .m_awqos   (fab_m_awqos),
        .m_awuser  (fab_m_awuser),
        .m_wvalid  (fab_m_wvalid),
        .m_wready  (fab_m_wready),
        .m_wdata   (fab_m_wdata),
        .m_wstrb   (fab_m_wstrb),
        .m_wlast   (fab_m_wlast),
        .m_bvalid  (fab_m_bvalid),
        .m_bready  (fab_m_bready),
        .m_bid     (fab_m_bid),
        .m_bresp   (fab_m_bresp),
        .m_arvalid (fab_m_arvalid),
        .m_arready (fab_m_arready),
        .m_arid    (fab_m_arid),
        .m_araddr  (fab_m_araddr),
        .m_arlen   (fab_m_arlen),
        .m_arsize  (fab_m_arsize),
        .m_arburst (fab_m_arburst),
        .m_arlock  (fab_m_arlock),
        .m_arcache (fab_m_arcache),
        .m_arprot  (fab_m_arprot),
        .m_arqos   (fab_m_arqos),
        .m_aruser  (fab_m_aruser),
        .m_rvalid  (fab_m_rvalid),
        .m_rready  (fab_m_rready),
        .m_rid     (fab_m_rid),
        .m_rdata   (fab_m_rdata),
        .m_rresp   (fab_m_rresp),
        .m_rlast   (fab_m_rlast),
        .s_awvalid (fab_s_awvalid),
        .s_awready (fab_s_awready),
        .s_awid    (fab_s_awid),
        .s_awaddr  (fab_s_awaddr),
        .s_awlen   (fab_s_awlen),
        .s_awsize  (fab_s_awsize),
        .s_awburst (fab_s_awburst),
        .s_awlock  (fab_s_awlock),
        .s_awcache (fab_s_awcache),
        .s_awprot  (fab_s_awprot),
        .s_awqos   (fab_s_awqos),
        .s_awuser  (fab_s_awuser),
        .s_wvalid  (fab_s_wvalid),
        .s_wready  (fab_s_wready),
        .s_wdata   (fab_s_wdata),
        .s_wstrb   (fab_s_wstrb),
        .s_wlast   (fab_s_wlast),
        .s_bvalid  (fab_s_bvalid),
        .s_bready  (fab_s_bready),
        .s_bid     (fab_s_bid),
        .s_bresp   (fab_s_bresp),
        .s_arvalid (fab_s_arvalid),
        .s_arready (fab_s_arready),
        .s_arid    (fab_s_arid),
        .s_araddr  (fab_s_araddr),
        .s_arlen   (fab_s_arlen),
        .s_arsize  (fab_s_arsize),
        .s_arburst (fab_s_arburst),
        .s_arlock  (fab_s_arlock),
        .s_arcache (fab_s_arcache),
        .s_arprot  (fab_s_arprot),
        .s_arqos   (fab_s_arqos),
        .s_aruser  (fab_s_aruser),
        .s_rvalid  (fab_s_rvalid),
        .s_rready  (fab_s_rready),
        .s_rid     (fab_s_rid),
        .s_rdata   (fab_s_rdata),
        .s_rresp   (fab_s_rresp),
        .s_rlast   (fab_s_rlast),
        .decode_err_irq        (fab_decode_err_irq),
        .exclusive_fail_irq    (fab_exclusive_fail_irq),
        .outstanding_count_dbg (fab_outstanding_count),
        // The SoC integrator does not yet route an MMIO W1C writer
        // through the fabric; firmware clears the IRQ status via the
        // PLIC ack path until the dedicated MMR slave lands.
        .irq_status_clear_we               (1'b0),
        .irq_status_decode_err_clear_mask  ('0),
        .irq_status_excl_fail_clear_mask   ('0)
    );

    // ----------------------------------------------------------------------
    // DRAM controller wrapping the behavioural model.  The fabric s[0]
    // slave port attaches to `e1_dram_ctrl`, which runs the refresh / ZQ /
    // ECC schedulers and internally instantiates `e1_axi4_dram_model` as
    // the storage backing.  This exercises the DFI 5.0 north contract:
    // any transaction that reaches s[0] flows through the controller
    // scheduler before the behavioural read/write.  The DFI 5.0 south
    // boundary is held in safe-idle pending the closed-IP LPDDR PHY (see
    // `docs/evidence/memory/lpddr-phy-procurement.yaml`).
    // ----------------------------------------------------------------------
    /* verilator lint_off UNUSEDSIGNAL */
    logic [AXI_ADDR_W-1:0]    dram_dfi_addr;
    logic [3:0]               dram_dfi_bank;
    logic                     dram_dfi_cs_n;
    logic                     dram_dfi_act_n;
    logic                     dram_dfi_ras_n;
    logic                     dram_dfi_cas_n;
    logic                     dram_dfi_we_n;
    logic                     dram_dfi_reset_n;
    logic                     dram_dfi_cke;
    logic                     dram_dfi_odt;
    logic [AXI_DATA_W-1:0]    dram_dfi_wrdata;
    logic [AXI_DATA_W/8-1:0]  dram_dfi_wrdata_mask;
    logic                     dram_dfi_wrdata_en;
    logic                     dram_dfi_rddata_en;
    logic                     dram_dfi_init_start;
    logic                     dram_dfi_ctrlupd_req;
    logic                     dram_dfi_dram_clk_disable;
    logic                     dram_refresh_active;
    logic                     dram_zqcs_active;
    logic                     dram_zqcl_active;
    logic [31:0]              dram_odecc_corrected_count;
    logic [31:0]              dram_odecc_uncorrected_count;
    logic [31:0]              dram_linkecc_corrected_count;
    logic [31:0]              dram_linkecc_uncorrected_count;
    logic                     dram_ecc_uncorrected_irq;
    logic [63:0]              dram_mem_base_addr;
    logic [63:0]              dram_mem_capacity_bytes;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_dram_ctrl #(
        .ID_WIDTH       (WIDE_ID_W),
        .ADDR_WIDTH     (AXI_ADDR_W),
        .DATA_WIDTH     (AXI_DATA_W),
        .USER_WIDTH     (AXI_USER_W),
        .BURST_LEN_W    (BURST_LEN_W),
        // Compress the refresh / ZQ horizons for cocotb so scheduler edges
        // appear inside the integration test window.  Production timing
        // lives in `docs/spec-db/dram-ctrl-timing.yaml`.
        .TREFI_CYCLES   (256),
        .TRFCAB_CYCLES  (16),
        .TRFCPB_CYCLES  (8),
        .ZQCS_INTERVAL  (1024),
        .ZQCL_INTERVAL  (8192)
    ) u_dram_ctrl (
        .clk   (clk),
        .rst_n (rst_n),
        .s_awvalid (fab_s_awvalid[0]),
        .s_awready (fab_s_awready[0]),
        .s_awid    (fab_s_awid[0]),
        .s_awaddr  (fab_s_awaddr[0]),
        .s_awlen   (fab_s_awlen[0]),
        .s_awsize  (fab_s_awsize[0]),
        .s_awburst (fab_s_awburst[0]),
        .s_awlock  (fab_s_awlock[0]),
        .s_awcache (fab_s_awcache[0]),
        .s_awprot  (fab_s_awprot[0]),
        .s_awqos   (fab_s_awqos[0]),
        .s_awuser  (fab_s_awuser[0]),
        .s_wvalid  (fab_s_wvalid[0]),
        .s_wready  (fab_s_wready[0]),
        .s_wdata   (fab_s_wdata[0]),
        .s_wstrb   (fab_s_wstrb[0]),
        .s_wlast   (fab_s_wlast[0]),
        .s_bvalid  (fab_s_bvalid[0]),
        .s_bready  (fab_s_bready[0]),
        .s_bid     (fab_s_bid[0]),
        .s_bresp   (fab_s_bresp[0]),
        .s_arvalid (fab_s_arvalid[0]),
        .s_arready (fab_s_arready[0]),
        .s_arid    (fab_s_arid[0]),
        .s_araddr  (fab_s_araddr[0]),
        .s_arlen   (fab_s_arlen[0]),
        .s_arsize  (fab_s_arsize[0]),
        .s_arburst (fab_s_arburst[0]),
        .s_arlock  (fab_s_arlock[0]),
        .s_arcache (fab_s_arcache[0]),
        .s_arprot  (fab_s_arprot[0]),
        .s_arqos   (fab_s_arqos[0]),
        .s_aruser  (fab_s_aruser[0]),
        .s_rvalid  (fab_s_rvalid[0]),
        .s_rready  (fab_s_rready[0]),
        .s_rid     (fab_s_rid[0]),
        .s_rdata   (fab_s_rdata[0]),
        .s_rresp   (fab_s_rresp[0]),
        .s_rlast   (fab_s_rlast[0]),
        .dfi_addr         (dram_dfi_addr),
        .dfi_bank         (dram_dfi_bank),
        .dfi_cs_n         (dram_dfi_cs_n),
        .dfi_act_n        (dram_dfi_act_n),
        .dfi_ras_n        (dram_dfi_ras_n),
        .dfi_cas_n        (dram_dfi_cas_n),
        .dfi_we_n         (dram_dfi_we_n),
        .dfi_reset_n      (dram_dfi_reset_n),
        .dfi_cke          (dram_dfi_cke),
        .dfi_odt          (dram_dfi_odt),
        .dfi_wrdata       (dram_dfi_wrdata),
        .dfi_wrdata_mask  (dram_dfi_wrdata_mask),
        .dfi_wrdata_en    (dram_dfi_wrdata_en),
        .dfi_rddata       ('0),
        .dfi_rddata_valid (1'b0),
        .dfi_rddata_en    (dram_dfi_rddata_en),
        .dfi_init_start   (dram_dfi_init_start),
        .dfi_init_complete(1'b1),
        .dfi_ctrlupd_req  (dram_dfi_ctrlupd_req),
        .dfi_ctrlupd_ack  (1'b1),
        .dfi_dram_clk_disable     (dram_dfi_dram_clk_disable),
        .refresh_active           (dram_refresh_active),
        .zqcs_active              (dram_zqcs_active),
        .zqcl_active              (dram_zqcl_active),
        .odecc_corrected_count    (dram_odecc_corrected_count),
        .odecc_uncorrected_count  (dram_odecc_uncorrected_count),
        .linkecc_corrected_count  (dram_linkecc_corrected_count),
        .linkecc_uncorrected_count(dram_linkecc_uncorrected_count),
        .ecc_uncorrected_irq      (dram_ecc_uncorrected_irq),
        .mem_base_addr            (dram_mem_base_addr),
        .mem_capacity_bytes       (dram_mem_capacity_bytes)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_dram_dfi;
    assign unused_dram_dfi = ^{
        dram_dfi_addr, dram_dfi_bank,
        dram_dfi_cs_n, dram_dfi_act_n, dram_dfi_ras_n, dram_dfi_cas_n,
        dram_dfi_we_n, dram_dfi_reset_n, dram_dfi_cke, dram_dfi_odt,
        dram_dfi_wrdata, dram_dfi_wrdata_mask, dram_dfi_wrdata_en,
        dram_dfi_rddata_en, dram_dfi_init_start, dram_dfi_ctrlupd_req,
        dram_dfi_dram_clk_disable,
        dram_refresh_active, dram_zqcs_active, dram_zqcl_active,
        dram_odecc_corrected_count, dram_odecc_uncorrected_count,
        dram_linkecc_corrected_count, dram_linkecc_uncorrected_count,
        dram_ecc_uncorrected_irq,
        dram_mem_base_addr, dram_mem_capacity_bytes
    };
    /* verilator lint_on UNUSEDSIGNAL */

    // s[1..3] UNMAP slaves: never decoded, but the interconnect must see
    // safe idle on every port.  Reject everything with SLVERR.
    for (genvar gs = 1; gs < FABRIC_SLAVES; gs++) begin : g_unmap_slaves
        assign fab_s_awready[gs] = 1'b0;
        assign fab_s_wready[gs]  = 1'b0;
        assign fab_s_bvalid[gs]  = 1'b0;
        assign fab_s_bid[gs]     = '0;
        assign fab_s_bresp[gs]   = 2'b10;
        assign fab_s_arready[gs] = 1'b0;
        assign fab_s_rvalid[gs]  = 1'b0;
        assign fab_s_rid[gs]     = '0;
        assign fab_s_rdata[gs]   = '0;
        assign fab_s_rresp[gs]   = 2'b10;
        assign fab_s_rlast[gs]   = 1'b0;
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_unmap_slaves;
    assign unused_unmap_slaves = ^{
        fab_s_awvalid[3:1], fab_s_awid[3:1], fab_s_awaddr[3:1],
        fab_s_awlen[3:1], fab_s_awsize[3:1], fab_s_awburst[3:1],
        fab_s_awlock[3:1], fab_s_awcache[3:1], fab_s_awprot[3:1],
        fab_s_awqos[3:1], fab_s_awuser[3:1], fab_s_wvalid[3:1],
        fab_s_wdata[3:1], fab_s_wstrb[3:1], fab_s_wlast[3:1],
        fab_s_bready[3:1], fab_s_arvalid[3:1], fab_s_arid[3:1],
        fab_s_araddr[3:1], fab_s_arlen[3:1], fab_s_arsize[3:1],
        fab_s_arburst[3:1], fab_s_arlock[3:1], fab_s_arcache[3:1],
        fab_s_arprot[3:1], fab_s_arqos[3:1], fab_s_aruser[3:1],
        fab_s_rready[3:1]
    };
    /* verilator lint_on UNUSEDSIGNAL */

    // ----------------------------------------------------------------------
    // PMC (Ibex on AON) + droop / AVFS tied to safe defaults.
    // The mailbox is exposed via the MMIO aperture so a CPU master (or the
    // existing debug MMIO bridge) can post telemetry / DVFS requests.
    // ----------------------------------------------------------------------
    logic [PMC_MBOX_DW-1:0] pmc_mbox_rdata_full;
    logic                   pmc_mbox_ready_full;

    pmc_top u_pmc (
        .clk_aon              (clk_aon),
        .clk_sample           (clk_sample),
        .rst_n                (rst_n),
        .mbox_valid_i         (mmio_valid && pmc_sel),
        .mbox_write_i         (mmio_write),
        .mbox_addr_i          (mmio_addr[PMC_MBOX_AW-1:0]),
        .mbox_wdata_i         (mmio_wdata),
        .mbox_rdata_o         (pmc_mbox_rdata_full),
        .mbox_ready_o         (pmc_mbox_ready_full),
        .spmi_sclk_o          (),
        .spmi_sdata_io        (),
        .spmi_enable_o        (),
        .i2c_scl_io           (),
        .i2c_sda_io           (),
        .droop_alarm_i        ('0),
        .droop_event_count_i  ('0),
        .avfs_target_code_i   ('0),
        .avfs_raise_count_i   ('0),
        .avfs_lower_count_i   ('0),
        .avfs_fault_i         ('0),
        .dvfs_request_code_o  (),
        .dvfs_request_valid_o (),
        .pmic_enable_o        (),
        .wake_irq_o           (pmc_wake_irq_o),
        .thermal_irq_o        (pmc_thermal_irq_o)
    );

    assign pmc_mbox_rdata = pmc_mbox_rdata_full;
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_pmc_ready;
    assign unused_pmc_ready = pmc_mbox_ready_full;
    /* verilator lint_on UNUSEDSIGNAL */

    // ----------------------------------------------------------------------
    // V0 peripherals — bootrom, peripherals (timer + GPIO), DMA, NPU,
    // display, weight buffer.  Unchanged from `e1_soc_top.sv`.
    // ----------------------------------------------------------------------
    e1_bootrom u_bootrom (
        .addr  (mmio_addr[7:2]),
        .rdata (bootrom_rdata)
    );

    e1_peripherals u_peripherals (
        .clk      (clk),
        .rst_n    (rst_n),
        .valid    (mmio_valid && periph_sel),
        .write    (mmio_write),
        .addr     (mmio_addr[7:2]),
        .wdata    (mmio_wdata),
        .rdata    (periph_rdata),
        .irq_timer(irq_timer),
        .gpio_out (gpio_out)
    );

    e1_dma u_dma (
        .clk            (clk),
        .rst_n          (rst_n),
        .valid          (mmio_valid && dma_sel),
        .write          (mmio_write),
        .addr           (mmio_addr[7:2]),
        .wdata          (mmio_wdata),
        .rdata          (dma_rdata),
        .irq            (irq_dma),
        .m_axil_awvalid (dma_m_awvalid),
        .m_axil_awready (dma_m_awready),
        .m_axil_awaddr  (dma_m_awaddr),
        .m_axil_wvalid  (dma_m_wvalid),
        .m_axil_wready  (dma_m_wready),
        .m_axil_wdata   (dma_m_wdata),
        .m_axil_wstrb   (dma_m_wstrb),
        .m_axil_bvalid  (dma_m_bvalid),
        .m_axil_bready  (dma_m_bready),
        .m_axil_bresp   (dma_m_bresp),
        .m_axil_arvalid (dma_m_arvalid),
        .m_axil_arready (dma_m_arready),
        .m_axil_araddr  (dma_m_araddr),
        .m_axil_rvalid  (dma_m_rvalid),
        .m_axil_rready  (dma_m_rready),
        .m_axil_rdata   (dma_m_rdata),
        .m_axil_rresp   (dma_m_rresp)
    );

    e1_npu u_npu (
        .clk            (clk),
        .rst_n          (rst_n),
        .valid          (mmio_valid && npu_sel),
        .write          (mmio_write),
        .addr           (mmio_addr[7:2]),
        .wdata          (mmio_wdata),
        .rdata          (npu_rdata),
        .irq            (irq_npu),
        .m_axil_awvalid (npu_m_awvalid),
        .m_axil_awready (npu_m_awready),
        .m_axil_awaddr  (npu_m_awaddr),
        .m_axil_wvalid  (npu_m_wvalid),
        .m_axil_wready  (npu_m_wready),
        .m_axil_wdata   (npu_m_wdata),
        .m_axil_wstrb   (npu_m_wstrb),
        .m_axil_bvalid  (npu_m_bvalid),
        .m_axil_bready  (npu_m_bready),
        .m_axil_bresp   (npu_m_bresp),
        .m_axil_arvalid (npu_m_arvalid),
        .m_axil_arready (npu_m_arready),
        .m_axil_araddr  (npu_m_araddr),
        .m_axil_rvalid  (npu_m_rvalid),
        .m_axil_rready  (npu_m_rready),
        .m_axil_rdata   (npu_m_rdata),
        .m_axil_rresp   (npu_m_rresp)
    );

    e1_display u_display (
        .clk           (clk),
        .rst_n         (rst_n),
        .valid         (mmio_valid && display_sel),
        .write         (mmio_write),
        .addr          (mmio_addr[7:2]),
        .wdata         (mmio_wdata),
        .rdata         (display_rdata),
        .irq_vsync     (irq_vsync),
        .scan_hsync    (display_scan_hsync),
        .scan_vsync    (display_scan_vsync),
        .scan_active   (display_scan_active),
        .scan_x        (display_scan_x),
        .scan_y        (display_scan_y),
        .scan_fb_addr  (display_scan_fb_addr),
        .scan_rgb      (display_scan_rgb),
        .fb_read_valid (display_fb_read_valid),
        .fb_read_addr  (display_fb_read_addr),
        .fb_read_data  (display_fb_read_data),
        .fb_read_ready (display_fb_read_ready)
    );

    // Weight-buffer SRAM (Sky130 OpenRAM hard-macro at 0x1004_0000).
    logic [3:0]  wbuf_wmask;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [31:0] wbuf_p1_dout_unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign wbuf_wmask = {4{mmio_write}};
    e1_weight_buffer_sram u_weight_buffer (
        .clk     (clk),
        .rst_n   (rst_n),
        .p0_csb  (~(mmio_valid && wbuf_sel)),
        .p0_web  (~mmio_write),
        .p0_wmask(wbuf_wmask),
        .p0_addr (mmio_addr[10:2]),
        .p0_din  (mmio_wdata),
        .p0_dout (wbuf_rdata),
        .p1_csb  (1'b1),
        .p1_addr (9'h0),
        .p1_dout (wbuf_p1_dout_unused)
    );

    // ----------------------------------------------------------------------
    // MMIO read-data mux (v0 path; new pmc window added)
    // ----------------------------------------------------------------------
    always_comb begin
        mmio_ready = mmio_valid;
        unique case (1'b1)
            bootrom_sel:  mmio_rdata = bootrom_rdata;
            periph_sel:   mmio_rdata = periph_rdata;
            dma_sel:      mmio_rdata = dma_rdata;
            npu_sel:      mmio_rdata = npu_rdata;
            display_sel:  mmio_rdata = display_rdata;
            wbuf_sel:     mmio_rdata = wbuf_rdata;
            pmc_sel:      mmio_rdata = pmc_mbox_rdata;
            iommu_sel:    mmio_rdata = iommu_aper_rdata;
            iommu_dma_sel:mmio_rdata = iommu_dma_rdata;
            slc_sel:      mmio_rdata = slc_aper_rdata;
            clint_sel:    mmio_rdata = clint_rdata;
            dram_sel:     mmio_rdata = mmio_dram_rdata;
            default:      mmio_rdata = 32'hDEAD_BEEF;
        endcase
    end

endmodule
