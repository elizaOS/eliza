// e1_rot_ot_blocks.sv
// Real OpenTitan crypto/security block instantiation harnesses for the E1 RoT.
//
// Each module here wraps a vendored OpenTitan IP (lowRISC, Apache-2.0, from the
// Earl Grey checkout pinned in external/opentitan/pin-manifest.json) with its
// rich sideband interfaces tied to the package-default idle values, exposing
// only the OpenTitan TL-UL device port (tlul_pkg::tl_h2d_t / tl_d2h_t). This is
// the integration boundary that replaces the fail-closed e1_rot_crypto_shim:
// the REAL block RTL elaborates here, behind the per-block
// E1_ROT_INSTANTIATE_<BLOCK> define, the same way the Ibex core is gated by
// E1_ROT_INSTANTIATE_IBEX.
//
// The TL device port is driven idle (tlul_pkg::TL_H2D_DEFAULT) at this stage --
// the RoT crossbar adapter that converts e1_rot_tlul_pkg <-> tlul_pkg and routes
// Ibex MMIO accesses into these blocks is the next integration step. The point
// proven by check_rot_integration.py at this stage is that the real OpenTitan
// RTL (not a shim) elaborates clean under Verilator inside the RoT flow.
//
// Sideband tie-offs use each block's own package defaults (ALERT_RX_DEFAULT,
// ESC_RX_DEFAULT, lc_ctrl_pkg::Off, '0 for request structs), matching how the
// Earl Grey top ties unused inputs. No functional crypto is claimed from a
// block whose data-path peers (EDN entropy, keymgr sideload, ROM image) are
// tied off; that wiring lands with the full secure-boot data path.

