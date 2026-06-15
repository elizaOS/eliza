// rvv_unit_stub.sv  —  RVV 1.0 dispatch-boundary stub for UNSUPPORTED ops.
//
// This module exposes the dispatch/completion handshake the OoO back-end
// uses, but does NOT implement vector arithmetic. The real element-wise
// integer/logic core of RVV 1.0 now lives in `rvv_alu_subset.sv` (a verified
// subset: vadd/vsub/vand/vor/vxor/vsll/vsrl/vsra/vmin*/vmax*/vmul/vmv with
// real per-element arithmetic, vsew/vl/vstart/tail semantics, cocotb-checked
// against a reference model in verify/cocotb/cpu/test_rvv_alu_subset.py).
//
// This stub remains as the handshake placeholder for the ops the subset
// ALU does NOT cover (memory, reductions, gather/scatter, widening/narrowing,
// fixed-point, floating-point, masking, permutation). It returns zeros and
// must NOT be claimed as a real RVV unit. The canonical status is in
//   docs/evidence/cpu_ap/rvv-1-0-execution.yaml
// and the full integration plan in docs/arch/rvv-integration-plan.md.
//
// Functional ISA-level vector evidence (RVV 1.0 on QEMU rva23u64, scalar-vs-
// vector dynamic instruction reduction) is recorded separately in
//   docs/evidence/cpu_ap/e1-rvv-vector.json   (claim_level: functional)
// produced by scripts/run_e1_rvv_vector.sh.
//
// What this stub provides:
//   - accepts a vector instruction descriptor and `vl`/`vtype`,
//   - holds it for one cycle, asserts `done`,
//   - returns a deterministic result vector of zeros,
//   - never raises an exception; always reports success.
//
// What this stub cannot do (route to rvv_alu_subset or a future backend):
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
