`timescale 1ns/1ps

// e1_slc_tb — cocotb wrapper around e1_slc.
//
// Flattens qos_class_e to a 3-bit logic port and unpacks the per-bank /
// per-qos way-mask arrays into flat vectors so cocotb can drive them.

/* verilator lint_off IMPORTSTAR */
import e1_cache_pkg::*;
/* verilator lint_on IMPORTSTAR */

module e1_slc_tb #(
    parameter int unsigned SIZE_BYTES  = 64 * 1024,
    parameter int unsigned WAYS        = 4,
    parameter int unsigned LINE_BYTES  = 64,
    parameter int unsigned BANKS       = 2,
    parameter int unsigned PADDR_W     = 40,
    parameter int unsigned NUM_CLIENTS = 4
)(
    input  logic                       clk,
    input  logic                       rst_n,

    input  logic                       req_valid,
    output logic                       req_ready,
    input  logic [PADDR_W-1:0]         req_paddr_line,
    input  logic                       req_is_write,
    input  logic [2:0]                 req_qos,
    input  logic [$clog2(NUM_CLIENTS)-1:0] req_client_id,
    input  logic [8*LINE_BYTES-1:0]    req_wb_data,
    output logic                       resp_valid,
    input  logic                       resp_ready,
    output logic [PADDR_W-1:0]         resp_paddr_line,
    output logic [8*LINE_BYTES-1:0]    resp_data,
    output logic [$clog2(NUM_CLIENTS)-1:0] resp_client_id,

    output logic                       dram_acq_valid,
    input  logic                       dram_acq_ready,
    output logic [PADDR_W-1:0]         dram_acq_paddr_line,
    output logic                       dram_acq_is_write,
    output logic [8*LINE_BYTES-1:0]    dram_acq_wb_data,
    input  logic                       dram_grant_valid,
    output logic                       dram_grant_ready,
    input  logic [PADDR_W-1:0]         dram_grant_paddr_line,
    input  logic [8*LINE_BYTES-1:0]    dram_grant_data,

    // Flattened config: one big vector per array
    input  logic [BANKS*WAYS-1:0]      way_enable_mask_flat,
    input  logic [8*WAYS-1:0]          way_alloc_mask_flat,
    input  logic [7:0]                 display_window_cycles,

    output logic                       hpm_slc_access,
    output logic                       hpm_slc_miss,
    output logic                       hpm_slc_display_hold,
    output logic                       hpm_slc_bdi_compress
);

    qos_class_e req_qos_e;
    assign req_qos_e = qos_class_e'(req_qos);

    // Unpack the flat way-mask vectors into the per-bank / per-qos arrays
    logic [WAYS-1:0] way_enable_mask_arr [BANKS];
    logic [WAYS-1:0] way_alloc_mask_arr  [8];
    always_comb begin
        for (int b = 0; b < BANKS; b++)
            way_enable_mask_arr[b] = way_enable_mask_flat[b*WAYS +: WAYS];
        for (int q = 0; q < 8; q++)
            way_alloc_mask_arr[q]  = way_alloc_mask_flat[q*WAYS +: WAYS];
    end

    e1_slc #(
        .SIZE_BYTES  (SIZE_BYTES),
        .WAYS        (WAYS),
        .LINE_BYTES  (LINE_BYTES),
        .BANKS       (BANKS),
        .PADDR_W     (PADDR_W),
        .NUM_CLIENTS (NUM_CLIENTS)
    ) u_slc (
        .clk                    (clk),
        .rst_n                  (rst_n),

        .req_valid              (req_valid),
        .req_ready              (req_ready),
        .req_paddr_line         (req_paddr_line),
        .req_is_write           (req_is_write),
        .req_qos                (req_qos_e),
        .req_client_id          (req_client_id),
        .req_wb_data            (req_wb_data),
        .resp_valid             (resp_valid),
        .resp_ready             (resp_ready),
        .resp_paddr_line        (resp_paddr_line),
        .resp_data              (resp_data),
        .resp_client_id         (resp_client_id),

        .dram_acq_valid         (dram_acq_valid),
        .dram_acq_ready         (dram_acq_ready),
        .dram_acq_paddr_line    (dram_acq_paddr_line),
        .dram_acq_is_write      (dram_acq_is_write),
        .dram_acq_wb_data       (dram_acq_wb_data),
        .dram_grant_valid       (dram_grant_valid),
        .dram_grant_ready       (dram_grant_ready),
        .dram_grant_paddr_line  (dram_grant_paddr_line),
        .dram_grant_data        (dram_grant_data),

        .way_enable_mask        (way_enable_mask_arr),
        .way_alloc_mask         (way_alloc_mask_arr),
        .display_window_cycles  (display_window_cycles),

        .hpm_slc_access         (hpm_slc_access),
        .hpm_slc_miss           (hpm_slc_miss),
        .hpm_slc_display_hold   (hpm_slc_display_hold),
        .hpm_slc_bdi_compress   (hpm_slc_bdi_compress)
    );

endmodule : e1_slc_tb
