`timescale 1ns/1ps

// e1_plic — RISC-V Platform-Level Interrupt Controller (production).
//
// Implements the RISC-V PLIC spec (v1.0.0) memory map and claim/complete
// semantics required to route device external interrupts to the harts under
// Linux/AOSP. Compatible with the riscv,plic0 / sifive,plic-1.0.0 device-tree
// binding (32-bit AXI-Lite slave, byte-addressed within the 64 MiB PLIC
// window, e.g. base 0x0C00_0000).
//
// Sources are 1..NUM_SOURCES (source 0 is the spec-reserved "no interrupt").
// Contexts are 0..NUM_CONTEXTS-1; a context is a (hart, privilege) target,
// e.g. context 0 = hart0 M-mode, context 1 = hart0 S-mode.
//
// Memory map (RISC-V PLIC spec):
//   +0x000000 + 4*src                    : priority[src]   RW32 (0..7)
//   +0x001000 + 4*(src/32)               : pending[block]  RO32 (gateway pending)
//   +0x002000 + 0x80*ctx + 4*(src/32)    : enable[ctx]     RW32 bitfield
//   +0x200000 + 0x1000*ctx + 0x0         : threshold[ctx]  RW32 (0..7)
//   +0x200000 + 0x1000*ctx + 0x4         : claim/complete  R=claim, W=complete
//
// Gateway semantics (level-triggered, v1): a source's pending bit is set while
// the source line is asserted AND the source is not currently "in service"
// (claimed-but-not-completed) for any context. A read of claim/complete returns
// the highest-priority enabled pending source whose priority strictly exceeds
// the context threshold (ties broken by lowest source id, per spec), and marks
// it in service (clears its visible pending). A write of that id to
// claim/complete signals completion, re-arming the gateway.
//
// Outputs: irq_o[ctx] is the external-interrupt line for that context (drives
// mip.MEIP / mip.SEIP). It is asserted while a claimable interrupt exists for
// the context (best pending enabled source with priority > threshold).

module e1_plic #(
    parameter int unsigned NUM_SOURCES  = 4,   // sources 1..NUM_SOURCES
    parameter int unsigned NUM_CONTEXTS = 1
) (
    input  logic        clk,
    input  logic        rst_n,

    // Level-sensitive interrupt source lines; index 0 == source id 1.
    input  logic [NUM_SOURCES-1:0] irq_sources,

    // Per-context external interrupt request (drive mip.MEIP / mip.SEIP).
    output logic [NUM_CONTEXTS-1:0] irq_o,

    // 32-bit AXI-Lite slave (byte-addressed within the PLIC window).
    input  logic        s_axil_awvalid,
    output logic        s_axil_awready,
    input  logic [31:0] s_axil_awaddr,
    input  logic        s_axil_wvalid,
    output logic        s_axil_wready,
    input  logic [31:0] s_axil_wdata,
    input  logic [3:0]  s_axil_wstrb,
    output logic        s_axil_bvalid,
    input  logic        s_axil_bready,
    output logic [1:0]  s_axil_bresp,

    input  logic        s_axil_arvalid,
    output logic        s_axil_arready,
    input  logic [31:0] s_axil_araddr,
    output logic        s_axil_rvalid,
    input  logic        s_axil_rready,
    output logic [31:0] s_axil_rdata,
    output logic [1:0]  s_axil_rresp
);
    localparam int unsigned PRIO_W = 3; // priority/threshold range 0..7

    // Region bases (byte offsets within the PLIC window), 32-bit for arithmetic.
    localparam logic [31:0] PENDING_BASE  = 32'h0000_1000;
    localparam logic [31:0] ENABLE_BASE   = 32'h0000_2000;
    localparam logic [31:0] CTX_BASE      = 32'h0020_0000;
    localparam logic [31:0] ENABLE_STRIDE = 32'h0000_0080;  // per context
    localparam logic [31:0] CTX_STRIDE    = 32'h0000_1000;  // per context

    // --- State -------------------------------------------------------------
    logic [PRIO_W-1:0]      priority_q [NUM_SOURCES+1];           // [0] reserved, tied 0
    logic [NUM_SOURCES:0]   enable_q   [NUM_CONTEXTS];            // bit s = source s
    logic [PRIO_W-1:0]      threshold_q[NUM_CONTEXTS];
    logic [NUM_SOURCES:0]   in_service;                          // global "claimed, not completed"

    // Gateway pending: source is pending while its line is high and it is not
    // currently in service. Level-triggered, so we don't latch a separate
    // pending register — the line + in_service mask is the pending state.
    logic [NUM_SOURCES:0]   src_level;
    always_comb begin
        src_level = '0;
        for (int unsigned s = 1; s <= NUM_SOURCES; s++)
            src_level[s] = irq_sources[s-1];
    end
    wire [NUM_SOURCES:0] gw_pending = src_level & ~in_service;

    // --- Per-context arbitration: best claimable source --------------------
    // best_src[ctx] = highest-priority enabled gateway-pending source whose
    // priority strictly exceeds the context threshold; ties -> lowest id.
    logic [31:0]        best_src  [NUM_CONTEXTS];
    logic [PRIO_W-1:0]  best_prio [NUM_CONTEXTS];
    always_comb begin
        for (int unsigned c = 0; c < NUM_CONTEXTS; c++) begin
            best_src[c]  = 32'h0;
            best_prio[c] = '0;
            // Iterate low->high id and overwrite only on strictly-greater
            // priority, so the highest-priority source wins and ties resolve to
            // the lowest source id (per the RISC-V PLIC spec).
            for (int unsigned s = 1; s <= NUM_SOURCES; s++) begin
                if (gw_pending[s] && enable_q[c][s] &&
                    (priority_q[s] > threshold_q[c]) &&
                    (priority_q[s] > best_prio[c])) begin
                    best_prio[c] = priority_q[s];
                    best_src[c]  = s;
                end
            end
        end
    end

    always_comb begin
        for (int unsigned c = 0; c < NUM_CONTEXTS; c++)
            irq_o[c] = (best_src[c] != 32'h0);
    end

    // --- AXI-Lite handshake (single outstanding) ---------------------------
    logic        write_addr_valid;
    logic        write_data_valid;
    logic [25:0] write_addr_q;
    logic [31:0] write_data_q;

    wire write_accept = write_addr_valid && write_data_valid && !s_axil_bvalid;
    wire read_accept  = s_axil_arvalid && s_axil_arready;

    assign s_axil_awready = !write_addr_valid && !s_axil_bvalid;
    assign s_axil_wready  = !write_data_valid && !s_axil_bvalid;
    assign s_axil_arready = !s_axil_rvalid;

    wire [31:0] wr_off = {6'h0, write_addr_q};
    wire [31:0] rd_off = {6'h0, s_axil_araddr[25:0]};

    // Decode helpers (all arithmetic in 32-bit byte-offset space).
    function automatic int unsigned prio_src(input logic [31:0] off);
        prio_src = int'(off >> 2); // priority region byte offset / 4 == source id
    endfunction
    function automatic int unsigned ctx_of(input logic [31:0] off);
        ctx_of = int'((off - CTX_BASE) / CTX_STRIDE);
    endfunction
    function automatic logic ctx_is_claim(input logic [31:0] off);
        ctx_is_claim = (((off - CTX_BASE) % CTX_STRIDE) == 32'h4);
    endfunction
    function automatic logic ctx_is_thresh(input logic [31:0] off);
        ctx_is_thresh = (((off - CTX_BASE) % CTX_STRIDE) == 32'h0);
    endfunction
    function automatic int unsigned en_ctx(input logic [31:0] off);
        en_ctx = int'((off - ENABLE_BASE) / ENABLE_STRIDE);
    endfunction

    wire wr_is_prio   = (wr_off < PENDING_BASE) &&
                        (prio_src(wr_off) >= 1) && (prio_src(wr_off) <= NUM_SOURCES);
    wire wr_is_enable = (wr_off >= ENABLE_BASE) && (wr_off < CTX_BASE) &&
                        (en_ctx(wr_off) < NUM_CONTEXTS) &&
                        (((wr_off - ENABLE_BASE) % ENABLE_STRIDE) == 32'h0);
    wire wr_is_ctx    = (wr_off >= CTX_BASE) && (ctx_of(wr_off) < NUM_CONTEXTS);

    // --- Read data mux -----------------------------------------------------
    logic [31:0] rdata_next;
    logic        rd_is_claim;   // a claim read consumes the interrupt
    logic [31:0] rd_claim_src;
    always_comb begin
        rdata_next   = 32'h0;
        rd_is_claim  = 1'b0;
        rd_claim_src = 32'h0;
        if ((rd_off < PENDING_BASE) &&
            (prio_src(rd_off) >= 1) && (prio_src(rd_off) <= NUM_SOURCES)) begin
            rdata_next = {{(32-PRIO_W){1'b0}}, priority_q[prio_src(rd_off)]};
        end else if ((rd_off >= PENDING_BASE) && (rd_off < ENABLE_BASE)) begin
            // pending block 0 holds sources 1..31 in bits 1..31.
            for (int unsigned s = 1; s <= NUM_SOURCES; s++)
                rdata_next[s] = gw_pending[s];
        end else if ((rd_off >= ENABLE_BASE) && (rd_off < CTX_BASE) &&
                     (en_ctx(rd_off) < NUM_CONTEXTS) &&
                     (((rd_off - ENABLE_BASE) % ENABLE_STRIDE) == 32'h0)) begin
            for (int unsigned s = 1; s <= NUM_SOURCES; s++)
                rdata_next[s] = enable_q[en_ctx(rd_off)][s];
        end else if ((rd_off >= CTX_BASE) && (ctx_of(rd_off) < NUM_CONTEXTS)) begin
            if (ctx_is_thresh(rd_off)) begin
                rdata_next = {{(32-PRIO_W){1'b0}}, threshold_q[ctx_of(rd_off)]};
            end else if (ctx_is_claim(rd_off)) begin
                rdata_next   = best_src[ctx_of(rd_off)];
                rd_is_claim  = (best_src[ctx_of(rd_off)] != 32'h0);
                rd_claim_src = best_src[ctx_of(rd_off)];
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned s = 0; s <= NUM_SOURCES; s++) priority_q[s] <= '0;
            for (int unsigned c = 0; c < NUM_CONTEXTS; c++) begin
                enable_q[c]    <= '0;
                threshold_q[c] <= '0;
            end
            in_service       <= '0;
            write_addr_valid <= 1'b0;
            write_data_valid <= 1'b0;
            write_addr_q     <= 26'h0;
            write_data_q     <= 32'h0;
            s_axil_bvalid    <= 1'b0;
            s_axil_bresp     <= 2'b00;
            s_axil_rvalid    <= 1'b0;
            s_axil_rdata     <= 32'h0;
            s_axil_rresp     <= 2'b00;
        end else begin
            priority_q[0] <= '0; // source 0 priority is read-only zero

            if (s_axil_bvalid && s_axil_bready) s_axil_bvalid <= 1'b0;
            if (s_axil_rvalid && s_axil_rready) s_axil_rvalid <= 1'b0;

            if (s_axil_awready && s_axil_awvalid) begin
                write_addr_valid <= 1'b1;
                write_addr_q     <= s_axil_awaddr[25:0];
            end
            if (s_axil_wready && s_axil_wvalid) begin
                write_data_valid <= 1'b1;
                write_data_q     <= s_axil_wdata;
            end

            // --- Claim (read of claim/complete) marks source in service ----
            if (read_accept && rd_is_claim) begin
                in_service[rd_claim_src[$clog2(NUM_SOURCES+1)-1:0]] <= 1'b1;
            end

            // --- Writes ----------------------------------------------------
            if (write_accept) begin
                if (wr_is_prio) begin
                    priority_q[prio_src(wr_off)] <= write_data_q[PRIO_W-1:0];
                end else if (wr_is_enable) begin
                    // bit per source; source 0 enable is ignored.
                    for (int unsigned s = 1; s <= NUM_SOURCES; s++)
                        enable_q[en_ctx(wr_off)][s] <= write_data_q[s];
                end else if (wr_is_ctx) begin
                    if (ctx_is_thresh(wr_off)) begin
                        threshold_q[ctx_of(wr_off)] <= write_data_q[PRIO_W-1:0];
                    end else if (ctx_is_claim(wr_off)) begin
                        // Completion: clear in_service for the written source so
                        // the gateway re-arms (if the line is still high it can
                        // become pending again next cycle).
                        for (int unsigned s = 1; s <= NUM_SOURCES; s++)
                            if (write_data_q == s) in_service[s] <= 1'b0;
                    end
                end
                s_axil_bvalid    <= 1'b1;
                s_axil_bresp     <= 2'b00;
                write_addr_valid <= 1'b0;
                write_data_valid <= 1'b0;
            end

            if (read_accept) begin
                s_axil_rdata  <= rdata_next;
                s_axil_rvalid <= 1'b1;
                s_axil_rresp  <= 2'b00;
            end
        end
    end

    // Unused upper address bits / strobes.
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign unused = ^{s_axil_awaddr[31:26], s_axil_araddr[31:26], s_axil_wstrb,
                      write_data_q[31:PRIO_W], wr_off[31:26], rd_off[31:26],
                      rd_claim_src[31:1]};

endmodule : e1_plic
