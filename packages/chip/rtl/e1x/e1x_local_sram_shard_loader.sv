`include "rtl/e1x/e1x_pkg.sv"

module e1x_local_sram_shard_loader #(
  parameter int LOCAL_SRAM_KIB = e1x_pkg::E1X_LOCAL_SRAM_KIB,
  parameter int WORD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,
  input  logic load_valid_i,
  input  logic [31:0] load_word_addr_i,
  input  logic [WORD_BITS-1:0] load_word_i,
  output logic load_ready_o,
  output logic overflow_o,
  output logic [31:0] capacity_bytes_o,
  output logic [31:0] loaded_words_o,
  output logic [31:0] loaded_bytes_o,
  output logic [31:0] checksum_o,
  input  logic read_valid_i,
  input  logic [31:0] read_word_addr_i,
  output logic read_valid_o,
  output logic read_error_o,
  output logic [WORD_BITS-1:0] read_word_o
);
  localparam int SRAM_BYTES = LOCAL_SRAM_KIB * 1024;
  localparam int SRAM_WORDS = SRAM_BYTES / (WORD_BITS / 8);
  localparam int WORD_BYTES = WORD_BITS / 8;
  localparam logic [31:0] SRAM_BYTES_U32 = SRAM_BYTES;

  logic [WORD_BITS-1:0] local_sram [SRAM_WORDS-1:0];
  logic overflow_q;
  logic [31:0] loaded_words_q;
  logic [31:0] checksum_q;

  assign load_ready_o = 1'b1;
  assign overflow_o = overflow_q;
  assign capacity_bytes_o = SRAM_BYTES_U32;
  assign loaded_words_o = loaded_words_q;
  assign loaded_bytes_o = loaded_words_q * WORD_BYTES;
  assign checksum_o = checksum_q;
  assign read_valid_o = read_valid_i;
  assign read_error_o = read_valid_i && read_word_addr_i >= SRAM_WORDS;

  always_comb begin
    read_word_o = '0;
    if (read_valid_i && read_word_addr_i < SRAM_WORDS) begin
      read_word_o = local_sram[read_word_addr_i];
    end
  end

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      overflow_q <= 1'b0;
      loaded_words_q <= '0;
      checksum_q <= '0;
    end else if (clear_i) begin
      overflow_q <= 1'b0;
      loaded_words_q <= '0;
      checksum_q <= '0;
    end else if (load_valid_i) begin
      if (load_word_addr_i < SRAM_WORDS) begin
        local_sram[load_word_addr_i] <= load_word_i;
        loaded_words_q <= loaded_words_q + 32'd1;
        checksum_q <= {checksum_q[30:0], checksum_q[31]} ^ load_word_i ^ load_word_addr_i;
      end else begin
        overflow_q <= 1'b1;
      end
    end
  end
endmodule
