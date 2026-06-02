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
loads and executes under the normal and high-failure repair-stress maps. The
real-graph path also writes
`e1x-real-graph-model-load.normal_defect_map.json`,
`e1x-real-graph-model-load.normal_repair_manifest.json`,
`e1x-real-graph-model-load.normal_repair_rom.json`/`.hex`,
`e1x-real-graph-model-load.high_failure_defect_map.json`, and
`e1x-real-graph-model-load.high_failure_repair_manifest.json` plus
`e1x-real-graph-model-load.high_failure_repair_rom.json`/`.hex` so both defect
scenarios have explicit wafer-sort, repair-manifest, and boot-programmable
repair-ROM sidecars. It also writes
`e1x-real-graph-model-load.normal_execution_trace.json` and
`e1x-real-graph-model-load.high_failure_execution_trace.json`, hash-linked
execution trace sidecars that reference the placement artifact and carry output
checksums, total cycles, route checks, and sampled layer checksums.

Run the benchmark harness gate, including report schema validation, E1
comparison checks, normal defect repair, high-failure repair, quantized
model-load checks, the high-failure model execution trace, and repair-handoff
sidecar validation, with:

```sh
python3 scripts/check_e1x_benchmark.py
```

Run the dedicated E1/E1X comparison audit, which cross-checks the canonical E1
baseline, E1X local-SRAM residency ratio, repaired normal/high execution
traces, and planning power/thermal dimensions without upgrading the claim
beyond architecture-model evidence, with:

```sh
python3 scripts/check_e1x_e1_comparison_audit.py
```

Run the real-graph kernel-dispatch codegen gate, which emits concrete PE boot
words from the checked 13B W4A8 graph placement, validates a deterministic
signed W4A8 microkernel numerical proof, and emits a tensor tile / K-wave
schedule plus fabric color-pressure, per-color fabric timing, and
architecture-level cycle estimates for every placed layer, with:

```sh
python3 scripts/check_e1x_kernel_codegen.py
```

Run the RTL repair-ROM consumer simulation with:

```sh
python3 scripts/check_e1x_repair_rom_cocotb.py
```

Run the aggregate E1X evidence-bundle gate, which checks the current benchmark,
yield/repair margin, graph-mapper, kernel-codegen, model-load stream,
tensor-numerics, tensor cycle-executor, sampled tensor fabric-executor,
sampled tensor output-checksum, bounded reduction-merge RTL,
full-output coverage-gap, execution coverage ladder, full-output workplan,
vector-kernel template, looped vector-kernel skeleton,
per-layer vector-kernel codegen,
sampled vector-kernel executor,
vector-kernel window executor,
vector-window fabric checksum,
window-shard linkage,
window-repair linkage,
window route validation,
window repair-ROM linkage,
window execution-trace linkage,
fabric-reduction accounting, core/PE cocotb, repair-ROM RTL,
boot-repair firmware, repair fuse/SRAM capacity, repair fuse-reader RTL, tile,
DFT cocotb, DFT strategy, legacy/repair fabric, production credit-router,
parameterized mesh-fabric, mesh route-discipline/liveness evidence,
power/thermal planning, formal, and RTL-contract reports as one top-level
architecture-simulation evidence bundle.
It also verifies that each required report declares evidence paths and that
those files, including the model-shard sample executor report and archived
cocotb result XMLs, are present. Run it with:

```sh
python3 scripts/check_e1x_evidence_bundle.py
```

Run the repair fuse/SRAM capacity gate, which sizes the production repair
fuse/ROM window and dedicated repair SRAM against the generated real-graph
normal and high-failure repair images, with:

```sh
python3 scripts/check_e1x_repair_capacity.py
```

Run the repair fuse-reader gate, which verifies the RTL controller that streams
a persistent OTP/fuse macro read port into the existing 64-bit repair-ROM loader
valid/ready contract against the generated normal and high-failure repair
images, with:

```sh
python3 scripts/check_e1x_repair_fuse_reader.py
```

