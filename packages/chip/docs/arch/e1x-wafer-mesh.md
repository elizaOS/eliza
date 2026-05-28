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

That command also emits sidecar repair/model handoff artifacts next to the main
report: a high-failure wafer-sort defect map, a repair manifest that points
back to the defect-map artifact by SHA-256, a compact repair ROM JSON/hex image
that points back to the repair manifest, a deterministic quantized model-shard
sample, and a high-failure model execution trace that links back to both the
repair manifest and the shard sample.

The scaled profile currently models `e1x_wse_riscv_mesh_8gb_v0` as a 512 x 342
logical mesh with 16 spare rows and 16 spare columns. At 48 KiB per logical
core, this provides 8208 MiB of distributed SRAM. The model-load demo places a
13B-parameter 4-bit static graph (`e1x_llm_13b_w4a8_static_graph`) on wafer with
reserved runtime/activation/metadata SRAM. It then simulates a deterministic
`prefill_2048_decode_128_static_int4` run after both a normal wafer-sort defect
scenario and a high-failure repair-stress scenario.
The same command also maps the checked `llama13b-w4a8-manifest.json`
transformer manifest through `compiler/runtime/e1x_graph_mapper.py`, writes
`e1x-real-graph-model-load.json`, and verifies that the real graph placement
loads and executes under the high-failure repair-stress map.

Run the benchmark harness gate, including report schema validation, E1
comparison checks, normal defect repair, high-failure repair, quantized
model-load checks, the high-failure model execution trace, and repair-handoff
sidecar validation, with:

```sh
python3 scripts/check_e1x_benchmark.py
```

Run the real-graph kernel-dispatch codegen gate, which emits concrete PE boot
words from the checked 13B W4A8 graph placement, validates a deterministic
signed W4A8 microkernel numerical proof, and emits a tensor tile / K-wave
schedule plus a schedule-derived architecture-level cycle estimate for every
placed layer, with:

```sh
python3 scripts/check_e1x_kernel_codegen.py
```

Run the RTL repair-ROM consumer simulation with:

```sh
python3 scripts/check_e1x_repair_rom_cocotb.py
```

Run the fabric simulation gate, including the production credit-flow-controlled
router and two-router lossless-chain proof, with:

```sh
python3 scripts/check_e1x_fabric_cocotb.py
```

Run the E1X formal safety gate, including the production credit router,
legacy mesh router, and repair-state/route-table proofs, with:

```sh
python3 scripts/check_e1x_formal.py
```

## Current E1X Contract

- ISA target: integer `RV64IM_Zicsr_Zifencei` processing elements for the
  quantized W4A8 inference path. RV F/D and full architectural-compliance
  evidence remain out of scope for the current E1X package.
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
- Production fabric router: `rtl/e1x/e1x_credit_router.sv` is the current
  input-buffered, credit-flow-controlled router intended to replace the legacy
  combinational router in production fabric paths. Its cocotb gate verifies
  route-table programming/readback, per-direction routing, backpressure without
  silent drops, credit exhaustion and recovery, round-robin fairness under
  contention, repair-drop reporting, and a two-router lossless burst chain. The
  formal gate verifies the reduced-parameter credit router's bounded FIFO and
  credit counters, no grant without output space and credit, repair-disabled
  route/drop behavior, and route-table programming/readback. The aggregate
  fabric gate includes this credit-router cocotb gate so fabric evidence covers
  both repair routing semantics and congestion-safe flow control.
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
- PE-core RTL: `rtl/e1x/e1x_pe_core.sv` is the current standalone processing
  element core. It boot-loads instructions into the per-PE local SRAM, executes
  RV64I integer, M-extension multiply/divide/remainder, Zicsr counters/scratch,
  and Zifencei no-op ordering behavior, and exposes the wavelet fabric through
  local MMIO registers. `scripts/check_e1x_pe_core_cocotb.py` runs assembled
  program tests for arithmetic, control flow, loads/stores, CSR behavior,
  ECALL/EBREAK halt, wavelet RX/TX, and a generated signed W4A8 dot-product
  program derived from `eliza.e1x.w4a8_microkernel_proof.v1`; the aggregate core
  cocotb gate includes this PE-core report alongside the legacy tiny-core tile
  contract and local SRAM shard-loader tests.
- Local SRAM integrity and DFT flow: `rtl/e1x/e1x_sram_ecc.sv` provides the
  SECDED encode/decode path and correction/detection counters for 32-bit local
  SRAM words, while `rtl/e1x/e1x_mbist.sv` provides the March C- local-SRAM
  manufacturing-test sequencer with pass/fail and failing-address/bit evidence.
  `scripts/check_e1x_dft_cocotb.py` proves the ECC and MBIST blocks in cocotb,
  and `scripts/check_e1x_dft_strategy.py` keeps the scan/DFT strategy document
  coupled to those RTL artifacts.
