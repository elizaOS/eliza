`timescale 1ns/1ps

// e1_uart_ns16550
//
// A compact, synthesizable ns16550a-compatible UART subset, presented as an
// AXI4 slave on the E1 fabric.  It exists so the real OpenSBI build (whose
// `uart8250` console driver speaks the standard 8250/16550 register layout)
// has a console sink at 0x1000_1000 when CVA6 executes it in simulation.
//
// Register map (byte offsets, reg-shift=0, byte-wide registers — exactly the
// `reg-shift = <0>` / `reg-width 1` projection the eliza OpenSBI platform and
// the e1-platform DTB declare):
//
//   0x00  RBR (R) / THR (W)   receive buffer / transmit holding
//   0x01  IER                 interrupt enable
//   0x02  IIR (R) / FCR (W)    interrupt id / FIFO control
//   0x03  LCR                  line control (DLAB in bit 7)
//   0x04  MCR                  modem control
//   0x05  LSR (R)              line status — bit5 THRE, bit6 TEMT, bit0 DR
//   0x06  MSR (R)              modem status
//   0x07  SCR                  scratch
//   When LCR.DLAB=1: 0x00 = DLL, 0x01 = DLM (baud divisor latch).
//
// This is the WRITE/console path OpenSBI uses: it polls LSR.THRE before each
// THR write, then writes the character.  We hold THRE/TEMT permanently set
// (the model never back-pressures), so every THR write is accepted and the
// byte is emitted on `tx_byte_o`/`tx_valid_o` for the testbench to scrape.
// The full bit-level UART line model is intentionally not implemented — this
// is the register-level console subset OpenSBI's uart8250 driver requires, and
// it is clearly a CONSOLE-SINK model, not a wire-level serializer.  (The
// wire-level 8N1 serializer lives in e1_uart.sv for the GPIO-class UART.)
//
// The receive path is wired but inert (DR held clear): OpenSBI bring-up and
// the M->S handoff proof are TX-only.  Reads of RBR return 0.
//
// AXI4 slave: single-outstanding, AxLEN=0 single-beat word accesses (the CPU
// issues uncached MMIO stores/loads to this region).  The accessed byte
// register is selected from the access address's low bits within the wide
// data beat.  This mirrors e1_axi4_to_axilite_slave's lane handling but the
// leaf here is a byte-addressed register file rather than a 32-bit AXI-Lite
// slave, so the bridge is folded directly into this module.

module e1_uart_ns16550
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_W   = 5,
    parameter int unsigned ADDR_W = 40,
    parameter int unsigned DATA_W = 128
) (
    input  logic clk,
    input  logic rst_n,

    // AXI4 slave (from the fabric).
    input  logic              s_awvalid,
    output logic              s_awready,
    input  logic [ID_W-1:0]   s_awid,
    input  logic [ADDR_W-1:0] s_awaddr,
    input  logic [7:0]        s_awlen,
    input  logic [2:0]        s_awsize,
    input  logic [1:0]        s_awburst,
    input  logic              s_wvalid,
    output logic              s_wready,
    input  logic [DATA_W-1:0] s_wdata,
    input  logic [DATA_W/8-1:0] s_wstrb,
    input  logic              s_wlast,
    output logic              s_bvalid,
    input  logic              s_bready,
    output logic [ID_W-1:0]   s_bid,
    output logic [1:0]        s_bresp,
    input  logic              s_arvalid,
    output logic              s_arready,
    input  logic [ID_W-1:0]   s_arid,
    input  logic [ADDR_W-1:0] s_araddr,
    input  logic [7:0]        s_arlen,
    input  logic [2:0]        s_arsize,
    input  logic [1:0]        s_arburst,
    output logic              s_rvalid,
    input  logic              s_rready,
    output logic [ID_W-1:0]   s_rid,
    output logic [DATA_W-1:0] s_rdata,
    output logic [1:0]        s_rresp,
    output logic              s_rlast,

    // Console TX scrape (no functional role; for the testbench to assemble the
    // transmitted character stream).  `tx_valid_o` pulses for one cycle each
    // time the CPU writes a byte to THR.
    output logic       tx_valid_o,
    output logic [7:0] tx_byte_o
);
    localparam int unsigned LANE_LSB = $clog2(DATA_W/8); // 4 for 128-bit bus

    // ns16550 register offsets (byte addresses, reg-shift=0).
    localparam logic [2:0] REG_THR = 3'h0;  // == RBR / DLL
    localparam logic [2:0] REG_IER = 3'h1;  // == DLM
    localparam logic [2:0] REG_FCR = 3'h2;  // == IIR (read)
    localparam logic [2:0] REG_LCR = 3'h3;
    localparam logic [2:0] REG_MCR = 3'h4;
    localparam logic [2:0] REG_LSR = 3'h5;
    localparam logic [2:0] REG_MSR = 3'h6;
    localparam logic [2:0] REG_SCR = 3'h7;

    // LSR bits OpenSBI's uart8250 polls: THRE (bit5) + TEMT (bit6) gate TX, and
    // it spins until THRE before each character.  Held set: the model never
    // back-pressures, so the transmit holding register is always "empty".
    localparam logic [7:0] LSR_THRE = 8'h20;
    localparam logic [7:0] LSR_TEMT = 8'h40;
    localparam logic [7:0] LSR_TX_IDLE = LSR_THRE | LSR_TEMT; // 0x60, DR=0

    // Programmable registers OpenSBI touches during uart8250_init (it sets the
    // baud divisor, LCR word length, FIFO control, etc.).  We store them so
    // reads return what was written; they have no line-level effect here.
    logic [7:0] ier_q, lcr_q, mcr_q, fcr_q, scr_q;
    logic [7:0] dll_q, dlm_q;
    logic       dlab;
    assign dlab = lcr_q[7];

    // ---- AXI4 single-outstanding bridge FSM (TX-side identical to the
    // CLINT shim, with a byte-register leaf folded in). ----
    typedef enum logic [2:0] { S_IDLE, S_WDATA, S_B, S_R } st_e;
    st_e st;

    logic [ID_W-1:0]     id_q;
    logic [LANE_LSB-1:2] lane_q;     // 32-bit lane index within the wide beat
    logic [LANE_LSB-1:0] byte_off_q; // full byte offset within the wide beat
    logic [2:0]          reg_q;      // selected byte register (addr[2:0])
    logic [31:0]         wdata_q;    // captured 32-bit write lane
    logic [7:0]          rdata_q;    // byte read result

    assign s_awready = (st == S_IDLE);
    assign s_arready = (st == S_IDLE) && !s_awvalid;
    assign s_wready  = (st == S_WDATA);

    assign s_bid    = id_q;
    assign s_bresp  = RESP_OKAY;
    assign s_rid    = id_q;
    assign s_rresp  = RESP_OKAY;
    assign s_rlast  = 1'b1;
    assign s_bvalid = (st == S_B);
    assign s_rvalid = (st == S_R);
    // Place the read byte at its true byte offset within the wide beat: a byte
    // read of, e.g., LSR at 0x..05 must appear in beat byte 5, not merely in the
    // low byte of the addressed 32-bit lane.  CVA6 extracts the byte by the full
    // access address, so a lane-only placement would return 0 for odd byte
    // offsets and the uart8250 driver would spin forever polling LSR.THRE.
    always_comb begin
        s_rdata = '0;
        s_rdata[{byte_off_q, 3'b0} +: 8] = rdata_q;
    end

    // Combinational read of the addressed register.
    function automatic logic [7:0] read_reg(input logic [2:0] r);
        unique case (r)
            REG_THR: read_reg = dlab ? dll_q : 8'h00;        // RBR: no RX data
            REG_IER: read_reg = dlab ? dlm_q : ier_q;
            REG_FCR: read_reg = 8'h01;                       // IIR: no irq pending
            REG_LCR: read_reg = lcr_q;
            REG_MCR: read_reg = mcr_q;
            REG_LSR: read_reg = LSR_TX_IDLE;                 // THRE|TEMT, DR=0
            REG_MSR: read_reg = 8'h00;
            REG_SCR: read_reg = scr_q;
            default: read_reg = 8'h00;
        endcase
    endfunction

    assign tx_byte_o = wdata_q[7:0];

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    assign unused = ^{s_awlen, s_awsize, s_awburst, s_arlen, s_arsize,
                      s_arburst, s_wlast, s_wstrb, fcr_q};
    /* verilator lint_on UNUSEDSIGNAL */

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st         <= S_IDLE;
            id_q       <= '0;
            lane_q     <= '0;
            byte_off_q <= '0;
            reg_q      <= '0;
            wdata_q    <= 32'h0;
            rdata_q    <= 8'h0;
            tx_valid_o <= 1'b0;
            ier_q      <= 8'h0;
            lcr_q      <= 8'h0;
            mcr_q      <= 8'h0;
            fcr_q      <= 8'h0;
            scr_q      <= 8'h0;
            dll_q      <= 8'h0;
            dlm_q      <= 8'h0;
        end else begin
            tx_valid_o <= 1'b0;
            unique case (st)
                S_IDLE: begin
                    if (s_awvalid && s_awready) begin
                        id_q   <= s_awid;
                        lane_q <= s_awaddr[LANE_LSB-1:2];
                        reg_q  <= s_awaddr[2:0];
                        st     <= S_WDATA;
                    end else if (s_arvalid && s_arready) begin
                        id_q       <= s_arid;
                        lane_q     <= s_araddr[LANE_LSB-1:2];
                        byte_off_q <= s_araddr[LANE_LSB-1:0];
                        rdata_q    <= read_reg(s_araddr[2:0]);
                        st         <= S_R;
                    end
                end
                S_WDATA: begin
                    if (s_wvalid && s_wready) begin
                        logic [31:0] lane_data;
                        logic [7:0]  byte_data;
                        lane_data = s_wdata[{lane_q, 5'b0} +: 32];
                        // Within the selected 32-bit lane the addressed byte is
                        // reg_q[1:0]; ns16550 registers are byte-wide.
                        byte_data = lane_data[{reg_q[1:0], 3'b0} +: 8];
                        wdata_q   <= lane_data;
                        unique case (reg_q)
                            REG_THR: begin
                                if (dlab) dll_q <= byte_data;
                                else begin
                                    // Console write: emit the byte.
                                    wdata_q[7:0] <= byte_data;
                                    tx_valid_o   <= 1'b1;
                                end
                            end
                            REG_IER: if (dlab) dlm_q <= byte_data;
                                     else       ier_q <= byte_data;
                            REG_FCR: fcr_q <= byte_data;
                            REG_LCR: lcr_q <= byte_data;
                            REG_MCR: mcr_q <= byte_data;
                            REG_SCR: scr_q <= byte_data;
                            default: begin end  // LSR/MSR read-only
                        endcase
                        st <= S_B;
                    end
                end
                S_B: if (s_bvalid && s_bready) st <= S_IDLE;
                S_R: if (s_rvalid && s_rready) st <= S_IDLE;
                default: st <= S_IDLE;
            endcase
        end
    end

    // tx_valid_o and wdata_q[7:0] are written by the same nonblocking
    // assignment cycle, so tx_byte_o (= wdata_q[7:0]) holds the transmitted
    // byte on the cycle tx_valid_o is high.

endmodule
