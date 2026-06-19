`include "rtl/e1x/e1x_pkg.sv"

// March C- memory built-in self-test (MBIST) controller for one E1X local
// SRAM instance.
//
// March C- element sequence (w0 = write background, r/w = read-then-write):
//   M0: (w0)            ascending,  write 0 to every cell
//   M1: (r0, w1)        ascending,  expect 0, write 1
//   M2: (r1, w0)        ascending,  expect 1, write 0
//   M3: (r0, w1)        descending, expect 0, write 1
//   M4: (r1, w0)        descending, expect 1, write 0
//   M5: (r0)            descending, expect 0
//
// Coverage: stuck-at faults (SAF), transition faults (TF), and a class of
// coupling faults (CFin/CFid) addressed by the alternating ascending/
// descending read-then-write order. The data background is a single bit
// replicated across the word; per the DFT strategy the controller is run
// multiple times with checkerboard/inverse backgrounds at signoff, but the
// RTL-proven core here is the address/march sequencer over one background.
//
// The controller drives a generic single-port synchronous SRAM (we/addr/
// wdata + 1-cycle-latent rdata). A behavioral SRAM model with an optional
// stuck-at fault-injection port is instantiated inside the module so the
// block is self-contained and Verilator-clean. When INJECT_ENABLE == 0 the
// injection logic is tied off and optimizes away, matching the production
// configuration where the controller wraps a foundry SRAM macro.
//
// Synthesizable. The behavioral SRAM is replaced by the foundry macro during
// the PD flow; the sequencer FSM and the pass/fail/failing-address reporting
// are the RTL-proven artifact (see docs/arch/e1x-dft.md).

module e1x_mbist #(
  parameter int DATA_BITS  = 32,
  parameter int DEPTH      = 64,                 // SRAM words walked by the test
  parameter int ADDR_BITS  = (DEPTH <= 1) ? 1 : $clog2(DEPTH),
  // Fault injection (verification only). When INJECT_ENABLE==0 the port is
  // unused and the model behaves as a clean SRAM.
  parameter bit INJECT_ENABLE = 1'b0
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic start_i,            // pulse to begin a self-test run

  // Fault-injection controls (only meaningful when INJECT_ENABLE==1).
  input  logic                 inject_valid_i, // sample the injection target
  input  logic [ADDR_BITS-1:0] inject_addr_i,
  input  logic [4:0]           inject_bit_i,   // which bit of the word is stuck
  input  logic                 inject_value_i, // value the bit is stuck at

  output logic                 busy_o,
  output logic                 done_o,
  output logic                 fail_o,
  output logic [ADDR_BITS-1:0] fail_addr_o,
  output logic [4:0]           fail_bit_o,      // first failing bit index
  output logic [DATA_BITS-1:0] fail_expected_o,
  output logic [DATA_BITS-1:0] fail_actual_o
);
  localparam logic [DATA_BITS-1:0] BG0 = '0;
  localparam logic [DATA_BITS-1:0] BG1 = '1;

  // ---- March element encoding -----------------------------------------
  typedef enum logic [3:0] {
    S_IDLE,
    S_M0,        // up:   w0
    S_M1_R,      // up:   r0
    S_M1_W,      // up:   w1
    S_M2_R,      // up:   r1
    S_M2_W,      // up:   w0
    S_M3_R,      // down: r0
    S_M3_W,      // down: w1
    S_M4_R,      // down: r1
    S_M4_W,      // down: w0
    S_M5_R,      // down: r0
    S_DONE,
    S_FAILED
  } state_e;

  state_e                 state_q, state_d;
  logic [ADDR_BITS-1:0]   addr_q,  addr_d;
  logic                   busy_q,  busy_d;
  logic                   done_q,  done_d;
  logic                   fail_q,  fail_d;
  logic [ADDR_BITS-1:0]   fail_addr_q, fail_addr_d;
  logic [4:0]             fail_bit_q,  fail_bit_d;
  logic [DATA_BITS-1:0]   fail_exp_q,  fail_exp_d;
  logic [DATA_BITS-1:0]   fail_act_q,  fail_act_d;

  // SRAM interface signals driven by the FSM.
  logic                   sram_we;
  logic [ADDR_BITS-1:0]   sram_addr;
  logic [DATA_BITS-1:0]   sram_wdata;
  logic [DATA_BITS-1:0]   sram_rdata;

  // A read issued this cycle returns data next cycle; we track what we expect.
  logic                   check_pending_q;
  logic [DATA_BITS-1:0]   check_expected_q;
  logic [ADDR_BITS-1:0]   check_addr_q;
  logic                   check_pending_d;
  logic [DATA_BITS-1:0]   check_expected_d;
  logic [ADDR_BITS-1:0]   check_addr_d;

  localparam logic [ADDR_BITS-1:0] ADDR_LAST = ADDR_BITS'(DEPTH - 1);
  localparam logic [ADDR_BITS-1:0] ADDR_ZERO = '0;

  function automatic logic is_read_state(state_e s);
    return (s == S_M1_R) || (s == S_M2_R) || (s == S_M3_R) ||
           (s == S_M4_R) || (s == S_M5_R);
  endfunction

  // First mismatching bit (lowest index) between expected and actual.
  function automatic logic [4:0] first_diff_bit(
      logic [DATA_BITS-1:0] exp, logic [DATA_BITS-1:0] act);
    logic [4:0] idx;
    idx = 5'd0;
    for (int unsigned b = 0; b < DATA_BITS; b++) begin
      if (exp[b] != act[b]) begin
        idx = b[4:0];
        break;
      end
    end
    return idx;
  endfunction

  // ---- Next-state / datapath ------------------------------------------
  always_comb begin
    state_d          = state_q;
    addr_d           = addr_q;
    busy_d           = busy_q;
    done_d           = done_q;
    fail_d           = fail_q;
    fail_addr_d      = fail_addr_q;
    fail_bit_d       = fail_bit_q;
    fail_exp_d       = fail_exp_q;
    fail_act_d       = fail_act_q;
    check_pending_d  = 1'b0;
    check_expected_d = check_expected_q;
    check_addr_d     = check_addr_q;

    sram_we    = 1'b0;
    sram_addr  = addr_q;
    sram_wdata = BG0;

    // Evaluate a pending read result (data is valid this cycle for the read
    // issued last cycle). On mismatch, latch the failing address/bit and stop.
    if (check_pending_q && state_q != S_IDLE) begin
      if (sram_rdata != check_expected_q) begin
        fail_d      = 1'b1;
        fail_addr_d = check_addr_q;
        fail_exp_d  = check_expected_q;
        fail_act_d  = sram_rdata;
        fail_bit_d  = first_diff_bit(check_expected_q, sram_rdata);
        busy_d      = 1'b0;
        done_d      = 1'b1;
        state_d     = S_FAILED;
      end
    end

    if (state_d != S_FAILED) begin
      unique case (state_q)
        S_IDLE: begin
          if (start_i) begin
            busy_d = 1'b1;
            done_d = 1'b0;
            fail_d = 1'b0;
            addr_d = ADDR_ZERO;
            state_d = S_M0;
          end
        end

        // M0: ascending w0
        S_M0: begin
          sram_we    = 1'b1;
          sram_addr  = addr_q;
          sram_wdata = BG0;
          if (addr_q == ADDR_LAST) begin
            addr_d  = ADDR_ZERO;
            state_d = S_M1_R;
          end else begin
            addr_d = addr_q + 1'b1;
          end
        end

        // M1: ascending (r0, w1) -- issue read, next cycle write at same addr
        S_M1_R: begin
          sram_addr        = addr_q;
          check_pending_d  = 1'b1;
          check_expected_d = BG0;
          check_addr_d     = addr_q;
          state_d          = S_M1_W;
        end
        S_M1_W: begin
          sram_we    = 1'b1;
          sram_addr  = addr_q;
          sram_wdata = BG1;
          if (addr_q == ADDR_LAST) begin
            addr_d  = ADDR_ZERO;
            state_d = S_M2_R;
          end else begin
            addr_d  = addr_q + 1'b1;
            state_d = S_M1_R;
          end
        end

        // M2: ascending (r1, w0)
        S_M2_R: begin
          sram_addr        = addr_q;
          check_pending_d  = 1'b1;
          check_expected_d = BG1;
          check_addr_d     = addr_q;
          state_d          = S_M2_W;
        end
        S_M2_W: begin
          sram_we    = 1'b1;
          sram_addr  = addr_q;
          sram_wdata = BG0;
          if (addr_q == ADDR_LAST) begin
            addr_d  = ADDR_LAST;
            state_d = S_M3_R;
          end else begin
            addr_d  = addr_q + 1'b1;
            state_d = S_M2_R;
          end
        end

        // M3: descending (r0, w1)
        S_M3_R: begin
          sram_addr        = addr_q;
          check_pending_d  = 1'b1;
          check_expected_d = BG0;
          check_addr_d     = addr_q;
          state_d          = S_M3_W;
        end
        S_M3_W: begin
          sram_we    = 1'b1;
          sram_addr  = addr_q;
          sram_wdata = BG1;
          if (addr_q == ADDR_ZERO) begin
            addr_d  = ADDR_LAST;
            state_d = S_M4_R;
          end else begin
            addr_d  = addr_q - 1'b1;
            state_d = S_M3_R;
          end
        end

        // M4: descending (r1, w0)
        S_M4_R: begin
          sram_addr        = addr_q;
          check_pending_d  = 1'b1;
          check_expected_d = BG1;
          check_addr_d     = addr_q;
          state_d          = S_M4_W;
        end
        S_M4_W: begin
          sram_we    = 1'b1;
          sram_addr  = addr_q;
          sram_wdata = BG0;
          if (addr_q == ADDR_ZERO) begin
            addr_d  = ADDR_LAST;
            state_d = S_M5_R;
          end else begin
            addr_d  = addr_q - 1'b1;
            state_d = S_M4_R;
          end
        end

        // M5: descending (r0)
        S_M5_R: begin
          sram_addr        = addr_q;
          check_pending_d  = 1'b1;
          check_expected_d = BG0;
          check_addr_d     = addr_q;
          if (addr_q == ADDR_ZERO) begin
            state_d = S_DONE;
          end else begin
            addr_d = addr_q - 1'b1;
          end
        end

        S_DONE: begin
          busy_d = 1'b0;
          done_d = 1'b1;
        end

        default: begin
          state_d = state_q;
        end
      endcase
    end
  end

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      state_q          <= S_IDLE;
      addr_q           <= '0;
      busy_q           <= 1'b0;
      done_q           <= 1'b0;
      fail_q           <= 1'b0;
      fail_addr_q      <= '0;
      fail_bit_q       <= '0;
      fail_exp_q       <= '0;
      fail_act_q       <= '0;
      check_pending_q  <= 1'b0;
      check_expected_q <= '0;
      check_addr_q     <= '0;
    end else begin
      state_q          <= state_d;
      addr_q           <= addr_d;
      busy_q           <= busy_d;
      done_q           <= done_d;
      fail_q           <= fail_d;
      fail_addr_q      <= fail_addr_d;
      fail_bit_q       <= fail_bit_d;
      fail_exp_q       <= fail_exp_d;
      fail_act_q       <= fail_act_d;
      check_pending_q  <= check_pending_d;
      check_expected_q <= check_expected_d;
      check_addr_q     <= check_addr_d;
    end
  end

  assign busy_o          = busy_q;
  assign done_o          = done_q;
  assign fail_o          = fail_q;
  assign fail_addr_o     = fail_addr_q;
  assign fail_bit_o      = fail_bit_q;
  assign fail_expected_o = fail_exp_q;
  assign fail_actual_o   = fail_act_q;

  // ---- Behavioral SRAM with optional stuck-at injection ----------------
  // Replaced by the foundry SRAM macro in the PD flow. The injection path is
  // a verification affordance; when INJECT_ENABLE==0 it is tied off.
  logic [DATA_BITS-1:0] mem [DEPTH-1:0];
  logic                 inj_active_q;
  logic [ADDR_BITS-1:0] inj_addr_q;
  logic [4:0]           inj_bit_q;
  logic                 inj_value_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      inj_active_q <= 1'b0;
      inj_addr_q   <= '0;
      inj_bit_q    <= '0;
      inj_value_q  <= 1'b0;
    end else if (INJECT_ENABLE && inject_valid_i) begin
      inj_active_q <= 1'b1;
      inj_addr_q   <= inject_addr_i;
      inj_bit_q    <= inject_bit_i;
      inj_value_q  <= inject_value_i;
    end
  end

  logic [DATA_BITS-1:0] wdata_eff;
  always_comb begin
    wdata_eff = sram_wdata;
    if (INJECT_ENABLE && inj_active_q && sram_addr == inj_addr_q
        && {1'b0, inj_bit_q} < DATA_BITS[5:0]) begin
      wdata_eff[inj_bit_q] = inj_value_q;
    end
  end

  logic [DATA_BITS-1:0] rdata_q;
  always_ff @(posedge clk_i) begin
    if (sram_we) begin
      mem[sram_addr] <= wdata_eff;
    end
    rdata_q <= mem[sram_addr];
  end
  assign sram_rdata = rdata_q;
endmodule
