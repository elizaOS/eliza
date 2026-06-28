`include "rtl/e1x/e1x_pkg.sv"

module e1x_reduction_merge_tb #(
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS,
  parameter int GROUP_BITS   = 16,
  parameter int COUNT_BITS   = 16
) (
  input  logic clk,
  input  logic rst_n,

  input  logic                  cfg_valid,
  output logic                  cfg_ready,
  input  logic [GROUP_BITS-1:0] cfg_group,
  input  logic [COUNT_BITS-1:0] cfg_expected_count,
  output logic                  cfg_error,

  input  logic                    in_valid,
  output logic                    in_ready,
  input  logic [GROUP_BITS-1:0]   in_group,
  input  logic [PAYLOAD_BITS-1:0] in_payload,

  output logic                    out_valid,
  input  logic                    out_ready,
  output logic [GROUP_BITS-1:0]   out_group,
  output logic [PAYLOAD_BITS-1:0] out_payload,
  output logic                    out_overflow,

  output logic                  active,
  output logic [COUNT_BITS-1:0] received_count,
  output logic [COUNT_BITS-1:0] mismatch_count
);
  e1x_reduction_merge #(
    .PAYLOAD_BITS(PAYLOAD_BITS),
    .GROUP_BITS(GROUP_BITS),
    .COUNT_BITS(COUNT_BITS)
  ) u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .cfg_valid_i(cfg_valid),
    .cfg_ready_o(cfg_ready),
    .cfg_group_i(cfg_group),
    .cfg_expected_count_i(cfg_expected_count),
    .cfg_error_o(cfg_error),
    .in_valid_i(in_valid),
    .in_ready_o(in_ready),
    .in_group_i(in_group),
    .in_payload_i(in_payload),
    .out_valid_o(out_valid),
    .out_ready_i(out_ready),
    .out_group_o(out_group),
    .out_payload_o(out_payload),
    .out_overflow_o(out_overflow),
    .active_o(active),
    .received_count_o(received_count),
    .mismatch_count_o(mismatch_count)
  );
endmodule
