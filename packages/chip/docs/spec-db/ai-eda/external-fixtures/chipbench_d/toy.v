module e1_toy_top(input wire clk, input wire rst_n, output wire done);
  assign done = rst_n & clk;
endmodule
