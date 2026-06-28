// e1_rot_ot_keymgr_stack.sv
// Functional keymgr key-ladder interconnect for the E1 RoT.
//
// Wires the REAL OpenTitan key manager (keymgr) into the live entropy +
// KMAC-KDF topology it needs to advance its key ladder, built entirely from
// the vendored OpenTitan IPs and *_pkg struct types (no hand-rolled ladder,
// no hand-rolled DRBG / health tests):
//
//   e1_rot_rng_model -> entropy_src -> csrng -> edn -> { kmac, keymgr } edn ports
//   keymgr.kmac_data_o/_i  <->  kmac.app_i[0]/app_o[0]   (the KeyMgr KDF app port)
//   keymgr.kmac_key_o      ->   kmac.keymgr_key_i        (sideloaded KDF key)
//
// This is the Earl Grey integration topology: the key manager runs each ladder
// stage as a KMAC operation over the KMAC application interface (app index 0,
// AppKMAC mode), with the current stage key supplied to KMAC as the sideloaded
// keymgr_key. KMAC (EnMasking=1) sources its masking entropy from the same real
// EDN the entropy KAT proves. The key manager itself reseeds its internal PRNG
// from a second EDN endpoint.
//
// Four register TL-UL device ports are exposed so the RoT control crossbar can
// program the chain exactly as firmware would:
//   tl_es_*     entropy_src registers
//   tl_cs_*     csrng registers
//   tl_edn_*    edn registers
//   tl_kmac_*   kmac registers       (SW programs CFG: EnMasking entropy ready)
//   tl_keymgr_* keymgr registers      (SW drives Init -> Advance -> Generate)
//
// Deterministic test seeds (creator/owner identity is FIXED in simulation, not a
// provisioned silicon device identity): otp_key_i / otp_device_id_i / rom_digest_i
// / flash_i carry the *_pkg deterministic test/default constants. This proves the
// hardware key-ladder DATAPATH and that the produced key is bound to the SW
// binding/salt inputs through the real KMAC KDF. It is NOT a real UDS / silicon
// device-identity claim: there is no AST entropy and no fused device secret.
//
// The keymgr's hardware-only sideload key output (kmac_key_o) is exposed as
// keymgr_sideload_o so a testbench can capture it and prove the ladder output
// diverges deterministically with the binding input (tamper divergence).

