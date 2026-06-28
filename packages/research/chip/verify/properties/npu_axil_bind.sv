// SPDX-License-Identifier: Apache-2.0
//
// Bind the AXI-Lite protocol property pack to the e1_npu descriptor-engine
// master port. Driven by verify/formal/e1_npu.sby, which compiles this file
// alongside the NPU formal harness (top: e1_npu_formal) and defines
// AXIL_PROTO_ASSUME_LIVENESS so the abstracted slave grants within MAX_STALL
// for the master-side proof. The descriptor engine keeps at most one read or
// write transaction in flight, so MAX_OUTST is 1.

`default_nettype none

bind e1_npu axi_lite_protocol_props #(
    .ADDR_W(32), .DATA_W(32), .MAX_OUTST(1), .MAX_STALL(64)
) u_axil_props (
    .clk     (clk),
    .rst_n   (rst_n),
    .awvalid (m_axil_awvalid),
    .awready (m_axil_awready),
    .awaddr  (m_axil_awaddr),
    .wvalid  (m_axil_wvalid),
    .wready  (m_axil_wready),
    .wdata   (m_axil_wdata),
    .wstrb   (m_axil_wstrb),
    .bvalid  (m_axil_bvalid),
    .bready  (m_axil_bready),
    .bresp   (m_axil_bresp),
    .arvalid (m_axil_arvalid),
    .arready (m_axil_arready),
    .araddr  (m_axil_araddr),
    .rvalid  (m_axil_rvalid),
    .rready  (m_axil_rready),
    .rdata   (m_axil_rdata),
    .rresp   (m_axil_rresp)
);

`default_nettype wire
