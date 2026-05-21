# AXI-Lite property pack

`axi_lite_protocol.sv` is a reusable SystemVerilog assertion bundle for
AXI-Lite master and slave ports. It is the single source of truth for
AXI-Lite protocol assertions in this repo (the older `axi_lite.sv` pack was
collapsed into it per `docs/E1_SOTA_TAPEOUT_DOSSIER.md` §3.4 H25). It is
parametric in `ADDR_W`, `DATA_W`, the outstanding bound `MAX_OUTST`, and the
bounded-fairness window `MAX_STALL`. Default budgets are documented in
`verify/properties/verification-budgets.md`.

Covered properties:

- VALID stability (no de-assert before handshake) on AW, W, AR, B, R.
- Payload stability on `awaddr`, `wdata`, `wstrb`, `araddr`, `bresp`,
  `rdata`, `rresp`.
- Response code legality (`OKAY`/`SLVERR`/`DECERR`; `EXOKAY` excluded).
- Bounded liveness on AW/W/AR (assert by default; assume when
  `AXIL_PROTO_ASSUME_LIVENESS` is defined for master-side proofs).
- Outstanding-transaction balance: no spurious B/R responses, and the
  in-flight count never exceeds `MAX_OUTST`.

## Binding

`bind` the module to any AXI-Lite port set, e.g.:

```sv
bind my_master axi_lite_protocol_props #(.ADDR_W(32), .DATA_W(32)) u_props (
    .clk(clk), .rst_n(rst_n),
    .awvalid(m_awvalid), .awready(m_awready), .awaddr(m_awaddr),
    .wvalid(m_wvalid),   .wready(m_wready),   .wdata(m_wdata), .wstrb(m_wstrb),
    .bvalid(m_bvalid),   .bready(m_bready),   .bresp(m_bresp),
    .arvalid(m_arvalid), .arready(m_arready), .araddr(m_araddr),
    .rvalid(m_rvalid),   .rready(m_rready),   .rdata(m_rdata), .rresp(m_rresp)
);
```

## SymbiYosys harness

`dma_axil_bind.sv` is a structural top that instantiates `e1_dma` and
binds the property pack to its master ports. `dma_axil.sby` exposes two
tasks: `bmc` (depth 32) and `prove` (depth 16). Run from this directory:

```sh
sby -f dma_axil.sby bmc
sby -f dma_axil.sby prove
```

Both tasks define `AXIL_PROTO_ASSUME_LIVENESS` so the downstream memory
liveness is assumed rather than asserted; the DMA master is then required
to keep VALID stable, drive legal responses, and never see spurious B/R.

Tracked under
`verify/rtl_gap_work_order.yaml#areas.interconnect.critical_gaps.interconnect-axi-lite-proof-coverage`
and `dma-proof-depth-and-protocol`.
