// ras.sv — Return Address Stack with split speculative/architectural pointers
// and overflow counter per entry.
//
// The architectural stack tracks committed call/return pairs. The speculative
// stack tracks predicted call/return pairs and is restored from a snapshot on
// misprediction. Each entry carries an `RAS_OVERFLOW_W`-bit counter so that a
// burst of pushes against a full stack does not silently corrupt the depth
// (the counter increments on overflow push and decrements on the matching
// return, restoring the original top once it reaches zero).
//
// Push happens on JAL/JALR with rd=x1 or x5. Pop happens on JALR with
// rs1=x1 or x5 and rd=x0. The detection logic lives in the front-end
// pre-decoder; this module receives a clean push/pop strobe pair.
//
// Resolver feedback can restore the speculative top via `restore_valid` /
// `restore_top` to the snapshot captured at prediction time.

`timescale 1ns/1ps

module ras
    import bpu_pkg::*;
(
    input  logic                   clk,
    input  logic                   rst_n,

    // Speculative push/pop interface from the prediction path.
    input  logic                   spec_push,
    input  logic [VADDR_W-1:0]     spec_push_addr,
    input  logic                   spec_pop,
    output logic [VADDR_W-1:0]     spec_top_addr,
    output logic                   spec_top_valid,
    output logic [RAS_IDX_W:0]     spec_top_idx,

    // Architectural commit interface from the resolver.
    input  logic                   commit_push,
    input  logic [VADDR_W-1:0]     commit_push_addr,
    input  logic                   commit_pop,

    // Speculative-state restore on misprediction.
    input  logic                   restore_valid,
    input  logic [RAS_IDX_W:0]     restore_top,

    // PMU strobes
    output logic                   pmu_overflow,
    output logic                   pmu_underflow
);

    typedef struct packed {
        logic [VADDR_W-1:0]        addr;
        logic [RAS_OVERFLOW_W-1:0] ovf;
        logic                      valid;
    } ras_entry_t;

    // Storage is sized to the speculative depth; architectural state is the
    // tail of the same array that has been confirmed by the resolver. The
    // architectural pointer never crosses the speculative pointer; redirects
    // truncate the speculative tail back to the snapshot.
    ras_entry_t spec_stack_q [RAS_SPEC_ENTRIES];
    ras_entry_t arch_stack_q [RAS_ARCH_ENTRIES];

    // Pointers point to the slot one past the top of stack (write index).
    logic [RAS_IDX_W:0] spec_sp_q;
    logic [$clog2(RAS_ARCH_ENTRIES+1)-1:0] arch_sp_q;

    logic spec_full;
    logic spec_empty;

    assign spec_full  = (spec_sp_q == RAS_SPEC_ENTRIES[RAS_IDX_W:0]);
    assign spec_empty = (spec_sp_q == '0);

    // Speculative top read. When the SP is zero we cannot pop and the
    // consumer must treat `spec_top_valid` as zero.
    always_comb begin
        if (spec_empty) begin
            spec_top_addr  = '0;
            spec_top_valid = 1'b0;
            spec_top_idx   = '0;
        end else begin
            spec_top_addr  = spec_stack_q[spec_sp_q - 1'b1].addr;
            spec_top_valid = spec_stack_q[spec_sp_q - 1'b1].valid;
            spec_top_idx   = spec_sp_q;
        end
    end

    integer i;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            spec_sp_q <= '0;
            arch_sp_q <= '0;
            for (i = 0; i < RAS_SPEC_ENTRIES; i++) begin
                spec_stack_q[i] <= '{addr:'0, ovf:'0, valid:1'b0};
            end
            for (i = 0; i < RAS_ARCH_ENTRIES; i++) begin
                arch_stack_q[i] <= '{addr:'0, ovf:'0, valid:1'b0};
            end
            pmu_overflow  <= 1'b0;
            pmu_underflow <= 1'b0;
        end else begin
            pmu_overflow  <= 1'b0;
            pmu_underflow <= 1'b0;

            // Resolver-driven restore wins over the prediction path because
            // a misprediction implies the speculative state was wrong.
            if (restore_valid) begin
                spec_sp_q <= restore_top;
            end else begin
                // Push and pop are mutually exclusive in a single cycle for a
                // single fetch block under the MVP geometry.
                if (spec_push && !spec_pop) begin
                    if (spec_full) begin
                        // Increment the overflow counter on the current top
                        // rather than overwriting any architectural entry.
                        spec_stack_q[RAS_SPEC_ENTRIES-1].ovf <=
                            spec_stack_q[RAS_SPEC_ENTRIES-1].ovf + 1'b1;
                        pmu_overflow <= 1'b1;
                    end else begin
                        spec_stack_q[spec_sp_q] <= '{
                            addr: spec_push_addr,
                            ovf:  '0,
                            valid: 1'b1
                        };
                        spec_sp_q <= spec_sp_q + 1'b1;
                    end
                end else if (spec_pop && !spec_push) begin
                    if (spec_empty) begin
                        pmu_underflow <= 1'b1;
                    end else if (spec_stack_q[spec_sp_q - 1'b1].ovf != '0) begin
                        spec_stack_q[spec_sp_q - 1'b1].ovf <=
                            spec_stack_q[spec_sp_q - 1'b1].ovf - 1'b1;
                    end else begin
                        spec_stack_q[spec_sp_q - 1'b1].valid <= 1'b0;
                        spec_sp_q <= spec_sp_q - 1'b1;
                    end
                end
            end

            // Architectural commit path. Mirrors the speculative semantics but
            // uses the smaller architectural ring. Architectural pushes that
            // overflow simply drop the bottom of the stack — the speculative
            // path keeps the more recent state for redirects.
            if (commit_push && !commit_pop) begin
                if (arch_sp_q == RAS_ARCH_ENTRIES[$clog2(RAS_ARCH_ENTRIES+1)-1:0]) begin
                    // Drop the bottom: shift down by one.
                    for (i = 0; i < RAS_ARCH_ENTRIES-1; i++) begin
                        arch_stack_q[i] <= arch_stack_q[i+1];
                    end
                    arch_stack_q[RAS_ARCH_ENTRIES-1] <= '{
                        addr: commit_push_addr,
                        ovf:  '0,
                        valid: 1'b1
                    };
                end else begin
                    arch_stack_q[arch_sp_q] <= '{
                        addr: commit_push_addr,
                        ovf:  '0,
                        valid: 1'b1
                    };
                    arch_sp_q <= arch_sp_q + 1'b1;
                end
            end else if (commit_pop && !commit_push) begin
                if (arch_sp_q != '0) begin
                    arch_stack_q[arch_sp_q - 1'b1].valid <= 1'b0;
                    arch_sp_q <= arch_sp_q - 1'b1;
                end
            end
        end
    end

endmodule : ras
