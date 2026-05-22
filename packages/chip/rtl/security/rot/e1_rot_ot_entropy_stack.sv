// e1_rot_ot_entropy_stack.sv
// Functional entropy interconnect for the E1 RoT (entropy_src -> csrng -> edn ->
// aes/kmac/keymgr), built from the vendored OpenTitan IPs and *_pkg struct types.
//
// This file is kept separate from e1_rot_ot_blocks.sv because it instantiates
// SIX OpenTitan blocks at once; the per-block elaboration harnesses in
// e1_rot_ot_blocks.sv are linted one at a time against a single block's
// filelist, so the multi-block stack must not share that compilation unit.
//
// e1_rot_rng_model is a DETERMINISTIC pseudo-random stand-in for the AST analog
// noise source -- it drives the real entropy_src digital datapath in simulation
// but carries NO FIPS / SP800-90B entropy guarantee. See the module header.

`timescale 1ns/1ps

// ---------------------------------------------------------------------------
// Behavioral RNG noise-source model.
//
// In silicon the entropy_src digital RNG interface (entropy_src_rng_o /
// entropy_src_rng_i) is driven by the AST analog noise source. For simulation
// bring-up we substitute the same RNG reference behavior the Earl Grey AST uses
// (top_earlgrey/ip/ast/rtl/rng.sv): a maximal-length 32-bit Fibonacci LFSR
// whose low RNG_BUS_WIDTH bits are sampled as the 4-bit nibble stream. The AST
// model only emits a sample every ~120 cycles; here the sample is emitted every
// cycle while rng_enable is asserted so the health-test / boot-bypass window
// fills in bounded simulation time. This is a DETERMINISTIC, PSEUDO-RANDOM
// stand-in -- it is NOT a physical entropy source and carries NO FIPS / SP800-90B
// entropy guarantee. It exists solely to drive the real entropy_src digital
// datapath in simulation.
// ---------------------------------------------------------------------------
module e1_rot_rng_model
  import entropy_src_pkg::*;
(
    input  logic                   clk_i,
    input  logic                   rst_ni,
    input  entropy_src_rng_req_t   rng_req_i,
    output entropy_src_rng_rsp_t   rng_rsp_o
);
  logic [31:0] lfsr_q;
  logic        en;
  assign en = rng_req_i.rng_enable;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      lfsr_q <= 32'h0000_0001;
    end else if (en) begin
      if (lfsr_q == {32{1'b1}}) begin
        lfsr_q <= {{31{1'b1}}, 1'b0};
      end else begin
        lfsr_q[31:1] <= lfsr_q[30:0];
        lfsr_q[0]    <= !(lfsr_q[31] ^ lfsr_q[21] ^ lfsr_q[1] ^ lfsr_q[0]);
      end
    end
  end

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      rng_rsp_o.rng_valid <= 1'b0;
      rng_rsp_o.rng_b     <= '0;
    end else begin
      rng_rsp_o.rng_valid <= en;
      rng_rsp_o.rng_b     <= lfsr_q[RNG_BUS_WIDTH-1:0];
    end
  end
endmodule : e1_rot_rng_model

// ---------------------------------------------------------------------------
// e1_rot_ot_entropy_stack -- the REAL entropy interconnect.
//
// Wires the vendored entropy_src -> csrng -> edn chain and fans the EDN endpoint
// out to the entropy ports of the real AES, KMAC and KEYMGR blocks, using the
// vendored *_pkg struct types end to end (no hand-rolled DRBG / health tests).
// Four TL-UL device ports are exposed so the RoT control crossbar can program
// the chain exactly as firmware would:
//   tl_es_*   entropy_src registers   (gate window idx 7)
//   tl_cs_*   csrng registers         (gate window idx 5)
//   tl_edn_*  edn registers           (gate window idx 6)
//   tl_kmac_* kmac registers          (gate window idx 2)
// AES and KEYMGR are instantiated as additional EDN endpoints to prove the
// fan-out wiring elaborates, with their register ports terminated locally
// (they are not the consumer driven by this KAT). The behavioral RNG model
// feeds entropy_src's analog port (see e1_rot_rng_model honesty caveat).
//
// EDN exposes NumEndPoints endpoints; this harness uses three (kmac, aes,
// keymgr) and ties the rest idle. EDN runs in boot-request mode so, once
// enabled, it autonomously instantiates+generates from CSRNG and serves the
// endpoints -- no per-request firmware sequencing is needed for the consumer.
// ---------------------------------------------------------------------------
module e1_rot_ot_entropy_stack
  import tlul_pkg::*;
(
    input  logic              clk_i,
    input  logic              rst_ni,

    input  tlul_pkg::tl_h2d_t tl_es_i,
    output tlul_pkg::tl_d2h_t tl_es_o,
    input  tlul_pkg::tl_h2d_t tl_cs_i,
    output tlul_pkg::tl_d2h_t tl_cs_o,
    input  tlul_pkg::tl_h2d_t tl_edn_i,
    output tlul_pkg::tl_d2h_t tl_edn_o,
    input  tlul_pkg::tl_h2d_t tl_kmac_i,
    output tlul_pkg::tl_d2h_t tl_kmac_o,
    input  tlul_pkg::tl_h2d_t tl_aes_i,
    output tlul_pkg::tl_d2h_t tl_aes_o
);

  localparam int unsigned NumEndPoints = 7;
  localparam int unsigned EpKmac   = 0;
  localparam int unsigned EpAes    = 1;
  localparam int unsigned EpKeymgr = 2;

  // entropy_src <-> csrng push interface.
  entropy_src_pkg::entropy_src_hw_if_req_t es_hw_if_req; // csrng -> entropy_src
  entropy_src_pkg::entropy_src_hw_if_rsp_t es_hw_if_rsp; // entropy_src -> csrng
  entropy_src_pkg::cs_aes_halt_req_t       cs_aes_halt_req; // entropy_src -> csrng
  entropy_src_pkg::cs_aes_halt_rsp_t       cs_aes_halt_rsp; // csrng -> entropy_src

  // entropy_src <-> behavioral RNG noise model.
  entropy_src_pkg::entropy_src_rng_req_t   es_rng_req;
  entropy_src_pkg::entropy_src_rng_rsp_t   es_rng_rsp;

  // csrng <-> edn application interface (single hw app, index 1: index 0 is the
  // csrng SW app port, which edn does not use).
  csrng_pkg::csrng_req_t [1:0] cs_cmd_req;
  csrng_pkg::csrng_rsp_t [1:0] cs_cmd_rsp;

  csrng_pkg::csrng_req_t edn_to_cs_req;
  csrng_pkg::csrng_rsp_t cs_to_edn_rsp;

  // edn endpoints.
  edn_pkg::edn_req_t [NumEndPoints-1:0] edn_ep_req; // endpoints -> edn
  edn_pkg::edn_rsp_t [NumEndPoints-1:0] edn_ep_rsp; // edn -> endpoints

  // --- entropy_src ---------------------------------------------------------
  entropy_src u_entropy_src (
    .clk_i,
    .rst_ni,
    .tl_i                        (tl_es_i),
    .tl_o                        (tl_es_o),
    .otp_en_entropy_src_fw_read_i(otp_ctrl_pkg::otp_en_t'(0)),
    .otp_en_entropy_src_fw_over_i(otp_ctrl_pkg::otp_en_t'(0)),
    .rng_fips_o                  (),
    .entropy_src_hw_if_i         (es_hw_if_req),
    .entropy_src_hw_if_o         (es_hw_if_rsp),
    .entropy_src_rng_o           (es_rng_req),
    .entropy_src_rng_i           (es_rng_rsp),
    .cs_aes_halt_o               (cs_aes_halt_req),
    .cs_aes_halt_i               (cs_aes_halt_rsp),
    .entropy_src_xht_o           (),
    .entropy_src_xht_i           (entropy_src_pkg::ENTROPY_SRC_XHT_RSP_DEFAULT),
    .alert_rx_i                  ({entropy_src_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o                  (),
    .intr_es_entropy_valid_o     (),
    .intr_es_health_test_failed_o(),
    .intr_es_observe_fifo_ready_o(),
    .intr_es_fatal_err_o         ()
  );

  e1_rot_rng_model u_rng_model (
    .clk_i,
    .rst_ni,
    .rng_req_i (es_rng_req),
    .rng_rsp_o (es_rng_rsp)
  );

  // --- csrng ---------------------------------------------------------------
  // App 0 = unused SW path peer (tied idle); app 1 = EDN application interface.
  assign cs_cmd_req[0]  = csrng_pkg::CSRNG_REQ_DEFAULT;
  assign cs_cmd_req[1]  = edn_to_cs_req;
  assign cs_to_edn_rsp  = cs_cmd_rsp[1];

  csrng #(
    .NHwApps (2)
  ) u_csrng (
    .clk_i,
    .rst_ni,
    .tl_i                      (tl_cs_i),
    .tl_o                      (tl_cs_o),
    .otp_en_csrng_sw_app_read_i(otp_ctrl_pkg::otp_en_t'(0)),
    .lc_hw_debug_en_i          (lc_ctrl_pkg::Off),
    .entropy_src_hw_if_o       (es_hw_if_req),
    .entropy_src_hw_if_i       (es_hw_if_rsp),
    .cs_aes_halt_i             (cs_aes_halt_req),
    .cs_aes_halt_o             (cs_aes_halt_rsp),
    .csrng_cmd_i               (cs_cmd_req),
    .csrng_cmd_o               (cs_cmd_rsp),
    .alert_rx_i                ({csrng_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o                (),
    .intr_cs_cmd_req_done_o    (),
    .intr_cs_entropy_req_o     (),
    .intr_cs_hw_inst_exc_o     (),
    .intr_cs_fatal_err_o       ()
  );

  // --- edn -----------------------------------------------------------------
  edn #(
    .NumEndPoints (NumEndPoints)
  ) u_edn (
    .clk_i,
    .rst_ni,
    .tl_i                    (tl_edn_i),
    .tl_o                    (tl_edn_o),
    .edn_i                   (edn_ep_req),
    .edn_o                   (edn_ep_rsp),
    .csrng_cmd_o             (edn_to_cs_req),
    .csrng_cmd_i             (cs_to_edn_rsp),
    .alert_rx_i              ({edn_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o              (),
    .intr_edn_cmd_req_done_o (),
    .intr_edn_fatal_err_o    ()
  );

  // Unused endpoints request nothing.
  for (genvar i = 0; i < NumEndPoints; i++) begin : gen_idle_ep
    if (i != EpKmac && i != EpAes && i != EpKeymgr) begin : gen_idle
      assign edn_ep_req[i] = edn_pkg::EDN_REQ_DEFAULT;
    end
  end

  // --- KMAC (entropy consumer driven by the KAT) ---------------------------
  kmac u_kmac (
    .clk_i,
    .rst_ni,
    .clk_edn_i   (clk_i),
    .rst_edn_ni  (rst_ni),
    .tl_i        (tl_kmac_i),
    .tl_o        (tl_kmac_o),
    .alert_rx_i  ({kmac_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o  (),
    .keymgr_key_i(keymgr_pkg::HW_KEY_REQ_DEFAULT),
    .app_i       ('{default: kmac_pkg::APP_REQ_DEFAULT}),
    .app_o       (),
    .entropy_o   (edn_ep_req[EpKmac]),
    .entropy_i   (edn_ep_rsp[EpKmac]),
    .intr_kmac_done_o  (),
    .intr_fifo_empty_o (),
    .intr_kmac_err_o   (),
    .idle_o            ()
  );

  // --- AES (additional EDN endpoint, register port programmable) -----------
  aes u_aes (
    .clk_i,
    .rst_ni,
    .idle_o          (),
    .lc_escalate_en_i(lc_ctrl_pkg::Off),
    .clk_edn_i       (clk_i),
    .rst_edn_ni      (rst_ni),
    .edn_o           (edn_ep_req[EpAes]),
    .edn_i           (edn_ep_rsp[EpAes]),
    .tl_i            (tl_aes_i),
    .tl_o            (tl_aes_o),
    .alert_rx_i      ({aes_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o      ()
  );

  // --- KEYMGR (additional EDN endpoint; register port terminated) ----------
  tlul_pkg::tl_d2h_t keymgr_tl_unused;
  keymgr u_keymgr (
    .clk_i,
    .rst_ni,
    .clk_edn_i      (clk_i),
    .rst_edn_ni     (rst_ni),
    .tl_i           (tlul_pkg::TL_H2D_DEFAULT),
    .tl_o           (keymgr_tl_unused),
    .aes_key_o      (),
    .hmac_key_o     (),
    .kmac_key_o     (),
    .kmac_data_o    (),
    .kmac_data_i    (kmac_pkg::APP_RSP_DEFAULT),
    .lc_keymgr_en_i (lc_ctrl_pkg::Off),
    .lc_keymgr_div_i('0),
    .otp_key_i      ('0),
    .otp_device_id_i('0),
    .flash_i        ('0),
    .edn_o          (edn_ep_req[EpKeymgr]),
    .edn_i          (edn_ep_rsp[EpKeymgr]),
    .rom_digest_i   ('0),
    .intr_op_done_o (),
    .alert_rx_i     ({keymgr_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o     ()
  );

  /* verilator lint_off UNUSED */
  wire _unused_es_stack = ^{keymgr_tl_unused};
  /* verilator lint_on UNUSED */
endmodule : e1_rot_ot_entropy_stack
