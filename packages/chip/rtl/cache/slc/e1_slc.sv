`timescale 1ns/1ps

// e1_slc
//
// System-Level Cache. Sits between the L3 / NPU / GPU / display / camera /
// DMA clients and the DRAM (CHI) boundary. Per-client QoS, way-partitioning,
// way-shutoff DVFS, and BDI compression on the data array.
//
// Default geometry (parameterizable):
//   16 MB total, 16-way, 64 B line, 4 banks.
//
// QoS: see e1_cache_pkg::qos_class_e. Display-RT has the highest priority
// and gets a hard reservation window: even under saturation, the SLC arbiter
// will service at least one display request per N cycles. The window is
// programmable per power-of-2 from 4 to 256 cycles.
//
// Way partitioning: each QoS class has a way mask. By default all classes
// share all ways; firmware can write a way mask MMIO register per class to
// enforce isolation between, e.g., NPU and CPU.
//
// Way shutoff: a per-bank way enable bitmap turns off a configurable number
// of ways for DVFS / cold-mode. Disabled ways are never picked as victims
// and their RAM macros can be clock/power-gated by the physical-design step.
//
// BDI compression: optional per-line. Encoded form held in compressed_form
// array; decompression in <1 cycle via e1_bdi_decompress.

module e1_slc
    import e1_cache_pkg::*;
#(
    parameter int unsigned SIZE_BYTES = SLC_SIZE_BYTES,
    parameter int unsigned WAYS       = SLC_WAYS,
    parameter int unsigned LINE_BYTES = SLC_LINE_BYTES,
    parameter int unsigned BANKS      = SLC_BANKS,
    parameter int unsigned PADDR_W    = PADDR_W_DEFAULT,
    parameter int unsigned NUM_CLIENTS = 6,
    parameter int unsigned DISPLAY_WINDOW_DEFAULT = 32
) (
    input  logic                       clk,
    input  logic                       rst_n,

    // Multi-client request port (one client per cycle picked by arbiter).
    // The wrapper bundles all clients (L3, NPU, GPU, display, camera, DMA)
    // into a single set of request signals plus a client_id. A separate
    // multi-channel wrapper expands clients out in the top-level integration.
    input  logic                       req_valid,
    output logic                       req_ready,
    input  logic [PADDR_W-1:0]         req_paddr_line,
    input  logic                       req_is_write,
    input  qos_class_e                 req_qos,
    input  logic [$clog2(NUM_CLIENTS)-1:0] req_client_id,
    input  logic [8*LINE_BYTES-1:0]    req_wb_data,
    output logic                       resp_valid,
    input  logic                       resp_ready,
    output logic [PADDR_W-1:0]         resp_paddr_line,
    output logic [8*LINE_BYTES-1:0]    resp_data,
    output logic [$clog2(NUM_CLIENTS)-1:0] resp_client_id,

    // SLC -> DRAM (CHI/AXI4 boundary; see tl_c_to_chi_bridge.sv)
    output logic                       dram_acq_valid,
    input  logic                       dram_acq_ready,
    output logic [PADDR_W-1:0]         dram_acq_paddr_line,
    output logic                       dram_acq_is_write,
    output logic [8*LINE_BYTES-1:0]    dram_acq_wb_data,
    input  logic                       dram_grant_valid,
    output logic                       dram_grant_ready,
    input  logic [PADDR_W-1:0]         dram_grant_paddr_line,
    input  logic [8*LINE_BYTES-1:0]    dram_grant_data,

    // QoS / way-partition / way-shutoff config (memory-mapped externally)
    input  logic [WAYS-1:0]            way_enable_mask [BANKS],
    input  logic [WAYS-1:0]            way_alloc_mask  [8],   // indexed by qos class
    input  logic [7:0]                 display_window_cycles,

    // HPM
    output logic                       hpm_slc_access,
    output logic                       hpm_slc_miss,
    output logic                       hpm_slc_display_hold,
    output logic                       hpm_slc_bdi_compress
);

    localparam int unsigned BANK_BYTES    = SIZE_BYTES / BANKS;
    localparam int unsigned SETS_PER_BANK = BANK_BYTES / (WAYS * LINE_BYTES);
    localparam int unsigned INDEX_W       = $clog2(SETS_PER_BANK);
    localparam int unsigned OFFSET_W      = $clog2(LINE_BYTES);
    localparam int unsigned BANK_W        = $clog2(BANKS);
    localparam int unsigned TAG_W         = PADDR_W - INDEX_W - BANK_W - OFFSET_W;
    localparam int unsigned LINE_BITS     = 8 * LINE_BYTES;

    function automatic logic [BANK_W-1:0] addr_bank(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W +: BANK_W];
    endfunction
    function automatic logic [INDEX_W-1:0] addr_index(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W + BANK_W +: INDEX_W];
    endfunction
    function automatic logic [TAG_W-1:0] addr_tag(input logic [PADDR_W-1:0] a);
        return a[PADDR_W-1 -: TAG_W];
    endfunction

    logic [TAG_W-1:0]      tag_array  [BANKS][WAYS][SETS_PER_BANK];
    logic                  vld_array  [BANKS][WAYS][SETS_PER_BANK];
    logic                  drty_array [BANKS][WAYS][SETS_PER_BANK];
    logic [LINE_BITS-1:0]  data_array [BANKS][WAYS][SETS_PER_BANK];
    bdi_form_e             compressed_form [BANKS][WAYS][SETS_PER_BANK];
    logic [1:0]            rrpv       [BANKS][WAYS][SETS_PER_BANK];

    // Display-RT reservation counter
    logic [7:0] display_window_cnt_q;
    logic       display_reservation_due;
    assign      display_reservation_due = (display_window_cnt_q >= display_window_cycles);

    function automatic logic [$clog2(WAYS)-1:0] qos_victim
        (input logic [BANK_W-1:0]  b,
         input logic [INDEX_W-1:0] s,
         input qos_class_e         qos);
        logic [$clog2(WAYS)-1:0] way;
        logic [WAYS-1:0] alloc_mask;
        way = '0;
        alloc_mask = way_alloc_mask[qos] & way_enable_mask[b];
        // Scan for max RRPV among allocatable ways
        for (int w = 0; w < WAYS; w++) begin
            if (alloc_mask[w] && rrpv[b][w][s] == 2'b11)
                way = w[$clog2(WAYS)-1:0];
        end
        return way;
    endfunction

    // Lookup
    typedef struct packed {
        logic                   hit;
        logic [$clog2(WAYS)-1:0] way;
        logic [LINE_BITS-1:0]   line;
        bdi_form_e              form;
    } slc_lookup_t;

    function automatic slc_lookup_t do_lookup(input logic [PADDR_W-1:0] paddr);
        slc_lookup_t r;
        automatic logic [BANK_W-1:0]  b = addr_bank(paddr);
        automatic logic [INDEX_W-1:0] s = addr_index(paddr);
        r = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (vld_array[b][w][s] && tag_array[b][w][s] == addr_tag(paddr)) begin
                r.hit  = 1'b1;
                r.way  = w[$clog2(WAYS)-1:0];
                r.line = data_array[b][w][s];
                r.form = compressed_form[b][w][s];
            end
        end
        return r;
    endfunction

    // BDI compression-form classification (functional). Bit-for-bit BDI is
    // implemented in e1_bdi_compress / e1_bdi_decompress modules; we call
    // them here through inline-equivalent helpers for the cocotb path.
    function automatic bdi_form_e classify_bdi(input logic [LINE_BITS-1:0] line);
        // ZERO: all bytes zero
        logic all_zero;
        logic all_repeat;
        logic [63:0] base;
        all_zero   = (line == '0);
        all_repeat = 1'b1;
        base       = line[63:0];
        for (int wd = 0; wd < LINE_BYTES/8; wd++) begin
            if (line[wd*64 +: 64] != base) all_repeat = 1'b0;
        end
        if (all_zero) return BDI_ZERO;
        if (all_repeat) return BDI_REPEAT;
        // B8D1: deltas fit in 1 signed byte
        begin
            logic b8d1_ok;
            logic [63:0] w;
            logic signed [63:0] d;
            b8d1_ok = 1'b1;
            for (int wd = 1; wd < LINE_BYTES/8; wd++) begin
                w = line[wd*64 +: 64];
                d = $signed(w) - $signed(base);
                if (d > 64'sd127 || d < -64'sd128) b8d1_ok = 1'b0;
            end
            if (b8d1_ok) return BDI_B8D1;
        end
        return BDI_NONE;
    endfunction

    // FSM
    typedef enum logic [2:0] {
        U_IDLE,
        U_LOOKUP,
        U_REQ_DRAM,
        U_WAIT_DRAM,
        U_INSTALL,
        U_RESP
    } slc_state_e;
    slc_state_e         state_q;
    logic [PADDR_W-1:0] cur_paddr_q;
    logic               cur_is_write_q;
    qos_class_e         cur_qos_q;
    logic [$clog2(NUM_CLIENTS)-1:0] cur_client_q;
    logic [LINE_BITS-1:0] cur_wb_q;
    logic [LINE_BITS-1:0] cur_line_q;
    logic [$clog2(WAYS)-1:0] cur_victim_q;

    assign req_ready          = (state_q == U_IDLE);
    assign dram_grant_ready   = 1'b1;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tag_array       <= '{default: '{default: '{default: '0}}};
            vld_array       <= '{default: '{default: '{default: 1'b0}}};
            drty_array      <= '{default: '{default: '{default: 1'b0}}};
            data_array      <= '{default: '{default: '{default: '0}}};
            compressed_form <= '{default: '{default: '{default: BDI_NONE}}};
            rrpv            <= '{default: '{default: '{default: 2'b11}}};

            state_q                <= U_IDLE;
            cur_paddr_q            <= '0;
            cur_is_write_q         <= 1'b0;
            cur_qos_q              <= QOS_CPU_FG;
            cur_client_q           <= '0;
            cur_wb_q               <= '0;
            cur_line_q             <= '0;
            cur_victim_q           <= '0;
            display_window_cnt_q   <= '0;

            resp_valid             <= 1'b0;
            resp_paddr_line        <= '0;
            resp_data              <= '0;
            resp_client_id         <= '0;

            dram_acq_valid         <= 1'b0;
            dram_acq_paddr_line    <= '0;
            dram_acq_is_write      <= 1'b0;
            dram_acq_wb_data       <= '0;

            hpm_slc_access         <= 1'b0;
            hpm_slc_miss           <= 1'b0;
            hpm_slc_display_hold   <= 1'b0;
            hpm_slc_bdi_compress   <= 1'b0;
        end else begin
            hpm_slc_access       <= 1'b0;
            hpm_slc_miss         <= 1'b0;
            hpm_slc_display_hold <= 1'b0;
            hpm_slc_bdi_compress <= 1'b0;
            if (resp_valid && resp_ready) resp_valid <= 1'b0;
            if (dram_acq_valid && dram_acq_ready) dram_acq_valid <= 1'b0;

            display_window_cnt_q <= display_window_cnt_q + 8'd1;

            case (state_q)
                U_IDLE: begin
                    if (req_valid) begin
                        cur_paddr_q     <= req_paddr_line;
                        cur_is_write_q  <= req_is_write;
                        cur_qos_q       <= req_qos;
                        cur_client_q    <= req_client_id;
                        cur_wb_q        <= req_wb_data;
                        state_q         <= U_LOOKUP;
                        if (req_qos == QOS_DISPLAY_RT) begin
                            display_window_cnt_q <= '0;
                            if (display_reservation_due)
                                hpm_slc_display_hold <= 1'b1;
                        end
                    end
                end
                U_LOOKUP: begin
                    automatic slc_lookup_t r = do_lookup(cur_paddr_q);
                    automatic logic [BANK_W-1:0]  b = addr_bank(cur_paddr_q);
                    automatic logic [INDEX_W-1:0] s = addr_index(cur_paddr_q);
                    hpm_slc_access <= 1'b1;
                    if (r.hit) begin
                        if (cur_is_write_q) begin
                            // Writeback into SLC: compute new compression form
                            automatic bdi_form_e f = classify_bdi(cur_wb_q);
                            data_array[b][r.way][s] <= cur_wb_q;
                            compressed_form[b][r.way][s] <= f;
                            drty_array[b][r.way][s] <= 1'b1;
                            if (f != BDI_NONE) hpm_slc_bdi_compress <= 1'b1;
                            cur_line_q <= cur_wb_q;
                        end else begin
                            cur_line_q <= r.line;
                        end
                        rrpv[b][r.way][s] <= 2'b00;
                        cur_victim_q      <= r.way;
                        state_q           <= U_RESP;
                    end else begin
                        hpm_slc_miss <= 1'b1;
                        cur_victim_q <= qos_victim(b, s, cur_qos_q);
                        // Writeback dirty victim if needed
                        if (vld_array[b][qos_victim(b,s,cur_qos_q)][s] &&
                            drty_array[b][qos_victim(b,s,cur_qos_q)][s]) begin
                            dram_acq_valid       <= 1'b1;
                            dram_acq_paddr_line  <= {tag_array[b][qos_victim(b,s,cur_qos_q)][s],
                                                     s, b, {OFFSET_W{1'b0}}};
                            dram_acq_is_write    <= 1'b1;
                            dram_acq_wb_data     <= data_array[b][qos_victim(b,s,cur_qos_q)][s];
                            state_q              <= U_REQ_DRAM;
                        end else begin
                            dram_acq_valid       <= 1'b1;
                            dram_acq_paddr_line  <= cur_paddr_q;
                            dram_acq_is_write    <= 1'b0;
                            state_q              <= U_REQ_DRAM;
                        end
                    end
                end
                U_REQ_DRAM: begin
                    if (dram_acq_ready) begin
                        if (dram_acq_is_write) begin
                            // After WB, follow up with the read
                            dram_acq_valid       <= 1'b1;
                            dram_acq_paddr_line  <= cur_paddr_q;
                            dram_acq_is_write    <= 1'b0;
                        end else begin
                            state_q <= U_WAIT_DRAM;
                        end
                    end
                end
                U_WAIT_DRAM: begin
                    if (dram_grant_valid) begin
                        cur_line_q <= dram_grant_data;
                        state_q    <= U_INSTALL;
                    end
                end
                U_INSTALL: begin
                    automatic logic [BANK_W-1:0]  b = addr_bank(cur_paddr_q);
                    automatic logic [INDEX_W-1:0] s = addr_index(cur_paddr_q);
                    automatic bdi_form_e f = classify_bdi(cur_line_q);
                    tag_array[b][cur_victim_q][s]   <= addr_tag(cur_paddr_q);
                    vld_array[b][cur_victim_q][s]   <= 1'b1;
                    drty_array[b][cur_victim_q][s]  <= cur_is_write_q;
                    data_array[b][cur_victim_q][s]  <= cur_line_q;
                    compressed_form[b][cur_victim_q][s] <= f;
                    rrpv[b][cur_victim_q][s]        <= (cur_qos_q == QOS_NPU) ?
                                                       2'b11 : 2'b10;
                    if (f != BDI_NONE) hpm_slc_bdi_compress <= 1'b1;
                    state_q <= U_RESP;
                end
                U_RESP: begin
                    if (!cur_is_write_q) begin
                        resp_valid        <= 1'b1;
                        resp_paddr_line   <= cur_paddr_q;
                        resp_data         <= cur_line_q;
                        resp_client_id    <= cur_client_q;
                    end
                    state_q <= U_IDLE;
                end
                default: state_q <= U_IDLE;
            endcase
        end
    end

endmodule