- Model-run flow: a deterministic W4A8 static graph execution model reports
  load cycles, prefill cycles, decode cycles, activation wavelets, repaired-hop
  penalty, decode tokens/s, and a repeatable output checksum under the
  high-failure defect map. The scaled generator writes the high-failure trace as
  an `eliza.e1x.quantized_model_execution_trace.v1` sidecar, and the benchmark
  gate validates the trace hash, repair-manifest link, model-shard link, golden
  trace match, output checksum, and total-cycle evidence.
- Real-graph mapping flow: `compiler/runtime/e1x_graph_mapper.py` parses the
  checked 13B W4A8 transformer manifest, assigns every layer to concrete
  logical mesh coordinates, verifies per-core SRAM occupancy and routing-color
  bounds, and feeds that placement into the same wafer repair/model-execution
  accounting. The graph-mapper and benchmark gates both require the real graph
  to load and produce a high-failure execution checksum after repair.
- Kernel-dispatch codegen: `compiler/runtime/e1x_kernel_codegen.py` converts the
  real graph placement into deterministic RV64IM PE boot words for every placed
  layer. Each generated dispatch program materializes layer/core/shard metadata,
  writes a layer dispatch token to the PE wavelet TX MMIO register, and halts
  with ECALL. `scripts/check_e1x_kernel_codegen.py` validates that every real
  graph layer has a generated dispatch stream, the plan links to the placement
  artifact hash, each emitted word uses PE-supported LUI/ADDI/SW/ECALL
  encodings, and dispatch payloads encode layer index, fabric color, and
  assigned-core count. The same gate writes
  `eliza.e1x.w4a8_microkernel_proof.v1`, a deterministic signed-int4-weight /
  signed-int8-activation numerical proof over every placed layer: packed W4
  words are unpacked, accumulated into signed int32, requantized to signed int8,
  and independently checked by the gate. This is the checked dispatch/control
  and scalar microkernel semantics layer. The gate also writes
  `eliza.e1x.tensor_tile_schedule.v1`, which assigns each layer's output rows to
  its placed cores and splits the K dimension into deterministic activation
  waves while proving row coverage, K-wave presence, and per-core SRAM fit. This
  feeds `eliza.e1x.schedule_execution_estimate.v1`, a deterministic
  architecture-level cycle estimate tied to the scheduled rows, K waves, assigned
  cores, W4A8 MAC count, and fabric bisection model. This is not yet
  cycle-accurate full tensor execution.
- Comparison: reports keep E1 and E1X separate by comparing E1X against the
  existing `open_2028_sota_160tops` E1 NPU architecture model.

## Evidence Scope

This is architecture-simulation evidence. It demonstrates SRAM sizing, model
placement, deterministic model execution, defect-map artifact generation,
repair-manifest handoff, spare remapping, and repaired route validation at
scale. It does not claim RTL completion, PDK signoff, scan/ATPG coverage,
physical wafer sort, package feasibility, measured silicon benchmark evidence,
or a production compiler for arbitrary LLM graphs.

## Completion Gates Still Missing

- RV F/D units and formal/full architectural compliance for the E1X processing
  element. The current gated PE core covers RV64IM_Zicsr_Zifencei integer
  execution for the quantized inference path, not floating-point ISA support or
  full RISC-V compliance.
- Full-wafer production mesh integration around the credit router, including
  complete route-table SRAM/fuse sizing, boot-time programming across every
  tile, and network-level deadlock/liveness proof. The current credit-router
  RTL, cocotb gate, and reduced-parameter formal safety proof are present, but
  full-wafer fabric integration remains open.
- Foundry scan-chain insertion, ATPG coverage, at-speed test, foundry SRAM macro
  MBIST collars, and measured silicon DFT evidence. The local SRAM ECC/MBIST
  RTL units and DFT strategy gate are present, but foundry-flow DFT remains
  outside this package.
- Silicon fuse burning and the OTP/fuse read port for repair programming. The
  boot-time repair-route programming logic is implemented in `fw/e1x/` and
  verified in simulation against the real generated `eliza.e1x.repair_rom.v1`
  image (it streams every remap/route word through the MMIO programmer protocol
  and reconstructs the route table), but the fuse window and OTP read path are
  modeled, not silicon.
- Cycle-accurate full tensor-kernel backend for the placed graph: vectorized
  int4/int8 MAC loops in PE instruction streams, accumulation layout across
  cores, fabric reduction/merge scheduling, and full-output numerical proof. The
  architecture-level placement/sharding/capacity mapping is closed by
  `compiler/runtime/e1x_graph_mapper.py`; dispatch/control instruction streams,
  deterministic scalar W4A8 microkernel semantics, and row/K-wave tensor
  scheduling plus schedule-derived architecture cycle estimates are checked by
  `compiler/runtime/e1x_kernel_codegen.py`; the cycle-accurate full tensor
  executor remains.
- Formal, full-wafer RTL, PD, package, thermal, and power evidence.
- Measured benchmark evidence against E1 on FPGA, board, or silicon.
