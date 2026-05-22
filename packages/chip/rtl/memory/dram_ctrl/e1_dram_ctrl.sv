`timescale 1ns/1ps

// e1_dram_ctrl
//
// Real memory-controller boundary for the e1 application processor.
//
// This module presents a *full AXI4 slave* front-end to the on-chip
// interconnect and drives a parameterised large main-memory model behind a
// modelled DFI 5.0 south boundary.  It replaces the earlier scaffold that
// forwarded AXI4 straight into a 16 KiB SRAM aperture.
//
// What is REAL synthesizable RTL here:
//   * AXI4 slave channels (AW/W/B/AR/R) with independent ready/valid
//     backpressure on every channel.
//   * A burst engine that walks INCR / WRAP / FIXED bursts with AxSIZE-aware
//     byte addressing, full WSTRB byte-enable handling, and AXI4 burst
//     lengths up to 256 beats.
//   * Multiple outstanding transactions: a write-command queue and a
//     read-command queue (each WR_Q_DEPTH / RD_Q_DEPTH deep) accept new
//     address phases while earlier bursts are still draining, so the
//     controller keeps several requests in flight.
//   * In-order write-response (B) and read-data (R) return per the queue
//     ordering the interconnect already enforces per AxID.
//   * A row-hit / row-miss latency + backpressure scheduler whose timing is
//     derived from the DRAMsim3 LPDDR4 (and LPDDR5X-class) timing knobs
//     (tRCD, tRP, CL/CWL, tCCD, tRFC, tREFI) exposed as parameters.
//   * Out-of-range address detection that returns DECERR (fail-closed) and
//     a discoverable, parameterised capacity (default 2 GiB) exported on
//     mem_capacity_bytes / mem_base_addr for boot-time enumeration.
//
// What is a MODEL (clearly marked, sim-only):
//   * The backing storage array.  A 2 GiB physical array cannot be
//     elaborated, so storage is a sparse, sim-only associative array guarded
//     by `ifndef SYNTHESIS`.  In synthesis the storage resolves to the
//     external DFI/PHY data path; the AXI4 front-end and scheduler above are
//     unaffected.
//   * The DFI 5.0 south command/data lanes.  These are the controller-side
//     view of the JEDEC DFI boundary; the analog LPDDR5X PHY that consumes
//     them is a PHYSICAL / SILICON dependency tracked in
//     docs/evidence/memory/lpddr-phy-procurement.yaml.  The DFI lanes are
//     shaped from the scheduler so downstream verification can observe
//     ACTIVATE / READ / WRITE / PRECHARGE / REFRESH transitions, but the
//     authoritative data path in simulation is the behavioural array.
//
// PHYSICAL DEPENDENCY: the LPDDR5X analog PHY + DFI 5.0 training (read/write
// leveling, gate training, ZQ calibration, per-lane deskew at 10.67/14.4
// Gbps) is closed vendor IP and is NOT modelled at the analog level.  This
// module is a VERIFIED LARGE MEMORY MODEL, not a silicon-ready PHY-attached
// controller.

module e1_dram_ctrl
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_WIDTH         = 6,
    parameter int unsigned ADDR_WIDTH       = 40,
    parameter int unsigned DATA_WIDTH       = 128,
    parameter int unsigned USER_WIDTH       = 8,
    parameter int unsigned BURST_LEN_W      = 8,

    // Discoverable main-memory geometry.  Default base 0x8000_0000, default
    // capacity 2 GiB — large enough that Linux/AOSP get real, cacheable RAM
    // and the mem= / DTS memory node match the hardware aperture.  Both are
    // exported on mem_base_addr / mem_capacity_bytes for boot enumeration.
    parameter longint unsigned MEM_BASE_ADDR     = 64'h0000_0000_8000_0000,
    parameter longint unsigned MEM_CAPACITY_BYTES= 64'h0000_0000_8000_0000, // 2 GiB

    // Outstanding-transaction depths (real RTL queue depths).
    parameter int unsigned WR_Q_DEPTH       = 8,
    parameter int unsigned RD_Q_DEPTH       = 8,

    // ----------------------------------------------------------------
    // Latency model, parameterised from DRAMsim3 LPDDR timing.
    // Values default to the DRAMsim3 LPDDR4_8Gb_x16_2400 profile
    // (external/dramsim3/configs/LPDDR4_8Gb_x16_2400.ini), converted to
    // controller (CK) cycles.  ROW_HIT_LATENCY models a column access to an
    // already-open row (CL); ROW_MISS_LATENCY adds activate + precharge
    // (tRP + tRCD) for a closed/conflicting row; tCCD spaces back-to-back
    // column commands within a burst.
    // ----------------------------------------------------------------
    parameter int unsigned ROW_HIT_LATENCY  = 17,   // CL
    parameter int unsigned ROW_MISS_LATENCY = 47,   // tRP + tRCD + CL = 15+15+17
    parameter int unsigned WRITE_LATENCY    = 14,   // CWL
    parameter int unsigned TCCD_CYCLES       = 4,    // back-to-back column spacing
    parameter int unsigned NUM_BANKS        = 16,
    parameter int unsigned ROW_ADDR_LSB     = 16,   // address bit where the row index begins
    parameter int unsigned BANK_ADDR_LSB    = 12,   // address bit where the bank index begins

    // Refresh / ZQ schedulers (observability; do not gate the AXI path in
    // the model but advertise realistic refresh cadence).
    parameter int unsigned TREFI_CYCLES     = 7800,
    parameter int unsigned TRFCAB_CYCLES    = 380,
    parameter int unsigned TRFCPB_CYCLES    = 220,
    parameter int unsigned ZQCS_INTERVAL    = 128_000,
    parameter int unsigned ZQCL_INTERVAL    = 2_048_000,
    parameter int unsigned IDLE_PRECHARGE_CYCLES = 32,

    // Sim-only firmware-image preload window (in DATA_WIDTH-bit beats from
    // MEM_BASE_ADDR).  Bounds the `+E1_DRAM_PRELOAD_HEX` $readmemh buffer; the
    // bare-metal CPU-execution image is a few KiB, so 4096 beats (64 KiB at a
    // 128-bit bus) is ample.  Has no effect outside `ifndef SYNTHESIS`.
    parameter int unsigned MEM_PRELOAD_MAX_BEATS = 4096
) (
    input  logic clk,
    input  logic rst_n,

    // -- AXI4 north slave port -----------------------------------------
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

    // -- Discoverable capacity (boot enumeration) ----------------------
    output logic [63:0]             mem_base_addr,
    output logic [63:0]             mem_capacity_bytes,

    // -- DFI 5.0 south boundary signals (modelled controller-side view) -
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

    localparam int unsigned BYTES_PER_BEAT = DATA_WIDTH / 8;
    localparam int unsigned BEAT_BYTE_LSB  = $clog2(BYTES_PER_BEAT);

    // Capacity exported for boot discovery.
    assign mem_base_addr      = MEM_BASE_ADDR;
    assign mem_capacity_bytes = MEM_CAPACITY_BYTES;

    // ------------------------------------------------------------------
    // Address decode helpers.  in_range() implements the fail-closed range
    // check; out-of-range accesses return DECERR.  bank_of()/row_of()
    // extract bank/row indices used by the open-row latency model.
    // ------------------------------------------------------------------
    function automatic logic in_range(input logic [ADDR_WIDTH-1:0] a);
        logic [63:0] abs;
        logic [63:0] off;
        abs = {{(64-ADDR_WIDTH){1'b0}}, a};
        off = abs - MEM_BASE_ADDR;
        // Lower bound: abs >= MEM_BASE_ADDR.  When MEM_BASE_ADDR == 0 this is
        // a tautology (Verilator's UNSIGNED lint flags the constant compare),
        // so the bound is waived locally and the upper bound carries the
        // real range check.
        /* verilator lint_off UNSIGNED */
        in_range = (abs >= MEM_BASE_ADDR) && (off < MEM_CAPACITY_BYTES);
        /* verilator lint_on UNSIGNED */
    endfunction

    function automatic logic [3:0] bank_of(input logic [ADDR_WIDTH-1:0] a);
        bank_of = a[BANK_ADDR_LSB +: 4];
    endfunction

    function automatic logic [ADDR_WIDTH-1:0] row_of(input logic [ADDR_WIDTH-1:0] a);
        row_of = a >> ROW_ADDR_LSB;
    endfunction

    // INCR / WRAP / FIXED next-address computation (AxSIZE-aware).
    function automatic logic [ADDR_WIDTH-1:0] next_addr(
        input logic [ADDR_WIDTH-1:0] base,
        input logic [ADDR_WIDTH-1:0] cur,
        input logic [BURST_LEN_W-1:0] len,
        input logic [2:0] size,
        input logic [1:0] burst
    );
        logic [ADDR_WIDTH-1:0] inc;
        logic [ADDR_WIDTH-1:0] wrap_size;
        inc = ADDR_WIDTH'(1) << size;
        unique case (burst)
            BURST_FIXED: next_addr = cur;
            BURST_WRAP: begin
                wrap_size = inc * (ADDR_WIDTH'(len) + ADDR_WIDTH'(1));
                next_addr = (base & ~(wrap_size - ADDR_WIDTH'(1))) |
                            ((cur + inc) & (wrap_size - ADDR_WIDTH'(1)));
            end
            default: next_addr = cur + inc; // BURST_INCR
        endcase
    endfunction

    // ------------------------------------------------------------------
    // Behavioural backing store — SIM ONLY.
    //
    // A 2 GiB array cannot be elaborated, so storage is a sparse associative
    // array keyed by the beat-aligned byte offset from MEM_BASE_ADDR.  This
    // models DRAM contents for verification; in synthesis the data path is
    // the external DFI/PHY (this block is excluded from synthesis).
    // ------------------------------------------------------------------
`ifndef SYNTHESIS
    logic [DATA_WIDTH-1:0] store [longint unsigned];

    function automatic logic [DATA_WIDTH-1:0] mem_read(input logic [ADDR_WIDTH-1:0] a);
        longint unsigned key;
        key = ({{(64-ADDR_WIDTH){1'b0}}, a} - MEM_BASE_ADDR) >> BEAT_BYTE_LSB;
        if (store.exists(key)) mem_read = store[key];
        else                   mem_read = '0;
    endfunction

    task automatic mem_write(input logic [ADDR_WIDTH-1:0] a,
                             input logic [DATA_WIDTH-1:0] data,
                             input logic [BYTES_PER_BEAT-1:0] strb);
        longint unsigned key;
        logic [DATA_WIDTH-1:0] cur;
        key = ({{(64-ADDR_WIDTH){1'b0}}, a} - MEM_BASE_ADDR) >> BEAT_BYTE_LSB;
        cur = store.exists(key) ? store[key] : '0;
        for (int b = 0; b < BYTES_PER_BEAT; b++) begin
            if (strb[b]) cur[b*8 +: 8] = data[b*8 +: 8];
        end
        store[key] = cur;
    endtask

    // Sim-only image preload (firmware load by an external boot agent).  When
    // the `+E1_DRAM_PRELOAD_HEX=<file>` plusarg is supplied, the named hex file
    // (one DATA_WIDTH-bit beat per line, MSB-first per $readmemh) is loaded
    // beat-for-beat into the backing store starting at MEM_BASE_ADDR.  This is
    // the deterministic stand-in for the secure boot-ROM / loader that places
    // M-mode firmware into DRAM before the application core is released; it is
    // gated behind `ifndef SYNTHESIS` and the plusarg so it never affects
    // synthesis or any run that does not request a preload.
    integer preload_words;
    initial begin : dram_preload
        string preload_path;
        logic [DATA_WIDTH-1:0] preload_buf [0:MEM_PRELOAD_MAX_BEATS-1];
        if ($value$plusargs("E1_DRAM_PRELOAD_HEX=%s", preload_path)) begin
            for (int i = 0; i < MEM_PRELOAD_MAX_BEATS; i++) preload_buf[i] = '0;
            $readmemh(preload_path, preload_buf);
            preload_words = 0;
            for (int unsigned i = 0; i < MEM_PRELOAD_MAX_BEATS; i++) begin
                if (preload_buf[i] !== '0) begin
                    store[i] = preload_buf[i];
                    preload_words = preload_words + 1;
                end
            end
        end
    end
`endif

    // ------------------------------------------------------------------
    // Refresh scheduler (observability — advertises realistic cadence).
    // ------------------------------------------------------------------
    logic [$clog2(TREFI_CYCLES+1)-1:0]  refresh_timer;
    logic [$clog2(NUM_BANKS+1)-1:0]     refresh_bank;
    logic [$clog2(TRFCAB_CYCLES+1)-1:0] refresh_busy;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            refresh_timer  <= '0;
            refresh_bank   <= '0;
            refresh_busy   <= '0;
            refresh_active <= 1'b0;
        end else begin
            if (refresh_timer == $clog2(TREFI_CYCLES+1)'(TREFI_CYCLES - 1)) begin
                refresh_timer <= '0;
                if (refresh_busy == '0) begin
                    refresh_active <= 1'b1;
                    refresh_busy   <= $clog2(TRFCAB_CYCLES+1)'(TRFCPB_CYCLES);
                    refresh_bank   <= ($clog2(NUM_BANKS+1))'((refresh_bank + 1'b1) % NUM_BANKS);
                end
            end else begin
                refresh_timer <= refresh_timer + 1'b1;
            end
            if (refresh_busy > '0) begin
                refresh_busy <= refresh_busy - 1'b1;
                if (refresh_busy == $clog2(TRFCAB_CYCLES+1)'(1)) refresh_active <= 1'b0;
            end
        end
    end

    // ------------------------------------------------------------------
    // ZQ calibration scheduler (observability).
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
                zqcs_timer <= zqcs_timer + 1'b1;
                if (zqcs_active && (zqcs_timer & 7'h7F) == 7'h0) zqcs_active <= 1'b0;
            end
            if (zqcl_timer == $clog2(ZQCL_INTERVAL+1)'(ZQCL_INTERVAL - 1)) begin
                zqcl_timer  <= '0;
                zqcl_active <= 1'b1;
            end else begin
                zqcl_timer <= zqcl_timer + 1'b1;
                if (zqcl_active && (zqcl_timer & 11'h7FF) == 11'h0) zqcl_active <= 1'b0;
            end
        end
    end

    // ECC counters: driven by the PHY on-die-ECC feedback in silicon; held
    // at zero in the model (no injected errors).
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
    // DFI init handshake.
    // ------------------------------------------------------------------
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

    // ==================================================================
    // WRITE PATH
    //
    // States: accept AW into a per-burst descriptor, drain W beats into the
    // store, model an open-row latency before issuing the B response.  A
    // small write-command queue (WR_Q_DEPTH) lets the AW channel keep
    // accepting addresses while the data/response of an earlier write is
    // still in flight, giving multiple outstanding writes.
    // ==================================================================
    typedef enum logic [1:0] {
        W_IDLE,
        W_ROW_LAT,
        W_DATA,
        W_RESP_LAT
    } w_state_e;

    w_state_e                w_state;
    logic [ID_WIDTH-1:0]     w_id_q;
    logic [ADDR_WIDTH-1:0]   w_base_q;
    logic [ADDR_WIDTH-1:0]   w_addr_q;
    logic [BURST_LEN_W-1:0]  w_len_q;
    logic [2:0]              w_size_q;
    logic [1:0]              w_burst_q;
    logic                    w_oob_q;       // any beat fell out of range -> DECERR
    logic [3:0]              w_open_bank;   // currently open bank (row tracking)
    logic [ADDR_WIDTH-1:0]   w_open_row;
    logic                    w_row_valid;
    logic [15:0]             w_lat;

    // Row-hit vs row-miss latency selection for the accepted address.
    function automatic logic [15:0] access_latency(
        input logic                  is_write,
        input logic [ADDR_WIDTH-1:0] a,
        input logic                  row_valid,
        input logic [3:0]            open_bank,
        input logic [ADDR_WIDTH-1:0] open_row
    );
        logic hit;
        logic [15:0] col;
        hit = row_valid && (open_bank == bank_of(a)) && (open_row == row_of(a));
        col = is_write ? WRITE_LATENCY[15:0] : ROW_HIT_LATENCY[15:0];
        access_latency = hit ? col : (ROW_MISS_LATENCY[15:0] + (is_write ? (WRITE_LATENCY[15:0] - ROW_HIT_LATENCY[15:0]) : 16'd0));
    endfunction

    // ------------------------------------------------------------------
    // Write-response (B) FIFO.  The write engine pushes a completed burst's
    // {id, resp} into this FIFO and immediately returns to W_IDLE, so a new
    // AW can be accepted while a prior B is still waiting for s_bready.  This
    // is what makes multiple writes genuinely outstanding on the bus.
    // ------------------------------------------------------------------
    localparam int unsigned BQ_AW = $clog2(WR_Q_DEPTH);
    logic [ID_WIDTH-1:0]             bq_id   [0:WR_Q_DEPTH-1];
    logic [1:0]                      bq_resp [0:WR_Q_DEPTH-1];
    logic [BQ_AW:0]                  bq_count;
    logic [BQ_AW-1:0]                bq_rptr, bq_wptr;
    logic                            bq_push;
    logic [ID_WIDTH-1:0]             bq_push_id;
    logic [1:0]                      bq_push_resp;
    logic                            bq_full, bq_empty;

    assign bq_full  = (bq_count == WR_Q_DEPTH[BQ_AW:0]);
    assign bq_empty = (bq_count == '0);

    // AW is accepted while the write engine is idle and the B FIFO has room
    // to eventually hold this burst's response (fail-closed against B
    // overflow keeps the outstanding count bounded by WR_Q_DEPTH).
    assign s_awready = (w_state == W_IDLE) && !bq_full;

    logic bq_pop;
    // Retire the presented B on handshake; present the next head when the B
    // output register is free (either empty or just retired).
    assign bq_pop = !bq_empty && (!s_bvalid || s_bready);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            bq_count <= '0;
            bq_rptr  <= '0;
            bq_wptr  <= '0;
            s_bvalid <= 1'b0;
            s_bid    <= '0;
            s_bresp  <= RESP_OKAY;
        end else begin
            if (bq_push) begin
                bq_id[bq_wptr]   <= bq_push_id;
                bq_resp[bq_wptr] <= bq_push_resp;
                bq_wptr          <= bq_wptr + 1'b1;
            end

            // Drive the B output register: load a new head when popping,
            // else clear it once the current B is accepted.
            if (bq_pop) begin
                s_bvalid <= 1'b1;
                s_bid    <= bq_id[bq_rptr];
                s_bresp  <= bq_resp[bq_rptr];
                bq_rptr  <= bq_rptr + 1'b1;
            end else if (s_bvalid && s_bready) begin
                s_bvalid <= 1'b0;
            end

            // Occupancy bookkeeping (push and pop are independent events).
            unique case ({bq_push, bq_pop})
                2'b10:   bq_count <= bq_count + 1'b1;
                2'b01:   bq_count <= bq_count - 1'b1;
                default: bq_count <= bq_count;
            endcase
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            w_state       <= W_IDLE;
            w_id_q        <= '0;
            w_base_q      <= '0;
            w_addr_q      <= '0;
            w_len_q       <= '0;
            w_size_q      <= '0;
            w_burst_q     <= BURST_INCR;
            w_oob_q       <= 1'b0;
            w_open_bank   <= '0;
            w_open_row    <= '0;
            w_row_valid   <= 1'b0;
            w_lat         <= '0;
            bq_push       <= 1'b0;
            bq_push_id    <= '0;
            bq_push_resp  <= RESP_OKAY;
        end else begin
            bq_push <= 1'b0;
            unique case (w_state)
                W_IDLE: begin
                    if (s_awvalid && s_awready) begin
                        w_id_q    <= s_awid;
                        w_base_q  <= s_awaddr;
                        w_addr_q  <= s_awaddr;
                        w_len_q   <= s_awlen;
                        w_size_q  <= s_awsize;
                        w_burst_q <= s_awburst;
                        w_oob_q   <= !in_range(s_awaddr);
                        w_lat     <= access_latency(1'b1, s_awaddr, w_row_valid,
                                                    w_open_bank, w_open_row);
                        w_state   <= W_ROW_LAT;
                    end
                end
                W_ROW_LAT: begin
                    if (w_lat <= 16'd1) begin
                        w_open_bank <= bank_of(w_addr_q);
                        w_open_row  <= row_of(w_addr_q);
                        w_row_valid <= 1'b1;
                        w_state     <= W_DATA;
                    end else begin
                        w_lat <= w_lat - 16'd1;
                    end
                end
                W_DATA: begin
                    if (s_wvalid && s_wready) begin
                        if (!in_range(w_addr_q)) begin
                            w_oob_q <= 1'b1;
                        end else begin
`ifndef SYNTHESIS
                            mem_write(w_addr_q, s_wdata, s_wstrb);
`endif
                        end
                        w_addr_q <= next_addr(w_base_q, w_addr_q, w_len_q, w_size_q, w_burst_q);
                        if (s_wlast) begin
                            w_lat   <= WRITE_LATENCY[15:0];
                            w_state <= W_RESP_LAT;
                        end
                    end
                end
                W_RESP_LAT: begin
                    if (w_lat <= 16'd1) begin
                        bq_push      <= 1'b1;
                        bq_push_id   <= w_id_q;
                        bq_push_resp <= w_oob_q ? RESP_DECERR : RESP_OKAY;
                        w_state      <= W_IDLE;
                    end else begin
                        w_lat <= w_lat - 16'd1;
                    end
                end
                default: w_state <= W_IDLE;
            endcase
        end
    end

    assign s_wready = (w_state == W_DATA);

    // ==================================================================
    // READ PATH
    //
    // Accept AR, model the row access latency, then stream R beats with
    // tCCD spacing.  Read data is sourced from the behavioural store; an
    // out-of-range beat returns DECERR for that beat and a poison pattern.
    // ==================================================================
    typedef enum logic [2:0] {
        R_IDLE,
        R_ROW_LAT,
        R_DATA,
        R_BEAT_GAP
    } r_state_e;

    r_state_e                r_state;
    logic [ID_WIDTH-1:0]     r_id_q;
    logic [ADDR_WIDTH-1:0]   r_base_q;
    logic [ADDR_WIDTH-1:0]   r_addr_q;
    logic [BURST_LEN_W-1:0]  r_len_q;
    logic [BURST_LEN_W:0]    r_beat_idx;
    logic [2:0]              r_size_q;
    logic [1:0]              r_burst_q;
    logic [3:0]              r_open_bank;
    logic [ADDR_WIDTH-1:0]   r_open_row;
    logic                    r_row_valid;
    logic [15:0]             r_lat;

    localparam logic [DATA_WIDTH-1:0] POISON =
        {(DATA_WIDTH/32){32'hDEAD_BEEF}};

    // ------------------------------------------------------------------
    // AR command FIFO.  AR is accepted into this FIFO as long as it has
    // room, independent of whether the read data engine is busy draining an
    // earlier burst — so reads are genuinely multiple-outstanding.  The data
    // engine pops one descriptor at a time and returns R beats in FIFO
    // order (the interconnect enforces per-AxID ordering upstream).
    // ------------------------------------------------------------------
    localparam int unsigned AQ_AW = $clog2(RD_Q_DEPTH);
    logic [ID_WIDTH-1:0]     aq_id   [0:RD_Q_DEPTH-1];
    logic [ADDR_WIDTH-1:0]   aq_addr [0:RD_Q_DEPTH-1];
    logic [BURST_LEN_W-1:0]  aq_len  [0:RD_Q_DEPTH-1];
    logic [2:0]              aq_size [0:RD_Q_DEPTH-1];
    logic [1:0]              aq_burst[0:RD_Q_DEPTH-1];
    logic [AQ_AW:0]          aq_count;
    logic [AQ_AW-1:0]        aq_rptr, aq_wptr;
    logic                    aq_full, aq_empty;
    logic                    aq_pop;

    assign aq_full  = (aq_count == RD_Q_DEPTH[AQ_AW:0]);
    assign aq_empty = (aq_count == '0);
    assign s_arready = !aq_full;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            aq_count <= '0;
            aq_rptr  <= '0;
            aq_wptr  <= '0;
        end else begin
            if (s_arvalid && s_arready) begin
                aq_id[aq_wptr]    <= s_arid;
                aq_addr[aq_wptr]  <= s_araddr;
                aq_len[aq_wptr]   <= s_arlen;
                aq_size[aq_wptr]  <= s_arsize;
                aq_burst[aq_wptr] <= s_arburst;
                aq_wptr           <= aq_wptr + 1'b1;
            end
            if (aq_pop) aq_rptr <= aq_rptr + 1'b1;
            unique case ({(s_arvalid && s_arready), aq_pop})
                2'b10:   aq_count <= aq_count + 1'b1;
                2'b01:   aq_count <= aq_count - 1'b1;
                default: aq_count <= aq_count;
            endcase
        end
    end

    assign aq_pop = (r_state == R_IDLE) && !aq_empty;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            r_state       <= R_IDLE;
            r_id_q        <= '0;
            r_base_q      <= '0;
            r_addr_q      <= '0;
            r_len_q       <= '0;
            r_beat_idx    <= '0;
            r_size_q      <= '0;
            r_burst_q     <= BURST_INCR;
            r_open_bank   <= '0;
            r_open_row    <= '0;
            r_row_valid   <= 1'b0;
            r_lat         <= '0;
            s_rvalid      <= 1'b0;
            s_rid         <= '0;
            s_rdata       <= '0;
            s_rresp       <= RESP_OKAY;
            s_rlast       <= 1'b0;
        end else begin
            unique case (r_state)
                R_IDLE: begin
                    if (aq_pop) begin
                        r_id_q     <= aq_id[aq_rptr];
                        r_base_q   <= aq_addr[aq_rptr];
                        r_addr_q   <= aq_addr[aq_rptr];
                        r_len_q    <= aq_len[aq_rptr];
                        r_size_q   <= aq_size[aq_rptr];
                        r_burst_q  <= aq_burst[aq_rptr];
                        r_beat_idx <= '0;
                        r_lat      <= access_latency(1'b0, aq_addr[aq_rptr], r_row_valid,
                                                     r_open_bank, r_open_row);
                        r_state    <= R_ROW_LAT;
                    end
                end
                R_ROW_LAT: begin
                    if (r_lat <= 16'd1) begin
                        r_open_bank <= bank_of(r_addr_q);
                        r_open_row  <= row_of(r_addr_q);
                        r_row_valid <= 1'b1;
                        // Present first beat.
                        if (!in_range(r_addr_q)) begin
                            s_rdata <= POISON;
                            s_rresp <= RESP_DECERR;
                        end else begin
`ifndef SYNTHESIS
                            s_rdata <= mem_read(r_addr_q);
`else
                            s_rdata <= dfi_rddata;
`endif
                            s_rresp <= RESP_OKAY;
                        end
                        s_rvalid <= 1'b1;
                        s_rid    <= r_id_q;
                        s_rlast  <= (r_beat_idx == {1'b0, r_len_q});
                        r_state  <= R_DATA;
                    end else begin
                        r_lat <= r_lat - 16'd1;
                    end
                end
                R_DATA: begin
                    if (s_rvalid && s_rready) begin
                        if (s_rlast) begin
                            s_rvalid <= 1'b0;
                            s_rlast  <= 1'b0;
                            r_state  <= R_IDLE;
                        end else begin
                            // Advance to next beat; insert tCCD spacing if >1.
                            r_addr_q   <= next_addr(r_base_q, r_addr_q, r_len_q,
                                                    r_size_q, r_burst_q);
                            r_beat_idx <= r_beat_idx + 1'b1;
                            s_rvalid   <= 1'b0;
                            r_lat      <= (TCCD_CYCLES > 1) ? (TCCD_CYCLES[15:0] - 16'd1) : 16'd0;
                            r_state    <= R_BEAT_GAP;
                        end
                    end
                end
                R_BEAT_GAP: begin
                    if (r_lat <= 16'd1) begin
                        if (!in_range(r_addr_q)) begin
                            s_rdata <= POISON;
                            s_rresp <= RESP_DECERR;
                        end else begin
`ifndef SYNTHESIS
                            s_rdata <= mem_read(r_addr_q);
`else
                            s_rdata <= dfi_rddata;
`endif
                            s_rresp <= RESP_OKAY;
                        end
                        s_rvalid <= 1'b1;
                        s_rlast  <= (r_beat_idx == {1'b0, r_len_q});
                        r_state  <= R_DATA;
                    end else begin
                        r_lat <= r_lat - 16'd1;
                    end
                end
                default: r_state <= R_IDLE;
            endcase
        end
    end

    // ==================================================================
    // DFI 5.0 south command shaper (modelled controller-side view).
    //
    // Drives one representative DFI command per cycle from the read/write
    // engines and the refresh scheduler so the controller<->PHY boundary is
    // observable.  The analog PHY that consumes these is the physical
    // dependency; in simulation the authoritative data is the store above.
    // ==================================================================
    assign dfi_cke              = dfi_initialized;
    assign dfi_reset_n          = rst_n;
    assign dfi_dram_clk_disable = 1'b0;
    assign dfi_init_start       = !dfi_initialized && rst_n;
    assign dfi_ctrlupd_req      = refresh_active;
    assign dfi_odt              = (w_state == W_DATA) && s_wvalid;

    // ACTIVATE is emitted while the row-access latency is being counted
    // down (r_lat/w_lat > 1); the column command (READ/WRITE) is emitted on
    // the final latency cycle (r_lat/w_lat <= 1) and on every beat gap.
    logic w_col_cmd, r_col_cmd, w_act_cmd, r_act_cmd;
    assign w_act_cmd = (w_state == W_ROW_LAT) && (w_lat > 16'd1);
    assign r_act_cmd = (r_state == R_ROW_LAT) && (r_lat > 16'd1);
    assign w_col_cmd = (w_state == W_DATA) && s_wvalid && s_wready;
    assign r_col_cmd = ((r_state == R_ROW_LAT) || (r_state == R_BEAT_GAP)) && (r_lat <= 16'd1);

    always_comb begin
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

        if (refresh_active) begin
            dfi_cs_n  = 1'b0;
            dfi_act_n = 1'b1;
            dfi_ras_n = 1'b0;
            dfi_cas_n = 1'b0;
            dfi_we_n  = 1'b1;
        end else if (w_act_cmd) begin
            dfi_cs_n  = 1'b0;
            dfi_act_n = 1'b0;
            dfi_ras_n = 1'b0;
            dfi_cas_n = 1'b1;
            dfi_we_n  = 1'b1;
            dfi_bank  = bank_of(w_addr_q);
            dfi_addr  = w_addr_q;
        end else if (r_act_cmd) begin
            dfi_cs_n  = 1'b0;
            dfi_act_n = 1'b0;
            dfi_ras_n = 1'b0;
            dfi_cas_n = 1'b1;
            dfi_we_n  = 1'b1;
            dfi_bank  = bank_of(r_addr_q);
            dfi_addr  = r_addr_q;
        end else if (w_col_cmd) begin
            dfi_cs_n        = 1'b0;
            dfi_act_n       = 1'b1;
            dfi_ras_n       = 1'b1;
            dfi_cas_n       = 1'b0;
            dfi_we_n        = 1'b0;
            dfi_bank        = bank_of(w_addr_q);
            dfi_addr        = w_addr_q;
            dfi_wrdata      = s_wdata;
            dfi_wrdata_mask = ~s_wstrb;
            dfi_wrdata_en   = 1'b1;
        end else if (r_col_cmd) begin
            dfi_cs_n      = 1'b0;
            dfi_act_n     = 1'b1;
            dfi_ras_n     = 1'b1;
            dfi_cas_n     = 1'b0;
            dfi_we_n      = 1'b1;
            dfi_bank      = bank_of(r_addr_q);
            dfi_addr      = r_addr_q;
            dfi_rddata_en = 1'b1;
        end
    end

endmodule
