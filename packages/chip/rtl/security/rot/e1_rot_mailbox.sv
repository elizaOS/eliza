// e1_rot_mailbox.sv
// AP <-> RoT TL-UL mailbox (NOT shared memory).
//
// Per docs/security/tee-plan/02-root-of-trust.md S1: "Mailbox, not shared
// memory, is the AP<->RoT interface. A TL-UL mailbox carries attestation
// requests, key-release requests (KeyMint), and RMA commands. No AP-visible
// path to RoT internal SRAM, OTP secrets, or the key manager."
//
// Structure: two independent, copy-on-doorbell register banks.
//   * Request bank  (AP writes, RoT reads): command word + N data words. The AP
//     rings the request doorbell; the RoT sees REQ_PENDING and reads the
//     captured request. The AP cannot read the RoT's SRAM/OTP/keymgr -- it can
//     only read back what it wrote plus the status word.
//   * Response bank (RoT writes, AP reads): status word + N data words. The RoT
//     rings the response doorbell; the AP sees RESP_READY and reads the result.
//     The AP cannot write the response bank.
//
// The isolation property is structural: the AP-facing TL-UL port (tl_ap_*) only
// decodes the mailbox register file. There is no address in the AP aperture
// that maps to the RoT crossbar, the RoT SRAM, OTP, or keymgr. The RoT-facing
// port (rot_*) is a simple register port driven by the RoT Ibex through the RoT
// crossbar; it is the only way request payloads leave / responses enter.
//
// Command codes (mailbox-level, opaque to the transport):
//   CMD_ATTEST   0x1   request a fresh attestation quote
//   CMD_KEY_REL  0x2   KeyMint key-release request (gated by RoT policy)
//   CMD_RMA      0x3   RMA command (gated by signed authorization in the RoT)
//
// Synthesizable: single clock, single synchronous-release async-assert reset.

