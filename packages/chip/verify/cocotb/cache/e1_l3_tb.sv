`timescale 1ns/1ps

// e1_l3_tb — cocotb wrapper around e1_l3_cache.
//
// Flattens mesi_e and qos_class_e ports to plain logic vectors. The L3 RTL
// is parameterized over banks/ways/sets; a small geometry is used for
// cocotb so the BMC-friendly arrays stay in a sane range for Verilator.
//
// NUM_L2 is fixed at 2 here so the cocotb tests can exercise the
// multi-master directory path (probe-mask, snoop-filter) without dragging
// in the full interconnect.

/* verilator lint_off IMPORTSTAR */
import e1_cache_pkg::*;
/* verilator lint_on IMPORTSTAR */

module e1_l3_tb #(
    parameter int unsigned SIZE_BYTES = 64 * 1024,
    parameter int unsigned WAYS       = 4,
    parameter int unsigned LINE_BYTES = 64,
    parameter int unsigned BANKS      = 2,
    parameter int unsigned NUM_L2     = 2,
    parameter int unsigned PADDR_W    = 40
)(
    input  logic                       clk,
    input  logic                       rst_n,

    input  logic                       l2_acq_valid,
    output logic                       l2_acq_ready,
    input  logic [PADDR_W-1:0]         l2_acq_paddr_line,
    input  logic                       l2_acq_is_write,
    input  logic [1:0]                 l2_acq_req_state,
    input  logic [8*LINE_BYTES-1:0]    l2_acq_wb_data,
    input  logic                       l2_acq_source_id,

    output logic                       l2_grant_valid,
    input  logic                       l2_grant_ready,
    output logic [PADDR_W-1:0]         l2_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0]    l2_grant_data,
    output logic [1:0]                 l2_grant_state,
    output logic                       l2_grant_source_id,

    output logic                       l2_probe_valid,
    input  logic                       l2_probe_ready,
    output logic [PADDR_W-1:0]         l2_probe_paddr_line,
    output logic [1:0]                 l2_probe_target_state,
    output logic [NUM_L2-1:0]          l2_probe_mask,
    input  logic                       l2_probe_ack,
    input  logic                       l2_probe_has_data,
    input  logic [8*LINE_BYTES-1:0]    l2_probe_wb_data,
    input  logic [1:0]                 l2_probe_final_state,

    output logic                       slc_acq_valid,
    input  logic                       slc_acq_ready,
    output logic [PADDR_W-1:0]         slc_acq_paddr_line,
    output logic                       slc_acq_is_write,
    output logic [2:0]                 slc_acq_qos,
    output logic [8*LINE_BYTES-1:0]    slc_acq_wb_data,
    input  logic                       slc_grant_valid,
    output logic                       slc_grant_ready,
    input  logic [PADDR_W-1:0]         slc_grant_paddr_line,
    input  logic [8*LINE_BYTES-1:0]    slc_grant_data,

    output logic                       hpm_l3_access,
    output logic                       hpm_l3_miss,
    output logic                       hpm_l3_snoop_hit,
    output logic                       hpm_l3_writeback
);

    mesi_e       l2_acq_req_state_e;
    mesi_e       l2_grant_state_e;
    mesi_e       l2_probe_target_state_e;
    mesi_e       l2_probe_final_state_e;
    qos_class_e  slc_acq_qos_e;

    assign l2_acq_req_state_e     = mesi_e'(l2_acq_req_state);
    assign l2_grant_state         = l2_grant_state_e;
    assign l2_probe_target_state  = l2_probe_target_state_e;
    assign l2_probe_final_state_e = mesi_e'(l2_probe_final_state);
    assign slc_acq_qos            = slc_acq_qos_e;

    e1_l3_cache #(
        .SIZE_BYTES (SIZE_BYTES),
        .WAYS       (WAYS),
        .LINE_BYTES (LINE_BYTES),
        .BANKS      (BANKS),
        .NUM_L2     (NUM_L2),
        .PADDR_W    (PADDR_W),
        .REPLACEMENT_POLICY (2'd0) // DRRIP/SRRIP path; pick_victim uses RRPV
    ) u_l3 (
        .clk                    (clk),
        .rst_n                  (rst_n),

        .l2_acq_valid           (l2_acq_valid),
        .l2_acq_ready           (l2_acq_ready),
        .l2_acq_paddr_line      (l2_acq_paddr_line),
        .l2_acq_is_write        (l2_acq_is_write),
        .l2_acq_req_state       (l2_acq_req_state_e),
        .l2_acq_wb_data         (l2_acq_wb_data),
        .l2_acq_source_id       (l2_acq_source_id),

        .l2_grant_valid         (l2_grant_valid),
        .l2_grant_ready         (l2_grant_ready),
        .l2_grant_paddr_line    (l2_grant_paddr_line),
        .l2_grant_data          (l2_grant_data),
        .l2_grant_state         (l2_grant_state_e),
        .l2_grant_source_id     (l2_grant_source_id),

        .l2_probe_valid         (l2_probe_valid),
        .l2_probe_ready         (l2_probe_ready),
        .l2_probe_paddr_line    (l2_probe_paddr_line),
        .l2_probe_target_state  (l2_probe_target_state_e),
        .l2_probe_mask          (l2_probe_mask),
        .l2_probe_ack           (l2_probe_ack),
        .l2_probe_has_data      (l2_probe_has_data),
        .l2_probe_wb_data       (l2_probe_wb_data),
        .l2_probe_final_state   (l2_probe_final_state_e),

        .slc_acq_valid          (slc_acq_valid),
        .slc_acq_ready          (slc_acq_ready),
        .slc_acq_paddr_line     (slc_acq_paddr_line),
        .slc_acq_is_write       (slc_acq_is_write),
        .slc_acq_qos            (slc_acq_qos_e),
        .slc_acq_wb_data        (slc_acq_wb_data),
        .slc_grant_valid        (slc_grant_valid),
        .slc_grant_ready        (slc_grant_ready),
        .slc_grant_paddr_line   (slc_grant_paddr_line),
        .slc_grant_data         (slc_grant_data),

        .hpm_l3_access          (hpm_l3_access),
        .hpm_l3_miss            (hpm_l3_miss),
        .hpm_l3_snoop_hit       (hpm_l3_snoop_hit),
        .hpm_l3_writeback       (hpm_l3_writeback)
    );

endmodule : e1_l3_tb
