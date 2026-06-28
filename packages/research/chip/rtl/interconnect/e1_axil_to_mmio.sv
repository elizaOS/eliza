`timescale 1ns/1ps

// e1_axil_to_mmio
//
// AXI-Lite slave -> simple MMIO master adapter.
//
// The e1 peripheral fabric (bootrom / peripherals / dma / npu / display /
// weight-buffer SRAM / CLINT / behavioural DRAM) speaks a simple synchronous
// request bus: mmio_valid / mmio_write / mmio_addr / mmio_wdata, with a single
// shared mmio_rdata / mmio_ready return. The CVA6 application processor reaches
// that fabric through e1_cpu_axi_bridge, whose downstream port is 32-bit
// AXI-Lite. This adapter converts that AXI-Lite slave port into one MMIO master
// request at a time so the CPU can read and write real peripherals.
//
// Behaviour:
//   * One outstanding transaction. Reads take priority over writes when both
//     channels present in the same idle cycle (matches the bridge, which never
//     issues a read and a write concurrently, but keeps the arbiter simple).
//   * A read drives mmio_valid with mmio_write=0; the captured mmio_rdata is
//     returned on the AXI-Lite R channel with RRESP=OKAY.
//   * A write drives mmio_valid with mmio_write=1 and mmio_wdata; the AXI-Lite B
//     channel returns BRESP=OKAY once the fabric accepts the beat.
//   * mmio_ready gates request completion, so multi-cycle fabric regions (the
//     real CLINT/PLIC/DRAM subsystem) are honoured without dropping beats.
//   * WSTRB is forwarded for observability but the v0 fabric is word-granular
//     and ignores it; partial-strobe writes still target the addressed word.
//
// The adapter never manufactures data: it returns exactly what the fabric
// returns on mmio_rdata, with OKAY for every completed beat (the fabric itself
// drives 0xDEAD_BEEF for unmapped words via e1_soc_top's decode default).

module e1_axil_to_mmio (
    input  logic        clk,
    input  logic        rst_n,

    // ── AXI-Lite slave port (from e1_cpu_axi_bridge master) ───────────────
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
    output logic [1:0]  s_axil_rresp,

    // ── Simple MMIO master port (to fabric arbiter) ───────────────────────
    output logic        mmio_valid,
    output logic        mmio_write,
    output logic [31:0] mmio_addr,
    output logic [31:0] mmio_wdata,
    output logic [3:0]  mmio_wstrb,
    input  logic [31:0] mmio_rdata,
    input  logic        mmio_ready
);
    localparam logic [1:0] RESP_OKAY = 2'b00;

    typedef enum logic [2:0] {
        S_IDLE,
        S_RD_REQ,
        S_RD_RESP,
        S_WR_REQ,
        S_WR_RESP
    } state_e;

    state_e      state_q, state_d;
    logic [31:0] addr_q;
    logic [31:0] wdata_q;
    logic [3:0]  wstrb_q;
    logic [31:0] rdata_q;

    // ── Next-state + MMIO request generation ──────────────────────────────
    always_comb begin
        state_d = state_q;

        s_axil_awready = 1'b0;
        s_axil_wready  = 1'b0;
        s_axil_bvalid  = 1'b0;
        s_axil_bresp   = RESP_OKAY;
        s_axil_arready = 1'b0;
        s_axil_rvalid  = 1'b0;
        s_axil_rdata   = rdata_q;
        s_axil_rresp   = RESP_OKAY;

        mmio_valid = 1'b0;
        mmio_write = 1'b0;
        mmio_addr  = addr_q;
        mmio_wdata = wdata_q;
        mmio_wstrb = wstrb_q;

        unique case (state_q)
            S_IDLE: begin
                // Reads win when both channels offer in the same cycle.
                if (s_axil_arvalid) begin
                    s_axil_arready = 1'b1;
                    state_d        = S_RD_REQ;
                end else if (s_axil_awvalid && s_axil_wvalid) begin
                    s_axil_awready = 1'b1;
                    s_axil_wready  = 1'b1;
                    state_d        = S_WR_REQ;
                end
            end

            S_RD_REQ: begin
                mmio_valid = 1'b1;
                mmio_write = 1'b0;
                if (mmio_ready) begin
                    state_d = S_RD_RESP;
                end
            end

            S_RD_RESP: begin
                s_axil_rvalid = 1'b1;
                s_axil_rresp  = RESP_OKAY;
                if (s_axil_rready) begin
                    state_d = S_IDLE;
                end
            end

            S_WR_REQ: begin
                mmio_valid = 1'b1;
                mmio_write = 1'b1;
                if (mmio_ready) begin
                    state_d = S_WR_RESP;
                end
            end

            S_WR_RESP: begin
                s_axil_bvalid = 1'b1;
                s_axil_bresp  = RESP_OKAY;
                if (s_axil_bready) begin
                    state_d = S_IDLE;
                end
            end

            default: state_d = S_IDLE;
        endcase
    end

    // ── State + datapath registers ────────────────────────────────────────
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state_q <= S_IDLE;
            addr_q  <= 32'h0;
            wdata_q <= 32'h0;
            wstrb_q <= 4'h0;
            rdata_q <= 32'h0;
        end else begin
            state_q <= state_d;

            if (state_q == S_IDLE) begin
                if (s_axil_arvalid) begin
                    addr_q <= s_axil_araddr;
                end else if (s_axil_awvalid && s_axil_wvalid) begin
                    addr_q  <= s_axil_awaddr;
                    wdata_q <= s_axil_wdata;
                    wstrb_q <= s_axil_wstrb;
                end
            end

            // Capture fabric read data on the cycle the request completes.
            if (state_q == S_RD_REQ && mmio_ready) begin
                rdata_q <= mmio_rdata;
            end
        end
    end

endmodule : e1_axil_to_mmio
