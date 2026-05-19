# NPU command ABI

The e1 NPU is a small synthesizable datapath behind a single-cycle MMIO
control interface. Software programs operands, selects an opcode, starts the
command, then polls `CTRL_STATUS.done` or waits for `irq_npu`.

This block is not a phone-class accelerator. It has only a local RTL descriptor
ring and DRAM-to-scratchpad read path, with no IOMMU, cache coherency, tensor
compiler backend, Android NNAPI delegate, production SRAM, or sustained
TOPS/power evidence. It may be cited only as L0 RTL/unit evidence unless a
higher-level report supplies the proof artifacts listed in
`docs/benchmarks/capabilities/README.md`.

```text
write OP_A
write OP_B
write ACC              ; optional, used by MAC/DOT4
write OPCODE
write CTRL_STATUS.start
poll or wait for irq_npu
read RESULT
```

`OPCODE` is read/write; readback returns the programmed low 4 bits. `RESULT_HI`
contains the high word for `MUL_LO` and sign-extension for signed 32-bit
`MAC_S16`/`DOT4_S8`/`DOT8_S4` results.
`MAC_S16`/`DOT4_S8` results.

Implemented opcodes:

| Opcode | Name | Result |
| ---: | --- | --- |
| `0` | `ADD` | `OP_A + OP_B` |
| `1` | `SUB` | `OP_A - OP_B` |
| `2` | `MUL_LO` | low 32 bits of unsigned `OP_A * OP_B`; high word in `RESULT_HI` |
| `3` | `MAC_S16` | signed low-16 multiply plus signed `ACC` |
| `4` | `DOT4_S8` | four packed signed INT8 products plus signed `ACC` |
| `5` | `MAX_U32` | unsigned max |
| `6` | `MIN_U32` | unsigned min |
| `7` | `DOT8_S4` | eight packed signed INT4 products plus signed `ACC` |
| `8` | `GEMM_S8` | bounded scratchpad INT8 GEMM tile, signed int32 output |

Status bits:

| Bit | Name | Meaning |
| ---: | --- | --- |
| `0` | `busy` | Command is executing |
| `1` | `done` | Command completed; also drives `irq_npu` |
| `2` | `error` | Unsupported opcode was rejected |

Write `CTRL_STATUS[1]` to clear `done` and `error`. Operands are latched when
`start` is accepted; software should not rely on mid-command register writes
affecting the in-flight operation.

## Scratchpad GEMM prototype

`GEMM_S8` is a concrete tile prototype, not a tensor subsystem. Software stages
row-major signed INT8 `A` and `B` matrices into a 64-byte MMIO scratchpad and
programs a bounded command. The datapath performs one signed INT8 multiply
accumulate per cycle and writes row-major signed int32 `C` results back into the
scratchpad. The current RTL bounds are `M <= 3`, `N <= 3`, `K <= 7`, further
limited by the 64-byte scratchpad footprint.

Additional registers:

| Offset | Name | Fields |
| ---: | --- | --- |
| `0x20` | `GEMM_CFG` | `M[1:0]`, `N[9:8]`, `K[18:16]` |
| `0x24` | `GEMM_BASE` | byte bases: `A[5:0]`, `B[13:8]`, `C[21:16]` |
| `0x28` | `GEMM_STRIDE` | byte strides: `A[3:0]`, `B[11:8]`, `C[19:16]` |
| `0x2c` | `PERF_UNSUPPORTED_OPS` | unsupported opcode/configuration counter |
| `0x30` | `CMD_PARAM` | bit 0 selects descriptor-submission mode |
| `0x40` | `DESC_BASE` | descriptor ring base; must be 32-bit aligned |
| `0x44` | `DESC_HEAD` | software producer index, 3 bits |
| `0x48` | `DESC_TAIL` | hardware/software consumer index, 3 bits |
| `0x4c` | `DESC_STATUS` | descriptor status bits plus error index in bits `[11:9]` |
| `0x50` | `PERF_CYCLES` | cycles spent in active state |
| `0x54` | `PERF_MACS` | signed INT8 MAC operations issued |
| `0x58` | `PERF_OPS` | accepted operation counter |
| `0x5c` | `PERF_ERRORS` | rejected commands/configurations; write bit 0 to clear all perf counters |
| `0x60` | `DESC_TIMEOUT_COUNT` | cycles spent in the active descriptor engine |
| `0x64` | `DESC_BYTES_READ` | descriptor plus tensor-stream bytes accepted by the NPU read path |
| `0x68` | `DESC_BYTES_WRITTEN` | descriptor writeback bytes accepted by the NPU write path; always zero until writeback exists |
| `0x6c` | `DESC_READ_BEATS` | descriptor plus tensor-stream read beats accepted |
| `0x70` | `DESC_WRITE_BEATS` | descriptor writeback beats accepted; always zero until writeback exists |
| `0x80`-`0xbc` | `SCRATCH[0..15]` | 16 little-endian 32-bit scratchpad words |

