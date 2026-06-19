// bpu_to_zihpm_remap.sv  —  BPU PMU bundle to Zihpm event-bus adapter.
//
// The BPU agent emits a 27-entry `pmu_event_e` stream (5-bit ID) declared in
// `rtl/cpu/bpu/bpu_pkg.sv`. The CSR-visible Zihpm event encoding declared in
// `rtl/cpu/csr/zihpm.sv` is the authoritative system contract (OoO/CSR is
// canonical for the cross-domain PMU surface). The two enumerations differ
// in three observable ways:
//
//   1. EVT_NONE = 0 in Zihpm. BPU IDs start at 0 with PMU_BR_PRED, so each
//      BPU event must be shifted by +1 before driving the Zihpm event bus.
//   2. Within the branch block, the BPU enum places PMU_BR_TAKEN at id=1 and
//      PMU_BR_MISP at id=2; the Zihpm enum places EVT_BR_TAKEN at id=2 and
//      EVT_BR_MISP at id=3 after EVT_NONE. The remap rewires by *name*, not
//      by raw id.
//   3. The BPU enum names the FTB miss event `PMU_FTB_MISS`. The Zihpm enum
//      calls the same architectural event `EVT_BTB_MISS` (BTB is the
//      published name in the RVA23 manual). The remap binds these together.
//
// This file documents the canonical wiring and instantiates the explicit
// strobe-by-strobe translation. The BPU agent owns its enum and we do not
// mutate it from this domain; if a future BPU revision aligns its enum with
// Zihpm naming and ordering, this adapter degenerates to a single shift.
//
// The adapter is purely combinational: every BPU strobe in the input bundle
// turns into the corresponding bit in the output event bus, with the
// remaining bits of the 256-bit Zihpm event bus left for the cache, IOMMU,
// memory, and OoO-back-end agents to drive.
//
// Verification: `scripts/check_pmu_event_alignment.py` parses both packages
// and proves the mapping is total (every BPU event lands in exactly one
// Zihpm slot) and unique (no two BPU events alias to the same Zihpm slot).
// The same checker fails closed if either side adds an event without
// updating this adapter and the host check.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDPARAM */
module bpu_to_zihpm_remap
    import bpu_pkg::*;
    import zihpm_pkg::*;
#(
    parameter int unsigned EVT_BUS_W = 256
) (
    // BPU PMU strobes: bit `i` asserted means BPU event id `i` fired this
    // cycle (i.e. PMU_BR_PRED when i==0, PMU_BR_TAKEN when i==1, etc.)
    input  logic [PMU_EVENTS-1:0]      bpu_strobes_i,

    // Zihpm event bus. Only the bits the BPU domain owns are driven; all
    // other bits are tied to 0 here and merged at the cluster level by the
    // `event_bus_or` aggregator.
    output logic [EVT_BUS_W-1:0]       zihpm_evbus_o
);

    // Compile-time sanity: the BPU and Zihpm enums must each enumerate
    // PMU_EVENTS=27 named events in the branch block.
    initial begin
        // synthesis translate_off
        if (PMU_EVENTS != 32'd27) begin
            $fatal(1, "bpu_to_zihpm_remap: PMU_EVENTS=%0d, expected 27", PMU_EVENTS);
        end
        // synthesis translate_on
    end

    always_comb begin
        zihpm_evbus_o = '0;

        // Branch / front-end remap, name-equal across enums.
        zihpm_evbus_o[EVT_BR_PRED]        = bpu_strobes_i[PMU_BR_PRED];
        zihpm_evbus_o[EVT_BR_TAKEN]       = bpu_strobes_i[PMU_BR_TAKEN];
        zihpm_evbus_o[EVT_BR_MISP]        = bpu_strobes_i[PMU_BR_MISP];
        zihpm_evbus_o[EVT_BR_COND]        = bpu_strobes_i[PMU_BR_COND];
        zihpm_evbus_o[EVT_BR_COND_MISP]   = bpu_strobes_i[PMU_BR_COND_MISP];
        zihpm_evbus_o[EVT_BR_IND]         = bpu_strobes_i[PMU_BR_IND];
        zihpm_evbus_o[EVT_BR_IND_MISP]    = bpu_strobes_i[PMU_BR_IND_MISP];
        zihpm_evbus_o[EVT_BR_CALL]        = bpu_strobes_i[PMU_BR_CALL];
        zihpm_evbus_o[EVT_BR_RET]         = bpu_strobes_i[PMU_BR_RET];
        zihpm_evbus_o[EVT_BR_RET_MISP]    = bpu_strobes_i[PMU_BR_RET_MISP];
        zihpm_evbus_o[EVT_RAS_OVERFLOW]   = bpu_strobes_i[PMU_RAS_OVERFLOW];
        zihpm_evbus_o[EVT_RAS_UNDERFLOW]  = bpu_strobes_i[PMU_RAS_UNDERFLOW];
        zihpm_evbus_o[EVT_FTQ_FULL]       = bpu_strobes_i[PMU_FTQ_FULL];
        zihpm_evbus_o[EVT_FTQ_EMPTY]      = bpu_strobes_i[PMU_FTQ_EMPTY];
        zihpm_evbus_o[EVT_FETCH_BUBBLE]   = bpu_strobes_i[PMU_FETCH_BUBBLE];
        // FTB_MISS (BPU) is the same architectural event as BTB_MISS (Zihpm).
        zihpm_evbus_o[EVT_BTB_MISS]       = bpu_strobes_i[PMU_FTB_MISS];
        zihpm_evbus_o[EVT_UFTB_HIT]       = bpu_strobes_i[PMU_UFTB_HIT];
        zihpm_evbus_o[EVT_TAGE_ALLOC]     = bpu_strobes_i[PMU_TAGE_ALLOC];
        zihpm_evbus_o[EVT_LOOP_HIT]       = bpu_strobes_i[PMU_LOOP_HIT];
        zihpm_evbus_o[EVT_SC_OVERRIDE]    = bpu_strobes_i[PMU_SC_OVERRIDE];
        zihpm_evbus_o[EVT_H2P_OVERRIDE]   = bpu_strobes_i[PMU_H2P_OVERRIDE];
        zihpm_evbus_o[EVT_L2_BTB_HIT]     = bpu_strobes_i[PMU_L2_FTB_HIT];
        zihpm_evbus_o[EVT_L2_BTB_MISS]    = bpu_strobes_i[PMU_L2_FTB_MISS];
        zihpm_evbus_o[EVT_TWO_AHEAD_REDIRECT] =
            bpu_strobes_i[PMU_TWO_AHEAD_REDIRECT];
        zihpm_evbus_o[EVT_LOCAL_DIR_OVERRIDE] =
            bpu_strobes_i[PMU_LOCAL_DIR_OVERRIDE];
        zihpm_evbus_o[EVT_BPU_META_TRAIN] = bpu_strobes_i[PMU_META_TRAIN];
        zihpm_evbus_o[EVT_L2_BTB_LATE_REDIRECT] =
            bpu_strobes_i[PMU_L2_FTB_LATE_REDIRECT];
    end

endmodule
/* verilator lint_on UNUSEDPARAM */
/* verilator lint_on DECLFILENAME */
