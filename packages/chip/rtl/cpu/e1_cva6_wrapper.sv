// e1_cva6_wrapper.sv  —  CVA6 integration wrapper for the e1-chip SoC
//
// Drop-in replacement for `e1_cpu_subsystem_stub`. Presents a flat AXI4
// master port + interrupt inputs + observability outputs and, under
// `+define+E1_HAVE_CVA6`, instantiates the OpenHW Group CVA6 RV64GC core
// pinned to v5.3.0 (commit 2ef1c1b1fca419354920c5487293bc605294904e) in
// `external/cva6/cva6/`.
//
// API contract (v5.3.0 and current HEAD):
//   - module           cva6
//   - config struct    config_pkg::cva6_cfg_t
//                      built from cva6_config_pkg::cva6_cfg via
//                      build_config_pkg::build_config()
//   - NoC structs      noc_req_t / noc_resp_t (parameter types declared
//                      in `core/cva6.sv`; contain AW/AR/W/B/R channels
//                      built from axi_pkg::{len,size,burst,cache,prot,
//                      qos,region,atop,resp}_t).
//
// The wrapper exposes CVA6's NoC signals through a thin adapter
// (`rtl/top/adapters/e1_cva6_to_e1axi4.sv`) that flattens the structs
// into the AXI4 master port below. The adapter is parameterised on
// AXI_ID_W / AXI_ADDR_W / AXI_DATA_W so the same wrapper instance can
// drive a 64-bit AXI4 fabric (cocotb-level CVA6 boot tests) or be
// width-adapted by the integrator before reaching a wider system bus.
//
// Without `+define+E1_HAVE_CVA6` the wrapper synthesises to safe idle
// outputs (the documented CVA6-disabled safe-idle behavior) so the rest of the SoC still
// compiles and simulates without the CVA6 source tree.

