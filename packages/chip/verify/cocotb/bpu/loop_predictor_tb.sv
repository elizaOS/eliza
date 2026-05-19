// loop_predictor_tb.sv — cocotb wrapper around the standalone loop predictor.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module loop_predictor_tb (
    input  logic               clk,
    input  logic               rst_n,
    input  logic               lkp_valid,
    input  logic [VADDR_W-1:0] lkp_pc,
    output logic               lkp_hit,
    output logic               lkp_taken,
    output logic               pmu_hit,
    input  logic               upd_valid,
    input  logic [VADDR_W-1:0] upd_pc,
    input  logic               upd_taken
);
    loop_predictor u_loop (.*);
endmodule
