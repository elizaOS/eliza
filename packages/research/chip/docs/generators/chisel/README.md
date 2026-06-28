# Chisel IP generators

Use this directory for small project-owned Chisel generators before they are promoted into Chipyard integration.

Initial candidates:

```text
NPU register generator
DMA descriptor queue
display register block
interrupt aggregation glue
```

CPU/AP rule: do not grow a repo-local Chisel application core here. The
Linux-capable AP path is the pinned Chipyard/Rocket path in
`generators/chipyard/eliza-rocket-manifest.json`. Chisel blocks in this
directory may provide MMIO peripherals or glue consumed by
`ElizaRocketConfig`, but CPU privilege, CSR, trap, cache, MMU, and Linux
boot behavior must come from the selected Rocket/Chipyard integration.