`timescale 1ns/1ps

// Number of RVFI retired-instruction ports exposed when E1_RVFI is defined.
// The cv64a6_imafdc_sv39 config (e1-pro little core) retires one instruction
// per cycle (NrCommitPorts == 1). An elaboration assert below fails closed if
// a wider config is wrapped without widening this surface.
`ifndef E1_RVFI_NRET
`define E1_RVFI_NRET 1
`endif

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDSIGNAL */
module e1_cpu_subsystem #(
    // Boot address forwarded to CVA6 as the reset PC / boot ROM entry.
    // Defaults to 0x1_0000 because CVA6's cv64a6 default executable PMA
    // regions cover [0, 0x1000), [0x1_0000, 0x2_0000), and the DRAM range.
    // Addresses in (0x1000 .. 0x1_0000) fault with INSTR_ACCESS_FAULT
    // before the icache can ever issue an AR.  Override via the wrapper
    // instantiation when integrating against a SoC ROM map whose vector
    // sits in a different executable window (e.g. cluster boot at DRAM
    // base 0x8000_0000).  See `external/cva6/cva6/core/include/
    // cv64a6_imafdc_sv39_config_pkg.sv::ExecuteRegionAddrBase`.
    parameter logic [63:0] BOOT_ADDR    = 64'h0000_0000_0001_0000,
    // AXI4 master geometry exposed by the wrapper. Must match CVA6's
    // CVA6Cfg.AxiIdWidth / AxiAddrWidth / AxiDataWidth when E1_HAVE_CVA6
    // is defined (default cv64a6 Sv39 config uses 4 / 64 / 64).
    parameter int unsigned AXI_ID_W     = 4,
    parameter int unsigned AXI_ADDR_W   = 64,
    parameter int unsigned AXI_DATA_W   = 64,
    parameter int unsigned AXI_USER_W   = 1
) (
    input  logic                       clk_i,
    input  logic                       rst_ni,

    // ── Interrupts from SoC ───────────────────────────────────────────────
    // irq_i[1] → M-mode external IRQ  (PLIC hart 0 M-mode context)
    // irq_i[0] → S-mode external IRQ  (PLIC hart 0 S-mode context)
    input  logic [1:0]                 irq_i,
    input  logic                       ipi_i,        // software IRQ (CLINT msip)
    input  logic                       time_irq_i,   // timer IRQ   (CLINT mtip)
    input  logic                       debug_req_i,  // debug request

    // ── AXI4 master port ──────────────────────────────────────────────────
    // Read address
    output logic [AXI_ID_W-1:0]        axi_ar_id,
    output logic [AXI_ADDR_W-1:0]      axi_ar_addr,
    output logic [7:0]                 axi_ar_len,
    output logic [2:0]                 axi_ar_size,
    output logic [1:0]                 axi_ar_burst,
    output logic                       axi_ar_lock,
    output logic [3:0]                 axi_ar_cache,
    output logic [2:0]                 axi_ar_prot,
    output logic [3:0]                 axi_ar_qos,
    output logic [3:0]                 axi_ar_region,
    output logic [AXI_USER_W-1:0]      axi_ar_user,
    output logic                       axi_ar_valid,
    input  logic                       axi_ar_ready,
    // Read data
    input  logic [AXI_ID_W-1:0]        axi_r_id,
    input  logic [AXI_DATA_W-1:0]      axi_r_data,
    input  logic [1:0]                 axi_r_resp,
    input  logic                       axi_r_last,
    input  logic [AXI_USER_W-1:0]      axi_r_user,
    input  logic                       axi_r_valid,
    output logic                       axi_r_ready,
    // Write address
    output logic [AXI_ID_W-1:0]        axi_aw_id,
    output logic [AXI_ADDR_W-1:0]      axi_aw_addr,
    output logic [7:0]                 axi_aw_len,
    output logic [2:0]                 axi_aw_size,
    output logic [1:0]                 axi_aw_burst,
    output logic                       axi_aw_lock,
    output logic [3:0]                 axi_aw_cache,
    output logic [2:0]                 axi_aw_prot,
    output logic [3:0]                 axi_aw_qos,
    output logic [3:0]                 axi_aw_region,
    output logic [5:0]                 axi_aw_atop,
    output logic [AXI_USER_W-1:0]      axi_aw_user,
    output logic                       axi_aw_valid,
    input  logic                       axi_aw_ready,
    // Write data
    output logic [AXI_DATA_W-1:0]      axi_w_data,
    output logic [(AXI_DATA_W/8)-1:0]  axi_w_strb,
    output logic                       axi_w_last,
    output logic [AXI_USER_W-1:0]      axi_w_user,
    output logic                       axi_w_valid,
    input  logic                       axi_w_ready,
    // Write response
    input  logic [AXI_ID_W-1:0]        axi_b_id,
    input  logic [1:0]                 axi_b_resp,
    input  logic [AXI_USER_W-1:0]      axi_b_user,
    input  logic                       axi_b_valid,
    output logic                       axi_b_ready,

    // ── Hart identity & debug observability ───────────────────────────────
    input  logic [63:0]                hart_id_i,
    output logic [63:0]                dbg_pc_o,
    output logic                       dbg_valid_o

`ifdef E1_RVFI
    // ── RVFI retired-instruction surface ──────────────────────────────────
    // Decoded, per-commit-port RISC-V Formal Interface stream, exposed for a
    // Spike step-and-compare (tandem) lane. Only the fields a retired-
    // instruction comparator needs are flattened out of the cva6_rvfi
    // decoder below; the full rvfi_instr_t / rvfi_csr_t structs stay internal
    // because their packed widths are config-dependent and not part of a
    // stable SoC-level contract. CVA6's NrCommitPorts is 1 for the cv64a6
    // Sv39 little-core config (e1-pro), so the surface is single-ported.
    ,
    output logic [`E1_RVFI_NRET-1:0]                 rvfi_valid_o,
    output logic [`E1_RVFI_NRET-1:0][63:0]           rvfi_order_o,
    output logic [`E1_RVFI_NRET-1:0][31:0]           rvfi_insn_o,
    output logic [`E1_RVFI_NRET-1:0]                 rvfi_trap_o,
    output logic [`E1_RVFI_NRET-1:0][1:0]            rvfi_mode_o,
    output logic [`E1_RVFI_NRET-1:0][4:0]            rvfi_rd_addr_o,
    output logic [`E1_RVFI_NRET-1:0][63:0]           rvfi_rd_wdata_o,
    output logic [`E1_RVFI_NRET-1:0][63:0]           rvfi_pc_rdata_o
`endif
);