Run the yield/repair-margin gate, which independently validates the real-graph
normal and high-failure defect maps against their repair manifests, spare
budget, and sampled repaired routes, with:

```sh
python3 scripts/check_e1x_yield_repair_margin.py
```

Run the clustered repair stress gate, which audits deterministic row/column
stripe failure cases against the 16 spare rows, 16 spare columns, and repair
capacity envelope while also proving over-budget clustered cases are detected,
with:

```sh
python3 scripts/check_e1x_clustered_repair_stress.py
```

Run the tensor-numerics gate, which independently recomputes every sampled W4A8
dot product in the real-graph microkernel proof and checks schedule/placement
alignment, with:

```sh
python3 scripts/check_e1x_tensor_numerics.py
```

Run the tensor cycle-executor gate, which replays every sampled W4A8 proof row
as scalar RV64IM add/mul/shift instruction streams and ties the result to the
PE-core generated W4A8 cocotb sample, with:

```sh
python3 scripts/check_e1x_tensor_cycle_executor.py
```

Run the sampled tensor fabric-executor gate, which takes the scalar row
partials from every proof layer, merges them with the same configured-group
signed accumulation and saturation semantics covered by the RTL reduction merge
primitive, and links the sampled execution path to the 24-color tensor schedule,
with:

```sh
python3 scripts/check_e1x_tensor_fabric_executor.py
```

Run the sampled tensor output-checksum gate, which recomputes the post-W4A8
requantized sampled output rows for every proof layer and links those sampled
outputs to the normal/high execution trace checksum sidecars, with:

```sh
python3 scripts/check_e1x_tensor_output_checksum.py
```

Run the full-output coverage-gap gate, which measures sampled tensor output
evidence against every scheduled real-graph output row and MAC, with:

```sh
python3 scripts/check_e1x_full_output_coverage.py
```

Run the execution coverage-ladder gate, which keeps real sampled model-output
coverage separate from deterministic vector-window fabric coverage while
quantifying the remaining full-output gap, with:

```sh
python3 scripts/check_e1x_execution_coverage_ladder.py
```

Run the full-output workplan gate, which converts the tensor schedule into a
deterministic compact plan covering every output row, MAC, packed vector-word
operation, K wave, core wave, and routing color without claiming execution, with:

```sh
python3 scripts/check_e1x_full_output_workplan.py
```

Run the full-output checksum-manifest gate, which commits every scheduled
real-graph output row identity and links the sampled-output, routed-window, and
normal/high repaired-run checksum sidecars while preserving the missing
full-output real-weight checksum blocker, with:

```sh
python3 scripts/check_e1x_full_output_checksum_manifest.py
```

Run the expanded real-weight row gate, which executes first/mid/last output rows
for every placed real-graph layer across the full K dimension, increasing real
W4A8 MAC coverage while still preserving the missing full-output checksum
blocker, with:

```sh
python3 scripts/check_e1x_expanded_real_weight_rows.py
```

Run the stratified full-K real-weight row gate, which executes 16 output rows
per placed real-graph layer across the full K dimension and records the
remaining full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_stratified_full_k_real_weight_rows.py
```

Run the stratified full-K repair execution gate, which routes the 16-row-per-
layer full-K evidence set through both normal and high-failure repair manifests
and checks logical output invariance against distinct physical route checksums,
with:

```sh
python3 scripts/check_e1x_stratified_full_k_repair_execution.py
```

Run the dense stratified full-K repair execution gate, which doubles the
repair-aware full-K evidence to 32 rows per placed layer while preserving the
full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_dense_stratified_full_k_repair_execution.py
```

Run the ultra-dense stratified full-K repair execution gate, which doubles the
dense gate again to 64 rows per placed layer and checks the same normal/high
repair-route invariants, with:

```sh
python3 scripts/check_e1x_ultra_dense_stratified_full_k_repair_execution.py
```

Run the hyper-dense stratified full-K repair execution gate, which doubles the
ultra-dense gate again to 128 rows per placed layer and checks the same
normal/high repair-route invariants, with:

