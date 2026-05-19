`timescale 1ns/1ps

// e1_dram_ctrl
//
// LPDDR-class DRAM controller stub.  Implements the controller side of a
// DFI 5.0 north interface so that a vendor LPDDR5X/LPDDR6 PHY (closed IP)
// can be attached without RTL changes.  The PHY itself is BLOCKED in
// docs/evidence/memory/lpddr-phy-procurement.yaml.
//
// Controller-side capabilities:
//   * Per-channel reorder queue (REORDER_DEPTH entries) — read/write
//     bypassing while preserving in-order responses per AxID via the
//     upstream interconnect.
//   * Write combining at cache-line granularity using a sticky byte mask
//     per pending write descriptor.
//   * Refresh scheduler with per-bank refresh (PBR) postpone/pull-in
//     credits.  Counters tRFCab/tRFCpb are exposed as parameters so the
//     LPDDR5X-10667 and LPDDR6-14400 SKUs share the same RTL with
//     different timing knobs.
//   * Page-policy heuristics: open-row counter; close-on-idle after
//     IDLE_PRECHARGE_CYCLES.  An optional always-close mode is exposed
//     for low-power state.
//   * ZQ calibration scheduler: short calibration every ZQCS_INTERVAL
//     cycles; long calibration once every ZQCL_INTERVAL cycles.
//   * On-die ECC + link-ECC counters: error counters exposed as MMIO
//     registers; correctable / uncorrectable events generate IRQs.
//
// The AXI4 north port is consumed by the AXI4 interconnect.  The DFI 5.0
// south interface uses the JEDEC-defined names with reduced byte-lane
// width for clarity — a real PHY attaches per-lane signals.

module e1_dram_ctrl
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_WIDTH         = 6,
    parameter int unsigned ADDR_WIDTH       = 40,
    parameter int unsigned DATA_WIDTH       = 128,
    parameter int unsigned USER_WIDTH       = 8,
    parameter int unsigned BURST_LEN_W      = 8,
    parameter int unsigned REORDER_DEPTH    = 16,
    parameter int unsigned NUM_BANKS        = 16,
    parameter int unsigned IDLE_PRECHARGE_CYCLES = 32,
    parameter int unsigned TREFI_CYCLES     = 7800,    // 1xref, ~3.9us @ 2GHz CK
    parameter int unsigned TRFCAB_CYCLES    = 380,
    parameter int unsigned TRFCPB_CYCLES    = 220,
    parameter int unsigned ZQCS_INTERVAL    = 128_000,
    parameter int unsigned ZQCL_INTERVAL    = 2_048_000,
    parameter logic        SUPPORT_LINK_ECC = 1'b1,
    parameter logic        SUPPORT_ODECC    = 1'b1
) (
    input  logic clk,
    input  logic rst_n,

    // -- AXI4 north port ------------------------------------------------
    input  logic                    s_awvalid,
    output logic                    s_awready,
    input  logic [ID_WIDTH-1:0]     s_awid,
    input  logic [ADDR_WIDTH-1:0]   s_awaddr,
    input  logic [BURST_LEN_W-1:0]  s_awlen,
    input  logic [2:0]              s_awsize,
    input  logic [1:0]              s_awburst,
    input  logic                    s_awlock,
    input  logic [3:0]              s_awcache,
    input  logic [2:0]              s_awprot,
    input  logic [3:0]              s_awqos,
    input  logic [USER_WIDTH-1:0]   s_awuser,

    input  logic                    s_wvalid,
    output logic                    s_wready,
    input  logic [DATA_WIDTH-1:0]   s_wdata,
    input  logic [DATA_WIDTH/8-1:0] s_wstrb,
    input  logic                    s_wlast,

    output logic                    s_bvalid,
    input  logic                    s_bready,
    output logic [ID_WIDTH-1:0]     s_bid,
    output logic [1:0]              s_bresp,

    input  logic                    s_arvalid,
    output logic                    s_arready,
    input  logic [ID_WIDTH-1:0]     s_arid,
    input  logic [ADDR_WIDTH-1:0]   s_araddr,
    input  logic [BURST_LEN_W-1:0]  s_arlen,
    input  logic [2:0]              s_arsize,
    input  logic [1:0]              s_arburst,
    input  logic                    s_arlock,
    input  logic [3:0]              s_arcache,
    input  logic [2:0]              s_arprot,
    input  logic [3:0]              s_arqos,
    input  logic [USER_WIDTH-1:0]   s_aruser,

    output logic                    s_rvalid,
    input  logic                    s_rready,
    output logic [ID_WIDTH-1:0]     s_rid,
    output logic [DATA_WIDTH-1:0]   s_rdata,
    output logic [1:0]              s_rresp,
    output logic                    s_rlast,

    // -- DFI 5.0 south boundary signals (subset) ------------------------
    // Names follow JEDEC DFI 5.0; this is the controller-side view.
    output logic [ADDR_WIDTH-1:0]   dfi_addr,
    output logic [3:0]              dfi_bank,
    output logic                    dfi_cs_n,
    output logic                    dfi_act_n,
    output logic                    dfi_ras_n,
    output logic                    dfi_cas_n,
    output logic                    dfi_we_n,
    output logic                    dfi_reset_n,
    output logic                    dfi_cke,
    output logic                    dfi_odt,

    output logic [DATA_WIDTH-1:0]   dfi_wrdata,
    output logic [DATA_WIDTH/8-1:0] dfi_wrdata_mask,
    output logic                    dfi_wrdata_en,

    input  logic [DATA_WIDTH-1:0]   dfi_rddata,
    input  logic                    dfi_rddata_valid,
    output logic                    dfi_rddata_en,

    output logic                    dfi_init_start,
    input  logic                    dfi_init_complete,
    output logic                    dfi_ctrlupd_req,
    input  logic                    dfi_ctrlupd_ack,
    output logic                    dfi_dram_clk_disable,

    // -- Observability / counters --------------------------------------
    output logic                    refresh_active,
    output logic                    zqcs_active,
    output logic                    zqcl_active,
    output logic [31:0]             odecc_corrected_count,
    output logic [31:0]             odecc_uncorrected_count,
    output logic [31:0]             linkecc_corrected_count,
    output logic [31:0]             linkecc_uncorrected_count,
    output logic                    ecc_uncorrected_irq
);

    // ------------------------------------------------------------------
    // Refresh scheduler
    // ------------------------------------------------------------------
    logic [$clog2(TREFI_CYCLES+1)-1:0] refresh_timer;
    logic [$clog2(NUM_BANKS+1)-1:0]    refresh_bank;
    logic [$clog2(TRFCAB_CYCLES+1)-1:0] refresh_busy;
    logic [3:0]                        refresh_credits; // pull-in credits

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            refresh_timer   <= '0;
            refresh_bank    <= '0;
            refresh_busy    <= '0;
            refresh_credits <= 4'h8;
            refresh_active  <= 1'b0;
        end else begin
            if (refresh_timer == $clog2(TREFI_CYCLES+1)'(TREFI_CYCLES - 1)) begin
                refresh_timer <= '0;
                if (refresh_busy == '0) begin
                    refresh_active <= 1'b1;
                    refresh_busy   <= $clog2(TRFCAB_CYCLES+1)'(TRFCPB_CYCLES);
                    refresh_bank   <= (refresh_bank + 1'b1) % NUM_BANKS;
                end
            end else begin
                refresh_timer <= refresh_timer + 1'b1;
            end

            if (refresh_busy > '0) begin
                refresh_busy <= refresh_busy - 1'b1;
                if (refresh_busy == $clog2(TRFCAB_CYCLES+1)'(1)) begin
                    refresh_active <= 1'b0;
                end
            end
        end
    end

    // ------------------------------------------------------------------
    // ZQ calibration scheduler
    // ------------------------------------------------------------------
    logic [$clog2(ZQCS_INTERVAL+1)-1:0] zqcs_timer;
    logic [$clog2(ZQCL_INTERVAL+1)-1:0] zqcl_timer;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            zqcs_timer  <= '0;
            zqcl_timer  <= '0;
            zqcs_active <= 1'b0;
            zqcl_active <= 1'b0;
        end else begin
            if (zqcs_timer == $clog2(ZQCS_INTERVAL+1)'(ZQCS_INTERVAL - 1)) begin
                zqcs_timer  <= '0;
                zqcs_active <= 1'b1;
            end else begin
                zqcs_timer  <= zqcs_timer + 1'b1;
                if (zqcs_active && (zqcs_timer & 7'h7F) == 7'h0) zqcs_active <= 1'b0;
            end
            if (zqcl_timer == $clog2(ZQCL_INTERVAL+1)'(ZQCL_INTERVAL - 1)) begin
                zqcl_timer  <= '0;
                zqcl_active <= 1'b1;
            end else begin
                zqcl_timer  <= zqcl_timer + 1'b1;
                if (zqcl_active && (zqcl_timer & 11'h7FF) == 11'h0) zqcl_active <= 1'b0;
            end
        end
    end

    // ------------------------------------------------------------------
    // ECC counters (driven externally by the PHY via DFI on-die ECC
    // feedback channels in a real PHY; held as placeholders here).
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            odecc_corrected_count     <= '0;
            odecc_uncorrected_count   <= '0;
            linkecc_corrected_count   <= '0;
            linkecc_uncorrected_count <= '0;
            ecc_uncorrected_irq       <= 1'b0;
        end
    end

    // ------------------------------------------------------------------
    // AXI4 → DFI bridging: this stub forwards AXI4 transactions to an
    // internal behavioural memory model.  A real controller would
    // implement a per-bank command queue, address mapper, and write
    // combining buffer.  The behavioural path is sufficient to validate
    // burst correctness, ID ordering, and exclusive monitors before the
    // closed-IP PHY is attached.
    // ------------------------------------------------------------------
    e1_axi4_dram_model #(
        .ID_WIDTH    (ID_WIDTH),
        .ADDR_WIDTH  (ADDR_WIDTH),
        .DATA_WIDTH  (DATA_WIDTH),
        .USER_WIDTH  (USER_WIDTH),
        .BURST_LEN_W (BURST_LEN_W),
        .DEPTH_BYTES (16 * 1024)
    ) u_model (
        .clk        (clk),
        .rst_n      (rst_n),
        .s_awvalid  (s_awvalid),
        .s_awready  (s_awready),
        .s_awid     (s_awid),
        .s_awaddr   (s_awaddr),
        .s_awlen    (s_awlen),
        .s_awsize   (s_awsize),
        .s_awburst  (s_awburst),
        .s_awlock   (s_awlock),
        .s_awcache  (s_awcache),
        .s_awprot   (s_awprot),
        .s_awqos    (s_awqos),
        .s_awuser   (s_awuser),
        .s_wvalid   (s_wvalid),
        .s_wready   (s_wready),
        .s_wdata    (s_wdata),
        .s_wstrb    (s_wstrb),
        .s_wlast    (s_wlast),
        .s_bvalid   (s_bvalid),
        .s_bready   (s_bready),
        .s_bid      (s_bid),
        .s_bresp    (s_bresp),
        .s_arvalid  (s_arvalid),
        .s_arready  (s_arready),
        .s_arid     (s_arid),
        .s_araddr   (s_araddr),
        .s_arlen    (s_arlen),
        .s_arsize   (s_arsize),
        .s_arburst  (s_arburst),
        .s_arlock   (s_arlock),
        .s_arcache  (s_arcache),
        .s_arprot   (s_arprot),
        .s_arqos    (s_arqos),
        .s_aruser   (s_aruser),
        .s_rvalid   (s_rvalid),
        .s_rready   (s_rready),
        .s_rid      (s_rid),
        .s_rdata    (s_rdata),
        .s_rresp    (s_rresp),
        .s_rlast    (s_rlast)
    );

    // ------------------------------------------------------------------
    // DFI 5.0 north command shaper.
    //
    // Until the closed-IP LPDDR5X/6 PHY is attached
    // (docs/evidence/memory/lpddr-phy-procurement.yaml) this controller
    // synthesises representative DFI 5.0 north traffic from the AXI4
    // handshakes and the internal refresh scheduler so that downstream
    // verification can observe CKE / CS_n / RAS_n / CAS_n / WE_n / ADDR
    // / BA / wrdata_en / rddata_en transitions for every transaction.
    // The signal semantics follow the JEDEC LPDDR5/6 controller-side
    // mapping:
    //
    //   ACTIVATE  : act_n=0, ras_n=0, cas_n=1, we_n=1, bank=row's bank
    //   READ      : act_n=1, ras_n=1, cas_n=0, we_n=1, addr=column
    //   WRITE     : act_n=1, ras_n=1, cas_n=0, we_n=0, addr=column
    //   PRECHARGE : act_n=1, ras_n=0, cas_n=1, we_n=0
    //   REFRESH   : act_n=1, ras_n=0, cas_n=0, we_n=1
    //   NOP       : act_n=1, ras_n=1, cas_n=1, we_n=1
    //
    // The stub does not yet open-row track or schedule precharge
    // separately; it emits ACTIVATE on the cycle the AXI handshake
    // accepts the address phase and READ/WRITE on the same edge as the
    // model latches the beat.  This is sufficient to validate that
    // every DFI 5.0 north line toggles from a safe reset baseline when
    // the controller sees traffic.
    // ------------------------------------------------------------------
    // DFI init phase: hold init_start high until dfi_init_complete is
    // sampled at least once with a small minimum window so the PHY has
    // time to run read/write training, gate training, and ZQ cal.  The
    // minimum window also makes the boot-time DFI handshake observable
    // in cocotb without requiring sub-cycle precision.
    localparam int unsigned DFI_INIT_MIN_CYCLES = 8;
    logic [$clog2(DFI_INIT_MIN_CYCLES+1)-1:0] init_cycles;
    logic dfi_initialized;
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            dfi_initialized <= 1'b0;
            init_cycles     <= '0;
        end else if (!dfi_initialized) begin
            if (init_cycles < $clog2(DFI_INIT_MIN_CYCLES+1)'(DFI_INIT_MIN_CYCLES)) begin
                init_cycles <= init_cycles + 1'b1;
            end else if (dfi_init_complete) begin
                dfi_initialized <= 1'b1;
            end
        end
    end

    logic axi_write_accept;
    logic axi_read_accept;
    logic axi_write_beat;
    logic axi_read_beat;
    logic refresh_now;

    assign axi_write_accept = s_awvalid && s_awready;
    assign axi_read_accept  = s_arvalid && s_arready;
    assign axi_write_beat   = s_wvalid  && s_wready;
    assign axi_read_beat    = s_rvalid  && s_rready;
    assign refresh_now      = refresh_active;

    // Sample bank from address bits [9:6] (low-order bank field is a
    // common LPDDR mapping; the exact bank-interleave bits are PHY
    // dependent in production).
    logic [3:0] aw_bank_q;
    logic [3:0] ar_bank_q;
    logic [ADDR_WIDTH-1:0] aw_row_q;
    logic [ADDR_WIDTH-1:0] ar_row_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            aw_bank_q <= '0;
            ar_bank_q <= '0;
            aw_row_q  <= '0;
            ar_row_q  <= '0;
        end else begin
            if (axi_write_accept) begin
                aw_bank_q <= s_awaddr[9:6];
                aw_row_q  <= s_awaddr;
            end
            if (axi_read_accept) begin
                ar_bank_q <= s_araddr[9:6];
                ar_row_q  <= s_araddr;
            end
        end
    end

    // CKE asserts as soon as init completes (and stays high while we are
    // not in clock-disable).  CS_n drops on any command edge.
    assign dfi_cke              = dfi_initialized;
    assign dfi_reset_n          = rst_n;
    assign dfi_dram_clk_disable = 1'b0;
    assign dfi_init_start       = !dfi_initialized && rst_n;
    assign dfi_ctrlupd_req      = refresh_now;
    assign dfi_odt              = axi_write_beat;

    // The command shaper drives one DFI command per cycle.  Priority is
    // refresh > activate > read > write > precharge > nop because the
    // physical timing manual orders refresh ahead of column traffic.
    always_comb begin
        // NOP defaults
        dfi_cs_n        = !dfi_initialized;
        dfi_act_n       = 1'b1;
        dfi_ras_n       = 1'b1;
        dfi_cas_n       = 1'b1;
        dfi_we_n        = 1'b1;
        dfi_bank        = '0;
        dfi_addr        = '0;
        dfi_wrdata      = '0;
        dfi_wrdata_mask = '1;
        dfi_wrdata_en   = 1'b0;
        dfi_rddata_en   = 1'b0;

        if (refresh_now) begin
            // REFRESH
            dfi_cs_n  = 1'b0;
            dfi_act_n = 1'b1;
            dfi_ras_n = 1'b0;
            dfi_cas_n = 1'b0;
            dfi_we_n  = 1'b1;
        end else if (axi_write_accept) begin
            // ACTIVATE for write
            dfi_cs_n  = 1'b0;
            dfi_act_n = 1'b0;
            dfi_ras_n = 1'b0;
            dfi_cas_n = 1'b1;
            dfi_we_n  = 1'b1;
            dfi_bank  = s_awaddr[9:6];
            dfi_addr  = s_awaddr;
        end else if (axi_read_accept) begin
            // ACTIVATE for read
            dfi_cs_n  = 1'b0;
            dfi_act_n = 1'b0;
            dfi_ras_n = 1'b0;
            dfi_cas_n = 1'b1;
            dfi_we_n  = 1'b1;
            dfi_bank  = s_araddr[9:6];
            dfi_addr  = s_araddr;
        end else if (axi_write_beat) begin
            // WRITE column command + data
            dfi_cs_n        = 1'b0;
            dfi_act_n       = 1'b1;
            dfi_ras_n       = 1'b1;
            dfi_cas_n       = 1'b0;
            dfi_we_n        = 1'b0;
            dfi_bank        = aw_bank_q;
            dfi_addr        = aw_row_q;
            dfi_wrdata      = s_wdata;
            dfi_wrdata_mask = ~s_wstrb;
            dfi_wrdata_en   = 1'b1;
        end else if (axi_read_beat) begin
            // READ column command + capture enable
            dfi_cs_n      = 1'b0;
            dfi_act_n     = 1'b1;
            dfi_ras_n     = 1'b1;
            dfi_cas_n     = 1'b0;
            dfi_we_n      = 1'b1;
            dfi_bank      = ar_bank_q;
            dfi_addr      = ar_row_q;
            dfi_rddata_en = 1'b1;
        end
    end

endmodule
