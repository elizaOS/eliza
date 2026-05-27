`include "rtl/e1x/e1x_pkg.sv"

module e1x_tiny_core_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic enable,
  input  logic instr_valid,
  input  logic [31:0] instr,
  input  logic wavelet_valid,
  input  logic [31:0] wavelet_payload,
  output logic wavelet_ready,
  output logic wavelet_out_valid,
  output logic [31:0] wavelet_out_payload,
  output logic [31:0] pc,
  output logic [63:0] x1,
  output logic [63:0] x2,
  output logic [63:0] x3,
  output logic [63:0] x10,
  output logic halted,
  output logic active
);
  e1x_tiny_core_contract u_core (
    .clk_i(clk),
    .rst_ni(rst_n),
    .enable_i(enable),
    .boot_pc_i(32'h1000_0000),
    .instr_valid_i(instr_valid),
    .instr_i(instr),
    .wavelet_valid_i(wavelet_valid),
    .wavelet_payload_i(wavelet_payload),
    .wavelet_ready_o(wavelet_ready),
    .wavelet_valid_o(wavelet_out_valid),
    .wavelet_payload_o(wavelet_out_payload),
    .pc_o(pc),
    .x1_o(x1),
    .x2_o(x2),
    .x3_o(x3),
    .halted_o(halted),
    .active_o(active)
  );

  assign x10 = u_core.regs[10];
endmodule
