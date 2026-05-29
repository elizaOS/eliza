module e1x_repair_mmio_programmer #(
  parameter int ADDR_BITS = 8
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,
  input  logic mmio_write_valid_i,
  input  logic [ADDR_BITS-1:0] mmio_write_addr_i,
  input  logic [31:0] mmio_write_data_i,
  output logic mmio_write_ready_o,
  input  logic mmio_read_valid_i,
  input  logic [ADDR_BITS-1:0] mmio_read_addr_i,
  output logic mmio_read_valid_o,
  output logic [31:0] mmio_read_data_o,
  output logic repair_clear_o,
  output logic repair_word_valid_o,
  output logic [63:0] repair_word_o,
  input  logic repair_word_ready_i,
  output logic busy_o,
  output logic error_o,
  output logic [31:0] words_pushed_o
);
  localparam logic [ADDR_BITS-1:0] ADDR_CTRL = 'h00;
  localparam logic [ADDR_BITS-1:0] ADDR_STATUS = 'h04;
  localparam logic [ADDR_BITS-1:0] ADDR_DATA_LO = 'h08;
  localparam logic [ADDR_BITS-1:0] ADDR_DATA_HI = 'h0c;
  localparam logic [ADDR_BITS-1:0] ADDR_PUSH = 'h10;
  localparam logic [ADDR_BITS-1:0] ADDR_COUNT = 'h14;

  logic [31:0] data_lo_q;
  logic [31:0] data_hi_q;
  logic [63:0] pending_word_q;
  logic pending_q;
  logic error_q;
  logic [31:0] words_pushed_q;
  logic push_addr;

  assign push_addr = mmio_write_addr_i == ADDR_PUSH;
  assign mmio_write_ready_o = !push_addr || !pending_q || repair_word_ready_i;
  assign repair_word_valid_o = pending_q;
  assign repair_word_o = pending_word_q;
  assign busy_o = pending_q;
  assign error_o = error_q;
  assign words_pushed_o = words_pushed_q;
  assign mmio_read_valid_o = mmio_read_valid_i;

  always_comb begin
    unique case (mmio_read_addr_i)
      ADDR_STATUS: mmio_read_data_o = {28'b0, pending_q, error_q, repair_word_ready_i, pending_q};
      ADDR_DATA_LO: mmio_read_data_o = data_lo_q;
      ADDR_DATA_HI: mmio_read_data_o = data_hi_q;
      ADDR_COUNT: mmio_read_data_o = words_pushed_q;
      default: mmio_read_data_o = 32'hE1A0_0001;
    endcase
  end

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      data_lo_q <= '0;
      data_hi_q <= '0;
      pending_word_q <= '0;
      pending_q <= 1'b0;
      error_q <= 1'b0;
      words_pushed_q <= '0;
      repair_clear_o <= 1'b0;
    end else begin
      repair_clear_o <= 1'b0;

      if (clear_i) begin
        data_lo_q <= '0;
        data_hi_q <= '0;
        pending_word_q <= '0;
        pending_q <= 1'b0;
        error_q <= 1'b0;
        words_pushed_q <= '0;
        repair_clear_o <= 1'b1;
      end else begin
        if (pending_q && repair_word_ready_i) begin
          pending_q <= 1'b0;
        end

        if (mmio_write_valid_i && mmio_write_ready_o) begin
          unique case (mmio_write_addr_i)
            ADDR_CTRL: begin
              if (mmio_write_data_i[0]) begin
                data_lo_q <= '0;
                data_hi_q <= '0;
                pending_word_q <= '0;
                pending_q <= 1'b0;
                words_pushed_q <= '0;
                repair_clear_o <= 1'b1;
              end
              if (mmio_write_data_i[1]) begin
                error_q <= 1'b0;
              end
            end
            ADDR_DATA_LO: begin
              data_lo_q <= mmio_write_data_i;
            end
            ADDR_DATA_HI: begin
              data_hi_q <= mmio_write_data_i;
            end
            ADDR_PUSH: begin
              pending_word_q <= {data_hi_q, data_lo_q};
              pending_q <= 1'b1;
              words_pushed_q <= words_pushed_q + 32'd1;
            end
            default: begin
              error_q <= 1'b1;
            end
          endcase
        end
      end
    end
  end
endmodule
