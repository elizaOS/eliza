# NPU v0 microarchitecture

## Selection

The e1 chip v0 NPU is a wrapped **Gemmini** generator instance from the
default Chipyard configuration (`GemminiCustomConfigs.defaultConfig`):
`16x16` systolic array of `INT8` MACs with an output stage that supports
`INT8`/`INT32` accumulation and ReLU. Gemmini is selected because it is the
only open-source accelerator that already ships with a Rocket/BOOM-integrated
driver, a documented descriptor (RoCC + virtual address) interface, and an
existing Chipyard build flow that matches the rest of the e1 chip CPU
selection in `docs/rtl/cpu-config-selection.md`.

The Gemmini instance is presented to the rest of the SoC through an
**MMIO-fronted command-queue wrapper** (`rtl/npu/e1_npu_gemmini_wrapper.sv`,
to be added) rather than through the RoCC tightly-coupled port, so that
software can program the accelerator from any master on the AXI-Lite contract
fabric and the CPU choice can be re-evaluated independently.

The legacy `rtl/npu/e1_npu.sv` MMIO datapath remains as a fallback target
for the small-op contract path (`ADD`/`MUL`/`MAC`/`DOT4`/`MAX`/`MIN` and the
bounded `GEMM_S8` scratchpad) and is selected when the Gemmini wrapper
reports `caps.gemmini_present == 0` at boot.

## Address map

The NPU target window lives at `0x1002_0000` (4 KiB) on the Linux-capable
contract fabric (see `docs/arch/interconnect.md`).

| Offset | Name | Access | Description |
| ---: | --- | --- | --- |
| `0x000` | `ID` | RO | `0x4E50_5530` (`"NPU0"`) |
| `0x004` | `CAPS` | RO | bit 0 `gemmini_present`, bit 1 `int8`, bit 2 `int32_accum`, bit 3 `relu`, bits `[15:8]` array rows, `[23:16]` array cols |
| `0x008` | `CTRL` | RW | bit 0 `enable`, bit 1 `flush`, bit 2 `irq_enable`, bit 3 `cpu_fallback_select` |
| `0x00C` | `STATUS` | RO | bit 0 `busy`, bit 1 `queue_full`, bit 2 `queue_empty`, bit 3 `done`, bit 4 `error`, bits `[15:8]` `q_level`, bits `[23:16]` `err_code` |
| `0x010` | `IRQ_STATUS` | RW1C | bit 0 `done`, bit 1 `error`, bit 2 `unsupported_op`, bit 3 `bus_error`, bit 4 `queue_overflow` |
| `0x014` | `IRQ_MASK` | RW | mirrors `IRQ_STATUS` bits |
| `0x018` | `DESC_BASE_LO` | RW | descriptor ring base, low 32 bits |
| `0x01C` | `DESC_BASE_HI` | RW | descriptor ring base, high 32 bits (zero on 32-bit SoC) |
| `0x020` | `DESC_RING_LEN` | RW | ring length in descriptors (power of two, `<= 256`) |
| `0x024` | `DESC_HEAD` | RW | software-write producer index |
| `0x028` | `DESC_TAIL` | RO | hardware-write consumer index |
| `0x02C` | `DESC_DOORBELL` | WO | write to commit new descriptors (value = new head) |
| `0x030` | `TENSOR_MEM_BASE_LO` | RW | tensor scratch base, low 32 bits |
| `0x034` | `TENSOR_MEM_BASE_HI` | RW | tensor scratch base, high 32 bits |
| `0x038` | `TENSOR_MEM_LEN` | RW | tensor scratch size in bytes |
| `0x040` | `PERF_CYCLES` | RO | cycles spent with `busy == 1` |
| `0x044` | `PERF_MACS_LO` | RO | retired MAC count, low 32 bits |
| `0x048` | `PERF_MACS_HI` | RO | retired MAC count, high 32 bits |
| `0x04C` | `PERF_FALLBACKS` | RO | descriptors that returned `unsupported_op` |
| `0x050` | `ERR_DESC_INDEX` | RO | index of descriptor that latched `error` |
| `0x054` | `ERR_FAULT_ADDR_LO` | RO | bus address of last `bus_error` |
| `0x058` | `ERR_FAULT_ADDR_HI` | RO | high 32 bits |

