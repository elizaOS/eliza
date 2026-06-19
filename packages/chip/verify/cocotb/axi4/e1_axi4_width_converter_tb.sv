`timescale 1ns/1ps

// e1_axi4_width_converter_tb
//
// Synthesizable harness wrapping e1_axi4_width_converter (upstream 64-bit
// master <-> downstream 128-bit slave) plus a small behavioural slave that
// answers reads from an internal RAM, accepts writes, and produces B/R
// responses with optional latency.  Used by cocotb to exercise the
// upsize direction relied on for the CVA6 v5.3.0 -> cluster slot 0 path.

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDSIGNAL */
module e1_axi4_width_converter_tb #(
    parameter int unsigned UPSTREAM_DATA_W   = 64,
    parameter int unsigned DOWNSTREAM_DATA_W = 128,
    parameter int unsigned ID_W              = 4,
    parameter int unsigned ADDR_W            = 32,
    parameter int unsigned USER_W            = 1,
    parameter int unsigned BURST_LEN_W       = 8,
    parameter int unsigned MEM_DEPTH         = 4096  // 4 KiB / DN_BYTES
) (
    input  logic                                 clk,
    input  logic                                 rst_n,

    // Upstream master driven by cocotb
    input  logic [ID_W-1:0]                      up_aw_id,
    input  logic [ADDR_W-1:0]                    up_aw_addr,
    input  logic [BURST_LEN_W-1:0]               up_aw_len,
    input  logic [2:0]                           up_aw_size,
    input  logic [1:0]                           up_aw_burst,
    input  logic                                 up_aw_lock,
    input  logic [3:0]                           up_aw_cache,
    input  logic [2:0]                           up_aw_prot,
    input  logic [3:0]                           up_aw_qos,
    input  logic [3:0]                           up_aw_region,
    input  logic [5:0]                           up_aw_atop,
    input  logic [USER_W-1:0]                    up_aw_user,
    input  logic                                 up_aw_valid,
    output logic                                 up_aw_ready,

    input  logic [UPSTREAM_DATA_W-1:0]           up_w_data,
    input  logic [(UPSTREAM_DATA_W/8)-1:0]       up_w_strb,
    input  logic                                 up_w_last,
    input  logic [USER_W-1:0]                    up_w_user,
    input  logic                                 up_w_valid,
    output logic                                 up_w_ready,

    output logic [ID_W-1:0]                      up_b_id,
    output logic [1:0]                           up_b_resp,
    output logic [USER_W-1:0]                    up_b_user,
    output logic                                 up_b_valid,
    input  logic                                 up_b_ready,

    input  logic [ID_W-1:0]                      up_ar_id,
    input  logic [ADDR_W-1:0]                    up_ar_addr,
    input  logic [BURST_LEN_W-1:0]               up_ar_len,
    input  logic [2:0]                           up_ar_size,
    input  logic [1:0]                           up_ar_burst,
    input  logic                                 up_ar_lock,
    input  logic [3:0]                           up_ar_cache,
    input  logic [2:0]                           up_ar_prot,
    input  logic [3:0]                           up_ar_qos,
    input  logic [3:0]                           up_ar_region,
    input  logic [USER_W-1:0]                    up_ar_user,
    input  logic                                 up_ar_valid,
    output logic                                 up_ar_ready,

    output logic [ID_W-1:0]                      up_r_id,
    output logic [UPSTREAM_DATA_W-1:0]           up_r_data,
    output logic [1:0]                           up_r_resp,
    output logic                                 up_r_last,
    output logic [USER_W-1:0]                    up_r_user,
    output logic                                 up_r_valid,
    input  logic                                 up_r_ready,

    // Observability for cocotb
    output logic [DOWNSTREAM_DATA_W-1:0]         dbg_dn_w_data,
    output logic [(DOWNSTREAM_DATA_W/8)-1:0]     dbg_dn_w_strb,
    output logic                                 dbg_dn_w_valid,
    output logic                                 dbg_dn_w_ready,
    output logic [BURST_LEN_W-1:0]               dbg_dn_aw_len,
    output logic [2:0]                           dbg_dn_aw_size,
    output logic [BURST_LEN_W-1:0]               dbg_dn_ar_len,
    output logic [2:0]                           dbg_dn_ar_size
);

    localparam int unsigned DN_BYTES = DOWNSTREAM_DATA_W / 8;

    // ----- Downstream wires (converter -> behavioural slave) -----
    logic [ID_W-1:0]                  dn_aw_id;
    logic [ADDR_W-1:0]                dn_aw_addr;
    logic [BURST_LEN_W-1:0]           dn_aw_len;
    logic [2:0]                       dn_aw_size;
    logic [1:0]                       dn_aw_burst;
    logic                             dn_aw_lock;
    logic [3:0]                       dn_aw_cache;
    logic [2:0]                       dn_aw_prot;
    logic [3:0]                       dn_aw_qos;
    logic [3:0]                       dn_aw_region;
    logic [5:0]                       dn_aw_atop;
    logic [USER_W-1:0]                dn_aw_user;
    logic                             dn_aw_valid;
    logic                             dn_aw_ready;
    logic [DOWNSTREAM_DATA_W-1:0]     dn_w_data;
    logic [(DOWNSTREAM_DATA_W/8)-1:0] dn_w_strb;
    logic                             dn_w_last;
    logic [USER_W-1:0]                dn_w_user;
    logic                             dn_w_valid;
    logic                             dn_w_ready;
    logic [ID_W-1:0]                  dn_b_id;
    logic [1:0]                       dn_b_resp;
    logic [USER_W-1:0]                dn_b_user;
    logic                             dn_b_valid;
    logic                             dn_b_ready;
    logic [ID_W-1:0]                  dn_ar_id;
    logic [ADDR_W-1:0]                dn_ar_addr;
    logic [BURST_LEN_W-1:0]           dn_ar_len;
    logic [2:0]                       dn_ar_size;
    logic [1:0]                       dn_ar_burst;
    logic                             dn_ar_lock;
    logic [3:0]                       dn_ar_cache;
    logic [2:0]                       dn_ar_prot;
    logic [3:0]                       dn_ar_qos;
    logic [3:0]                       dn_ar_region;
    logic [USER_W-1:0]                dn_ar_user;
    logic                             dn_ar_valid;
    logic                             dn_ar_ready;
    logic [ID_W-1:0]                  dn_r_id;
    logic [DOWNSTREAM_DATA_W-1:0]     dn_r_data;
    logic [1:0]                       dn_r_resp;
    logic                             dn_r_last;
    logic [USER_W-1:0]                dn_r_user;
    logic                             dn_r_valid;
    logic                             dn_r_ready;

    e1_axi4_width_converter #(
        .UPSTREAM_DATA_W  (UPSTREAM_DATA_W),
        .DOWNSTREAM_DATA_W(DOWNSTREAM_DATA_W),
        .ID_W             (ID_W),
        .ADDR_W           (ADDR_W),
        .USER_W           (USER_W),
        .BURST_LEN_W      (BURST_LEN_W)
    ) u_dut (
        .clk_i      (clk),
        .rst_ni     (rst_n),
        .up_aw_id   (up_aw_id),
        .up_aw_addr (up_aw_addr),
        .up_aw_len  (up_aw_len),
        .up_aw_size (up_aw_size),
        .up_aw_burst(up_aw_burst),
        .up_aw_lock (up_aw_lock),
        .up_aw_cache(up_aw_cache),
        .up_aw_prot (up_aw_prot),
        .up_aw_qos  (up_aw_qos),
        .up_aw_region(up_aw_region),
        .up_aw_atop (up_aw_atop),
        .up_aw_user (up_aw_user),
        .up_aw_valid(up_aw_valid),
        .up_aw_ready(up_aw_ready),
        .up_w_data  (up_w_data),
        .up_w_strb  (up_w_strb),
        .up_w_last  (up_w_last),
        .up_w_user  (up_w_user),
        .up_w_valid (up_w_valid),
        .up_w_ready (up_w_ready),
        .up_b_id    (up_b_id),
        .up_b_resp  (up_b_resp),
        .up_b_user  (up_b_user),
        .up_b_valid (up_b_valid),
        .up_b_ready (up_b_ready),
        .up_ar_id   (up_ar_id),
        .up_ar_addr (up_ar_addr),
        .up_ar_len  (up_ar_len),
        .up_ar_size (up_ar_size),
        .up_ar_burst(up_ar_burst),
        .up_ar_lock (up_ar_lock),
        .up_ar_cache(up_ar_cache),
        .up_ar_prot (up_ar_prot),
        .up_ar_qos  (up_ar_qos),
        .up_ar_region(up_ar_region),
        .up_ar_user (up_ar_user),
        .up_ar_valid(up_ar_valid),
        .up_ar_ready(up_ar_ready),
        .up_r_id    (up_r_id),
        .up_r_data  (up_r_data),
        .up_r_resp  (up_r_resp),
        .up_r_last  (up_r_last),
        .up_r_user  (up_r_user),
        .up_r_valid (up_r_valid),
        .up_r_ready (up_r_ready),

        .dn_aw_id   (dn_aw_id),
        .dn_aw_addr (dn_aw_addr),
        .dn_aw_len  (dn_aw_len),
        .dn_aw_size (dn_aw_size),
        .dn_aw_burst(dn_aw_burst),
        .dn_aw_lock (dn_aw_lock),
        .dn_aw_cache(dn_aw_cache),
        .dn_aw_prot (dn_aw_prot),
        .dn_aw_qos  (dn_aw_qos),
        .dn_aw_region(dn_aw_region),
        .dn_aw_atop (dn_aw_atop),
        .dn_aw_user (dn_aw_user),
        .dn_aw_valid(dn_aw_valid),
        .dn_aw_ready(dn_aw_ready),
        .dn_w_data  (dn_w_data),
        .dn_w_strb  (dn_w_strb),
        .dn_w_last  (dn_w_last),
        .dn_w_user  (dn_w_user),
        .dn_w_valid (dn_w_valid),
        .dn_w_ready (dn_w_ready),
        .dn_b_id    (dn_b_id),
        .dn_b_resp  (dn_b_resp),
        .dn_b_user  (dn_b_user),
        .dn_b_valid (dn_b_valid),
        .dn_b_ready (dn_b_ready),
        .dn_ar_id   (dn_ar_id),
        .dn_ar_addr (dn_ar_addr),
        .dn_ar_len  (dn_ar_len),
        .dn_ar_size (dn_ar_size),
        .dn_ar_burst(dn_ar_burst),
        .dn_ar_lock (dn_ar_lock),
        .dn_ar_cache(dn_ar_cache),
        .dn_ar_prot (dn_ar_prot),
        .dn_ar_qos  (dn_ar_qos),
        .dn_ar_region(dn_ar_region),
        .dn_ar_user (dn_ar_user),
        .dn_ar_valid(dn_ar_valid),
        .dn_ar_ready(dn_ar_ready),
        .dn_r_id    (dn_r_id),
        .dn_r_data  (dn_r_data),
        .dn_r_resp  (dn_r_resp),
        .dn_r_last  (dn_r_last),
        .dn_r_user  (dn_r_user),
        .dn_r_valid (dn_r_valid),
        .dn_r_ready (dn_r_ready)
    );

    assign dbg_dn_w_data  = dn_w_data;
    assign dbg_dn_w_strb  = dn_w_strb;
    assign dbg_dn_w_valid = dn_w_valid;
    assign dbg_dn_w_ready = dn_w_ready;
    assign dbg_dn_aw_len  = dn_aw_len;
    assign dbg_dn_aw_size = dn_aw_size;
    assign dbg_dn_ar_len  = dn_ar_len;
    assign dbg_dn_ar_size = dn_ar_size;

    // ============================================================
    // Behavioural downstream slave with downstream-wide memory.
    // ============================================================
    logic [DOWNSTREAM_DATA_W-1:0] mem [MEM_DEPTH];

    // ----- Write side -----
    // Capture AW into a small holding register, then drain W beats into
    // mem indexed by (aw_addr / DN_BYTES) + beat_counter.
    logic                       aw_held_q;
    logic [ID_W-1:0]            aw_id_q;
    logic [ADDR_W-1:0]          aw_addr_q;
    logic [BURST_LEN_W-1:0]     aw_beats_left_q;
    logic [2:0]                 aw_size_q;
    logic [USER_W-1:0]          aw_user_q;
    logic                       w_in_burst_q;
    logic [ADDR_W-1:0]          w_cur_addr_q;

    assign dn_aw_ready = ~aw_held_q;
    assign dn_w_ready  = aw_held_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            aw_held_q       <= 1'b0;
            aw_id_q         <= '0;
            aw_addr_q       <= '0;
            aw_beats_left_q <= '0;
            aw_size_q       <= 3'd0;
            aw_user_q       <= '0;
            w_in_burst_q    <= 1'b0;
            w_cur_addr_q    <= '0;
        end else begin
            if (dn_aw_valid && dn_aw_ready) begin
                aw_held_q       <= 1'b1;
                aw_id_q         <= dn_aw_id;
                aw_addr_q       <= dn_aw_addr;
                aw_beats_left_q <= dn_aw_len;
                aw_size_q       <= dn_aw_size;
                aw_user_q       <= dn_aw_user;
                w_in_burst_q    <= 1'b1;
                w_cur_addr_q    <= dn_aw_addr;
            end
            if (dn_w_valid && dn_w_ready) begin
                automatic int idx;
                automatic int unsigned beat_bytes;
                idx = (w_cur_addr_q / DN_BYTES) % MEM_DEPTH;
                // strobe-merge into mem
                for (int b = 0; b < DN_BYTES; b++) begin
                    if (dn_w_strb[b]) begin
                        mem[idx][b*8 +: 8] <= dn_w_data[b*8 +: 8];
                    end
                end
                // AXI4 INCR: advance by 2^AxSIZE bytes per beat (the
                // AxSIZE encodes bytes_per_beat = 1 << AxSIZE).  In the
                // upsize path AxSIZE on the downstream bus equals the
                // upstream's AxSIZE, so a 64-bit upstream beat on the
                // 128-bit downstream bus still advances by 8 bytes.
                beat_bytes = 1 << aw_size_q;
                w_cur_addr_q <= w_cur_addr_q + beat_bytes;
                if (dn_w_last) begin
                    w_in_burst_q <= 1'b0;
                end
            end
        end
    end

    // B response: emit one cycle after the W burst completes.
    logic b_pending_q;
    assign dn_b_id    = aw_id_q;
    assign dn_b_resp  = 2'b00;
    assign dn_b_user  = aw_user_q;
    assign dn_b_valid = b_pending_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            b_pending_q <= 1'b0;
        end else begin
            if (dn_w_valid && dn_w_ready && dn_w_last) begin
                b_pending_q <= 1'b1;
            end
            if (dn_b_valid && dn_b_ready) begin
                b_pending_q <= 1'b0;
                aw_held_q   <= 1'b0;  // free slot for next AW
            end
        end
    end

    // ----- Read side -----
    logic                       ar_held_q;
    logic [ID_W-1:0]            ar_id_q;
    logic [ADDR_W-1:0]          ar_cur_addr_q;
    logic [BURST_LEN_W-1:0]     ar_beats_left_q;
    logic [USER_W-1:0]          ar_user_q;
    logic [2:0]                 ar_size_q;
    logic                       r_in_burst_q;
    logic                       r_is_last_q;

    assign dn_ar_ready = ~ar_held_q;

    assign dn_r_id    = ar_id_q;
    assign dn_r_resp  = 2'b00;
    assign dn_r_user  = ar_user_q;
    assign dn_r_last  = r_is_last_q;
    assign dn_r_valid = r_in_burst_q;
    always_comb begin
        automatic int idx;
        idx = (ar_cur_addr_q / DN_BYTES) % MEM_DEPTH;
        dn_r_data = mem[idx];
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ar_held_q       <= 1'b0;
            ar_id_q         <= '0;
            ar_cur_addr_q   <= '0;
            ar_beats_left_q <= '0;
            ar_user_q       <= '0;
            ar_size_q       <= 3'd0;
            r_in_burst_q    <= 1'b0;
            r_is_last_q     <= 1'b0;
        end else begin
            if (dn_ar_valid && dn_ar_ready) begin
                ar_held_q       <= 1'b1;
                ar_id_q         <= dn_ar_id;
                ar_cur_addr_q   <= dn_ar_addr;
                ar_beats_left_q <= dn_ar_len;
                ar_user_q       <= dn_ar_user;
                ar_size_q       <= dn_ar_size;
                r_in_burst_q    <= 1'b1;
                r_is_last_q     <= (dn_ar_len == '0);
            end
            if (dn_r_valid && dn_r_ready) begin
                if (r_is_last_q) begin
                    r_in_burst_q <= 1'b0;
                    ar_held_q    <= 1'b0;
                    r_is_last_q  <= 1'b0;
                end else begin
                    ar_cur_addr_q   <= ar_cur_addr_q + (32'd1 << ar_size_q);
                    ar_beats_left_q <= ar_beats_left_q - 1'b1;
                    r_is_last_q     <= (ar_beats_left_q == 1);
                end
            end
        end
    end

endmodule
/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on DECLFILENAME */