`ifdef E1_HAVE_CVA6
    // =========================================================================
    // Real CVA6 instantiation (v5.3.0 / cv64a6_imafdc_sv39).
    //
    // CVA6's NoC port carries every channel in one `noc_req_t` (CPU→bus)
    // and one `noc_resp_t` (bus→CPU). The adapter below unpacks those
    // structs into the flat AXI4 ports declared on this module. The
    // wrapper's own AXI parameters must match the cv64a6 config; we cross-
    // check at elaboration time below.
    // =========================================================================

`ifdef E1_RVFI
    // RVFI struct macros, sourced from the pinned CVA6 tree (core/include is
    // on the +incdir+ path supplied by core/Flist.cva6).
    `include "rvfi_types.svh"
`endif

    // Resolve the CVA6 build configuration once.
    localparam config_pkg::cva6_cfg_t CVA6Cfg = build_config_pkg::build_config(
        cva6_config_pkg::cva6_cfg
    );

    // Cross-check the wrapper-level AXI geometry against the CVA6 config so
    // a mismatch fails closed during elaboration rather than at simulation.
    initial begin
        // synthesis translate_off
        if (AXI_ID_W   != CVA6Cfg.AxiIdWidth)
            $fatal(1, "e1_cva6_wrapper: AXI_ID_W=%0d != CVA6Cfg.AxiIdWidth=%0d",
                   AXI_ID_W, CVA6Cfg.AxiIdWidth);
        if (AXI_ADDR_W != CVA6Cfg.AxiAddrWidth)
            $fatal(1, "e1_cva6_wrapper: AXI_ADDR_W=%0d != CVA6Cfg.AxiAddrWidth=%0d",
                   AXI_ADDR_W, CVA6Cfg.AxiAddrWidth);
        if (AXI_DATA_W != CVA6Cfg.AxiDataWidth)
            $fatal(1, "e1_cva6_wrapper: AXI_DATA_W=%0d != CVA6Cfg.AxiDataWidth=%0d",
                   AXI_DATA_W, CVA6Cfg.AxiDataWidth);
        // synthesis translate_on
    end

    // Local channel struct typedefs that mirror the parameter types declared
    // inside `core/cva6.sv`. Repeating them here keeps the wrapper readable
    // without leaking ariane_pkg internals into the SoC.
    typedef struct packed {
        logic [CVA6Cfg.AxiIdWidth-1:0]   id;
        logic [CVA6Cfg.AxiAddrWidth-1:0] addr;
        axi_pkg::len_t                   len;
        axi_pkg::size_t                  size;
        axi_pkg::burst_t                 burst;
        logic                            lock;
        axi_pkg::cache_t                 cache;
        axi_pkg::prot_t                  prot;
        axi_pkg::qos_t                   qos;
        axi_pkg::region_t                region;
        logic [CVA6Cfg.AxiUserWidth-1:0] user;
    } cva6_axi_ar_chan_t;

    typedef struct packed {
        logic [CVA6Cfg.AxiIdWidth-1:0]   id;
        logic [CVA6Cfg.AxiAddrWidth-1:0] addr;
        axi_pkg::len_t                   len;
        axi_pkg::size_t                  size;
        axi_pkg::burst_t                 burst;
        logic                            lock;
        axi_pkg::cache_t                 cache;
        axi_pkg::prot_t                  prot;
        axi_pkg::qos_t                   qos;
        axi_pkg::region_t                region;
        axi_pkg::atop_t                  atop;
        logic [CVA6Cfg.AxiUserWidth-1:0] user;
    } cva6_axi_aw_chan_t;

    typedef struct packed {
        logic [CVA6Cfg.AxiDataWidth-1:0]     data;
        logic [(CVA6Cfg.AxiDataWidth/8)-1:0] strb;
        logic                                last;
        logic [CVA6Cfg.AxiUserWidth-1:0]     user;
    } cva6_axi_w_chan_t;

    typedef struct packed {
        logic [CVA6Cfg.AxiIdWidth-1:0]   id;
        axi_pkg::resp_t                  resp;
        logic [CVA6Cfg.AxiUserWidth-1:0] user;
    } cva6_axi_b_chan_t;

    typedef struct packed {
        logic [CVA6Cfg.AxiIdWidth-1:0]   id;
        logic [CVA6Cfg.AxiDataWidth-1:0] data;
        axi_pkg::resp_t                  resp;
        logic                            last;
        logic [CVA6Cfg.AxiUserWidth-1:0] user;
    } cva6_axi_r_chan_t;

    typedef struct packed {
        cva6_axi_aw_chan_t aw;
        logic              aw_valid;
        cva6_axi_w_chan_t  w;
        logic              w_valid;
        logic              b_ready;
        cva6_axi_ar_chan_t ar;
        logic              ar_valid;
        logic              r_ready;
    } cva6_noc_req_t;

    typedef struct packed {
        logic              aw_ready;
        logic              ar_ready;
        logic              w_ready;
        logic              b_valid;
        cva6_axi_b_chan_t  b;
        logic              r_valid;
        cva6_axi_r_chan_t  r;
    } cva6_noc_resp_t;

    cva6_noc_req_t  cva6_noc_req;
    cva6_noc_resp_t cva6_noc_resp;

    // ── RVFI probe / retired-instruction types ────────────────────────────
    // Built from CVA6's own `rvfi_types.svh` macros so the wrapper tracks the
    // pinned core's probe layout exactly (adopt, do not reinvent). The probe
    // bus (`rvfi_probes_o`) is the raw, undecoded tap; `cva6_rvfi` lowers it
    // into the architectural retired-instruction stream (`rvfi_instr_t`) that
    // a Spike step-and-compare consumes, mirroring the corev_apu testharness.