For row-major `A[M][K]`, `B[K][N]`, and `C[M][N]`, use `A_STRIDE = K`,
`B_STRIDE = N`, and `C_STRIDE = 4*N`. `C_BASE` must be word-aligned. Invalid
dimensions or scratchpad addresses complete with `CTRL_STATUS.done|error` set
and increment `PERF_ERRORS`.

The full v0.1 NPU ABI should extend this pattern:

```text
MMIO control registers
command queue
DMA descriptors
scratchpad allocation
INT8/INT4 GEMM commands
completion interrupt
performance counters
```

Current integration is still a prototype datapath model. When `CMD_PARAM[0]` is
set and software writes `CTRL_STATUS.start`, the RTL validates base alignment
and empty/non-empty queue state, then fetches four 32-bit descriptor words from
the read-only `m_axil_ar/r` descriptor port for each visible queue entry.
Descriptor word 0 carries `opcode[3:0]`, `stream_to_scratch[8]`,
`scratch_offset[21:16]`, `byte_count[29:24]`, `writeback_request[30]`, and
`valid_owner[31]`. Software must set `valid_owner` before advancing `DESC_HEAD`;
the current RTL rejects descriptors without this bit and leaves `DESC_TAIL`
unchanged. Word 1 is the stream source byte address when streaming is enabled,
or scalar `OP_A` otherwise. Words 2 and 3 are scalar `OP_B` and `ACC`, or
reserved for streamed GEMM. The stream path is aligned 32-bit reads only and
writes into the 64-byte scratchpad before launching the selected existing opcode.

`DESC_STATUS[0]` reports empty, `[1]` reports descriptor completion, `[2]`
reports descriptor error, `[3]` reports autonomous timeout, `[4]` reports
descriptor fetch read error, `[5]` reports tensor stream read/configuration
error, `[6]` reports a descriptor missing the valid owner bit, `[7]` reports an
unsupported writeback request, `[8]` reports descriptor engine busy, and
`[11:9]` reports the descriptor index that faulted or completed. The three
visible head/tail bits do not encode a full-ring condition. A missing descriptor
or stream read response times out with `CTRL_STATUS.done|error`; read-response
errors fail closed. The standalone DMA block tracks aligned 32-bit beat issue,
byte completion, last source/destination addresses, and final write strobe, but
NPU descriptor streaming uses the NPU read master and still has no writeback DMA
path. Descriptors with `writeback_request` set are rejected before launch, and
`DESC_BYTES_WRITTEN`/`DESC_WRITE_BEATS` remain zero.

## Evidence gates

Before any `e1-npu` benchmark is treated as accelerator evidence, the report
must include:

- exact model SHA-256 and Android/Linux target identity,
- NNAPI accelerator query showing `e1-npu`,
- total/delegated NNAPI node count, zero CPU fallback, and zero unsupported ops,
- precision actually used by the delegate,
- dataflow name and description from the measured path,
- DMA path plus bytes read and written by the NPU workload; current local RTL
  reports descriptor read counts and zero write counts because writeback
  requests fail closed,
- descriptor queue depth, head/tail completion evidence, and timeout/error
  behavior for queued commands,
- MACs per inference, NPU cycles, NPU clock, DMA byte counters, operation/error
  counters, observed TOPS, and the TOPS formula,
- Android HAL service, SELinux fail-closed policy, VTS result, and CTS result
  when any Android accelerator claim is made,
- transcript hashes for adb, NNAPI query, benchmark output, and DMA trace.

TOPS is a derived review field, not proof by itself:

```text
observed_tops <= macs_per_inference * 2 / (npu_cycles / npu_hz) / 1e12
```

The current RTL cannot satisfy those gates because its measured GEMM output path
is still the 64-byte scratchpad and descriptor stream reads have no writeback
DMA, cache coherency, production queue ownership, or software-owned completion
queue.
