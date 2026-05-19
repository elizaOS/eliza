# E1 SoC floorplan note

The e1 chip is small enough to run as a flat design. The full project should move to hierarchical hardening:

```text
npu_tile
dma_subsystem
display_subsystem
peripheral_subsystem
cpu_subsystem
top_level_soc
```

The OpenLane config uses an absolute toy die area only to prove the flow entry point.
