# E1X Wafer-Mesh Architecture Model

E1X is tracked as a separate chip direction from E1. E1 continues to be the
Ariane/CVA6-derived RISC-V phone SoC path. E1X is the Cerebras-inspired path:
many tiny RISC-V processing elements, local SRAM at each element, a uniform
mesh fabric, and post-test routing repair around defective cores or links.

The checked model lives in `compiler/runtime/e1x_wafer_model.py` and emits
`benchmarks/results/e1x-wafer-mesh-model.json` through:

```sh
python3 scripts/generate_e1x_wafer_mesh_evidence.py
```

Run the benchmark harness gate, including report schema validation and the E1
comparison checks, with:

```sh
python3 scripts/check_e1x_benchmark.py
```

The first RTL-facing contract lives under `rtl/e1x/`:

- `e1x_pkg.sv`: constants shared by the model and RTL contract.
- `e1x_mesh_router.sv`: color-indexed route table, port-disable repair inputs,
  repaired-drop visibility, color propagation, and one-hop wavelet forwarding.
- `e1x_tiny_core_contract.sv`: minimal tiny-core placeholder with 48 KiB local
  SRAM contract, wavelet ingress/egress, and a checked RV64I integer subset
  covering ADDI, ADD, SUB, LUI, and ECALL halt.
- `e1x_tile.sv`: binds the tiny-core contract and mesh router into one
  processing element, including an exposed instruction stream for integrated
  tile-level simulation.

Run the consistency gate with:

```sh
python3 scripts/check_e1x_rtl_contract.py
```

Run the tiny-core execution simulation with:

```sh
python3 scripts/check_e1x_core_cocotb.py
```

Run the integrated tile simulation with:

```sh
python3 scripts/check_e1x_tile_cocotb.py
```

That gate proves the tile wrapper can execute the core instruction stream,
route a fabric wavelet into the local core, and return the core response back
onto the mesh fabric.

Run the router repair/defect simulation with:

```sh
python3 scripts/check_e1x_fabric_cocotb.py
```

That gate currently runs both a single-router suite and a 2x2 mesh suite. The
2x2 suite proves a diagonal two-hop route, a repaired south-then-east route when
the direct east output is disabled, and an unrepaired disabled-link drop report.

The model is intentionally scoped as architecture simulation. It does not claim
RTL completion, PDK signoff, DFT coverage, wafer sort, package feasibility, or
silicon benchmark evidence.

## Current E1X Contract

- ISA target: tiny `rv64imafdc_zicsr_zifencei`-class RISC-V core array.
- Logical mesh: 32 x 32 active processing elements in the default model.
- Spare fabric: two spare rows and two spare columns for deterministic repair
  experiments.
- Per-core memory: 48 KiB local SRAM, matching the public Cerebras-style design
  point captured in `/home/shaw/Downloads/cerebras.md`.
- Fabric: 32-bit wavelet-style payloads, 24 routing colors, and neighboring
  mesh links modeled as bidirectional per-cycle transfer paths.
- Defect flow: deterministic blocked-core and blocked-link maps, greedy
  logical-to-physical replacement, and BFS route validation for every logical
  nearest-neighbor edge.
- Comparison: the report keeps E1 and E1X separate by comparing E1X against the
  existing `open_2028_sota_160tops` E1 NPU architecture model.

## Completion Gates Still Missing

- Complete RV64IMAFDC/Zicsr/Zifencei-compatible core RTL for the E1X processing
  element. The current core is a deliberately small RV64I contract subset.
- Mesh router RTL with production color queues and route table programming
  protocol. The current router verifies combinational color routing, link
  disable, and repaired-drop behavior.
- SRAM BIST/ECC/parity policy and scan/DFT insertion strategy.
- Wafer-sort defect-map ingestion format and repair fuse/ROM handoff.
- Compiler/runtime mapping from kernels to logical mesh coordinates.
- Formal, full-wafer RTL, PD, package, thermal, and power evidence.
- Measured benchmark evidence against the E1 Ariane/CVA6 path.
