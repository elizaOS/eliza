# Interrupt map

The e1 chip exposes level-style interrupt outputs. The CPU/interconnect scaffold adds a small PLIC-style interrupt controller contract at `0x0C00_0000`.

| Signal | Source | Meaning |
| --- | --- | --- |
| `irq_timer` | Peripheral block | Timer count reached compare |
| `irq_dma` | DMA block | DMA command finished |
| `irq_npu` | NPU block | NPU command finished |
| `irq_vsync` | Display block | Display vsync pulse/level placeholder |

## Interrupt controller source IDs

Source ID 0 is reserved, matching PLIC-style claim semantics. Current source IDs are:

| Source ID | Source | Notes |
| ---: | --- | --- |
| 1 | Timer | Future machine/supervisor timer gateway |
| 2 | DMA | DMA completion |
| 3 | NPU | NPU command completion |
| 4 | Display | Vsync or display event |

The current `e1_interrupt_controller` latches asserted source bits into `PENDING`, gates CPU external interrupt with `ENABLE`, returns the lowest enabled pending source ID on claim, and clears a pending source when software writes that source ID to complete. If the physical source remains asserted, it may re-pend after completion.

The controller target accepts independently arriving AXI-Lite write address and write data channels, then updates registers only after both halves of a write have been captured.

The full-chip interrupt map must preserve stable source IDs as PLIC/IMSIC integration is added.
