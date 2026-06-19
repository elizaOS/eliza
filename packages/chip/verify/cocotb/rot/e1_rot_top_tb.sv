// e1_rot_top_tb.sv
// cocotb testbench wrapper for e1_rot_top (W1 RoT integration).
//
// e1_rot_top exposes the AP mailbox over a packed TL-UL struct (e1_rot_tlul_pkg
// tl_h2d_t / tl_d2h_t). cocotb drives flat signals more naturally, so this
// wrapper flattens the mailbox host channel into discrete a_* / d_* fields and
// packs/unpacks the structs, leaving the rest of the RoT top untouched. It also
// surfaces the reset-sequencer and OTP/mailbox observability outputs directly.
//
// The OTP provisioning rows are driven from a flat plusarg-free default
// (lifecycle = LOCKED) so the reset-release sequence does not trip the SCRAP
// fail-closed path; the SCRAP test overrides the lifecycle row via the
// lc_scrap_force input.

`timescale 1ns/1ps

module e1_rot_top_tb
  import e1_rot_tlul_pkg::*;
(
    input  logic clk_i,
    input  logic rst_ni,

    // Reset-sequencer stimulus.
    input  logic boot_verified_i,
    input  logic iopmp_policy_ready_i,

    // Lifecycle override: when 1, force the OTP lifecycle word to SCRAP
    // (one-hot bit 5) to exercise the fail-closed halt; when 0, LOCKED (bit 3).
    input  logic lc_scrap_force,

    // Flat AP mailbox host channel (TL-UL A/D).
    input  logic        mbox_a_valid,
    input  logic [2:0]  mbox_a_opcode,
    input  logic [7:0]  mbox_a_source,
    input  logic [31:0] mbox_a_address,
    input  logic [31:0] mbox_a_data,
    output logic        mbox_d_valid,
    output logic [2:0]  mbox_d_opcode,
    output logic [7:0]  mbox_d_source,
    output logic        mbox_d_error,
    output logic [31:0] mbox_d_data,

    // Standalone-mailbox RoT-facing port. Drives the same e1_rot_mailbox RTL as
    // the integrated top, letting cocotb act as the RoT firmware for the
    // request->response round-trip (in the integrated top the RoT-facing port
    // is driven by the Ibex via the crossbar). The AP side of this mailbox is
    // exposed via mbox2_* so the round-trip is end-to-end through real RTL.
    input  logic        rot_valid_i,
    input  logic        rot_write_i,
    input  logic [5:0]  rot_addr_i,
    input  logic [31:0] rot_wdata_i,
    output logic [31:0] rot_rdata_o,

    input  logic        mbox2_a_valid,
    input  logic [2:0]  mbox2_a_opcode,
    input  logic [7:0]  mbox2_a_source,
    input  logic [31:0] mbox2_a_address,
    input  logic [31:0] mbox2_a_data,
    output logic [31:0] mbox2_d_data,
    output logic        mbox2_req_pending,
    output logic        mbox2_resp_ready,

    // Observability.
    output logic        cva6_rst_no,
    output logic        pmc_rst_no,
    output logic [2:0]  reset_state_o,
    output logic        platform_released_o,
    output logic        rot_halted_o,
    output logic        otp_parity_fault_o,
    output logic [7:0]  lifecycle_state_o,
    output logic        mbox_req_pending_o,
    output logic        mbox_resp_ready_o
);

  // ----------------------------------------------------------------
  // OTP provisioning rows: a clean image whose lifecycle word selects LOCKED
  // (one-hot bit 3) or SCRAP (one-hot bit 5). All three redundant rows carry
  // the same value so the 2-of-3 majority is unambiguous (no parity fault).
  // LIFECYCLE_OFF = word 20 in e1_otp_map.
  // ----------------------------------------------------------------
  localparam int unsigned OTP_WORDS  = 32;
  localparam int unsigned LC_OFF     = 20;
  localparam logic [31:0] LC_LOCKED  = 32'h0000_0008;  // bit 3
  localparam logic [31:0] LC_SCRAP   = 32'h0000_0020;  // bit 5

  logic [OTP_WORDS*32-1:0] otp_rows;
  always_comb begin
    otp_rows = '0;
    otp_rows[LC_OFF*32 +: 32] = lc_scrap_force ? LC_SCRAP : LC_LOCKED;
  end

  // ----------------------------------------------------------------
  // Pack the flat host channel into tl_h2d_t; unpack the device response.
  // ----------------------------------------------------------------
  tl_h2d_t mbox_tl_i;
  tl_d2h_t mbox_tl_o;

  always_comb begin
    mbox_tl_i           = TL_H2D_DEFAULT;
    mbox_tl_i.a_valid   = mbox_a_valid;
    mbox_tl_i.a_opcode  = tl_a_op_e'(mbox_a_opcode);
    mbox_tl_i.a_source  = mbox_a_source;
    mbox_tl_i.a_address = mbox_a_address;
    mbox_tl_i.a_data    = mbox_a_data;
    mbox_tl_i.a_mask    = 4'hF;
    mbox_tl_i.d_ready   = 1'b1;
  end

  assign mbox_d_valid  = mbox_tl_o.d_valid;
  assign mbox_d_opcode = mbox_tl_o.d_opcode;
  assign mbox_d_source = mbox_tl_o.d_source;
  assign mbox_d_error  = mbox_tl_o.d_error;
  assign mbox_d_data   = mbox_tl_o.d_data;

  e1_rot_top u_rot (
    .clk_i               (clk_i),
    .rst_ni              (rst_ni),
    .cva6_rst_no         (cva6_rst_no),
    .pmc_rst_no          (pmc_rst_no),
    .boot_verified_i     (boot_verified_i),
    .iopmp_policy_ready_i(iopmp_policy_ready_i),
    .mbox_tl_i           (mbox_tl_i),
    .mbox_tl_o           (mbox_tl_o),
    .otp_row0_init_i     (otp_rows),
    .otp_row1_init_i     (otp_rows),
    .otp_row2_init_i     (otp_rows),
    .reset_state_o       (reset_state_o),
    .platform_released_o (platform_released_o),
    .rot_halted_o        (rot_halted_o),
    .otp_parity_fault_o  (otp_parity_fault_o),
    .lifecycle_state_o   (lifecycle_state_o),
    .mbox_req_pending_o  (mbox_req_pending_o),
    .mbox_resp_ready_o   (mbox_resp_ready_o)
  );

  // ----------------------------------------------------------------
  // Standalone mailbox for the end-to-end round-trip test. Same RTL module
  // (e1_rot_mailbox) the integrated top instantiates; here both the AP TL-UL
  // host port and the RoT-facing register port are driven by cocotb.
  // ----------------------------------------------------------------
  tl_h2d_t mbox2_tl_i;
  tl_d2h_t mbox2_tl_o;
  always_comb begin
    mbox2_tl_i           = TL_H2D_DEFAULT;
    mbox2_tl_i.a_valid   = mbox2_a_valid;
    mbox2_tl_i.a_opcode  = tl_a_op_e'(mbox2_a_opcode);
    mbox2_tl_i.a_source  = mbox2_a_source;
    mbox2_tl_i.a_address = mbox2_a_address;
    mbox2_tl_i.a_data    = mbox2_a_data;
    mbox2_tl_i.a_mask    = 4'hF;
    mbox2_tl_i.d_ready   = 1'b1;
  end
  assign mbox2_d_data = mbox2_tl_o.d_data;

  e1_rot_mailbox #(
    .NUM_DATA_WORDS(8)
  ) u_mailbox_rt (
    .clk_i        (clk_i),
    .rst_ni       (rst_ni),
    .tl_ap_i      (mbox2_tl_i),
    .tl_ap_o      (mbox2_tl_o),
    .rot_valid_i  (rot_valid_i),
    .rot_write_i  (rot_write_i),
    .rot_addr_i   (rot_addr_i),
    .rot_wdata_i  (rot_wdata_i),
    .rot_rdata_o  (rot_rdata_o),
    .req_pending_o(mbox2_req_pending),
    .resp_ready_o (mbox2_resp_ready),
    .req_cmd_o    (/* unused in tb */)
  );

  /* verilator lint_off PINCONNECTEMPTY */
  /* verilator lint_on PINCONNECTEMPTY */

endmodule : e1_rot_top_tb
