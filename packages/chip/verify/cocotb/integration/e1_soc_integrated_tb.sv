`timescale 1ns/1ps

// e1_soc_integrated_tb
//
// Synthesizable cocotb harness for `e1_soc_integrated`.  Drives a single
// clock to the SoC `clk`, `clk_aon`, and `clk_sample` ports (cocotb is not
// multi-clock-domain at this layer; the AON / sample domains are exercised
// off the same edge as the main clk).  This is acceptable for structural
// integration verification — the timing relationships between the AON and
// main rails belong in `verify/cocotb/power/`.
//
// All cross-domain ports of e1_soc_integrated are routed to the harness
// top so the integration cocotb tests can drive / observe them directly.

module e1_soc_integrated_tb
    import e1_ftq_to_l1i_pkg::*;
    import bpu_pkg::*;
(
    input  logic        clk,
    input  logic        rst_n,

    // Same v0 MMIO aperture
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,
    output logic [31:0] mmio_rdata,
    output logic        mmio_ready,

    output logic        irq_timer,
    output logic        irq_dma,
    output logic        irq_npu,
    output logic        irq_vsync,
    output logic        msip_o,
    output logic        mtip_o,
    output logic [7:0]  gpio_out,

    // BPU surface
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

    // L1I prefetch observation
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
    output logic                slc_dram_acq_valid_o,
    output logic                slc_dram_grant_valid_o,

    // Zihpm CSR observation
    input  logic        zihpm_csr_we_i,
    input  logic [11:0] zihpm_csr_addr_i,
    input  logic [63:0] zihpm_csr_wdata_i,
    input  logic [11:0] zihpm_csr_raddr_i,
    output logic [63:0] zihpm_csr_rdata_o,
    output logic        zihpm_csr_rvalid_o,
    input  logic        zihpm_instret_pulse_i,

    output logic        pmc_wake_irq_o,
    output logic        pmc_thermal_irq_o,

    output logic        iommu_fault_irq_o,
    output logic [31:0] iommu_fault_count_o,

    // CVA6 slot-0 in-band SoC traffic counters + boot-ROM mirrors.  Surfaced
    // unconditionally so the cocotb in-band SoC boot test (run with
    // `+define+E1_CLUSTER_SLOT0_CVA6`) can read them; when the define is
    // off the DUT drives them to zero.
    output logic [31:0]  cva6_slot0_ar_xfers_o,
    output logic [31:0]  cva6_slot0_aw_xfers_o,
    output logic [31:0]  cva6_slot0_w_xfers_o,
    output logic [31:0]  cva6_slot0_r_xfers_o,
    output logic [31:0]  cva6_slot0_b_xfers_o,
    output logic [127:0] cva6_slot0_rom_word0_o,
    output logic [127:0] cva6_slot0_rom_word1_o,
    output logic [127:0] cva6_slot0_rom_word2_o
);

    e1_soc_integrated u_soc (
        .clk                  (clk),
        .clk_aon              (clk),
        .clk_sample           (clk),
        .rst_n                (rst_n),
        .mmio_valid           (mmio_valid),
        .mmio_write           (mmio_write),
        .mmio_addr            (mmio_addr),
        .mmio_wdata           (mmio_wdata),
        .mmio_rdata           (mmio_rdata),
        .mmio_ready           (mmio_ready),
        .irq_timer            (irq_timer),
        .irq_dma              (irq_dma),
        .irq_npu              (irq_npu),
        .irq_vsync            (irq_vsync),
        .msip_o               (msip_o),
        .mtip_o               (mtip_o),
        .gpio_out             (gpio_out),
        .lkp_valid_i          (lkp_valid_i),
        .lkp_pc_i             (lkp_pc_i),
        .pred_valid_o         (pred_valid_o),
        .pred_redirect_valid_o(pred_redirect_valid_o),
        .pred_redirect_pc_o   (pred_redirect_pc_o),
        .resolve_i            (resolve_i),
        .fetch_pop_i          (fetch_pop_i),
        .fetch_valid_o        (fetch_valid_o),
        .fetch_stream_ready_i (fetch_stream_ready_i),
        .fetch_stream_valid_o (fetch_stream_valid_o),
        .fetch_stream_pc_o    (fetch_stream_pc_o),
        .fetch_stream_target_pc_o(fetch_stream_target_pc_o),
        .fetch_stream_ftq_idx_o(fetch_stream_ftq_idx_o),
        .fetch_stream_segment_idx_o(fetch_stream_segment_idx_o),
        .fetch_stream_taken_o (fetch_stream_taken_o),
        .fetch_stream_kind_o  (fetch_stream_kind_o),
        .l1i_demand_enable_i  (l1i_demand_enable_i),
        .l1i_demand_valid_o   (l1i_demand_valid_o),
        .l1i_demand_ready_i   (l1i_demand_ready_i),
        .l1i_demand_paddr_o   (l1i_demand_paddr_o),
        .l1i_demand_ftq_idx_o (l1i_demand_ftq_idx_o),
        .l1i_demand_segment_idx_o(l1i_demand_segment_idx_o),
        .l1i_demand_kind_o    (l1i_demand_kind_o),
        .l1i_demand_valid_lane1_o(l1i_demand_valid_lane1_o),
        .l1i_demand_ready_lane1_i(l1i_demand_ready_lane1_i),
        .l1i_demand_paddr_lane1_o(l1i_demand_paddr_lane1_o),
        .l1i_demand_ftq_idx_lane1_o(l1i_demand_ftq_idx_lane1_o),
        .l1i_demand_segment_idx_lane1_o(l1i_demand_segment_idx_lane1_o),
        .l1i_demand_kind_lane1_o(l1i_demand_kind_lane1_o),
        .l1i_demand_occupancy_o(l1i_demand_occupancy_o),
        .l1i_demand_overflow_o(l1i_demand_overflow_o),
        .late_redirect_valid_o(late_redirect_valid_o),
        .late_redirect_pc_o   (late_redirect_pc_o),
        .late_redirect_ftq_idx_o(late_redirect_ftq_idx_o),
        .late_redirect_valid_lanes_o(late_redirect_valid_lanes_o),
        .late_redirect_pc_lanes_o(late_redirect_pc_lanes_o),
        .late_redirect_ftq_idx_lanes_o(late_redirect_ftq_idx_lanes_o),
        .l1i_prefetch_req_o   (l1i_prefetch_req_o),
        .l1i_prefetch_valid_o (l1i_prefetch_valid_o),
        .l1i_prefetch_flush_o (l1i_prefetch_flush_o),
        .l1i_cache_resp_valid_o(l1i_cache_resp_valid_o),
        .l1i_cache_resp_valid_lane1_o(l1i_cache_resp_valid_lane1_o),
        .l1i_cache_miss_valid_o(l1i_cache_miss_valid_o),
        .l1i_cache_miss_valid_lane1_o(l1i_cache_miss_valid_lane1_o),
        .l1i_l2_acq_valid_o   (l1i_l2_acq_valid_o),
        .l1i_l2_active_lane1_o(l1i_l2_active_lane1_o),
        .l2_l3_acq_valid_o    (l2_l3_acq_valid_o),
        .l2_l3_grant_valid_o  (l2_l3_grant_valid_o),
        .slc_dram_acq_valid_o (slc_dram_acq_valid_o),
        .slc_dram_grant_valid_o(slc_dram_grant_valid_o),
        .zihpm_csr_we_i       (zihpm_csr_we_i),
        .zihpm_csr_addr_i     (zihpm_csr_addr_i),
        .zihpm_csr_wdata_i    (zihpm_csr_wdata_i),
        .zihpm_csr_raddr_i    (zihpm_csr_raddr_i),
        .zihpm_csr_rdata_o    (zihpm_csr_rdata_o),
        .zihpm_csr_rvalid_o   (zihpm_csr_rvalid_o),
        .zihpm_instret_pulse_i(zihpm_instret_pulse_i),
        .pmc_wake_irq_o       (pmc_wake_irq_o),
        .pmc_thermal_irq_o    (pmc_thermal_irq_o),
        .iommu_fault_irq_o    (iommu_fault_irq_o),
        .iommu_fault_count_o  (iommu_fault_count_o),
        .cva6_slot0_ar_xfers_o (cva6_slot0_ar_xfers_o),
        .cva6_slot0_aw_xfers_o (cva6_slot0_aw_xfers_o),
        .cva6_slot0_w_xfers_o  (cva6_slot0_w_xfers_o),
        .cva6_slot0_r_xfers_o  (cva6_slot0_r_xfers_o),
        .cva6_slot0_b_xfers_o  (cva6_slot0_b_xfers_o),
        .cva6_slot0_rom_word0_o (cva6_slot0_rom_word0_o),
        .cva6_slot0_rom_word1_o (cva6_slot0_rom_word1_o),
        .cva6_slot0_rom_word2_o (cva6_slot0_rom_word2_o)
    );

endmodule