`timescale 1ns/1ps

module e1_rot_mailbox
  import e1_rot_tlul_pkg::*;
#(
    parameter int unsigned NUM_DATA_WORDS = 8
) (
    input  logic clk_i,
    input  logic rst_ni,

    // ----------------------------------------------------------------
    // AP-facing TL-UL device port. The CVA6 AP domain is the host.
    // ----------------------------------------------------------------
    input  tl_h2d_t tl_ap_i,
    output tl_d2h_t tl_ap_o,

    // ----------------------------------------------------------------
    // RoT-facing register port (driven by the RoT Ibex via the RoT crossbar).
    // Word-indexed register access, same valid/write/addr/wdata/rdata shape as
    // the rest of the E1 security register files.
    // ----------------------------------------------------------------
    input  logic        rot_valid_i,
    input  logic        rot_write_i,
    input  logic [5:0]  rot_addr_i,    // word index into the mailbox reg file
    input  logic [31:0] rot_wdata_i,
    output logic [31:0] rot_rdata_o,

    // Sideband strobes for the RoT firmware / cocotb observability.
    output logic        req_pending_o,  // AP rang the request doorbell
    output logic        resp_ready_o,   // RoT rang the response doorbell
    output logic [31:0] req_cmd_o       // captured request command word
);

  // ----------------------------------------------------------------
  // Register map (word indices). Request bank is AP-writable; response bank is
  // RoT-writable. Doorbells are one-shot.
  // ----------------------------------------------------------------
  localparam logic [5:0] REG_REQ_CMD      = 6'h00;  // AP W / RoT R
  localparam logic [5:0] REG_REQ_DOORBELL = 6'h01;  // AP W1 -> sets REQ_PENDING
  localparam logic [5:0] REG_STATUS       = 6'h02;  // RO both sides
  localparam logic [5:0] REG_RESP_STATUS  = 6'h03;  // RoT W / AP R
  localparam logic [5:0] REG_RESP_DOORBELL= 6'h04;  // RoT W1 -> sets RESP_READY
  localparam logic [5:0] REG_REQ_DATA0    = 6'h08;  // .. +NUM_DATA_WORDS  AP W
  localparam logic [5:0] REG_RESP_DATA0   = 6'h18;  // .. +NUM_DATA_WORDS  RoT W

  // STATUS bit positions: bit0=REQ_PENDING, bit1=RESP_READY (see {..} packing
  // of resp_ready_q/req_pending_q in the read mux below).

  // Sized data-word index (log2 of NUM_DATA_WORDS) for the per-bank arrays.
  localparam int unsigned DW_IDX_W = (NUM_DATA_WORDS <= 1) ? 1 : $clog2(NUM_DATA_WORDS);

  logic [31:0] req_cmd_q;
  logic [31:0] req_data_q  [NUM_DATA_WORDS];
  logic [31:0] resp_status_q;
  logic [31:0] resp_data_q [NUM_DATA_WORDS];
  logic        req_pending_q;
  logic        resp_ready_q;

  // Sized per-bank word indices. The address has already been range-checked
  // against the bank base before these are used.
  logic [DW_IDX_W-1:0] ap_req_idx;
  logic [DW_IDX_W-1:0] ap_resp_idx;
  logic [DW_IDX_W-1:0] rot_req_idx;
  logic [DW_IDX_W-1:0] rot_resp_idx;
  assign ap_req_idx   = DW_IDX_W'(ap_word    - REG_REQ_DATA0 );
  assign ap_resp_idx  = DW_IDX_W'(ap_word    - REG_RESP_DATA0);
  assign rot_req_idx  = DW_IDX_W'(rot_addr_i - REG_REQ_DATA0 );
  assign rot_resp_idx = DW_IDX_W'(rot_addr_i - REG_RESP_DATA0);

  // ----------------------------------------------------------------
  // AP-facing TL-UL request decode. Single-beat, single-cycle accept; the
  // mailbox always accepts (a_ready=1) and responds the next cycle (d_valid).
  // ----------------------------------------------------------------
  logic            ap_req;
  logic            ap_we;
  logic [5:0]      ap_word;
  logic [31:0]     ap_wdata;
  logic [TL_AIW-1:0] ap_source;

  assign ap_req    = tl_ap_i.a_valid;
  assign ap_we     = (tl_ap_i.a_opcode == PutFullData) ||
                     (tl_ap_i.a_opcode == PutPartialData);
  assign ap_word   = tl_ap_i.a_address[7:2];
  assign ap_wdata  = tl_ap_i.a_data;
  assign ap_source = tl_ap_i.a_source;

  // AP write authorization: the AP may write ONLY the request bank + request
  // doorbell. Writes to the response bank / status are dropped (fail-closed,
  // the RoT owns those). Reads of the request bank return what the AP wrote;
  // reads of the response bank return the RoT-produced result.
  logic ap_write_req_data;
  logic ap_write_req_cmd;
  logic ap_write_req_db;
  assign ap_write_req_cmd  = ap_req && ap_we && (ap_word == REG_REQ_CMD);
  assign ap_write_req_db   = ap_req && ap_we && (ap_word == REG_REQ_DOORBELL);
  assign ap_write_req_data = ap_req && ap_we &&
                             (ap_word >= REG_REQ_DATA0) &&
                             (ap_word <  (REG_REQ_DATA0 + NUM_DATA_WORDS[5:0]));

  // AP read data mux. The response bank is readable; the RoT SRAM/OTP/keymgr
  // are NOT in this address space at all.
  logic [31:0] ap_rdata;
  always_comb begin
    ap_rdata = 32'h0;
    if (ap_word == REG_REQ_CMD) begin
      ap_rdata = req_cmd_q;
    end else if (ap_word == REG_STATUS) begin
      ap_rdata = {30'h0, resp_ready_q, req_pending_q};
    end else if (ap_word == REG_RESP_STATUS) begin
      ap_rdata = resp_status_q;
    end else if ((ap_word >= REG_RESP_DATA0) &&
                 (ap_word < (REG_RESP_DATA0 + NUM_DATA_WORDS[5:0]))) begin
      ap_rdata = resp_data_q[ap_resp_idx];
    end else if ((ap_word >= REG_REQ_DATA0) &&
                 (ap_word < (REG_REQ_DATA0 + NUM_DATA_WORDS[5:0]))) begin
      ap_rdata = req_data_q[ap_req_idx];
    end
  end

  // TL-UL response: one-cycle-latency AccessAck / AccessAckData.
  logic            d_valid_q;
  tl_d_op_e        d_opcode_q;
  logic [31:0]     d_data_q;
  logic [TL_AIW-1:0] d_source_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      d_valid_q  <= 1'b0;
      d_opcode_q <= AccessAck;
      d_data_q   <= 32'h0;
      d_source_q <= '0;
    end else begin
      d_valid_q  <= ap_req;
      d_opcode_q <= ap_we ? AccessAck : AccessAckData;
      d_data_q   <= ap_rdata;
      d_source_q <= ap_source;
    end
  end

  assign tl_ap_o = '{
    d_valid:  d_valid_q,
    d_opcode: d_opcode_q,
    d_param:  '0,
    d_size:   2'd2,
    d_source: d_source_q,
    d_error:  1'b0,
    d_data:   d_data_q,
    a_ready:  1'b1
  };

  // ----------------------------------------------------------------
  // RoT-facing register port. The RoT may read the request bank and write the
  // response bank + response doorbell. Reading the request doorbell clears
  // REQ_PENDING (the RoT has consumed the request).
  // ----------------------------------------------------------------
  logic rot_write_resp_status;
  logic rot_write_resp_db;
  logic rot_write_resp_data;
  logic rot_read_req_db;
  assign rot_write_resp_status = rot_valid_i && rot_write_i && (rot_addr_i == REG_RESP_STATUS);
  assign rot_write_resp_db     = rot_valid_i && rot_write_i && (rot_addr_i == REG_RESP_DOORBELL);
  assign rot_write_resp_data   = rot_valid_i && rot_write_i &&
                                 (rot_addr_i >= REG_RESP_DATA0) &&
                                 (rot_addr_i <  (REG_RESP_DATA0 + NUM_DATA_WORDS[5:0]));
  assign rot_read_req_db        = rot_valid_i && !rot_write_i && (rot_addr_i == REG_REQ_DOORBELL);

  always_comb begin
    rot_rdata_o = 32'h0;
    if (rot_addr_i == REG_REQ_CMD) begin
      rot_rdata_o = req_cmd_q;
    end else if (rot_addr_i == REG_STATUS) begin
      rot_rdata_o = {30'h0, resp_ready_q, req_pending_q};
    end else if ((rot_addr_i >= REG_REQ_DATA0) &&
                 (rot_addr_i < (REG_REQ_DATA0 + NUM_DATA_WORDS[5:0]))) begin
      rot_rdata_o = req_data_q[rot_req_idx];
    end else if ((rot_addr_i >= REG_RESP_DATA0) &&
                 (rot_addr_i < (REG_RESP_DATA0 + NUM_DATA_WORDS[5:0]))) begin
      rot_rdata_o = resp_data_q[rot_resp_idx];
    end
  end

  // ----------------------------------------------------------------
  // State update.
  // ----------------------------------------------------------------
  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      req_cmd_q     <= 32'h0;
      resp_status_q <= 32'h0;
      req_pending_q <= 1'b0;
      resp_ready_q  <= 1'b0;
      for (int unsigned i = 0; i < NUM_DATA_WORDS; i++) begin
        req_data_q[i]  <= 32'h0;
        resp_data_q[i] <= 32'h0;
      end
    end else begin
      // --- AP -> request bank ---
      if (ap_write_req_cmd) begin
        req_cmd_q <= ap_wdata;
      end
      if (ap_write_req_data) begin
        req_data_q[ap_req_idx] <= ap_wdata;
      end
      if (ap_write_req_db) begin
        req_pending_q <= 1'b1;     // doorbell: request now visible to the RoT
      end

      // --- RoT consumes request ---
      if (rot_read_req_db) begin
        req_pending_q <= 1'b0;     // RoT acknowledged / consumed
      end

      // --- RoT -> response bank ---
      if (rot_write_resp_status) begin
        resp_status_q <= rot_wdata_i;
      end
      if (rot_write_resp_data) begin
        resp_data_q[rot_resp_idx] <= rot_wdata_i;
      end
      if (rot_write_resp_db) begin
        resp_ready_q <= 1'b1;      // doorbell: response now visible to the AP
      end

      // --- AP consumes response: reading RESP_DOORBELL clears RESP_READY ---
      if (ap_req && !ap_we && (ap_word == REG_RESP_DOORBELL)) begin
        resp_ready_q <= 1'b0;
      end
    end
  end

  assign req_pending_o = req_pending_q;
  assign resp_ready_o  = resp_ready_q;
  assign req_cmd_o     = req_cmd_q;

  // The mailbox is a single-beat 32-bit register file: a_param / a_size and the
  // host's d_ready backpressure are intentionally not consumed (the mailbox
  // always accepts and always responds the next cycle). Tap them so the unused
  // bits are explicit rather than silently dropped.
  /* verilator lint_off UNUSED */
  wire _unused_tl = ^{tl_ap_i.a_param, tl_ap_i.a_size, tl_ap_i.a_mask,
                      tl_ap_i.d_ready};
  /* verilator lint_on UNUSED */

endmodule : e1_rot_mailbox
