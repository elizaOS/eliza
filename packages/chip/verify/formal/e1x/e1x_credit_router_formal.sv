// SPDX-License-Identifier: Apache-2.0
//
// SymbiYosys formal harness for ``e1x_credit_router``. This checks the
// production credit-flow-controlled router's local safety contract on a reduced
// but parameter-generic instance: bounded FIFO occupancy, bounded credit
// counters, route-table programming/readback, no grant without output space and
// credit, and repair-disabled route/drop behavior. Drive with
// verify/formal/e1x/e1x_credit_router.sby.

`include "rtl/e1x/e1x_pkg.sv"

module e1x_credit_router_formal #(
  parameter int PORTS = 2,
  parameter int COLORS = 2,
  parameter int PAYLOAD_BITS = 8,
  parameter int FIFO_DEPTH = 2,
  parameter int CREDIT_MAX = 2
) (
  input logic clk_i
);
  import e1x_pkg::*;

  localparam int COLOR_BITS = $clog2(COLORS);
  localparam int PORT_BITS = $clog2(PORTS);
  localparam int PROG_ADDR_BITS = COLOR_BITS + PORT_BITS;
  localparam int DEPTH_BITS = $clog2(FIFO_DEPTH + 1);
  localparam int CREDIT_BITS = $clog2(CREDIT_MAX + 1);

  logic rst_ni = 1'b0;

  (* anyseq *) logic repair_enable_d;
  (* anyseq *) logic [PORTS-1:0] port_disable_d;
  (* anyseq *) logic prog_we_d;
  (* anyseq *) logic [PROG_ADDR_BITS-1:0] prog_addr_d;
  (* anyseq *) logic [2:0] prog_dir_d;
  (* anyseq *) logic [PORTS-1:0] in_valid_d;
  (* anyseq *) logic [PORTS-1:0][COLOR_BITS-1:0] in_color_d;
  (* anyseq *) logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload_d;
  (* anyseq *) logic [PORTS-1:0] out_ready_d;
  (* anyseq *) logic [PORTS-1:0] out_credit_d;

  logic repair_enable_i;
  logic [PORTS-1:0] port_disable_i;
  logic prog_we_i;
  logic [PROG_ADDR_BITS-1:0] prog_addr_i;
  logic [2:0] prog_dir_i;
  logic [PORTS-1:0] in_valid_i;
  logic [PORTS-1:0][COLOR_BITS-1:0] in_color_i;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload_i;
  logic [PORTS-1:0] out_ready_i;
  logic [PORTS-1:0] out_credit_i;

  always_ff @(posedge clk_i) begin
    repair_enable_i <= repair_enable_d;
    port_disable_i <= port_disable_d;
    prog_we_i <= prog_we_d;
    prog_addr_i <= prog_addr_d;
    prog_dir_i <= prog_dir_d;
    in_valid_i <= in_valid_d;
    in_color_i <= in_color_d;
    in_payload_i <= in_payload_d;
    out_ready_i <= out_ready_d;
    out_credit_i <= out_credit_d;
  end

  logic [2:0] prog_dir_o;
  logic [PORTS-1:0] in_ready_o;
  logic [PORTS-1:0] out_valid_o;
  logic [PORTS-1:0][COLOR_BITS-1:0] out_color_o;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] out_payload_o;
  logic [PORTS-1:0] repaired_drop_o;

  e1x_credit_router #(
    .PORTS(PORTS),
    .COLORS(COLORS),
    .PAYLOAD_BITS(PAYLOAD_BITS),
    .FIFO_DEPTH(FIFO_DEPTH),
    .CREDIT_MAX(CREDIT_MAX)
  ) dut (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .repair_enable_i(repair_enable_i),
    .port_disable_i(port_disable_i),
    .prog_we_i(prog_we_i),
    .prog_addr_i(prog_addr_i),
    .prog_dir_i(prog_dir_i),
    .prog_dir_o(prog_dir_o),
    .in_valid_i(in_valid_i),
    .in_color_i(in_color_i),
    .in_payload_i(in_payload_i),
    .in_ready_o(in_ready_o),
    .out_valid_o(out_valid_o),
    .out_color_o(out_color_o),
    .out_payload_o(out_payload_o),
    .out_ready_i(out_ready_i),
    .out_credit_i(out_credit_i),
    .repaired_drop_o(repaired_drop_o)
  );

  logic saw_reset;
  logic armed_q;
  logic prev_prog_we;
  logic [PROG_ADDR_BITS-1:0] prev_prog_addr;
  logic [2:0] prev_prog_dir;
  logic [PORTS-1:0] prev_head_drop;
  logic [PORTS-1:0] prev_fifo_empty;
  initial saw_reset = 1'b0;

  always_ff @(posedge clk_i) begin
    rst_ni <= 1'b1;
    if (rst_ni) begin
      saw_reset <= 1'b1;
    end
    armed_q <= rst_ni;
    prev_prog_we <= dut.prog_we_i;
    prev_prog_addr <= dut.prog_addr_i;
    prev_prog_dir <= dut.prog_dir_i;
    prev_head_drop <= dut.head_drop;
    prev_fifo_empty <= dut.fifo_empty;
  end

  always_comb begin
    for (int p = 0; p < PORTS; p++) begin
      assume (int'(in_color_i[p]) < COLORS);
    end
    assume (prog_dir_i < 3'(PORTS) || prog_dir_i == E1X_DIR_DROP);
  end

  always_comb begin
    if (saw_reset) begin
      for (int p = 0; p < PORTS; p++) begin
        assert (dut.fifo_cnt[p] <= DEPTH_BITS'(FIFO_DEPTH));
        assert (in_ready_o[p] == (dut.fifo_cnt[p] != DEPTH_BITS'(FIFO_DEPTH)));
      end

      for (int o = 0; o < PORTS; o++) begin
        assert (dut.credit_q[o] <= CREDIT_BITS'(CREDIT_MAX));
        if (dut.out_grant_valid[o]) begin
          assert (dut.credit_q[o] != '0);
          assert (dut.out_slot_free[o]);
          assert (dut.grant[o] != '0);
        end
        if (repair_enable_i && port_disable_i[o] && dut.out_grant_valid[o]) begin
          assert (0);
        end
        for (int i = 0; i < PORTS; i++) begin
          if (dut.grant[o][i]) begin
            assert (dut.head_route_ok[i]);
            assert (dut.head_out[i] == PORT_BITS'(o));
            assert (!dut.head_drop[i]);
          end
        end
      end
    end
  end

  always_ff @(posedge clk_i) begin
    if (saw_reset && armed_q && prev_prog_we && dut.prog_addr_i == prev_prog_addr) begin
      assert (prog_dir_o == prev_prog_dir);
    end
    if (saw_reset && armed_q) begin
      for (int p = 0; p < PORTS; p++) begin
        if (repaired_drop_o[p]) begin
          assert (prev_head_drop[p]);
          assert (!prev_fifo_empty[p]);
        end
      end
    end
  end
endmodule
