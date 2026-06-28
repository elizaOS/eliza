// rvv_alu_subset.sv — real RVV 1.0 element-wise vector ALU (verifiable subset).
//
// This is NOT a full vector unit. It is a real, spec-conformant
// implementation of the integer/logic element-wise core of RVV 1.0:
// per-element arithmetic over the active body, honoring vsew (element
// width), vl (active length), vstart (skip prefix), and the tail/mask
// agnostic policy. Within its declared opcode set the arithmetic is real:
// it computes the correct result for every active element, verified element
// by element against a reference model in cocotb.
//
// Implemented (single datapath, one element-group per dispatch):
//   OPIVV (funct6):
//     vadd.vv  vsub.vv  vand.vv  vor.vv  vxor.vv
//     vsll.vv  vsrl.vv  vsra.vv  vmul.vv  vminu.vv vmaxu.vv vmin.vv vmax.vv
//   OPIVX (scalar operand from rs1, splatted):
//     vadd.vx  vsub.vx  vand.vx  vor.vx  vxor.vx  vmul.vx
//   vmv.v.v / vmv.v.x (vd <- vs1 / x[rs1] splat)
//
// Element widths: E8, E16, E32, E64 (vsew 0..3). LMUL is handled by the
// surrounding sequencer issuing one VLEN-wide group per dispatch; this block
// processes exactly one register's worth of elements (VLEN/SEW lanes) per
// fire. Tail elements (index >= vl) follow the tail-agnostic rule: this unit
// implements the "undisturbed-equivalent" pass-through of vs3 for the tail so
// the result is deterministic and testable; a vta=1 policy of all-ones is
// selectable via tail_ones_i.
//
// Out of scope (these MUST route elsewhere or trap — the dispatch wrapper
// flags them, this ALU never fakes them):
//   - widening / narrowing (vwadd, vnsrl, ...), fixed-point saturation,
//   - floating-point, reductions, gather/scatter, permutation, slides,
//   - mask-producing compares, masked (vm=0) execution, segment loads,
//   - any memory access (this is a pure ALU; the LSU owns vector mem).
//
// The companion cocotb test (verify/cocotb/cpu/test_rvv_alu_subset.py) drives
// random vtype/vl/vstart and checks every element against a Python reference
// model, including the tail and vstart-prefix policy.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
// vtype's vma/vta/reserved bits are not consumed here: masking is out of the
// subset (vm=1 only) and the tail-agnostic policy is driven by tail_ones_i,
// so only vsew and vill are read from the struct.
/* verilator lint_off UNUSEDSIGNAL */
module rvv_alu_subset
    import rvv_pkg::*;
