// e1_rot_top.sv
// E1 root-of-trust integration top (W1, the long pole).
//
// Per docs/security/tee-plan/02-root-of-trust.md S1 (Option A): a discrete
// OpenTitan Earl Grey-class Ibex secure subsystem integrated as the E1 RoT. On
// cold boot only the RoT runs; it holds the CVA6 application cluster and the
// PMC in reset until a verified, measured boot, then releases them. The AP
// reaches the RoT only through a TL-UL mailbox -- never the RoT internal SRAM,
// OTP secrets, or the key manager.
//
// Composition:
//   * Ibex RV32IMC          -- the RoT processor. REAL: instantiated from the
//                              FuseSoC-staged lowRISC tree (external/ibex/ibex/
//                              build/...), shared with the PMC lane, under the
//                              E1_ROT_INSTANTIATE_IBEX define. Same config
//                              envelope as external/ibex/pin-manifest.json.
//   * RoT SRAM + mask-ROM   -- REAL: behavioral instruction/data memory backing
//                              the mask ROM region and the RoT scratch SRAM.
//   * e1_otp_map (W4)        -- REAL: instantiated from rtl/security/otp/
//                              e1_otp_map.sv (parallel agent). NOT re-created
//                              here.
//   * e1_lc_ctrl (W5)        -- lifecycle controller. Bound by name behind
//                              E1_ROT_HAVE_LC_CTRL against the documented W5
//                              port list (parallel agent). Until W5 lands, the
//                              wrapper consumes the OTP lifecycle one-hot
//                              directly for reset-release gating -- it does NOT
//                              implement its own lifecycle controller.
//   * e1_rot_mailbox         -- REAL: AP<->RoT TL-UL mailbox.
//   * e1_rot_reset_seq       -- REAL: cold-boot reset sequencer (fail-closed).
//   * OpenTitan crypto blocks -- rom_ctrl, keymgr, kmac, hmac, aes, csrng, edn,
//                              entropy_src, alert_handler. REAL under each
//                              E1_ROT_INSTANTIATE_<BLOCK> define: the vendored
//                              OpenTitan IP is instantiated via the
//                              e1_rot_ot_<block> harness (e1_rot_ot_blocks.sv)
//                              with package-default sideband tie-offs and its
//                              tlul_pkg TL-UL device port exposed. When a
//                              define is absent the block falls back to the
//                              fail-closed e1_rot_crypto_shim. The TL ports are
//                              tied idle here; the crossbar adapter wiring the
//                              real blocks into the Ibex data path lands with
//                              the secure-boot data path. See e1_rot_ot_blocks.sv
//                              and e1_rot_crypto_shim.sv.
//
// Synthesizable wrapper; lints/elaborates clean under Verilator for the
// integrated scope.

