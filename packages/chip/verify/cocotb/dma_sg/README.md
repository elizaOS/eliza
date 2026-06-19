# Descriptor scatter-gather DMA cocotb suite

Known-answer tests for `rtl/dma/e1_dma_sg.sv`, the descriptor-based,
full-AXI4 scatter-gather DMA engine (the production-direction successor to the
AXI-Lite word-copy `rtl/dma/e1_dma.sv`).

`test_dma_sg.py` stands up a byte-addressed Python AXI4 INCR slave behind
randomized ready/valid backpressure, builds memory-resident descriptor rings,
kicks the engine over its MMIO register port, and asserts:

- `sg_multi_descriptor_copy_is_byte_exact` — a 3-descriptor chain is fetched,
  executed, and byte-exact at every destination; only the last descriptor
  raises an IRQ; the IRQ is W1C-clearable.
- `sg_unaligned_head_and_tail_is_exact` — different sub-word src/dst offsets and
  a non-word length copy exactly, touching no neighbour bytes.
- `sg_long_transfer_spans_many_bursts` — a 4 KiB descriptor exercises many
  `MAX_BEATS` INCR bursts.
- `sg_axcache_attribute_drives_bus` — the programmed AXCACHE attribute
  (cacheable vs device) is presented on ARCACHE/AWCACHE.
- `sg_decerr_sets_error_status_and_irq_without_corrupting_siblings` — an AXI
  DECERR region sets the descriptor + global error status, raises the error
  IRQ, halts the chain fail-closed, and leaves a sibling descriptor's
  destination untouched.

Run:

    COCOTB_TOPLEVEL=e1_dma_sg COCOTB_MODULE=test_dma_sg \
        COCOTB_DIR=verify/cocotb/dma_sg scripts/run_cocotb.sh

Gate: `scripts/check_dma_engine.py` runs `verilator --lint-only` plus this
suite and writes `build/reports/dma_engine.json` (`eliza.gate_status.v1`).

Follow-ons (not covered here): SoC-fabric wiring including the source-ID tag
for IOMMU/IOPMP, multi-channel arbitration, >16-beat AxLEN, and the Linux
dmaengine driver.
