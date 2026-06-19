# Verification budgets

Single source of truth for the bounded-fairness and outstanding-transaction
budgets used by the reusable AXI-Lite property pack
(`verify/properties/axi_lite_protocol.sv`, module `axi_lite_protocol_props`).

Prior to dossier item §3.4 H30 the two property files disagreed:
`axi_lite.sv` defaulted `MAX_STALL=64` while `axi_lite_protocol.sv` defaulted
`MAX_STALL=256`. The files were collapsed (§3.4 H25) and the budgets settled
here.

## Module defaults

`axi_lite_protocol_props` declares these defaults:

| Parameter   | Default | Meaning                                                        |
|-------------|---------|----------------------------------------------------------------|
| `ADDR_W`    | 32      | AXI-Lite address width.                                         |
| `DATA_W`    | 32      | AXI-Lite data width.                                            |
| `MAX_OUTST` | 16      | Max simultaneously in-flight write/read transactions.          |
| `MAX_STALL` | 256     | Bounded-fairness window: cycles `*VALID` may wait for `*READY`. |

### Why `MAX_STALL = 256`

`MAX_STALL` is the liveness ceiling: a held `*VALID` must see `*READY` within
`MAX_STALL` cycles, otherwise the liveness assertion fails (or, under
`AXIL_PROTO_ASSUME_LIVENESS`, the environment is constrained to grant within
that window). The default must exceed the deepest single-channel stall any
real AXI-Lite slave in the SoC can legitimately impose while still being a
finite, BMC-tractable bound.

`256` is chosen as the conservative SoC-wide default because it bounds the
worst-case arbiter + slave latency on the shared AXI-Lite fabric (the
interconnect can serialise multiple masters before granting `READY`) without
being so large that it inflates SMT solve time. The earlier `64` value came
from the DMA-master-only proof, where the master is point-to-point against a
single slave model and never sees fabric arbitration; it is too tight to be a
correct fabric-wide default. Picking the larger of the two disagreeing values
is the fail-closed choice: a too-small `MAX_STALL` would let a legitimately
slow-but-live slave fail the liveness assertion (false negative on a real
design) or, worse, mask a deadlock as "satisfied within the window" only
because the window was unrealistically short.

### Why `MAX_OUTST = 16`

`MAX_OUTST` bounds the outstanding-transaction counters. AXI-Lite has no burst
length, so depth comes only from pipelined address/data acceptance. `16` is
larger than any current SoC AXI-Lite slave's accept depth, so the
`a_*_outstanding_bounded` assertions catch counter runaway (a spurious-response
or accounting bug) without flagging legal pipelining.

## Per-DUT overrides

Binds override the defaults to match the concrete DUT. These are the only
sanctioned divergences from the defaults:

| Bind site                              | `MAX_OUTST` | `MAX_STALL` | Rationale                                                                 |
|----------------------------------------|-------------|-------------|---------------------------------------------------------------------------|
| `verify/properties/dma_axil_bind.sv`   | 1           | 64          | DMA master is a single-outstanding FSM against one slave; no fabric arb.  |
| `verify/formal/e1_axi_lite_dram_bind.sv` | 4         | 64          | DRAM model accepts a shallow pipeline; point-to-point, no arbitration.    |
| `verify/formal/e1_axi_lite_interconnect_bind.sv` | 8 | 1024        | Crossbar can serialise all masters before granting one; deepest stall.    |

When adding a bind, start from the module defaults and only override after
confirming the DUT's actual accept depth and worst-case grant latency.
