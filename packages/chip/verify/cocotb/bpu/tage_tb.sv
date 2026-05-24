// tage_tb.sv — cocotb wrapper around the standalone TAGE direction predictor.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module tage_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    output logic                lkp_taken,
    output logic                lkp_taken_alt,
    output logic [TAGE_TABLES:0] lkp_hit_vec,
    output logic [$clog2(TAGE_TABLES+1)-1:0] lkp_provider,
    output logic                lkp_provider_taken,
    output logic [TAGE_CTR_W-1:0] lkp_provider_ctr,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic                upd_taken,
    input  logic                upd_misp,
    input  logic [$clog2(TAGE_TABLES+1)-1:0] upd_provider,
    input  logic                upd_provider_taken,
    input  logic                upd_alt_taken,
    input  logic                upd_provider_weak,

    input  logic                useful_reset_lsb,
    input  logic                useful_reset_msb,

    output logic                pmu_alloc
);
    tage u_tage (.*);
endmodule