`timescale 1ns/1ps

// ---------------------------------------------------------------------------
// HMAC (SHA-2) -- secure-boot hash + keymgr KDF feed.
// ---------------------------------------------------------------------------
module e1_rot_ot_hmac (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  hmac u_hmac (
    .clk_i,
    .rst_ni,
    .tl_i,
    .tl_o,
    .alert_rx_i        ({hmac_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o        (),
    .intr_hmac_done_o  (),
    .intr_fifo_empty_o (),
    .intr_hmac_err_o   (),
    .idle_o            ()
  );
endmodule : e1_rot_ot_hmac

// ---------------------------------------------------------------------------
// KMAC (SHA-3 / cSHAKE) -- keymgr KDF + DICE.
// ---------------------------------------------------------------------------
module e1_rot_ot_kmac (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  kmac u_kmac (
    .clk_i,
    .rst_ni,
    .clk_edn_i   (clk_i),
    .rst_edn_ni  (rst_ni),
    .tl_i,
    .tl_o,
    .alert_rx_i  ({kmac_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o  (),
    .keymgr_key_i('0),
    .app_i       ('0),
    .app_o       (),
    .entropy_o   (),
    .entropy_i   ('0),
    .intr_kmac_done_o  (),
    .intr_fifo_empty_o (),
    .intr_kmac_err_o   (),
    .idle_o            ()
  );
endmodule : e1_rot_ot_kmac

// ---------------------------------------------------------------------------
// AES.
// ---------------------------------------------------------------------------
module e1_rot_ot_aes (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  aes u_aes (
    .clk_i,
    .rst_ni,
    .idle_o          (),
    .lc_escalate_en_i(lc_ctrl_pkg::Off),
    .clk_edn_i       (clk_i),
    .rst_edn_ni      (rst_ni),
    .edn_o           (),
    .edn_i           ('0),
    .tl_i,
    .tl_o,
    .alert_rx_i      ({aes_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o      ()
  );
endmodule : e1_rot_ot_aes

// ---------------------------------------------------------------------------
// CSRNG (CTR_DRBG).
// ---------------------------------------------------------------------------
module e1_rot_ot_csrng (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  csrng u_csrng (
    .clk_i,
    .rst_ni,
    .tl_i,
    .tl_o,
    .otp_en_csrng_sw_app_read_i(otp_ctrl_pkg::otp_en_t'(0)),
    .lc_hw_debug_en_i          (lc_ctrl_pkg::Off),
    .entropy_src_hw_if_o       (),
    .entropy_src_hw_if_i       ('0),
    .cs_aes_halt_i             ('0),
    .cs_aes_halt_o             (),
    .csrng_cmd_i               ('0),
    .csrng_cmd_o               (),
    .alert_rx_i                ({csrng_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o                (),
    .intr_cs_cmd_req_done_o    (),
    .intr_cs_entropy_req_o     (),
    .intr_cs_hw_inst_exc_o     (),
    .intr_cs_fatal_err_o       ()
  );
endmodule : e1_rot_ot_csrng

// ---------------------------------------------------------------------------
// EDN (entropy distribution network).
// ---------------------------------------------------------------------------
module e1_rot_ot_edn (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  edn u_edn (
    .clk_i,
    .rst_ni,
    .tl_i,
    .tl_o,
    .edn_i                   ('0),
    .edn_o                   (),
    .csrng_cmd_o             (),
    .csrng_cmd_i             ('0),
    .alert_rx_i              ({edn_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o              (),
    .intr_edn_cmd_req_done_o (),
    .intr_edn_fatal_err_o    ()
  );
endmodule : e1_rot_ot_edn

// ---------------------------------------------------------------------------
// ENTROPY_SRC.
// ---------------------------------------------------------------------------
module e1_rot_ot_entropy_src (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  entropy_src u_entropy_src (
    .clk_i,
    .rst_ni,
    .tl_i,
    .tl_o,
    .otp_en_entropy_src_fw_read_i(otp_ctrl_pkg::otp_en_t'(0)),
    .otp_en_entropy_src_fw_over_i(otp_ctrl_pkg::otp_en_t'(0)),
    .rng_fips_o                  (),
    .entropy_src_hw_if_i         ('0),
    .entropy_src_hw_if_o         (),
    .entropy_src_rng_o           (),
    .entropy_src_rng_i           ('0),
    .cs_aes_halt_o               (),
    .cs_aes_halt_i               ('0),
    .entropy_src_xht_o           (),
    .entropy_src_xht_i           ('0),
    .alert_rx_i                  ({entropy_src_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o                  (),
    .intr_es_entropy_valid_o     (),
    .intr_es_health_test_failed_o(),
    .intr_es_observe_fifo_ready_o(),
    .intr_es_fatal_err_o         ()
  );
endmodule : e1_rot_ot_entropy_src

// ---------------------------------------------------------------------------
// KEYMGR (key manager / DICE).
// ---------------------------------------------------------------------------
module e1_rot_ot_keymgr (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  keymgr u_keymgr (
    .clk_i,
    .rst_ni,
    .clk_edn_i      (clk_i),
    .rst_edn_ni     (rst_ni),
    .tl_i,
    .tl_o,
    .aes_key_o      (),
    .hmac_key_o     (),
    .kmac_key_o     (),
    .kmac_data_o    (),
    .kmac_data_i    ('0),
    .lc_keymgr_en_i (lc_ctrl_pkg::Off),
    .lc_keymgr_div_i('0),
    .otp_key_i      ('0),
    .otp_device_id_i('0),
    .flash_i        ('0),
    .edn_o          (),
    .edn_i          ('0),
    .rom_digest_i   ('0),
    .intr_op_done_o (),
    .alert_rx_i     ({keymgr_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o     ()
  );
endmodule : e1_rot_ot_keymgr

// ---------------------------------------------------------------------------
// ROM_CTRL (mask-ROM controller + integrity check). Exposes the register TL
// port; the ROM data TL port is driven idle.
// ---------------------------------------------------------------------------
module e1_rot_ot_rom_ctrl (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  tlul_pkg::tl_d2h_t rom_tl_unused;
  rom_ctrl u_rom_ctrl (
    .clk_i,
    .rst_ni,
    .rom_cfg_i     ('0),
    .rom_tl_i      (tlul_pkg::TL_H2D_DEFAULT),
    .rom_tl_o      (rom_tl_unused),
    .regs_tl_i     (tl_i),
    .regs_tl_o     (tl_o),
    .alert_rx_i    ({rom_ctrl_reg_pkg::NumAlerts{prim_alert_pkg::ALERT_RX_DEFAULT}}),
    .alert_tx_o    (),
    .pwrmgr_data_o (),
    .keymgr_data_o (),
    .kmac_data_i   ('0),
    .kmac_data_o   ()
  );
  /* verilator lint_off UNUSED */
  wire _unused_rom = ^{rom_tl_unused};
  /* verilator lint_on UNUSED */
endmodule : e1_rot_ot_rom_ctrl

// ---------------------------------------------------------------------------
// ALERT_HANDLER -- alert/escalation aggregation.
// ---------------------------------------------------------------------------
module e1_rot_ot_alert_handler (
    input  logic                clk_i,
    input  logic                rst_ni,
    input  tlul_pkg::tl_h2d_t   tl_i,
    output tlul_pkg::tl_d2h_t   tl_o
);
  alert_handler u_alert_handler (
    .clk_i,
    .rst_ni,
    .clk_edn_i    (clk_i),
    .rst_edn_ni   (rst_ni),
    .tl_i,
    .tl_o,
    .intr_classa_o(),
    .intr_classb_o(),
    .intr_classc_o(),
    .intr_classd_o(),
    .crashdump_o  (),
    .edn_o        (),
    .edn_i        ('0),
    .alert_tx_i   ({alert_pkg::NAlerts{prim_alert_pkg::ALERT_TX_DEFAULT}}),
    .alert_rx_o   (),
    .esc_rx_i     ({alert_pkg::N_ESC_SEV{prim_esc_pkg::ESC_RX_DEFAULT}}),
    .esc_tx_o     ()
  );
endmodule : e1_rot_ot_alert_handler
