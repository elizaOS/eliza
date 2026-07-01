# Compute silicon optimization work order

## Top leverage backlog

| Priority | Optimization | Release boundary |
| --- | --- | --- |
| P0 | Replace the tiny CPU contract with a Chipyard Rocket or CVA6 integration path. | No Android boot claim until BSP logs and boot transcripts exist. |
| P0 | Keep DMA as the first shared-memory performance primitive and prove ordering, backpressure, and error handling. | No coherent DMA claim until memory-system verification exists. |
| P1 | Increase memory bandwidth before adding wider accelerators. | No benchmark claim from simulator wall-clock time. |
| P1 | Apply the modeled CPU+NPU no-throttle operating point in `soc-optimized-operating-point.yaml`: 1.4 W CPU/AP active budget, 1.2 W NPU active budget, 44 dense INT8 TOPS modeled base, and 208 GB/s sustained memory target with 5% memory/TOPS/power guardbands. | No design claim until `make soc-optimization` still matches the work order and real target evidence replaces the model. |
| P1 | Add NPU operator coverage only with unsupported op count and CPU fallback percentage. | No AI throughput claim without real calibrated runs. |
| P2 | Explore cache, scratchpad, quantization, compression, and tiling for performance per watt. | No size or power win claim without synthesis and power evidence. |

Scale-up work must keep the RTL contract, software header, cocotb evidence, and
benchmark metadata in sync.
