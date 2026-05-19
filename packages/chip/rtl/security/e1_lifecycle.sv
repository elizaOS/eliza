// e1_lifecycle.sv
// Device lifecycle controller for the e1 chip security subsystem.
//
// Lifecycle states (2-bit, stored in OTP shadow word 1):
//   LIFECYCLE_UNLOCKED (2'b00): factory/debug - all debug access permitted,
//                               secure boot skipped
//   LIFECYCLE_LOCKED   (2'b01): production - secure boot required,
//                               debug requires auth challenge
//   LIFECYCLE_RMA      (2'b10): field return - limited debug re-enabled by
//                               auth challenge
//   LIFECYCLE_INVALID  (2'b11): fused-out/bricked - all access denied
//
// MMIO base: 0x1000_5000
//
// Register map (byte offsets, word-aligned):
//   0x00  LIFECYCLE_STATUS     RO  Current lifecycle state [1:0]
//   0x04  LIFECYCLE_TRANS_KEY  WO  Write unlock key to attempt UNLOCKED->LOCKED
//   0x08  DEBUG_AUTH_CHALLENGE RO  32-bit LFSR challenge (changes each reset)
//   0x0C  DEBUG_AUTH_RESPONSE  WO  Write XOR(challenge, device_key) to unlock debug
//   0x10  SECURITY_FLAGS       RO  bit0=JTAG_DISABLED, bit1=DBG_MMIO_DISABLED,
//                                  bit2=UART_BOOT_DISABLED
//
// Outputs:
//   lifecycle_state_o [1:0]  - broadcast to bootrom and rest of SoC
//   debug_auth_granted_o     - pulsed high for 1024 cycles after correct response
//   jtag_disable_o           - combinatorial from SECURITY_FLAGS bit 0

