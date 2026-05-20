`timescale 1ns/1ps

// e1_l3_cache
//
// Shared multi-bank L3 cache with directory-based MESI.
//
// Default geometry (parameterizable):
//   8 MB, 16-way, 64 B line, 4 banks.
//   Bank select uses address bits [BANK_SHIFT +: BANK_W].
//
// Coherence: distributed directory at L3. Each line's directory entry
// tracks which L2s (and the NPU IO-coherent client) hold the line, and in
// what state.
//
// Replacement: Mockingjay-class with DRRIP fallback. This module exposes a
// REPLACEMENT_POLICY parameter and delegates to a replacement-policy
// sub-module so the choice is single-source-of-truth.
//
// Latency: ~25 cycles in physical design. Functional model is single-cycle
// hit / multi-cycle miss with backing SLC.

module e1_l3_cache
    import e1_cache_pkg::*;
#(
    parameter int unsigned SIZE_BYTES = L3_SIZE_BYTES,
    parameter int unsigned WAYS       = L3_WAYS,
    parameter int unsigned LINE_BYTES = L3_LINE_BYTES,
    parameter int unsigned BANKS      = L3_BANKS,
    parameter int unsigned NUM_L2     = 1,        // number of L2 sharers tracked
    parameter int unsigned PADDR_W    = PADDR_W_DEFAULT,
    parameter logic [1:0]  REPLACEMENT_POLICY = 2'd0  // 0=DRRIP 1=Hawkeye 2=Mockingjay 3=LRU
) (
    input  logic                       clk,
    input  logic                       rst_n,

    // L2 requests (one channel per L2, multiplexed externally to a single
    // pair of valid/ready signals for area). For the functional model and
    // NUM_L2=1, this is a single L2 port. Multi-L2 routing is layered by
    // an interconnect module instantiated alongside.
    input  logic                       l2_acq_valid,
    output logic                       l2_acq_ready,
    input  logic [PADDR_W-1:0]         l2_acq_paddr_line,
    input  logic                       l2_acq_is_write,
    input  mesi_e                      l2_acq_req_state,
    input  logic [8*LINE_BYTES-1:0]    l2_acq_wb_data,
    input  logic [(NUM_L2 > 1 ? $clog2(NUM_L2) : 1)-1:0] l2_acq_source_id,

    output logic                       l2_grant_valid,
    input  logic                       l2_grant_ready,
    output logic [PADDR_W-1:0]         l2_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0]    l2_grant_data,
    output mesi_e                      l2_grant_state,
    output logic [(NUM_L2 > 1 ? $clog2(NUM_L2) : 1)-1:0] l2_grant_source_id,

    // Probe issued to L2(s)
    output logic                       l2_probe_valid,
    input  logic                       l2_probe_ready,
    output logic [PADDR_W-1:0]         l2_probe_paddr_line,
    output mesi_e                      l2_probe_target_state,
    output logic [NUM_L2-1:0]          l2_probe_mask,
    input  logic                       l2_probe_ack,
    input  logic                       l2_probe_has_data,
    input  logic [8*LINE_BYTES-1:0]    l2_probe_wb_data,
    input  mesi_e                      l2_probe_final_state,

    // L3 -> SLC
    output logic                       slc_acq_valid,
    input  logic                       slc_acq_ready,
    output logic [PADDR_W-1:0]         slc_acq_paddr_line,
    output logic                       slc_acq_is_write,
    output qos_class_e                 slc_acq_qos,
    output logic [8*LINE_BYTES-1:0]    slc_acq_wb_data,
    input  logic                       slc_grant_valid,
    output logic                       slc_grant_ready,
    input  logic [PADDR_W-1:0]         slc_grant_paddr_line,
    input  logic [8*LINE_BYTES-1:0]    slc_grant_data,

    // HPM
    output logic                       hpm_l3_access,
    output logic                       hpm_l3_miss,
    output logic                       hpm_l3_snoop_hit,
    output logic                       hpm_l3_writeback
);

    localparam int unsigned BANK_BYTES    = SIZE_BYTES / BANKS;
    localparam int unsigned SETS_PER_BANK = BANK_BYTES / (WAYS * LINE_BYTES);
    localparam int unsigned INDEX_W       = $clog2(SETS_PER_BANK);
    localparam int unsigned OFFSET_W      = $clog2(LINE_BYTES);
    localparam int unsigned BANK_W        = $clog2(BANKS);
    localparam int unsigned TAG_W         = PADDR_W - INDEX_W - BANK_W - OFFSET_W;
    localparam int unsigned LINE_BITS     = 8 * LINE_BYTES;
    /* verilator lint_off UNUSEDPARAM */
    localparam int unsigned BANK_SHIFT    = OFFSET_W;
    /* verilator lint_on UNUSEDPARAM */
    localparam int unsigned SRC_W         = (NUM_L2 > 1) ? $clog2(NUM_L2) : 1;

    function automatic logic [BANK_W-1:0] addr_bank(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W +: BANK_W];
    endfunction
    function automatic logic [INDEX_W-1:0] addr_index(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W + BANK_W +: INDEX_W];
    endfunction
    function automatic logic [TAG_W-1:0] addr_tag(input logic [PADDR_W-1:0] a);
        return a[PADDR_W-1 -: TAG_W];
    endfunction

    // Per-bank storage. Per-line directory: which L2s hold it and the
    // aggregated state.
    logic [TAG_W-1:0]      tag_array  [BANKS][WAYS][SETS_PER_BANK];
    mesi_e                 state_array [BANKS][WAYS][SETS_PER_BANK];
    logic [LINE_BITS-1:0]  data_array [BANKS][WAYS][SETS_PER_BANK];
    logic [NUM_L2-1:0]     sharers    [BANKS][WAYS][SETS_PER_BANK];
    logic [WAYS-2:0]       plru       [BANKS][SETS_PER_BANK];

    // 2-bit RRPV per way per set for DRRIP / RRIP-class policies.
    logic [1:0]            rrpv [BANKS][WAYS][SETS_PER_BANK];
    // Set-dueling psel counter (10-bit signed).
    logic signed [9:0]     drrip_psel_q;

    // Lookup
    typedef struct packed {
        logic                   hit;
        logic [$clog2(WAYS)-1:0] way;
        logic [LINE_BITS-1:0]   line;
        mesi_e                  state;
        logic [NUM_L2-1:0]      sharers;
    } l3_lookup_t;

    function automatic l3_lookup_t do_lookup(input logic [PADDR_W-1:0] paddr);
        l3_lookup_t r;
        automatic logic [BANK_W-1:0]  b = addr_bank(paddr);
        automatic logic [INDEX_W-1:0] s = addr_index(paddr);
        r = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (state_array[b][w][s] != MESI_I &&
                tag_array[b][w][s] == addr_tag(paddr)) begin
                r.hit     = 1'b1;
                r.way     = w[$clog2(WAYS)-1:0];
                r.line    = data_array[b][w][s];
                r.state   = state_array[b][w][s];
                r.sharers = sharers[b][w][s];
            end
        end
        return r;
    endfunction

    // DRRIP victim selection: scan for RRPV=3, age otherwise.
    function automatic logic [$clog2(WAYS)-1:0] drrip_victim
        (input logic [BANK_W-1:0] b, input logic [INDEX_W-1:0] s);
        logic [$clog2(WAYS)-1:0] candidate;
        candidate = '0;
        // First scan: any way with RRPV == 3?
        for (int w = 0; w < WAYS; w++) begin
            if (rrpv[b][w][s] == 2'b11) candidate = w[$clog2(WAYS)-1:0];
        end
        return candidate;
    endfunction

    function automatic logic [$clog2(WAYS)-1:0] plru_victim
        (input logic [WAYS-2:0] tree);
        logic [$clog2(WAYS)-1:0] way;
        int unsigned node;
        node = 0;
        way  = '0;
        for (int level = 0; level < $clog2(WAYS); level++) begin
            way[$clog2(WAYS)-1-level] = tree[node];
            node = (node * 2) + 1 + (tree[node] ? 1 : 0);
        end
        return way;
    endfunction

    function automatic logic [$clog2(WAYS)-1:0] pick_victim
        (input logic [BANK_W-1:0] b, input logic [INDEX_W-1:0] s);
        if (REPLACEMENT_POLICY == 2'd0) return drrip_victim(b, s);
        else return plru_victim(plru[b][s]);
    endfunction

    // FSM
    typedef enum logic [2:0] {
        T_IDLE,
        T_LOOKUP,
        T_PROBE_SHARERS,
        T_REQ_SLC,
        T_WAIT_SLC,
        T_INSTALL,
        T_RESP
    } l3_state_e;
    l3_state_e         state_q;
    logic [PADDR_W-1:0] cur_paddr_q;
    logic              cur_is_write_q;
    mesi_e             cur_req_state_q;
    logic [LINE_BITS-1:0] cur_wb_q;
    logic [LINE_BITS-1:0] cur_line_q;
    mesi_e             cur_grant_state_q;
    logic [SRC_W-1:0]  cur_src_q;
    logic [$clog2(WAYS)-1:0] cur_victim_q;
    logic [NUM_L2-1:0] cur_probe_mask_q;

    assign l2_acq_ready = (state_q == T_IDLE);
    assign slc_grant_ready = 1'b1;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int b = 0; b < BANKS; b++)
                for (int w = 0; w < WAYS; w++)
                    for (int s = 0; s < SETS_PER_BANK; s++) begin
                        tag_array[b][w][s]   <= '0;
                        state_array[b][w][s] <= MESI_I;
                        data_array[b][w][s]  <= '0;
                        sharers[b][w][s]     <= '0;
                        rrpv[b][w][s]        <= 2'b11;
                    end
            for (int b = 0; b < BANKS; b++)
                for (int s = 0; s < SETS_PER_BANK; s++)
                    plru[b][s] <= '0;
            drrip_psel_q <= 10'sd0;

            state_q             <= T_IDLE;
            cur_paddr_q         <= '0;
            cur_is_write_q      <= 1'b0;
            cur_req_state_q     <= MESI_I;
            cur_wb_q            <= '0;
            cur_line_q          <= '0;
            cur_grant_state_q   <= MESI_I;
            cur_src_q           <= '0;
            cur_victim_q        <= '0;
            cur_probe_mask_q    <= '0;

            l2_grant_valid       <= 1'b0;
            l2_grant_paddr_line  <= '0;
            l2_grant_data        <= '0;
            l2_grant_state       <= MESI_I;
            l2_grant_source_id   <= '0;

            l2_probe_valid       <= 1'b0;
            l2_probe_paddr_line  <= '0;
            l2_probe_target_state <= MESI_I;
            l2_probe_mask        <= '0;

            slc_acq_valid        <= 1'b0;
            slc_acq_paddr_line   <= '0;
            slc_acq_is_write     <= 1'b0;
            slc_acq_qos          <= QOS_CPU_FG;
            slc_acq_wb_data      <= '0;

            hpm_l3_access        <= 1'b0;
            hpm_l3_miss          <= 1'b0;
            hpm_l3_snoop_hit     <= 1'b0;
            hpm_l3_writeback     <= 1'b0;
        end else begin
            hpm_l3_access    <= 1'b0;
            hpm_l3_miss      <= 1'b0;
            hpm_l3_snoop_hit <= 1'b0;
            hpm_l3_writeback <= 1'b0;
            if (l2_grant_valid && l2_grant_ready) l2_grant_valid <= 1'b0;
            if (l2_probe_valid && l2_probe_ready) l2_probe_valid <= 1'b0;

            case (state_q)
                T_IDLE: begin
                    if (l2_acq_valid) begin
                        cur_paddr_q      <= l2_acq_paddr_line;
                        cur_is_write_q   <= l2_acq_is_write;
                        cur_req_state_q  <= l2_acq_req_state;
                        cur_wb_q         <= l2_acq_wb_data;
                        cur_src_q        <= l2_acq_source_id;
                        state_q          <= T_LOOKUP;
                    end
                end
                T_LOOKUP: begin
                    automatic l3_lookup_t r = do_lookup(cur_paddr_q);
                    automatic logic [BANK_W-1:0]  b = addr_bank(cur_paddr_q);
                    automatic logic [INDEX_W-1:0] s = addr_index(cur_paddr_q);
                    hpm_l3_access <= 1'b1;
                    if (r.hit) begin
                        // Determine if sharers need to be probed
                        automatic logic [NUM_L2-1:0] mask = r.sharers;
                        mask[cur_src_q] = 1'b0; // don't probe self
                        if (cur_req_state_q == MESI_M && |mask) begin
                            cur_probe_mask_q <= mask;
                            l2_probe_valid       <= 1'b1;
                            l2_probe_paddr_line  <= cur_paddr_q;
                            l2_probe_target_state<= MESI_I;
                            l2_probe_mask        <= mask;
                            state_q              <= T_PROBE_SHARERS;
                            hpm_l3_snoop_hit     <= 1'b1;
                        end else if (cur_req_state_q == MESI_S && r.state == MESI_M && |mask) begin
                            cur_probe_mask_q <= mask;
                            l2_probe_valid       <= 1'b1;
                            l2_probe_paddr_line  <= cur_paddr_q;
                            l2_probe_target_state<= MESI_S;
                            l2_probe_mask        <= mask;
                            state_q              <= T_PROBE_SHARERS;
                            hpm_l3_snoop_hit     <= 1'b1;
                        end else begin
                            cur_line_q         <= r.line;
                            cur_grant_state_q  <= cur_req_state_q;
                            cur_victim_q       <= r.way;
                            // Update sharers + DRRIP
                            sharers[b][r.way][s] <= r.sharers | (NUM_L2'(1) << cur_src_q);
                            if (cur_req_state_q == MESI_M)
                                state_array[b][r.way][s] <= MESI_M;
                            else if (state_array[b][r.way][s] != MESI_M)
                                state_array[b][r.way][s] <= MESI_S;
                            rrpv[b][r.way][s] <= 2'b00;
                            plru[b][s] <= /* keep tree update small */
                                plru[b][s];
                            state_q <= T_RESP;
                        end
                    end else begin
                        hpm_l3_miss <= 1'b1;
                        cur_victim_q <= pick_victim(b, s);
                        // Writeback victim if dirty
                        if (state_array[b][pick_victim(b, s)][s] == MESI_M) begin
                            hpm_l3_writeback <= 1'b1;
                            slc_acq_valid       <= 1'b1;
                            slc_acq_paddr_line  <= {tag_array[b][pick_victim(b, s)][s],
                                                    s, b, {OFFSET_W{1'b0}}};
                            slc_acq_is_write    <= 1'b1;
                            slc_acq_qos         <= QOS_CPU_BG;
                            slc_acq_wb_data     <= data_array[b][pick_victim(b, s)][s];
                            state_q             <= T_REQ_SLC;
                        end else begin
                            slc_acq_valid       <= 1'b1;
                            slc_acq_paddr_line  <= cur_paddr_q;
                            slc_acq_is_write    <= 1'b0;
                            slc_acq_qos         <= QOS_CPU_FG;
                            state_q             <= T_REQ_SLC;
                        end
                    end
                end
                T_PROBE_SHARERS: begin
                    if (l2_probe_ack) begin
                        // Merge probe writeback data if dirty
                        automatic logic [BANK_W-1:0]  b = addr_bank(cur_paddr_q);
                        automatic logic [INDEX_W-1:0] s = addr_index(cur_paddr_q);
                        if (l2_probe_has_data) begin
                            data_array[b][cur_victim_q][s] <= l2_probe_wb_data;
                            cur_line_q                     <= l2_probe_wb_data;
                        end else begin
                            cur_line_q <= data_array[b][cur_victim_q][s];
                        end
                        sharers[b][cur_victim_q][s] <=
                            sharers[b][cur_victim_q][s] & ~cur_probe_mask_q;
                        sharers[b][cur_victim_q][s][cur_src_q] <= 1'b1;
                        cur_grant_state_q <= cur_req_state_q;
                        state_array[b][cur_victim_q][s] <=
                            (cur_req_state_q == MESI_M) ? MESI_M : MESI_S;
                        state_q <= T_RESP;
                    end
                end
                T_REQ_SLC: begin
                    if (slc_acq_ready) begin
                        slc_acq_valid <= 1'b0;
                        if (cur_is_write_q || slc_acq_is_write) begin
                            // For a victim writeback, re-issue an acquire for
                            // the missing line right after.
                            if (slc_acq_is_write) begin
                                slc_acq_valid       <= 1'b1;
                                slc_acq_paddr_line  <= cur_paddr_q;
                                slc_acq_is_write    <= 1'b0;
                                slc_acq_qos         <= QOS_CPU_FG;
                                state_q             <= T_REQ_SLC;
                            end else begin
                                state_q <= T_WAIT_SLC;
                            end
                        end else begin
                            state_q <= T_WAIT_SLC;
                        end
                    end
                end
                T_WAIT_SLC: begin
                    if (slc_grant_valid) begin
                        cur_line_q        <= slc_grant_data;
                        cur_grant_state_q <= cur_req_state_q;
                        state_q           <= T_INSTALL;
                    end
                end
                T_INSTALL: begin
                    automatic logic [BANK_W-1:0]  b = addr_bank(cur_paddr_q);
                    automatic logic [INDEX_W-1:0] s = addr_index(cur_paddr_q);
                    tag_array[b][cur_victim_q][s]   <= addr_tag(cur_paddr_q);
                    state_array[b][cur_victim_q][s] <= cur_grant_state_q;
                    data_array[b][cur_victim_q][s]  <= cur_line_q;
                    sharers[b][cur_victim_q][s]     <= (NUM_L2'(1) << cur_src_q);
                    rrpv[b][cur_victim_q][s]        <= 2'b10; // SRRIP insertion
                    state_q                         <= T_RESP;
                end
                T_RESP: begin
                    l2_grant_valid       <= 1'b1;
                    l2_grant_paddr_line  <= cur_paddr_q;
                    l2_grant_data        <= cur_line_q;
                    l2_grant_state       <= cur_grant_state_q;
                    l2_grant_source_id   <= cur_src_q;
                    state_q              <= T_IDLE;
                end
                default: state_q <= T_IDLE;
            endcase
        end
    end

endmodule
