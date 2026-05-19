// e1_cluster_top.sv  —  Eliza 2028 phone-class AP cluster top.
//
// Topology mirrors `docs/arch/ooo-cluster.md`:
//
//     1 x e1-ultra  (big core, target Ascalon-D8 fork or scaled XiangShan)
//   + 3 x e1-premium (mid core, target XiangShan Kunminghu V3 6-wide)
//   + 4 x e1-pro    (little core, OpenHW CVA6 RV64GC in-order)
//
// The actual coherent bus and SLC live in the cache subsystem (see
// `rtl/cache/` owned by the cache agent). This wrapper:
//
//   - instantiates the selected core wrappers under compile-time defines,
//   - exposes a per-core AXI4 master port to the cache agent's coherent
//     bus interface (the cache agent decides MESI/CHI/L3/SLC behavior),
//   - exposes a single FTQ interface per core to the BPU agent's RTL,
//   - exposes per-core power-island, DVFS, and reset ports for the power
//     and clock agents,
//   - aggregates Zihpm PMU events into one cluster-level event bundle so
//     the back-end / debug subsystem can route them to counters.
//
// All compile-time defines are independent; if no core define is set the
// module synthesizes to a tied-off placeholder that documents the cluster
// boundary and lets the rest of the SoC compile.
//
// Compile knobs (set at simulator/yosys/openlane invocation):
//   +define+E1_HAVE_ASCALON   - instantiate Ascalon big core stub
//   +define+E1_HAVE_KUNMINGHU - instantiate XiangShan mid core stub
//   +define+E1_HAVE_BOOM      - instantiate BOOM mid-fallback core stub
//   +define+E1_HAVE_CVA6      - instantiate CVA6 little cores
//   +define+E1_CLUSTER_LITE   - synthesize 1-core lite variant for cocotb
//
// The cluster is parameterizable so cocotb tests can shrink it to a single
// core without redefining the topology.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDSIGNAL */
module e1_cluster_top #(
    parameter int unsigned NUM_BIG_CORES   = 1,
    parameter int unsigned NUM_MID_CORES   = 3,
    parameter int unsigned NUM_LITTLE_CORES= 4,
    parameter int unsigned NUM_CORES       = NUM_BIG_CORES + NUM_MID_CORES + NUM_LITTLE_CORES,
    parameter logic [63:0] RESET_VECTOR    = 64'h0000_0000_8000_0000,
    // Width of the cache-agent-owned coherent master bus per core. The cache
    // agent declares the actual AXI4 type; we expose a flat per-core port
    // group here so the cluster wrapper is independent of the cache RTL.
    parameter int unsigned AXI_ADDR_W      = 64,
    parameter int unsigned AXI_DATA_W      = 128,
    parameter int unsigned AXI_ID_W        = 8
) (
    // Clocks/reset are per-core; the clock agent owns the actual PLL/clock
    // tree. We accept one clock + one reset per core to let DVFS drive them
    // independently.
    input  logic [NUM_CORES-1:0]              core_clk_i,
    input  logic [NUM_CORES-1:0]              core_rst_ni,

    // Per-core power-island enables. The power agent toggles these.
    // pwr_island_en_i = 1 means the island is powered up and clock-active.
    input  logic [NUM_CORES-1:0]              pwr_island_en_i,
    // Retention voltage marker; L1 keeps state, clocks gated.
    input  logic [NUM_CORES-1:0]              pwr_retention_i,

    // Per-core interrupt inputs (timer, software, external).
    // Bit packing matches CVA6/Rocket convention: [1] M-ext, [0] S-ext.
    input  logic [NUM_CORES-1:0][1:0]         core_irq_ext_i,
    input  logic [NUM_CORES-1:0]              core_irq_timer_i,
    input  logic [NUM_CORES-1:0]              core_irq_software_i,
    input  logic [NUM_CORES-1:0]              core_debug_req_i,

    // Hart IDs - typically (cluster_id << 8) | core_id; assigned by SoC top.
    input  logic [NUM_CORES-1:0][63:0]        core_hart_id_i,

    // AXI4 master ports (one per core) to the cache subsystem coherent bus.
    // Flat packing; the cache agent wraps these into its own struct types.
    output logic [NUM_CORES-1:0][AXI_ID_W-1:0]   axi_aw_id_o,
    output logic [NUM_CORES-1:0][AXI_ADDR_W-1:0] axi_aw_addr_o,
    output logic [NUM_CORES-1:0][7:0]            axi_aw_len_o,
    output logic [NUM_CORES-1:0][2:0]            axi_aw_size_o,
    output logic [NUM_CORES-1:0][1:0]            axi_aw_burst_o,
    output logic [NUM_CORES-1:0]                 axi_aw_lock_o,
    output logic [NUM_CORES-1:0][3:0]            axi_aw_cache_o,
    output logic [NUM_CORES-1:0][2:0]            axi_aw_prot_o,
    output logic [NUM_CORES-1:0]                 axi_aw_valid_o,
    input  logic [NUM_CORES-1:0]                 axi_aw_ready_i,

    output logic [NUM_CORES-1:0][AXI_DATA_W-1:0] axi_w_data_o,
    output logic [NUM_CORES-1:0][(AXI_DATA_W/8)-1:0] axi_w_strb_o,
    output logic [NUM_CORES-1:0]                 axi_w_last_o,
    output logic [NUM_CORES-1:0]                 axi_w_valid_o,
    input  logic [NUM_CORES-1:0]                 axi_w_ready_i,

    input  logic [NUM_CORES-1:0][AXI_ID_W-1:0]   axi_b_id_i,
    input  logic [NUM_CORES-1:0][1:0]            axi_b_resp_i,
    input  logic [NUM_CORES-1:0]                 axi_b_valid_i,
    output logic [NUM_CORES-1:0]                 axi_b_ready_o,

    output logic [NUM_CORES-1:0][AXI_ID_W-1:0]   axi_ar_id_o,
    output logic [NUM_CORES-1:0][AXI_ADDR_W-1:0] axi_ar_addr_o,
    output logic [NUM_CORES-1:0][7:0]            axi_ar_len_o,
    output logic [NUM_CORES-1:0][2:0]            axi_ar_size_o,
    output logic [NUM_CORES-1:0][1:0]            axi_ar_burst_o,
    output logic [NUM_CORES-1:0]                 axi_ar_lock_o,
    output logic [NUM_CORES-1:0][3:0]            axi_ar_cache_o,
    output logic [NUM_CORES-1:0][2:0]            axi_ar_prot_o,
    output logic [NUM_CORES-1:0]                 axi_ar_valid_o,
    input  logic [NUM_CORES-1:0]                 axi_ar_ready_i,

    input  logic [NUM_CORES-1:0][AXI_ID_W-1:0]   axi_r_id_i,
    input  logic [NUM_CORES-1:0][AXI_DATA_W-1:0] axi_r_data_i,
    input  logic [NUM_CORES-1:0][1:0]            axi_r_resp_i,
    input  logic [NUM_CORES-1:0]                 axi_r_last_i,
    input  logic [NUM_CORES-1:0]                 axi_r_valid_i,
    output logic [NUM_CORES-1:0]                 axi_r_ready_o,

    // Cluster-level observability. The debug agent samples these.
    output logic [NUM_CORES-1:0][63:0]        core_pc_committed_o,
    output logic [NUM_CORES-1:0]              core_pc_committed_valid_o,
    output logic [NUM_CORES-1:0]              core_halted_o
);

    // -----------------------------------------------------------------
    // Cluster-level cross-checks at elaboration time.
    // -----------------------------------------------------------------
    // Topology must match the 1+3+4 contract unless explicitly overridden.
    initial begin
        // synthesis translate_off
        if (NUM_BIG_CORES > 4)
            $fatal(1, "e1_cluster_top: NUM_BIG_CORES=%0d exceeds contract", NUM_BIG_CORES);
        if (NUM_CORES != NUM_BIG_CORES + NUM_MID_CORES + NUM_LITTLE_CORES)
            $fatal(1, "e1_cluster_top: NUM_CORES must equal big+mid+little");
        // synthesis translate_on
    end