`timescale 1ns/1ps

module e1_rot_top
  import e1_rot_tlul_pkg::*;
#(
    // RoT SRAM/mask-ROM aperture. The Ibex boots from ROT_BOOT_ADDR.
    parameter logic [31:0] ROT_BOOT_ADDR = 32'h0000_0000,
    parameter int unsigned ROT_MEM_BYTES = 64 * 1024,
    // MMIO base of the RoT register crossbar (OTP / LC / mailbox / crypto).
    parameter logic [31:0] ROT_MMIO_BASE = 32'h2000_0000
) (
    input  logic clk_i,
    input  logic rst_ni,              // RoT power-on reset

    // ----------------------------------------------------------------
    // Platform reset outputs (to the E1 SoC top). Active-low: 0 = held in
    // reset, 1 = released. The RoT releases these only on verified boot.
    // ----------------------------------------------------------------
    output logic cva6_rst_no,
    output logic pmc_rst_no,

    // ----------------------------------------------------------------
    // Secure-boot verdict + IOPMP policy-ready inputs to the reset sequencer.
    // In the integrated SoC these are driven by the mask-ROM verifier (R2/R3)
    // and the IOPMP programming sequence (lane 03). Exposed at the top so the
    // cocotb reset-release test can drive them.
    // ----------------------------------------------------------------
    input  logic boot_verified_i,
    input  logic iopmp_policy_ready_i,

    // ----------------------------------------------------------------
    // AP-facing TL-UL mailbox port (to the CVA6 AP domain).
    // ----------------------------------------------------------------
    input  tl_h2d_t mbox_tl_i,
    output tl_d2h_t mbox_tl_o,

    // ----------------------------------------------------------------
    // OTP provisioning macro contents (behavioral; silicon replaces with the
    // OTP read port). Three redundant rows for the 2-of-3 majority read.
    // ----------------------------------------------------------------
    input  logic [32*32-1:0] otp_row0_init_i,
    input  logic [32*32-1:0] otp_row1_init_i,
    input  logic [32*32-1:0] otp_row2_init_i,

    // ----------------------------------------------------------------
    // Observability for the gate / cocotb.
    // ----------------------------------------------------------------
    output logic [2:0]  reset_state_o,
    output logic        platform_released_o,
    output logic        rot_halted_o,
    output logic        otp_parity_fault_o,
    output logic [7:0]  lifecycle_state_o,
    output logic        mbox_req_pending_o,
    output logic        mbox_resp_ready_o
);

  // ================================================================
  // Reset sequencer (fail-closed cold-boot ordering).
  // ================================================================
  logic rot_rst_no;
  logic [7:0] lifecycle_state;
  logic       lc_scrap;

  // SCRAP is lifecycle one-hot bit 5 (otp-fuse-map.md S2 / e1_otp_map LC_SCRAP).
  assign lc_scrap = lifecycle_state[5];

  e1_rot_reset_seq u_reset_seq (
    .clk_i               (clk_i),
    .rst_ni              (rst_ni),
    .boot_verified_i     (boot_verified_i),
    .iopmp_policy_ready_i(iopmp_policy_ready_i),
    .lc_scrap_i          (lc_scrap),
    .rot_rst_no          (rot_rst_no),
    .cva6_rst_no         (cva6_rst_no),
    .pmc_rst_no          (pmc_rst_no),
    .state_o             (reset_state_o),
    .platform_released_o (platform_released_o),
    .halted_o            (rot_halted_o)
  );

  // The RoT internal logic runs on the RoT-released reset: the Ibex, SRAM,
  // crossbar, OTP, mailbox come up when the sequencer releases the RoT domain.
  logic rot_rst_n_int;
  assign rot_rst_n_int = rst_ni & rot_rst_no;

  // ================================================================
  // RoT data-bus register crossbar fan-out. The Ibex data port (or, before the
  // Ibex is instantiated, an idle master) addresses OTP / LC / mailbox / crypto
  // shims in the ROT_MMIO_BASE aperture. A flat valid/write/addr/wdata/rdata
  // register port is sufficient for the RoT's slow control-plane accesses.
  // ================================================================
  logic        rot_reg_valid;
  logic        rot_reg_write;
  logic [11:0] rot_reg_addr;     // byte offset within the MMIO aperture
  logic [31:0] rot_reg_wdata;
  logic [31:0] rot_reg_rdata;

  // Sub-aperture decode (4 KiB windows within ROT_MMIO_BASE):
  //   +0x000  OTP controller (e1_otp_map)
  //   +0x100  mailbox RoT-facing port
  //   +0x200  crypto/security shims (TL-UL; accessed via per-block adapters)
  localparam logic [11:0] WIN_OTP   = 12'h000;
  localparam logic [11:0] WIN_MBOX  = 12'h100;

  logic sel_otp;
  logic sel_mbox;
  assign sel_otp  = (rot_reg_addr[11:8] == WIN_OTP[11:8]);
  assign sel_mbox = (rot_reg_addr[11:8] == WIN_MBOX[11:8]);

  // ================================================================
  // OTP controller (W4) -- REAL.
  // ================================================================
  logic [31:0] otp_rdata;
  logic        otp_tamper_event;
  e1_otp_map u_otp (
    .clk               (clk_i),
    .rst_n             (rot_rst_n_int),
    .valid             (rot_reg_valid & sel_otp),
    .write             (rot_reg_write & sel_otp),
    .addr              (rot_reg_addr[$clog2(32)+2-1:2]),
    .wdata             (rot_reg_wdata),
    .rdata             (otp_rdata),
    .auth_ok_i         (1'b0),       // signed-auth path lands with R2/R3 firmware
    .otp_row0_init_i   (otp_row0_init_i),
    .otp_row1_init_i   (otp_row1_init_i),
    .otp_row2_init_i   (otp_row2_init_i),
    .otp_parity_fault_o(otp_parity_fault_o),
    .tamper_event_o    (otp_tamper_event),
    .lifecycle_state_o (lifecycle_state)
  );
  assign lifecycle_state_o = lifecycle_state;

  // ================================================================
  // Lifecycle controller (W5) binding.
  // ================================================================
`ifdef E1_ROT_HAVE_LC_CTRL
  // Bind to the parallel-agent W5 module by its documented name/ports. The
  // controller consumes the OTP lifecycle one-hot and the signed debug-auth
  // challenge/response, and produces the decoded lifecycle + debug-auth grant.
  // Port list per docs/security/tee-plan/02-root-of-trust.md S4 + debug-policy.md.
  logic        lc_debug_auth_granted;
  e1_lc_ctrl u_lc_ctrl (
    .clk_i                 (clk_i),
    .rst_ni                (rot_rst_n_int),
    .otp_lifecycle_state_i (lifecycle_state),
    .debug_auth_granted_o  (lc_debug_auth_granted)
  );
  /* verilator lint_off UNUSED */
  wire _unused_lc = lc_debug_auth_granted;
  /* verilator lint_on UNUSED */
