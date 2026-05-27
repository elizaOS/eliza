# Memory map

All addresses are byte addresses. The e1 chip uses a single-cycle MMIO request interface. Peripheral regions implement only word-aligned accesses in the first 256 bytes of each 4 KiB control window in the current RTL. The boot ROM is a separate 64 KiB aperture. For peripheral control windows, nonzero `addr[11:8]`, unaligned accesses, and unknown regions return `0xDEAD_BEEF` at the top-level decode.

| Region | Base | Size | Purpose |
| --- | ---: | ---: | --- |
| Boot ROM | `0x0000_0000` | `64 KiB` | Reset/identity words |
| Peripheral control | `0x1000_0000` | `4 KiB` | ID, scratch, GPIO, timer |
| DMA | `0x1001_0000` | `4 KiB` | DMA master contract model |
| NPU | `0x1002_0000` | `4 KiB` | Small NPU datapath |
| Display | `0x1003_0000` | `4 KiB` | Framebuffer scanout controller |
| DRAM aperture | `0x8000_0000` | `4 KiB` | SRAM-backed test DRAM visible to debug MMIO and DMA |

## Linux-capable AXI-Lite scaffold map

The CPU/interconnect scaffold is separate from the e1-chip debug MMIO path. It uses AXI-Lite-style channels and establishes the future software contract. The e1-chip top now exposes a small debug-visible DRAM aperture for DMA integration, while the Linux-capable scaffold keeps its own AXI-Lite DRAM model:

| Region | Base | Size | Purpose |
| --- | ---: | ---: | --- |
| Interrupt controller | `0x0C00_0000` | `4 KiB` | PLIC-style source pending, enable, claim/complete scaffold |
| DMA control scaffold | `0x1001_0000` | `4 KiB` | AXI-Lite DMA control target; DMA master is arbitrated onto the DRAM model |
| DRAM aperture | `0x8000_0000` | `256 MiB` | External DRAM controller/PHY boundary; current RTL model implements a small test memory |

Unmapped AXI-Lite scaffold accesses return `DECERR`; reads also return `0xDEAD_BEEF`.

The `256 MiB` row is the software-visible aperture contract, not implemented capacity. The current SRAM-backed RTL model under that aperture implements only `4 KiB`; accesses within `0x8000_0000` - `0x8FFF_FFFF` but outside the 4 KiB model return DRAM-model `SLVERR`, not AXI-Lite decode `DECERR`. The tiny CPU execution test uses the DRAM aperture as instruction and data memory. The current DRAM model implements aligned 32-bit words with byte strobes; the CPU subset only generates aligned `LW` and `SW`.

The Linux-capable scaffold routes DMA master traffic only to the DRAM model. DMA access attempts outside the DRAM aperture must fail with a memory error and must not update MMIO targets. This is a local containment check, not an IOMMU or coherency implementation.

The map is also not a complete boot-memory map. The current reset ROM entry is
the e1-chip identity ROM, and no boot SRAM region, ROM-to-SRAM copy contract,
DRAM initialization sequence, or OpenSBI memory-discovery handoff is implemented
in this map. Those rows must be added before Linux boot-memory readiness can be
claimed.

## Linux access-map dependencies

The scaffold map is not yet a complete Linux device memory map. Before a Linux/Android readiness claim, the memory map must explicitly reserve and test these dependencies:

| Dependency | Required map contract |
| --- | --- |
| Reset ROM | Immutable reset vector, executable ROM image or source, failure behavior, and handoff target. |
| Boot SRAM | SRAM base/size, permissions, stack/temporary storage ownership, zeroization or lifetime policy, and DMA exclusion. |
| CLINT/ACLINT | Machine timer and software interrupt window, CPU privilege access, DMA exclusion, and device-tree binding evidence. |
| PLIC/IMSIC | Interrupt-controller pending, enable, priority, threshold, claim/complete, CPU privilege access, DMA exclusion, and source-ID stability. |
| IOMMU/SMMU | MMIO aperture, stream/client IDs, page table format, fault-status registers, interrupt source, and reset behavior. |
| DRAM/LPDDR | Real target memory base, discovered size, reserved firmware/device regions, cacheability attributes, training status, and boot log evidence. |
| DMA-coherent regions | Coherent or non-coherent DMA buffer attributes, cache-maintenance requirements, and dma-buf/fence compatibility evidence. |
| QoS/performance counters | Per-master bandwidth, latency, underflow, error, and fault counters if the production fabric exposes them. |

Until those rows exist with executable evidence, CLINT/PLIC access map dependencies, page fault reporting, coherent DMA, IOMMU/SMMU, and DRAM bandwidth/latency remain blockers rather than implemented behavior.

## Register conventions

All registers are 32-bit little-endian words. Writes to reserved registers are ignored. Reads from unmapped regions return `0xDEAD_BEEF`.

## Peripheral registers

| Offset | Name | Access | Description |
| ---: | --- | --- | --- |
| `0x00` | `ID` | RO | `0x1000_0001` |
| `0x04` | `SCRATCH` | RW | Software scratch register |
| `0x08` | `GPIO_OUT` | RW | Low 8 bits drive `gpio_out` |
| `0x0C` | `TIMER_COUNT` | RO | Free-running counter |
| `0x10` | `TIMER_COMPARE` | RW | Timer interrupt threshold |
| `0x14` | `TIMER_IRQ` | RO | Bit 0 is timer IRQ level |

## DMA registers

