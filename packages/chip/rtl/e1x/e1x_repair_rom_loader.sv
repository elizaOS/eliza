`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_rom_loader #(
  parameter int INDEX_BITS = 32,
  parameter int HOP_BITS = 16
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,
  input  logic word_valid_i,
  input  logic [63:0] word_i,
  output logic word_ready_o,
  output logic header_valid_o,
  output logic remap_valid_o,
  output logic [INDEX_BITS-1:0] remap_logical_o,
  output logic [INDEX_BITS-1:0] remap_physical_o,
  output logic route_valid_o,
  output logic [INDEX_BITS-1:0] route_logical_from_o,
  output logic [INDEX_BITS-1:0] route_logical_to_o,
  output logic [2:0] route_dir_o,
  output logic [HOP_BITS-1:0] route_hops_o,
  output logic done_o,
  output logic error_o,
  output logic [31:0] remap_count_o,
  output logic [31:0] route_count_o,
  output logic [31:0] words_seen_o
);
  localparam logic [63:0] E1X_REPAIR_MAGIC = 64'h4531_5852_4550_4149;
  localparam int HEADER_WORDS = 8;

  logic [31:0] word_index_q;
  logic [31:0] remap_count_q;
  logic [31:0] route_count_q;
  logic [31:0] remaps_seen_q;
  logic [31:0] routes_seen_q;
  logic done_q;
  logic error_q;

  assign word_ready_o = !done_q && !error_q;
  assign done_o = done_q;
  assign error_o = error_q;
  assign remap_count_o = remap_count_q;
  assign route_count_o = route_count_q;
  assign words_seen_o = word_index_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      word_index_q <= '0;
      remap_count_q <= '0;
      route_count_q <= '0;
      remaps_seen_q <= '0;
      routes_seen_q <= '0;
      done_q <= 1'b0;
      error_q <= 1'b0;
      header_valid_o <= 1'b0;
      remap_valid_o <= 1'b0;
      remap_logical_o <= '0;
      remap_physical_o <= '0;
      route_valid_o <= 1'b0;
      route_logical_from_o <= '0;
      route_logical_to_o <= '0;
      route_dir_o <= '0;
      route_hops_o <= '0;
    end else if (clear_i) begin
      word_index_q <= '0;
      remap_count_q <= '0;
      route_count_q <= '0;
      remaps_seen_q <= '0;
      routes_seen_q <= '0;
      done_q <= 1'b0;
      error_q <= 1'b0;
      header_valid_o <= 1'b0;
      remap_valid_o <= 1'b0;
      route_valid_o <= 1'b0;
    end else begin
      header_valid_o <= 1'b0;
      remap_valid_o <= 1'b0;
      route_valid_o <= 1'b0;

      if (word_valid_i && word_ready_o) begin
        unique case (word_index_q)
          32'd0: begin
            if (word_i != E1X_REPAIR_MAGIC) begin
              error_q <= 1'b1;
            end
          end
          32'd1: begin
          end
          32'd2: begin
          end
          32'd3: begin
          end
          32'd4: begin
            remap_count_q <= word_i[31:0];
          end
          32'd5: begin
            route_count_q <= word_i[31:0];
          end
          32'd6: begin
          end
          32'd7: begin
            header_valid_o <= 1'b1;
          end
          default: begin
            if (word_index_q < HEADER_WORDS + remap_count_q) begin
              remap_valid_o <= 1'b1;
              remap_logical_o <= word_i[63:32];
              remap_physical_o <= word_i[31:0];
              remaps_seen_q <= remaps_seen_q + 32'd1;
            end else if (word_index_q < HEADER_WORDS + remap_count_q + route_count_q) begin
              route_valid_o <= 1'b1;
              route_logical_from_o <= {{(INDEX_BITS-24){1'b0}}, word_i[63:40]};
              route_logical_to_o <= {{(INDEX_BITS-21){1'b0}}, word_i[39:19]};
              route_dir_o <= word_i[18:16];
              route_hops_o <= word_i[HOP_BITS-1:0];
              routes_seen_q <= routes_seen_q + 32'd1;
            end else begin
              error_q <= 1'b1;
            end
          end
        endcase

        word_index_q <= word_index_q + 32'd1;
        if (
          word_index_q + 32'd1 == HEADER_WORDS + remap_count_q + route_count_q &&
          word_index_q >= HEADER_WORDS - 1
        ) begin
          done_q <= 1'b1;
        end
      end
    end
  end

  logic unused_seen;
  assign unused_seen = ^remaps_seen_q ^ ^routes_seen_q;
endmodule