`endif

  // ================================================================
  // AP <-> RoT mailbox -- REAL.
  // ================================================================
  logic [31:0] mbox_rot_rdata;
  logic [31:0] mbox_req_cmd;
  e1_rot_mailbox #(
    .NUM_DATA_WORDS(8)
  ) u_mailbox (
    .clk_i        (clk_i),
    .rst_ni       (rot_rst_n_int),
    .tl_ap_i      (mbox_tl_i),
    .tl_ap_o      (mbox_tl_o),
    .rot_valid_i  (rot_reg_valid & sel_mbox),
    .rot_write_i  (rot_reg_write & sel_mbox),
    .rot_addr_i   (rot_reg_addr[7:2]),
    .rot_wdata_i  (rot_reg_wdata),
    .rot_rdata_o  (mbox_rot_rdata),
    .req_pending_o(mbox_req_pending_o),
    .resp_ready_o (mbox_resp_ready_o),
    .req_cmd_o    (mbox_req_cmd)
  );

  // RoT register read mux.
  assign rot_reg_rdata = sel_otp  ? otp_rdata      :
                         sel_mbox ? mbox_rot_rdata : 32'h0;

  // ================================================================
  // OpenTitan crypto/security blocks.
  //
  // Each block is instantiated REAL behind its own E1_ROT_INSTANTIATE_<BLOCK>
  // define (via the e1_rot_ot_<block> harness in e1_rot_ot_blocks.sv, which
  // wraps the vendored OpenTitan IP with package-default sideband tie-offs and
  // exposes the tlul_pkg TL-UL device port). When the define is absent the
  // block falls back to the fail-closed e1_rot_crypto_shim (correct
  // e1_rot_tlul_pkg signature, error-tagged responses). check_rot_integration.py
  // enumerates a block as REAL only when its harness elaborates clean in the
  // gate's Verilator lint with the block's generated filelist; otherwise the
  // block stays BLOCKED.
  //
  // The TL device ports are driven idle at this stage -- the RoT crossbar
  // adapter that converts e1_rot_tlul_pkg <-> tlul_pkg and routes Ibex MMIO
  // accesses into these blocks lands with the secure-boot data path. The
  // instantiation here proves the real RTL elaborates inside the RoT flow and
  // represents its area/port footprint in the elaborated netlist.
  // ================================================================
  // The crypto control crossbar (e1_rot_xbar) is enabled whenever any real
  // OpenTitan crypto/security block is instantiated. The integrated gate sets
  // all nine E1_ROT_INSTANTIATE_<BLOCK> defines; any one of them activates the
  // real tlul_pkg datapath instead of the fail-closed shim bank.
`ifdef E1_ROT_INSTANTIATE_ROM_CTRL
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_KEYMGR
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_KMAC
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_HMAC
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_AES
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_CSRNG
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_EDN
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_ENTROPY_SRC
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif
`ifdef E1_ROT_INSTANTIATE_ALERT_HANDLER
  `define E1_ROT_INSTANTIATE_CRYPTO_XBAR
