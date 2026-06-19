`timescale 1ns/1ps

module e1_l1i_dual_miss_to_l2_tb
    import e1_cache_pkg::*;
(
    input  logic        clk,
    input  logic        rst_n,
    input  logic        flush_i,

    input  logic        miss_valid_i,
    output logic        miss_ready_o,
    input  logic [39:0] miss_paddr_line_i,
    input  logic        miss_is_prefetch_i,

    input  logic        miss_valid_lane1_i,
    output logic        miss_ready_lane1_o,
    input  logic [39:0] miss_paddr_line_lane1_i,
    input  logic        miss_is_prefetch_lane1_i,

    output logic        l2_l1i_acq_valid_o,
    input  logic        l2_l1i_acq_ready_i,
    output logic [39:0] l2_l1i_acq_paddr_line_o,
    output logic        l2_l1i_acq_is_prefetch_o,

    input  logic        l2_l1i_grant_valid_i,
    output logic        l2_l1i_grant_ready_o,
    input  logic [39:0] l2_l1i_grant_paddr_line_i,
    input  logic [511:0] l2_l1i_grant_data_i,

    output logic        refill_valid_o,
    input  logic        refill_ready_i,
    output logic [127:0] refill_data_o,
    output logic [1:0]  refill_beat_idx_o,
    output logic        refill_last_o,

    output logic        refill_valid_lane1_o,
    input  logic        refill_ready_lane1_i,
    output logic [127:0] refill_data_lane1_o,
    output logic [1:0]  refill_beat_idx_lane1_o,
    output logic        refill_last_lane1_o,

    output logic        busy_o,
    output logic        active_lane1_o
);
    e1_l1i_dual_miss_to_l2 #(
        .LINE_BYTES(64),
        .PADDR_W(40)
    ) dut (
        .clk                         (clk),
        .rst_n                       (rst_n),
        .flush_i                     (flush_i),
        .miss_valid_i                (miss_valid_i),
        .miss_ready_o                (miss_ready_o),
        .miss_paddr_line_i           (miss_paddr_line_i),
        .miss_is_prefetch_i          (miss_is_prefetch_i),
        .miss_valid_lane1_i          (miss_valid_lane1_i),
        .miss_ready_lane1_o          (miss_ready_lane1_o),
        .miss_paddr_line_lane1_i     (miss_paddr_line_lane1_i),
        .miss_is_prefetch_lane1_i    (miss_is_prefetch_lane1_i),
        .l2_l1i_acq_valid_o          (l2_l1i_acq_valid_o),
        .l2_l1i_acq_ready_i          (l2_l1i_acq_ready_i),
        .l2_l1i_acq_paddr_line_o     (l2_l1i_acq_paddr_line_o),
        .l2_l1i_acq_is_prefetch_o    (l2_l1i_acq_is_prefetch_o),
        .l2_l1i_grant_valid_i        (l2_l1i_grant_valid_i),
        .l2_l1i_grant_ready_o        (l2_l1i_grant_ready_o),
        .l2_l1i_grant_paddr_line_i   (l2_l1i_grant_paddr_line_i),
        .l2_l1i_grant_data_i         (l2_l1i_grant_data_i),
        .l2_l1i_grant_state_i        (MESI_S),
        .refill_valid_o              (refill_valid_o),
        .refill_ready_i              (refill_ready_i),
        .refill_data_o               (refill_data_o),
        .refill_beat_idx_o           (refill_beat_idx_o),
        .refill_last_o               (refill_last_o),
        .refill_valid_lane1_o        (refill_valid_lane1_o),
        .refill_ready_lane1_i        (refill_ready_lane1_i),
        .refill_data_lane1_o         (refill_data_lane1_o),
        .refill_beat_idx_lane1_o     (refill_beat_idx_lane1_o),
        .refill_last_lane1_o         (refill_last_lane1_o),
        .busy_o                      (busy_o),
        .active_lane1_o              (active_lane1_o)
    );
endmodule
