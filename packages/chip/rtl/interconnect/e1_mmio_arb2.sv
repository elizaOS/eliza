`timescale 1ns/1ps

// e1_mmio_arb2
//
// Two-master arbiter for the simple synchronous MMIO request bus used by the
// e1 peripheral fabric (mmio_valid / mmio_write / mmio_addr / mmio_wdata with a
// shared mmio_rdata / mmio_ready return).
//
// Masters:
//   0  External debug/MMIO bridge  - highest priority (m0_*)
//   1  CPU AXI-Lite -> MMIO adapter - lower priority    (m1_*)
//
// Arbitration is request-granular with grant-locking: once a master is granted
// it holds the fabric until that master's request handshake completes
// (mmio_valid & mmio_ready), so multi-cycle fabric regions (real CLINT/PLIC/
// DRAM) are never torn between masters mid-transaction. While locked to one
// master, the other master sees its request stalled (ready de-asserted) but is
// not dropped — it simply waits, which the debug bridge and the AXI-Lite
// adapter both tolerate (they keep mmio_valid asserted until granted+ready).
//
// The debug bridge has strict priority so an external operator/JTAG path can
// always intervene even while the CPU is streaming peripheral traffic.

module e1_mmio_arb2 (
    input  logic        clk,
    input  logic        rst_n,

    // ── Master 0: external debug/MMIO bridge (priority) ───────────────────
    input  logic        m0_valid,
    input  logic        m0_write,
    input  logic [31:0] m0_addr,
    input  logic [31:0] m0_wdata,
    output logic [31:0] m0_rdata,
    output logic        m0_ready,

    // ── Master 1: CPU AXI-Lite -> MMIO adapter ────────────────────────────
    input  logic        m1_valid,
    input  logic        m1_write,
    input  logic [31:0] m1_addr,
    input  logic [31:0] m1_wdata,
    input  logic [3:0]  m1_wstrb,
    output logic [31:0] m1_rdata,
    output logic        m1_ready,

    // ── Downstream fabric port ────────────────────────────────────────────
    output logic        mmio_valid,
    output logic        mmio_write,
    output logic [31:0] mmio_addr,
    output logic [31:0] mmio_wdata,
    output logic [3:0]  mmio_wstrb,
    input  logic [31:0] mmio_rdata,
    input  logic        mmio_ready
);
    // Grant state: 0 = free, plus a locked indication of which master holds it.
    typedef enum logic [1:0] {
        GRANT_NONE = 2'b00,
        GRANT_M0   = 2'b01,
        GRANT_M1   = 2'b10
    } grant_e;

    grant_e grant_q, grant_d;

    // Combinational grant for this cycle: hold an existing lock, else arbitrate
    // fresh requests with M0 strictly ahead of M1.
    grant_e grant_now;
    always_comb begin
        if (grant_q != GRANT_NONE) begin
            grant_now = grant_q;
        end else if (m0_valid) begin
            grant_now = GRANT_M0;
        end else if (m1_valid) begin
            grant_now = GRANT_M1;
        end else begin
            grant_now = GRANT_NONE;
        end
    end

    // Drive the shared fabric port from the granted master.
    always_comb begin
        unique case (grant_now)
            GRANT_M0: begin
                mmio_valid = m0_valid;
                mmio_write = m0_write;
                mmio_addr  = m0_addr;
                mmio_wdata = m0_wdata;
                mmio_wstrb = {4{m0_write}};
            end
            GRANT_M1: begin
                mmio_valid = m1_valid;
                mmio_write = m1_write;
                mmio_addr  = m1_addr;
                mmio_wdata = m1_wdata;
                mmio_wstrb = m1_wstrb;
            end
            default: begin
                mmio_valid = 1'b0;
                mmio_write = 1'b0;
                mmio_addr  = 32'h0;
                mmio_wdata = 32'h0;
                mmio_wstrb = 4'h0;
            end
        endcase
    end

    // Route the shared return only to the granted master; the stalled master
    // sees ready=0 (its request is held, not completed) and stable rdata.
    assign m0_rdata = mmio_rdata;
    assign m1_rdata = mmio_rdata;
    assign m0_ready = (grant_now == GRANT_M0) ? mmio_ready : 1'b0;
    assign m1_ready = (grant_now == GRANT_M1) ? mmio_ready : 1'b0;

    // Lock the grant while a transaction is mid-flight; release on completion.
    always_comb begin
        grant_d = grant_q;
        unique case (grant_now)
            GRANT_M0: grant_d = (m0_valid && mmio_ready) ? GRANT_NONE : GRANT_M0;
            GRANT_M1: grant_d = (m1_valid && mmio_ready) ? GRANT_NONE : GRANT_M1;
            default:  grant_d = GRANT_NONE;
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) grant_q <= GRANT_NONE;
        else        grant_q <= grant_d;
    end

endmodule : e1_mmio_arb2