```sh
python3 scripts/check_e1x_hyper_dense_stratified_full_k_repair_execution.py
```

Run the full norm real-weight row gate, which executes every output row for the
complete `norm` layer class across its full K dimension and records the
remaining matmul-heavy full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_full_norm_real_weight_rows.py
```

Run the vocab sampled-K real-weight row gate, which executes every output row of
the singleton `embedding` and `lm_head` layers over a wider sampled-K window and
records the remaining full-K/full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_vocab_sampled_k_real_weight_rows.py
```

Run the repaired real-weight execution gate, which maps the currently executed
real-weight rows through both normal and high-failure repair manifests and
checks that logical output checksums remain invariant while physical route
checksums differ, with:

```sh
python3 scripts/check_e1x_repaired_real_weight_execution.py
```

Run the real-weight coverage ladder gate, which accounts for every current
real-weight row executor against the full-output workplan and separates 100%
represented row/full-K MAC identity coverage from the remaining sampled-K
execution blocker, with:

```sh
python3 scripts/check_e1x_real_weight_coverage_ladder.py
```

Run the attention-output sampled-K real-weight row gate, which executes every
`attn_out_proj` output row over a bounded sampled-K window and records the
remaining full-K/full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_attn_out_sampled_k_real_weight_rows.py
```

Run the attention-QKV sampled-K real-weight row gate, which executes every
`attn_qkv_proj` output row over a bounded sampled-K window and records the
remaining full-K/full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_attn_qkv_sampled_k_real_weight_rows.py
```

Run the MLP-gate sampled-K real-weight row gate, which executes every
`mlp_gate_proj` output row over a bounded sampled-K window and records the
remaining full-K/full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_mlp_gate_sampled_k_real_weight_rows.py
```

Run the MLP-up sampled-K real-weight row gate, which executes every
`mlp_up_proj` output row over a bounded sampled-K window and records the
remaining full-K/full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_mlp_up_sampled_k_real_weight_rows.py
```

Run the MLP-down sampled-K real-weight row gate, which executes every
`mlp_down_proj` output row over a bounded sampled-K window and records the
remaining full-K/full-output checksum blocker, with:

```sh
python3 scripts/check_e1x_mlp_down_sampled_k_real_weight_rows.py
```

Run the vector-kernel template gate, which emits a concrete RV64IM unrolled W4A8
program template for one packed int4 vector word and scales it against the
full-output workplan without claiming looped per-layer execution, with:

```sh
python3 scripts/check_e1x_vector_kernel_template.py
```

Run the looped vector-kernel skeleton gate, which emits concrete RV64IM branch
and pointer-update control words for iterating output rows and packed vector
words, then scales that loop-control overhead against the full-output workplan,
with:

```sh
python3 scripts/check_e1x_looped_vector_kernel_skeleton.py
```

Run the per-layer vector-kernel codegen gate, which combines the full-output
workplan, vector-word template, and loop skeleton into deterministic per-layer
codegen accounting without claiming execution of those generated rows, with:

```sh
python3 scripts/check_e1x_per_layer_vector_codegen.py
```

Run the sampled vector-kernel executor gate, which replays the proof rows as
packed int4 vector-word operations linked to the per-layer codegen artifact and
PE-core RTL cocotb evidence, with:

```sh
python3 scripts/check_e1x_sampled_vector_kernel_executor.py
```

Run the vector-kernel window executor gate, which expands packed W4A8 vector
execution to a deterministic 64-row window per proof layer while preserving the
full-output execution blocker, with:

```sh
python3 scripts/check_e1x_vector_kernel_window_executor.py
```

Run the vector-window fabric-checksum gate, which routes and reduces the
64-row-per-layer vector execution window by scheduled routing color and links it
to the RTL reduction-merge evidence, with:

```sh
python3 scripts/check_e1x_vector_window_fabric_checksum.py
```

Run the window-shard linkage gate, which maps the deterministic vector-window
execution rows onto the real placed model's loaded local-SRAM shard ranges and
loader-word accounting, with:

```sh
python3 scripts/check_e1x_window_shard_linkage.py
```

Run the window-repair linkage gate, which maps the vector-window touched logical
cores through the normal and high-failure repair manifests and verifies their
post-repair physical targets are usable, with:

```sh
python3 scripts/check_e1x_window_repair_linkage.py
```

Run the window route-validation gate, which recomputes repaired physical routes
for adjacent logical neighbor pairs inside the executed vector-window touched
core set under normal and high-failure defect maps, with:

```sh
python3 scripts/check_e1x_window_route_validation.py
```

Run the window repair-ROM linkage gate, which decodes the generated normal and
high-failure repair ROM images and verifies they program the remap words needed
by the executed vector-window touched cores, with:

```sh
python3 scripts/check_e1x_window_repair_rom_linkage.py
```

Run the window execution-trace linkage gate, which ties the normal/high
real-graph execution traces to the repair ROM and window route evidence and
checks the high-failure slowdown path, with:

```sh
python3 scripts/check_e1x_window_execution_trace_linkage.py
```

Run the fabric-reduction gate, which recomputes scheduled reduction and
activation wavelets by routing color, checks fabric color timing linkage, and
ties the accounting to mesh delivery plus bounded RTL merge-primitive evidence
without claiming full vectorized tensor fabric execution, with:

```sh
python3 scripts/check_e1x_fabric_reduction.py
```

Run the reduction-merge RTL gate, which verifies the bounded merge primitive
for one configured reduction group at a time, including signed partial sums,
valid/ready backpressure, tag mismatch accounting, config rejection, and int32
saturation, with:

```sh
python3 scripts/check_e1x_reduction_merge_cocotb.py
```

Run the full model-load stream gate, which accounts for every placed real-graph
weight shard as local-SRAM loader transactions, checks all shards fit the
placement SRAM budget, and links the full placement stream to the generated
shard-loader cocotb sample, with:

```sh
python3 scripts/check_e1x_model_load_stream.py
```

Run the model-shard sample executor gate, which executes the checked
high-failure model-shard sample payload through W4A8 vector semantics: every W4
word from one complete per-core weight shard plus the capacity-end sentinel
word, with the loader checksum tied back to the full model-load stream, full
scheduled-row deterministic window, and local-SRAM loader cocotb evidence. This
is actual loaded shard-sample execution; it still preserves the missing full
6.5GB quantized weight-payload executor and full-output real-weight checksum
blocker.

```sh
python3 scripts/check_e1x_model_shard_sample_executor.py
```

Run the layer-shard sweep executor gate, which executes generated W4 payloads
for the first, middle, and last shard record from every placed real-graph layer
through W4A8 semantics. This covers all 283 layers and all 8 layer kinds across
687 sampled shard records, linking the sweep to the full model-load stream and
window-shard evidence while preserving the missing full 6.5GB payload execution
and full-output real-weight checksum blocker.

```sh
python3 scripts/check_e1x_layer_shard_sweep_executor.py
```

Run the full-payload manifest gate, which enumerates every placed real-graph
model shard record and commits deterministic first/middle/last W4 probe words
for each shard. This covers all 151,367 shard records and all 1,627,034,880
loader-word transactions as a compact whole-graph payload identity manifest,
while preserving the missing full payload execution and full-output
real-weight checksum blocker.

```sh
python3 scripts/check_e1x_full_payload_manifest.py
```

Run the full-payload repair mapping gate, which maps every committed payload
shard through the generated normal and high-failure repair manifests, verifies
the physical targets avoid blocked cores, and links the result to the repaired
route checksums. This proves the full resident payload placement survives the
modeled defect maps while preserving the missing full payload execution and
silicon/foundry evidence blockers.

```sh
python3 scripts/check_e1x_full_payload_repair_mapping.py
```

Run the full-payload repair-ROM gate, which proves the boot-programmable normal
and high-failure repair ROM images contain the remap words required by every
remapped resident payload shard, and links those ROM payloads to the RTL
repair-ROM loader cocotb plus boot firmware evidence. This preserves the
silicon fuse/OTP and foundry evidence blockers.

