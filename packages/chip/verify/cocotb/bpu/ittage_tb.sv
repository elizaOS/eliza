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
    output logic [$clog2(ITTAGE_TABLES+1)-1:0] lkp_provider,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic [VADDR_W-1:0]  upd_target,
    input  logic                upd_misp,
    input  logic [$clog2(ITTAGE_TABLES+1)-1:0] upd_provider
);
    ittage u_ittage (.*);
endmodule