The 4 KiB window leaves `0x080`-`0xFFF` reserved for future per-engine
debug counters.

## Descriptor queue format

Descriptors are software-owned cache-line-aligned records in system memory at
`DESC_BASE`. Each descriptor is **64 bytes** (16 words, little-endian):

| Word | Field | Description |
| ---: | --- | --- |
| 0 | `OP` | opcode (see v0 op set) |
| 0 (hi 16) | `FLAGS` | bit 0 `irq_on_complete`, bit 1 `signed_input`, bit 2 `relu_fuse`, bit 3 `barrier` |
| 1 | `SHAPE_M` | M dimension (rows of A / output rows) |
| 2 | `SHAPE_N` | N dimension (cols of B / output cols) |
| 3 | `SHAPE_K` | K dimension (contraction) or conv kernel size |
| 4 | `A_ADDR_LO` | input A base |
| 5 | `A_ADDR_HI` | high 32 bits |
| 6 | `B_ADDR_LO` | input B / weights base |
| 7 | `B_ADDR_HI` | |
| 8 | `C_ADDR_LO` | output base |
| 9 | `C_ADDR_HI` | |
| 10 | `A_STRIDE` | leading-dim stride in bytes |
| 11 | `B_STRIDE` | |
| 12 | `C_STRIDE` | |
| 13 | `CONV_PARAMS` | `stride_h[3:0]`, `stride_w[7:4]`, `pad_h[11:8]`, `pad_w[15:12]`, `dilation[19:16]` |
| 14 | `POOL_PARAMS` | `window_h[3:0]`, `window_w[7:4]`, `stride[11:8]` |
| 15 | `COMPLETION_TAG` | opaque 32-bit value returned in `STATUS.err_code`/`IRQ_STATUS` payload register `0x05C` when the descriptor retires |

Hardware advances `DESC_TAIL` past each retired descriptor and asserts
`IRQ_STATUS.done` if `FLAGS.irq_on_complete == 1` and `IRQ_MASK.done == 1`.

Producer/consumer protocol:

1. Software writes a contiguous run of descriptors starting at `DESC_HEAD`.
2. Software memory-fences then writes the new head index to `DESC_DOORBELL`.
3. Hardware reads descriptors in order, validates them against `CAPS`, and
   dispatches each one to either the Gemmini core or the CPU-fallback path
   (see below).
4. On retirement, `DESC_TAIL` advances. Out-of-order completion is not
   supported in v0; in-flight descriptors retire in submission order.

## Tensor memory ABI

Tensor buffers live in DRAM and are referenced by physical (or
contract-fabric) addresses. v0 imposes:

- **Alignment**: A/B/C base addresses must be 16-byte aligned. Strides must
  be multiples of 16 bytes.
- **Layout**: row-major. Convolutions use `NHWC`. Pooling operates on
  `NHWC` with `N == 1` in v0.
- **Data types**: `INT8` activations and weights, `INT32` accumulator,
  `INT8` output after optional ReLU and per-tensor scale (programmed via
  reserved field in v1, hard-wired to `1.0` in v0).
- **Scratch window**: `TENSOR_MEM_BASE`..`+TENSOR_MEM_LEN` declares a
  pinned region that hardware is allowed to use for tile staging. Outside
  this window, accesses are blocked at the wrapper and surface as
  `bus_error`.

## v0 op set

