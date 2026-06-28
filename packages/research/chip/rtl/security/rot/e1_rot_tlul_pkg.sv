// e1_rot_tlul_pkg.sv
// Self-contained TileLink Uncached Lightweight (TL-UL) typedefs for the E1
// root-of-trust internal crossbar and the AP<->RoT mailbox.
//
// The struct layout (a_valid/a_opcode/a_size/a_source/a_address/a_mask/a_data
// host->device, d_valid/d_opcode/d_source/d_data/d_error device->host) follows
// the OpenTitan TL-UL signature (lowRISC, Apache-2.0, hw/ip/tlul/rtl/tlul_pkg.sv
// at the pin recorded in external/opentitan/pin-manifest.json). It is a
// deliberately trimmed, E1-owned copy so the RoT crossbar elaborates without
// dragging in the Earl Grey topgen-generated top_pkg / prim dependency chain.
// When a vendored OpenTitan block is wired in for real, an adapter converts
// between this package and tlul_pkg::tl_h2d_t / tl_d2h_t at that block's edge.
//
// Integrity (cmd_intg/data_intg/rsp_intg) is intentionally NOT modelled here:
// the RoT crossbar is on-die behind the reset sequencer and the mailbox is the
// only externally reachable port. Bus integrity hardening is owned by lane 04
// (docs/security/tee-plan/04-side-channel-physical-hardening.md).

`timescale 1ns/1ps

package e1_rot_tlul_pkg;

  // E1 RoT TL-UL address/data geometry. 32-bit RV32 RoT address space, 32-bit
  // data, 4 byte-enables, 8-bit source id (sufficient for the handful of
  // crossbar masters/devices in the RoT).
  parameter int unsigned TL_AW  = 32;
  parameter int unsigned TL_DW  = 32;
  parameter int unsigned TL_DBW = TL_DW / 8;   // byte-enable width
  parameter int unsigned TL_SZW = 2;           // log2 of max beat size (4B)
  parameter int unsigned TL_AIW = 8;           // a_source width

  typedef enum logic [2:0] {
    PutFullData    = 3'h0,
    PutPartialData = 3'h1,
    Get            = 3'h4
  } tl_a_op_e;

  typedef enum logic [2:0] {
    AccessAck     = 3'h0,
    AccessAckData = 3'h1
  } tl_d_op_e;

  // Host-to-device (request) channel.
  typedef struct packed {
    logic                  a_valid;
    tl_a_op_e              a_opcode;
    logic [2:0]            a_param;
    logic [TL_SZW-1:0]     a_size;
    logic [TL_AIW-1:0]     a_source;
    logic [TL_AW-1:0]      a_address;
    logic [TL_DBW-1:0]     a_mask;
    logic [TL_DW-1:0]      a_data;
    logic                  d_ready;
  } tl_h2d_t;

  // Device-to-host (response) channel.
  typedef struct packed {
    logic                  d_valid;
    tl_d_op_e              d_opcode;
    logic [2:0]            d_param;
    logic [TL_SZW-1:0]     d_size;
    logic [TL_AIW-1:0]     d_source;
    logic                  d_error;
    logic [TL_DW-1:0]      d_data;
    logic                  a_ready;
  } tl_d2h_t;

  // Tie-off defaults for downstream consumers of this package; not referenced
  // within the package itself.
  /* verilator lint_off UNUSEDPARAM */
  parameter tl_h2d_t TL_H2D_DEFAULT = '{
    a_valid:   1'b0,
    a_opcode:  Get,
    a_param:   '0,
    a_size:    '0,
    a_source:  '0,
    a_address: '0,
    a_mask:    '0,
    a_data:    '0,
    d_ready:   1'b1
  };

  parameter tl_d2h_t TL_D2H_DEFAULT = '{
    d_valid:  1'b0,
    d_opcode: AccessAck,
    d_param:  '0,
    d_size:   '0,
    d_source: '0,
    d_error:  1'b0,
    d_data:   '0,
    a_ready:  1'b1
  };
  /* verilator lint_on UNUSEDPARAM */

endpackage : e1_rot_tlul_pkg