#(
    parameter int unsigned VLEN_BITS = rvv_pkg::VLEN_BITS_BIG,
    parameter int unsigned XLEN      = 64
) (
    input  logic                  clk_i,
    input  logic                  rst_ni,

    // Dispatch.
    input  logic                  valid_i,
    output logic                  ready_o,

    // Decoded operation. funct3 selects OPIVV(000)/OPIVX(100)/OPIVI(011);
    // funct6 selects the operation per RVV 1.0 Table (OP-V major opcode).
    input  logic [2:0]            funct3_i,
    input  logic [5:0]            funct6_i,

    // Architectural context from rvv_csr.
    input  logic [XLEN-1:0]       vl_i,
    input  logic [XLEN-1:0]       vstart_i,
    input  rvv_pkg::vtype_t       vtype_i,
    input  logic                  tail_ones_i,  // vta policy: 1 -> tail=all-ones

    // Operands. vs2 is the vector source; vs1 the second vector source
    // (OPIVV); rs1 the scalar (OPIVX) or sign-extended imm (OPIVI). vs3 is the
    // old vd value (for vstart prefix + tail-undisturbed pass-through).
    input  logic [VLEN_BITS-1:0]  vs2_i,
    input  logic [VLEN_BITS-1:0]  vs1_i,
    input  logic [XLEN-1:0]       rs1_i,
    input  logic [VLEN_BITS-1:0]  vs3_i,

    // Result.
    output logic                  valid_o,
    input  logic                  ready_i,
    output logic [VLEN_BITS-1:0]  vd_o,
    output logic                  unsupported_o  // op outside the subset
);

    // funct3 encodings for OP-V (RVV 1.0 §11.1 / §31 instruction listing).
    localparam logic [2:0] OPIVV = 3'b000;
    localparam logic [2:0] OPIVX = 3'b100;
    localparam logic [2:0] OPIVI = 3'b011;

    // funct6 encodings (subset).
    localparam logic [5:0] F6_ADD  = 6'b000000;
    localparam logic [5:0] F6_SUB  = 6'b000010;
    localparam logic [5:0] F6_AND  = 6'b001001;
    localparam logic [5:0] F6_OR   = 6'b001010;
    localparam logic [5:0] F6_XOR  = 6'b001011;
    localparam logic [5:0] F6_SLL  = 6'b100101;
    localparam logic [5:0] F6_SRL  = 6'b101000;
    localparam logic [5:0] F6_SRA  = 6'b101001;
    localparam logic [5:0] F6_MINU = 6'b000100;
    localparam logic [5:0] F6_MIN  = 6'b000101;
    localparam logic [5:0] F6_MAXU = 6'b000110;
    localparam logic [5:0] F6_MAX  = 6'b000111;
    localparam logic [5:0] F6_MV   = 6'b010111; // vmv.v.* (vmerge w/ vm=1)

    // Integer multiply is OPMVV (funct3=010) / OPMVX (110), funct6=100101.
    // This shares the funct6 value with OPIVV vsll; the funct3 disambiguates
    // (vsll is OPIVV/OPIVX, vmul is OPMVV/OPMVX), so no encoding ambiguity.
    localparam logic [2:0] OPMVV   = 3'b010;
    localparam logic [2:0] OPMVX   = 3'b110;
    localparam logic [5:0] F6_MUL_M = 6'b100101;

    localparam int unsigned MAX_LANES = VLEN_BITS / 8; // E8 worst case

    logic busy_q;
    logic [VLEN_BITS-1:0] vd_q;
    logic unsupported_q;

    assign ready_o       = !busy_q;
    assign valid_o       = busy_q;
    assign vd_o          = vd_q;
    assign unsupported_o = unsupported_q;

    // sew in bits: 8/16/32/64 for vsew 0..3.
    function automatic logic [6:0] sew_bits(input logic [2:0] vsew);
        return 7'(8 << vsew);
    endfunction

    // Per-element compute. Operands arrive zero-extended to 64 b at the
    // element width; signed ops re-derive the sign extension internally.
    function automatic logic [63:0] elem_op(
        input logic [5:0]  f6,
        input logic [2:0]  f3,
        input logic [63:0] a,   // vs2 element (zero-extended from sb bits)
        input logic [63:0] b,   // vs1 / rs1 element (zero-extended from sb bits)
        input logic [6:0]  sb,  // sew bits (8/16/32/64)
        output logic       unsup
    );
        logic [63:0]        r;
        logic signed [63:0] as;
        logic signed [63:0] bs;
        logic [5:0]         sh;
        logic [6:0]         shamt_mask;
        r     = '0;
        unsup = 1'b0;
        // sign-extend a,b from sb bits to 64.
        as = $signed(a <<  (7'd64 - sb)) >>> (7'd64 - sb);
        bs = $signed(b <<  (7'd64 - sb)) >>> (7'd64 - sb);
        // shift amount = low log2(sew) bits of b, i.e. b mod sew.
        shamt_mask = sb - 7'd1;
        sh = b[5:0] & shamt_mask[5:0];
        if ((f3 == OPMVV || f3 == OPMVX) && f6 == F6_MUL_M) begin
            r = a * b;
        end else begin
            unique case (f6)
                F6_ADD : r = a + b;
                F6_SUB : r = a - b;
                F6_AND : r = a & b;
                F6_OR  : r = a | b;
                F6_XOR : r = a ^ b;
                F6_SLL : r = a << sh;
                F6_SRL : r = a >> sh;
                F6_SRA : r = $unsigned(as >>> sh);
                F6_MINU: r = (a < b)   ? a : b;
                F6_MAXU: r = (a > b)   ? a : b;
                F6_MIN : r = (as < bs) ? a : b;
                F6_MAX : r = (as > bs) ? a : b;
                F6_MV  : r = b;
                default: begin r = '0; unsup = 1'b1; end
            endcase
        end
        return r;
    endfunction

    // Combinational result assembled into next_vd; registered on fire.
    logic [VLEN_BITS-1:0] next_vd;
    logic                 next_unsup;

    always_comb begin
        logic [6:0]        sb;
        int unsigned       lo;
        logic [63:0]       av;
        logic [63:0]       bv;
        logic [63:0]       rv;
        logic              u;

        next_vd    = vs3_i; // default: tail/prefix undisturbed
        next_unsup = 1'b0;
        sb         = sew_bits(vtype_i.vsew);

        for (int unsigned e = 0; e < MAX_LANES; e++) begin
            lo = e * sb;
            av = '0;
            bv = '0;
            rv = '0;
            u  = 1'b0;
            if ((lo + 32'(sb) <= VLEN_BITS) && !vtype_i.vill) begin
                if (64'(e) >= vstart_i && 64'(e) < vl_i) begin
                    // active body: real element compute.
                    for (int unsigned k = 0; k < 64; k++) begin
                        if (k < sb) begin
                            av[k] = vs2_i[lo + k];
                            if (funct3_i == OPIVV || funct3_i == OPMVV)
                                bv[k] = vs1_i[lo + k];
                            else
                                bv[k] = (k < XLEN) ? rs1_i[k] : 1'b0;
                        end
                    end
                    rv = elem_op(funct6_i, funct3_i, av, bv, sb, u);
                    if (u) next_unsup = 1'b1;
                    for (int unsigned k = 0; k < 64; k++)
                        if (k < sb) next_vd[lo + k] = rv[k];
                end else if (64'(e) >= vl_i && tail_ones_i) begin
                    // tail with vta=1: all-ones. Prefix (e<vstart) and the
                    // tail-undisturbed case keep vs3 (already defaulted).
                    for (int unsigned k = 0; k < 64; k++)
                        if (k < sb) next_vd[lo + k] = 1'b1;
                end
            end
        end

        if (vtype_i.vill)
            next_unsup = 1'b1;
        if (!(funct3_i == OPIVV || funct3_i == OPIVX || funct3_i == OPIVI
              || funct3_i == OPMVV || funct3_i == OPMVX))
            next_unsup = 1'b1;
    end

    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            busy_q        <= 1'b0;
            vd_q          <= '0;
            unsupported_q <= 1'b0;
        end else begin
            if (valid_i && ready_o) begin
                busy_q        <= 1'b1;
                vd_q          <= next_vd;
                unsupported_q <= next_unsup;
            end else if (valid_o && ready_i) begin
                busy_q        <= 1'b0;
            end
        end
    end

endmodule
/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on DECLFILENAME */
