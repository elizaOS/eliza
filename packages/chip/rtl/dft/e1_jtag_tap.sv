`timescale 1ns/1ps

// IEEE 1149.1 Test Access Port (TAP) controller for the Eliza E1 SoC.
//
// Implements the 16-state TAP state machine, a 5-bit instruction register,
// the mandatory data registers (BYPASS, IDCODE), and the SAMPLE/PRELOAD and
// EXTEST instructions. The boundary-scan register itself is NOT instantiated
// here: its width is the pad count, which is BLOCKED on the unfinalized pad
// inventory (docs/pd/pad-cell-selection-criteria.md). When SAMPLE/PRELOAD or
// EXTEST is selected, the data path falls back to BYPASS until the boundary
// register is generated from the final pad list (no faked width is asserted).
//
// IR width 5 matches pd/dft/mbist.yaml (jtag_tap_module: e1_jtag_tap,
// ir_width_bits: 5) and docs/pd/dft-strategy.md.

module e1_jtag_tap #(
    parameter logic [31:0] IDCODE_VALUE = 32'h0000_0001
) (
    input  logic tck,
    input  logic tms,
    input  logic tdi,
    input  logic trst_n,   // optional async TAP reset (active low)
    output logic tdo,
    output logic tdo_oe,    // TDO output enable (1 only in Shift-DR/Shift-IR)

    // Decoded controller status for on-chip consumers (MBIST, scan enable).
    output logic        test_logic_reset,
    output logic        capture_dr,
    output logic        shift_dr,
    output logic        update_dr,
    output logic [4:0]  ir
);

    // TAP state encoding (IEEE 1149.1 standard 16-state FSM).
    typedef enum logic [3:0] {
        TEST_LOGIC_RESET = 4'h0,
        RUN_TEST_IDLE    = 4'h1,
        SELECT_DR_SCAN   = 4'h2,
        CAPTURE_DR       = 4'h3,
        SHIFT_DR         = 4'h4,
        EXIT1_DR         = 4'h5,
        PAUSE_DR         = 4'h6,
        EXIT2_DR         = 4'h7,
        UPDATE_DR        = 4'h8,
        SELECT_IR_SCAN   = 4'h9,
        CAPTURE_IR       = 4'hA,
        SHIFT_IR         = 4'hB,
        EXIT1_IR         = 4'hC,
        PAUSE_IR         = 4'hD,
        EXIT2_IR         = 4'hE,
        UPDATE_IR        = 4'hF
    } tap_state_e;

    // Mandatory + supported instructions (IR width 5).
    localparam logic [4:0] INSTR_EXTEST  = 5'b00000;
    localparam logic [4:0] INSTR_SAMPLE  = 5'b00001;  // SAMPLE/PRELOAD
    localparam logic [4:0] INSTR_IDCODE  = 5'b00010;
    localparam logic [4:0] INSTR_BYPASS  = 5'b11111;  // all-ones = BYPASS (mandatory)

    tap_state_e state, next_state;

    // ---- TAP state machine -------------------------------------------------
    always_comb begin
        unique case (state)
            TEST_LOGIC_RESET: next_state = tms ? TEST_LOGIC_RESET : RUN_TEST_IDLE;
            RUN_TEST_IDLE:    next_state = tms ? SELECT_DR_SCAN    : RUN_TEST_IDLE;
            SELECT_DR_SCAN:   next_state = tms ? SELECT_IR_SCAN    : CAPTURE_DR;
            CAPTURE_DR:       next_state = tms ? EXIT1_DR          : SHIFT_DR;
            SHIFT_DR:         next_state = tms ? EXIT1_DR          : SHIFT_DR;
            EXIT1_DR:         next_state = tms ? UPDATE_DR         : PAUSE_DR;
            PAUSE_DR:         next_state = tms ? EXIT2_DR          : PAUSE_DR;
            EXIT2_DR:         next_state = tms ? UPDATE_DR         : SHIFT_DR;
            UPDATE_DR:        next_state = tms ? SELECT_DR_SCAN    : RUN_TEST_IDLE;
            SELECT_IR_SCAN:   next_state = tms ? TEST_LOGIC_RESET  : CAPTURE_IR;
            CAPTURE_IR:       next_state = tms ? EXIT1_IR          : SHIFT_IR;
            SHIFT_IR:         next_state = tms ? EXIT1_IR          : SHIFT_IR;
            EXIT1_IR:         next_state = tms ? UPDATE_IR         : PAUSE_IR;
            PAUSE_IR:         next_state = tms ? EXIT2_IR          : PAUSE_IR;
            EXIT2_IR:         next_state = tms ? UPDATE_IR         : SHIFT_IR;
            UPDATE_IR:        next_state = tms ? SELECT_DR_SCAN    : RUN_TEST_IDLE;
            default:          next_state = TEST_LOGIC_RESET;
        endcase
    end

    always_ff @(posedge tck or negedge trst_n) begin
        if (!trst_n) state <= TEST_LOGIC_RESET;
        else         state <= next_state;
    end

    assign test_logic_reset = (state == TEST_LOGIC_RESET);
    assign capture_dr       = (state == CAPTURE_DR);
    assign shift_dr         = (state == SHIFT_DR);
    assign update_dr        = (state == UPDATE_DR);

    // ---- Instruction register ----------------------------------------------
    // Shift register + shadow (UPDATE_IR-latched) instruction.
    logic [4:0] ir_shift;
    logic [4:0] ir_latched;

    always_ff @(posedge tck or negedge trst_n) begin
        if (!trst_n) begin
            ir_shift <= INSTR_IDCODE;
        end else if (state == CAPTURE_IR) begin
            // IEEE 1149.1: two LSBs captured as 01.
            ir_shift <= 5'b00001;
        end else if (state == SHIFT_IR) begin
            ir_shift <= {tdi, ir_shift[4:1]};
        end
    end

    always_ff @(posedge tck or negedge trst_n) begin
        if (!trst_n)                    ir_latched <= INSTR_IDCODE;
        else if (state == TEST_LOGIC_RESET) ir_latched <= INSTR_IDCODE;
        else if (state == UPDATE_IR)    ir_latched <= ir_shift;
    end

    assign ir = ir_latched;

    // ---- Data registers -----------------------------------------------------
    // BYPASS (single bit) and IDCODE (32-bit). The boundary-scan register for
    // SAMPLE/PRELOAD/EXTEST is BLOCKED on the pad inventory; those instructions
    // route through BYPASS so TDO stays well-defined without faking a width.
    logic        bypass_reg;
    logic [31:0] idcode_shift;

    always_ff @(posedge tck) begin
        if (state == CAPTURE_DR)      bypass_reg <= 1'b0;
        else if (state == SHIFT_DR)   bypass_reg <= tdi;
    end

    always_ff @(posedge tck) begin
        if (state == CAPTURE_DR)      idcode_shift <= IDCODE_VALUE;
        else if (state == SHIFT_DR)   idcode_shift <= {tdi, idcode_shift[31:1]};
    end

    // ---- TDO mux (updated on falling edge of TCK per IEEE 1149.1) ----------
    logic tdo_comb;
    always_comb begin
        if (state == SHIFT_IR) begin
            tdo_comb = ir_shift[0];
        end else if (state == SHIFT_DR) begin
            unique case (ir_latched)
                INSTR_IDCODE: tdo_comb = idcode_shift[0];
                // SAMPLE/PRELOAD and EXTEST select the boundary-scan register,
                // which is BLOCKED on the pad inventory; until it is generated
                // they route through BYPASS so TDO stays defined (no faked
                // boundary width). BYPASS itself is the all-ones instruction.
                INSTR_SAMPLE,
                INSTR_EXTEST,
                INSTR_BYPASS: tdo_comb = bypass_reg;
                default:      tdo_comb = bypass_reg;
            endcase
        end else begin
            tdo_comb = 1'b0;
        end
    end

    always_ff @(negedge tck or negedge trst_n) begin
        if (!trst_n) begin
            tdo    <= 1'b0;
            tdo_oe <= 1'b0;
        end else begin
            tdo    <= tdo_comb;
            tdo_oe <= (state == SHIFT_IR) || (state == SHIFT_DR);
        end
    end

endmodule
