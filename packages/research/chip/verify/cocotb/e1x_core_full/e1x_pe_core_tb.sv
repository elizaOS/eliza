`include "rtl/e1x/e1x_pkg.sv"

module e1x_pe_core_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic enable,
  input  logic boot_en,
  input  logic [31:0] boot_pc,
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
  output logic [63:0] x5,
  output logic [63:0] x6,
  output logic [63:0] x7,
  output logic [63:0] x10,
  output logic [63:0] x11,
  output logic [63:0] x12,
  output logic [63:0] x28,
  output logic [63:0] x29,
  output logic [63:0] x30,
  output logic [63:0] x31,
  output logic halted,
  output logic active
);
  e1x_pe_core u_core (
    .clk_i(clk),
    .rst_ni(rst_n),
    .enable_i(enable),
    .boot_en_i(boot_en),
    .boot_pc_i(boot_pc),
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

  assign x5  = u_core.regs[5];
  assign x6  = u_core.regs[6];
  assign x7  = u_core.regs[7];
  assign x10 = u_core.regs[10];
  assign x11 = u_core.regs[11];
  assign x12 = u_core.regs[12];
  assign x28 = u_core.regs[28];
  assign x29 = u_core.regs[29];
  assign x30 = u_core.regs[30];
  assign x31 = u_core.regs[31];
endmodule
