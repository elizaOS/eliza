// SPDX-License-Identifier: Apache-2.0
//
// Formal top for the cache-coherence SWMR proof. Unlike the abstract witness
// that preceded it, this harness instantiates the *real* MESI directory RTL
// (`rtl/cache/coherence/e1_coherence_dir.sv`) with two cores and leaves every
// request / probe / grant channel free for the BMC engine. The bound property
// pack (`e1_coherence_dir_swmr_props.sv`) then proves the protocol itself keeps
// the SWMR invariant on the directory's authoritative coherence record -- it is
// not assumed.
//
// The directory's driving inputs are exposed as primary input PORTS of this
// top. SymbiYosys drives top-level input ports with a fresh free value every
// cycle, so the engine explores every acquire / release / probe-ack /
// grant-ready interleaving the directory's ready/valid handshakes admit. (An
// undriven internal wire would instead be optimised to a constant, which would
// silently make the proof vacuous -- hence the inputs must be ports.)
//
// Sizing: the SWMR invariant is per-directory-line and independent of the line
// width, so LINE_BYTES / PADDR_W / DIR_LINES are shrunk to keep BMC tractable
// while NUM_CORES stays at 2 (the dimension SWMR is about). DIR_LINES = 2 lets
// the engine pick conflicting and non-conflicting directory sets.

module e1_coherence_dir_formal
    import e1_cache_pkg::*;
#(
    parameter int unsigned NUM_CORES   = 2,
    parameter int unsigned PADDR_W     = 12,
    parameter int unsigned LINE_BYTES  = 4,
    parameter int unsigned DIR_LINES   = 2,
    parameter int unsigned NUM_DOMAINS = 2,
    localparam int unsigned LINE_BITS  = 8 * LINE_BYTES,
    localparam int unsigned DOM_W      = (NUM_DOMAINS > 1) ? $clog2(NUM_DOMAINS) : 1
) (
    input logic clk,

    // Free directory inputs (driven by the BMC engine).
    input logic [NUM_CORES-1:0]    acq_valid,
    input logic [PADDR_W-1:0]      acq_paddr_line    [NUM_CORES],
    input logic [NUM_CORES-1:0]    acq_is_write,
    input mesi_e                   acq_req_state     [NUM_CORES],
    input logic [LINE_BITS-1:0]    acq_wb_data       [NUM_CORES],
    input logic [DOM_W-1:0]        acq_domain        [NUM_CORES],
    input logic [NUM_CORES-1:0]    grant_ready,
    input logic [NUM_CORES-1:0]    probe_ready,
    input logic [NUM_CORES-1:0]    probe_ack,
    input logic [NUM_CORES-1:0]    probe_has_data,
    input logic [LINE_BITS-1:0]    probe_wb_data     [NUM_CORES],
    input mesi_e                   probe_final_state [NUM_CORES],
    input logic                    flush_req,
    input logic [DOM_W-1:0]        flush_domain
);
    // Deterministic power-on reset. `rst_cnt_q` starts at 0 (slang + smtbmc
    // honour the `initial` value of a register that has no async reset), holds
    // the directory in reset for the first two cycles, then releases it for the
    // rest of the proof. Starting from a real reset state installs the legal
    // MESI_I coherence record so the SWMR assertions police the protocol's
    // steady-state behaviour rather than illegal `anyinit` start values.
    logic [1:0] rst_cnt_q = 2'd0;
    logic       rst_n;
    always_ff @(posedge clk) begin
        if (rst_cnt_q != 2'd3) rst_cnt_q <= rst_cnt_q + 2'd1;
    end
    assign rst_n = (rst_cnt_q >= 2'd2);

    // Directory outputs (observed, unconstrained).
    logic [NUM_CORES-1:0]    acq_ready;
    logic [NUM_CORES-1:0]    grant_valid;
    logic [PADDR_W-1:0]      grant_paddr_line [NUM_CORES];
    logic [LINE_BITS-1:0]    grant_data       [NUM_CORES];
    mesi_e                   grant_state      [NUM_CORES];
    logic [NUM_CORES-1:0]    probe_valid;
    logic [PADDR_W-1:0]      probe_paddr_line [NUM_CORES];
    mesi_e                   probe_target_state [NUM_CORES];
    logic                    flush_busy;
    logic                    flush_done;
    logic                    hpm_dir_acquire;
    logic                    hpm_dir_probe;
    logic                    hpm_dir_writeback;
    logic                    hpm_dir_flush;

    e1_coherence_dir #(
        .NUM_CORES   (NUM_CORES),
        .PADDR_W     (PADDR_W),
        .LINE_BYTES  (LINE_BYTES),
        .DIR_LINES   (DIR_LINES),
        .NUM_DOMAINS (NUM_DOMAINS)
    ) u_dir (
        .clk                (clk),
        .rst_n              (rst_n),
        .acq_valid          (acq_valid),
        .acq_ready          (acq_ready),
        .acq_paddr_line     (acq_paddr_line),
        .acq_is_write       (acq_is_write),
        .acq_req_state      (acq_req_state),
        .acq_wb_data        (acq_wb_data),
        .acq_domain         (acq_domain),
        .grant_valid        (grant_valid),
        .grant_ready        (grant_ready),
        .grant_paddr_line   (grant_paddr_line),
        .grant_data         (grant_data),
        .grant_state        (grant_state),
        .probe_valid        (probe_valid),
        .probe_ready        (probe_ready),
        .probe_paddr_line   (probe_paddr_line),
        .probe_target_state (probe_target_state),
        .probe_ack          (probe_ack),
        .probe_has_data     (probe_has_data),
        .probe_wb_data      (probe_wb_data),
        .probe_final_state  (probe_final_state),
        .flush_req          (flush_req),
        .flush_domain       (flush_domain),
        .flush_busy         (flush_busy),
        .flush_done         (flush_done),
        .hpm_dir_acquire    (hpm_dir_acquire),
        .hpm_dir_probe      (hpm_dir_probe),
        .hpm_dir_writeback  (hpm_dir_writeback),
        .hpm_dir_flush      (hpm_dir_flush)
    );

    // Bind the SWMR property pack onto the real directory's internal coherence
    // record. The bind reaches dir_state_q / dir_valid_q / dir_sharers_q inside
    // u_dir, so the asserts police the actual protocol state, not a model.
    bind e1_coherence_dir e1_coherence_dir_swmr_props #(
        .NUM_CORES (NUM_CORES),
        .DIR_LINES (DIR_LINES)
    ) u_swmr (
        .clk           (clk),
        .rst_n         (rst_n),
        .dir_state_q   (dir_state_q),
        .dir_valid_q   (dir_valid_q),
        .dir_sharers_q (dir_sharers_q)
    );

endmodule
