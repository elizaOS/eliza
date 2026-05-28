# E1X Wafer-Mesh Architecture Model

E1X is tracked as a separate chip direction from E1. E1 remains the
Ariane/CVA6-derived phone SoC path. E1X is the Cerebras-inspired path: many
tiny RISC-V processing elements, local SRAM beside each element, a uniform
mesh fabric, and post-test routing repair around defective cores and links.

The checked architecture model lives in `compiler/runtime/e1x_wafer_model.py`.
The base evidence command is:

```sh
python3 scripts/generate_e1x_wafer_mesh_evidence.py
```

The scaled SRAM/model-load/model-run evidence command is:

```sh
python3 scripts/generate_e1x_scaled_model_evidence.py
```

That command also emits sidecar repair-handoff artifacts next to the main
report: a high-failure wafer-sort defect map, a repair manifest that points
back to the defect-map artifact by SHA-256, and a compact repair ROM JSON/hex
image that points back to the repair manifest.

The scaled profile currently models `e1x_wse_riscv_mesh_8gb_v0` as a 512 x 342
logical mesh with 16 spare rows and 16 spare columns. At 48 KiB per logical
core, this provides 8208 MiB of distributed SRAM. The model-load demo places a
13B-parameter 4-bit static graph (`e1x_llm_13b_w4a8_static_graph`) on wafer with
reserved runtime/activation/metadata SRAM. It then simulates a deterministic
`prefill_2048_decode_128_static_int4` run after both a normal wafer-sort defect
scenario and a high-failure repair-stress scenario.

Run the benchmark harness gate, including report schema validation, E1
comparison checks, normal defect repair, high-failure repair, quantized
model-load checks, the high-failure model execution trace, and repair-handoff
sidecar validation, with:

```sh
python3 scripts/check_e1x_benchmark.py
```

Run the RTL repair-ROM consumer simulation with:

```sh
python3 scripts/check_e1x_repair_rom_cocotb.py
```

## Current E1X Contract

- ISA target: tiny `rv64imafdc_zicsr_zifencei`-class RISC-V core array.
- Base logical mesh: 32 x 32 active processing elements.
- Scaled logical mesh: 512 x 342 active processing elements, 175104 logical
  cores, and 8208 MiB distributed SRAM.
- Spare fabric: spare rows and spare columns for deterministic repair
  experiments.
- Per-core memory: 48 KiB local SRAM, matching the public Cerebras-style design
  point captured in `/home/shaw/Downloads/cerebras.md`.
- Fabric: 32-bit wavelet-style payloads, 24 routing colors, and neighboring
  mesh links modeled as bidirectional per-cycle transfer paths.
- Defect flow: deterministic defect-map generation, logical-to-physical spare
  replacement, and A* mesh route validation over normal and high-failure
  scenarios.
- Repair handoff: the scaled generator writes an
  `eliza.e1x.wafer_sort_defect_map.v1` sidecar and an
  `eliza.e1x.repair_manifest.v1` sidecar. The repair manifest records remapped
  logical cores, sampled repaired routes, route-table programming metadata, and
  the source defect-map hash.
- Repair ROM: the repair manifest is compiled into an `eliza.e1x.repair_rom.v1`
  64-bit word image plus a `.hex` programming image. The ROM encodes header
  metadata, logical-to-physical remap words, sampled route words, and source
  artifact hashes for firmware/RTL handoff validation. Route words pack a
  logical source index, logical destination index, 3-bit first-hop direction,
  and 16-bit hop count, so the RTL handoff can steer a next hop rather than
  only count path length. The repair-ROM cocotb gate streams the generated
  high-failure 8GB scaled-model repair ROM sidecar through the RTL loader and
  verifies decoded remap/route counts against the JSON/hex artifact. The same
  generated ROM is also streamed into the RTL repair route table and checked
  against sampled-route manifest lookups, and into a large repair-state RTL
  instance that stores all generated high-failure remaps for selected
  logical-to-physical lookup checks. The gate also includes undersized
  repair-state and route-table negative tests that prove bounded RTL storage
  raises an observable overflow status instead of silently truncating repair
  records. A firmware-style MMIO programming harness stages 32-bit low/high
  repair-word halves, pushes the resulting 64-bit words into the same loader
  stream, and proves route-table lookup success plus invalid-access and clear
  recovery behavior. A larger generated-ROM variant streams the complete
  high-failure 8GB repair ROM sidecar through that MMIO path into the RTL route
  table and validates manifest-sampled first-hop directions and hop counts.
  The tile-level MMIO harness then binds the same programmer to the
  repair-routed tile, proving firmware-loaded repair routes can steer a fabric
  wavelet around a disabled output and that clear removes the programmed route.
  A generated high-failure variant uses a large MMIO-routed tile instance,
  streams the complete 8GB repair ROM sidecar through the tile programming
  port, and verifies the tile fabric takes the manifest-selected first hop.
