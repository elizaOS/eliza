// e1_rot_reset_seq.sv
// E1 root-of-trust reset sequencer.
//
// Implements the cold-boot reset ordering of docs/security/tee-plan/
// 02-root-of-trust.md S1: on cold boot ONLY the RoT Ibex runs its mask ROM.
// The CVA6 application cluster and the PMC are held in reset until the mask-ROM
// secure-boot verifier asserts `boot_verified_i` AND the IOPMP source-ID policy
// has been programmed (`iopmp_policy_ready_i`, feeding lane 03). Only then are
// the application cores released.
//
// Fail-closed law (CLAUDE.md / AGENTS.md): if `boot_verified_i` never asserts,
// the cores stay in reset forever. There is no timeout that releases them, no
// "secure-mode bypass", and no unsigned fallback. A lifecycle SCRAP state
// (`lc_scrap_i`) latches a hard halt that can never release the platform.
//
// Synthesizable: single clock, single synchronous-release async-assert reset,
// no initial blocks, no delays.

`timescale 1ns/1ps

module e1_rot_reset_seq (
    input  logic clk_i,
    input  logic rst_ni,            // RoT power-on reset (async assert)

    // Secure-boot verdict from the mask-ROM verifier (R2/R3). One-shot strobe;
    // the sequencer latches it. Must be the result of a real signature +
    // measurement check -- never tied high in production.
    input  logic boot_verified_i,

    // IOPMP source-ID policy programmed by the RoT (lane 03). The application
    // cluster is not released until I/O is default-deny gated.
    input  logic iopmp_policy_ready_i,

    // Lifecycle SCRAP: device is fused-out. Latches a permanent halt.
    input  logic lc_scrap_i,

    // Reset outputs. Active-low resets handed to the downstream domains: the
    // domain is HELD IN RESET while the line is 0, RELEASED when 1.
    output logic rot_rst_no,        // RoT Ibex: released first, immediately
    output logic cva6_rst_no,       // CVA6 application cluster
    output logic pmc_rst_no,        // PMC (power/DVFS/thermal; a RoT client)

    // Observability for the gate / cocotb. One-hot would be over-engineered;
    // a small enum is enough.
    output logic [2:0] state_o,
    output logic       platform_released_o,
    output logic       halted_o
);

  // ----------------------------------------------------------------
  // FSM
  // ----------------------------------------------------------------
  typedef enum logic [2:0] {
    ST_ROT_RESET  = 3'd0,  // power-on: everything in reset
    ST_ROT_RUN    = 3'd1,  // RoT released; AP/PMC held; waiting for verdict
    ST_WAIT_IOPMP = 3'd2,  // boot verified; waiting for IOPMP policy program
    ST_RELEASED   = 3'd3,  // AP cluster + PMC released
    ST_HALT       = 3'd4   // fail-closed terminal: SCRAP or never-verified
  } state_e;

  state_e state_q, state_d;

  always_comb begin
    state_d = state_q;
    unique case (state_q)
      ST_ROT_RESET: begin
        // Release the RoT itself one cycle after reset deassertion so its
        // mask ROM can start. SCRAP traps immediately.
        state_d = lc_scrap_i ? ST_HALT : ST_ROT_RUN;
      end
      ST_ROT_RUN: begin
        if (lc_scrap_i) begin
          state_d = ST_HALT;
        end else if (boot_verified_i) begin
          state_d = ST_WAIT_IOPMP;
        end
        // else: stay here indefinitely -- fail-closed, no timeout release.
      end
      ST_WAIT_IOPMP: begin
        if (lc_scrap_i) begin
          state_d = ST_HALT;
        end else if (iopmp_policy_ready_i) begin
          state_d = ST_RELEASED;
        end
      end
      ST_RELEASED: begin
        // Terminal-success: once the platform is up it stays up for this power
        // cycle. SCRAP can still force a halt (alert-handler escalation path).
        if (lc_scrap_i) begin
          state_d = ST_HALT;
        end
      end
      ST_HALT: begin
        state_d = ST_HALT;  // sticky; only a power-on reset clears it
      end
      default: state_d = ST_HALT;
    endcase
  end

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      state_q <= ST_ROT_RESET;
    end else begin
      state_q <= state_d;
    end
  end

  // ----------------------------------------------------------------
  // Reset line decode. Active-low: 0 = held in reset, 1 = released.
  // ----------------------------------------------------------------
  always_comb begin
    // Default everything held in reset (fail-closed default).
    rot_rst_no  = 1'b0;
    cva6_rst_no = 1'b0;
    pmc_rst_no  = 1'b0;
    unique case (state_q)
      ST_ROT_RESET: begin
        rot_rst_no  = 1'b0;
      end
      ST_ROT_RUN: begin
        rot_rst_no  = 1'b1;  // RoT runs
      end
      ST_WAIT_IOPMP: begin
        rot_rst_no  = 1'b1;
      end
      ST_RELEASED: begin
        rot_rst_no  = 1'b1;
        cva6_rst_no = 1'b1;  // application cluster released
        pmc_rst_no  = 1'b1;  // PMC released
      end
      ST_HALT: begin
        // Everything stays in reset. The RoT is also halted so it cannot be
        // coerced into re-attempting the release path after a SCRAP/escalation.
        rot_rst_no  = 1'b0;
      end
      default: ;
    endcase
  end

  assign state_o             = state_q;
  assign platform_released_o = (state_q == ST_RELEASED);
  assign halted_o            = (state_q == ST_HALT);

endmodule : e1_rot_reset_seq
