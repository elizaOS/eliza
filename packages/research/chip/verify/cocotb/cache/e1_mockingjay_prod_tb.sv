`timescale 1ns/1ps

// e1_mockingjay_prod_tb — cocotb wrapper around e1_mockingjay_prod.
//
// Trim the module down to a small geometry (WAYS=8, SETS=64) so the
// cocotb stream loop completes in seconds. The harness drives a
// "scan + reuse" stream that classical LRU mishandles (scan flushes the
// hot working set on every pass) and expects Mockingjay to retain the
// hot set via STT/RTP feedback.
//
// The Sampled Cache Tracker is keyed by line address (set_id, tag) per
// the HPCA'22 paper section 4. The testbench exposes `acc_tag` so the
// cocotb stream can drive a distinct tag for every scan access and the
// same hot tag for repeated hot-set accesses, matching the paper's
// expected operating regime.

module e1_mockingjay_prod_tb #(
    parameter int unsigned WAYS  = 8,
    parameter int unsigned SETS  = 64,
    parameter int unsigned PC_W  = 64,
    parameter int unsigned TAG_W = 24
)(
    input  logic                       clk,
    input  logic                       rst_n,
    input  logic                       acc_valid,
    input  logic [$clog2(SETS)-1:0]    acc_set,
    input  logic                       acc_hit,
    input  logic [$clog2(WAYS)-1:0]    acc_way,
    input  logic                       acc_is_miss_install,
    input  logic [PC_W-1:0]            acc_pc,
    input  logic [TAG_W-1:0]           acc_tag,
    input  logic [$clog2(SETS)-1:0]    query_set,
    output logic [$clog2(WAYS)-1:0]    victim_way,
    output logic [31:0]                hits_count,
    output logic [31:0]                misses_count
);

    e1_mockingjay_prod #(
        .WAYS         (WAYS),
        .SETS         (SETS),
        .PC_W         (PC_W),
        .TAG_W        (TAG_W),
        .STT_WAYS     (4),
        .STT_SETS     (16),
        .RTP_ENTRIES  (64),
        .ETR_W        (3),
        .CACHE_FRIENDLY_THRESHOLD (4)
    ) u_mj (
        .clk                  (clk),
        .rst_n                (rst_n),
        .acc_valid            (acc_valid),
        .acc_set              (acc_set),
        .acc_hit              (acc_hit),
        .acc_way              (acc_way),
        .acc_is_miss_install  (acc_is_miss_install),
        .acc_pc               (acc_pc),
        .acc_tag              (acc_tag),
        .query_set            (query_set),
        .victim_way           (victim_way),
        .hits_count           (hits_count),
        .misses_count         (misses_count)
    );

endmodule : e1_mockingjay_prod_tb