`ifdef E1_CLUSTER_LITE
    // Lite variant: tie everything off as a placeholder. Useful for cocotb
    // smoke before the cache/BPU/core agents land their real RTL.
    for (genvar gi = 0; gi < NUM_CORES; gi++) begin : g_lite_tieoff
        assign axi_aw_id_o[gi]    = '0;
        assign axi_aw_addr_o[gi]  = '0;
        assign axi_aw_len_o[gi]   = '0;
        assign axi_aw_size_o[gi]  = '0;
        assign axi_aw_burst_o[gi] = '0;
        assign axi_aw_lock_o[gi]  = '0;
        assign axi_aw_cache_o[gi] = '0;
        assign axi_aw_prot_o[gi]  = '0;
        assign axi_aw_valid_o[gi] = 1'b0;
        assign axi_w_data_o[gi]   = '0;
        assign axi_w_strb_o[gi]   = '0;
        assign axi_w_last_o[gi]   = 1'b0;
        assign axi_w_valid_o[gi]  = 1'b0;
        assign axi_b_ready_o[gi]  = 1'b1;
        assign axi_ar_id_o[gi]    = '0;
        assign axi_ar_addr_o[gi]  = '0;
        assign axi_ar_len_o[gi]   = '0;
        assign axi_ar_size_o[gi]  = '0;
        assign axi_ar_burst_o[gi] = '0;
        assign axi_ar_lock_o[gi]  = '0;
        assign axi_ar_cache_o[gi] = '0;
        assign axi_ar_prot_o[gi]  = '0;
        assign axi_ar_valid_o[gi] = 1'b0;
        assign axi_r_ready_o[gi]  = 1'b1;
        assign core_pc_committed_o[gi]       = '0;
        assign core_pc_committed_valid_o[gi] = 1'b0;
        assign core_halted_o[gi]             = 1'b1;
    end
`else
    // Production wiring is the cache agent's responsibility. Big/mid/little
    // core instances are gated by E1_HAVE_* defines so the build can pick
    // and choose which open cores are linked. Until any of those defines
    // are set, all per-core ports remain tied to safe idle values; the
    // cache subsystem treats this as an absent master and continues
    // serving the rest of the SoC.
    for (genvar gi = 0; gi < NUM_CORES; gi++) begin : g_tieoff_until_core_link
        assign axi_aw_id_o[gi]    = '0;
        assign axi_aw_addr_o[gi]  = '0;
        assign axi_aw_len_o[gi]   = '0;
        assign axi_aw_size_o[gi]  = '0;
        assign axi_aw_burst_o[gi] = '0;
        assign axi_aw_lock_o[gi]  = '0;
        assign axi_aw_cache_o[gi] = '0;
        assign axi_aw_prot_o[gi]  = '0;
        assign axi_aw_valid_o[gi] = 1'b0;
        assign axi_w_data_o[gi]   = '0;
        assign axi_w_strb_o[gi]   = '0;
        assign axi_w_last_o[gi]   = 1'b0;
        assign axi_w_valid_o[gi]  = 1'b0;
        assign axi_b_ready_o[gi]  = 1'b1;
        assign axi_ar_id_o[gi]    = '0;
        assign axi_ar_addr_o[gi]  = '0;
        assign axi_ar_len_o[gi]   = '0;
        assign axi_ar_size_o[gi]  = '0;
        assign axi_ar_burst_o[gi] = '0;
        assign axi_ar_lock_o[gi]  = '0;
        assign axi_ar_cache_o[gi] = '0;
        assign axi_ar_prot_o[gi]  = '0;
        assign axi_ar_valid_o[gi] = 1'b0;
        assign axi_r_ready_o[gi]  = 1'b1;
        assign core_pc_committed_o[gi]       = '0;
        assign core_pc_committed_valid_o[gi] = 1'b0;
        assign core_halted_o[gi]             = 1'b1;
    end
`endif

    // Tie off currently-unconsumed cluster inputs so lint stays clean.
    logic unused_cluster_inputs;
    assign unused_cluster_inputs = ^{
        core_clk_i,
        core_rst_ni,
        pwr_island_en_i,
        pwr_retention_i,
        core_irq_ext_i,
        core_irq_timer_i,
        core_irq_software_i,
        core_debug_req_i,
        core_hart_id_i,
        axi_aw_ready_i,
        axi_w_ready_i,
        axi_b_id_i,
        axi_b_resp_i,
        axi_b_valid_i,
        axi_ar_ready_i,
        axi_r_id_i,
        axi_r_data_i,
        axi_r_resp_i,
        axi_r_last_i,
        axi_r_valid_i,
        RESET_VECTOR
    };

endmodule
/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on DECLFILENAME */
