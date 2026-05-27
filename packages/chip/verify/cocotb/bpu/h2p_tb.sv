// h2p_tb.sv - cocotb wrapper around the H2P direction sidecar.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module h2p_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    input  logic [ITTAGE_TARGET_HISTORY_BITS-1:0] lkp_target_hist,
    input  logic [ITTAGE_PATH_HISTORY_BITS-1:0] lkp_path_hist,
    output logic                lkp_override,
    output logic                lkp_taken,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic [ITTAGE_TARGET_HISTORY_BITS-1:0] upd_target_hist,
    input  logic [ITTAGE_PATH_HISTORY_BITS-1:0] upd_path_hist,
    input  logic                upd_taken,

    input  logic                test_corrupt_parity_valid,
    input  logic [VADDR_W-1:0]  test_corrupt_parity_pc,
    input  logic [$clog2(H2P_FEATURES+1)-1:0] test_corrupt_parity_feature
);
    h2p_corrector u_h2p (.*);
endmodule
