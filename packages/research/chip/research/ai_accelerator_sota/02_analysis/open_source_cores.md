# Open-Source Accelerator Implementations

Date: 2026-05-19

This list prioritizes projects with RTL, simulation, software, or generator
value for E1. It is not an endorsement that any project can be imported without
license and integration review.

## Highest-Value References

### Gemmini

- URL: `https://alonamid.github.io/publication/gemmini/`
- Public repo family: `https://github.com/ucb-bar/gemmini`
- Architecture: RISC-V RoCC systolic-array generator integrated with
  Rocket/BOOM/Rocket Chip.
- Relevance to E1:
  - parameterized array/tile/scratchpad generator,
  - software-visible custom instructions,
  - quantized inference support,
  - proven research tapeout path in older nodes.
- Implementation action:
  - study Gemmini's parameter surface and software ABI before growing E1's
    hard-coded NPU;
  - do not copy RTL blindly; build an E1-native generator contract.

### NVDLA

- URL: `https://nvdla.org/`
- Public repo family: `https://github.com/nvdla`
- Architecture: configurable inference accelerator with Verilog, C-model,
  compiler, Linux driver, and tests.
- Relevance to E1:
  - end-to-end accelerator evidence structure,
  - Linux driver and userspace stack,
  - convolution/inference pipeline reference.
- Implementation action:
  - mine NVDLA's evidence shape, register interface discipline, and software
    packaging;
  - use as a reference for driver/runtime completeness, not necessarily for
    transformer-era datapath choices.

### Vortex

- URL: `https://github.com/vortexgpgpu/vortex`
- Architecture: full-stack open-source RISC-V GPGPU with simulator, RTL
  simulator, FPGA backends, OpenCL/OpenGL-oriented software.
- Relevance to E1:
  - open GPU software stack lessons,
  - SIMT scheduling and memory coalescing ideas,
  - FPGA validation flow.
- Implementation action:
  - evaluate as a GPU-side companion reference only after NPU tensor path has a
    stable ABI;
  - use for lessons on compiler/runtime/device-driver split.

### OpenGeMM

- URL: `https://arxiv.org/abs/2411.09543`
- Architecture: GEMM accelerator generator with lightweight RISC-V control and
  tight memory coupling.
- Relevance to E1:
  - high-utilization GEMM generator target,
  - reported system-level TOPS/W reference point,
  - useful comparison against Gemmini-style tiled systolic design.
- Implementation action:
  - add to design-space model as a competing tile/memory organization.

### OpenCelerity

- URL: `https://opencelerity.org/`
- Architecture: open RISC-V tiered accelerator fabric SoC.
- Relevance to E1:
  - multi-accelerator fabric and NoC orientation,
  - full SoC integration lessons.
- Implementation action:
  - inspect fabric partitioning when E1 grows beyond one NPU block.

### ESP

- URL: `https://www.esp.cs.columbia.edu/`
- Architecture: open SoC platform with RTL/HLS/ML accelerator flows and Vortex
  integration.
- Relevance to E1:
  - accelerator-generator infrastructure,
  - Linux/software integration,
  - SoC composition.
- Implementation action:
  - use as a reference for repeatable accelerator integration flows.

## Smaller / Educational TPU-Like Projects

Tiny TPU, TinyTinyTPU, and similar FPGA projects are useful for pedagogical
systolic-array smoke tests but are not production-grade SOTA baselines. They can
still inform minimal cocotb tests, waveform checks, and small tile examples.

## Research Cores To Track

- VUSA-style sparse systolic arrays: unstructured sparsity only helps if
  metadata decode and utilization are solved.
- Low-bit integerized ViT systolic designs: useful for INT4/INT2 transformer
  inference.
- EdgeBERT, SpAtten, Energon, A3, and related transformer accelerators:
  relevant for early exit, attention pruning, sparse attention, and dynamic
  workloads.
- XiangShan / RVV-class open CPU work: relevant if E1 needs stronger vector
  fallback before a production NPU compiler exists.

## Import Rules For E1

1. Record license before copying any code.
2. Prefer architectural patterns and tests over direct RTL import.
3. Any imported block needs a local spec, register contract, simulation model,
   Linux interface, and evidence gate.
4. Avoid parallel accelerator command mechanisms. E1 should route through the
   existing descriptor/runtime architecture as it matures.
