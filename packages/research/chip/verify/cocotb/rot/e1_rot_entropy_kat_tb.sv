// e1_rot_entropy_kat_tb.sv
// Functional entropy-stack testbench for the E1 RoT control crossbar.
//
// Instantiates the real e1_rot_xbar (tlul_adapter_host + tlul_socket_1n,
// vendored OpenTitan TL-UL fabric) with the real entropy interconnect
// (e1_rot_ot_entropy_stack: entropy_src -> csrng -> edn -> aes/kmac/keymgr,
// fed by the behavioral RNG noise model) wired onto its device windows:
//   idx 2  kmac        (the entropy consumer the KAT drives)
//   idx 4  aes         (additional EDN endpoint)
//   idx 5  csrng
//   idx 6  edn
//   idx 7  entropy_src
// cocotb (test_e1_rot_entropy_kat.py) drives the crossbar host port to enable
// the stack, then programs KMAC for a plain SHA3-256 hash with its masking
// entropy sourced from the real EDN (CFG.entropy_mode = EdnMode). KMAC can only
// complete -- and the unmasked digest can only equal the FIPS 202 known answer
// -- if the entropy_src -> csrng -> edn -> kmac datapath actually delivers
// entropy. The testbench asserts nothing itself; the cocotb test checks the
// digest (XOR of the two masked state shares) against the known answer.

`timescale 1ns/1ps

module e1_rot_entropy_kat_tb
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

  localparam int unsigned N_DEVICE   = 9;
  localparam int unsigned KMAC_IDX   = 2;
  localparam int unsigned AES_IDX    = 4;
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

  // Real entropy interconnect on the entropy/consumer device windows.
  e1_rot_ot_entropy_stack u_estack (
    .clk_i,
    .rst_ni,
    .tl_es_i   (dev_tl_h2d[ES_IDX]),
    .tl_es_o   (dev_tl_d2h[ES_IDX]),
    .tl_cs_i   (dev_tl_h2d[CSRNG_IDX]),
    .tl_cs_o   (dev_tl_d2h[CSRNG_IDX]),
    .tl_edn_i  (dev_tl_h2d[EDN_IDX]),
    .tl_edn_o  (dev_tl_d2h[EDN_IDX]),
    .tl_kmac_i (dev_tl_h2d[KMAC_IDX]),
    .tl_kmac_o (dev_tl_d2h[KMAC_IDX]),
    .tl_aes_i  (dev_tl_h2d[AES_IDX]),
    .tl_aes_o  (dev_tl_d2h[AES_IDX])
  );

  // Every other device window is unused in this proof: terminate it with the
  // vendored tlul_err_resp so an out-of-window access still gets a well-formed
  // (error) TL-UL response rather than hanging.
  for (genvar i = 0; i < N_DEVICE; i++) begin : gen_unused_dev
    if (i != KMAC_IDX && i != AES_IDX && i != CSRNG_IDX &&
        i != EDN_IDX && i != ES_IDX) begin : gen_err_term
      tlul_err_resp u_err_resp (
        .clk_i,
        .rst_ni,
        .tl_h_i (dev_tl_h2d[i]),
        .tl_h_o (dev_tl_d2h[i])
      );
    end
  end

endmodule : e1_rot_entropy_kat_tb
