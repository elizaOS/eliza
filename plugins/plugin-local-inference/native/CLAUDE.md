# @elizaos/inference

Private native-kernel workspace for the local-inference stack: Metal, Vulkan, CUDA, and scalar reference implementations plus hardware verification.

## Role

This directory owns reusable kernel sources and the verification harness used to prove elizaOS/llama.cpp integrations. It is not a second TypeScript inference runtime. Production model loading and FFI dispatch live in the parent `@elizaos/plugin-local-inference`; build orchestration and target packaging live in app-core scripts and the managed llama.cpp fork.

`verify/kernel-contract.json` is the authoritative, machine-checked statement of kernel names, required runtime capability keys, fixtures, backend status, hardware evidence, and graph-smoke gates. Do not infer readiness from the presence of a shader, a successful compiler invocation, or prose reports.

The current Gemma text path uses TurboQuant Q4 weights, stock Q8_0/F16 KV, Gemma-compatible flash attention, and MTP. QJL, PolarQuant, Turbo3, and Turbo3-TCQ remain valid for their declared legacy/non-Gemma or shared-ABI scopes; their fixture results do not prove the shipping Gemma decode graph.

## Layout

```
package.json                 private package scripts
metal/                       Metal kernels
vulkan/                      Vulkan compute shaders
cuda/                        CUDA kernels
reference/                   scalar C reference implementations
include/                     shared native headers
verify/
  kernel-contract.json       canonical capability and evidence contract
  check_kernel_contract.mjs  structural contract validator
  Makefile                   reference, backend, benchmark, and graph gates
  gen_fixture.c              deterministic fixture generator
  *_verify.*                 backend correctness harnesses
  *_runner.*                 hardware-specific evidence runners
  *dispatch_smoke*           built-fork graph dispatch tests
  fixtures/                  generated/reference fixtures
  *.json                     checked hardware evidence records
configs/                     native build configuration
llama.cpp/                   pinned fork submodule used by local builds
patches/                     narrowly scoped native patches
audio-fixtures/              reviewed voice fixtures
voice-bench/                 standalone voice benchmark workspace
kokoro_training/             vendored Kokoro training reference
eliza-generic-llama/         retained standalone build experiment; not a shipping backend
llama.cpp-omnivoice-merge/   example/reference patches, not the production build path
PRECACHE.md                  text-KV cache design notes
docs/                        focused native design notes
```

Generated binaries, SPIR-V, build directories, and machine-local captures are not source. Keep reproducible inputs and canonical evidence records; do not document a local binary as if it were a repository artifact.

## Kernel families

The contract currently tracks TurboQuant, QJL, PolarQuant, MTP, fused attention, and iSTFT surfaces. Each family has three separate states:

1. Source authored and compilable.
2. Fixture parity on a real backend.
3. Built-fork graph dispatch with recordable hardware evidence.

Only the third state can make a runtime capability ready when `kernel-contract.json` requires graph evidence. Software Vulkan, MoltenVK standing in for native Linux/Android Vulkan, or symbol-only inspection cannot satisfy a physical-backend gate.

Fused attention is an optimization over the required score/softmax/value-mix path. Keep it outside required manifest capabilities until the contract explicitly promotes it.

## Commands

Package scripts provide the portable entry points:

```bash
bun run --cwd plugins/plugin-local-inference/native verify:contract
bun run --cwd plugins/plugin-local-inference/native verify:reference
bun run --cwd plugins/plugin-local-inference/native verify:vulkan
bun run --cwd plugins/plugin-local-inference/native verify:metal
bun run --cwd plugins/plugin-local-inference/native clean
```

The Makefile exposes narrower and hardware-dependent gates:

```bash
make -C plugins/plugin-local-inference/native/verify kernel-contract
make -C plugins/plugin-local-inference/native/verify reference-test
make -C plugins/plugin-local-inference/native/verify cpu-dispatch-smoke
make -C plugins/plugin-local-inference/native/verify vulkan-verify
make -C plugins/plugin-local-inference/native/verify vulkan-dispatch-smoke
make -C plugins/plugin-local-inference/native/verify metal-verify
make -C plugins/plugin-local-inference/native/verify cuda-verify
make -C plugins/plugin-local-inference/native/verify android-vulkan-smoke
```

Backend targets require their real SDK, compiler, libraries, and hardware. Read the target recipe and `verify/HARDWARE_VERIFICATION.md` before running a hardware lane.

## Change rules

- Update scalar/reference math first, regenerate fixtures, then update backend implementations. All backends compare against the same reference contract.
- Preserve packed block layouts, endianness, alignment, tensor dimensions, and seed/sign-vector rules. A layout change requires coordinated converter, runtime, fixture, and manifest updates.
- Keep GPU kernels free of implicit subgroup-size assumptions unless the dispatch contract guarantees them.
- Distinguish shipped symbols from callable graph operations. Capability detection must prove the graph route, not only locate a symbol.
- Fail closed when hardware, a required fixture, a build artifact, or graph support is absent. Hardware runners must not record passes on the wrong operating system, software ICD, or unsupported accelerator.
- Record backend, device, driver/compiler, target, command, exit code, fixture results, and graph-smoke evidence in the schema required by `kernel-contract.json`.
- Do not reintroduce standalone production shims. The fused `libelizainference` surface is the production text/voice boundary.
- Do not extend `eliza-generic-llama/` or the example OmniVoice merge path as a shipping backend without first changing the parent runtime architecture and its tests.

## Backend-specific notes

### Metal

Metal fixture tests may JIT source for numerical verification, but the shipping gate must exercise the compiled library/metallib and the built-fork graph. Keep threadgroup reductions valid for the dispatched group size and preserve byte-accurate packed-block addressing.

### Vulkan

Compile shaders to validated SPIR-V and run both fixture parity and native graph dispatch. Native Linux and Android gates reject software devices by default. Informational fallback shaders do not replace the required hot-path gates.

### CUDA and ROCm

Use the hardware runners on supported Linux accelerators. Compiler preprocessing or PTX generation is useful diagnosis, not hardware proof. Record native architecture coverage and built-fork execution.

### CPU

Reference tests establish numerical truth; dispatch smoke proves the optimized fork path reaches the intended operation. Keep multithreaded results deterministic within the contract tolerance and compare them with the scalar reference.

## Verification

Start with `verify:contract` and `verify:reference`. Run every backend fixture and built-fork graph gate affected by the change on real target hardware, then inspect the generated evidence and numerical diffs. For model-path changes, also run the parent plugin's real inference or voice workflow.

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../CLAUDE.md). Hardware claims must be reproducible and manually reviewed; authored code, mocked dispatch, or a skipped fixture is not proof.
