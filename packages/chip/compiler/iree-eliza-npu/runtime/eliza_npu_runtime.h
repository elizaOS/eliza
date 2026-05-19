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

/* MMIO base + register offsets. Identical to PRECISION_MATRIX values. */
#define ELIZA_NPU_MMIO_BASE         0x10020000u
#define ELIZA_NPU_REG_OP_A          0x00u
#define ELIZA_NPU_REG_OP_B          0x04u
#define ELIZA_NPU_REG_RESULT        0x08u
#define ELIZA_NPU_REG_CTRL_STATUS   0x0Cu
#define ELIZA_NPU_REG_OPCODE        0x10u
#define ELIZA_NPU_REG_ACC           0x14u
#define ELIZA_NPU_REG_GEMM_CFG      0x20u
#define ELIZA_NPU_REG_GEMM_BASE     0x24u
#define ELIZA_NPU_REG_GEMM_STRIDE   0x28u
#define ELIZA_NPU_REG_CMD_PARAM     0x30u
#define ELIZA_NPU_REG_DESC_BASE     0x40u
#define ELIZA_NPU_REG_DESC_HEAD     0x44u
#define ELIZA_NPU_REG_DESC_TAIL     0x48u
#define ELIZA_NPU_REG_DESC_STATUS   0x4Cu
#define ELIZA_NPU_REG_SCRATCH       0x80u

#define ELIZA_NPU_SCRATCH_BYTES     64
#define ELIZA_NPU_DESC_RING_ENTRIES 8

/* Descriptor word 0 layout. */
#define ELIZA_NPU_DESC_FLAG_STREAM_TO_SCRATCH (1u << 8)
#define ELIZA_NPU_DESC_FLAG_WRITEBACK_REQUEST (1u << 30)
#define ELIZA_NPU_DESC_FLAG_VALID_OWNER       (1u << 31)

/* Hardware opcodes. */
#define ELIZA_NPU_OP_ADD     0u
#define ELIZA_NPU_OP_SUB     1u
#define ELIZA_NPU_OP_MUL_LO  2u
#define ELIZA_NPU_OP_MAC_S16 3u
#define ELIZA_NPU_OP_DOT4_S8 4u
#define ELIZA_NPU_OP_MAX_U32 5u
#define ELIZA_NPU_OP_MIN_U32 6u
#define ELIZA_NPU_OP_DOT8_S4 7u
#define ELIZA_NPU_OP_GEMM_S8 8u

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
