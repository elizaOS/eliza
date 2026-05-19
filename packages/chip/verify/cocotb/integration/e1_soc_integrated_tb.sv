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
    input  bpu_resolve_t        resolve_i,
    input  logic                fetch_pop_i,
    output logic                fetch_valid_o,

    // L1I prefetch observation
    output ftq_prefetch_req_t   l1i_prefetch_req_o,
    output logic                l1i_prefetch_valid_o,
    output logic                l1i_prefetch_flush_o,

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
    output logic [31:0] iommu_fault_count_o
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
        .resolve_i            (resolve_i),
        .fetch_pop_i          (fetch_pop_i),
        .fetch_valid_o        (fetch_valid_o),
        .l1i_prefetch_req_o   (l1i_prefetch_req_o),
        .l1i_prefetch_valid_o (l1i_prefetch_valid_o),
        .l1i_prefetch_flush_o (l1i_prefetch_flush_o),
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
        .iommu_fault_count_o  (iommu_fault_count_o)
    );

endmodule