| `OP` | Mnemonic | Description | Backed by |
| ---: | --- | --- | --- |
| `0x00` | `NOP` | retires immediately, useful as a barrier | wrapper |
| `0x10` | `MATMUL_S8` | `C = A * B`, INT8 in / INT32 out | Gemmini |
| `0x11` | `MATMUL_S8_RELU` | `C = relu(A * B)` | Gemmini |
| `0x20` | `CONV2D_S8` | NHWC INT8 convolution | Gemmini im2col + array |
| `0x21` | `CONV2D_S8_RELU` | fused ReLU | Gemmini |
| `0x30` | `RELU` | elementwise INT8 ReLU | Gemmini transpose-write path |
| `0x40` | `MAXPOOL_S8` | NHWC max pool, window 2x2 or 3x3, stride 1 or 2 | Gemmini pooling unit |
| `0xFE` | `BARRIER` | drains in-flight ops before retiring | wrapper |
| `0xFF` | `FALLBACK` | force CPU-fallback (test hook) | CPU |

Any other opcode, or a supported opcode with shape/stride/flag combinations
outside the validated set, latches `STATUS.error`, sets `err_code` to the
table below, and asserts `IRQ_STATUS.unsupported_op`.

| `err_code` | Meaning |
| ---: | --- |
| `0x01` | unknown opcode |
| `0x02` | shape out of range |
| `0x03` | unsupported flag combination |
| `0x04` | misaligned base or stride |
| `0x05` | tensor outside `TENSOR_MEM` window |
| `0x06` | bus response error (also sets `bus_error`) |
| `0x07` | queue overflow (also sets `queue_overflow`) |

## Interrupt and error registers

`irq_npu` is the level output to the PLIC; it is the OR of
`IRQ_STATUS & IRQ_MASK`. Software clears interrupts by writing 1 to the
corresponding `IRQ_STATUS` bit.

Errors are sticky in `STATUS.error` until either (a) software writes
`CTRL.flush == 1`, which drops the descriptor ring back to empty and resets
`STATUS`/`ERR_*`, or (b) software writes 1 to `IRQ_STATUS.error`. `flush`
is required to recover from `bus_error` and `queue_overflow`; clearing
`IRQ_STATUS` alone is enough to dismiss `unsupported_op`.

## CPU fallback contract

When a descriptor cannot be executed on the Gemmini engine (unsupported
opcode, oversized shape, missing flag, or `OP == FALLBACK`), the wrapper:

1. Does **not** consume the descriptor on Gemmini.
2. Sets `STATUS.error` and `IRQ_STATUS.unsupported_op` with the descriptor
   index in `ERR_DESC_INDEX`.
3. Increments `PERF_FALLBACKS`.
4. If `CTRL.cpu_fallback_select == 1`, the wrapper also asserts a
   secondary `irq_fallback` line to the CPU. The kernel driver is
   expected to:
   a. Read the descriptor at `ERR_DESC_INDEX`.
   b. Execute the operation in software (kernel module / userspace
      delegate).
   c. Clear `IRQ_STATUS.unsupported_op` and `STATUS.error`.
   d. Advance `DESC_TAIL` by writing it back (writeable when
      `CTRL.cpu_fallback_select == 1`; ignored otherwise).
5. If `CTRL.cpu_fallback_select == 0`, the descriptor is treated as a
   hard failure: the ring stalls until software issues `CTRL.flush`.

The contract guarantees that **no descriptor is silently dropped**. Either
Gemmini retires it, or the CPU retires it and writes back the tag, or the
ring stalls visibly via `STATUS.busy == 0 && q_level > 0 && error == 1`.

## v0 validated envelope

| Parameter | v0 limit |
| ---: | --- |
| Matmul `M`, `N` | `<= 1024` |
| Matmul `K` | `<= 1024` |
| Conv2D `H`, `W` | `<= 256` |
| Conv2D `C_in`, `C_out` | `<= 512` |
| Conv2D kernel | `1x1`, `3x3`, `5x5` |
| Conv2D stride | `1` or `2` |
| Pool window | `2x2` or `3x3` |
| Descriptor ring length | `<= 256`, power of two |

Anything outside this envelope must surface as `unsupported_op` and follow
the CPU fallback contract.
