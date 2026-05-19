// ftb_tb.sv — cocotb wrapper around the standalone FTB module.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ftb_tb (
    input  logic                     clk,
    input  logic                     rst_n,
    input  logic                     lkp_valid,
    input  logic [VADDR_W-1:0]       lkp_pc,
    output logic                     lkp_hit,
    output logic [VADDR_W-1:0]       lkp_target,
    output logic [1:0]               lkp_kind,
    output logic [MAX_BR_PER_BLOCK-1:0] lkp_br_valid,
    input  logic                     upd_valid,
    input  logic [VADDR_W-1:0]       upd_pc,
    input  logic [VADDR_W-1:0]       upd_target,
    input  logic [1:0]               upd_kind,
    input  logic [MAX_BR_PER_BLOCK-1:0] upd_br_valid,
    input  logic                     upd_alloc,
    output logic                     pmu_miss
);
    br_kind_e lkp_kind_w;
    ftb u_ftb (
        .clk(clk),
        .rst_n(rst_n),
        .lkp_valid(lkp_valid),
        .lkp_pc(lkp_pc),
        .lkp_hit(lkp_hit),
        .lkp_target(lkp_target),
        .lkp_kind(lkp_kind_w),
        .lkp_br_valid(lkp_br_valid),
        .upd_valid(upd_valid),
        .upd_pc(upd_pc),
        .upd_target(upd_target),
        .upd_kind(br_kind_e'(upd_kind)),
        .upd_br_valid(upd_br_valid),
        .upd_alloc(upd_alloc),
        .pmu_miss(pmu_miss)
    );
    assign lkp_kind = lkp_kind_w;
endmodule
