`timescale 1ns/1ps

// e1_l2_tb — cocotb wrapper around e1_l2_cache.
//
// The L2 RTL ports are already plain SystemVerilog logic vectors plus the
// MESI enum. cocotb can drive the enum through its 2-bit encoding directly,
// so this wrapper is a thin pass-through that:
//   - localizes the parameter overrides used by the tests (small geometry
//     so the BMC-friendly mem arrays stay in a sane range for Verilator);
//   - flattens the `mesi_e` enum ports to `logic [1:0]` so the Python tests
//     don't need to use the cocotb enum API;
//   - elevates the `pkg::e1_cache_pkg::*` import to module scope.
//
// Geometry override: 16 KiB total / 4-way / 64 B line / 64 sets. Small but
// large enough to exercise PLRU + miss FSM without blowing up sim memory.

/* verilator lint_off IMPORTSTAR */
import e1_cache_pkg::*;
/* verilator lint_on IMPORTSTAR */

module e1_l2_tb #(
    parameter int unsigned SIZE_BYTES = 16 * 1024,
    parameter int unsigned WAYS       = 4,
    parameter int unsigned LINE_BYTES = 64,
    parameter int unsigned PADDR_W    = 40
)(
    input  logic                       clk,
    input  logic                       rst_n,

    input  logic                       l1i_acq_valid,
    output logic                       l1i_acq_ready,
    input  logic [PADDR_W-1:0]         l1i_acq_paddr_line,
    input  logic                       l1i_acq_is_prefetch,
    output logic                       l1i_grant_valid,
    input  logic                       l1i_grant_ready,
    output logic [PADDR_W-1:0]         l1i_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0]    l1i_grant_data,
    output logic [1:0]                 l1i_grant_state,

    input  logic                       l1d_acq_valid,
    output logic                       l1d_acq_ready,
    input  logic [PADDR_W-1:0]         l1d_acq_paddr_line,
    input  logic                       l1d_acq_is_write,
    input  logic [1:0]                 l1d_acq_req_state,
    input  logic [8*LINE_BYTES-1:0]    l1d_acq_wb_data,
    output logic                       l1d_grant_valid,
    input  logic                       l1d_grant_ready,
    output logic [PADDR_W-1:0]         l1d_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0]    l1d_grant_data,
    output logic [1:0]                 l1d_grant_state,

    output logic                       l3_acq_valid,
    input  logic                       l3_acq_ready,
    output logic [PADDR_W-1:0]         l3_acq_paddr_line,
    output logic                       l3_acq_is_write,
    output logic [1:0]                 l3_acq_req_state,
    output logic [8*LINE_BYTES-1:0]    l3_acq_wb_data,
    input  logic                       l3_grant_valid,
    output logic                       l3_grant_ready,
    input  logic [PADDR_W-1:0]         l3_grant_paddr_line,
    input  logic [8*LINE_BYTES-1:0]    l3_grant_data,
    input  logic [1:0]                 l3_grant_state,

    input  logic                       l3_probe_valid,
    output logic                       l3_probe_ready,
    input  logic [PADDR_W-1:0]         l3_probe_paddr_line,
    input  logic [1:0]                 l3_probe_target_state,
    output logic                       l3_probe_ack,
    output logic                       l3_probe_has_data,
    output logic [8*LINE_BYTES-1:0]    l3_probe_wb_data,
    output logic [1:0]                 l3_probe_final_state,

    output logic                       l1d_probe_valid,
    input  logic                       l1d_probe_ready,
    output logic [PADDR_W-1:0]         l1d_probe_paddr_line,
    output logic [1:0]                 l1d_probe_target_state,
    input  logic                       l1d_probe_ack,
    input  logic                       l1d_probe_has_data,
    input  logic [8*LINE_BYTES-1:0]    l1d_probe_wb_data,
    input  logic [1:0]                 l1d_probe_final_state,

    input  logic                       ptw_req_valid,
    output logic                       ptw_req_ready,
    input  logic [PADDR_W-1:0]         ptw_req_paddr,
    input  logic                       ptw_req_is_write,
    input  logic [63:0]                ptw_req_wdata,
    output logic                       ptw_resp_valid,
    output logic [63:0]                ptw_resp_data,

    output logic                       hpm_l2_access,
    output logic                       hpm_l2_miss,
    output logic                       hpm_l2_prefetch
);

    // Local enum bridges
    mesi_e l1i_grant_state_e;
    mesi_e l1d_acq_req_state_e;
    mesi_e l1d_grant_state_e;
    mesi_e l3_acq_req_state_e;
    mesi_e l3_grant_state_e;
    mesi_e l3_probe_target_state_e;
    mesi_e l3_probe_final_state_e;
    mesi_e l1d_probe_target_state_e;
    mesi_e l1d_probe_final_state_e;

    assign l1i_grant_state           = l1i_grant_state_e;
    assign l1d_acq_req_state_e       = mesi_e'(l1d_acq_req_state);
    assign l1d_grant_state           = l1d_grant_state_e;
    assign l3_acq_req_state          = l3_acq_req_state_e;
    assign l3_grant_state_e          = mesi_e'(l3_grant_state);
    assign l3_probe_target_state_e   = mesi_e'(l3_probe_target_state);
    assign l3_probe_final_state      = l3_probe_final_state_e;
    assign l1d_probe_target_state    = l1d_probe_target_state_e;
    assign l1d_probe_final_state_e   = mesi_e'(l1d_probe_final_state);

    e1_l2_cache #(
        .SIZE_BYTES (SIZE_BYTES),
        .WAYS       (WAYS),
        .LINE_BYTES (LINE_BYTES),
        .PADDR_W    (PADDR_W)
    ) u_l2 (
        .clk                    (clk),
        .rst_n                  (rst_n),

        .l1i_acq_valid          (l1i_acq_valid),
        .l1i_acq_ready          (l1i_acq_ready),
        .l1i_acq_paddr_line     (l1i_acq_paddr_line),
        .l1i_acq_is_prefetch    (l1i_acq_is_prefetch),
        .l1i_grant_valid        (l1i_grant_valid),
        .l1i_grant_ready        (l1i_grant_ready),
        .l1i_grant_paddr_line   (l1i_grant_paddr_line),
        .l1i_grant_data         (l1i_grant_data),
        .l1i_grant_state        (l1i_grant_state_e),

        .l1d_acq_valid          (l1d_acq_valid),
        .l1d_acq_ready          (l1d_acq_ready),
        .l1d_acq_paddr_line     (l1d_acq_paddr_line),
        .l1d_acq_is_write       (l1d_acq_is_write),
        .l1d_acq_req_state      (l1d_acq_req_state_e),
        .l1d_acq_wb_data        (l1d_acq_wb_data),
        .l1d_grant_valid        (l1d_grant_valid),
        .l1d_grant_ready        (l1d_grant_ready),
        .l1d_grant_paddr_line   (l1d_grant_paddr_line),
        .l1d_grant_data         (l1d_grant_data),
        .l1d_grant_state        (l1d_grant_state_e),

        .l3_acq_valid           (l3_acq_valid),
        .l3_acq_ready           (l3_acq_ready),
        .l3_acq_paddr_line      (l3_acq_paddr_line),
        .l3_acq_is_write        (l3_acq_is_write),
        .l3_acq_req_state       (l3_acq_req_state_e),
        .l3_acq_wb_data         (l3_acq_wb_data),
        .l3_grant_valid         (l3_grant_valid),
        .l3_grant_ready         (l3_grant_ready),
        .l3_grant_paddr_line    (l3_grant_paddr_line),
        .l3_grant_data          (l3_grant_data),
        .l3_grant_state         (l3_grant_state_e),

        .l3_probe_valid         (l3_probe_valid),
        .l3_probe_ready         (l3_probe_ready),
        .l3_probe_paddr_line    (l3_probe_paddr_line),
        .l3_probe_target_state  (l3_probe_target_state_e),
        .l3_probe_ack           (l3_probe_ack),
        .l3_probe_has_data      (l3_probe_has_data),
        .l3_probe_wb_data       (l3_probe_wb_data),
        .l3_probe_final_state   (l3_probe_final_state_e),

        .l1d_probe_valid        (l1d_probe_valid),
        .l1d_probe_ready        (l1d_probe_ready),
        .l1d_probe_paddr_line   (l1d_probe_paddr_line),
        .l1d_probe_target_state (l1d_probe_target_state_e),
        .l1d_probe_ack          (l1d_probe_ack),
        .l1d_probe_has_data     (l1d_probe_has_data),
        .l1d_probe_wb_data      (l1d_probe_wb_data),
        .l1d_probe_final_state  (l1d_probe_final_state_e),

        .ptw_req_valid          (ptw_req_valid),
        .ptw_req_ready          (ptw_req_ready),
        .ptw_req_paddr          (ptw_req_paddr),
        .ptw_req_is_write       (ptw_req_is_write),
        .ptw_req_wdata          (ptw_req_wdata),
        .ptw_resp_valid         (ptw_resp_valid),
        .ptw_resp_data          (ptw_resp_data),

        .hpm_l2_access          (hpm_l2_access),
        .hpm_l2_miss            (hpm_l2_miss),
        .hpm_l2_prefetch        (hpm_l2_prefetch)
    );

endmodule : e1_l2_tb
