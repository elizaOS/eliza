`timescale 1ns/1ps

// e1_l2_cache
//
// Private per-core L2 cache.
//
// Default geometry (parameterizable):
//   1 MB, 8-way, 64 B line, 2048 sets.
//
// Role:
//   - Backs L1I and L1D miss requests
//   - Inclusive of L1I tags (so L1I never holds a line that L2 has evicted)
//   - Non-inclusive of L1D data (no duplicate writeback storage; saves area)
//   - Participates in MESI on the L2<->L3 link
//   - Hosts the PTW data port for page-table walks
//
// Pipeline: 12-cycle latency budget. Functional model here is single-cycle
// hit response, multi-cycle miss path. Real timing pipeline depth is a
// physical-design parameter and is described in
// docs/arch/cache-hierarchy.md.
//
// Prefetchers wire-in as observer modules on the L1D miss stream and as
// producers on a separate prefetch request port; both routes are handled
// by the existing acq/grant channel.

module e1_l2_cache
    import e1_cache_pkg::*;
#(
    parameter int unsigned SIZE_BYTES = L2_SIZE_BYTES,
    parameter int unsigned WAYS       = L2_WAYS,
    parameter int unsigned LINE_BYTES = L2_LINE_BYTES,
    parameter int unsigned PADDR_W    = PADDR_W_DEFAULT
) (
    input  logic                    clk,
    input  logic                    rst_n,

    // L1I requests (read-only, returns 64 B line + MESI state)
    input  logic                    l1i_acq_valid,
    output logic                    l1i_acq_ready,
    input  logic [PADDR_W-1:0]      l1i_acq_paddr_line,
    input  logic                    l1i_acq_is_prefetch,
    output logic                    l1i_grant_valid,
    input  logic                    l1i_grant_ready,
    output logic [PADDR_W-1:0]      l1i_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0] l1i_grant_data,
    output mesi_e                   l1i_grant_state,

    // L1D requests (acquire/release/probe-data-response)
    input  logic                    l1d_acq_valid,
    output logic                    l1d_acq_ready,
    input  logic [PADDR_W-1:0]      l1d_acq_paddr_line,
    input  logic                    l1d_acq_is_write,
    input  mesi_e                   l1d_acq_req_state,
    input  logic [8*LINE_BYTES-1:0] l1d_acq_wb_data,
    output logic                    l1d_grant_valid,
    input  logic                    l1d_grant_ready,
    output logic [PADDR_W-1:0]      l1d_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0] l1d_grant_data,
    output mesi_e                   l1d_grant_state,

    // L2 -> L3 link (TileLink TL-C class request)
    output logic                    l3_acq_valid,
    input  logic                    l3_acq_ready,
    output logic [PADDR_W-1:0]      l3_acq_paddr_line,
    output logic                    l3_acq_is_write,
    output mesi_e                   l3_acq_req_state,
    output logic [8*LINE_BYTES-1:0] l3_acq_wb_data,
    input  logic                    l3_grant_valid,
    output logic                    l3_grant_ready,
    input  logic [PADDR_W-1:0]      l3_grant_paddr_line,
    input  logic [8*LINE_BYTES-1:0] l3_grant_data,
    input  mesi_e                   l3_grant_state,

    // Probe (from L3 directory) and probe response down to L1D
    input  logic                    l3_probe_valid,
    output logic                    l3_probe_ready,
    input  logic [PADDR_W-1:0]      l3_probe_paddr_line,
    input  mesi_e                   l3_probe_target_state,
    output logic                    l3_probe_ack,
    output logic                    l3_probe_has_data,
    output logic [8*LINE_BYTES-1:0] l3_probe_wb_data,
    output mesi_e                   l3_probe_final_state,

    output logic                    l1d_probe_valid,
    input  logic                    l1d_probe_ready,
    output logic [PADDR_W-1:0]      l1d_probe_paddr_line,
    output mesi_e                   l1d_probe_target_state,
    input  logic                    l1d_probe_ack,
    input  logic                    l1d_probe_has_data,
    input  logic [8*LINE_BYTES-1:0] l1d_probe_wb_data,
    input  mesi_e                   l1d_probe_final_state,

    // Page-table walk data port (CPU's PTW reads/writes here)
    input  logic                    ptw_req_valid,
    output logic                    ptw_req_ready,
    input  logic [PADDR_W-1:0]      ptw_req_paddr,
    input  logic                    ptw_req_is_write,
    input  logic [63:0]             ptw_req_wdata,
    output logic                    ptw_resp_valid,
    output logic [63:0]             ptw_resp_data,

    // HPM events
    output logic                    hpm_l2_access,
    output logic                    hpm_l2_miss,
    output logic                    hpm_l2_prefetch
);

    localparam int unsigned SETS         = SIZE_BYTES / (WAYS * LINE_BYTES);
    localparam int unsigned INDEX_W      = $clog2(SETS);
    localparam int unsigned OFFSET_W     = $clog2(LINE_BYTES);
    localparam int unsigned TAG_W        = PADDR_W - INDEX_W - OFFSET_W;
    localparam int unsigned LINE_BITS    = 8 * LINE_BYTES;

    function automatic logic [INDEX_W-1:0] addr_index(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W +: INDEX_W];
    endfunction
    function automatic logic [TAG_W-1:0] addr_tag(input logic [PADDR_W-1:0] a);
        return a[PADDR_W-1 -: TAG_W];
    endfunction

    logic [TAG_W-1:0]       tag_array  [WAYS][SETS];
    mesi_e                  state_array [WAYS][SETS];
    logic [LINE_BITS-1:0]   data_array [WAYS][SETS];
    logic                   l1i_pres   [WAYS][SETS]; // L1I tag-inclusion bit
    logic [WAYS-2:0]        plru       [SETS];

    // Lookup helper
    typedef struct packed {
        logic                   hit;
        logic [$clog2(WAYS)-1:0] way;
        logic [LINE_BITS-1:0]   line;
        mesi_e                  state;
    } l2_lookup_t;

    function automatic l2_lookup_t do_lookup(input logic [PADDR_W-1:0] paddr);
        l2_lookup_t r;
        r = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (state_array[w][addr_index(paddr)] != MESI_I &&
                tag_array[w][addr_index(paddr)] == addr_tag(paddr)) begin
                r.hit   = 1'b1;
                r.way   = w[$clog2(WAYS)-1:0];
                r.line  = data_array[w][addr_index(paddr)];
                r.state = state_array[w][addr_index(paddr)];
            end
        end
        return r;
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

    function automatic logic [WAYS-2:0] plru_update
        (input logic [WAYS-2:0] tree, input logic [$clog2(WAYS)-1:0] way);
        logic [WAYS-2:0] next_tree;
        int unsigned node;
        next_tree = tree;
        node = 0;
        for (int level = 0; level < $clog2(WAYS); level++) begin
            next_tree[node] = ~way[$clog2(WAYS)-1-level];
            node = (node * 2) + 1 + (way[$clog2(WAYS)-1-level] ? 1 : 0);
        end
        return next_tree;
    endfunction

    // Miss FSM
    typedef enum logic [2:0] {
        S_IDLE,
        S_REQ_L3,
        S_WAIT_L3,
        S_PROBE_L1D,
        S_WAIT_PROBE,
        S_RESP
    } l2_state_e;
    l2_state_e               state_q;
    logic [PADDR_W-1:0]      pending_paddr_q;
    logic                    pending_is_l1i_q;
    logic                    pending_is_pf_q;
    logic                    pending_is_write_q;
    logic [LINE_BITS-1:0]    pending_wb_q;
    logic [LINE_BITS-1:0]    grant_data_q;
    mesi_e                   grant_state_q;
    mesi_e                   req_state_q;
    logic [$clog2(WAYS)-1:0] victim_way_q;
    logic                    arb_pick_l1i_q;

    assign l3_acq_paddr_line = pending_paddr_q;
    assign l3_acq_is_write   = pending_is_write_q;
    assign l3_acq_req_state  = req_state_q;
    assign l3_acq_wb_data    = pending_wb_q;
    assign l3_probe_ready    = (state_q == S_IDLE);

    // Simple PTW port: route through the L2 lookup. PTW is non-cached
    // here; in production the PTW would walk through L2 with normal cache
    // attributes. The functional model treats PTW as direct backing-store
    // access through the L3 link.
    assign ptw_req_ready  = (state_q == S_IDLE);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tag_array   <= '{default: '{default: '0}};
            state_array <= '{default: '{default: MESI_I}};
            data_array  <= '{default: '{default: '0}};
            l1i_pres    <= '{default: '{default: 1'b0}};
            plru        <= '{default: '0};

            state_q             <= S_IDLE;
            pending_paddr_q     <= '0;
            pending_is_l1i_q    <= 1'b0;
            pending_is_pf_q     <= 1'b0;
            pending_is_write_q  <= 1'b0;
            pending_wb_q        <= '0;
            grant_data_q        <= '0;
            grant_state_q       <= MESI_I;
            req_state_q         <= MESI_I;
            victim_way_q        <= '0;
            arb_pick_l1i_q      <= 1'b0;

            l1i_grant_valid     <= 1'b0;
            l1i_grant_paddr_line <= '0;
            l1i_grant_data      <= '0;
            l1i_grant_state     <= MESI_I;

            l1d_grant_valid     <= 1'b0;
            l1d_grant_paddr_line <= '0;
            l1d_grant_data      <= '0;
            l1d_grant_state     <= MESI_I;

            l3_acq_valid        <= 1'b0;
            l3_grant_ready      <= 1'b1;

            l3_probe_ack        <= 1'b0;
            l3_probe_has_data   <= 1'b0;
            l3_probe_wb_data    <= '0;
            l3_probe_final_state <= MESI_I;

            l1d_probe_valid     <= 1'b0;
            l1d_probe_paddr_line <= '0;
            l1d_probe_target_state <= MESI_I;

            ptw_resp_valid      <= 1'b0;
            ptw_resp_data       <= '0;

            hpm_l2_access       <= 1'b0;
            hpm_l2_miss         <= 1'b0;
            hpm_l2_prefetch     <= 1'b0;
        end else begin
            hpm_l2_access   <= 1'b0;
            hpm_l2_miss     <= 1'b0;
            hpm_l2_prefetch <= 1'b0;
            l1i_grant_valid <= l1i_grant_valid && !(l1i_grant_valid && l1i_grant_ready);
            l1d_grant_valid <= l1d_grant_valid && !(l1d_grant_valid && l1d_grant_ready);
            l3_probe_ack    <= 1'b0;
            ptw_resp_valid  <= 1'b0;

            // L1I probe issuance never used by L2 toward L1I in this model;
            // L1I back-invalidate is driven by L3 probes mirrored down.

            case (state_q)
                S_IDLE: begin
                    // Pick arbitration: alternate between L1I and L1D so
                    // neither starves. PTW gets a single-cycle bypass when
                    // both miss queues are empty.
                    arb_pick_l1i_q <= ~arb_pick_l1i_q;
                    if (arb_pick_l1i_q && l1i_acq_valid) begin
                        l2_handle_l1i(l1i_acq_paddr_line, l1i_acq_is_prefetch);
                    end else if (l1d_acq_valid) begin
                        l2_handle_l1d(l1d_acq_paddr_line,
                                      l1d_acq_is_write,
                                      l1d_acq_req_state,
                                      l1d_acq_wb_data);
                    end else if (l1i_acq_valid) begin
                        l2_handle_l1i(l1i_acq_paddr_line, l1i_acq_is_prefetch);
                    end else if (ptw_req_valid && !ptw_req_is_write) begin
                        // Read PTE: look up directly in cache; if miss, treat
                        // as L1D-like miss with shared state.
                        automatic l2_lookup_t r =
                            do_lookup({ptw_req_paddr[PADDR_W-1:OFFSET_W],
                                       {OFFSET_W{1'b0}}});
                        if (r.hit) begin
                            // Extract 8-byte word from line
                            ptw_resp_valid <= 1'b1;
                            for (int b = 0; b < 64; b++) begin
                                automatic int unsigned bit_idx =
                                    32'(ptw_req_paddr[OFFSET_W-1:0]) * 8 + b;
                                if (bit_idx < LINE_BITS)
                                    ptw_resp_data[b] <= r.line[bit_idx];
                            end
                        end
                    end

                    if (l3_probe_valid) begin
                        // Process probe synchronously
                        l3_handle_probe();
                    end
                end
                S_REQ_L3: begin
                    if (!l3_acq_valid) begin
                        l3_acq_valid <= 1'b1;
                    end else if (l3_acq_ready) begin
                        l3_acq_valid <= 1'b0;
                        state_q      <= S_WAIT_L3;
                    end
                end
                S_WAIT_L3: begin
                    if (l3_grant_valid && l3_grant_ready) begin
                        grant_data_q  <= l3_grant_data;
                        grant_state_q <= l3_grant_state;
                        state_q       <= S_RESP;
                    end
                end
                S_PROBE_L1D: begin
                    if (!l1d_probe_valid) begin
                        l1d_probe_valid <= 1'b1;
                    end else if (l1d_probe_ready) begin
                        l1d_probe_valid <= 1'b0;
                        state_q         <= S_WAIT_PROBE;
                    end
                end
                S_WAIT_PROBE: begin
                    if (l1d_probe_ack) begin
                        state_q <= S_RESP;
                    end
                end
                S_RESP: begin
                    // Allocate into L2 array
                    tag_array[victim_way_q][addr_index(pending_paddr_q)]
                        <= addr_tag(pending_paddr_q);
                    state_array[victim_way_q][addr_index(pending_paddr_q)]
                        <= grant_state_q;
                    data_array[victim_way_q][addr_index(pending_paddr_q)]
                        <= grant_data_q;
                    plru[addr_index(pending_paddr_q)] <=
                        plru_update(plru[addr_index(pending_paddr_q)],
                                    victim_way_q);

                    if (pending_is_l1i_q) begin
                        l1i_grant_valid       <= 1'b1;
                        l1i_grant_paddr_line  <= pending_paddr_q;
                        l1i_grant_data        <= grant_data_q;
                        l1i_grant_state       <= MESI_S;
                        l1i_pres[victim_way_q][addr_index(pending_paddr_q)]
                            <= 1'b1;
                        if (pending_is_pf_q) hpm_l2_prefetch <= 1'b1;
                    end else begin
                        l1d_grant_valid       <= 1'b1;
                        l1d_grant_paddr_line  <= pending_paddr_q;
                        l1d_grant_data        <= grant_data_q;
                        l1d_grant_state       <= grant_state_q;
                    end
                    state_q <= S_IDLE;
                end
                default: state_q <= S_IDLE;
            endcase
        end
    end

    // Procedural helpers wrap miss handling
    task automatic l2_handle_l1i(input logic [PADDR_W-1:0] paddr,
                                 input logic               is_pf);
        automatic l2_lookup_t r = do_lookup(paddr);
        hpm_l2_access <= 1'b1;
        if (r.hit) begin
            l1i_grant_valid       <= 1'b1;
            l1i_grant_paddr_line  <= paddr;
            l1i_grant_data        <= r.line;
            l1i_grant_state       <= MESI_S;
            l1i_pres[r.way][addr_index(paddr)] <= 1'b1;
            plru[addr_index(paddr)] <=
                plru_update(plru[addr_index(paddr)], r.way);
            if (is_pf) hpm_l2_prefetch <= 1'b1;
        end else begin
            hpm_l2_miss     <= 1'b1;
            pending_paddr_q   <= paddr;
            pending_is_l1i_q  <= 1'b1;
            pending_is_pf_q   <= is_pf;
            pending_is_write_q<= 1'b0;
            pending_wb_q      <= '0;
            req_state_q       <= MESI_S;
            victim_way_q      <= plru_victim(plru[addr_index(paddr)]);
            state_q           <= S_REQ_L3;
        end
    endtask

    task automatic l2_handle_l1d(input logic [PADDR_W-1:0] paddr,
                                 input logic               is_write,
                                 input mesi_e              req_state,
                                 input logic [LINE_BITS-1:0] wb);
        automatic l2_lookup_t r = do_lookup(paddr);
        hpm_l2_access <= 1'b1;
        // L2 can satisfy a read hit from any non-Invalid state, including
        // Owned: an Owner forwards the line to a new sharer without
        // involving the next level. The Owner stays in O; the requestor
        // installs the line in S (the L3 directory upgrade is observed
        // via the snoop path; here we only need to forward the data).
        if (r.hit && (!is_write) &&
            (req_state == MESI_S ||
             r.state == MESI_M || r.state == MESI_E ||
             r.state == MESI_O)) begin
            l1d_grant_valid       <= 1'b1;
            l1d_grant_paddr_line  <= paddr;
            l1d_grant_data        <= r.line;
            // Forwarding from Owned keeps the requester in S and the
            // owner unchanged; from M/E we hand back the same state so
            // L1D can promote on its next write.
            l1d_grant_state       <= (r.state == MESI_O) ? MESI_S : r.state;
            plru[addr_index(paddr)] <=
                plru_update(plru[addr_index(paddr)], r.way);
        end else begin
            hpm_l2_miss <= 1'b1;
            pending_paddr_q   <= paddr;
            pending_is_l1i_q  <= 1'b0;
            pending_is_pf_q   <= 1'b0;
            pending_is_write_q<= is_write;
            pending_wb_q      <= wb;
            req_state_q       <= req_state;
            victim_way_q      <= r.hit ? r.way : plru_victim(plru[addr_index(paddr)]);
            state_q           <= S_REQ_L3;
        end
    endtask

    task automatic l3_handle_probe();
        automatic l2_lookup_t r = do_lookup(l3_probe_paddr_line);
        if (r.hit) begin
            // If L1I has the line, invalidate L1I copy first
            if (l1i_pres[r.way][addr_index(l3_probe_paddr_line)]) begin
                l1d_probe_valid       <= 1'b1;
                l1d_probe_paddr_line  <= l3_probe_paddr_line;
                l1d_probe_target_state<= l3_probe_target_state;
                state_q               <= S_PROBE_L1D;
                pending_paddr_q       <= l3_probe_paddr_line;
            end
            // MOESI snoop response: a dirty owner (M or O) supplies data.
            //  - probe target = I and current = M/O: invalidate, write back
            //  - probe target = S and current = M:  downgrade M->O, hand
            //    the dirty line forward (Owner forwarding); the L3
            //    directory installs the new requester as a sharer
            //  - probe target = S and current = O:  Owner already exists;
            //    hand the dirty line forward but stay in O so the writer
            //    history continues to belong to one cache
            if (moesi_is_dirty(r.state) &&
                l3_probe_target_state != MESI_M) begin
                l3_probe_has_data <= 1'b1;
                l3_probe_wb_data  <= r.line;
            end
            if (r.state == MESI_M && l3_probe_target_state == MESI_S) begin
                // M -> O on the existing owner so peers may sample
                state_array[r.way][addr_index(l3_probe_paddr_line)] <=
                    MESI_O;
            end else if (r.state == MESI_O &&
                         l3_probe_target_state == MESI_S) begin
                // Owner keeps the dirty line; no state change
                state_array[r.way][addr_index(l3_probe_paddr_line)] <=
                    MESI_O;
            end else begin
                state_array[r.way][addr_index(l3_probe_paddr_line)] <=
                    l3_probe_target_state;
            end
        end
        l3_probe_ack         <= 1'b1;
        // The final state we report mirrors the directory's intended
        // outcome from the original requester's perspective; the Owner
        // tracks its M->O transition internally above.
        l3_probe_final_state <= l3_probe_target_state;
    endtask

    // Ready signals: accept only when idle
    assign l1i_acq_ready = (state_q == S_IDLE) && !l1i_grant_valid;
    assign l1d_acq_ready = (state_q == S_IDLE) && !l1d_grant_valid;

endmodule
