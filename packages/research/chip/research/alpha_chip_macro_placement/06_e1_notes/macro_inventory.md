# E1 Macro Inventory

This file tracks whether E1 currently has enough real hard macros to benefit
from AlphaChip macro placement.

## Initial observation

The checked-in E1 RTL is mostly SystemVerilog soft logic and stubs, including:

- top-level SoC wrappers under `rtl/top/`
- NPU under `rtl/npu/`
- memory model under `rtl/memory/`
- CPU/AP stubs and wrappers under `rtl/cpu/`
- interconnect, interrupt, display, DMA, debug, and peripheral logic

OpenLane configs target SKY130/GF180 exploratory flows, but hard SRAM/NPU/cache
macro LEFs are not yet obvious from committed files. If the flow synthesizes all
memory into standard cells, AlphaChip will have little to optimize beyond soft
macro clustering.

## Next inventory tasks

- List all true hard macros after the next OpenLane synthesis/floorplan run.
- Identify SRAM/cache/NPU array blocks that should become hard macros.
- Record dimensions, pin counts, legal orientations, halo/channel rules, and
  fixed IO/pad constraints.
- Decide whether to create hierarchical hard-macro blocks for NPU tiles or SRAM
  banks before AlphaChip training.
