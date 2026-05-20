// ftq_tb.sv — cocotb wrapper around the FTQ.
//
// Flattens the ftq_entry_t structure into raw vectors on the push and pop
// ports so cocotb tests can drive and observe entries without depending on
// the Verilator+VPI struct interface.

`timescale 1ns/1ps

import bpu_pkg::*;

module ftq_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                push_valid,
    input  logic [VADDR_W-1:0]  push_start_pc,
    input  logic [VADDR_W-1:0]  push_end_pc,
    input  logic [VADDR_W-1:0]  push_target_pc,
    input  logic                push_taken,
    input  logic [2:0]          push_kind,
    output logic                push_ready,

    input  logic                pop_ready,
    output logic                pop_valid,
    output logic [VADDR_W-1:0]  pop_start_pc,
    output logic [VADDR_W-1:0]  pop_target_pc,
    output logic                pop_taken,
    output logic [2:0]          pop_kind,
    output logic [FTQ_IDX_W-1:0] pop_ftq_idx,

    input  logic                flush_valid,
    input  logic [FTQ_IDX_W-1:0] flush_idx,

    output logic                pmu_full,
    output logic                pmu_empty,
    output logic [FTQ_IDX_W:0]  occupancy
);

    ftq_entry_t push_w;
    ftq_entry_t pop_w;

    always_comb begin
        push_w               = '0;
        push_w.valid         = push_valid;
        push_w.start_pc      = push_start_pc;
        push_w.end_pc        = push_end_pc;
        push_w.target_pc     = push_target_pc;
        push_w.taken         = push_taken;
        push_w.kind          = br_kind_e'(push_kind);
        push_w.br_taken_mask = {{(MAX_BR_PER_BLOCK-1){1'b0}}, push_taken};
    end

    ftq u_ftq (
        .clk        (clk),
        .rst_n      (rst_n),
        .push_valid (push_valid),
        .push_entry (push_w),
        .push_ready (push_ready),
        .pop_ready  (pop_ready),
        .pop_valid  (pop_valid),
        .pop_entry  (pop_w),
        .flush_valid(flush_valid),
        .flush_idx  (flush_idx),
        .pmu_full   (pmu_full),
        .pmu_empty  (pmu_empty),
        .occupancy  (occupancy)
    );

    assign pop_start_pc  = pop_w.start_pc;
    assign pop_target_pc = pop_w.target_pc;
    assign pop_taken     = pop_w.taken;
    assign pop_kind      = pop_w.kind;
    assign pop_ftq_idx   = pop_w.ftq_idx;
endmodule
