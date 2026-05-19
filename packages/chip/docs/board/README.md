# Eliza e1 demo board

The board target is a contract artifact for first-article bring-up planning, not a manufacturable PCB yet.

Minimal demo board contents:

- Placeholder QFN64 chip symbol and footprint.
- `3.3 V` IO rail.
- `1.8 V` core rail.
- External oscillator.
- Reset button.
- MCU/debug header driving the demo MMIO interface.
- 8 LEDs on GPIO outputs.
- IRQ test points.
- JTAG/debug header reserved.

The board must not be released for fabrication until the package, padframe, pinout, ESD, and rail-current assumptions are replaced with foundry/package-specific data.

Physical TH1520 reference-board procurement and validation are tracked in
[`docs/board/th1520-procurement-test-plan.md`](../docs/board/th1520-procurement-test-plan.md).
