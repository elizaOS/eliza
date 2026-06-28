// e1_cva6_to_e1axi4.sv  —  CVA6 NoC struct ↔ flat AXI4 adapter.
//
// CVA6 v5.3.0 (`external/cva6/cva6/`) exposes its memory port as one
// `noc_req_t` (CPU→bus) and one `noc_resp_t` (bus→CPU) struct.  This
// adapter unpacks those structs into the flat AXI4 master signals used
// by `rtl/cpu/e1_cva6_wrapper.sv` and the SoC fabric in
// `rtl/interconnect/axi4/`.
//
// The adapter is **width-matched only**.  No data-width conversion, no
// outstanding-id remapping, no clock crossing.  Parameters are declared
// so a future integration site can instantiate it at different widths
// without editing the body; mismatches between AXI_*_W and the struct
// widths fail closed at elaboration time via the assertions below.
//
// Adapter direction:
//
//   noc_req_i (struct)  → flat AXI4 master outputs (AR/AW/W + handshakes)
//   flat AXI4 inputs    → noc_resp_o (struct) consumed by the core
//
// References:
//   - external/cva6/cva6/core/cva6.sv lines ~180-300: noc_req_t /
//     noc_resp_t parameter type declarations.
//   - external/cva6/cva6/vendor/pulp-platform/axi/src/axi_pkg.sv lines
//     23-41: axi_pkg::{len,size,burst,cache,prot,qos,region,atop,resp}_t.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
module e1_cva6_to_e1axi4 #(
    parameter int unsigned AXI_ID_W   = 4,
    parameter int unsigned AXI_ADDR_W = 64,
    parameter int unsigned AXI_DATA_W = 64,
    parameter int unsigned AXI_USER_W = 1,
    // The CVA6 noc_req_t / noc_resp_t parameter types must be supplied by
    // the instantiator so the adapter does not have to import any CVA6
    // header.  This keeps `e1_cva6_to_e1axi4` independent of the
    // ariane_pkg / config_pkg name space — the wrapper that owns CVA6Cfg
    // builds the matching struct typedef and threads it through.
    parameter type noc_req_t  = logic,
    parameter type noc_resp_t = logic
) (
    // ── CVA6-side ports ───────────────────────────────────────────────
    input  noc_req_t                    noc_req_i,
    output noc_resp_t                   noc_resp_o,

    // ── Flat AXI4 master port (matches e1_cva6_wrapper) ───────────────
    // Read address
    output logic [AXI_ID_W-1:0]         axi_ar_id,
    output logic [AXI_ADDR_W-1:0]       axi_ar_addr,
    output logic [7:0]                  axi_ar_len,
    output logic [2:0]                  axi_ar_size,
    output logic [1:0]                  axi_ar_burst,
    output logic                        axi_ar_lock,
    output logic [3:0]                  axi_ar_cache,
    output logic [2:0]                  axi_ar_prot,
    output logic [3:0]                  axi_ar_qos,
    output logic [3:0]                  axi_ar_region,
    output logic [AXI_USER_W-1:0]       axi_ar_user,
    output logic                        axi_ar_valid,
    input  logic                        axi_ar_ready,
    // Read data
    input  logic [AXI_ID_W-1:0]         axi_r_id,
    input  logic [AXI_DATA_W-1:0]       axi_r_data,
    input  logic [1:0]                  axi_r_resp,
    input  logic                        axi_r_last,
    input  logic [AXI_USER_W-1:0]       axi_r_user,
    input  logic                        axi_r_valid,
    output logic                        axi_r_ready,
    // Write address
    output logic [AXI_ID_W-1:0]         axi_aw_id,
    output logic [AXI_ADDR_W-1:0]       axi_aw_addr,
    output logic [7:0]                  axi_aw_len,
    output logic [2:0]                  axi_aw_size,
    output logic [1:0]                  axi_aw_burst,
    output logic                        axi_aw_lock,
    output logic [3:0]                  axi_aw_cache,
    output logic [2:0]                  axi_aw_prot,
    output logic [3:0]                  axi_aw_qos,
    output logic [3:0]                  axi_aw_region,
    output logic [5:0]                  axi_aw_atop,
    output logic [AXI_USER_W-1:0]       axi_aw_user,
    output logic                        axi_aw_valid,
    input  logic                        axi_aw_ready,
    // Write data
    output logic [AXI_DATA_W-1:0]       axi_w_data,
    output logic [(AXI_DATA_W/8)-1:0]   axi_w_strb,
    output logic                        axi_w_last,
    output logic [AXI_USER_W-1:0]       axi_w_user,
    output logic                        axi_w_valid,
    input  logic                        axi_w_ready,
    // Write response
    input  logic [AXI_ID_W-1:0]         axi_b_id,
    input  logic [1:0]                  axi_b_resp,
    input  logic [AXI_USER_W-1:0]       axi_b_user,
    input  logic                        axi_b_valid,
    output logic                        axi_b_ready
);

    // -----------------------------------------------------------------
    // Unpack CVA6 → flat AXI4 (CPU → bus direction).
    // -----------------------------------------------------------------
    // AR channel
    assign axi_ar_id     = noc_req_i.ar.id;
    assign axi_ar_addr   = noc_req_i.ar.addr;
    assign axi_ar_len    = noc_req_i.ar.len;
    assign axi_ar_size   = noc_req_i.ar.size;
    assign axi_ar_burst  = noc_req_i.ar.burst;
    assign axi_ar_lock   = noc_req_i.ar.lock;
    assign axi_ar_cache  = noc_req_i.ar.cache;
    assign axi_ar_prot   = noc_req_i.ar.prot;
    assign axi_ar_qos    = noc_req_i.ar.qos;
    assign axi_ar_region = noc_req_i.ar.region;
    assign axi_ar_user   = noc_req_i.ar.user;
    assign axi_ar_valid  = noc_req_i.ar_valid;
    assign axi_r_ready   = noc_req_i.r_ready;

    // AW channel
    assign axi_aw_id     = noc_req_i.aw.id;
    assign axi_aw_addr   = noc_req_i.aw.addr;
    assign axi_aw_len    = noc_req_i.aw.len;
    assign axi_aw_size   = noc_req_i.aw.size;
    assign axi_aw_burst  = noc_req_i.aw.burst;
    assign axi_aw_lock   = noc_req_i.aw.lock;
    assign axi_aw_cache  = noc_req_i.aw.cache;
    assign axi_aw_prot   = noc_req_i.aw.prot;
    assign axi_aw_qos    = noc_req_i.aw.qos;
    assign axi_aw_region = noc_req_i.aw.region;
    assign axi_aw_atop   = noc_req_i.aw.atop;
    assign axi_aw_user   = noc_req_i.aw.user;
    assign axi_aw_valid  = noc_req_i.aw_valid;

    // W channel
    assign axi_w_data    = noc_req_i.w.data;
    assign axi_w_strb    = noc_req_i.w.strb;
    assign axi_w_last    = noc_req_i.w.last;
    assign axi_w_user    = noc_req_i.w.user;
    assign axi_w_valid   = noc_req_i.w_valid;

    // B-channel ready
    assign axi_b_ready   = noc_req_i.b_ready;

    // -----------------------------------------------------------------
    // Pack flat AXI4 → CVA6 (bus → CPU direction).
    // -----------------------------------------------------------------
    always_comb begin
        noc_resp_o = '0;
        noc_resp_o.ar_ready = axi_ar_ready;
        noc_resp_o.aw_ready = axi_aw_ready;
        noc_resp_o.w_ready  = axi_w_ready;

        // R channel
        noc_resp_o.r_valid  = axi_r_valid;
        noc_resp_o.r.id     = axi_r_id;
        noc_resp_o.r.data   = axi_r_data;
        noc_resp_o.r.resp   = axi_r_resp;
        noc_resp_o.r.last   = axi_r_last;
        noc_resp_o.r.user   = axi_r_user;

        // B channel
        noc_resp_o.b_valid  = axi_b_valid;
        noc_resp_o.b.id     = axi_b_id;
        noc_resp_o.b.resp   = axi_b_resp;
        noc_resp_o.b.user   = axi_b_user;
    end

endmodule
/* verilator lint_on DECLFILENAME */