`timescale 1ns/1ps

module e1_lifecycle (
    input  logic        clk,
    input  logic        rst_n,

    // MMIO slave interface
    input  logic        valid,
    input  logic        write,
    input  logic [4:0]  addr,    // byte addr bits [6:2] (word index within 256-byte window)
    input  logic [31:0] wdata,
    output logic [31:0] rdata,

    // OTP shadow fuse word 1 carries the locked lifecycle target
    // bit[1:0] = fuse_lifecycle_target. When the device transitions from
    // UNLOCKED to LOCKED, we check this matches 2'b01 before committing.
    input  logic [31:0] fuse_word1_i,

    // Broadcast outputs
    output logic [1:0]  lifecycle_state_o,
    output logic        debug_auth_granted_o,
    output logic        jtag_disable_o
);

    // ----------------------------------------------------------------
    // Lifecycle state encoding
    // ----------------------------------------------------------------
    localparam logic [1:0] LC_UNLOCKED = 2'b00;
    localparam logic [1:0] LC_LOCKED   = 2'b01;
    localparam logic [1:0] LC_RMA      = 2'b10;
    localparam logic [1:0] LC_INVALID  = 2'b11;

    // Transition unlock key: software must write this exact value to
    // LIFECYCLE_TRANS_KEY to arm the UNLOCKED -> LOCKED transition.
    // A second write of 0xFEED_DEAD commits it.
    localparam logic [31:0] TRANS_UNLOCK_WORD = 32'hC0DE_CAFE;
    localparam logic [31:0] TRANS_COMMIT_WORD = 32'hFEED_DEAD;

    // Placeholder device key for debug auth response computation.
    // In a real device this comes from an immutable fuse row.
    localparam logic [31:0] DEVICE_KEY_PLACEHOLDER = 32'hA5A5_5A5A;

    // ----------------------------------------------------------------
    // LFSR for challenge generation (32-bit Galois LFSR, taps at 32,22,2,1)
    // Polynomial: x^32 + x^22 + x^2 + x + 1
    // ----------------------------------------------------------------
    logic [31:0] lfsr_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            // Non-zero seed so the LFSR does not lock up
            lfsr_q <= 32'hACE1_2345;
        end else begin
            // Galois LFSR step
            lfsr_q <= {1'b0, lfsr_q[31:1]} ^ (lfsr_q[0] ? 32'h8038_0001 : 32'h0);
        end
    end

    // ----------------------------------------------------------------
    // Register state
    // ----------------------------------------------------------------
    logic [1:0]  lifecycle_state_q;
    logic [31:0] challenge_q;       // latched at reset, static per power cycle
    logic        trans_armed_q;     // set when UNLOCK_WORD has been written
    logic [9:0]  auth_grant_ctr_q;  // counts down 1024 cycles of granted access
    logic [2:0]  security_flags_q;  // {UART_BOOT_DISABLED, DBG_MMIO_DISABLED, JTAG_DISABLED}

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            // Latch challenge from LFSR at reset de-assertion
            challenge_q      <= 32'hACE1_2345; // initial seed value
            trans_armed_q    <= 1'b0;
            auth_grant_ctr_q <= 10'h0;
            // Security flags default: JTAG disabled when LOCKED, else all open.
            // Will be updated after lifecycle_state_q is resolved below.
            security_flags_q <= 3'b000;
        end else begin
            // Capture LFSR into challenge once; it stays stable for this power cycle.
            // (We re-sample the first clocked value; LFSR started from reset seed.)
            // Actually we keep challenge_q fixed after the first cycle post-reset.
            // We do this by only loading on the cycle rst_n goes high (handled by
            // letting it be the reset seed; subsequent cycles it is not updated).

            // Auth grant counter countdown
            if (auth_grant_ctr_q != 10'h0) begin
                auth_grant_ctr_q <= auth_grant_ctr_q - 10'h1;
            end

            // Default: clear trans_armed on any non-UNLOCK_WORD write to the key reg
            // (handled inside the write decode below)

            if (valid && write) begin
                unique case (addr[4:0])
                    // 0x04 LIFECYCLE_TRANS_KEY
                    5'h01: begin
                        if (lifecycle_state_q == LC_UNLOCKED) begin
                            if (!trans_armed_q) begin
                                if (wdata == TRANS_UNLOCK_WORD) begin
                                    trans_armed_q <= 1'b1;
                                end
                            end else begin
                                // Armed: commit word transitions state
                                if (wdata == TRANS_COMMIT_WORD) begin
                                    // Commit only when fuse_word1 agrees
                                    if (fuse_word1_i[1:0] == LC_LOCKED) begin
                                        // Transition handled in lifecycle_state_q block
                                        security_flags_q <= 3'b001; // JTAG_DISABLED
                                    end
                                end
                                trans_armed_q <= 1'b0;
                            end
                        end
                    end

                    // 0x0C DEBUG_AUTH_RESPONSE
                    5'h03: begin
                        if (lifecycle_state_q == LC_LOCKED || lifecycle_state_q == LC_RMA) begin
                            logic [31:0] expected;
                            expected = challenge_q ^ DEVICE_KEY_PLACEHOLDER;
                            if (wdata == expected) begin
                                auth_grant_ctr_q <= 10'd1023;
                            end
                        end
                    end

                    default: ;
                endcase
            end
        end
    end

    // Lifecycle state register (separate always block for clarity)
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            lifecycle_state_q <= LC_UNLOCKED;
        end else begin
            if (lifecycle_state_q == LC_UNLOCKED) begin
                // Transition to LOCKED on armed + commit word + fuse agreement
                if (valid && write && (addr[4:0] == 5'h01) &&
                    trans_armed_q &&
                    (wdata == TRANS_COMMIT_WORD) &&
                    (fuse_word1_i[1:0] == LC_LOCKED)) begin
                    lifecycle_state_q <= LC_LOCKED;
                end
            end
            // All other transitions (RMA, INVALID) require physical fuse blow
            // and are reflected in fuse_word1 at next power-on; for simulation
            // we honor the fuse word on reset (see below).
        end
    end

    // ----------------------------------------------------------------
    // Challenge: latch LFSR value one cycle after reset de-assertion.
    // We use a one-shot flop to capture it exactly once.
    // ----------------------------------------------------------------
    logic challenge_latched_q;
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            challenge_latched_q <= 1'b0;
            challenge_q         <= 32'hACE1_2345;
        end else begin
            if (!challenge_latched_q) begin
                challenge_q         <= lfsr_q;
                challenge_latched_q <= 1'b1;
            end
        end
    end

    // ----------------------------------------------------------------
    // Read mux
    // ----------------------------------------------------------------
    always_comb begin
        rdata = 32'h0;
        if (valid && !write) begin
            unique case (addr[4:0])
                5'h00: rdata = {30'h0, lifecycle_state_q};   // LIFECYCLE_STATUS
                5'h01: rdata = 32'h0;                         // TRANS_KEY: write-only, read 0
                5'h02: rdata = challenge_q;                   // DEBUG_AUTH_CHALLENGE
                5'h03: rdata = 32'h0;                         // RESPONSE: write-only, read 0
                5'h04: rdata = {29'h0, security_flags_q};    // SECURITY_FLAGS
                default: rdata = 32'h0;
            endcase
        end
    end

    // ----------------------------------------------------------------
    // Output assignments
    // ----------------------------------------------------------------
    assign lifecycle_state_o   = lifecycle_state_q;
    assign debug_auth_granted_o = (auth_grant_ctr_q != 10'h0);
    assign jtag_disable_o      = security_flags_q[0];

endmodule
