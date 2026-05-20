// uftb_tb.sv — cocotb wrapper around the standalone uFTB module.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module uftb_tb (
    input  logic               clk,
    input  logic               rst_n,
    input  logic               lkp_valid,
    input  logic [VADDR_W-1:0] lkp_pc,
    output logic               lkp_hit,
    output logic [VADDR_W-1:0] lkp_next_pc,
    input  logic               upd_valid,
    input  logic [VADDR_W-1:0] upd_pc,
    input  logic [VADDR_W-1:0] upd_next_pc,
    output logic               pmu_hit
);
    uftb u_uftb (.*);
endmodule