`endif

  // Crypto MMIO host port (driven by the Ibex data port crypto window, or idle
  // when the Ibex is not instantiated). Declared at module scope (under the
  // xbar define, since that is the only configuration that uses them) so both
  // the xbar block and the Ibex memory-interface block reference the same nets.
`ifdef E1_ROT_INSTANTIATE_CRYPTO_XBAR
  logic        crypto_host_req;
  logic [31:0] crypto_host_addr;
  logic        crypto_host_we;
  logic [31:0] crypto_host_wdata;
  logic [3:0]  crypto_host_be;
`endif

  localparam int unsigned NUM_CRYPTO = 9;
  // Block-id order MUST match BLOCKS (crypto) in scripts/check_rot_integration.py.
  localparam logic [31:0] CRYPTO_ID [NUM_CRYPTO] = '{
    32'h524F4D43, // "ROMC" rom_ctrl
    32'h4B45594D, // "KEYM" keymgr
    32'h4B4D4143, // "KMAC" kmac
    32'h484D4143, // "HMAC" hmac
    32'h41455320, // "AES " aes
    32'h43535247, // "CSRG" csrng
    32'h45444E20, // "EDN " edn
    32'h454E5452, // "ENTR" entropy_src
    32'h414C5254  // "ALRT" alert_handler
  };

  // ----------------------------------------------------------------
  // Crypto control crossbar (REAL datapath).
  //
  // When any real OpenTitan block is instantiated (E1_ROT_INSTANTIATE_*), the
  // RoT crypto control bus is the vendored tlul_pkg, routed by e1_rot_xbar
  // (tlul_adapter_host + tlul_socket_1n). The Ibex data accesses into the
  // crypto MMIO window (ROT_MMIO_BASE + CRYPTO_WIN_OFF, addr[27:24]==1) drive
  // the crossbar host port; the socket fans out to the nine device windows
  // (4 KiB each, idx = addr[15:12]) defined in e1_rot_xbar.sv. The HMAC KAT
  // (verify/cocotb/rot/test_e1_rot_kat.py) proves SHA-256 through this exact
  // host->adapter->socket->block path.
  //
  // crypto_block_tap aggregates each device response so the device ports are
  // not optimized away; it is consumed in _unused_misc below.
  // ----------------------------------------------------------------
  logic [NUM_CRYPTO-1:0] crypto_shim_valid;
  logic [NUM_CRYPTO-1:0] crypto_block_tap;

`ifdef E1_ROT_INSTANTIATE_CRYPTO_XBAR
  tlul_pkg::tl_h2d_t crypto_dev_h2d [NUM_CRYPTO];
  tlul_pkg::tl_d2h_t crypto_dev_d2h [NUM_CRYPTO];

  // Crypto MMIO window select from the Ibex data port (addr[27:24]==1).
  logic        crypto_host_gnt;
  logic        crypto_host_rvalid;
  logic [31:0] crypto_host_rdata;
  logic        crypto_host_err;
  logic        crypto_host_intg_err;

  e1_rot_xbar #(
    .N_DEVICE (NUM_CRYPTO)
  ) u_crypto_xbar (
    .clk_i,
    .rst_ni       (rot_rst_n_int),
    .host_req_i   (crypto_host_req),
    .host_gnt_o   (crypto_host_gnt),
    .host_addr_i  (crypto_host_addr),
    .host_we_i    (crypto_host_we),
    .host_wdata_i (crypto_host_wdata),
    .host_be_i    (crypto_host_be),
    .host_rvalid_o(crypto_host_rvalid),
    .host_rdata_o (crypto_host_rdata),
    .host_err_o   (crypto_host_err),
    .host_intg_err_o(crypto_host_intg_err),
    .dev_tl_o     (crypto_dev_h2d),
    .dev_tl_i     (crypto_dev_d2h)
  );

  for (genvar i = 0; i < NUM_CRYPTO; i++) begin : gen_crypto_tap
    assign crypto_block_tap[i] = ^{crypto_dev_d2h[i]};
    assign crypto_shim_valid[i] = 1'b0;
  end

  e1_rot_ot_rom_ctrl     u_rom_ctrl     (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[0]), .tl_o(crypto_dev_d2h[0]));
  e1_rot_ot_keymgr       u_keymgr       (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[1]), .tl_o(crypto_dev_d2h[1]));
  e1_rot_ot_kmac         u_kmac         (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[2]), .tl_o(crypto_dev_d2h[2]));
  e1_rot_ot_hmac         u_hmac         (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[3]), .tl_o(crypto_dev_d2h[3]));
  e1_rot_ot_aes          u_aes          (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[4]), .tl_o(crypto_dev_d2h[4]));
  e1_rot_ot_csrng        u_csrng        (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[5]), .tl_o(crypto_dev_d2h[5]));
  e1_rot_ot_edn          u_edn          (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[6]), .tl_o(crypto_dev_d2h[6]));
  e1_rot_ot_entropy_src  u_entropy_src  (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[7]), .tl_o(crypto_dev_d2h[7]));
  e1_rot_ot_alert_handler u_alert_handler (.clk_i, .rst_ni(rot_rst_n_int),
    .tl_i(crypto_dev_h2d[8]), .tl_o(crypto_dev_d2h[8]));

  /* verilator lint_off UNUSED */
  wire _unused_xbar = ^{crypto_host_gnt, crypto_host_rvalid, crypto_host_rdata,
                        crypto_host_err, crypto_host_intg_err};
  /* verilator lint_on UNUSED */
