// e1_rot_xbar.sv
// E1 root-of-trust TL-UL control crossbar.
//
// Converts the RoT processor (Ibex) data-memory port -- a simple
// req/gnt/rvalid/we/be/addr/wdata/rdata bus -- into a TL-UL host using the
// vendored OpenTitan tlul_adapter_host, then fans that single host out to the
// nine OpenTitan crypto/security block TL-UL device ports with the vendored
// tlul_socket_1n. Address decode selects the device window.
//
// The RoT internal control bus is standardized on the vendored tlul_pkg
// (tl_h2d_t / tl_d2h_t with full command/response integrity), NOT the trimmed
// e1_rot_tlul_pkg: the adapter_host generates command integrity and the device
// reg adapters check it, so the integrity field is correct end-to-end with no
// translation layer. e1_rot_tlul_pkg remains the AP<->RoT mailbox bus only.
//
// Address map (byte offsets within MMIO_CRYPTO_BASE, 4 KiB device windows):
//   idx 0  0x0000  rom_ctrl       (regs TL port)
//   idx 1  0x1000  keymgr
//   idx 2  0x2000  kmac
//   idx 3  0x3000  hmac
//   idx 4  0x4000  aes
//   idx 5  0x5000  csrng
//   idx 6  0x6000  edn
//   idx 7  0x7000  entropy_src
//   idx 8  0x8000  alert_handler
// An address outside windows 0..8 selects the out-of-range code N (=9), which
// tlul_socket_1n answers with a TL-UL error response (fail-closed).
//
// Synthesizable; reuses OpenTitan TL-UL fabric primitives (no hand-rolled
// fabric). Lints clean under the gate's Verilator waivers.

`timescale 1ns/1ps

module e1_rot_xbar
  import tlul_pkg::*;
#(
    // Number of crypto/security device ports.
    parameter int unsigned N_DEVICE = 9,
    // log2(window size) for the per-device address window. 12 => 4 KiB.
    parameter int unsigned DEV_WIN_LSB = 12,
    // Index width of the device window field selected from the address.
    parameter int unsigned DEV_SEL_W = 4
) (
    input  logic clk_i,
    input  logic rst_ni,

    // RoT host (Ibex data port style) request/response.
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

    // Device TL-UL ports (one per crypto/security block).
    output tl_h2d_t                    dev_tl_o [N_DEVICE],
    input  tl_d2h_t                    dev_tl_i [N_DEVICE]
);

  // ------------------------------------------------------------------
  // Ibex-style host port -> TL-UL host (command integrity generated here).
  // MAX_REQS == 1: purely combinational, single outstanding request, which
  // matches the RoT firmware's blocking control-plane access pattern.
  // ------------------------------------------------------------------
  tl_h2d_t host_tl_h2d;
  tl_d2h_t host_tl_d2h;

  tlul_adapter_host #(
    .MAX_REQS (1)
  ) u_adapter_host (
    .clk_i,
    .rst_ni,
    .req_i      (host_req_i),
    .gnt_o      (host_gnt_o),
    .addr_i     (host_addr_i),
    .we_i       (host_we_i),
    .wdata_i    (host_wdata_i),
    .be_i       (host_be_i),
    .type_i     (DataType),
    .valid_o    (host_rvalid_o),
    .rdata_o    (host_rdata_o),
    .err_o      (host_err_o),
    .intg_err_o (host_intg_err_o),
    .tl_o       (host_tl_h2d),
    .tl_i       (host_tl_d2h)
  );

  // ------------------------------------------------------------------
  // Address decode -> device select. The window index is the address field
  // [DEV_WIN_LSB +: DEV_SEL_W]. An index >= N_DEVICE selects the out-of-range
  // code N, which tlul_socket_1n answers with a TL-UL error (fail-closed).
  // ------------------------------------------------------------------
  localparam int unsigned NWD = $clog2(N_DEVICE + 1);

  logic [DEV_SEL_W-1:0] win_idx;
  logic [NWD-1:0]       dev_select;

  assign win_idx = host_tl_h2d.a_address[DEV_WIN_LSB +: DEV_SEL_W];
  assign dev_select = (win_idx < DEV_SEL_W'(N_DEVICE)) ? NWD'(win_idx)
                                                       : NWD'(N_DEVICE);

  // ------------------------------------------------------------------
  // 1-host -> N-device fan-out, reusing the vendored TL-UL socket.
  // ------------------------------------------------------------------
  tlul_socket_1n #(
    .N (N_DEVICE)
  ) u_socket_1n (
    .clk_i,
    .rst_ni,
    .tl_h_i       (host_tl_h2d),
    .tl_h_o       (host_tl_d2h),
    .tl_d_o       (dev_tl_o),
    .tl_d_i       (dev_tl_i),
    .dev_select_i (dev_select)
  );

endmodule : e1_rot_xbar
