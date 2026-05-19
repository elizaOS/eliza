// e1_cva6_wrapper.sv  —  CVA6 integration wrapper for the e1-chip SoC
//
// This module is the drop-in replacement for e1_cpu_subsystem_stub.  It
// presents the same external port list as the stub (AXI-Lite manager +
// interrupt inputs + observability outputs) and is intended to instantiate
// the OpenHW Group CVA6 RV64GC core under `+define+E1_HAVE_CVA6.
//
// API DRIFT (BLOCKED, tracked by external/cva6/pin-manifest.json
// `wrapper_api_drift`):
//
//   The `ifdef E1_HAVE_CVA6 block below targets the legacy CVA6 API
//     - module           `ariane`
//     - config struct    `ariane_pkg::ariane_cfg_t`
//     - default config   `ariane_pkg::ArianeDefaultConfig`
//     - AXI structs      `ariane_axi::req_t` / `ariane_axi::resp_t`
//   None of these symbols exist in the current `external/cva6/cva6` checkout
//   (commit cfb85e7 at the time of writing) or in any tagged release from
//   v4.0.0 forward.  Current CVA6 HEAD exposes
//     - module           `cva6`
//     - config struct    `config_pkg::cva6_cfg_t` (built from
//                        `cva6_config_pkg::cva6_cfg` via
//                        `build_config_pkg::build_config`)
//     - AXI structs      configurable NoC types (`noc_req_t` / `noc_resp_t`
//                        for `NOC_TYPE_AXI4_ATOP`)
//
//   Until the `ifdef block is re-targeted, defining `E1_HAVE_CVA6 will fail
//   elaboration; the integration top therefore keeps the cluster in lite
//   tie-off mode (`docs/evidence/integration/cross-domain-interfaces.yaml` →
//   `cluster_to_fabric.status = TIED_OFF`).  Recovery steps:
//
//     1. Pin `external/cva6/cva6` to v5.3.0 (commit 2ef1c1b) — the most
//        recent tag with a stable `config_pkg::cva6_cfg_t` API.
//     2. Initialise the cvfpu + hpdcache + cvfpu/src/common_cells +
//        cvfpu/src/fpu_div_sqrt_mvp submodules.
//     3. Rewrite the `ifdef E1_HAVE_CVA6 block to instantiate
//          cva6 #(.CVA6Cfg(build_config_pkg::build_config(
//                              cva6_config_pkg::cva6_cfg)))
//        and bridge its NoC/AXI structs to the flat ports below via a new
//        `rtl/top/adapters/e1_cva6_to_e1axi4.sv` adapter.
//     4. Re-run `make cva6-generator-check` (scripts/check_cva6_pin.py
//        verifies both the checkout and the wrapper-symbol drift).
//
// Without the define the wrapper stubs all outputs to safe idle values so
// that the rest of the SoC compiles and simulates without the CVA6 source
// tree, preserving the v0 integration smoke path.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDSIGNAL */
module e1_cpu_subsystem #(
    // Boot address forwarded to CVA6 as the reset PC / boot ROM entry.
    // Matches e1_chip_cpu_variant.boot.reset_vector in
    // sw/platform/e1_platform_contract.json.
    parameter logic [63:0] BOOT_ADDR = 64'h0000_0000_0000_1000
) (
    input  logic        clk_i,
    input  logic        rst_ni,

    // ── Interrupts from SoC ───────────────────────────────────────────────
    // irq_i[1] → M-mode external IRQ  (PLIC hart 0 M-mode context)
    // irq_i[0] → S-mode external IRQ  (PLIC hart 0 S-mode context)
    input  logic [1:0]  irq_i,
    input  logic        ipi_i,        // software interrupt from CLINT msip
    input  logic        time_irq_i,   // timer interrupt from CLINT mtip
    input  logic        debug_req_i,  // debug request; tie 0 until JTAG wired

    // ── AXI4 64-bit master port (→ e1_cpu_axi_bridge) ─────────────────
    // Read address
    output logic [3:0]  axi_ar_id,
    output logic [63:0] axi_ar_addr,
    output logic [7:0]  axi_ar_len,
    output logic [2:0]  axi_ar_size,
    output logic [1:0]  axi_ar_burst,
    output logic        axi_ar_lock,
    output logic [3:0]  axi_ar_cache,
    output logic [2:0]  axi_ar_prot,
    output logic [3:0]  axi_ar_qos,
    output logic [3:0]  axi_ar_region,
    output logic        axi_ar_user,
    output logic        axi_ar_valid,
    input  logic        axi_ar_ready,
    // Read data
    input  logic [3:0]  axi_r_id,
    input  logic [63:0] axi_r_data,
    input  logic [1:0]  axi_r_resp,
    input  logic        axi_r_last,
    input  logic        axi_r_user,
    input  logic        axi_r_valid,
    output logic        axi_r_ready,
    // Write address
    output logic [3:0]  axi_aw_id,
    output logic [63:0] axi_aw_addr,
    output logic [7:0]  axi_aw_len,
    output logic [2:0]  axi_aw_size,
    output logic [1:0]  axi_aw_burst,
    output logic        axi_aw_lock,
    output logic [3:0]  axi_aw_cache,
    output logic        axi_aw_user,
    output logic        axi_aw_valid,
    input  logic        axi_aw_ready,
    // Write data
    output logic [63:0] axi_w_data,
    output logic [7:0]  axi_w_strb,
    output logic        axi_w_last,
    output logic        axi_w_user,
    output logic        axi_w_valid,
    input  logic        axi_w_ready,
    // Write response
    input  logic [3:0]  axi_b_id,
    input  logic [1:0]  axi_b_resp,
    input  logic        axi_b_user,
    input  logic        axi_b_valid,
    output logic        axi_b_ready,

    // ── Debug / observability ─────────────────────────────────────────────
    output logic [63:0] dbg_pc_o,
    output logic        dbg_valid_o
);

