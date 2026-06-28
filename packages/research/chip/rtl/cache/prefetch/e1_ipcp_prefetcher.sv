`timescale 1ns/1ps

// e1_ipcp_prefetcher
//
// Instruction Pointer Classifier Prefetcher (Pakalapati & Panda, ISCA'20).
//
// Classifies each PC into one of three behaviors:
//   CS  : Constant-Stride
//   CPLX: Complex-Stride (different stride per consecutive access)
//   NL  : Next-Line (default fallback)
//
// Streamlined synthesizable approximation: each PC is tracked with last
// addr, last stride, and a classifier confidence. Emits +stride prefetch
// when in CS state, +1 line in NL, alternates strides in CPLX.

module e1_ipcp_prefetcher #(
    parameter int unsigned PC_W       = 64,
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned LINE_BYTES = 64,
    parameter int unsigned ENTRIES    = 16
) (
    input  logic               clk,
    input  logic               rst_n,

    input  logic               obs_valid,
    input  logic [PC_W-1:0]    obs_pc,
    input  logic [PADDR_W-1:0] obs_paddr,

    output logic               pf_valid,
    input  logic               pf_ready,
    output logic [PADDR_W-1:0] pf_paddr_line
);

    localparam int unsigned OFFSET_W = $clog2(LINE_BYTES);
    localparam int unsigned LINE_ADDR_W = PADDR_W - OFFSET_W;
    localparam int unsigned IDX_W = $clog2(ENTRIES);
    localparam int signed   STRIDE_W = 16;

    typedef enum logic [1:0] { CLS_NL, CLS_CS, CLS_CPLX } cls_e;

    typedef struct packed {
        logic                       valid;
        logic [PC_W-1:0]            pc;
        logic [LINE_ADDR_W-1:0]     last_line;
        logic signed [STRIDE_W-1:0] last_stride;
        logic signed [STRIDE_W-1:0] alt_stride;
        cls_e                       cls;
        logic [3:0]                 conf;
    } ipcp_entry_t;

    ipcp_entry_t tbl [ENTRIES];

    function automatic logic [IDX_W-1:0] lookup_pc
        (input logic [PC_W-1:0] pc, output logic found);
        logic [IDX_W-1:0] idx;
        idx = '0;
        found = 1'b0;
        for (int i = 0; i < ENTRIES; i++) begin
            if (tbl[i].valid && tbl[i].pc == pc) begin
                idx = i[IDX_W-1:0];
                found = 1'b1;
            end
        end
        return idx;
    endfunction

    function automatic logic [IDX_W-1:0] alloc_slot();
        logic [IDX_W-1:0] idx;
        idx = '0;
        for (int i = 0; i < ENTRIES; i++)
            if (!tbl[i].valid) idx = i[IDX_W-1:0];
        return idx;
    endfunction

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int i = 0; i < ENTRIES; i++) begin
                tbl[i] <= '0;
                tbl[i].cls <= CLS_NL;
            end
            pf_valid      <= 1'b0;
            pf_paddr_line <= '0;
        end else begin
            if (pf_valid && pf_ready) pf_valid <= 1'b0;

            if (obs_valid) begin
                logic found;
                logic [IDX_W-1:0] idx;
                logic [LINE_ADDR_W-1:0] new_line;
                logic signed [STRIDE_W-1:0] delta;
                new_line = obs_paddr[PADDR_W-1:OFFSET_W];
                idx = lookup_pc(obs_pc, found);
                if (!found) begin
                    idx = alloc_slot();
                    tbl[idx].valid       <= 1'b1;
                    tbl[idx].pc          <= obs_pc;
                    tbl[idx].last_line   <= new_line;
                    tbl[idx].last_stride <= '0;
                    tbl[idx].alt_stride  <= '0;
                    tbl[idx].cls         <= CLS_NL;
                    tbl[idx].conf        <= 4'h0;
                end else begin
                    delta = $signed(new_line) - $signed(tbl[idx].last_line);
                    if (delta == tbl[idx].last_stride && delta != 0) begin
                        tbl[idx].cls  <= CLS_CS;
                        if (tbl[idx].conf != 4'hF)
                            tbl[idx].conf <= tbl[idx].conf + 1;
                    end else if (delta == tbl[idx].alt_stride && delta != 0) begin
                        tbl[idx].cls <= CLS_CPLX;
                    end else begin
                        if (tbl[idx].cls == CLS_CS && tbl[idx].conf > 0)
                            tbl[idx].conf <= tbl[idx].conf - 1;
                        else
                            tbl[idx].cls <= CLS_NL;
                        tbl[idx].alt_stride <= tbl[idx].last_stride;
                    end
                    tbl[idx].last_stride <= delta;
                    tbl[idx].last_line   <= new_line;

                    if (!pf_valid) begin
                        case (tbl[idx].cls)
                            CLS_CS: begin
                                if (tbl[idx].conf >= 4'd2) begin
                                    pf_valid      <= 1'b1;
                                    pf_paddr_line <= {(new_line + delta),
                                                      {OFFSET_W{1'b0}}};
                                end
                            end
                            CLS_NL: begin
                                pf_valid      <= 1'b1;
                                pf_paddr_line <= {(new_line + LINE_ADDR_W'(1)),
                                                  {OFFSET_W{1'b0}}};
                            end
                            CLS_CPLX: begin
                                pf_valid      <= 1'b1;
                                pf_paddr_line <= {(new_line + tbl[idx].alt_stride),
                                                  {OFFSET_W{1'b0}}};
                            end
                            default: ;
                        endcase
                    end
                end
            end
        end
    end

endmodule
