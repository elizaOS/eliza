`timescale 1ns/1ps

// e1_aplic — RISC-V AIA Advanced Platform-Level Interrupt Controller (production).
//
// Implements the RISC-V Advanced Interrupt Architecture (AIA) APLIC in MSI
// delivery mode (DM=1): wired interrupt sources are configured per-source
// (sourcecfg), optionally delegated to a child domain, and each owning domain
// targets a source at a hart's IMSIC interrupt file by generating an MSI write
// (the seteipnum doorbell at rtl/interrupts/e1_imsic.sv). This is the modern
// RISC-V wire->MSI bridge Linux programs via the riscv,aplic DT binding; it is
// the complement to the classic PLIC at rtl/interrupts/e1_plic.sv.
//
// DOMAINS. Two interrupt domains: the machine (M) domain is the root/parent and
// the supervisor (S) domain is its child. The M domain owns every source whose
// sourcecfg.delegate is 0; a source with delegate=1 is handed to the S domain,
// which then owns its sourcecfg/target. This is the AIA domain hierarchy with
// M->S delegation (sourcecfg.D bit). Each domain has its own setienum/target
// state and emits MSIs independently.
//
// PER-SOURCE STATE (sources 1..NUM_SOURCES; source 0 reserved):
//   sourcecfg[s].sm  : source mode — 0=inactive, 1=edge(rising), 2=level(high).
//   sourcecfg[s].d   : delegate to child (S) domain.
//   ie[domain][s]    : interrupt-enable in the owning domain (setienum/clrienum).
//   target[domain][s]: { file, EIID, secure } — the destination IMSIC file
//                      index the MSI lands in (the AIA target Hart-Index field;
//                      MSI address = file * IMSIC_PAGE_BYTES), the interrupt
//                      identity written to seteipnum (EIID), and the
//                      secure-world qualifier (TEE lane 03).
//
// MSI GENERATION. A source is "asserted" per its mode (edge: a 0->1 transition
// pulses once; level: while the line is high). When an asserted source is
// enabled in its owning domain, the APLIC emits one MSI write to that source's
// target: msi_we_o pulses with msi_addr_o = target.hart * IMSIC_PAGE_BYTES (the
// IMSIC doorbell page for that file) and msi_id_o = target.EIID. A per-source
// "MSI in flight" interlock prevents re-emitting the same level source until it
// deasserts, so a held line yields exactly one MSI per assertion (re-arms on
// deassert), matching APLIC level-MSI semantics.
//
// SECURE-DOMAIN HOOK (docs/security/tee-plan/03-secure-io-iommu-npu.md §5).
// target[domain][s].secure drives msi_world_o on the emitted MSI. The IMSIC
// world gate then commits the MSI only to a file whose world matches. A source
// targeting the confidential domain (secure=1) lands only in the secure IMSIC
// file; a host/S target (secure=0) can never reach it. Programming of the
// secure target bits is a monitor-only privilege at the SoC integration layer
// (the M-domain register window is not mapped into S/host address space), so
// the host cannot retarget a source into the confidential domain.

module e1_aplic #(
    parameter int unsigned NUM_SOURCES = 4,    // sources 1..NUM_SOURCES
    parameter int unsigned NUM_IDS     = 63,   // max IMSIC interrupt identity
    // Number of addressable destination IMSIC files (flat file pages). The
    // target's file-index field selects one; the MSI address is index*page.
    parameter int unsigned NUM_TARGETS = 2,
    parameter int unsigned IMSIC_PAGE_BYTES = 4096,
    // Derived widths (computed from the above; not intended to be overridden).
    parameter int unsigned SRC_W  = $clog2(NUM_SOURCES + 1)
) (
    input  logic clk,
    input  logic rst_n,

    // Wired interrupt source lines; index 0 == source id 1.
    input  logic [NUM_SOURCES-1:0] irq_sources,

    // --- Configuration write port (driven by the domain register decode).
    // domain: 0 = M (machine/root), 1 = S (supervisor/child).
    input  logic               cfg_we_i,
    input  logic               cfg_domain_i,    // which domain owns this write
    input  logic [SRC_W-1:0]   cfg_src_i,       // source id 1..NUM_SOURCES
    input  logic [1:0]         cfg_field_i,     // 0=sourcecfg,1=ie,2=target
    input  logic [31:0]        cfg_wdata_i,     // field-specific payload

    // --- MSI emit port to the IMSIC doorbell (one shared write channel).
    output logic               msi_we_o,
    output logic [31:0]        msi_addr_o,      // IMSIC-window byte address of target file
    output logic [31:0]        msi_id_o,        // interrupt identity (EIID)
    output logic               msi_world_o      // 1 = secure/confidential world
);
    // domain 0 = M, domain 1 = S.
    localparam int unsigned NUM_DOMAINS = 2;
    localparam int unsigned PAGE_W = (NUM_TARGETS > 1) ? $clog2(NUM_TARGETS) : 1;
    localparam int unsigned EIID_W = $clog2(NUM_IDS + 1);

    // sourcecfg.sm encodings.
    localparam logic [1:0] SM_INACTIVE = 2'd0;
    localparam logic [1:0] SM_EDGE     = 2'd1;
    localparam logic [1:0] SM_LEVEL    = 2'd2;

    // cfg_field_i encodings.
    localparam logic [1:0] FIELD_SOURCECFG = 2'd0;
    localparam logic [1:0] FIELD_IE        = 2'd1;
    localparam logic [1:0] FIELD_TARGET    = 2'd2;

    // --- State -------------------------------------------------------------
    logic [1:0]        sm_q       [NUM_SOURCES+1];                 // source mode
    logic              deleg_q    [NUM_SOURCES+1];                 // delegate to S
    logic              ie_q       [NUM_DOMAINS][NUM_SOURCES+1];    // per-domain enable
    logic [PAGE_W-1:0] tgt_page_q [NUM_DOMAINS][NUM_SOURCES+1];    // dest IMSIC file index
    logic [EIID_W-1:0] tgt_eiid_q [NUM_DOMAINS][NUM_SOURCES+1];
    logic              tgt_secure_q[NUM_DOMAINS][NUM_SOURCES+1];

    // Edge detect + level-MSI interlock.
    logic [NUM_SOURCES:0] line_q;       // sampled source lines (for edge detect)
    logic [NUM_SOURCES:0] inflight_q;   // MSI emitted, awaiting line deassert

    logic [NUM_SOURCES:0] src_level;
    always_comb begin
        src_level = '0;
        for (int unsigned s = 1; s <= NUM_SOURCES; s++)
            src_level[s] = irq_sources[s-1];
    end

    // Owning domain of a source: S (1) if delegated, else M (0).
    function automatic logic owner(input logic [SRC_W-1:0] s);
        owner = deleg_q[s];
    endfunction

    // --- Assertion + arbitration: pick the lowest source id that wants an MSI.
    // A source "fires" when, in its owning domain, it is enabled and asserted:
    //   edge  : rising edge of the line and not already in flight,
    //   level : line high and not already in flight.
    // The interlock (inflight) makes a held line emit exactly one MSI per
    // assertion; it clears when the line deasserts.
    logic [NUM_SOURCES:0] fire;
    always_comb begin
        for (int unsigned s = 0; s <= NUM_SOURCES; s++) fire[s] = 1'b0;
        for (int unsigned s = 1; s <= NUM_SOURCES; s++) begin
            automatic logic d = owner(s[SRC_W-1:0]);
            automatic logic asserted =
                (sm_q[s] == SM_EDGE)  ? (src_level[s] && !line_q[s]) :
                (sm_q[s] == SM_LEVEL) ?  src_level[s]               : 1'b0;
            fire[s] = ie_q[d][s] && asserted && !inflight_q[s];
        end
    end

    // One MSI channel: emit for the lowest-id firing source this cycle.
    logic            emit;
    logic [SRC_W-1:0] emit_src;
    always_comb begin
        emit     = 1'b0;
        emit_src = '0;
        for (int unsigned s = NUM_SOURCES; s >= 1; s--) begin
            if (fire[s]) begin
                emit     = 1'b1;
                emit_src = s[SRC_W-1:0];
            end
        end
    end

    // MSI output: target of the emitting source in its owning domain.
    always_comb begin
        automatic logic d = owner(emit_src);
        msi_we_o    = emit;
        msi_addr_o  = emit ? ({{(32-PAGE_W){1'b0}}, tgt_page_q[d][emit_src]}
                              * IMSIC_PAGE_BYTES[31:0]) : 32'h0;
        msi_id_o    = emit ? {{(32-EIID_W){1'b0}}, tgt_eiid_q[d][emit_src]} : 32'h0;
        msi_world_o = emit ? tgt_secure_q[d][emit_src] : 1'b0;
    end

    // --- State update ------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned s = 0; s <= NUM_SOURCES; s++) begin
                sm_q[s]    <= SM_INACTIVE;
                deleg_q[s] <= 1'b0;
                for (int unsigned d = 0; d < NUM_DOMAINS; d++) begin
                    ie_q[d][s]         <= 1'b0;
                    tgt_page_q[d][s]   <= '0;
                    tgt_eiid_q[d][s]   <= '0;
                    tgt_secure_q[d][s] <= 1'b0;
                end
            end
            line_q     <= '0;
            inflight_q <= '0;
        end else begin
            line_q <= src_level;

            // Configuration writes (one source field per write).
            if (cfg_we_i && (cfg_src_i >= 1) && (cfg_src_i <= NUM_SOURCES[SRC_W-1:0])) begin
                automatic logic d = cfg_domain_i;
                unique case (cfg_field_i)
                    FIELD_SOURCECFG: begin
                        // Only the M (parent) domain owns sourcecfg/delegation.
                        if (!cfg_domain_i) begin
                            sm_q[cfg_src_i]    <= cfg_wdata_i[1:0];
                            deleg_q[cfg_src_i] <= cfg_wdata_i[2];
                        end
                    end
                    FIELD_IE: ie_q[d][cfg_src_i] <= cfg_wdata_i[0];
                    FIELD_TARGET: begin
                        // target payload: [PAGE_W-1:0]=dest file index,
                        // [16+:EIID_W]=EIID, [31]=secure-world qualifier.
                        tgt_page_q[d][cfg_src_i]   <= cfg_wdata_i[PAGE_W-1:0];
                        tgt_eiid_q[d][cfg_src_i]   <= cfg_wdata_i[16 +: EIID_W];
                        tgt_secure_q[d][cfg_src_i] <= cfg_wdata_i[31];
                    end
                    default: ;
                endcase
            end

            // MSI interlock: set on emit, clear when the source line deasserts.
            for (int unsigned s = 1; s <= NUM_SOURCES; s++) begin
                if (emit && (emit_src == s[SRC_W-1:0]))
                    inflight_q[s] <= 1'b1;
                else if (!src_level[s])
                    inflight_q[s] <= 1'b0;
            end
        end
    end

    // Reserved source 0 is never asserted.
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign unused = ^{cfg_wdata_i, fire[0], line_q[0], inflight_q[0]};

endmodule : e1_aplic
