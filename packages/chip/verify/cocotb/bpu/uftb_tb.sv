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
    output logic [VADDR_W-1:0] lkp_fall_through_pc,
    output logic [2:0]         lkp_kind,
    output logic [FTB_TARGET_CONF_W-1:0] lkp_conf,
    input  logic               upd_valid,
    input  logic [VADDR_W-1:0] upd_pc,
    input  logic [VADDR_W-1:0] upd_next_pc,
    input  logic [VADDR_W-1:0] upd_fall_through_pc,
    input  logic [2:0]         upd_kind,
    input  logic               test_corrupt_parity_valid,
    input  logic [UFTB_IDX_W-1:0] test_corrupt_parity_idx,
    input  logic [$clog2(UFTB_WAYS)-1:0] test_corrupt_parity_way,
    output logic               pmu_hit
);
    br_kind_e lkp_kind_w;

    uftb u_uftb (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .lkp_context(bpu_default_context()),
        .lkp_hit    (lkp_hit),
        .lkp_next_pc(lkp_next_pc),
        .lkp_fall_through_pc(lkp_fall_through_pc),
        .lkp_kind   (lkp_kind_w),
        .lkp_conf   (lkp_conf),
        .upd_valid  (upd_valid),
        .upd_pc     (upd_pc),
        .upd_context(bpu_default_context()),
        .upd_next_pc(upd_next_pc),
        .upd_fall_through_pc(upd_fall_through_pc),
        .upd_kind   (br_kind_e'(upd_kind)),
        .flush_valid(1'b0),
        .flush_context_valid(1'b0),
        .flush_context(bpu_default_context()),
        .test_corrupt_parity_valid(test_corrupt_parity_valid),
        .test_corrupt_parity_idx(test_corrupt_parity_idx),
        .test_corrupt_parity_way(test_corrupt_parity_way),
        .pmu_hit    (pmu_hit)
    );

    assign lkp_kind = lkp_kind_w;
endmodule
