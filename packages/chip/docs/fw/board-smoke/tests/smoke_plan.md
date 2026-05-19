# Board smoke test plan

The board bring-up smoke firmware runs on an external MCU/debug adapter and
exercises the demo chip through the debug/MMIO interface. Before any MMIO
transaction, the operator must confirm power rails are current-limited and in
range for the selected package, adapter, and board revision.

Pass criteria:

1. Hold reset low and verify GPIO/IRQ outputs low.
2. Verify power-good state and record rail voltage/current before clocks run.
3. Release reset and wait 16 clock cycles.
4. Read boot ROM word 0: expect `0x4F50534F`.
5. Read boot ROM word 1: expect `0x43484950`.
6. Write `SCRATCH = 0xA5A55A5A`, read it back.
7. Write `GPIO_OUT = 0xA5`, verify LED/test-point state.
8. Configure timer compare and observe `IRQ_TIMER`.
9. Program DMA start and observe `IRQ_DMA`.
10. Program NPU operands `17 + 25`, observe `IRQ_NPU`, read result `42`.
11. Enable display block and observe `IRQ_VSYNC`.

Any mismatch is a first-article failure until explained by an approved waiver.