```sh
python3 scripts/check_e1x_full_payload_repair_rom.py
```

Run the full-payload repaired-run linkage gate, which ties the full resident
payload manifest, normal/high repair mapping, boot-programmable repair ROMs,
benchmark summary, and normal/high real-graph execution traces into one
modeled repaired-run consistency report. This validates the modeled high-failure
slowdown and output-checksum path while preserving the missing full-output
real-weight checksum blocker.

```sh
python3 scripts/check_e1x_full_payload_repaired_run.py
```

Run the power/thermal planning gate, which estimates dense-peak and real-graph
schedule power against an explicit wafer-scale liquid-cooling envelope without
claiming package or silicon signoff, with:

```sh
python3 scripts/check_e1x_power_thermal.py
```

Run the DFT strategy gate, which emits a structured report tying the SECDED and
March C- cocotb evidence to the fail-closed foundry scan/ATPG/silicon boundary,
with:

```sh
python3 scripts/check_e1x_dft_strategy.py
```

Run the fabric simulation gate, including the production credit-flow-controlled
router and two-router lossless-chain proof, with:

```sh
python3 scripts/check_e1x_fabric_cocotb.py
```

Run the production mesh fabric gate, which instantiates the credit router across
a parameterized tile array with real `e1x_pe_core` nodes and checks multi-hop XY
delivery, with:

```sh
python3 scripts/check_e1x_mesh_fabric_cocotb.py
```

Run the mesh route-discipline/liveness evidence gate, which ties strict XY
route-discipline markers, production mesh/credit-router cocotb evidence, and
local credit-router formal safety evidence while preserving the open full
network-level formal liveness blocker, with:

```sh
python3 scripts/check_e1x_mesh_liveness_evidence.py
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
  verifies decoded remap/route counts against the JSON/hex artifact. It now
  also streams the real-graph normal and high-failure repair ROM sidecars
  through the same RTL loader and route-table lookup path, tying both checked
  13B W4A8 placement repair artifacts to RTL-facing programming evidence. The
  scaled generated ROM
  is also streamed into the RTL repair route table and checked against
  sampled-route manifest lookups, and into a large repair-state RTL instance
  that stores all generated high-failure remaps for selected logical-to-physical
  lookup checks. The gate also includes undersized
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
  Generated tile-level variants use a large MMIO-routed tile instance, stream
  the complete scaled high-failure plus real-graph normal/high-failure repair
  ROM sidecars through the tile programming port, and verify the tile fabric
  takes the manifest-selected first hop for each programmed image.
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
- Production PE tile and mesh fabric top: `rtl/e1x/e1x_pe_tile.sv` integrates the
  real RV64IM_Zicsr_Zifencei `e1x_pe_core` (not the tiny-core contract) with the
  mesh router; its `e1x-tile-cocotb` tests boot a program that runs an
  M-extension MUL and round-trip a fabric wavelet through the router Local port.
  `rtl/e1x/e1x_mesh_fabric.sv` is the parameterized RxC (default 4x4) full-mesh
  top: it instantiates the production `e1x_credit_router` across a tile array of
  real `e1x_pe_core` nodes, wires inter-tile credit-returned links (N<->S,
  E<->W) with boundary tie-offs that fail closed, exposes per-node boot,
  injection, and ejection, and programs per-router route tables for XY
  dimension-order routing. The `e1x-mesh-fabric-cocotb` gate proves multi-hop
  lossless delivery (six router hops corner-to-corner), X-then-Y turns,
  independent multi-color flows, and a real PE core launching a wavelet routed
  across the mesh. This closes the integration gap between the production credit
  router, the real PE core, and the wafer mesh; full-resolution sizing and a
  formal network-level liveness proof remain open (see Completion Gates). The
  `e1x-mesh-liveness-evidence` gate aggregates the XY route-discipline markers,
  local credit-router formal safety checks, and 4x4 mesh cocotb evidence without
  claiming a full network liveness proof.
- Bounded reduction merge RTL: `rtl/e1x/e1x_reduction_merge.sv` accumulates one
  configured tensor reduction group at a time from signed 32-bit fabric
  partials into a 64-bit accumulator, emits a saturated signed 32-bit result,
  and exposes valid/ready backpressure, tag mismatch, count, and overflow
  status. The `e1x-reduction-merge-cocotb` gate covers signed sums,
  backpressured output hold, wrong-group filtering, positive/negative
  saturation, and zero-length config rejection.
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
  and `scripts/check_e1x_dft_strategy.py` emits a structured report that keeps
  the scan/DFT strategy document coupled to those RTL artifacts and the
  fail-closed foundry scan/ATPG/silicon boundary.
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
  to load and produce normal plus high-failure execution checksums after repair.
  The benchmark gate also validates both real-graph defect-map and
  repair-manifest sidecars, their source-map links, blocked-core/link counts,
  remap counts, route-check counts, sampled repair routes, repaired-hop
  penalties, repair-ROM source links, ROM word counts, and JSON/hex image
  consistency. Both real-graph execution-trace sidecar hashes, placement links,
  golden-trace flags, output checksums, and cycle counts are checked too.
  Sampled layer trace route colors are checked against the placement, the
  high-failure trace must be no faster than the normal trace, and the
  schedule-derived execution estimate is required to fit inside the high-failure
  trace's total cycle budget.
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
  also feeds `eliza.e1x.fabric_color_pressure.v1`, which audits activation and
  reduction wavelets across all 24 routing colors,
  `eliza.e1x.fabric_color_timing.v1`, which estimates high-failure
  repair-aware per-color fabric cycles and bounds the peak color by the schedule
  execution estimate, and
  `eliza.e1x.schedule_execution_estimate.v1`, a deterministic architecture-level
  cycle estimate tied to the scheduled rows, K waves, assigned cores, W4A8 MAC
  count, fabric bisection model, and the same high-failure repair-hop penalty
  used by the real-graph model-load report. This is not yet cycle-accurate full
  tensor execution.
- Comparison: reports keep E1 and E1X separate by comparing E1X against the
  existing `open_2028_sota_160tops` E1 NPU architecture model. The benchmark
  gate now reports both the scaled E1X peak/SRAM ratios and the real-graph
  schedule-derived effective TOPS versus the E1 peak baseline, while separately
  showing that the resident W4A8 real graph needs over 100x the E1 local SRAM
  budget but fits within the 8GB E1X SRAM model.

## Evidence Scope

This is architecture-simulation evidence. It demonstrates SRAM sizing, model
placement, deterministic model execution, defect-map artifact generation,
repair-manifest handoff, spare remapping, repaired route validation, and
modeled yield/repair margin at scale. It does not claim RTL completion, PDK
signoff, scan/ATPG coverage, physical wafer sort, package feasibility, measured
silicon benchmark evidence, or a production compiler for arbitrary LLM graphs.

## Completion Gates Still Missing

- RV F/D units and formal/full architectural compliance for the E1X processing
  element. The current gated PE core covers RV64IM_Zicsr_Zifencei integer
  execution for the quantized inference path, not floating-point ISA support or
  full RISC-V compliance. The real `e1x_pe_core` is now integrated into a
  production tile (`rtl/e1x/e1x_pe_tile.sv`) and into the mesh fabric nodes; the
  `e1x-tile-cocotb` gate boots a program on the integrated core (including an
  M-extension MUL the tiny-core cannot decode) and round-trips a fabric wavelet
  through the router Local port.
- Network-level deadlock/liveness *formal* proof for the production mesh. A parameterized RxC
  (default 4x4) mesh fabric top (`rtl/e1x/e1x_mesh_fabric.sv`) now instantiates
  the production `e1x_credit_router` across a tile array with real `e1x_pe_core`
  compute nodes, inter-tile credit-returned links, and boot-time route-table
  programming; the `e1x-mesh-fabric-cocotb` gate proves multi-hop lossless XY
  delivery (up to six router hops corner-to-corner), X-then-Y turns, independent
  multi-color flows, and a real PE core launching a wavelet routed across the
  mesh. XY dimension-order routing is acyclic in the channel-dependency graph
  (deadlock-free by construction). The `e1x-mesh-liveness-evidence` gate now
  checks those route-discipline markers against the mesh RTL, the credit-router
  congestion/drop boundary, the expected 4x4 mesh cocotb tests, and the local
  credit-router formal safety harness; it deliberately records
  `full_formal_network_liveness_proof_missing` as the residual blocker. The
  `e1x-repair-capacity` gate now sizes the full-wafer repair fuse/ROM window and
  dedicated remap/route SRAM against the generated real-graph normal and
  high-failure repair images; a full-mesh formal liveness proof remains open.
- Foundry scan-chain insertion, ATPG coverage, at-speed test, foundry SRAM macro
  MBIST collars, and measured silicon DFT evidence. The local SRAM ECC/MBIST
  RTL units and DFT strategy gate are present, but foundry-flow DFT remains
  outside this package.
- Silicon fuse burning and foundry OTP macro evidence for repair programming.
  The boot-time repair-route programming logic is implemented in `fw/e1x/` and
  verified in simulation against the real generated `eliza.e1x.repair_rom.v1`
  images for the scaled high-failure handoff plus the real-graph normal and
  high-failure handoffs. `rtl/e1x/e1x_repair_fuse_reader.sv` now provides the
  synthesizable controller contract from a persistent 64-bit OTP/fuse read port
  into the repair-ROM loader valid/ready stream, and
  `e1x-repair-fuse-reader` gates it against all generated repair images plus
  Verilator lint. Fuse burning, foundry OTP macro implementation, wafer sort,
  and silicon readback remain open.
- Cycle-accurate full tensor-kernel backend for the placed graph: vectorized
  int4/int8 MAC loops in PE instruction streams, accumulation layout across
  cores, fabric reduction/merge scheduling, and full-output numerical proof. The
  architecture-level placement/sharding/capacity mapping is closed by
  `compiler/runtime/e1x_graph_mapper.py`; dispatch/control instruction streams,
  deterministic scalar W4A8 microkernel semantics, and row/K-wave tensor
  scheduling plus fabric color-pressure/timing and schedule-derived
  architecture cycle estimates are checked by `compiler/runtime/e1x_kernel_codegen.py`.
  The `e1x-model-load-stream` gate now expands the full 283-layer placement into
  151367 local-SRAM shard-load records and 1627034880 loader word transactions,
  validating loader-capacity fit, the aligned 4 KiB/core runtime reserve policy,
  and row-padding overhead against the generated local-SRAM shard-loader cocotb
  sample.
  The `e1x-tensor-numerics` gate independently recomputes all sampled W4A8 MACs
  across the 283 placed layers and verifies proof/schedule/placement alignment;
  the `e1x-tensor-cycle-executor` gate now replays all 1132 sampled rows and
  26180 sampled MACs as scalar RV64IM add/mul/shift instruction streams with
  cycle accounting, linked to the PE-core generated W4A8 cocotb test. The
  `e1x-tensor-fabric-executor` gate now feeds those 1132 scalar row partials
  across 283 proof-layer merge groups, checks 1415 sampled merge cycles and
  109531 total sampled scalar-plus-merge cycles, and links that path to the
  24-color tensor schedule. The `e1x-tensor-output-checksum` gate now recomputes
  the post-requantized sampled output rows for all 283 proof layers and records
  sampled output checksum 14414877542268347137 while also checking that the
  normal/high execution trace sidecars carry positive, route-colored scenario
  checksums. The `e1x-full-output-coverage` gate now quantifies that this is
  still 1132 sampled rows out of 2608640 scheduled output rows and 26180 sampled
  MACs out of 13015864320 full graph MACs, preserving the full-output blocker
  as measured evidence. The `e1x-execution-coverage-ladder` gate keeps that real
  sampled-output lane separate from the deterministic vector-window fabric lane,
  which now covers all 2608640 scheduled rows and 70620160 lane MACs, more than
  a 2300x row gain over the real sampled output lane while leaving no scheduled
  row outside the deterministic window. This still preserves the real-weight
  full-output blocker because the window uses deterministic W4A8 test weights
  rather than the full quantized model tensor payload. The
  deterministic window. The `e1x-full-output-workplan` gate now hashes a compact
  full-output workplan covering all 2608640 rows, 13015864320 MACs,
  1627345920 packed vector-word operations, 4187241 scheduled core waves, 5481
  K waves, and all 24 routing colors; it still does not execute those rows. The
  `e1x-vector-kernel-template` gate now emits a concrete 54-word RV64IM unrolled
  W4A8 template for one packed int4 vector word and scales that to
  87876679680 template instruction instances over the full-output workplan; the
  `e1x-looped-vector-kernel-skeleton` gate adds an 11-word RV64IM branch/control
  skeleton for row/vector iteration, scaling to 6517209600 loop-control
  instructions and 94393889280 combined template-plus-loop instruction
  instances. The `e1x-per-layer-vector-codegen` gate combines that template and
  loop skeleton with all 283 workplan layers, preserving the same
  94393889280 estimated generated instructions. The
  `e1x-sampled-vector-kernel-executor` gate now executes the sampled proof rows
  as 3556 packed int4 vector-word operations across all 283 proof layers and
  verifies 26180 lane MACs against the proof accumulators/requantized outputs;
  the `e1x-vector-kernel-window-executor` gate expands deterministic packed
  vector execution to 2608640 rows and 9190400 vector-word operations across the
  same 283 layers. The `e1x-vector-window-fabric-checksum` gate now routes that
  expanded window across all 24 routing colors, merges 283 layer groups with
  RTL-reduction-equivalent saturation semantics, and records routed checksum
  4718384912712357942. The `e1x-window-shard-linkage` gate maps those executed
  rows onto all 151367 real loaded local-SRAM shard records and all 1627034880
  loader words, proving the deterministic window spans the resident load stream without
  claiming the full weight tensors were executed. The
  `e1x-window-repair-linkage` gate maps the same 151367 touched logical cores
  through normal/high repair manifests: 279 window cores remap under normal defects
  and 3012 remap under high failure, with all touched cores landing on usable
  physical targets. The `e1x-window-route-validation` gate then recomputes 301949
  repaired physical neighbor routes inside that touched-core set; high-failure
  routes accumulate 1809664 extra hops versus 167619 for normal defects while avoiding
  blocked cores and links. The `e1x-window-repair-rom-linkage` gate verifies the
  generated repair ROM payloads contain the remap words needed by that window:
  279 under normal defects and 3012 under high failure, tied to RTL repair-ROM cocotb
  and boot repair firmware evidence. The `e1x-window-execution-trace-linkage`
  gate ties that repair evidence to the normal/high real-graph execution traces:
  high failure runs 63132355414 cycles versus 47501642583 normal cycles, with a
  larger repair hop penalty and distinct output checksum. The missing piece is
  executing all generated rows with real model weights through the vectorized
  tensor fabric and producing a full-output checksum. The
  bounded `e1x-reduction-merge-cocotb` gate verifies a single-group RTL
  reduction primitive for signed partial sums, backpressure, mismatch
  accounting, and saturation. The `e1x-fabric-reduction` gate now independently
  recomputes 2608640 scheduled reduction wavelets, 270586961 total fabric
  wavelets, all 24 routing-color aggregates, and the per-color fabric timing
  links against mesh delivery plus bounded reduction-merge evidence. The
  vectorized full tensor fabric executor, full-wafer reduction scheduler, and
  full-output numerical proof remain open.
- Formal, full-wafer RTL, PD, package thermal signoff, calibrated power
  extraction, and measured silicon power evidence. The `e1x-power-thermal` gate
  is planning-grade arithmetic only.
- Measured benchmark evidence against E1 on FPGA, board, or silicon.
