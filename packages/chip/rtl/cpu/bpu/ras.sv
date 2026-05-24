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

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

// Renamed from `ras` to `e1_bpu_ras` to avoid a global module name
// collision with CVA6 v5.3.0's `external/cva6/cva6/core/frontend/ras.sv`
// when the integrated SoC build links both source trees (in-band
// `+define+E1_HAVE_CVA6 +define+E1_CLUSTER_SLOT0_CVA6`).  Verilator
// uses the first global definition of a module name it sees; renaming
// the e1 module to a uniquely-qualified name resolves the conflict
// without patching CVA6's source tree. The file name is kept as
// `ras.sv` so the cocotb test wrappers (ras_tb.sv) keep matching the
// rest of the BPU file-naming convention; the resulting
// DECLFILENAME warning is silenced explicitly.
/* verilator lint_off DECLFILENAME */
module e1_bpu_ras (
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

    input  logic                   flush,

    // Speculative-state restore on misprediction.
    input  logic                   restore_valid,
    input  logic [RAS_IDX_W:0]     restore_top,
    input  logic                   restore_entry_valid,
    input  logic [VADDR_W-1:0]     restore_entry_addr,

    // PMU strobes
    output logic                   pmu_overflow,
    output logic                   pmu_underflow
`ifdef FORMAL
    ,
    output logic [RAS_IDX_W:0]     formal_spec_sp,
    output logic [$clog2(RAS_ARCH_ENTRIES+1)-1:0] formal_arch_sp
`endif
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

`ifdef FORMAL
    assign formal_spec_sp = spec_sp_q;
    assign formal_arch_sp = arch_sp_q;
`endif

    logic spec_full;
    logic spec_empty;

    assign spec_full  = (spec_sp_q == RAS_SPEC_ENTRIES[RAS_IDX_W:0]);
    assign spec_empty = (spec_sp_q == '0);

    // Speculative top read. When the SP is zero we cannot pop and the
    // consumer must treat `spec_top_valid` as zero.
    logic [RAS_IDX_W-1:0] spec_top_rdaddr;
    assign spec_top_rdaddr = spec_sp_q[RAS_IDX_W-1:0] - 1'b1;

    ras_entry_t spec_top_entry;
    assign spec_top_entry = spec_stack_q[spec_top_rdaddr];

    // Working temporaries used by the always_ff push/pop paths. Declared
    // at module scope so the yosys 0.64 frontend can reason about them as
    // ordinary signals rather than block-local automatic variables.
    ras_entry_t spec_push_entry_n;
    ras_entry_t spec_pop_entry_n;
    ras_entry_t spec_pop_ovf_entry_n;
    ras_entry_t spec_restore_entry_n;
    ras_entry_t arch_push_entry_n;
    ras_entry_t arch_pop_entry_n;

    logic [$clog2(RAS_ARCH_ENTRIES)-1:0] arch_sp_top_rdaddr;
    assign arch_sp_top_rdaddr = arch_sp_q[$clog2(RAS_ARCH_ENTRIES)-1:0] - 1'b1;

    always_comb begin
        spec_push_entry_n        = '0;
        spec_push_entry_n.addr   = spec_push_addr;
        spec_push_entry_n.ovf    = '0;
        spec_push_entry_n.valid  = 1'b1;

        spec_pop_entry_n         = spec_top_entry;
        spec_pop_entry_n.valid   = 1'b0;

        spec_pop_ovf_entry_n     = spec_top_entry;
        spec_pop_ovf_entry_n.ovf = (spec_top_entry.ovf != '0)
                                    ? (spec_top_entry.ovf - 1'b1) : '0;

        spec_restore_entry_n       = '0;
        spec_restore_entry_n.addr  = restore_entry_addr;
        spec_restore_entry_n.ovf   = '0;
        spec_restore_entry_n.valid = restore_entry_valid;

        arch_push_entry_n        = '0;
        arch_push_entry_n.addr   = commit_push_addr;
        arch_push_entry_n.ovf    = '0;
        arch_push_entry_n.valid  = 1'b1;

        arch_pop_entry_n         = arch_stack_q[arch_sp_top_rdaddr];
        arch_pop_entry_n.valid   = 1'b0;
    end

    always_comb begin
        if (spec_empty && arch_sp_q != '0) begin
            spec_top_addr  = arch_stack_q[arch_sp_top_rdaddr].addr;
            spec_top_valid = arch_stack_q[arch_sp_top_rdaddr].valid;
            spec_top_idx   = '0;
        end else if (spec_empty) begin
            spec_top_addr  = '0;
            spec_top_valid = 1'b0;
            spec_top_idx   = '0;
        end else begin
            spec_top_addr  = spec_top_entry.addr;
            spec_top_valid = spec_top_entry.valid;
            spec_top_idx   = spec_sp_q;
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            spec_sp_q <= '0;
            arch_sp_q <= '0;
            for (int unsigned i = 0; i < RAS_SPEC_ENTRIES; i++) begin
                spec_stack_q[i] <= '0;
            end
            for (int unsigned i = 0; i < RAS_ARCH_ENTRIES; i++) begin
                arch_stack_q[i] <= '0;
            end
            pmu_overflow  <= 1'b0;
            pmu_underflow <= 1'b0;
        end else begin
            pmu_overflow  <= 1'b0;
            pmu_underflow <= 1'b0;

            if (flush) begin
                spec_sp_q <= '0;
                arch_sp_q <= '0;
                for (int unsigned i = 0; i < RAS_SPEC_ENTRIES; i++) begin
                    spec_stack_q[i] <= '0;
                end
                for (int unsigned i = 0; i < RAS_ARCH_ENTRIES; i++) begin
                    arch_stack_q[i] <= '0;
                end
            end else begin
            // Resolver-driven restore wins over the prediction path because
            // a misprediction implies the speculative state was wrong. A
            // resolved call still has to seed the restored speculative stack
            // with its committed return address; otherwise a call redirect
            // trains architectural state but leaves the next return with an
            // empty or stale speculative top.
            if (restore_valid) begin
                if (commit_push && !commit_pop &&
                    restore_top != RAS_SPEC_ENTRIES[RAS_IDX_W:0]) begin
                    spec_sp_q <= restore_top + 1'b1;
                end else if (commit_pop && !commit_push && restore_top != '0) begin
                    spec_sp_q <= restore_top - 1'b1;
                end else begin
                    spec_sp_q <= restore_top;
                end
                if (restore_top != '0 && restore_entry_valid) begin
                    spec_stack_q[restore_top[RAS_IDX_W-1:0] - 1'b1] <=
                        spec_restore_entry_n;
                end
                if (commit_push && !commit_pop) begin
                    if (restore_top == RAS_SPEC_ENTRIES[RAS_IDX_W:0]) begin
                        spec_stack_q[RAS_SPEC_ENTRIES-1].ovf <=
                            spec_stack_q[RAS_SPEC_ENTRIES-1].ovf + 1'b1;
                        pmu_overflow <= 1'b1;
                    end else begin
                        spec_stack_q[restore_top[RAS_IDX_W-1:0]] <= arch_push_entry_n;
                    end
                end else if (commit_pop && !commit_push) begin
                    if (restore_top == '0) begin
                        pmu_underflow <= 1'b1;
                    end else begin
                        spec_stack_q[restore_top[RAS_IDX_W-1:0] - 1'b1] <= spec_pop_entry_n;
                    end
                end
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
                        // Whole-struct write at the indexed location keeps the
                        // yosys 0.64 frontend happy (no member-specific writes
                        // with a non-constant array index).
                        spec_stack_q[spec_sp_q[RAS_IDX_W-1:0]] <= spec_push_entry_n;
                        spec_sp_q <= spec_sp_q + 1'b1;
                    end
                end else if (spec_pop && !spec_push) begin
                    if (spec_empty) begin
                        if (arch_sp_q == '0) begin
                            pmu_underflow <= 1'b1;
                        end
                    end else if (spec_top_entry.ovf != '0) begin
                        spec_stack_q[spec_top_rdaddr] <= spec_pop_ovf_entry_n;
                    end else begin
                        spec_stack_q[spec_top_rdaddr] <= spec_pop_entry_n;
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
                    for (int unsigned i = 0; i < RAS_ARCH_ENTRIES-1; i++) begin
                        arch_stack_q[i] <= arch_stack_q[i+1];
                    end
                    arch_stack_q[RAS_ARCH_ENTRIES-1].addr  <= commit_push_addr;
                    arch_stack_q[RAS_ARCH_ENTRIES-1].ovf   <= '0;
                    arch_stack_q[RAS_ARCH_ENTRIES-1].valid <= 1'b1;
                end else begin
                    arch_stack_q[arch_sp_q[$clog2(RAS_ARCH_ENTRIES)-1:0]] <= arch_push_entry_n;
                    arch_sp_q <= arch_sp_q + 1'b1;
                end
            end else if (commit_pop && !commit_push) begin
                if (arch_sp_q != '0) begin
                    arch_stack_q[arch_sp_top_rdaddr] <= arch_pop_entry_n;
                    arch_sp_q <= arch_sp_q - 1'b1;
                end
            end
            end
        end
    end

endmodule : e1_bpu_ras
/* verilator lint_on DECLFILENAME */
