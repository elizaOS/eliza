`include "rtl/e1x/e1x_pkg.sv"

module e1x_mbist_tb (
  input  logic        clk,
  input  logic        rst_n,
  input  logic        start,
  input  logic        inject_valid,
  input  logic [5:0]  inject_addr,
  input  logic [4:0]  inject_bit,
  input  logic        inject_value,
  output logic        busy,
  output logic        done,
  output logic        fail,
  output logic [5:0]  fail_addr,
  output logic [4:0]  fail_bit,
  output logic [31:0] fail_expected,
  output logic [31:0] fail_actual
);
  // 64-deep, 32-bit SRAM under test, with fault injection enabled for verification.
  e1x_mbist #(
    .DATA_BITS(32),
    .DEPTH(64),
    .INJECT_ENABLE(1'b1)
  ) u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .start_i(start),
    .inject_valid_i(inject_valid),
    .inject_addr_i(inject_addr),
    .inject_bit_i(inject_bit),
    .inject_value_i(inject_value),
    .busy_o(busy),
    .done_o(done),
    .fail_o(fail),
    .fail_addr_o(fail_addr),
    .fail_bit_o(fail_bit),
    .fail_expected_o(fail_expected),
    .fail_actual_o(fail_actual)
  );
endmodule
