# CPU subsystem contract

The repository now carries a minimal executable RISC-V CPU path at
`rtl/cpu/e1_tiny_cpu_contract.sv`. The legacy
`rtl/cpu/e1_cpu_subsystem_stub.sv` module is only a compatibility alias that
wraps this contract model. After reset it fetches 32-bit RISC-V instructions
from `RESET_PC` over the existing AXI-Lite manager port, executes a small
integer subset, and halts on `ECALL`, illegal instructions, or bus errors.

## Boundary

The CPU subsystem boundary is a single 32-bit AXI-Lite manager port:

```text
AW: awvalid, awready, awaddr[31:0]
W:  wvalid, wready, wdata[31:0], wstrb[3:0]
B:  bvalid, bready, bresp[1:0]
AR: arvalid, arready, araddr[31:0]
R:  rvalid, rready, rdata[31:0], rresp[1:0]
```

The CPU issues one aligned 32-bit AXI-Lite transaction at a time. Instruction fetches and `LW`/`SW` use the same manager port. It always accepts read/write responses, exports `reset_pc` and `hart_id`, reports `cpu_halted`, and reports combined interrupt pending state.

## Implemented stepping-stone ISA

This is a tiny RV execution path for e1-chip proof, not a Linux-capable application core.

| Area | Implemented now |
| --- | --- |
| Fetch | 32-bit instruction fetch from AXI-Lite `RESET_PC` |
| Integer registers | 32 architectural registers held as 64-bit values, `x0` hardwired to zero |
| Control flow | `JAL`, `JALR`, `BEQ`, `BNE` |
| Integer ops | `LUI`, `AUIPC`, `ADDI`, `ADD`, `SUB` |
| Memory ops | aligned 32-bit `LW`, `SW` |
| Halt | `ECALL`/`EBREAK`, illegal instruction, or AXI error response |
| Interrupts | level inputs are reflected through `irq_pending`; trap entry/CSR handling is not implemented |

The focused simulation wrapper `verify/cocotb/e1_tiny_cpu_contract_tb.sv` resets the CPU at `0x8000_0000`, preloads the DRAM model through a loader AXI-Lite path, then releases the CPU. The cocotb test `verify/cocotb/test_tiny_cpu_execution.py` proves fetch, execute, DRAM store, interrupt-controller MMIO write, halt, and external IRQ reflection.

## Linux-capable bring-up target

| Contract item | Target |
| --- | --- |
| Generator | Chipyard `main-2026-05-20` commit `48f904aefbb3903dce6efa7901982642853ae6a7` (previous: `1.13.0` / `69eba860a352343e4ac6b6df0f3638a79a86ec78`) |
| Config | `ElizaRocketConfig` |
| Core | Single Rocket application hart for first integration only |
| ISA | RV64GC application hart, plus platform-defined management hart if needed |
| Reset | `reset_pc` points at boot ROM or firmware entry |
| Interrupts | Timer, software, and external interrupt inputs compatible with OpenSBI/Linux expectations |
| Memory access | AXI/TileLink-class manager path, represented here by the 32-bit AXI-Lite scaffold |
| Coherency | Not modeled in the current scaffold |
| MMU/cache | Not modeled in the current scaffold |

This target is a Linux smoke and software bring-up milestone. A single Rocket
RV64GC hart, even when generated correctly, is not a 2028 phone-class
application processor claim. Phone-class AP work needs a separate selected CPU
topology, cache hierarchy, coherency plan, MMU/TLB validation, sustained
benchmark and power evidence, Android userspace evidence, and eventual silicon
evidence.

The Linux-capable CPU/AP requirements gate is
`docs/arch/linux-capable-cpu-contract.md`. The generator selection gate is
`generators/chipyard/eliza-rocket-manifest.json`, checked by
`make chipyard-generator-check`.

Remaining blockers to RV64GC/Linux are CSR/trap machinery, privilege modes, CLINT-compatible timer/software interrupts, PLIC compatibility, atomics, compressed/floating-point extensions, MMU/page-table walks, caches/coherency, wider/high-throughput memory fabric, and a real boot ROM/OpenSBI handoff.
