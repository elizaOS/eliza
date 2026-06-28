`timescale 1ns/1ps

module e1_display (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        valid,
    input  logic        write,
    input  logic [5:0]  addr,
    input  logic [31:0] wdata,
    output logic [31:0] rdata,
    output logic        irq_vsync,
    output logic        scan_hsync,
    output logic        scan_vsync,
    output logic        scan_active,
    output logic [15:0] scan_x,
    output logic [15:0] scan_y,
    output logic [31:0] scan_fb_addr,
    output logic [23:0] scan_rgb,
    output logic        fb_read_valid,
    output logic [31:0] fb_read_addr,
    input  logic [31:0] fb_read_data,
    input  logic        fb_read_ready
);
    localparam logic [31:0] FORMAT_XR24 = 32'h3432_5258;

    localparam logic [16:0] H_FRONT_PORCH = 17'd16;
    localparam logic [16:0] H_SYNC_PULSE  = 17'd96;
    localparam logic [16:0] H_BACK_PORCH  = 17'd48;
    localparam logic [16:0] V_FRONT_PORCH = 17'd10;
    localparam logic [16:0] V_SYNC_PULSE  = 17'd2;
    localparam logic [16:0] V_BACK_PORCH  = 17'd33;

    logic [31:0] fb_base;
    logic [15:0] width;
    logic [15:0] height;
    logic [31:0] format;
    logic        enable;
    logic [31:0] underflow_count;
    logic [31:0] fetched_pixel_count;
    logic [63:0] frame_byte_count;
    logic [31:0] line_stride_bytes;

    logic [16:0] h_count;
    logic [16:0] v_count;
    logic [16:0] h_active_end;
    logic [16:0] h_sync_start;
    logic [16:0] h_sync_end;
    logic [16:0] h_total;
    logic [16:0] v_active_end;
    logic [16:0] v_sync_start;
    logic [16:0] v_sync_end;
    logic [16:0] v_total;
    logic [31:0] active_pixel_index;
    /* verilator lint_off UNUSEDSIGNAL */
    logic        unused_fb_alpha;
    /* verilator lint_on UNUSEDSIGNAL */

    assign h_active_end = {1'b0, width};
    assign h_sync_start = h_active_end + H_FRONT_PORCH;
    assign h_sync_end   = h_sync_start + H_SYNC_PULSE;
    assign h_total      = h_sync_end + H_BACK_PORCH;
    assign v_active_end = {1'b0, height};
    assign v_sync_start = v_active_end + V_FRONT_PORCH;
    assign v_sync_end   = v_sync_start + V_SYNC_PULSE;
    assign v_total      = v_sync_end + V_BACK_PORCH;

    assign scan_hsync  = enable && (h_count >= h_sync_start) && (h_count < h_sync_end);
    assign scan_vsync  = enable && (v_count >= v_sync_start) && (v_count < v_sync_end);
    assign scan_active = enable && (h_count < h_active_end) && (v_count < v_active_end);
    assign scan_x      = h_count[15:0];
    assign scan_y      = v_count[15:0];
    assign irq_vsync   = enable && (h_count == 17'd0) && (v_count == v_sync_start);

    assign active_pixel_index = ({16'h0, scan_y} * {16'h0, width}) + {16'h0, scan_x};
    assign scan_fb_addr = scan_active ? fb_base + (active_pixel_index << 2) : 32'h0;
    assign fb_read_valid = scan_active;
    assign fb_read_addr = scan_fb_addr;
    assign frame_byte_count = {32'h0, width} * {32'h0, height} * 64'd4;
    assign line_stride_bytes = {14'h0, width, 2'b00};
    assign unused_fb_alpha = ^fb_read_data[31:24];
    assign scan_rgb = (scan_active && fb_read_ready) ? fb_read_data[23:0] : 24'h0;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            fb_base <= 32'h0;
            width <= 16'd640;
            height <= 16'd480;
            format <= FORMAT_XR24;
            enable <= 1'b0;
            underflow_count <= 32'h0;
            fetched_pixel_count <= 32'h0;
            h_count <= 17'h0;
            v_count <= 17'h0;
        end else begin
            if (valid && write) begin
                unique case (addr)
                    6'h00: fb_base <= wdata;
                    6'h01: begin
                        width <= (wdata[15:0] == 16'h0) ? 16'd1 : wdata[15:0];
                        height <= (wdata[31:16] == 16'h0) ? 16'd1 : wdata[31:16];
                    end
                    6'h02: begin
                        if (wdata == FORMAT_XR24) begin
                            format <= wdata;
                        end
                    end
                    6'h03: enable <= wdata[0];
                    6'h05: underflow_count <= 32'h0;
                    6'h06: fetched_pixel_count <= 32'h0;
                    default: begin end
                endcase
            end

            if (scan_active) begin
                if (fb_read_ready) begin
                    fetched_pixel_count <= fetched_pixel_count + 32'd1;
                end else begin
                    underflow_count <= underflow_count + 32'd1;
                end
            end

            if (!enable) begin
                h_count <= 17'h0;
                v_count <= 17'h0;
            end else if (h_count >= h_total - 17'd1) begin
                h_count <= 17'h0;
                if (v_count >= v_total - 17'd1) begin
                    v_count <= 17'h0;
                end else begin
                    v_count <= v_count + 17'd1;
                end
            end else begin
                h_count <= h_count + 17'd1;
            end
        end
    end

    always_comb begin
        unique case (addr)
            6'h00: rdata = fb_base;
            6'h01: rdata = {height, width};
            6'h02: rdata = format;
            6'h03: rdata = {31'h0, enable};
            6'h04: rdata = {31'h0, irq_vsync};
            6'h05: rdata = underflow_count;
            6'h06: rdata = fetched_pixel_count;
            6'h07: rdata = line_stride_bytes;
            6'h08: rdata = frame_byte_count[31:0];
            6'h09: rdata = frame_byte_count[63:32];
            default: rdata = 32'h0;
        endcase
    end
endmodule
