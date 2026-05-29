// E1X repair fuse/OTP reader.
//
// Bridges a persistent 64-bit fuse/OTP macro read port into the repair-ROM
// loader's valid/ready word stream. This module does not implement fuse
// burning or the foundry OTP macro; it provides the synthesizable controller
// contract around that macro: sequential word-address reads, loader
// backpressure, bounded image size, and fail-closed timeout/error handling.
module e1x_repair_fuse_reader #(
  parameter int ADDR_BITS = 12,
  parameter int MAX_WORDS = 4096,
  parameter int TIMEOUT_CYCLES = 1024
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,

  input  logic start_i,
  input  logic [ADDR_BITS:0] word_count_i,

  output logic otp_read_valid_o,
  output logic [ADDR_BITS-1:0] otp_read_addr_o,
  input  logic otp_read_ready_i,
  input  logic otp_read_data_valid_i,
  input  logic [63:0] otp_read_data_i,

  output logic repair_word_valid_o,
  output logic [63:0] repair_word_o,
  input  logic repair_word_ready_i,

  output logic busy_o,
  output logic done_o,
  output logic error_o,
  output logic [ADDR_BITS:0] words_streamed_o
);
  localparam int TIMEOUT_BITS = $clog2(TIMEOUT_CYCLES + 1);
  localparam logic [ADDR_BITS:0] ONE_WORD = {{ADDR_BITS{1'b0}}, 1'b1};

  typedef enum logic [1:0] {
    S_IDLE,
    S_ISSUE,
    S_WAIT_DATA,
    S_PRESENT
  } state_e;

  state_e state_q;
  logic [ADDR_BITS:0] target_words_q;
  logic [ADDR_BITS:0] next_read_index_q;
  logic [ADDR_BITS:0] words_streamed_q;
  logic [TIMEOUT_BITS-1:0] timeout_q;
  logic [63:0] repair_word_q;
  logic done_q;
  logic error_q;

  assign otp_read_valid_o = state_q == S_ISSUE;
  assign otp_read_addr_o = next_read_index_q[ADDR_BITS-1:0];
  assign repair_word_valid_o = state_q == S_PRESENT;
  assign repair_word_o = repair_word_q;
  assign busy_o = state_q != S_IDLE;
  assign done_o = done_q;
  assign error_o = error_q;
  assign words_streamed_o = words_streamed_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      state_q <= S_IDLE;
      target_words_q <= '0;
      next_read_index_q <= '0;
      words_streamed_q <= '0;
      timeout_q <= '0;
      repair_word_q <= '0;
      done_q <= 1'b0;
      error_q <= 1'b0;
    end else if (clear_i) begin
      state_q <= S_IDLE;
      target_words_q <= '0;
      next_read_index_q <= '0;
      words_streamed_q <= '0;
      timeout_q <= '0;
      repair_word_q <= '0;
      done_q <= 1'b0;
      error_q <= 1'b0;
    end else begin
      unique case (state_q)
        S_IDLE: begin
          timeout_q <= '0;
          if (start_i) begin
            done_q <= 1'b0;
            error_q <= 1'b0;
            target_words_q <= word_count_i;
            next_read_index_q <= '0;
            words_streamed_q <= '0;
            if (word_count_i == '0 || int'(word_count_i) > MAX_WORDS) begin
              error_q <= 1'b1;
            end else begin
              state_q <= S_ISSUE;
            end
          end
        end

        S_ISSUE: begin
          if (otp_read_ready_i) begin
            timeout_q <= '0;
            state_q <= S_WAIT_DATA;
          end else if (timeout_q == TIMEOUT_BITS'(TIMEOUT_CYCLES)) begin
            error_q <= 1'b1;
            state_q <= S_IDLE;
          end else begin
            timeout_q <= timeout_q + {{(TIMEOUT_BITS-1){1'b0}}, 1'b1};
          end
        end

        S_WAIT_DATA: begin
          if (otp_read_data_valid_i) begin
            repair_word_q <= otp_read_data_i;
            timeout_q <= '0;
            state_q <= S_PRESENT;
          end else if (timeout_q == TIMEOUT_BITS'(TIMEOUT_CYCLES)) begin
            error_q <= 1'b1;
            state_q <= S_IDLE;
          end else begin
            timeout_q <= timeout_q + {{(TIMEOUT_BITS-1){1'b0}}, 1'b1};
          end
        end

        S_PRESENT: begin
          if (repair_word_ready_i) begin
            words_streamed_q <= words_streamed_q + ONE_WORD;
            next_read_index_q <= next_read_index_q + ONE_WORD;
            if (words_streamed_q + ONE_WORD == target_words_q) begin
              done_q <= 1'b1;
              state_q <= S_IDLE;
            end else begin
              state_q <= S_ISSUE;
            end
          end
        end

        default: begin
          error_q <= 1'b1;
          state_q <= S_IDLE;
        end
      endcase
    end
  end
endmodule