| Offset | Name | Access | Description |
| ---: | --- | --- | --- |
| `0x00` | `SRC` | RW | Source byte address; must be word-aligned in this model |
| `0x04` | `DST` | RW | Destination byte address; must be word-aligned in this model |
| `0x08` | `LEN` | RW | Byte length; the model issues one 32-bit beat at a time |
| `0x0C` | `CTRL_STATUS` | RW | Write bit 0 to start, bit 1 to clear done/error; read bit 0 busy, bit 1 done/IRQ, bit 2 error, bit 3 accepted read-address pulse, bit 4 accepted write-address/data pulse |
| `0x10` | `CFG` | RW | Reserved DMA integration/configuration word; reset value is `4` bytes per beat |
| `0x14` | `BYTES_DONE` | RO | Number of payload bytes completed by the current/last command |
| `0x18` | `BEATS_ISSUED` | RO | Number of modeled write beats completed |
| `0x1C` | `CUR_SRC` | RO | Current source address while busy |
| `0x20` | `CUR_DST` | RO | Current destination address while busy |
| `0x24` | `LAST_SRC` | RO | Last modeled read address issued |
| `0x28` | `LAST_DST` | RO | Last modeled write address issued |
| `0x2C` | `MASTER_TRACE` | RO | `{last_wstrb[3:0], state[2:0]}` packed into bits `[10:7]` and `[2:0]` |
| `0x30` | `READ_BEATS` | RO | Number of AXI-Lite read responses completed |
| `0x34` | `WRITE_BEATS` | RO | Number of AXI-Lite write responses completed |
| `0x38` | `ERROR_COUNT` | RO | Number of alignment or bus response errors observed by the current/last command |

## NPU registers

| Offset | Name | Access | Description |
| ---: | --- | --- | --- |
| `0x00` | `OP_A` | RW | Operand A |
| `0x04` | `OP_B` | RW | Operand B |
| `0x08` | `RESULT` | RO | Low result word |
| `0x0C` | `CTRL_STATUS` | RW | Write bit 0 to start, bit 1 to clear done/error; read bit 0 busy, bit 1 done/IRQ, bit 2 error |
| `0x10` | `OPCODE` | RW | `0` add, `1` sub, `2` unsigned multiply, `3` signed S16 MAC, `4` packed signed INT8 dot4, `5` unsigned max, `6` unsigned min, `7` packed signed INT4 dot8, `8` bounded INT8 GEMM |
| `0x14` | `ACC` | RW | Accumulator/bias input for MAC/DOT operations |
| `0x18` | `RESULT_HI` | RO | High result/sign-extension word |
| `0x1C` | `TRACE` | RO | `{latched_opcode[3:0], busy_count[2:0]}` in low bits |
| `0x20` | `GEMM_CFG` | RW | Bounded scratchpad GEMM dimensions: `M[1:0]`, `N[9:8]`, `K[18:16]` |
| `0x24` | `GEMM_BASE` | RW | Byte bases: `A[5:0]`, `B[13:8]`, `C[21:16]` |
| `0x28` | `GEMM_STRIDE` | RW | Byte strides: `A[3:0]`, `B[11:8]`, `C[19:16]` |
| `0x2C` | `PERF_UNSUPPORTED_OPS` | RO | Rejected opcode/configuration counter |
| `0x30` | `CMD_PARAM` | RW | Reserved command parameter word; no tensor queue semantics yet |
| `0x40` | `DESC_BASE` | RW | Reserved descriptor-ring base; not a DMA command queue |
| `0x44` | `DESC_HEAD` | RW | Reserved descriptor-ring head |
| `0x48` | `DESC_TAIL` | RO | Reserved descriptor-ring tail |
| `0x4C` | `DESC_STATUS` | RO | Reserved descriptor-ring status |
| `0x50` | `PERF_CYCLES` | RO | Cycles spent in active GEMM state |
| `0x54` | `PERF_MACS` | RO | Signed INT8 GEMM MACs issued by the scratchpad prototype |
| `0x58` | `PERF_OPS` | RO | Accepted operation counter |
| `0x5C` | `PERF_ERRORS` | RW | Rejected command/configuration counter; write bit 0 clears all NPU perf counters |
| `0x80`-`0xBC` | `SCRATCH[0..15]` | RW | 64-byte MMIO scratchpad for the bounded GEMM prototype |

## Display registers

| Offset | Name | Access | Description |
| ---: | --- | --- | --- |
| `0x00` | `FB_BASE` | RW | Framebuffer base address; top-level scanout currently fetches from the `0x8000_0000` SRAM-backed DRAM aperture |
| `0x04` | `MODE` | RW | `{height[15:0], width[15:0]}` |
| `0x08` | `FORMAT` | RW | FourCC-like format value |
| `0x0C` | `ENABLE` | RW | Bit 0 enables scanout |
| `0x10` | `VSYNC` | RO | Bit 0 is vsync IRQ level |
| `0x14` | `UNDERFLOW_COUNT` | RW1C-like | Counts active pixels that could not fetch framebuffer data |
| `0x18` | `FETCHED_PIXEL_COUNT` | RW1C-like | Counts active pixels fetched from the framebuffer client |

## Interrupt controller registers

| Offset | Name | Access | Description |
| ---: | --- | --- | --- |
| `0x00` | `ID` | RO | `0x1C00_0001` |
| `0x04` | `PENDING` | RO | Bit `n` is pending state for source ID `n + 1` |
| `0x08` | `ENABLE` | RW | Bit `n` enables source ID `n + 1` |
| `0x0C` | `CLAIM_COMPLETE` | RW | Read returns lowest enabled pending source ID, or 0; write source ID to clear its pending bit |