`else
  // No real block instantiated: keep the fail-closed shims (correct
  // e1_rot_tlul_pkg signature, error-tagged responses) so the spine still
  // elaborates and the reset/mailbox cocotb contracts run without the crypto
  // closure. The crypto xbar/datapath only exists when a real block is present.
`define E1_ROT_CRYPTO_SHIM(IDX) \
    tl_d2h_t shim_tl_o; \
    e1_rot_crypto_shim #(.BLOCK_ID(CRYPTO_ID[IDX])) u_crypto_shim ( \
      .clk_i(clk_i), .rst_ni(rot_rst_n_int), .tl_i(TL_H2D_DEFAULT), \
      .tl_o(shim_tl_o), .result_valid_o(crypto_shim_valid[IDX])); \
    assign crypto_block_tap[IDX] = ^{shim_tl_o};
  if (1) begin : gen_rom_ctrl      `E1_ROT_CRYPTO_SHIM(0) end
  if (1) begin : gen_keymgr        `E1_ROT_CRYPTO_SHIM(1) end
  if (1) begin : gen_kmac          `E1_ROT_CRYPTO_SHIM(2) end
  if (1) begin : gen_hmac          `E1_ROT_CRYPTO_SHIM(3) end
  if (1) begin : gen_aes           `E1_ROT_CRYPTO_SHIM(4) end
  if (1) begin : gen_csrng         `E1_ROT_CRYPTO_SHIM(5) end
  if (1) begin : gen_edn           `E1_ROT_CRYPTO_SHIM(6) end
  if (1) begin : gen_entropy_src   `E1_ROT_CRYPTO_SHIM(7) end
  if (1) begin : gen_alert_handler `E1_ROT_CRYPTO_SHIM(8) end
`endif

  /* verilator lint_off UNUSED */
  wire _unused_misc = ^{otp_tamper_event, crypto_shim_valid, crypto_block_tap,
                        lc_scrap, mbox_req_cmd, rot_reg_addr[1:0],
                        ROT_BOOT_ADDR, ROT_MMIO_BASE};
  /* verilator lint_on UNUSED */

  // ================================================================
  // RoT processor: Ibex RV32IMC -- REAL under E1_ROT_INSTANTIATE_IBEX.
  // Instantiation mirrors rtl/power/pmc_top.sv (the proven PMC Ibex pattern)
  // and the config envelope in external/ibex/pin-manifest.json. The Ibex
  // instr/data buses are served by the RoT SRAM/mask-ROM model; data accesses
  // into the ROT_MMIO_BASE aperture drive the register crossbar above.
  // ================================================================
