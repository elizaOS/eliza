`timescale 1ns/1ps

// e1_uart: Basic 8N1 UART with 16-deep TX/RX FIFOs and programmable baud divider.
//
// MMIO interface matches e1_soc_top's single-cycle valid/write/addr/wdata/rdata style.
// addr is word-address (byte_addr[7:2]).
//
// Register map (byte offsets from base):
//   0x00  DATA     write -> enqueue TX byte, read -> dequeue RX byte
//   0x04  STATUS   RO: {27'b0, RX_OVERRUN, RX_FULL, RX_EMPTY, TX_FULL, TX_EMPTY}
//   0x08  CONTROL  RW: {29'b0, RX_IE, TX_IE, UART_EN}
//   0x0C  BAUD_DIV RW: clock divider (baud period in clk cycles; 0 = disable)
//
// Interrupt: level-sensitive, asserted when (RX FIFO non-empty && RX_IE) OR
//            (TX FIFO empty && TX_IE), all gated by UART_EN.

module e1_uart (
    input  logic        clk,
    input  logic        rst_n,

    // Simple MMIO slave interface (from e1_soc_top)
    input  logic        valid,
    input  logic        write,
    input  logic [5:0]  addr,     // byte_addr[7:2]
    input  logic [31:0] wdata,
    output logic [31:0] rdata,

    // Interrupt output
    output logic        irq,

    // UART physical pins
    output logic        tx,
    input  logic        rx
);

    // -----------------------------------------------------------------------
    // Parameters
    // -----------------------------------------------------------------------
    localparam int FIFO_DEPTH     = 16;
    localparam int FIFO_ADDR_BITS = 4;   // log2(FIFO_DEPTH)

    // -----------------------------------------------------------------------
    // Register addresses (word index = byte_offset >> 2)
    // -----------------------------------------------------------------------
    localparam logic [5:0] ADDR_DATA     = 6'h00;
    localparam logic [5:0] ADDR_STATUS   = 6'h01;
    localparam logic [5:0] ADDR_CONTROL  = 6'h02;
    localparam logic [5:0] ADDR_BAUD_DIV = 6'h03;

    // -----------------------------------------------------------------------
    // Control / baud registers
    // -----------------------------------------------------------------------
    logic        uart_en;
    logic        tx_ie;
    logic        rx_ie;
    logic [31:0] baud_div;

    // -----------------------------------------------------------------------
    // TX FIFO
    // -----------------------------------------------------------------------
    logic [7:0]              tx_fifo [0:FIFO_DEPTH-1];
    logic [FIFO_ADDR_BITS-1:0] tx_wr_ptr;
    logic [FIFO_ADDR_BITS-1:0] tx_rd_ptr;
    logic [FIFO_ADDR_BITS:0]   tx_count;
    wire                       tx_full  = tx_count == FIFO_DEPTH[FIFO_ADDR_BITS:0];
    wire                       tx_empty = tx_count == '0;

    // -----------------------------------------------------------------------
    // RX FIFO
    // -----------------------------------------------------------------------
    logic [7:0]              rx_fifo [0:FIFO_DEPTH-1];
    logic [FIFO_ADDR_BITS-1:0] rx_wr_ptr;
    logic [FIFO_ADDR_BITS-1:0] rx_rd_ptr;
    logic [FIFO_ADDR_BITS:0]   rx_count;
    wire                       rx_full  = rx_count == FIFO_DEPTH[FIFO_ADDR_BITS:0];
    wire                       rx_empty = rx_count == '0;
    logic                      rx_overrun;

    // -----------------------------------------------------------------------
    // Internal control pulses
    // -----------------------------------------------------------------------
    logic tx_load_byte;  // TX shift reg is consuming the head of the TX FIFO
    logic rx_push_byte;  // RX shift reg has a complete byte ready to enqueue
    logic [7:0] rx_byte_val; // byte captured by RX state machine

    // -----------------------------------------------------------------------
    // Baud tick generator
    // -----------------------------------------------------------------------
    logic [31:0] baud_cnt;
    wire  baud_tick = uart_en && (baud_div != 32'h0) && (baud_cnt == 32'h0);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            baud_cnt <= 32'h0;
        end else if (!uart_en || baud_div == 32'h0) begin
            baud_cnt <= 32'h0;
        end else if (baud_cnt == 32'h0) begin
            baud_cnt <= baud_div - 32'h1;
        end else begin
            baud_cnt <= baud_cnt - 32'h1;
        end
    end

    // -----------------------------------------------------------------------
    // TX state machine
    // -----------------------------------------------------------------------
    typedef enum logic [1:0] {
        TX_IDLE  = 2'b00,
        TX_START = 2'b01,
        TX_DATA  = 2'b10,
        TX_STOP  = 2'b11
    } tx_state_t;

    tx_state_t   tx_state;
    logic [7:0]  tx_shift;
    logic [2:0]  tx_bit_cnt;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tx_state     <= TX_IDLE;
            tx_shift     <= 8'hFF;
            tx_bit_cnt   <= 3'h0;
            tx           <= 1'b1;
            tx_load_byte <= 1'b0;
        end else begin
            tx_load_byte <= 1'b0;
            unique case (tx_state)
                TX_IDLE: begin
                    tx <= 1'b1;
                    if (!tx_empty && uart_en && baud_tick) begin
                        tx_shift     <= tx_fifo[tx_rd_ptr];
                        tx_load_byte <= 1'b1;
                        tx_state     <= TX_START;
                    end
                end
                TX_START: begin
                    tx <= 1'b0;
                    if (baud_tick) begin
                        tx_bit_cnt <= 3'h0;
                        tx_state   <= TX_DATA;
                    end
                end
                TX_DATA: begin
                    tx <= tx_shift[0];
                    if (baud_tick) begin
                        tx_shift <= {1'b1, tx_shift[7:1]};
                        if (tx_bit_cnt == 3'h7) begin
                            tx_state <= TX_STOP;
                        end else begin
                            tx_bit_cnt <= tx_bit_cnt + 3'h1;
                        end
                    end
                end
                TX_STOP: begin
                    tx <= 1'b1;
                    if (baud_tick) begin
                        tx_state <= TX_IDLE;
                    end
                end
            endcase
        end
    end

    // -----------------------------------------------------------------------
    // RX two-flop synchroniser
    // -----------------------------------------------------------------------
    logic rx_sync0, rx_sync1;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rx_sync0 <= 1'b1;
            rx_sync1 <= 1'b1;
        end else begin
            rx_sync0 <= rx;
            rx_sync1 <= rx_sync0;
        end
    end

    // -----------------------------------------------------------------------
    // RX state machine — samples mid-bit using its own baud counter
    // -----------------------------------------------------------------------
    typedef enum logic [1:0] {
        RX_IDLE  = 2'b00,
        RX_START = 2'b01,
        RX_DATA  = 2'b10,
        RX_STOP  = 2'b11
    } rx_state_t;

    rx_state_t   rx_state;
    logic [7:0]  rx_shift;
    logic [2:0]  rx_bit_cnt;
    logic [31:0] rx_baud_cnt;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rx_state     <= RX_IDLE;
            rx_shift     <= 8'h0;
            rx_bit_cnt   <= 3'h0;
            rx_baud_cnt  <= 32'h0;
            rx_push_byte <= 1'b0;
            rx_byte_val  <= 8'h0;
        end else begin
            rx_push_byte <= 1'b0;
            unique case (rx_state)
                RX_IDLE: begin
                    rx_baud_cnt <= 32'h0;
                    if (uart_en && baud_div != 32'h0 && !rx_sync1) begin
                        // Falling edge: load half-period to sample mid-start-bit
                        rx_baud_cnt <= (baud_div >> 1);
                        rx_state    <= RX_START;
                    end
                end
                RX_START: begin
                    if (rx_baud_cnt == 32'h0) begin
                        if (!rx_sync1) begin
                            rx_baud_cnt <= baud_div - 32'h1;
                            rx_bit_cnt  <= 3'h0;
                            rx_state    <= RX_DATA;
                        end else begin
                            rx_state <= RX_IDLE;  // false start
                        end
                    end else begin
                        rx_baud_cnt <= rx_baud_cnt - 32'h1;
                    end
                end
                RX_DATA: begin
                    if (rx_baud_cnt == 32'h0) begin
                        rx_shift    <= {rx_sync1, rx_shift[7:1]};
                        rx_baud_cnt <= baud_div - 32'h1;
                        if (rx_bit_cnt == 3'h7) begin
                            rx_state <= RX_STOP;
                        end else begin
                            rx_bit_cnt <= rx_bit_cnt + 3'h1;
                        end
                    end else begin
                        rx_baud_cnt <= rx_baud_cnt - 32'h1;
                    end
                end
                RX_STOP: begin
                    if (rx_baud_cnt == 32'h0) begin
                        rx_byte_val  <= {rx_sync1, rx_shift[7:1]};
                        rx_push_byte <= 1'b1;
                        rx_state     <= RX_IDLE;
                    end else begin
                        rx_baud_cnt <= rx_baud_cnt - 32'h1;
                    end
                end
            endcase
        end
    end

    // -----------------------------------------------------------------------
    // Control / baud register writes
    // -----------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            uart_en  <= 1'b0;
            tx_ie    <= 1'b0;
            rx_ie    <= 1'b0;
            baud_div <= 32'h0;
        end else begin
            if (valid && write) begin
                unique case (addr)
                    ADDR_CONTROL:  begin
                        uart_en <= wdata[0];
                        tx_ie   <= wdata[1];
                        rx_ie   <= wdata[2];
                    end
                    ADDR_BAUD_DIV: baud_div <= wdata;
                    default: begin end
                endcase
            end
        end
    end

    // -----------------------------------------------------------------------
    // TX FIFO management
    // -----------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tx_wr_ptr <= '0;
            tx_rd_ptr <= '0;
            tx_count  <= '0;
        end else begin
            if (valid && write && addr == ADDR_DATA && !tx_full) begin
                tx_fifo[tx_wr_ptr] <= wdata[7:0];
                tx_wr_ptr          <= tx_wr_ptr + 1'b1;
                tx_count           <= tx_count + 1'b1;
            end
            if (tx_load_byte) begin
                tx_rd_ptr <= tx_rd_ptr + 1'b1;
                tx_count  <= tx_count - 1'b1;
            end
        end
    end

    // -----------------------------------------------------------------------
    // RX FIFO management
    // -----------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rx_wr_ptr  <= '0;
            rx_rd_ptr  <= '0;
            rx_count   <= '0;
            rx_overrun <= 1'b0;
        end else begin
            if (rx_push_byte) begin
                if (rx_full) begin
                    rx_overrun <= 1'b1;
                end else begin
                    rx_fifo[rx_wr_ptr] <= rx_byte_val;
                    rx_wr_ptr          <= rx_wr_ptr + 1'b1;
                    rx_count           <= rx_count + 1'b1;
                end
            end
            if (valid && !write && addr == ADDR_DATA && !rx_empty) begin
                rx_rd_ptr <= rx_rd_ptr + 1'b1;
                rx_count  <= rx_count - 1'b1;
            end
            if (valid && !write && addr == ADDR_STATUS) begin
                rx_overrun <= 1'b0;
            end
        end
    end

    // -----------------------------------------------------------------------
    // MMIO reads
    // -----------------------------------------------------------------------
    always_comb begin
        unique case (addr)
            ADDR_DATA:     rdata = rx_empty ? 32'h0 : {24'h0, rx_fifo[rx_rd_ptr]};
            ADDR_STATUS:   rdata = {27'h0, rx_overrun, rx_full, rx_empty, tx_full, tx_empty};
            ADDR_CONTROL:  rdata = {29'h0, rx_ie, tx_ie, uart_en};
            ADDR_BAUD_DIV: rdata = baud_div;
            default:       rdata = 32'h0;
        endcase
    end

    // -----------------------------------------------------------------------
    // Interrupt
    // -----------------------------------------------------------------------
    assign irq = uart_en && ((!rx_empty && rx_ie) || (tx_empty && tx_ie));

endmodule