`ifdef E1_HAVE_CVA6
    // =========================================================================
    // Real CVA6 instantiation
    //
    // CVA6's top-level (core/cva6.sv) uses two struct types from
    // include/ariane_axi_pkg.sv:
    //   ariane_axi::req_t   — CPU→interconnect (AR/AW/W channels + R/B ready)
    //   ariane_axi::resp_t  — interconnect→CPU (R/B channels + AR/AW/W ready)
    //
    // The fields map to flat signals as follows (64-bit data, 4-bit ID):
    //
    //   req.ar.id        → axi_ar_id       resp.ar_ready → axi_ar_ready
    //   req.ar.addr      → axi_ar_addr     resp.r.id     → axi_r_id
    //   req.ar.len       → axi_ar_len      resp.r.data   → axi_r_data
    //   req.ar.size      → axi_ar_size     resp.r.resp   → axi_r_resp
    //   req.ar.burst     → axi_ar_burst    resp.r.last   → axi_r_last
    //   req.ar.lock      → axi_ar_lock     resp.r.user   → axi_r_user
    //   req.ar.cache     → axi_ar_cache    resp.r_valid  → axi_r_valid
    //   req.ar.prot      → axi_ar_prot     resp.aw_ready → axi_aw_ready
    //   req.ar.qos       → axi_ar_qos      resp.w_ready  → axi_w_ready
    //   req.ar.region    → axi_ar_region   resp.b.id     → axi_b_id
    //   req.ar.user      → axi_ar_user     resp.b.resp   → axi_b_resp
    //   req.ar_valid     → axi_ar_valid    resp.b.user   → axi_b_user
    //   req.r_ready      → axi_r_ready     resp.b_valid  → axi_b_valid
    //   req.aw.id        → axi_aw_id
    //   req.aw.addr      → axi_aw_addr
    //   req.aw.len       → axi_aw_len
    //   req.aw.size      → axi_aw_size
    //   req.aw.burst     → axi_aw_burst
    //   req.aw.lock      → axi_aw_lock
    //   req.aw.cache     → axi_aw_cache
    //   req.aw.user      → axi_aw_user
    //   req.aw_valid     → axi_aw_valid
    //   req.w.data       → axi_w_data
    //   req.w.strb       → axi_w_strb
    //   req.w.last       → axi_w_last
    //   req.w.user       → axi_w_user
    //   req.w_valid      → axi_w_valid
    //   req.b_ready      → axi_b_ready
    // =========================================================================

    // Pack the flat AXI signals into CVA6 struct types.
    ariane_axi::req_t  cva6_axi_req;
    ariane_axi::resp_t cva6_axi_resp;

    // ── req_t packing (CPU outputs → struct) ─────────────────────────────
    always_comb begin
        cva6_axi_req = '0;

        // AR channel
        cva6_axi_req.ar.id     = axi_ar_id;
        cva6_axi_req.ar.addr   = axi_ar_addr;
        cva6_axi_req.ar.len    = axi_ar_len;
        cva6_axi_req.ar.size   = axi_ar_size;
        cva6_axi_req.ar.burst  = axi_ar_burst;
        cva6_axi_req.ar.lock   = axi_ar_lock;
        cva6_axi_req.ar.cache  = axi_ar_cache;
        cva6_axi_req.ar.prot   = axi_ar_prot;
        cva6_axi_req.ar.qos    = axi_ar_qos;
        cva6_axi_req.ar.region = axi_ar_region;
        cva6_axi_req.ar.user   = axi_ar_user;
        cva6_axi_req.ar_valid  = axi_ar_valid;
        cva6_axi_req.r_ready   = axi_r_ready;

        // AW channel
        cva6_axi_req.aw.id     = axi_aw_id;
        cva6_axi_req.aw.addr   = axi_aw_addr;
        cva6_axi_req.aw.len    = axi_aw_len;
        cva6_axi_req.aw.size   = axi_aw_size;
        cva6_axi_req.aw.burst  = axi_aw_burst;
        cva6_axi_req.aw.lock   = axi_aw_lock;
        cva6_axi_req.aw.cache  = axi_aw_cache;
        cva6_axi_req.aw.user   = axi_aw_user;
        cva6_axi_req.aw_valid  = axi_aw_valid;

        // W channel
        cva6_axi_req.w.data    = axi_w_data;
        cva6_axi_req.w.strb    = axi_w_strb;
        cva6_axi_req.w.last    = axi_w_last;
        cva6_axi_req.w.user    = axi_w_user;
        cva6_axi_req.w_valid   = axi_w_valid;

        // B channel ready
        cva6_axi_req.b_ready   = axi_b_ready;
    end

    // ── resp_t unpacking (struct → CPU inputs) ────────────────────────────
    assign axi_ar_ready = cva6_axi_resp.ar_ready;
    assign axi_r_id     = cva6_axi_resp.r.id;
    assign axi_r_data   = cva6_axi_resp.r.data;
    assign axi_r_resp   = cva6_axi_resp.r.resp;
    assign axi_r_last   = cva6_axi_resp.r.last;
    assign axi_r_user   = cva6_axi_resp.r.user;
    assign axi_r_valid  = cva6_axi_resp.r_valid;
    assign axi_aw_ready = cva6_axi_resp.aw_ready;
    assign axi_w_ready  = cva6_axi_resp.w_ready;
    assign axi_b_id     = cva6_axi_resp.b.id;
    assign axi_b_resp   = cva6_axi_resp.b.resp;
    assign axi_b_user   = cva6_axi_resp.b.user;
    assign axi_b_valid  = cva6_axi_resp.b_valid;

    // ── CVA6 core instantiation ───────────────────────────────────────────
    // CVA6 config: use ArianeDefaultConfig which gives RV64IMAFDC + S-mode +
    // Sv39 MMU, sufficient for Linux/OpenSBI bring-up.
    //
    // The CVA6 top module does not expose dbg_pc_o or dbg_valid_o directly;
    // we tap commit_instr_o[0].pc and commit_instr_o[0].valid if available,
    // or tie to zero when the port is absent in the selected CVA6 version.
    //
    // Hart ID is fixed at 0 for the single-hart e1-chip configuration.

    cva6 #(
        .ArianeCfg (ariane_pkg::ArianeDefaultConfig),
        .AxiAddrWidth (64),
        .AxiDataWidth (64),
        .AxiIdWidth   (4),
        .AxiUserWidth (1)
    ) u_cva6 (
        .clk_i          (clk_i),
        .rst_ni         (rst_ni),
        .boot_addr_i    (BOOT_ADDR),
        .hart_id_i      (64'h0),
        .irq_i          (irq_i),
        .ipi_i          (ipi_i),
        .time_irq_i     (time_irq_i),
        .debug_req_i    (debug_req_i),
        .axi_req_o      (cva6_axi_req),   // output from CPU
        .axi_resp_i     (cva6_axi_resp)   // input to CPU
    );
    // Note: cva6 drives axi_req_o from its internals; we feed that back into
    // our flat outputs below via the assign statements above (ar_valid etc.).
    // The "req" variable above is used to *pack* flat signals for the resp
    // direction — for the actual CVA6 instance the axi_req_o port is an output
    // and is assigned automatically.  The always_comb packing block above is
    // retained for documentation and may be removed if it causes tool warnings.

    // Observability taps — CVA6 v5 exposes commit_instr_o as a packed array.
    // If the port does not exist in the selected version, tie to zero.
`ifdef CVA6_HAS_COMMIT_INSTR_O
    assign dbg_pc_o    = u_cva6.commit_instr_o[0].pc;
    assign dbg_valid_o = u_cva6.commit_instr_o[0].valid;