`ifdef E1_ROT_INSTANTIATE_IBEX
  localparam int unsigned ROT_MEM_WORDS = ROT_MEM_BYTES / 4;
  localparam int unsigned ROT_MEM_AW    = $clog2(ROT_MEM_WORDS);

  logic [31:0] rot_mem_q [ROT_MEM_WORDS];

  initial begin : rot_mem_preload
    string rot_hex_path;
    for (int unsigned w = 0; w < ROT_MEM_WORDS; w++) begin
      rot_mem_q[w] = 32'h0000_0013;   // RV32 NOP at reset
    end
    if ($value$plusargs("ROT_MEM_HEX=%s", rot_hex_path)) begin
      $display("[e1_rot_top] preloading RoT SRAM/ROM from %s", rot_hex_path);
      $readmemh(rot_hex_path, rot_mem_q);
    end
  end

  logic        ibex_instr_req;
  logic        ibex_instr_gnt;
  logic        ibex_instr_rvalid;
  logic [31:0] ibex_instr_addr;
  logic [31:0] ibex_instr_rdata;
  logic        ibex_instr_err;
  logic        ibex_data_req;
  logic        ibex_data_gnt;
  logic        ibex_data_rvalid;
  logic        ibex_data_we;
  logic [3:0]  ibex_data_be;
  logic [31:0] ibex_data_addr;
  logic [31:0] ibex_data_wdata;
  logic [31:0] ibex_data_rdata;
  logic        ibex_data_err;
  logic        ibex_core_sleep;

  // SRAM/OTP/mailbox single-cycle response (the crypto window response comes
  // from the crossbar; the two are muxed onto the Ibex data port below).
  logic        mem_data_gnt;
  logic        mem_data_rvalid;
  logic [31:0] mem_data_rdata;
  logic        mem_data_err;

  // Memory aperture decode: ROT_BOOT_ADDR .. +ROT_MEM_BYTES is SRAM/ROM;
  // ROT_MMIO_BASE .. +4KiB is the register crossbar.
  logic [ROT_MEM_AW-1:0] instr_word_idx;
  logic [ROT_MEM_AW-1:0] data_word_idx;
  logic                  instr_in_mem;
  logic                  data_in_mem;
  logic                  data_in_mmio;

  // MMIO aperture split (addr[27:24] selects the sub-region within the MMIO
  // nibble ROT_MMIO_BASE[31:28]):
  //   addr[27:24]==0  OTP / lifecycle / mailbox flat register window
  //   addr[27:24]==1  crypto control crossbar (e1_rot_xbar -> 9 OT blocks)
  logic data_in_crypto;
  assign instr_in_mem  = (ibex_instr_addr[31:16] == ROT_BOOT_ADDR[31:16]);
  assign data_in_mem   = (ibex_data_addr [31:16] == ROT_BOOT_ADDR[31:16]);
  assign data_in_mmio  = (ibex_data_addr [31:28] == ROT_MMIO_BASE[31:28]) &&
                         (ibex_data_addr [27:24] == 4'h0) &&
                         (ibex_data_addr [23:12] == ROT_MMIO_BASE[23:12]);
  assign data_in_crypto = (ibex_data_addr [31:28] == ROT_MMIO_BASE[31:28]) &&
                          (ibex_data_addr [27:24] == 4'h1);
  assign instr_word_idx = ibex_instr_addr[ROT_MEM_AW+2-1:2];
  assign data_word_idx  = ibex_data_addr [ROT_MEM_AW+2-1:2];

  // Drive the register crossbar from Ibex data accesses into the MMIO aperture.
  assign rot_reg_valid = ibex_data_req & data_in_mmio;
  assign rot_reg_write = ibex_data_we;
  assign rot_reg_addr  = ibex_data_addr[11:0];
  assign rot_reg_wdata = ibex_data_wdata;

  // Drive the crypto control crossbar host port from Ibex accesses into the
  // crypto window. The crossbar host is the vendored tlul_adapter_host: it has
  // its own multi-cycle gnt/rvalid handshake (socket FIFO latency), so a RoT
  // firmware MMIO load to a crypto block must honor that handshake. The
  // single-cycle response model below answers OTP/mailbox/SRAM directly; the
  // crypto window response is the crossbar's. The host-driven firmware crypto
  // path is exercised structurally here and functionally by the HMAC KAT
  // (verify/cocotb/rot/test_e1_rot_kat.py) driving the crossbar host directly.
`ifdef E1_ROT_INSTANTIATE_CRYPTO_XBAR
  assign crypto_host_req   = ibex_data_req & data_in_crypto;
  assign crypto_host_we    = ibex_data_we;
  assign crypto_host_addr  = {16'h0, ibex_data_addr[15:0]};
  assign crypto_host_wdata = ibex_data_wdata;
  assign crypto_host_be    = ibex_data_be;
`endif

  // Single-cycle SRAM/ROM + MMIO response model.
  always_ff @(posedge clk_i or negedge rot_rst_n_int) begin
    if (!rot_rst_n_int) begin
      ibex_instr_gnt    <= 1'b0;
      ibex_instr_rvalid <= 1'b0;
      ibex_instr_rdata  <= 32'h0;
      ibex_instr_err    <= 1'b0;
      mem_data_gnt      <= 1'b0;
      mem_data_rvalid   <= 1'b0;
      mem_data_rdata    <= 32'h0;
      mem_data_err      <= 1'b0;
    end else begin
      ibex_instr_gnt    <= ibex_instr_req;
      ibex_instr_rvalid <= ibex_instr_req;
      ibex_instr_err    <= ibex_instr_req && !instr_in_mem;
      if (ibex_instr_req && instr_in_mem) begin
        ibex_instr_rdata <= rot_mem_q[instr_word_idx];
      end

      // SRAM/OTP/mailbox answer in one cycle. Crypto-window accesses are
      // answered by the crossbar's own gnt/rvalid handshake (see the crypto
      // response mux below), so they are excluded from this single-cycle path.
      mem_data_gnt    <= ibex_data_req & !data_in_crypto;
      mem_data_rvalid <= ibex_data_req & !data_in_crypto;
      mem_data_err    <= ibex_data_req && !(data_in_mem || data_in_mmio || data_in_crypto);
      if (ibex_data_req && data_in_mem) begin
        if (ibex_data_we) begin
          if (ibex_data_be[0]) rot_mem_q[data_word_idx][ 7: 0] <= ibex_data_wdata[ 7: 0];
          if (ibex_data_be[1]) rot_mem_q[data_word_idx][15: 8] <= ibex_data_wdata[15: 8];
          if (ibex_data_be[2]) rot_mem_q[data_word_idx][23:16] <= ibex_data_wdata[23:16];
          if (ibex_data_be[3]) rot_mem_q[data_word_idx][31:24] <= ibex_data_wdata[31:24];
        end
        mem_data_rdata <= rot_mem_q[data_word_idx];
      end else if (ibex_data_req && data_in_mmio) begin
        mem_data_rdata <= rot_reg_rdata;
      end
    end
  end

  // Ibex data-port response mux: crypto window from the crossbar host, else the
  // single-cycle SRAM/OTP/mailbox model.
`ifdef E1_ROT_INSTANTIATE_CRYPTO_XBAR
  assign ibex_data_gnt    = data_in_crypto ? crypto_host_gnt    : mem_data_gnt;
  assign ibex_data_rvalid = data_in_crypto ? crypto_host_rvalid : mem_data_rvalid;
  assign ibex_data_rdata  = data_in_crypto ? crypto_host_rdata  : mem_data_rdata;
  assign ibex_data_err    = data_in_crypto ? crypto_host_err    : mem_data_err;
`else
  assign ibex_data_gnt    = mem_data_gnt;
  assign ibex_data_rvalid = mem_data_rvalid;
  assign ibex_data_rdata  = mem_data_rdata;
  assign ibex_data_err    = mem_data_err;
  /* verilator lint_off UNUSED */
  wire _unused_nocrypto = ^{data_in_crypto};
  /* verilator lint_on UNUSED */
`endif

  ibex_top #(
    .RV32M               (ibex_pkg::RV32MSlow),
    .RV32E               (1'b0),
    .BranchTargetALU     (1'b0),
    .WritebackStage      (1'b0),
    .ICache              (1'b0),
    .ICacheECC           (1'b0),
    .BranchPredictor     (1'b0),
    .DbgTriggerEn        (1'b1),
    .DbgHwBreakNum       (4),
    .SecureIbex          (1'b0)
  ) u_ibex_rot (
    .clk_i                     (clk_i),
    .rst_ni                    (rot_rst_n_int),
    .test_en_i                 (1'b0),
    .ram_cfg_icache_tag_i      (prim_ram_1p_pkg::RAM_1P_CFG_DEFAULT),
    .ram_cfg_rsp_icache_tag_o  (),
    .ram_cfg_icache_data_i     (prim_ram_1p_pkg::RAM_1P_CFG_DEFAULT),
    .ram_cfg_rsp_icache_data_o (),
    .hart_id_i                 (32'h0),
    .boot_addr_i               (ROT_BOOT_ADDR),

    .instr_req_o               (ibex_instr_req),
    .instr_gnt_i               (ibex_instr_gnt),
    .instr_rvalid_i            (ibex_instr_rvalid),
    .instr_addr_o              (ibex_instr_addr),
    .instr_rdata_i             (ibex_instr_rdata),
    .instr_rdata_intg_i        (7'h0),
    .instr_err_i               (ibex_instr_err),

    .data_req_o                (ibex_data_req),
    .data_gnt_i                (ibex_data_gnt),
    .data_rvalid_i             (ibex_data_rvalid),
    .data_we_o                 (ibex_data_we),
    .data_be_o                 (ibex_data_be),
    .data_addr_o               (ibex_data_addr),
    .data_wdata_o              (ibex_data_wdata),
    .data_wdata_intg_o         (),
    .data_rdata_i              (ibex_data_rdata),
    .data_rdata_intg_i         (7'h0),
    .data_err_i                (ibex_data_err),

    .irq_software_i            (1'b0),
    .irq_timer_i               (1'b0),
    .irq_external_i            (1'b0),
    .irq_fast_i                (15'h0),
    .irq_nm_i                  (1'b0),

    .scramble_key_valid_i      (1'b0),
    .scramble_key_i            ('0),
    .scramble_nonce_i          ('0),
    .scramble_req_o            (),

    .debug_req_i               (1'b0),
    .crash_dump_o              (),
    .double_fault_seen_o       (),

    .fetch_enable_i            (ibex_pkg::IbexMuBiOn),
    .alert_minor_o             (),
    .alert_major_internal_o    (),
    .alert_major_bus_o         (),
    .core_sleep_o              (ibex_core_sleep),
    .scan_rst_ni               (rot_rst_n_int),

    .lockstep_cmp_en_o         (),
    .data_req_shadow_o         (),
    .data_we_shadow_o          (),
    .data_be_shadow_o          (),
    .data_addr_shadow_o        (),
    .data_wdata_shadow_o       (),
    .data_wdata_intg_shadow_o  (),
    .instr_req_shadow_o        (),
    .instr_addr_shadow_o       ()
  );

  /* verilator lint_off UNUSED */
  wire _unused_ibex = ^{ibex_core_sleep, rot_rst_no};
  /* verilator lint_on UNUSED */
`else
  // Ibex not instantiated (default lint of the wrapper alone). Drive the RoT
  // register crossbar idle so the OTP/mailbox/crossbar still elaborate and the
  // reset-release + mailbox cocotb tests run against the real RTL. The cocotb
  // build defines E1_ROT_INSTANTIATE_IBEX (like the PMC lane) to add the core.
  assign rot_reg_valid = 1'b0;
  assign rot_reg_write = 1'b0;
  assign rot_reg_addr  = 12'h0;
  assign rot_reg_wdata = 32'h0;
  // Crypto crossbar host idle when no RoT core drives it (xbar present but no
  // Ibex -- e.g. the integrated elaboration check exercises the datapath ports
  // without firmware).
`ifdef E1_ROT_INSTANTIATE_CRYPTO_XBAR
  assign crypto_host_req   = 1'b0;
  assign crypto_host_addr  = 32'h0;
  assign crypto_host_we    = 1'b0;
  assign crypto_host_wdata = 32'h0;
  assign crypto_host_be    = 4'h0;
`endif
  /* verilator lint_off UNUSED */
  wire _unused_norobot = ^{rot_reg_rdata, rot_rst_no, ROT_MEM_BYTES[0]};
  /* verilator lint_on UNUSED */
`endif

endmodule : e1_rot_top
