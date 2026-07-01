`timescale 1ns/1ps

// e1_coherence_smp_tb
//
// SMP coherence harness: NUM_CORES real e1_l1d_cache instances sharing a
// single e1_coherence_dir directory controller. This is the device under
// test for the multi-core coherence KAT (SWMR, write propagation, the
// store-buffer / message-passing litmus, clean eviction + writeback ordering,
// and domain-flush partitioning).
//
// The wrapper exposes a flattened per-core LSU request/response interface so
// the cocotb test can drive loads and stores into each core's L1D, plus the
// directory's flush-by-domain control. The L1D <-> directory acq/grant/probe
// channels are wired internally; the test never touches them, so the proof
// runs through the real RTL coherence path end to end.
//
// Small geometry (L1D 2 KiB / 2-way) keeps the modeled arrays in a sane range
// for Verilator while still exercising tag match, MSHR fill, and probe
// writeback.

/* verilator lint_off IMPORTSTAR */
import e1_cache_pkg::*;
import e1_lsu_to_l1d_pkg::*;
/* verilator lint_on IMPORTSTAR */

module e1_coherence_smp_tb #(
    parameter int unsigned NUM_CORES   = 2,
    parameter int unsigned PADDR_W     = 40,
    parameter int unsigned LINE_BYTES  = 64,
    parameter int unsigned L1D_SIZE    = 2 * 1024,
    parameter int unsigned L1D_WAYS    = 2,
    parameter int unsigned DIR_LINES   = 64,
    parameter int unsigned NUM_DOMAINS = 2
) (
    input  logic                       clk,
    input  logic                       rst_n,

    // Flattened per-core LSU port 0 request (one request lane per core is
    // enough for the coherence proofs; port 1 is held idle).
    input  logic [NUM_CORES-1:0]       c_req_valid,
    output logic [NUM_CORES-1:0]       c_req_ready,
    input  logic [PADDR_W-1:0]         c_req_paddr   [NUM_CORES],
    input  logic                       c_req_is_load [NUM_CORES],
    input  logic [63:0]                c_req_wdata   [NUM_CORES],
    output logic [NUM_CORES-1:0]       c_resp_valid,
    output logic [63:0]                c_resp_rdata  [NUM_CORES],
    output logic [NUM_CORES-1:0]       c_resp_ack,
    output logic [NUM_CORES-1:0]       c_resp_replay,

    // Per-core confidential-domain tag (used by the directory flush sweep).
    input  logic [$clog2(NUM_DOMAINS)-1:0] c_domain  [NUM_CORES],

    // Flush-by-domain control.
    input  logic                       flush_req,
    input  logic [$clog2(NUM_DOMAINS)-1:0] flush_domain,
    output logic                       flush_busy,
    output logic                       flush_done
);

    localparam int unsigned LINE_BITS = 8 * LINE_BYTES;

    // Directory HPM observation taps (not exported by this harness).
    /* verilator lint_off UNUSEDSIGNAL */
    logic hpm_dir_acquire_nc, hpm_dir_probe_nc;
    logic hpm_dir_writeback_nc, hpm_dir_flush_nc;
    /* verilator lint_on UNUSEDSIGNAL */

    // ---- Per-core L1D <-> directory wires ----
    logic [NUM_CORES-1:0]       acq_valid;
    logic [NUM_CORES-1:0]       acq_ready;
    logic [PADDR_W-1:0]         acq_paddr_line   [NUM_CORES];
    logic [NUM_CORES-1:0]       acq_is_write;
    mesi_e                      acq_req_state    [NUM_CORES];
    logic [LINE_BITS-1:0]       acq_wb_data      [NUM_CORES];

    logic [NUM_CORES-1:0]       grant_valid;
    logic [NUM_CORES-1:0]       grant_ready;
    logic [PADDR_W-1:0]         grant_paddr_line [NUM_CORES];
    logic [LINE_BITS-1:0]       grant_data       [NUM_CORES];
    mesi_e                      grant_state      [NUM_CORES];

    logic [NUM_CORES-1:0]       probe_valid;
    logic [NUM_CORES-1:0]       probe_ready;
    logic [PADDR_W-1:0]         probe_paddr_line [NUM_CORES];
    mesi_e                      probe_target_state [NUM_CORES];
    logic [NUM_CORES-1:0]       probe_ack;
    logic [NUM_CORES-1:0]       probe_has_data;
    logic [LINE_BITS-1:0]       probe_wb_data    [NUM_CORES];
    mesi_e                      probe_final_state [NUM_CORES];

    // ---- Generate per-core L1D ----
    genvar gi;
    generate
        for (gi = 0; gi < NUM_CORES; gi++) begin : g_core
            lsu_l1d_req_t  p0_req;
            lsu_l1d_resp_t p0_resp;
            logic          p0_resp_valid;
            // Tied-off / observation-only L1D outputs.
            /* verilator lint_off UNUSEDSIGNAL */
            logic          p1_ready_nc;
            logic          p1_resp_valid_nc;
            lsu_l1d_resp_t p1_resp_nc;
            logic          hpm_access_nc, hpm_miss_nc;
            logic          hpm_ecc_corr_nc, hpm_ecc_uncorr_nc;
            /* verilator lint_on UNUSEDSIGNAL */

            // Pack the flattened request into the LSU struct. size=3 (8B),
            // full-word strobe on stores.
            assign p0_req = '{
                paddr:   c_req_paddr[gi],
                size:    3'd3,
                is_load: c_req_is_load[gi],
                wdata:   {64'h0, c_req_wdata[gi]},
                wstrb:   c_req_is_load[gi] ? 16'h0 : 16'h00FF,
                tag:     8'(gi)
            };

            e1_l1d_cache #(
                .SIZE_BYTES (L1D_SIZE),
                .WAYS       (L1D_WAYS),
                .LINE_BYTES (LINE_BYTES),
                .PADDR_W    (PADDR_W)
            ) u_l1d (
                .clk    (clk),
                .rst_n  (rst_n),

                .lsu_p0_valid      (c_req_valid[gi]),
                .lsu_p0_ready      (c_req_ready[gi]),
                .lsu_p0_req        (p0_req),
                .lsu_p0_resp_valid (p0_resp_valid),
                .lsu_p0_resp       (p0_resp),

                .lsu_p1_valid      (1'b0),
                .lsu_p1_ready      (p1_ready_nc),
                .lsu_p1_req        (lsu_l1d_req_zero()),
                .lsu_p1_resp_valid (p1_resp_valid_nc),
                .lsu_p1_resp       (p1_resp_nc),

                .l2_acq_valid         (acq_valid[gi]),
                .l2_acq_ready         (acq_ready[gi]),
                .l2_acq_paddr_line    (acq_paddr_line[gi]),
                .l2_acq_is_write      (acq_is_write[gi]),
                .l2_acq_request_state (acq_req_state[gi]),
                .l2_acq_wb_data       (acq_wb_data[gi]),
                .l2_grant_valid       (grant_valid[gi]),
                .l2_grant_ready       (grant_ready[gi]),
                .l2_grant_paddr_line  (grant_paddr_line[gi]),
                .l2_grant_data        (grant_data[gi]),
                .l2_grant_state       (grant_state[gi]),

                .probe_valid        (probe_valid[gi]),
                .probe_ready        (probe_ready[gi]),
                .probe_paddr_line   (probe_paddr_line[gi]),
                .probe_target_state (probe_target_state[gi]),
                .probe_ack          (probe_ack[gi]),
                .probe_has_data     (probe_has_data[gi]),
                .probe_wb_data      (probe_wb_data[gi]),
                .probe_final_state  (probe_final_state[gi]),

                .hpm_l1d_access     (hpm_access_nc),
                .hpm_l1d_miss       (hpm_miss_nc),
                .hpm_l1d_ecc_corr   (hpm_ecc_corr_nc),
                .hpm_l1d_ecc_uncorr (hpm_ecc_uncorr_nc)
            );

            assign c_resp_valid[gi]  = p0_resp_valid;
            assign c_resp_rdata[gi]  = p0_resp.rdata[63:0];
            assign c_resp_ack[gi]    = p0_resp.ack;
            assign c_resp_replay[gi] = p0_resp.replay;
        end
    endgenerate

    // ---- Shared directory coherence controller ----
    e1_coherence_dir #(
        .NUM_CORES   (NUM_CORES),
        .PADDR_W     (PADDR_W),
        .LINE_BYTES  (LINE_BYTES),
        .DIR_LINES   (DIR_LINES),
        .NUM_DOMAINS (NUM_DOMAINS)
    ) u_dir (
        .clk    (clk),
        .rst_n  (rst_n),

        .acq_valid        (acq_valid),
        .acq_ready        (acq_ready),
        .acq_paddr_line   (acq_paddr_line),
        .acq_is_write     (acq_is_write),
        .acq_req_state    (acq_req_state),
        .acq_wb_data      (acq_wb_data),
        .acq_domain       (c_domain),

        .grant_valid      (grant_valid),
        .grant_ready      (grant_ready),
        .grant_paddr_line (grant_paddr_line),
        .grant_data       (grant_data),
        .grant_state      (grant_state),

        .probe_valid        (probe_valid),
        .probe_ready        (probe_ready),
        .probe_paddr_line   (probe_paddr_line),
        .probe_target_state (probe_target_state),
        .probe_ack          (probe_ack),
        .probe_has_data     (probe_has_data),
        .probe_wb_data      (probe_wb_data),
        .probe_final_state  (probe_final_state),

        .flush_req     (flush_req),
        .flush_domain  (flush_domain),
        .flush_busy    (flush_busy),
        .flush_done    (flush_done),

        .hpm_dir_acquire   (hpm_dir_acquire_nc),
        .hpm_dir_probe     (hpm_dir_probe_nc),
        .hpm_dir_writeback (hpm_dir_writeback_nc),
        .hpm_dir_flush     (hpm_dir_flush_nc)
    );

    // grant_ready is always asserted by the L1D model (it ties l2_grant_ready
    // high), so the directory may grant whenever it has a result. Wired
    // through grant_ready above.

endmodule : e1_coherence_smp_tb
