// rvv_unit_stub.sv  —  RVV 1.0 execution unit behavioral stub.
//
// This module is a placeholder execution unit that exposes the dispatch
// boundary the OoO back-end will use, but does NOT implement vector
// arithmetic. It is sufficient for cocotb to drive vector dispatch tests
// and for early verification that the surrounding OoO machinery accepts
// vector instructions, but it must NOT be claimed as a real RVV unit.
//
// Status: BLOCKED — full RVV execution out of scope for this turn. The
// canonical evidence path is
//   docs/evidence/cpu_ap/rvv-1-0-execution.yaml
// which records the blocked status until either an open RVV reference
// (Saturn, Ara, Vicuna, or XiangShan vector backend) is forked in or a
// from-scratch implementation lands.
//
// What the stub provides:
//   - accepts a vector instruction descriptor and `vl`/`vtype`,
//   - holds it for one cycle, asserts `done`,
//   - returns a deterministic but unspecified result vector of zeros,
//   - never raises an exception; always reports success.
//
// What the stub cannot do (anything that would form a real claim):
//   - any arithmetic, masking, narrowing, widening, reduction, gather,
//     scatter, strided/indexed memory, or permutation,
//   - any tail/mask agnostic semantics,
//   - any VL/EMUL/EEW interaction with the LSU,
//   - any RVV-spec conformance.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDSIGNAL */
module rvv_unit_stub
    import rvv_pkg::*;
#(
    parameter int unsigned VLEN_BITS = rvv_pkg::VLEN_BITS_BIG,
    parameter int unsigned XLEN      = 64
) (
    input  logic                  clk_i,
    input  logic                  rst_ni,

    // Dispatch port.
    input  logic                  disp_valid_i,
    output logic                  disp_ready_o,
    input  logic [31:0]           disp_instr_i,
    input  logic [XLEN-1:0]       disp_vl_i,
    input  rvv_pkg::vtype_t       disp_vtype_i,
    input  logic [VLEN_BITS-1:0]  disp_vs1_i,
    input  logic [VLEN_BITS-1:0]  disp_vs2_i,
    input  logic [VLEN_BITS-1:0]  disp_vs3_i,
    input  logic [VLEN_BITS-1:0]  disp_vmask_i,
    input  logic [XLEN-1:0]       disp_rs1_i,

    // Completion port.
    output logic                  done_valid_o,
    input  logic                  done_ready_i,
    output logic [VLEN_BITS-1:0]  done_vd_o,
    output logic                  done_exception_o,
    output logic [3:0]            done_exception_code_o
);

    // The behavioral stub holds an instruction for exactly one cycle and
    // returns zeros. Real RVV uops have variable latency depending on vl,
    // sew, lmul, datapath; this stub is intentionally trivial.
    logic        in_flight_q;
    logic [VLEN_BITS-1:0] vd_q;

    assign disp_ready_o = !in_flight_q;

    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            in_flight_q <= 1'b0;
            vd_q        <= '0;
        end else begin
            if (disp_valid_i && disp_ready_o) begin
                in_flight_q <= 1'b1;
                vd_q        <= '0;
            end else if (done_valid_o && done_ready_i) begin
                in_flight_q <= 1'b0;
            end
        end
    end

    assign done_valid_o          = in_flight_q;
    assign done_vd_o             = vd_q;
    assign done_exception_o      = 1'b0;
    assign done_exception_code_o = 4'd0;

    // Mark unused inputs so lint stays clean and intent is documented.
    logic unused_inputs;
    assign unused_inputs = ^{
        disp_instr_i,
        disp_vl_i,
        disp_vtype_i,
        disp_vs1_i,
        disp_vs2_i,
        disp_vs3_i,
        disp_vmask_i,
        disp_rs1_i
    };

endmodule
/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on DECLFILENAME */
