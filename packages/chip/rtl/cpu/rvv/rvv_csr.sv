// rvv_csr.sv  —  RISC-V Vector 1.0 CSR file for the e1 big core.
//
// Spec: "RISC-V V" version 1.0, sections 1.3, 3.4, 6.
//   - vstart  0x008  RW  vector-start position for partial executions
//   - vxsat   0x009  RW  fixed-point saturation flag (bit 0)
//   - vxrm    0x00A  RW  fixed-point rounding mode (bits 1:0)
//   - vcsr    0x00F  RW  combined view of vxrm | vxsat
//   - vl      0xC20  RO  current vector length (elements)
//   - vtype   0xC21  RO  current vector type (vsew, vlmul, vta, vma, vill)
//   - vlenb   0xC22  RO  VLEN/8 (bytes per vector register)
//
// Big-core configuration (per docs/architecture-optimization/sota-2028/
// ooo-execution.md Section C):
//   - VLEN = 256 bits (one register holds 256 b)
//   - DLEN = 256 bits (one cycle/datapath moves 256 b per execution lane)
//   - ELEN = 64 bits (largest element)
//   - 2 vector execution datapaths (effective 512 b/cycle peak)
//
// Mid core (e1-premium) uses VLEN = 128 with a single datapath. Little
// core (e1-pro) has no vector unit; vector instructions trap.
//
// This module is the CSR boundary only. The execution unit is the OoO
// agent's responsibility and will plug into the dispatch/issue ports.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDPARAM */
`ifndef RVV_PKG_DEFINED
`define RVV_PKG_DEFINED
package rvv_pkg;

    // Big-core defaults; cluster instances override.
    localparam int unsigned VLEN_BITS_BIG    = 256;
    localparam int unsigned ELEN_BITS_BIG    = 64;
    localparam int unsigned DLEN_BITS_BIG    = 256;
    localparam int unsigned LANES_BIG        = 2;

    localparam int unsigned VLEN_BITS_MID    = 128;
    localparam int unsigned ELEN_BITS_MID    = 64;
    localparam int unsigned DLEN_BITS_MID    = 128;
    localparam int unsigned LANES_MID        = 1;

    // vtype field encoding per V 1.0 spec.
    typedef struct packed {
        logic        vill;    // bit 63
        logic [62:0] reserved_hi;  // tied 0 (we keep zero per spec)
        logic        vma;     // bit 7
        logic        vta;     // bit 6
        logic [2:0]  vsew;    // bits 5:3
        logic [2:0]  vlmul;   // bits 2:0
    } vtype_t;
    // Note: vtype is XLEN wide; we encode only the architecturally visible
    // bits and zero-extend on read.

    // vsew encoding: 000=E8 001=E16 010=E32 011=E64 (others reserved)
    typedef enum logic [2:0] {
        VSEW_E8  = 3'd0,
        VSEW_E16 = 3'd1,
        VSEW_E32 = 3'd2,
        VSEW_E64 = 3'd3
    } vsew_e;

    // vlmul encoding (fractional and integer).
    typedef enum logic [2:0] {
        VLMUL_F8 = 3'b101,
        VLMUL_F4 = 3'b110,
        VLMUL_F2 = 3'b111,
        VLMUL_1  = 3'b000,
        VLMUL_2  = 3'b001,
        VLMUL_4  = 3'b010,
        VLMUL_8  = 3'b011
    } vlmul_e;

    // vxrm encoding.
    typedef enum logic [1:0] {
        VXRM_RNU = 2'd0,
        VXRM_RNE = 2'd1,
        VXRM_RDN = 2'd2,
        VXRM_ROD = 2'd3
    } vxrm_e;

