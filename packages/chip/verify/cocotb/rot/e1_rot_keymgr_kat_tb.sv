// e1_rot_keymgr_kat_tb.sv
// Functional keymgr key-ladder testbench for the E1 RoT control crossbar.
//
// Instantiates the real e1_rot_xbar (tlul_adapter_host + tlul_socket_1n,
// vendored OpenTitan TL-UL fabric) with the real keymgr key-ladder stack
// (e1_rot_ot_keymgr_stack: entropy_src -> csrng -> edn -> kmac + keymgr, with
// keymgr's KMAC-KDF app port wired to the real KMAC and its sideload key fed
// back as the KDF stage key) wired onto its device windows:
//   idx 1  keymgr      (the key ladder under test)
//   idx 2  kmac        (the KDF engine the ladder drives)
//   idx 5  csrng
//   idx 6  edn
//   idx 7  entropy_src
// cocotb (test_e1_rot_keymgr_kat.py) drives the crossbar host port to enable
// the entropy stack, program KMAC's masking entropy, then sequence the keymgr
// CSRs through Init -> Advance (Reset->Init->CreatorRootKey) -> Generate-SW-Output
// and reads the generated key back from the SW-output CSRs. The keymgr can only
// advance and emit a non-error bound key if the full keymgr <-> kmac <-> edn
// datapath delivers; the testbench asserts nothing itself.
//
// keymgr_sideload_o exposes the hardware-only sideload key for the cocotb
// tamper-divergence check (re-run with a different SW binding and compare).

`timescale 1ns/1ps

module e1_rot_keymgr_kat_tb
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
    output logic                       host_intg_err_o,

    // Exposed hardware-only sideload key (kmac_key_o) for the divergence proof.
    output logic [255:0]               sideload_key_share0_o,
    output logic [255:0]               sideload_key_share1_o,
    output logic                       sideload_key_valid_o
);

  localparam int unsigned N_DEVICE   = 9;
  localparam int unsigned KEYMGR_IDX = 1;
  localparam int unsigned KMAC_IDX   = 2;
  localparam int unsigned CSRNG_IDX  = 5;
  localparam int unsigned EDN_IDX    = 6;
  localparam int unsigned ES_IDX     = 7;

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

  keymgr_pkg::hw_key_req_t sideload_key;

  e1_rot_ot_keymgr_stack u_kmstack (
    .clk_i,
    .rst_ni,
    .tl_es_i     (dev_tl_h2d[ES_IDX]),
    .tl_es_o     (dev_tl_d2h[ES_IDX]),
    .tl_cs_i     (dev_tl_h2d[CSRNG_IDX]),
    .tl_cs_o     (dev_tl_d2h[CSRNG_IDX]),
    .tl_edn_i    (dev_tl_h2d[EDN_IDX]),
    .tl_edn_o    (dev_tl_d2h[EDN_IDX]),
    .tl_kmac_i   (dev_tl_h2d[KMAC_IDX]),
    .tl_kmac_o   (dev_tl_d2h[KMAC_IDX]),
    .tl_keymgr_i (dev_tl_h2d[KEYMGR_IDX]),
    .tl_keymgr_o (dev_tl_d2h[KEYMGR_IDX]),
    .keymgr_sideload_o (sideload_key)
  );

  assign sideload_key_share0_o = sideload_key.key_share0;
  assign sideload_key_share1_o = sideload_key.key_share1;
  assign sideload_key_valid_o  = sideload_key.valid;

  // Terminate every unused device window with the vendored tlul_err_resp so an
  // out-of-window access still gets a well-formed (error) TL-UL response.
  for (genvar i = 0; i < N_DEVICE; i++) begin : gen_unused_dev
    if (i != KEYMGR_IDX && i != KMAC_IDX && i != CSRNG_IDX &&
        i != EDN_IDX && i != ES_IDX) begin : gen_err_term
      tlul_err_resp u_err_resp (
        .clk_i,
        .rst_ni,
        .tl_h_i (dev_tl_h2d[i]),
        .tl_h_o (dev_tl_d2h[i])
      );
    end
  end

endmodule : e1_rot_keymgr_kat_tb