`ifdef E1_RVFI
    localparam type rvfi_probes_instr_t = `RVFI_PROBES_INSTR_T(CVA6Cfg);
    localparam type rvfi_probes_csr_t   = `RVFI_PROBES_CSR_T(CVA6Cfg);
    localparam type rvfi_probes_t       = struct packed {
        rvfi_probes_csr_t   csr;
        rvfi_probes_instr_t instr;
    };
    localparam type rvfi_instr_t        = `RVFI_INSTR_T(CVA6Cfg);
    localparam type rvfi_csr_elmt_t     = `RVFI_CSR_ELMT_T(CVA6Cfg);
    localparam type rvfi_csr_t          = `RVFI_CSR_T(CVA6Cfg, rvfi_csr_elmt_t);
    localparam type rvfi_to_iti_t       = `RVFI_TO_ITI_T(CVA6Cfg);

    initial begin
        // synthesis translate_off
        if (CVA6Cfg.NrCommitPorts != `E1_RVFI_NRET)
            $fatal(1, "e1_cva6_wrapper: E1_RVFI_NRET=%0d != CVA6Cfg.NrCommitPorts=%0d; widen the RVFI surface for this config",
                   `E1_RVFI_NRET, CVA6Cfg.NrCommitPorts);
        // synthesis translate_on
    end

    rvfi_probes_t                                  rvfi_probes;
    rvfi_instr_t [CVA6Cfg.NrCommitPorts-1:0]       rvfi_instr;
    rvfi_csr_t                                     rvfi_csr;
    rvfi_to_iti_t                                  rvfi_to_iti;
`endif

    // CVxIF tied off — we do not attach a coprocessor in the e1-chip
    // little-core path. The CVA6 v5.3.0 NoC pipeline ignores cvxif_req_o
    // when cvxif_resp_i is held quiescent.
    /* verilator lint_off UNUSEDSIGNAL */
    logic cvxif_req_unused;
    /* verilator lint_on UNUSEDSIGNAL */

    cva6 #(
        .CVA6Cfg              (CVA6Cfg),
`ifdef E1_RVFI
        .rvfi_probes_instr_t  (rvfi_probes_instr_t),
        .rvfi_probes_csr_t    (rvfi_probes_csr_t),
        .rvfi_probes_t        (rvfi_probes_t),
`endif
        .noc_req_t            (cva6_noc_req_t),
        .noc_resp_t           (cva6_noc_resp_t)
    ) u_cva6 (
        .clk_i        (clk_i),
        .rst_ni       (rst_ni),
        .boot_addr_i  (BOOT_ADDR[CVA6Cfg.VLEN-1:0]),
        .hart_id_i    (hart_id_i[CVA6Cfg.XLEN-1:0]),
        .irq_i        (irq_i),
        .ipi_i        (ipi_i),
        .time_irq_i   (time_irq_i),
        .debug_req_i  (debug_req_i),
`ifdef E1_RVFI
        .rvfi_probes_o(rvfi_probes),
`else
        .rvfi_probes_o(/* unconnected; trace ports left open */),
`endif
        .cvxif_req_o  (/* unconnected; no coprocessor */),
        .cvxif_resp_i ('0),
        .noc_req_o    (cva6_noc_req),
        .noc_resp_i   (cva6_noc_resp)
    );

`ifdef E1_RVFI
    // ── RVFI probe decoder ────────────────────────────────────────────────
    // Lowers the raw probe bus into the architectural retired-instruction
    // stream, exactly as corev_apu/tb/ariane_testharness.sv does. The decoded
    // stream is what the Spike step-and-compare lane diffs each instruction.
    cva6_rvfi #(
        .CVA6Cfg             (CVA6Cfg),
        .rvfi_instr_t        (rvfi_instr_t),
        .rvfi_csr_t          (rvfi_csr_t),
        .rvfi_probes_instr_t (rvfi_probes_instr_t),
        .rvfi_probes_csr_t   (rvfi_probes_csr_t),
        .rvfi_probes_t       (rvfi_probes_t),
        .rvfi_to_iti_t       (rvfi_to_iti_t)
    ) u_cva6_rvfi (
        .clk_i        (clk_i),
        .rst_ni       (rst_ni),
        .rvfi_probes_i(rvfi_probes),
        .rvfi_instr_o (rvfi_instr),
        .rvfi_to_iti_o(rvfi_to_iti),
        .rvfi_csr_o   (rvfi_csr)
    );

    // Flatten the decoded stream onto the wrapper's RVFI output surface.
    for (genvar p = 0; p < CVA6Cfg.NrCommitPorts; p++) begin : gen_rvfi_out
        assign rvfi_valid_o[p]    = rvfi_instr[p].valid;
        assign rvfi_order_o[p]    = rvfi_instr[p].order;
        assign rvfi_insn_o[p]     = rvfi_instr[p].insn;
        assign rvfi_trap_o[p]     = rvfi_instr[p].trap;
        assign rvfi_mode_o[p]     = rvfi_instr[p].mode;
        assign rvfi_rd_addr_o[p]  = rvfi_instr[p].rd_addr;
        assign rvfi_rd_wdata_o[p] = {{(64-CVA6Cfg.XLEN){1'b0}}, rvfi_instr[p].rd_wdata};
        assign rvfi_pc_rdata_o[p] = {{(64-CVA6Cfg.XLEN){1'b0}}, rvfi_instr[p].pc_rdata};
    end
`endif

    // ── NoC struct ↔ flat AXI4 adapter ────────────────────────────────────
    e1_cva6_to_e1axi4 #(
        .AXI_ID_W   (AXI_ID_W),
        .AXI_ADDR_W (AXI_ADDR_W),
        .AXI_DATA_W (AXI_DATA_W),
        .AXI_USER_W (AXI_USER_W),
        .noc_req_t  (cva6_noc_req_t),
        .noc_resp_t (cva6_noc_resp_t)
    ) u_cva6_to_axi (
        // From CVA6
        .noc_req_i    (cva6_noc_req),
        .noc_resp_o   (cva6_noc_resp),
        // To/from flat AXI4 master port
        .axi_ar_id    (axi_ar_id),
        .axi_ar_addr  (axi_ar_addr),
        .axi_ar_len   (axi_ar_len),
        .axi_ar_size  (axi_ar_size),
        .axi_ar_burst (axi_ar_burst),
        .axi_ar_lock  (axi_ar_lock),
        .axi_ar_cache (axi_ar_cache),
        .axi_ar_prot  (axi_ar_prot),
        .axi_ar_qos   (axi_ar_qos),
        .axi_ar_region(axi_ar_region),
        .axi_ar_user  (axi_ar_user),
        .axi_ar_valid (axi_ar_valid),
        .axi_ar_ready (axi_ar_ready),
        .axi_r_id     (axi_r_id),
        .axi_r_data   (axi_r_data),
        .axi_r_resp   (axi_r_resp),
        .axi_r_last   (axi_r_last),
        .axi_r_user   (axi_r_user),
        .axi_r_valid  (axi_r_valid),
        .axi_r_ready  (axi_r_ready),
        .axi_aw_id    (axi_aw_id),
        .axi_aw_addr  (axi_aw_addr),
        .axi_aw_len   (axi_aw_len),
        .axi_aw_size  (axi_aw_size),
        .axi_aw_burst (axi_aw_burst),
        .axi_aw_lock  (axi_aw_lock),
        .axi_aw_cache (axi_aw_cache),
        .axi_aw_prot  (axi_aw_prot),
        .axi_aw_qos   (axi_aw_qos),
        .axi_aw_region(axi_aw_region),
        .axi_aw_atop  (axi_aw_atop),
        .axi_aw_user  (axi_aw_user),
        .axi_aw_valid (axi_aw_valid),
        .axi_aw_ready (axi_aw_ready),
        .axi_w_data   (axi_w_data),
        .axi_w_strb   (axi_w_strb),
        .axi_w_last   (axi_w_last),
        .axi_w_user   (axi_w_user),
        .axi_w_valid  (axi_w_valid),
        .axi_w_ready  (axi_w_ready),
        .axi_b_id     (axi_b_id),
        .axi_b_resp   (axi_b_resp),
        .axi_b_user   (axi_b_user),
        .axi_b_valid  (axi_b_valid),
        .axi_b_ready  (axi_b_ready)
    );

    // Observability — CVA6 does not expose `commit_instr_o` on the top-level
    // NoC port. With E1_RVFI defined, the decoded RVFI stream above is the
    // architectural commit record, so dbg_pc/dbg_valid follow commit port 0
    // (the retired-PC the step-and-compare lane checks against Spike). Without
    // E1_RVFI the wrapper still elaborates and the SoC top relies on AXI4
    // traffic as the structural execution proof.
`ifdef E1_RVFI
    assign dbg_pc_o    = rvfi_pc_rdata_o[0];
    assign dbg_valid_o = rvfi_valid_o[0];
`else
    assign dbg_pc_o    = 64'h0;
    assign dbg_valid_o = 1'b0;
`endif

`else // !E1_HAVE_CVA6
    // =========================================================================
    // Stub: safe idle outputs — CPU appears powered-off to the interconnect.
    // Compile with `+define+E1_HAVE_CVA6` and the standalone CVA6 sources to
    // link the real core.
    // =========================================================================
    logic unused_stub_inputs;
    assign unused_stub_inputs = ^{
        clk_i,
        rst_ni,
        irq_i,
        ipi_i,
        time_irq_i,
        debug_req_i,
        hart_id_i,
        axi_ar_ready,
        axi_r_id,
        axi_r_data,
        axi_r_resp,
        axi_r_last,
        axi_r_user,
        axi_r_valid,
        axi_aw_ready,
        axi_w_ready,
        axi_b_id,
        axi_b_resp,
        axi_b_user,
        axi_b_valid,
        BOOT_ADDR
    };

    assign axi_ar_id     = '0;
    assign axi_ar_addr   = '0;
    assign axi_ar_len    = 8'h0;
    assign axi_ar_size   = 3'h0;
    assign axi_ar_burst  = 2'h0;
    assign axi_ar_lock   = 1'b0;
    assign axi_ar_cache  = 4'h0;
    assign axi_ar_prot   = 3'h0;
    assign axi_ar_qos    = 4'h0;
    assign axi_ar_region = 4'h0;
    assign axi_ar_user   = '0;
    assign axi_ar_valid  = 1'b0;
    assign axi_r_ready   = 1'b1;

    assign axi_aw_id     = '0;
    assign axi_aw_addr   = '0;
    assign axi_aw_len    = 8'h0;
    assign axi_aw_size   = 3'h0;
    assign axi_aw_burst  = 2'h0;
    assign axi_aw_lock   = 1'b0;
    assign axi_aw_cache  = 4'h0;
    assign axi_aw_prot   = 3'h0;
    assign axi_aw_qos    = 4'h0;
    assign axi_aw_region = 4'h0;
    assign axi_aw_atop   = 6'h0;
    assign axi_aw_user   = '0;
    assign axi_aw_valid  = 1'b0;

    assign axi_w_data    = '0;
    assign axi_w_strb    = '0;
    assign axi_w_last    = 1'b0;
    assign axi_w_user    = '0;
    assign axi_w_valid   = 1'b0;

    assign axi_b_ready   = 1'b1;

    assign dbg_pc_o    = 64'h0;
    assign dbg_valid_o = 1'b0;

`ifdef E1_RVFI
    // RVFI surface only carries data when the real core is linked; with the
    // stub it is quiescent so the port list stays consistent for integrators
    // that always declare it.
    assign rvfi_valid_o    = '0;
    assign rvfi_order_o    = '0;
    assign rvfi_insn_o     = '0;
    assign rvfi_trap_o     = '0;
    assign rvfi_mode_o     = '0;
    assign rvfi_rd_addr_o  = '0;
    assign rvfi_rd_wdata_o = '0;
    assign rvfi_pc_rdata_o = '0;
`endif

`endif // E1_HAVE_CVA6

endmodule
/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on DECLFILENAME */