`else
    assign dbg_pc_o    = 64'h0;
    assign dbg_valid_o = 1'b0;
`endif

`else  // !E1_HAVE_CVA6
    // =========================================================================
    // Stub: safe idle outputs — CPU appears powered-off to the interconnect.
    // Compile with +define+E1_HAVE_CVA6 and include external/cva6/ to
    // enable the real core.
    // =========================================================================

    // synthesis warning: E1_HAVE_CVA6 not defined; CPU outputs are tied off.
    // This is intentional for simulation without the CVA6 source tree.
    logic unused_stub_inputs;
    assign unused_stub_inputs = ^{
        clk_i,
        rst_ni,
        irq_i,
        ipi_i,
        time_irq_i,
        debug_req_i,
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

    assign axi_ar_id     = 4'h0;
    assign axi_ar_addr   = 64'h0;
    assign axi_ar_len    = 8'h0;
    assign axi_ar_size   = 3'h0;
    assign axi_ar_burst  = 2'h0;
    assign axi_ar_lock   = 1'b0;
    assign axi_ar_cache  = 4'h0;
    assign axi_ar_prot   = 3'h0;
    assign axi_ar_qos    = 4'h0;
    assign axi_ar_region = 4'h0;
    assign axi_ar_user   = 1'b0;
    assign axi_ar_valid  = 1'b0;
    assign axi_r_ready   = 1'b1;   // absorb any spurious R beats

    assign axi_aw_id     = 4'h0;
    assign axi_aw_addr   = 64'h0;
    assign axi_aw_len    = 8'h0;
    assign axi_aw_size   = 3'h0;
    assign axi_aw_burst  = 2'h0;
    assign axi_aw_lock   = 1'b0;
    assign axi_aw_cache  = 4'h0;
    assign axi_aw_user   = 1'b0;
    assign axi_aw_valid  = 1'b0;

    assign axi_w_data    = 64'h0;
    assign axi_w_strb    = 8'h0;
    assign axi_w_last    = 1'b0;
    assign axi_w_user    = 1'b0;
    assign axi_w_valid   = 1'b0;

    assign axi_b_ready   = 1'b1;   // absorb any spurious B beats

    assign dbg_pc_o    = 64'h0;
    assign dbg_valid_o = 1'b0;

`endif  // E1_HAVE_CVA6

endmodule
/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on DECLFILENAME */