endpackage : rvv_pkg
`endif

module rvv_csr #(
    parameter int unsigned VLEN_BITS = rvv_pkg::VLEN_BITS_BIG,
    parameter int unsigned ELEN_BITS = rvv_pkg::ELEN_BITS_BIG,
    // VLMAX_E8 = VLEN_BITS in E8/LMUL=1 by definition; kept as a parameter so
    // integrators can override for fractional-LMUL minimum-VLMAX checks.
    parameter int unsigned VLMAX_E8  = VLEN_BITS,
    parameter int unsigned XLEN      = 64
) (
    input  logic              clk_i,
    input  logic              rst_ni,

    // CSR write port (any privilege; M-mode handler filters).
    input  logic              csr_we_i,
    input  logic [11:0]       csr_addr_i,
    input  logic [XLEN-1:0]   csr_wdata_i,

    // CSR read port.
    input  logic [11:0]       csr_raddr_i,
    output logic [XLEN-1:0]   csr_rdata_o,
    output logic              csr_rvalid_o,

    // vsetvl* writes from decode/dispatch. avl is in elements; this block
    // computes new vl per V 1.0 algorithm and updates vtype.
    input  logic              vsetvl_we_i,
    input  logic [XLEN-1:0]   vsetvl_avl_i,
    input  rvv_pkg::vtype_t   vsetvl_vtype_i,
    output logic [XLEN-1:0]   vsetvl_vl_o,
    output logic              vsetvl_vill_o,

    // Reads consumed by the vector execution unit.
    output logic [XLEN-1:0]   vl_o,
    output rvv_pkg::vtype_t   vtype_o,
    output logic              vxsat_o,
    output logic [1:0]        vxrm_o
);

    // Architectural state.
    logic [XLEN-1:0]   vstart_q;
    logic              vxsat_q;
    logic [1:0]        vxrm_q;
    logic [XLEN-1:0]   vl_q;
    rvv_pkg::vtype_t   vtype_q;

    // -----------------------------------------------------------------
    // vsetvl* algorithm (V 1.0 §6 informative):
    //
    //   sew_bytes = 1 << vsew
    //   vlmax     = (VLEN / sew_bytes) * lmul   // lmul as a rational
    //   if avl <= vlmax           -> new_vl = avl
    //   elif avl < 2*vlmax        -> new_vl = ceil(avl/2) (impl-def, we
    //                                          choose floor(avl/2)+1)
    //   else                       -> new_vl = vlmax
    //
    // We support integer LMUL (1,2,4,8) and the standard fractional
    // values. Reserved combinations set vill=1 and force vl=0.
    // -----------------------------------------------------------------
    // VLEN_BITS / 8 (bytes per vector register). Pre-widened to XLEN so
    // the division-by-sew_bytes stays at XLEN width.
    localparam logic [XLEN-1:0] VLEN_BYTES = XLEN'(VLEN_BITS / 8);

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [XLEN-1:0] compute_vlmax(
        input rvv_pkg::vtype_t vt
    );
        logic [XLEN-1:0] sew_bytes;
        logic [XLEN-1:0] vlmax_e;
        sew_bytes = {{(XLEN-32){1'b0}}, 32'd1} << vt.vsew;
        unique case (vt.vlmul)
            rvv_pkg::VLMUL_1:  vlmax_e = VLEN_BYTES / sew_bytes;
            rvv_pkg::VLMUL_2:  vlmax_e = (VLEN_BYTES / sew_bytes) * XLEN'(2);
            rvv_pkg::VLMUL_4:  vlmax_e = (VLEN_BYTES / sew_bytes) * XLEN'(4);
            rvv_pkg::VLMUL_8:  vlmax_e = (VLEN_BYTES / sew_bytes) * XLEN'(8);
            rvv_pkg::VLMUL_F2: vlmax_e = (VLEN_BYTES / sew_bytes) / XLEN'(2);
            rvv_pkg::VLMUL_F4: vlmax_e = (VLEN_BYTES / sew_bytes) / XLEN'(4);
            rvv_pkg::VLMUL_F8: vlmax_e = (VLEN_BYTES / sew_bytes) / XLEN'(8);
            default:           vlmax_e = '0;
        endcase
        return vlmax_e;
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic vsew_lmul_legal(input rvv_pkg::vtype_t vt);
        // ELEN limit: cannot have vsew larger than ELEN. vt.vill, vt.vma,
        // vt.vta, and the reserved-hi bits are not inputs to the legality
        // check — vill is the output, and vma/vta are agnostic flags that
        // do not constrain (vsew, vlmul) legality.
        int unsigned sew_bits;
        sew_bits = 8 << vt.vsew;
        if (sew_bits > ELEN_BITS) return 1'b0;
        // Reserved vlmul values (=4'b100 i.e. encoded 3'b100 is reserved).
        if (vt.vlmul == 3'b100) return 1'b0;
        return 1'b1;
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    // -----------------------------------------------------------------
    // CSR write path
    // -----------------------------------------------------------------
    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            vstart_q <= '0;
            vxsat_q  <= 1'b0;
            vxrm_q   <= 2'd0;
            vl_q     <= '0;
            vtype_q  <= '{vill: 1'b1, reserved_hi: '0, vma: 1'b0, vta: 1'b0,
                          vsew: 3'd0, vlmul: 3'd0};
        end else begin
            if (vsetvl_we_i) begin
                if (!vsew_lmul_legal(vsetvl_vtype_i)) begin
                    vl_q                <= '0;
                    vtype_q.vill        <= 1'b1;
                    vtype_q.reserved_hi <= '0;
                    vtype_q.vma         <= 1'b0;
                    vtype_q.vta         <= 1'b0;
                    vtype_q.vsew        <= '0;
                    vtype_q.vlmul       <= '0;
                end else begin
                    logic [XLEN-1:0] vlmax_v;
                    vlmax_v = compute_vlmax(vsetvl_vtype_i);
                    vtype_q <= vsetvl_vtype_i;
                    vtype_q.vill <= 1'b0;
                    vtype_q.reserved_hi <= '0;
                    if (vsetvl_avl_i <= vlmax_v) begin
                        vl_q <= vsetvl_avl_i;
                    end else begin
                        vl_q <= vlmax_v;
                    end
                end
            end else if (csr_we_i) begin
                unique case (csr_addr_i)
                    12'h008: vstart_q <= csr_wdata_i;
                    12'h009: vxsat_q  <= csr_wdata_i[0];
                    12'h00A: vxrm_q   <= csr_wdata_i[1:0];
                    12'h00F: begin
                        vxrm_q  <= csr_wdata_i[2:1];
                        vxsat_q <= csr_wdata_i[0];
                    end
                    default: ;
                endcase
            end
        end
    end

    // -----------------------------------------------------------------
    // CSR read path
    // -----------------------------------------------------------------
    always_comb begin
        csr_rdata_o  = '0;
        csr_rvalid_o = 1'b0;
        unique case (csr_raddr_i)
            12'h008: begin csr_rdata_o = vstart_q;                       csr_rvalid_o = 1'b1; end
            12'h009: begin csr_rdata_o = {{(XLEN-1){1'b0}}, vxsat_q};   csr_rvalid_o = 1'b1; end
            12'h00A: begin csr_rdata_o = {{(XLEN-2){1'b0}}, vxrm_q};    csr_rvalid_o = 1'b1; end
            12'h00F: begin csr_rdata_o = {{(XLEN-3){1'b0}}, vxrm_q, vxsat_q}; csr_rvalid_o = 1'b1; end
            12'hC20: begin csr_rdata_o = vl_q;                           csr_rvalid_o = 1'b1; end
            12'hC21: begin csr_rdata_o = {{(XLEN-16){1'b0}}, vtype_q.vill,
                                          7'b0, vtype_q.vma, vtype_q.vta,
                                          vtype_q.vsew, vtype_q.vlmul};
                                                                          csr_rvalid_o = 1'b1; end
            12'hC22: begin csr_rdata_o = VLEN_BYTES;                     csr_rvalid_o = 1'b1; end
            default: ;
        endcase
    end

    assign vsetvl_vl_o   = vl_q;
    assign vsetvl_vill_o = vtype_q.vill;
    assign vl_o          = vl_q;
    assign vtype_o       = vtype_q;
    assign vxsat_o       = vxsat_q;
    assign vxrm_o        = vxrm_q;

endmodule
/* verilator lint_on UNUSEDPARAM */
/* verilator lint_on DECLFILENAME */
