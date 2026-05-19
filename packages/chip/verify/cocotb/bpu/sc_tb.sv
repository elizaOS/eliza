// sc_tb.sv — cocotb wrapper around the standalone Statistical Corrector.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module sc_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    input  logic                lkp_tage_taken,
    input  logic                lkp_tage_lowconf,
    output logic                lkp_override,
    output logic                lkp_taken,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic                upd_taken,
    input  logic                upd_tage_lowconf
);
    sc u_sc (.*);
endmodule