- Repair ROM RTL: `rtl/e1x/e1x_repair_rom_loader.sv` consumes the 64-bit image
  format and emits decoded remap and route records. `rtl/e1x/e1x_repair_state.sv`
  stores those records in bounded remap/route memories and exposes lookup ports
  for remaps, first-hop route overrides, and repair-storage overflow status.
  `rtl/e1x/e1x_repair_mmio_programmer.sv` provides the current firmware-facing
  programming shim: software writes staged 32-bit halves, pushes repair words
  with valid/ready backpressure, reads status/count registers, and can pulse
  clear to reload the downstream repair consumer.
  `rtl/e1x/e1x_repair_aware_router.sv` applies decoded repair-route directions
  over the live color route table before forwarding through the mesh router.
  `rtl/e1x/e1x_repair_route_table.sv` stores ROM-loaded route records behind
  multi-ingress combinational lookup ports and exposes the same overflow status.
  `rtl/e1x/e1x_repair_routed_router.sv` is the current bridge proof: it loads
  repair ROM words, looks up each packet's logical source/destination, drives
  the repair-aware router override for every router ingress port, and carries
  repair-table overflow status to integration logic.
  `rtl/e1x/e1x_repair_routed_tile.sv` carries that bridge to the tile boundary:
  fabric ingress ports provide logical source/destination sideband metadata,
  the tile loads repair ROM words, and the core path remains bound to the same
  tiny-core contract. The repair-routed 2x2 mesh cocotb harness propagates that
  sideband over registered links and proves that different tiles can apply
  different ROM-loaded first-hop directions for the same logical source and
  destination.
  `rtl/e1x/e1x_repair_mmio_routed_tile.sv` wraps the programmer and repair-routed
  tile together so MMIO writes, status reads, and clear pulses feed the tile
  repair ROM stream at the same boundary used by fabric traffic.
- Model-load flow: quantized weights are sharded across repaired logical cores,
  runtime SRAM is reserved per core, and the model is accepted only if both
  aggregate SRAM and per-core shard capacity fit. `rtl/e1x/e1x_local_sram_shard_loader.sv`
  is the current RTL-facing shard-load proof: it models the 48 KiB local SRAM
  capacity, accepts packed 32-bit W4 weight words, exposes loaded-byte and
  checksum counters, supports readback, and flags out-of-capacity shard writes.
  The cocotb gate loads a deterministic quantized shard, verifies readback
  including the last valid local SRAM word, and proves overflow plus clear
  recovery at the per-tile memory boundary.
- Model-run flow: a deterministic W4A8 static graph execution model reports
  load cycles, prefill cycles, decode cycles, activation wavelets, repaired-hop
  penalty, decode tokens/s, and a repeatable output checksum under the
  high-failure defect map.
- Comparison: reports keep E1 and E1X separate by comparing E1X against the
  existing `open_2028_sota_160tops` E1 NPU architecture model.

## Evidence Scope

This is architecture-simulation evidence. It demonstrates SRAM sizing, model
placement, deterministic model execution, defect-map artifact generation,
repair-manifest handoff, spare remapping, and repaired route validation at
scale. It does not claim RTL completion, PDK signoff, DFT coverage, physical
wafer sort, package feasibility, measured silicon benchmark evidence, or a
production compiler for arbitrary LLM graphs.

## Completion Gates Still Missing

- Complete RV64IMAFDC/Zicsr/Zifencei-compatible core RTL for the E1X processing
  element.
- Production mesh router RTL with queues, route-table programming protocol,
  repair fuses/ROM, and formal checks.
- SRAM BIST/ECC/parity policy and scan/DFT insertion strategy.
- Full route-table SRAM or fuse/ROM programming integration in boot firmware
  beyond the current bounded MMIO programming proof.
- Compiler/runtime mapping from real quantized model graphs to logical mesh
  coordinates.
- Formal, full-wafer RTL, PD, package, thermal, and power evidence.
- Measured benchmark evidence against E1 on FPGA, board, or silicon.
