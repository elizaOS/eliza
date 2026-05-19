`timescale 1ns/1ps

module e1_bootrom (
    input  logic [5:0]  addr,
    output logic [31:0] rdata
);
    always_comb begin
        unique case (addr)
            6'h00: rdata = 32'h4F50_534F;
            6'h01: rdata = 32'h4348_4950;
            6'h02: rdata = 32'h0000_0001;
            6'h03: rdata = 32'h0000_1000;
            default: rdata = 32'h0000_0000;
        endcase
    end
endmodule
