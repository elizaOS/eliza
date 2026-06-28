/*
 * eliza_npu_runtime.h - C ABI for the e1 NPU descriptor ring runtime.
 *
 * This ABI mirrors `submit_descriptors` and the descriptor word packing in
 * `compiler/runtime/e1_npu_runtime.py` and the MMIO contract in
 * `docs/spec-db/e1-npu-runtime-contract.json`. It is the linker boundary
 * between the IREE-emitted descriptor table and the kernel-side NPU driver.
 *
 * The runtime is intentionally split into two halves:
 *   - Pure encoder helpers (`eliza_npu_pack_descriptor_word0`) that can run
 *     on any host and produce the exact same descriptor word as the Python
 *     oracle. These are testable without hardware.
 *   - MMIO submission (`eliza_npu_submit_descriptors`) which requires either
 *     real hardware, Verilator simulation, or a memory-mapped fake. The
 *     real binding lives in the kernel driver; this header declares the ABI
 *     that the IREE-emitted module calls.
 *
 * Error model: every entry point returns one of the eliza_npu_status_t codes
 * below. There is no errno, no implicit logging, and no silent fallback.
 * The MLIR dialect verifiers already pre-check most invariants.
 */
#ifndef ELIZA_NPU_RUNTIME_H
#define ELIZA_NPU_RUNTIME_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* MMIO base + register offsets. These mirror, byte-for-byte, the constants on
 * `E1NpuRuntime` in compiler/runtime/e1_npu_runtime.py and the AXI-Lite word
 * decode in rtl/npu/e1_npu.sv (s_axil_*addr[7:2] = byte_offset >> 2). The C
 * ABI MUST be kept in lockstep with both. The parity test in
 * compiler/iree-eliza-npu/tests/test_runtime_mmio_parity.py enforces this. */
#define ELIZA_NPU_MMIO_BASE             0x10020000u
#define ELIZA_NPU_REG_OP_A              0x00u  /* byte 0x00 / word 0x00 */
#define ELIZA_NPU_REG_OP_B              0x04u  /* byte 0x04 / word 0x01 */
#define ELIZA_NPU_REG_RESULT            0x08u  /* byte 0x08 / word 0x02 */
#define ELIZA_NPU_REG_CTRL_STATUS       0x0Cu  /* byte 0x0C / word 0x03 */
#define ELIZA_NPU_REG_OPCODE            0x10u  /* byte 0x10 / word 0x04 */
#define ELIZA_NPU_REG_ACC               0x14u  /* byte 0x14 / word 0x05 */
#define ELIZA_NPU_REG_RESULT_HI         0x18u  /* byte 0x18 / word 0x06 */
#define ELIZA_NPU_REG_DEBUG             0x1Cu  /* byte 0x1C / word 0x07 */
#define ELIZA_NPU_REG_GEMM_CFG          0x20u  /* byte 0x20 / word 0x08 */
#define ELIZA_NPU_REG_GEMM_BASE         0x24u  /* byte 0x24 / word 0x09 */
#define ELIZA_NPU_REG_GEMM_STRIDE       0x28u  /* byte 0x28 / word 0x0A */
#define ELIZA_NPU_REG_PERF_UNSUP_OPS    0x2Cu  /* byte 0x2C / word 0x0B */
#define ELIZA_NPU_REG_CMD_PARAM         0x30u  /* byte 0x30 / word 0x0C */
#define ELIZA_NPU_REG_DESC_BASE         0x40u  /* byte 0x40 / word 0x10 */
#define ELIZA_NPU_REG_DESC_HEAD         0x44u  /* byte 0x44 / word 0x11 */
#define ELIZA_NPU_REG_DESC_TAIL         0x48u  /* byte 0x48 / word 0x12 */
#define ELIZA_NPU_REG_DESC_STATUS       0x4Cu  /* byte 0x4C / word 0x13 */
#define ELIZA_NPU_REG_PERF_CYCLES       0x50u  /* byte 0x50 / word 0x14 */
#define ELIZA_NPU_REG_PERF_MACS         0x54u  /* byte 0x54 / word 0x15 */
#define ELIZA_NPU_REG_PERF_OPS          0x58u  /* byte 0x58 / word 0x16 */
#define ELIZA_NPU_REG_PERF_ERRORS       0x5Cu  /* byte 0x5C / word 0x17 */
#define ELIZA_NPU_REG_DESC_TIMEOUT_CNT  0x60u  /* byte 0x60 / word 0x18 */
#define ELIZA_NPU_REG_DESC_BYTES_READ   0x64u  /* byte 0x64 / word 0x19 */
#define ELIZA_NPU_REG_DESC_BYTES_WRITTEN 0x68u /* byte 0x68 / word 0x1A */
#define ELIZA_NPU_REG_DESC_READ_BEATS   0x6Cu  /* byte 0x6C / word 0x1B */
#define ELIZA_NPU_REG_DESC_WRITE_BEATS  0x70u  /* byte 0x70 / word 0x1C */
#define ELIZA_NPU_REG_SCRATCH           0x80u  /* byte 0x80 / word 0x20 */

#define ELIZA_NPU_SCRATCH_BYTES         64
#define ELIZA_NPU_DESC_RING_ENTRIES     8

/* CTRL_STATUS bit layout (read/write semantics differ; matches rtl/npu/e1_npu.sv).
 * The Python oracle treats these as identical bit positions. */
