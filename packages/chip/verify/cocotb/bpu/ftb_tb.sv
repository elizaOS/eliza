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
    output logic [FTB_TARGET_CONF_W-1:0] lkp_target_conf,
    output logic [VADDR_W-1:0]       lkp_fall_through_pc,
    output logic [2:0]               lkp_kind,
    output logic [MAX_BR_PER_BLOCK-1:0] lkp_br_valid,
    output logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] lkp_slot_offset,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] lkp_slot_kind,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp_slot_target,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp_slot_fall_through_pc,
    output logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] lkp_slot_target_conf,
    input  logic                     upd_valid,
    input  logic [VADDR_W-1:0]       upd_pc,
    input  logic [VADDR_W-1:0]       upd_target,
    input  logic [VADDR_W-1:0]       upd_fall_through_pc,
    input  logic [2:0]               upd_kind,
    input  logic [MAX_BR_PER_BLOCK-1:0] upd_br_valid,
    input  logic                     upd_alloc,
    input  logic                     test_corrupt_parity_valid,
    input  logic [FTB_IDX_W-1:0]     test_corrupt_parity_idx,
    input  logic [$clog2(FTB_WAYS)-1:0] test_corrupt_parity_way,
    output logic                     pmu_miss
);
    br_kind_e lkp_kind_w;
    /* verilator lint_off UNUSEDSIGNAL */
    logic                     lkp2_hit_unused;
    logic [VADDR_W-1:0]       lkp2_target_unused;
    logic [FTB_TARGET_CONF_W-1:0] lkp2_target_conf_unused;
    logic [VADDR_W-1:0]       lkp2_fall_through_pc_unused;
    br_kind_e                 lkp2_kind_unused;
    logic [MAX_BR_PER_BLOCK-1:0] lkp2_br_valid_unused;
    logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] lkp2_slot_offset_unused;
    logic [MAX_BR_PER_BLOCK-1:0][2:0] lkp2_slot_kind_unused;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp2_slot_target_unused;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp2_slot_fall_through_pc_unused;
    logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] lkp2_slot_target_conf_unused;
    /* verilator lint_on UNUSEDSIGNAL */

    ftb u_ftb (
        .clk(clk),
        .rst_n(rst_n),
        .lkp_valid(lkp_valid),
        .lkp_pc(lkp_pc),
        .lkp_context(bpu_default_context()),
        .lkp_hit(lkp_hit),
        .lkp_target(lkp_target),
        .lkp_target_conf(lkp_target_conf),
        .lkp_fall_through_pc(lkp_fall_through_pc),
        .lkp_kind(lkp_kind_w),
        .lkp_br_valid(lkp_br_valid),
        .lkp_slot_offset(lkp_slot_offset),
        .lkp_slot_kind(lkp_slot_kind),
        .lkp_slot_target(lkp_slot_target),
        .lkp_slot_fall_through_pc(lkp_slot_fall_through_pc),
        .lkp_slot_target_conf(lkp_slot_target_conf),
        .lkp2_valid(1'b0),
        .lkp2_pc('0),
        .lkp2_context(bpu_default_context()),
        .lkp2_hit(lkp2_hit_unused),
        .lkp2_target(lkp2_target_unused),
        .lkp2_target_conf(lkp2_target_conf_unused),
        .lkp2_fall_through_pc(lkp2_fall_through_pc_unused),
        .lkp2_kind(lkp2_kind_unused),
        .lkp2_br_valid(lkp2_br_valid_unused),
        .lkp2_slot_offset(lkp2_slot_offset_unused),
        .lkp2_slot_kind(lkp2_slot_kind_unused),
        .lkp2_slot_target(lkp2_slot_target_unused),
        .lkp2_slot_fall_through_pc(lkp2_slot_fall_through_pc_unused),
        .lkp2_slot_target_conf(lkp2_slot_target_conf_unused),
        .upd_valid(upd_valid),
        .upd_pc(upd_pc),
        .upd_context(bpu_default_context()),
        .upd_target(upd_target),
        .upd_fall_through_pc(upd_fall_through_pc),
        .upd_kind(br_kind_e'(upd_kind)),
        .upd_br_valid(upd_br_valid),
        .upd_alloc(upd_alloc),
        .refill_valid(1'b0),
        .refill_pc('0),
        .refill_context(bpu_default_context()),
        .refill_target('0),
        .refill_target_conf('0),
        .refill_fall_through_pc('0),
        .refill_kind(BR_NONE),
        .refill_br_valid('0),
        .refill_slot_offset('0),
        .refill_slot_kind('0),
        .refill_slot_target('0),
        .refill_slot_fall_through_pc('0),
        .refill_slot_target_conf('0),
        .flush_valid(1'b0),
        .flush_context_valid(1'b0),
        .flush_context(bpu_default_context()),
        .test_corrupt_parity_valid(test_corrupt_parity_valid),
        .test_corrupt_parity_idx(test_corrupt_parity_idx),
        .test_corrupt_parity_way(test_corrupt_parity_way),
        .pmu_miss(pmu_miss)
    );
    assign lkp_kind = lkp_kind_w;
endmodule
