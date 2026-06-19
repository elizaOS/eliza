`timescale 1ns/1ps

module e1_reset_sync (
    input  logic clk,
    input  logic rst_n_async,
    output logic rst_n_sync
);

    logic [1:0] sync_q;

    /* verilator lint_off SYNCASYNCNET */
    always_ff @(posedge clk or negedge rst_n_async) begin
        if (!rst_n_async) begin
            sync_q <= 2'b00;
        end else begin
            sync_q <= {sync_q[0], 1'b1};
        end
    end
    /* verilator lint_on SYNCASYNCNET */

    assign rst_n_sync = sync_q[1];

endmodule
