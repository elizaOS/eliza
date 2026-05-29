# SoC top-level adapters

Width / packing adapters that translate between domain-agent RTL
interfaces.  Adapters live here because they belong to top-level
integration, not to any single domain.  When the domain RTL drifts
(e.g., a width change), the adapter absorbs the drift so the rest of
the top stays untouched.

Today the adapters are implemented inline inside
`rtl/top/e1_soc_integrated.sv` (concatenations and slice operators
applied at the master-fabric attachment).  This README documents them
so a future drift detector can flag them and convert them to dedicated
modules under this directory if needed.

## Active adapters

### `CHI bridge ID 6 → Fabric ID 8`

```
{2'b00, chi_m_awid}  → fab_m_awid[0][7:0]
fab_m_bid[0][5:0]    → chi_m_bid[5:0]
{2'b00, chi_m_arid}  → fab_m_arid[0][7:0]
fab_m_rid[0][5:0]    → chi_m_rid[5:0]
```

Reason: `e1_chi_to_axi4_bridge` declares `parameter ID_WIDTH=6` to
carry AMBA CHI's source-id field; `e1_axi4_interconnect` runs with
`ID_WIDTH=8` to preserve the production cluster AXI4 ID contract.  The
two high fabric bits are zero for CHI traffic.

### `IOMMU downstream ID 6 → Fabric ID 8`

Same pattern as the CHI bridge.  The IOMMU's `d_*id` ports are 6-bit;
the fabric attach zero-pads to 8 bits and slices response IDs back to
6 bits.

### `CVA6 slot-0 ID 4 → Fabric ID 8`

The optional `+define+E1_CLUSTER_SLOT0_CVA6` path drives a 4-bit-ID,
64-bit-data AXI4 master.  `e1_axi4_width_converter` upsizes data to
128 bits; the SoC attach point zero-pads CVA6 request IDs to the
8-bit fabric contract and slices response IDs back to 4 bits.

### `Cluster AXI4 ID 8 → Fabric ID 8`

No ID adapter is needed.  The default `e1_cluster_top` instance exposes
eight production-shape per-core AXI4 master ports, all directly attached
to fabric masters 3..10.  In lite mode those ports remain quiet until
production per-core wrappers land.

## Pending adapters (BLOCKED on domain RTL landing)

### `LSU L1D 128-bit data ↔ L1D module 2R/2W port pair`

Will be needed once the cache RTL is wired through this top.
Currently the cluster's `lsu_l1d_req_o` array is tied off; when the
L1D instance lands its consumer side, the per-core 2R/2W ports
attach to the cluster's `[NUM_CORES][1:0]` packed array.  Geometry
matches by construction (both sides import `e1_lsu_to_l1d_pkg`); no
adapter logic is anticipated.

### `FTQ-to-L1I per-cluster fan-out`

The integration top currently exposes a single L1I prefetch port at
the SoC boundary (driven by the BPU's single `bpu_top` instance).
When the cluster moves out of lite mode, the BPU has to fan out one
prefetch port per core; the FTQ shim instantiates once per core, and
the cluster's `ftq_l1i_req_o[NUM_CORES-1:0]` array carries the
result.  No adapter logic; just instantiation.
