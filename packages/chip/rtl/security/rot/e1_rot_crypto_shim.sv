// e1_rot_crypto_shim.sv
// Fail-closed E1 integration shim for an OpenTitan crypto/security block that
// is NOT YET truly elaborated in the RoT wrapper.
//
// HONESTY NOTE (CLAUDE.md / AGENTS.md fail-closed law): this module is a SHIM,
// not the OpenTitan IP. It presents the correct TL-UL device-port signature so
// the RoT crossbar elaborates and the integration spine is real, but it does
// NOT implement aes/hmac/kmac/keymgr/csrng/edn/entropy_src/rom_ctrl/
// alert_handler functionality. Every register read returns a fixed
// FAIL_CLOSED_RDATA sentinel and every transaction raises `busy_o`=0 with an
// error-tagged TL-UL response, so any RoT firmware that depends on a real
// crypto result observes a hard failure rather than a spoofed success.
//
// check_rot_integration.py enumerates each instance of this shim as a BLOCKED
// block in the gate report, with the named missing dependency
// (top_earlgrey topgen-generated *_reg_pkg / *_reg_top + the full prim/secded/
// mubi elaboration chain). Replacing a shim with the real vendored block is the
// remaining integration work for that block.
//
// Synthesizable: single clock, single synchronous-release async-assert reset.

`timescale 1ns/1ps

module e1_rot_crypto_shim
  import e1_rot_tlul_pkg::*;
#(
    // Identifies the shimmed block in waveforms / the device-id register.
    parameter logic [31:0] BLOCK_ID = 32'h0
) (
    input  logic clk_i,
    input  logic rst_ni,

    input  tl_h2d_t tl_i,
    output tl_d2h_t tl_o,

    // Always-deasserted "busy"/"valid-result" sideband: the shim never claims
    // to have produced a real cryptographic result.
    output logic    result_valid_o
);

  // Sentinel returned on every register read. 0xDEADC0DE is deliberately not a
  // plausible crypto result; firmware comparing against an expected digest/MAC
  // will mismatch and fail closed.
  localparam logic [31:0] FAIL_CLOSED_RDATA = 32'hDEAD_C0DE;

  logic            d_valid_q;
  tl_d_op_e        d_opcode_q;
  logic [TL_AIW-1:0] d_source_q;
  logic            we;

  assign we = (tl_i.a_opcode == PutFullData) || (tl_i.a_opcode == PutPartialData);

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      d_valid_q  <= 1'b0;
      d_opcode_q <= AccessAck;
      d_source_q <= '0;
    end else begin
      d_valid_q  <= tl_i.a_valid;
      d_opcode_q <= we ? AccessAck : AccessAckData;
      d_source_q <= tl_i.a_source;
    end
  end

  // Every response is error-tagged: the block is not integrated, so any access
  // is a hard fail-closed error rather than a silent default.
  assign tl_o = '{
    d_valid:  d_valid_q,
    d_opcode: d_opcode_q,
    d_param:  '0,
    d_size:   2'd2,
    d_source: d_source_q,
    d_error:  1'b1,                 // fail-closed: signal the block is absent
    d_data:   FAIL_CLOSED_RDATA,
    a_ready:  1'b1
  };

  assign result_valid_o = 1'b0;

  // Keep BLOCK_ID observable so the elaborated netlist records which shim this
  // is, without it being optimized away.
  logic [31:0] block_id_tap;
  assign block_id_tap = BLOCK_ID;
  /* verilator lint_off UNUSED */
  wire _unused = ^{block_id_tap, tl_i.a_param, tl_i.a_size, tl_i.a_address,
                   tl_i.a_mask, tl_i.a_data, tl_i.d_ready};
  /* verilator lint_on UNUSED */

endmodule : e1_rot_crypto_shim