#define ELIZA_NPU_CTRL_BUSY             (1u << 0)
#define ELIZA_NPU_CTRL_DONE             (1u << 1)
#define ELIZA_NPU_CTRL_ERROR            (1u << 2)
/* writes: bit 0 = launch, bit 1 = ack/clear done, bit 2 = ack/clear error */
#define ELIZA_NPU_CTRL_LAUNCH_WRITE     (1u << 0)
#define ELIZA_NPU_CTRL_CLEAR_WRITE      (1u << 1)

/* DESC_STATUS bit layout (matches Python DESC_STATUS_* and SV desc_status). */
#define ELIZA_NPU_DESC_STATUS_EMPTY                 (1u << 0)
#define ELIZA_NPU_DESC_STATUS_DONE                  (1u << 1)
#define ELIZA_NPU_DESC_STATUS_ERROR                 (1u << 2)
#define ELIZA_NPU_DESC_STATUS_TIMEOUT               (1u << 3)
#define ELIZA_NPU_DESC_STATUS_MEM_ERROR             (1u << 4)
#define ELIZA_NPU_DESC_STATUS_STREAM_ERROR          (1u << 5)
#define ELIZA_NPU_DESC_STATUS_OWNER_ERROR           (1u << 6)
#define ELIZA_NPU_DESC_STATUS_WRITEBACK_UNSUPPORTED (1u << 7)

/* Descriptor word 0 layout. */
#define ELIZA_NPU_DESC_FLAG_STREAM_TO_SCRATCH (1u << 8)
#define ELIZA_NPU_DESC_FLAG_WRITEBACK_REQUEST (1u << 30)
#define ELIZA_NPU_DESC_FLAG_VALID_OWNER       (1u << 31)

/* Hardware opcodes. Full 4-bit opcode space; mirrors OP_* on the Python oracle. */
#define ELIZA_NPU_OP_ADD            0u
#define ELIZA_NPU_OP_SUB            1u
#define ELIZA_NPU_OP_MUL_LO         2u
#define ELIZA_NPU_OP_MAC_S16        3u
#define ELIZA_NPU_OP_DOT4_S8        4u
#define ELIZA_NPU_OP_MAX_U32        5u
#define ELIZA_NPU_OP_MIN_U32        6u
#define ELIZA_NPU_OP_DOT8_S4        7u
#define ELIZA_NPU_OP_GEMM_S8        8u
#define ELIZA_NPU_OP_GEMM_S4        9u
#define ELIZA_NPU_OP_RELU4_S8       10u
#define ELIZA_NPU_OP_VRELU_S8       11u
#define ELIZA_NPU_OP_SDOT4_S4_2_4   12u
#define ELIZA_NPU_OP_DOT16_S2       13u
#define ELIZA_NPU_OP_DOT4_FP8_E4M3  14u
#define ELIZA_NPU_OP_EXP2_NEG_Q0_8  15u
#define ELIZA_NPU_OPCODE_MAX        15u

typedef enum {
  ELIZA_NPU_OK = 0,
  ELIZA_NPU_ERR_INVALID_OPCODE = 1,
  ELIZA_NPU_ERR_SCRATCH_BOUNDS = 2,
  ELIZA_NPU_ERR_ALIGNMENT = 3,
  ELIZA_NPU_ERR_RING_BOUNDS = 4,
  ELIZA_NPU_ERR_WRITEBACK_UNSUPPORTED = 5,
  ELIZA_NPU_ERR_MMIO = 6,
  ELIZA_NPU_ERR_TIMEOUT = 7,
  ELIZA_NPU_ERR_REJECTED = 8
} eliza_npu_status_t;

typedef struct {
  uint32_t opcode;
  uint32_t source_addr;
  uint32_t scratch_offset;
  uint32_t byte_count;
  uint32_t op_b;
  uint32_t acc;
  uint32_t flags; /* bitwise OR of ELIZA_NPU_DESC_FLAG_* */
} eliza_npu_descriptor_t;

typedef struct {
  uint32_t word0;
  uint32_t word1;
  uint32_t word2;
  uint32_t word3;
} eliza_npu_descriptor_words_t;

/* MMIO read/write callbacks. Mirrors the Read32/Write32 protocol used by the
 * Python oracle. The kernel driver supplies platform-specific implementations
 * (Linux ioremap / Verilator memmap / userspace fake). */
typedef uint32_t (*eliza_npu_read32_fn)(uint32_t offset, void *ctx);
typedef void     (*eliza_npu_write32_fn)(uint32_t offset, uint32_t value, void *ctx);

typedef struct {
  eliza_npu_read32_fn  read32;
  eliza_npu_write32_fn write32;
  void                *ctx;
} eliza_npu_mmio_t;

/* Pure encoder. Validates the descriptor against the contract and packs the
 * four 32-bit words. Returns OK and fills `out` on success. */
eliza_npu_status_t eliza_npu_pack_descriptor(
    const eliza_npu_descriptor_t *desc,
    eliza_npu_descriptor_words_t *out);

/* Pack only word 0 (matches `pack_stream_descriptor_word0` in the Python
 * oracle). Useful for callers that build word1..word3 themselves. */
uint32_t eliza_npu_pack_descriptor_word0(
    uint32_t opcode, uint32_t scratch_offset, uint32_t byte_count,
    int valid_owner, int writeback_request);

/* Submit a contiguous range of descriptors. The caller stages descriptors
 * into the ring base buffer; this entry point pokes the MMIO registers and
 * polls `DESC_STATUS` until completion or timeout. */
eliza_npu_status_t eliza_npu_submit_descriptors(
    eliza_npu_mmio_t *mmio,
    uint32_t descriptor_ring_base_phys,
    uint32_t head,
    uint32_t tail,
    uint32_t timeout_polls);

#ifdef __cplusplus
} // extern "C"
#endif

#endif // ELIZA_NPU_RUNTIME_H
