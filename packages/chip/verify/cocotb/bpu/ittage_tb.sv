// ittage_tb.sv — cocotb wrapper around the standalone ITTAGE indirect predictor.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ittage_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    output logic                lkp_hit,
    output logic [VADDR_W-1:0]  lkp_target,
    output logic [ITTAGE_CTR_W-1:0] lkp_ctr,
    output logic [$clog2(ITTAGE_TABLES+1)-1:0] lkp_provider,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic [VADDR_W-1:0]  upd_target,
    input  logic                upd_misp,
    input  logic [$clog2(ITTAGE_TABLES+1)-1:0] upd_provider,

    input  logic [$clog2(ITTAGE_TABLES)-1:0] probe_table,
    input  logic [$clog2(ITTAGE_ENTRIES_4 / ITTAGE_WAYS)-1:0] probe_idx,
    output logic [ITTAGE_USEFUL_W-1:0]       probe_useful
);
    ittage #(
        .USEFUL_RESET_PERIOD(4)
    ) u_ittage (.*);

    always_comb begin
        probe_useful = '0;
        for (int unsigned way = 0; way < ITTAGE_WAYS; way++) begin
            if (u_ittage.storage_q[probe_table][probe_idx][way].useful > probe_useful)
                probe_useful = u_ittage.storage_q[probe_table][probe_idx][way].useful;
        end
    end
endmodule
