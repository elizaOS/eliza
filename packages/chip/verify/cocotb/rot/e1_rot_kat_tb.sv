// e1_rot_kat_tb.sv
// Functional crypto datapath testbench for the E1 RoT control crossbar.
//
// Instantiates the real e1_rot_xbar (tlul_adapter_host + tlul_socket_1n,
// vendored OpenTitan TL-UL fabric) with the real OpenTitan HMAC block wired on
// device window 3 (and an idle device on every other window). cocotb drives the
// crossbar host port (req/we/be/addr/wdata) exactly as the RoT Ibex data port
// would, programs HMAC to compute SHA-256("abc"), and reads back the digest
// through the same datapath. The testbench asserts nothing itself; the cocotb
// test (test_e1_rot_kat.py) checks the digest against the FIPS 180-4 known
// answer. This proves the host->xbar->socket->real-block->host datapath end to
// end, not a shim.

`timescale 1ns/1ps

module e1_rot_kat_tb
  import tlul_pkg::*;
(
    input  logic                       clk_i,
    input  logic                       rst_ni,

    // Crossbar host port (RoT Ibex data-port style). Driven by cocotb.
    input  logic                       host_req_i,
    output logic                       host_gnt_o,
    input  logic [top_pkg::TL_AW-1:0]  host_addr_i,
    input  logic                       host_we_i,
    input  logic [top_pkg::TL_DW-1:0]  host_wdata_i,
    input  logic [top_pkg::TL_DBW-1:0] host_be_i,
    output logic                       host_rvalid_o,
    output logic [top_pkg::TL_DW-1:0]  host_rdata_o,
    output logic                       host_err_o,
    output logic                       host_intg_err_o
);

  localparam int unsigned N_DEVICE = 9;
  localparam int unsigned HMAC_IDX = 3;

  tl_h2d_t dev_tl_h2d [N_DEVICE];
  tl_d2h_t dev_tl_d2h [N_DEVICE];

  e1_rot_xbar #(
    .N_DEVICE (N_DEVICE)
  ) u_xbar (
    .clk_i,
    .rst_ni,
    .host_req_i,
    .host_gnt_o,
    .host_addr_i,
    .host_we_i,
    .host_wdata_i,
    .host_be_i,
    .host_rvalid_o,
    .host_rdata_o,
    .host_err_o,
    .host_intg_err_o,
    .dev_tl_o (dev_tl_h2d),
    .dev_tl_i (dev_tl_d2h)
  );

  // Real OpenTitan HMAC on device window HMAC_IDX.
  e1_rot_ot_hmac u_hmac (
    .clk_i,
    .rst_ni,
    .tl_i (dev_tl_h2d[HMAC_IDX]),
    .tl_o (dev_tl_d2h[HMAC_IDX])
  );

  // Every other device window is unused in this datapath proof: terminate it
  // with the vendored tlul_err_resp so an out-of-window access still gets a
  // well-formed (error) TL-UL response rather than hanging.
  for (genvar i = 0; i < N_DEVICE; i++) begin : gen_unused_dev
    if (i != HMAC_IDX) begin : gen_err_term
      tlul_err_resp u_err_resp (
        .clk_i,
        .rst_ni,
        .tl_h_i (dev_tl_h2d[i]),
        .tl_h_o (dev_tl_d2h[i])
      );
    end
  end

endmodule : e1_rot_kat_tb
