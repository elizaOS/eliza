# Eliza-AI-SoC e1 pipeline

This repository is the CLI-first pre-tapeout scaffold for an open RISC-V AI phone SoC. The first executable milestone is a tiny `e1_soc` chip that exercises the full project pipeline:

- architecture contracts
- synthesizable RTL
- cocotb verification
- formal checks
- Verilator simulation
- QEMU/Renode software-facing reference targets
- Yosys synthesis
- OpenLane/OpenROAD physical-design entry points
- documentation and tapeout checklist

The e1 chip is not the phone SoC. It is the smallest end-to-end proving ground for the tools and conventions.

## Quick start

```sh
make tools
make smoke
```

Most EDA tools are expected to run from Docker or Nix on a fresh machine:

```sh
docker build -t eliza-soc-tools .
docker run --rm -it -v "$PWD:/work" -w /work eliza-soc-tools make smoke
```

If Nix is available:

```sh
nix develop
make smoke
```

## Important targets

```text
make tools          show local tool availability
make rtl-check      syntax/elaboration checks where tools exist
make cocotb         run cocotb RTL tests
make verilator      build and run Verilator harness
make formal         run SymbiYosys formal checks
make synth          synthesize e1 chip with Yosys
make openlane       run OpenLane block flow when available
make openroad       run OpenROAD Tcl entry point when available
make qemu           launch the QEMU RISC-V software reference firmware
make renode         launch the Renode platform stub when available
make mvp-status     report every MVP subsystem as PASS, BLOCK, or FAIL
make docs-check     validate architecture/doc skeleton
make smoke          run the locally available low-cost checks
```

## Milestone discipline

The project should only grow the full phone SoC after this e1 pipeline is boring:

1. RTL tests pass.
2. Formal checks pass.
3. Synthesis reports exist.
4. A physical-design run produces reports or a documented blocker.
5. Software-facing contracts are represented in docs and test fixtures.
