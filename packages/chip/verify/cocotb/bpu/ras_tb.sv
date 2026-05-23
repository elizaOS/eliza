// ras_tb.sv — cocotb wrapper for the standalone RAS module.

`timescale 1ns/1ps

import bpu_pkg::*;

module ras_tb (
    input  logic               clk,
    input  logic               rst_n,
    input  logic               spec_push,
    input  logic [VADDR_W-1:0] spec_push_addr,
    input  logic               spec_pop,
    output logic [VADDR_W-1:0] spec_top_addr,
    output logic               spec_top_valid,
    output logic [RAS_IDX_W:0] spec_top_idx,
    input  logic               commit_push,
    input  logic [VADDR_W-1:0] commit_push_addr,
    input  logic               commit_pop,
    input  logic               restore_valid,
    input  logic [RAS_IDX_W:0] restore_top,
    input  logic               restore_entry_valid,
    input  logic [VADDR_W-1:0] restore_entry_addr,
    output logic               pmu_overflow,
    output logic               pmu_underflow
);
    e1_bpu_ras u_ras (.*);
endmodule