`timescale 1ns/1ps

module e1_rot_ot_keymgr_stack
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
    input  tlul_pkg::tl_h2d_t tl_keymgr_i,
    output tlul_pkg::tl_d2h_t tl_keymgr_o,

    // Hardware-only sideload key the keymgr emits (kmac_key_o), exposed for the
    // tamper-divergence proof. In silicon this never leaves the chip.
    output keymgr_pkg::hw_key_req_t keymgr_sideload_o
);

  localparam int unsigned NumEndPoints = 7;
  localparam int unsigned EpKmac   = 0;
  localparam int unsigned EpKeymgr = 1;

  // entropy_src <-> csrng push interface.
  entropy_src_pkg::entropy_src_hw_if_req_t es_hw_if_req;
  entropy_src_pkg::entropy_src_hw_if_rsp_t es_hw_if_rsp;
  entropy_src_pkg::cs_aes_halt_req_t       cs_aes_halt_req;
  entropy_src_pkg::cs_aes_halt_rsp_t       cs_aes_halt_rsp;

  // entropy_src <-> behavioral RNG noise model.
  entropy_src_pkg::entropy_src_rng_req_t   es_rng_req;
  entropy_src_pkg::entropy_src_rng_rsp_t   es_rng_rsp;

  // csrng <-> edn application interface (index 1 is the EDN app; index 0 is the
  // csrng SW app port, tied idle).
  csrng_pkg::csrng_req_t [1:0] cs_cmd_req;
  csrng_pkg::csrng_rsp_t [1:0] cs_cmd_rsp;

  csrng_pkg::csrng_req_t edn_to_cs_req;
  csrng_pkg::csrng_rsp_t cs_to_edn_rsp;

  // edn endpoints.
  edn_pkg::edn_req_t [NumEndPoints-1:0] edn_ep_req;
  edn_pkg::edn_rsp_t [NumEndPoints-1:0] edn_ep_rsp;

  // keymgr <-> kmac KDF application port.
  kmac_pkg::app_req_t keymgr_to_kmac;
  kmac_pkg::app_rsp_t kmac_to_keymgr;

  // keymgr sideloaded key fed back into kmac (the stage key for the KDF).
  keymgr_pkg::hw_key_req_t keymgr_kmac_key;

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

  for (genvar i = 0; i < NumEndPoints; i++) begin : gen_idle_ep
    if (i != EpKmac && i != EpKeymgr) begin : gen_idle
      assign edn_ep_req[i] = edn_pkg::EDN_REQ_DEFAULT;
    end
  end

  // --- KMAC (KDF engine for the key ladder) --------------------------------
  // The keymgr drives KMAC through application interface 0 (AppKMAC mode); the
  // current stage key is supplied as the sideloaded keymgr_key. SW programs the
  // KMAC register port only to set CFG (EnMasking entropy ready / EdnMode).
  kmac_pkg::app_req_t [kmac_pkg::NumAppIntf-1:0] kmac_app_req;
  kmac_pkg::app_rsp_t [kmac_pkg::NumAppIntf-1:0] kmac_app_rsp;

  assign kmac_app_req[0] = keymgr_to_kmac;
  assign kmac_to_keymgr  = kmac_app_rsp[0];
  for (genvar i = 1; i < kmac_pkg::NumAppIntf; i++) begin : gen_idle_app
    assign kmac_app_req[i] = kmac_pkg::APP_REQ_DEFAULT;
  end

  kmac u_kmac (
    .clk_i,
    .rst_ni,
    .clk_edn_i   (clk_i),
    .rst_edn_ni  (rst_ni),
    .tl_i        (tl_kmac_i),
    .tl_o        (tl_kmac_o),
    .alert_rx_i  ({kmac_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o  (),
    .keymgr_key_i(keymgr_kmac_key),
    .app_i       (kmac_app_req),
    .app_o       (kmac_app_rsp),
    .entropy_o   (edn_ep_req[EpKmac]),
    .entropy_i   (edn_ep_rsp[EpKmac]),
    .intr_kmac_done_o  (),
    .intr_fifo_empty_o (),
    .intr_kmac_err_o   (),
    .idle_o            ()
  );

  // --- KEYMGR (the key ladder under test) ----------------------------------
  // Deterministic test creator/owner roots (NOT a provisioned silicon UDS):
  //   otp_key_i        : OTP_KEYMGR_KEY_DEFAULT (fixed creator root key, valid)
  //   otp_device_id_i  : fixed test device id
  //   rom_digest_i     : fixed valid ROM digest
  //   flash_i          : KEYMGR_FLASH_DEFAULT seeds
  //   lc_keymgr_en_i   : On (lifecycle gate that authorizes the ladder)
  // The creator/owner identity seeds are the keymgr_pkg RndCnst defaults
  // compiled into the vendored RTL.
  localparam otp_ctrl_pkg::otp_device_id_t TestDeviceId =
      256'h0123_4567_89ab_cdef_fedc_ba98_7654_3210_0f1e_2d3c_4b5a_6978_8796_a5b4_c3d2_e1f0;

  keymgr u_keymgr (
    .clk_i,
    .rst_ni,
    .clk_edn_i      (clk_i),
    .rst_edn_ni     (rst_ni),
    .tl_i           (tl_keymgr_i),
    .tl_o           (tl_keymgr_o),
    .aes_key_o      (),
    .hmac_key_o     (),
    .kmac_key_o     (keymgr_kmac_key),
    .kmac_data_o    (keymgr_to_kmac),
    .kmac_data_i    (kmac_to_keymgr),
    .lc_keymgr_en_i (lc_ctrl_pkg::On),
    .lc_keymgr_div_i(lc_ctrl_pkg::lc_keymgr_div_t'(64'hcafef00d_5a5a_a5a5)),
    .otp_key_i      (otp_ctrl_pkg::OTP_KEYMGR_KEY_DEFAULT),
    .otp_device_id_i(TestDeviceId),
    .flash_i        (flash_ctrl_pkg::KEYMGR_FLASH_DEFAULT),
    .edn_o          (edn_ep_req[EpKeymgr]),
    .edn_i          (edn_ep_rsp[EpKeymgr]),
    .rom_digest_i   ('{data: 256'hd0c0_ba98_7654_3210_0123_4567_89ab_cdef_dead_beef_face_b00c_1234_5678_9abc_def0,
                       valid: 1'b1}),
    .intr_op_done_o (),
    .alert_rx_i     ({keymgr_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o     ()
  );

  assign keymgr_sideload_o = keymgr_kmac_key;

endmodule : e1_rot_ot_keymgr_stack
