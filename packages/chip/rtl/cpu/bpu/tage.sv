// tage.sv — TAGE conditional direction predictor (5 tagged tables + bimodal).
//
// Read path: every table is indexed in parallel using its own folded history
// length. The longest-history tagged table that hits provides the direction;
// the next-longest hitting table is the "alternate" used by SC and the
// allocation decision. The bimodal serves as the default when no tagged table
// hits.
//
// Update path: when the prediction was wrong, walk from the longest table
// downward and find the first one whose useful field is zero (or which is
// invalid) and allocate it. If no entry has useful==0, the periodic reset
// (driven by `pmu_useful_reset_lsb/msb` from bpu_csr) will eventually free
// one. The direction counter of the hitting table is always updated toward
// the actual outcome.

`timescale 1ns/1ps

module tage
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    output logic                lkp_taken,
    output logic                lkp_taken_alt,
    output logic [TAGE_TABLES:0] lkp_hit_vec,
    output logic [$clog2(TAGE_TABLES+1)-1:0] lkp_provider,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic                upd_taken,
    input  logic                upd_misp,
    input  logic [$clog2(TAGE_TABLES+1)-1:0] upd_provider,

    input  logic                useful_reset_lsb,
    input  logic                useful_reset_msb,

    // Exposes the provider's direction counter so the SC override path can
    // detect a low-confidence prediction without a hierarchical reference
    // into per-table storage.
    output logic [TAGE_CTR_W-1:0] lkp_provider_ctr,

    output logic                pmu_alloc
);

    logic [TAGE_TABLES-1:0] tab_hit;
    logic [TAGE_TABLES-1:0] tab_taken;
    logic [TAGE_TABLES-1:0] tab_alloc_req;
    logic [TAGE_USEFUL_W-1:0] tab_useful [TAGE_TABLES];
    logic [TAGE_CTR_W-1:0] tab_ctr [TAGE_TABLES];
    logic [TAGE_TABLES-1:0] tab_alloc_pmu;

    logic                   bim_taken;
    /* verilator lint_off UNUSEDSIGNAL */
    // The bimodal counter is exported for SC reuse extensions; not consumed
    // by the TAGE arbitration today.
    logic [BIM_CTR_W-1:0]   bim_ctr;
    /* verilator lint_on UNUSEDSIGNAL */

    bimodal u_bimodal (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .lkp_taken  (bim_taken),
        .lkp_ctr    (bim_ctr),
        .upd_valid  (upd_valid),
        .upd_pc     (upd_pc),
        .upd_taken  (upd_taken)
    );

    // Generate the tagged tables. Each table uses its own history length.
    // History lengths come from individual localparams in bpu_pkg so the
    // package can be parsed by yosys (which does not yet accept array
    // localparams in port/declaration contexts).
    genvar gi;
    generate
        for (gi = 0; gi < TAGE_TABLES; gi++) begin : g_tab
            localparam int unsigned HL =
                (gi == 0) ? TAGE_HIST_LEN_0 :
                (gi == 1) ? TAGE_HIST_LEN_1 :
                (gi == 2) ? TAGE_HIST_LEN_2 :
                (gi == 3) ? TAGE_HIST_LEN_3 : TAGE_HIST_LEN_4;
            logic [HL-1:0] lkp_h_slice;
            logic [HL-1:0] upd_h_slice;
            assign lkp_h_slice = lkp_hist[TAGE_HIST_LEN_MAX-1 -: HL];
            assign upd_h_slice = upd_hist[TAGE_HIST_LEN_MAX-1 -: HL];

            // Per-table update gate: the table fires its counter / useful
            // update when it is the provider, and fires the allocation
            // path when the upper-level alloc picker selected it. Allocation
            // must not be gated by the provider equality, otherwise no
            // non-provider table can ever be allocated.
            logic upd_valid_g;
            assign upd_valid_g = upd_valid &&
                ((upd_provider == gi[$clog2(TAGE_TABLES+1)-1:0]+1) ||
                 tab_alloc_req[gi]);

            tage_table #(
                .TABLE_ID   (gi),
                .ENTRIES    (TAGE_ENTRIES_TABLE),
                .HIST_LEN   (HL)
            ) u_tab (
                .clk             (clk),
                .rst_n           (rst_n),
                .lkp_valid       (lkp_valid),
                .lkp_pc          (lkp_pc),
                .lkp_hist        (lkp_h_slice),
                .lkp_hit         (tab_hit[gi]),
                .lkp_taken       (tab_taken[gi]),
                .lkp_ctr         (tab_ctr[gi]),
                .lkp_useful      (tab_useful[gi]),
                .upd_valid       (upd_valid_g),
                .upd_pc          (upd_pc),
                .upd_hist        (upd_h_slice),
                .upd_taken       (upd_taken),
                .upd_correct     (!upd_misp),
                .upd_alloc       (tab_alloc_req[gi]),
                .upd_useful_inc  (upd_valid && !upd_misp &&
                                   (upd_provider == gi[$clog2(TAGE_TABLES+1)-1:0]+1)),
                .upd_useful_dec  (1'b0),
                .useful_reset_lsb(useful_reset_lsb),
                .useful_reset_msb(useful_reset_msb),
                .pmu_alloc       (tab_alloc_pmu[gi])
            );
        end
    endgenerate

    // -----------------------------------------------------------------------
    // Read-path arbitration: longest hitting table wins. Alternate is the
    // next-longest. Providers are encoded 0=bimodal, 1..TAGE_TABLES=table-i.
    // -----------------------------------------------------------------------
    logic [$clog2(TAGE_TABLES+1)-1:0] provider_pri;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [$clog2(TAGE_TABLES+1)-1:0] alt_pri;
    /* verilator lint_on UNUSEDSIGNAL */
    logic                              provider_taken;
    logic                              alt_taken;
    logic                              provider_found;
    logic                              alt_found;

    always_comb begin
        provider_pri   = '0;
        alt_pri        = '0;
        provider_taken = bim_taken;
        alt_taken      = bim_taken;
        provider_found = 1'b0;
        alt_found      = 1'b0;
        lkp_hit_vec    = {tab_hit, 1'b1};
        for (int ti = TAGE_TABLES-1; ti >= 0; ti--) begin
            if (tab_hit[ti]) begin
                if (!provider_found) begin
                    provider_found = 1'b1;
                    provider_pri   = ti[$clog2(TAGE_TABLES+1)-1:0] + 1;
                    provider_taken = tab_taken[ti];
                end else if (!alt_found) begin
                    alt_found = 1'b1;
                    alt_pri   = ti[$clog2(TAGE_TABLES+1)-1:0] + 1;
                    alt_taken = tab_taken[ti];
                end
            end
        end
        lkp_taken     = provider_found ? provider_taken : bim_taken;
        lkp_taken_alt = alt_found ? alt_taken : bim_taken;
        lkp_provider  = provider_pri;
        // Provider counter readout for SC. Zero when the bimodal provided.
        if (provider_found) begin
            lkp_provider_ctr = tab_ctr[provider_pri - 1];
        end else begin
            lkp_provider_ctr = '0;
        end
    end

    // -----------------------------------------------------------------------
    // Allocation policy on misprediction. Walk from upd_provider+1 upward
    // (i.e. longer histories) and allocate the first table whose useful
    // is zero. The decision is registered with the read snapshot via the
    // resolver feedback (the resolver replays the lookup so per-table
    // useful values are read again here on the upd cycle).
    // -----------------------------------------------------------------------
    logic [TAGE_TABLES-1:0] alloc_candidates;
    always_comb begin
        alloc_candidates = '0;
        tab_alloc_req    = '0;
        if (upd_valid && upd_misp) begin
            for (int unsigned ta = 0; ta < TAGE_TABLES; ta++) begin
                if (ta + 1 > upd_provider && tab_useful[ta] == '0)
                    alloc_candidates[ta] = 1'b1;
            end
            // Pick the lowest-index candidate. This matches the Seznec CBP-5
            // policy of allocating the shortest available table beyond the
            // provider so longer-history tables remain available for later
            // mispredictions.
            for (int unsigned tb = 0; tb < TAGE_TABLES; tb++) begin
                if (alloc_candidates[tb] && tab_alloc_req == '0)
                    tab_alloc_req[tb] = 1'b1;
            end
        end
    end

    assign pmu_alloc = |tab_alloc_pmu;

endmodule : tage
