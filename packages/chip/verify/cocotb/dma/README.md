# DMA cocotb gap coverage

Directed tests targeting the long-transfer, byte-strobe, unaligned, IRQ,
and bus-error gaps tracked in
`verify/rtl_gap_work_order.yaml#areas.dma.critical_gaps.dma-real-memory-system`.

These tests follow the DUT port convention of `rtl/dma/e1_dma.sv`.
They are not yet wired into `verify/cocotb/Makefile`; integration is
tracked as part of the same work order entry.
