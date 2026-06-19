`include "rtl/e1x/e1x_pkg.sv"

module e1x_tiny_core_contract #(
  parameter int XLEN = 64,
  parameter int LOCAL_SRAM_KIB = e1x_pkg::E1X_LOCAL_SRAM_KIB
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic enable_i,
  input  logic [31:0] boot_pc_i,
  input  logic instr_valid_i,
  input  logic [31:0] instr_i,
  input  logic wavelet_valid_i,
  input  logic [e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] wavelet_payload_i,
  output logic wavelet_ready_o,
  output logic wavelet_valid_o,
  output logic [e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] wavelet_payload_o,
  output logic [31:0] pc_o,
  output logic [63:0] x1_o,
  output logic [63:0] x2_o,
  output logic [63:0] x3_o,
  output logic halted_o,
  output logic active_o
);
  localparam int SRAM_BYTES = LOCAL_SRAM_KIB * 1024;
  localparam int SRAM_WORDS = SRAM_BYTES / 4;

  logic [31:0] local_sram [SRAM_WORDS-1:0];
  logic [63:0] regs [31:0];
  logic [31:0] pc_q;
  logic [31:0] acc_q;
  logic halted_q;
  logic tx_valid_q;
  logic [e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] tx_payload_q;

  assign wavelet_ready_o = enable_i && !halted_q;
  assign wavelet_valid_o = tx_valid_q;
  assign wavelet_payload_o = tx_payload_q;
  assign pc_o = pc_q;
  assign x1_o = regs[1];
  assign x2_o = regs[2];
  assign x3_o = regs[3];
  assign halted_o = halted_q;
  assign active_o = enable_i && !halted_q;

  function automatic logic [63:0] sext12(input logic [11:0] imm);
    sext12 = {{52{imm[11]}}, imm};
  endfunction

  function automatic logic [63:0] sext32(input logic [31:0] value);
    sext32 = {{32{value[31]}}, value};
  endfunction

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      pc_q <= boot_pc_i;
      acc_q <= '0;
      halted_q <= 1'b0;
      tx_valid_q <= 1'b0;
      tx_payload_q <= '0;
      for (int idx = 0; idx < 32; idx++) begin
        regs[idx] <= '0;
      end
    end else if (enable_i && !halted_q) begin
      tx_valid_q <= 1'b0;
      if (instr_valid_i) begin
        pc_q <= pc_q + 32'd4;
        unique case (instr_i[6:0])
          7'b0010011: begin
            unique case (instr_i[14:12])
              3'b000: begin
                if (instr_i[11:7] != 5'd0) begin
                  regs[instr_i[11:7]] <= regs[instr_i[19:15]] + sext12(instr_i[31:20]);
                end
              end
              default: begin
              end
            endcase
          end
          7'b0110011: begin
            unique case ({instr_i[31:25], instr_i[14:12]})
              {7'b0000000, 3'b000}: begin
                if (instr_i[11:7] != 5'd0) begin
                  regs[instr_i[11:7]] <= regs[instr_i[19:15]] + regs[instr_i[24:20]];
                end
              end
              {7'b0100000, 3'b000}: begin
                if (instr_i[11:7] != 5'd0) begin
                  regs[instr_i[11:7]] <= regs[instr_i[19:15]] - regs[instr_i[24:20]];
                end
              end
              default: begin
              end
            endcase
          end
          7'b0110111: begin
            if (instr_i[11:7] != 5'd0) begin
              regs[instr_i[11:7]] <= sext32({instr_i[31:12], 12'b0});
            end
          end
          7'b1110011: begin
            if (instr_i == 32'h0000_0073) begin
              halted_q <= 1'b1;
            end
          end
          default: begin
          end
        endcase
      end
      if (wavelet_valid_i) begin
        acc_q <= acc_q + wavelet_payload_i;
        tx_valid_q <= 1'b1;
        tx_payload_q <= wavelet_payload_i ^ acc_q[e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0];
        local_sram[pc_q[$clog2(SRAM_WORDS)+1:2]] <= wavelet_payload_i;
        regs[10] <= regs[10] + {{32{1'b0}}, wavelet_payload_i};
      end
      regs[0] <= '0;
    end else begin
      tx_valid_q <= 1'b0;
    end
  end

  logic unused_xlen;
  assign unused_xlen = ^XLEN;
endmodule
