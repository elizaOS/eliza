`timescale 1ns/1ps

// e1_l3_replacement_tb
//
// Distinctness harness for the three L3 replacement sub-modules the
// e1_l3_cache delegates to (DRRIP, Hawkeye, Mockingjay-prod). All three
// observe the SAME access-event stream and expose their independent
// victim_way for the SAME query set, so a single simulation proves that
// REPLACEMENT_POLICY selects genuinely different policies rather than a
// silent PLRU fallback.
//
// Geometry is trimmed (WAYS=8, SETS=64) so the per-way state arrays stay
// small for Verilator. The access bus mirrors the e1_l3_cache wiring:
// constant (zero) PC at the L3 directory boundary, line-address tag fed to
// Mockingjay's STT.

module e1_l3_replacement_tb #(
    parameter int unsigned WAYS  = 8,
    parameter int unsigned SETS  = 64,
    parameter int unsigned TAG_W = 24
)(
    input  logic                       clk,
    input  logic                       rst_n,

    input  logic                       acc_valid,
    input  logic [$clog2(SETS)-1:0]    acc_set,
    input  logic                       acc_hit,
    input  logic [$clog2(WAYS)-1:0]    acc_way,
    input  logic                       acc_is_miss_install,
    input  logic [TAG_W-1:0]           acc_tag,

    input  logic [$clog2(SETS)-1:0]    query_set,
    output logic [$clog2(WAYS)-1:0]    drrip_victim,
    output logic [$clog2(WAYS)-1:0]    hawkeye_victim,
    output logic [$clog2(WAYS)-1:0]    mockingjay_victim
);

    /* verilator lint_off UNUSEDSIGNAL */
    logic [31:0] mj_hits;
    logic [31:0] mj_misses;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_drrip #(
        .WAYS (WAYS),
        .SETS (SETS)
    ) u_drrip (
        .clk                 (clk),
        .rst_n               (rst_n),
        .acc_valid           (acc_valid),
        .acc_set             (acc_set),
        .acc_hit             (acc_hit),
        .acc_way             (acc_way),
        .acc_is_miss_install (acc_is_miss_install),
        .query_set           (query_set),
        .victim_way          (drrip_victim)
    );

    e1_hawkeye #(
        .WAYS (WAYS),
        .SETS (SETS)
    ) u_hawkeye (
        .clk                 (clk),
        .rst_n               (rst_n),
        .acc_valid           (acc_valid),
        .acc_set             (acc_set),
        .acc_hit             (acc_hit),
        .acc_way             (acc_way),
        .acc_is_miss_install (acc_is_miss_install),
        .acc_pc              ('0),
        .query_set           (query_set),
        .victim_way          (hawkeye_victim)
    );

    e1_mockingjay_prod #(
        .WAYS (WAYS),
        .SETS (SETS),
        .TAG_W (TAG_W)
    ) u_mockingjay (
        .clk                 (clk),
        .rst_n               (rst_n),
        .acc_valid           (acc_valid),
        .acc_set             (acc_set),
        .acc_hit             (acc_hit),
        .acc_way             (acc_way),
        .acc_is_miss_install (acc_is_miss_install),
        .acc_pc              ('0),
        .acc_tag             (acc_tag),
        .query_set           (query_set),
        .victim_way          (mockingjay_victim),
        .hits_count          (mj_hits),
        .misses_count        (mj_misses)
    );

endmodule : e1_l3_replacement_tb
