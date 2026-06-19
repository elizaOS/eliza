`timescale 1ns/1ps

// e1_spp_prefetcher
//
// Signature Path Prefetcher (Kim, Pugsley, et al., MICRO'16). L2 prefetcher.
//
// Maintains two tables:
//   - Signature Table (ST): per-page state machine (signature + last offset)
//   - Pattern Table (PT):   per-signature delta histogram
//
// On a demand access:
//   - Compute (page, offset). Look up ST. If miss, allocate.
//   - Compute delta = offset - last_offset.
//   - Update ST entry: signature = (signature << 3) ^ delta.
//   - Look up PT[old_signature]. Pick deltas above a confidence threshold,
//     emit prefetches.
//
// This is a small, synthesizable RTL approximation suitable for a cocotb
// sweep. Full SPP includes lookahead chains; we ship single-level lookahead.

module e1_spp_prefetcher #(
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned LINE_BYTES = 64,
    parameter int unsigned PAGE_BYTES = 4096,
    parameter int unsigned ST_ENTRIES = 32,
    parameter int unsigned PT_ENTRIES = 64,
    parameter int unsigned SIG_W      = 12,
    parameter int unsigned OFFSETS_PER_PAGE = PAGE_BYTES / LINE_BYTES,
    parameter int unsigned CONF_THRESHOLD = 4
) (
    input  logic                   clk,
    input  logic                   rst_n,

    input  logic                   obs_valid,
    input  logic [PADDR_W-1:0]     obs_paddr,

    output logic                   pf_valid,
    input  logic                   pf_ready,
    output logic [PADDR_W-1:0]     pf_paddr_line
);

    localparam int unsigned LINE_OFFSET_W = $clog2(LINE_BYTES);
    localparam int unsigned PAGE_OFFSET_W = $clog2(PAGE_BYTES);
    localparam int unsigned PAGE_LINE_W   = $clog2(OFFSETS_PER_PAGE);
    localparam int unsigned PAGE_TAG_W    = PADDR_W - PAGE_OFFSET_W;
    localparam int unsigned ST_IDX_W      = $clog2(ST_ENTRIES);
    localparam int unsigned PT_IDX_W      = $clog2(PT_ENTRIES);

    typedef struct packed {
        logic                       valid;
        logic [PAGE_TAG_W-1:0]      page_tag;
        logic [SIG_W-1:0]           signature;
        logic [PAGE_LINE_W-1:0]     last_offset;
    } st_entry_t;

    typedef struct packed {
        logic                       valid;
        logic [SIG_W-1:0]           signature;
        logic signed [PAGE_LINE_W:0] delta;
        logic [3:0]                 confidence;
    } pt_entry_t;

    st_entry_t st [ST_ENTRIES];
    pt_entry_t pt [PT_ENTRIES];

    function automatic logic [ST_IDX_W-1:0] st_lookup
        (input logic [PAGE_TAG_W-1:0] tag, output logic found);
        logic [ST_IDX_W-1:0] idx;
        idx = '0;
        found = 1'b0;
        for (int i = 0; i < ST_ENTRIES; i++) begin
            if (st[i].valid && st[i].page_tag == tag) begin
                idx = i[ST_IDX_W-1:0];
                found = 1'b1;
            end
        end
        return idx;
    endfunction

    function automatic logic [ST_IDX_W-1:0] st_alloc();
        logic [ST_IDX_W-1:0] idx;
        idx = '0;
        for (int i = 0; i < ST_ENTRIES; i++)
            if (!st[i].valid) idx = i[ST_IDX_W-1:0];
        return idx;
    endfunction

    function automatic logic [PT_IDX_W-1:0] pt_lookup
        (input logic [SIG_W-1:0] sig,
         input logic signed [PAGE_LINE_W:0] delta,
         output logic found);
        logic [PT_IDX_W-1:0] idx;
        idx = '0;
        found = 1'b0;
        for (int i = 0; i < PT_ENTRIES; i++) begin
            if (pt[i].valid && pt[i].signature == sig && pt[i].delta == delta) begin
                idx = i[PT_IDX_W-1:0];
                found = 1'b1;
            end
        end
        return idx;
    endfunction

    function automatic logic [PT_IDX_W-1:0] pt_alloc();
        logic [PT_IDX_W-1:0] idx;
        idx = '0;
        for (int i = 0; i < PT_ENTRIES; i++)
            if (!pt[i].valid) idx = i[PT_IDX_W-1:0];
        return idx;
    endfunction

    function automatic logic [PT_IDX_W-1:0] pt_best_for_sig
        (input logic [SIG_W-1:0] sig, output logic any_found);
        logic [PT_IDX_W-1:0] idx;
        logic [3:0] best;
        idx = '0;
        best = 4'h0;
        any_found = 1'b0;
        for (int i = 0; i < PT_ENTRIES; i++) begin
            if (pt[i].valid && pt[i].signature == sig &&
                pt[i].confidence > best) begin
                best = pt[i].confidence;
                idx  = i[PT_IDX_W-1:0];
                any_found = 1'b1;
            end
        end
        return idx;
    endfunction

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int i = 0; i < ST_ENTRIES; i++) begin
                st[i] <= '0;
            end
            for (int i = 0; i < PT_ENTRIES; i++) begin
                pt[i] <= '0;
            end
            pf_valid      <= 1'b0;
            pf_paddr_line <= '0;
        end else begin
            if (pf_valid && pf_ready) pf_valid <= 1'b0;

            if (obs_valid) begin
                logic [PAGE_TAG_W-1:0]      page_tag;
                logic [PAGE_LINE_W-1:0]     offset;
                logic                       st_found;
                logic [ST_IDX_W-1:0]        st_idx;
                logic [SIG_W-1:0]           old_sig;
                logic [SIG_W-1:0]           new_sig;
                logic signed [PAGE_LINE_W:0] delta;
                logic                       pt_found;
                logic [PT_IDX_W-1:0]        pt_idx;

                page_tag = obs_paddr[PADDR_W-1:PAGE_OFFSET_W];
                offset   = obs_paddr[PAGE_OFFSET_W-1:LINE_OFFSET_W];
                st_idx   = st_lookup(page_tag, st_found);

                if (!st_found) begin
                    st_idx = st_alloc();
                    st[st_idx].valid       <= 1'b1;
                    st[st_idx].page_tag    <= page_tag;
                    st[st_idx].signature   <= '0;
                    st[st_idx].last_offset <= offset;
                end else begin
                    old_sig = st[st_idx].signature;
                    delta = $signed({1'b0, offset}) - $signed({1'b0, st[st_idx].last_offset});
                    new_sig = (old_sig << 3) ^ SIG_W'(delta);

                    // Update PT
                    pt_idx = pt_lookup(old_sig, delta, pt_found);
                    if (pt_found) begin
                        if (pt[pt_idx].confidence != 4'hF)
                            pt[pt_idx].confidence <= pt[pt_idx].confidence + 1;
                    end else begin
                        pt_idx = pt_alloc();
                        pt[pt_idx].valid      <= 1'b1;
                        pt[pt_idx].signature  <= old_sig;
                        pt[pt_idx].delta      <= delta;
                        pt[pt_idx].confidence <= 4'h1;
                    end
                    st[st_idx].signature   <= new_sig;
                    st[st_idx].last_offset <= offset;

                    // Emit prefetch based on best PT entry for the NEW signature
                    if (!pf_valid) begin
                        logic best_found;
                        logic [PT_IDX_W-1:0] best_idx;
                        best_idx = pt_best_for_sig(new_sig, best_found);
                        if (best_found && pt[best_idx].confidence >= CONF_THRESHOLD[3:0]) begin
                            logic signed [PAGE_LINE_W:0] pf_off;
                            pf_off = $signed({1'b0, offset}) + pt[best_idx].delta;
                            if (pf_off >= 0 && pf_off < (PAGE_LINE_W+1)'(OFFSETS_PER_PAGE)) begin
                                pf_valid      <= 1'b1;
                                pf_paddr_line <= {page_tag,
                                                  pf_off[PAGE_LINE_W-1:0],
                                                  {LINE_OFFSET_W{1'b0}}};
                            end
                        end
                    end
                end
            end
        end
    end

endmodule
