// Bounded E1X tensor reduction merge primitive.
//
// This block is intentionally small: one configured reduction group is active
// at a time, incoming 32-bit signed fabric payloads are summed into a 64-bit
// accumulator, and the completed group emits a saturated signed 32-bit result.
// It is the RTL-facing primitive for reduction/merge semantics, not the full
// vectorized tensor fabric executor.
module e1x_reduction_merge #(
  parameter int PAYLOAD_BITS = 32,
  parameter int GROUP_BITS   = 16,
  parameter int COUNT_BITS   = 16
) (
  input  logic clk_i,
  input  logic rst_ni,

  input  logic                  cfg_valid_i,
  output logic                  cfg_ready_o,
  input  logic [GROUP_BITS-1:0] cfg_group_i,
  input  logic [COUNT_BITS-1:0] cfg_expected_count_i,
  output logic                  cfg_error_o,

  input  logic                    in_valid_i,
  output logic                    in_ready_o,
  input  logic [GROUP_BITS-1:0]   in_group_i,
  input  logic [PAYLOAD_BITS-1:0] in_payload_i,

  output logic                    out_valid_o,
  input  logic                    out_ready_i,
  output logic [GROUP_BITS-1:0]   out_group_o,
  output logic [PAYLOAD_BITS-1:0] out_payload_o,
  output logic                    out_overflow_o,

  output logic                  active_o,
  output logic [COUNT_BITS-1:0] received_count_o,
  output logic [COUNT_BITS-1:0] mismatch_count_o
);
  localparam logic signed [63:0] INT32_MAX = 64'sd2147483647;
  localparam logic signed [63:0] INT32_MIN = -64'sd2147483648;

  logic                    active_q;
  logic [GROUP_BITS-1:0]   group_q;
  logic [COUNT_BITS-1:0]   expected_q;
  logic [COUNT_BITS-1:0]   received_q;
  logic [COUNT_BITS-1:0]   mismatch_q;
  logic signed [63:0]      acc_q;
  logic                    out_valid_q;
  logic [GROUP_BITS-1:0]   out_group_q;
  logic [PAYLOAD_BITS-1:0] out_payload_q;
  logic                    out_overflow_q;
  logic                    cfg_error_q;

  function automatic logic signed [63:0] sign_extend_payload(logic [PAYLOAD_BITS-1:0] value);
    sign_extend_payload = {{(64-PAYLOAD_BITS){value[PAYLOAD_BITS-1]}}, value};
  endfunction

  function automatic logic [PAYLOAD_BITS-1:0] saturate_i32(logic signed [63:0] value);
    if (value > INT32_MAX) begin
      saturate_i32 = 32'h7fff_ffff;
    end else if (value < INT32_MIN) begin
      saturate_i32 = 32'h8000_0000;
    end else begin
      saturate_i32 = value[PAYLOAD_BITS-1:0];
    end
  endfunction

  function automatic logic overflows_i32(logic signed [63:0] value);
    overflows_i32 = (value > INT32_MAX) || (value < INT32_MIN);
  endfunction

  assign cfg_ready_o      = !active_q && !out_valid_q;
  assign in_ready_o       = active_q && !out_valid_q;
  assign out_valid_o      = out_valid_q;
  assign out_group_o      = out_group_q;
  assign out_payload_o    = out_payload_q;
  assign out_overflow_o   = out_overflow_q;
  assign active_o         = active_q;
  assign received_count_o = received_q;
  assign mismatch_count_o = mismatch_q;
  assign cfg_error_o      = cfg_error_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      active_q       <= 1'b0;
      group_q        <= '0;
      expected_q     <= '0;
      received_q     <= '0;
      mismatch_q     <= '0;
      acc_q          <= '0;
      out_valid_q    <= 1'b0;
      out_group_q    <= '0;
      out_payload_q  <= '0;
      out_overflow_q <= 1'b0;
      cfg_error_q    <= 1'b0;
    end else begin
      if (out_valid_q && out_ready_i) begin
        out_valid_q    <= 1'b0;
        out_overflow_q <= 1'b0;
      end

      if (cfg_valid_i && cfg_ready_o) begin
        if (cfg_expected_count_i == '0) begin
          cfg_error_q <= 1'b1;
        end else begin
          active_q    <= 1'b1;
          group_q     <= cfg_group_i;
          expected_q  <= cfg_expected_count_i;
          received_q  <= '0;
          mismatch_q  <= '0;
          acc_q       <= '0;
          cfg_error_q <= 1'b0;
        end
      end

      if (in_valid_i && in_ready_o) begin
        if (in_group_i != group_q) begin
          mismatch_q <= mismatch_q + {{(COUNT_BITS-1){1'b0}}, 1'b1};
        end else begin
          logic signed [63:0] next_acc;
          logic [COUNT_BITS-1:0] next_received;

          next_acc = acc_q + sign_extend_payload(in_payload_i);
          next_received = received_q + {{(COUNT_BITS-1){1'b0}}, 1'b1};
          acc_q <= next_acc;
          received_q <= next_received;
          if (next_received == expected_q) begin
            active_q       <= 1'b0;
            out_valid_q    <= 1'b1;
            out_group_q    <= group_q;
            out_payload_q  <= saturate_i32(next_acc);
            out_overflow_q <= overflows_i32(next_acc);
          end
        end
      end
    end
  end
endmodule
