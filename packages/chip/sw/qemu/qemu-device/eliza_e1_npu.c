/*
 * Eliza E1 NPU MMIO device model.
 *
 * Functional model of rtl/npu/e1_npu.sv. The register byte offsets follow
 * sw/platform/e1_platform_contract.json (the RTL 6-bit word address equals
 * byte_offset >> 2). On a START doorbell the model performs the same INT8/INT4
 * GEMM, scalar, packed-dot and vector-ReLU arithmetic the RTL computes, and on
 * a descriptor doorbell it fetches four-word descriptors from guest memory,
 * optionally streams operands into the scratchpad, executes, and optionally
 * writes results back to guest memory.
 *
 * Because QEMU drivers program the operands, write START, then poll the status
 * register until DONE/ERROR, the compute is performed synchronously on the
 * START write and the status register is left reporting completion.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/module.h"
#include "hw/sysbus.h"
#include "hw/irq.h"
#include "hw/qdev-properties.h"
#include "migration/vmstate.h"
#include "system/dma.h"
#include "hw/misc/eliza_e1_npu.h"

/* Register byte offsets (e1_platform_contract.h). */
#define R_OP_A                 0x00
#define R_OP_B                 0x04
#define R_RESULT               0x08
#define R_CTRL_STATUS          0x0c
#define R_OPCODE               0x10
#define R_ACC                  0x14
#define R_RESULT_HI            0x18
#define R_TRACE                0x1c
#define R_GEMM_CFG             0x20
#define R_GEMM_BASE            0x24
#define R_GEMM_STRIDE          0x28
#define R_PERF_UNSUPPORTED_OPS 0x2c
#define R_CMD_PARAM            0x30
#define R_DESC_BASE            0x40
#define R_DESC_HEAD            0x44
#define R_DESC_TAIL            0x48
#define R_DESC_STATUS          0x4c
#define R_PERF_CYCLES          0x50
#define R_PERF_MACS            0x54
#define R_PERF_OPS             0x58
#define R_PERF_ERRORS          0x5c
#define R_DESC_TIMEOUT_COUNT   0x60
#define R_DESC_BYTES_READ      0x64
#define R_DESC_BYTES_WRITTEN   0x68
#define R_DESC_READ_BEATS      0x6c
#define R_DESC_WRITE_BEATS     0x70
#define R_PERF_STALL_CYCLES    0x74
#define R_PERF_SCRATCH_BYTES   0x78
#define R_PERF_THERMAL_THROTTLE 0x7c
#define R_SCRATCH0             0x80
#define R_SCRATCH_END          0xbc

/* CTRL_STATUS bits. */
#define CTRL_START 0x1u
#define CTRL_DONE  0x2u
#define CTRL_ERROR 0x4u

/* CMD_PARAM flags. */
#define CMD_DESC_SUBMIT  0x1u
#define CMD_DOT16_TERNARY 0x2u

/* Opcodes. */
enum {
    OP_ADD = 0x0,
    OP_SUB = 0x1,
    OP_MUL_LO = 0x2,
    OP_MAC_S16 = 0x3,
    OP_DOT4_S8 = 0x4,
    OP_MAX_U32 = 0x5,
    OP_MIN_U32 = 0x6,
    OP_DOT8_S4 = 0x7,
    OP_GEMM_S8 = 0x8,
    OP_GEMM_S4 = 0x9,
    OP_RELU4_S8 = 0xa,
    OP_VRELU_S8 = 0xb,
    OP_SDOT4_S4_2_4 = 0xc,
    OP_DOT16_S2 = 0xd,
    OP_DOT4_FP8_E4M3 = 0xe,
    OP_EXP2_NEG_Q0_8 = 0xf,
};

#define DESC_TIMEOUT_LIMIT 128

static inline int32_t sx8(uint8_t v)  { return (int8_t)v; }
static inline int32_t sx4(uint8_t v)  { return (int8_t)(v << 4) >> 4; }
static inline int32_t sx2(uint8_t v)  { return (int8_t)(v << 6) >> 6; }
static inline int32_t sx16(uint16_t v){ return (int16_t)v; }

static uint8_t relu_s8(uint8_t v)
{
    return (v & 0x80) ? 0 : v;
}

/* Scratchpad byte/word access (little-endian within the 32-bit words). */
static uint8_t scratch_read_byte(ElizaE1NpuState *s, unsigned byte_addr)
{
    byte_addr &= 0x3f;
    return (s->scratch[byte_addr >> 2] >> ((byte_addr & 3) * 8)) & 0xff;
}

static void scratch_write_byte(ElizaE1NpuState *s, unsigned byte_addr, uint8_t v)
{
    uint32_t word_idx = (byte_addr & 0x3f) >> 2;
    unsigned shift = (byte_addr & 3) * 8;

    s->scratch[word_idx] &= ~(0xffu << shift);
    s->scratch[word_idx] |= (uint32_t)v << shift;
}

static int32_t scratch_read_s4(ElizaE1NpuState *s, unsigned nibble_addr)
{
    uint8_t byte_value = scratch_read_byte(s, nibble_addr >> 1);

    if (nibble_addr & 1) {
        return sx4((byte_value >> 4) & 0xf);
    }
    return sx4(byte_value & 0xf);
}

static int32_t s4_lane(uint32_t word, unsigned lane)
{
    return sx4((word >> (lane * 4)) & 0xf);
}

static int32_t s2_lane(uint32_t word, unsigned lane)
{
    return sx2((word >> (lane * 2)) & 0x3);
}

/* Ternary lane: 00=0, 01=+1, 10=-1, 11 reserved (rejected before use). */
static int32_t t2_lane(uint32_t word, unsigned lane)
{
    switch ((word >> (lane * 2)) & 0x3) {
    case 0x1: return 1;
    case 0x2: return -1;
    default:  return 0;
    }
}

static bool ternary_reserved_present(uint32_t a, uint32_t b)
{
    for (unsigned lane = 0; lane < 16; lane++) {
        if (((a >> (lane * 2)) & 0x3) == 0x3) {
            return true;
        }
        if (((b >> (lane * 2)) & 0x3) == 0x3) {
            return true;
        }
    }
    return false;
}

static int32_t fp8_e4m3_to_q8_8(uint8_t v)
{
    uint32_t exp = (v >> 3) & 0xf;
    uint32_t mant = v & 0x7;
    uint32_t abs_q;

    if (exp == 0) {
        abs_q = mant >> 1;
    } else if (exp >= 2) {
        abs_q = (0x8u | mant) << (exp - 2);
    } else {
        abs_q = (0x8u | mant) >> 1;
    }
    return (v & 0x80) ? -(int32_t)abs_q : (int32_t)abs_q;
}

static uint32_t exp2_neg_q0_8(uint8_t v)
{
    int8_t delta = (int8_t)v;
    uint8_t magnitude = (delta > 0) ? 0 : (uint8_t)(-delta);
    unsigned shift = (magnitude > 8) ? 8 : magnitude;

    return 256u >> shift;
}

static unsigned opcode_latency(uint32_t op)
{
    switch (op) {
    case OP_MUL_LO: return 2;
    case OP_MAC_S16: return 2;
    case OP_DOT4_S8: return 3;
    case OP_DOT8_S4: return 3;
    case OP_SDOT4_S4_2_4: return 3;
    case OP_DOT16_S2: return 3;
    case OP_DOT4_FP8_E4M3: return 3;
    case OP_EXP2_NEG_Q0_8: return 2;
    default: return 1;
    }
}

static bool opcode_valid(uint32_t op)
{
    return op <= 0xf;
}

static bool opcode_is_gemm(uint32_t op)
{
    return op == OP_GEMM_S8 || op == OP_GEMM_S4;
}

static bool opcode_is_vector(uint32_t op)
{
    return op == OP_VRELU_S8;
}

static void eliza_e1_npu_update_irq(ElizaE1NpuState *s)
{
    qemu_set_irq(s->irq, (s->status & CTRL_DONE) ? 1 : 0);
}

/*
 * Execute a scalar / packed-dot opcode against (a, b, acc), returning the
 * 64-bit datapath result through {hi, lo}. Returns false if the operation
 * faults (ternary reserved encoding), in which case the caller sets ERROR.
 */
static bool eliza_e1_npu_scalar(ElizaE1NpuState *s, uint32_t op,
                                uint32_t a, uint32_t b, uint32_t acc,
                                uint32_t *lo, uint32_t *hi)
{
    int64_t wide = 0;
    int32_t sum;

    switch (op) {
    case OP_ADD:
        wide = (uint32_t)(a + b);
        break;
    case OP_SUB:
        wide = (uint32_t)(a - b);
        break;
    case OP_MUL_LO:
        wide = (uint64_t)a * (uint64_t)b;
        break;
    case OP_MAC_S16:
        sum = sx16(a & 0xffff) * sx16(b & 0xffff) + (int32_t)acc;
        wide = sum;
        break;
    case OP_DOT4_S8:
        sum = sx8(a) * sx8(b) +
              sx8(a >> 8) * sx8(b >> 8) +
              sx8(a >> 16) * sx8(b >> 16) +
              sx8(a >> 24) * sx8(b >> 24) + (int32_t)acc;
        wide = sum;
        break;
    case OP_MAX_U32:
        wide = (a > b) ? a : b;
        break;
    case OP_MIN_U32:
        wide = (a < b) ? a : b;
        break;
    case OP_DOT8_S4:
        sum = (int32_t)acc;
        for (unsigned lane = 0; lane < 8; lane++) {
            sum += s4_lane(a, lane) * s4_lane(b, lane);
        }
        wide = sum;
        break;
    case OP_SDOT4_S4_2_4:
        sum = s4_lane(a, 0) * s4_lane(b, (acc >> 0) & 0x3) +
              s4_lane(a, 1) * s4_lane(b, (acc >> 2) & 0x3) +
              s4_lane(a, 2) * s4_lane(b, 0x4 | ((acc >> 4) & 0x3)) +
              s4_lane(a, 3) * s4_lane(b, 0x4 | ((acc >> 6) & 0x3));
        wide = sum;
        break;
    case OP_DOT16_S2:
        if (s->cmd_param & CMD_DOT16_TERNARY) {
            if (ternary_reserved_present(a, b)) {
                return false;
            }
            sum = (int32_t)acc;
            for (unsigned lane = 0; lane < 16; lane++) {
                sum += t2_lane(a, lane) * t2_lane(b, lane);
            }
        } else {
            sum = (int32_t)acc;
            for (unsigned lane = 0; lane < 16; lane++) {
                sum += s2_lane(a, lane) * s2_lane(b, lane);
            }
        }
        wide = sum;
        break;
    case OP_DOT4_FP8_E4M3:
        sum = (int32_t)acc;
        for (unsigned lane = 0; lane < 4; lane++) {
            int32_t pa = fp8_e4m3_to_q8_8((a >> (lane * 8)) & 0xff);
            int32_t pb = fp8_e4m3_to_q8_8((b >> (lane * 8)) & 0xff);
            sum += ((int64_t)pa * pb) >> 8;
        }
        wide = sum;
        break;
    case OP_EXP2_NEG_Q0_8:
        wide = exp2_neg_q0_8(a & 0xff);
        break;
    case OP_RELU4_S8:
        wide = ((uint32_t)relu_s8((a >> 24) & 0xff) << 24) |
               ((uint32_t)relu_s8((a >> 16) & 0xff) << 16) |
               ((uint32_t)relu_s8((a >> 8) & 0xff) << 8) |
               (uint32_t)relu_s8(a & 0xff);
        break;
    default:
        wide = 0;
        break;
    }

    *lo = (uint32_t)wide;
    *hi = (uint32_t)((uint64_t)wide >> 32);
    return true;
}

/*
 * GEMM_S8 / GEMM_S4 over the scratchpad. Operands and the int32 output live in
 * the 64-byte scratchpad addressed by the GEMM_BASE / GEMM_STRIDE registers.
 * Mirrors the RTL address generation exactly.
 */
static bool eliza_e1_npu_gemm(ElizaE1NpuState *s)
{
    uint32_t m = s->gemm_cfg & 0x3;
    uint32_t n = (s->gemm_cfg >> 8) & 0x3;
    uint32_t k = (s->gemm_cfg >> 16) & 0x7;
    uint32_t a_base = s->gemm_bases & 0x3f;
    uint32_t b_base = (s->gemm_bases >> 8) & 0x3f;
    uint32_t c_base = (s->gemm_bases >> 16) & 0x3f;
    uint32_t a_stride = s->gemm_strides & 0xf;
    uint32_t b_stride = (s->gemm_strides >> 8) & 0xf;
    uint32_t c_stride = (s->gemm_strides >> 16) & 0xf;
    bool s4_mode = (s->opcode == OP_GEMM_S4);

    if (m == 0 || n == 0 || k == 0) {
        return false;
    }

    for (uint32_t i = 0; i < m; i++) {
        for (uint32_t j = 0; j < n; j++) {
            uint32_t c_addr = c_base + i * c_stride + j * 4;
            int32_t acc = 0;

            for (uint32_t l = 0; l < k; l++) {
                uint32_t a_addr = a_base + i * a_stride + l;
                uint32_t b_addr = b_base + l * b_stride + j;
                int32_t av, bv;

                if (s4_mode) {
                    if (a_addr >= 128 || b_addr >= 128) {
                        return false;
                    }
                    av = scratch_read_s4(s, a_addr);
                    bv = scratch_read_s4(s, b_addr);
                } else {
                    if (a_addr >= 64 || b_addr >= 64) {
                        return false;
                    }
                    av = sx8(scratch_read_byte(s, a_addr));
                    bv = sx8(scratch_read_byte(s, b_addr));
                }
                acc += av * bv;
                s->perf_macs++;
                s->perf_cycles++;
                s->perf_scratch_bytes += (l == k - 1) ? 6 : 2;
            }

            if ((c_addr + 3) >= 64 || (c_addr & 3) != 0) {
                return false;
            }
            s->scratch[c_addr >> 2] = (uint32_t)acc;
        }
    }
    return true;
}

/* VRELU_S8 over a scratchpad byte range (vec_len / src / dst from GEMM_CFG). */
static bool eliza_e1_npu_vrelu(ElizaE1NpuState *s)
{
    uint32_t vec_len = s->gemm_cfg & 0x3f;
    uint32_t src_base = s->gemm_bases & 0x3f;
    uint32_t dst_base = (s->gemm_bases >> 8) & 0x3f;

    if (vec_len == 0 || src_base + vec_len > 64 || dst_base + vec_len > 64) {
        return false;
    }
    for (uint32_t i = 0; i < vec_len; i++) {
        scratch_write_byte(s, dst_base + i, relu_s8(scratch_read_byte(s, src_base + i)));
        s->perf_scratch_bytes += 2;
        s->perf_cycles++;
    }
    return true;
}

/* Run the currently-programmed (non-descriptor) operation on a START doorbell. */
static void eliza_e1_npu_run_direct(ElizaE1NpuState *s)
{
    uint32_t lo, hi;

    if (opcode_is_gemm(s->opcode)) {
        if (eliza_e1_npu_gemm(s)) {
            s->status = CTRL_DONE;
            s->perf_ops++;
        } else {
            s->status = CTRL_DONE | CTRL_ERROR;
            s->perf_errors++;
            s->perf_unsupported_ops++;
        }
        return;
    }
    if (opcode_is_vector(s->opcode)) {
        if (eliza_e1_npu_vrelu(s)) {
            s->status = CTRL_DONE;
            s->perf_ops++;
        } else {
            s->status = CTRL_DONE | CTRL_ERROR;
            s->perf_errors++;
            s->perf_unsupported_ops++;
        }
        return;
    }
    if (!opcode_valid(s->opcode)) {
        s->status = CTRL_DONE | CTRL_ERROR;
        s->perf_errors++;
        s->perf_unsupported_ops++;
        return;
    }
    if (!eliza_e1_npu_scalar(s, s->opcode, s->op_a, s->op_b, s->acc, &lo, &hi)) {
        s->status = CTRL_DONE | CTRL_ERROR;
        s->perf_errors++;
        return;
    }
    s->result = lo;
    s->result_hi = hi;
    s->perf_cycles += opcode_latency(s->opcode);
    s->perf_ops++;
    s->status = CTRL_DONE;
}

/*
 * Descriptor ring execution. Walks the 3-bit head/tail ring at DESC_BASE,
 * fetching four 32-bit descriptor words from guest memory per entry, optionally
 * streaming operand bytes into the scratchpad, executing the descriptor's
 * opcode, and optionally writing GEMM output back to guest memory. Mirrors the
 * RTL DESC_* state machine, including its fail-closed validation and accounting.
 */
static void eliza_e1_npu_run_descriptors(ElizaE1NpuState *s)
{
    uint32_t tail = s->desc_tail & 0x7;
    uint32_t head = s->desc_head & 0x7;

    if (s->desc_base & 0x3) {
        s->desc_status = 0x4;
        s->status = CTRL_DONE | CTRL_ERROR;
        s->perf_errors++;
        s->perf_unsupported_ops++;
        return;
    }
    if (head == tail) {
        s->desc_status = 0x1;
        s->status = CTRL_DONE | CTRL_ERROR;
        s->perf_errors++;
        s->perf_unsupported_ops++;
        return;
    }

    s->desc_bytes_read = 0;
    s->desc_bytes_written = 0;
    s->desc_read_beats = 0;
    s->desc_write_beats = 0;
    s->desc_timeout_count = 0;

    while (tail != head) {
        uint32_t desc[4];
        uint32_t desc_addr = s->desc_base + tail * 16;

        for (unsigned w = 0; w < 4; w++) {
            uint32_t v;
            if (dma_memory_read(s->dma_as, desc_addr + w * 4, &v, 4,
                                MEMTXATTRS_UNSPECIFIED) != MEMTX_OK) {
                s->desc_status = 0x14;
                s->status = CTRL_DONE | CTRL_ERROR;
                s->perf_errors++;
                s->perf_unsupported_ops++;
                return;
            }
            desc[w] = le32_to_cpu(v);
            s->desc_bytes_read += 4;
            s->desc_read_beats++;
        }

        uint32_t opcode = desc[0] & 0xf;
        bool valid_owner = desc[0] & (1u << 31);
        bool writeback = desc[0] & (1u << 30);
        bool stream = desc[0] & (1u << 8);
        uint32_t stream_dst = (desc[0] >> 16) & 0x3f;
        uint32_t stream_len = (desc[0] >> 24) & 0x3f;

        if (!valid_owner) {
            s->desc_status = 0x44;
            s->status = CTRL_DONE | CTRL_ERROR;
            s->perf_errors++;
            s->perf_unsupported_ops++;
            return;
        }
        if (!opcode_valid(opcode)) {
            s->desc_status = 0x6;
            s->status = CTRL_DONE | CTRL_ERROR;
            s->perf_errors++;
            s->perf_unsupported_ops++;
            return;
        }

        /* Stream descriptor-sourced DRAM words into the scratchpad. */
        if (stream) {
            bool stream_ok = ((desc[1] & 0x3) == 0) &&
                             ((stream_dst & 0x3) == 0) &&
                             (stream_len != 0) &&
                             ((stream_len & 0x3) == 0) &&
                             (stream_dst + stream_len <= 64);
            if (!stream_ok) {
                s->desc_status = 0x24;
                s->status = CTRL_DONE | CTRL_ERROR;
                s->perf_errors++;
                s->perf_unsupported_ops++;
                return;
            }
            for (uint32_t off = 0; off < stream_len; off += 4) {
                uint32_t v;
                if (dma_memory_read(s->dma_as, desc[1] + off, &v, 4,
                                    MEMTXATTRS_UNSPECIFIED) != MEMTX_OK) {
                    s->desc_status = 0x34;
                    s->status = CTRL_DONE | CTRL_ERROR;
                    s->perf_errors++;
                    s->perf_unsupported_ops++;
                    return;
                }
                s->scratch[(stream_dst + off) >> 2] = le32_to_cpu(v);
                s->desc_bytes_read += 4;
                s->desc_read_beats++;
                s->perf_scratch_bytes += 4;
            }
        }

        /* Execute the descriptor opcode. */
        bool ok;
        if (opcode_is_gemm(opcode)) {
            s->opcode = opcode;
            ok = eliza_e1_npu_gemm(s);
        } else if (opcode_is_vector(opcode)) {
            s->opcode = opcode;
            ok = eliza_e1_npu_vrelu(s);
        } else {
            uint32_t lo, hi;
            ok = eliza_e1_npu_scalar(s, opcode, desc[1], desc[2], desc[3],
                                     &lo, &hi);
            if (ok) {
                s->result = lo;
                s->result_hi = hi;
            }
        }
        if (!ok) {
            s->desc_status = 0x6;
            s->status = CTRL_DONE | CTRL_ERROR;
            s->perf_errors++;
            s->perf_unsupported_ops++;
            return;
        }
        s->perf_ops++;

        /* Writeback streamed GEMM output to guest memory. */
        if (writeback) {
            uint32_t m = s->gemm_cfg & 0x3;
            uint32_t n = (s->gemm_cfg >> 8) & 0x3;
            uint32_t c_base = (s->gemm_bases >> 16) & 0x3f;
            uint32_t write_len = m * n * 4;
            bool wb_ok = ((desc[2] & 0x3) == 0) && opcode_is_gemm(opcode) &&
                         (c_base + write_len <= 64) && (write_len != 0);
            if (!wb_ok) {
                s->desc_status = 0x84;
                s->status = CTRL_DONE | CTRL_ERROR;
                s->perf_errors++;
                s->perf_unsupported_ops++;
                return;
            }
            for (uint32_t off = 0; off < write_len; off += 4) {
                uint32_t v = cpu_to_le32(s->scratch[(c_base + off) >> 2]);
                if (dma_memory_write(s->dma_as, desc[2] + off, &v, 4,
                                     MEMTXATTRS_UNSPECIFIED) != MEMTX_OK) {
                    s->desc_status = 0x94;
                    s->status = CTRL_DONE | CTRL_ERROR;
                    s->perf_errors++;
                    s->perf_unsupported_ops++;
                    return;
                }
                s->desc_bytes_written += 4;
                s->desc_write_beats++;
                s->perf_scratch_bytes += 4;
            }
        }

        tail = (tail + 1) & 0x7;
        s->desc_tail = tail;
        s->desc_status = 0x2;
    }

    s->status = CTRL_DONE;
}

static void eliza_e1_npu_doorbell(ElizaE1NpuState *s)
{
    if (s->cmd_param & CMD_DESC_SUBMIT) {
        eliza_e1_npu_run_descriptors(s);
    } else {
        eliza_e1_npu_run_direct(s);
    }
    eliza_e1_npu_update_irq(s);
}

static uint64_t eliza_e1_npu_read(void *opaque, hwaddr addr, unsigned size)
{
    ElizaE1NpuState *s = opaque;

    if (addr >= R_SCRATCH0 && addr <= R_SCRATCH_END) {
        return s->scratch[(addr - R_SCRATCH0) >> 2];
    }

    switch (addr) {
    case R_OP_A: return s->op_a;
    case R_OP_B: return s->op_b;
    case R_RESULT: return s->result;
    case R_CTRL_STATUS: return s->status;
    case R_OPCODE: return s->opcode & 0xf;
    case R_ACC: return s->acc;
    case R_RESULT_HI: return s->result_hi;
    case R_TRACE: return 0;
    case R_GEMM_CFG: return s->gemm_cfg;
    case R_GEMM_BASE: return s->gemm_bases;
    case R_GEMM_STRIDE: return s->gemm_strides;
    case R_PERF_UNSUPPORTED_OPS: return s->perf_unsupported_ops;
    case R_CMD_PARAM: return s->cmd_param;
    case R_DESC_BASE: return s->desc_base;
    case R_DESC_HEAD: return s->desc_head & 0x7;
    case R_DESC_TAIL: return s->desc_tail & 0x7;
    case R_DESC_STATUS: return s->desc_status;
    case R_PERF_CYCLES: return s->perf_cycles;
    case R_PERF_MACS: return s->perf_macs;
    case R_PERF_OPS: return s->perf_ops;
    case R_PERF_ERRORS: return s->perf_errors;
    case R_DESC_TIMEOUT_COUNT: return s->desc_timeout_count;
    case R_DESC_BYTES_READ: return s->desc_bytes_read;
    case R_DESC_BYTES_WRITTEN: return s->desc_bytes_written;
    case R_DESC_READ_BEATS: return s->desc_read_beats;
    case R_DESC_WRITE_BEATS: return s->desc_write_beats;
    case R_PERF_STALL_CYCLES: return s->perf_stall_cycles;
    case R_PERF_SCRATCH_BYTES: return s->perf_scratch_bytes;
    case R_PERF_THERMAL_THROTTLE: return s->perf_thermal_throttle;
    default:
        qemu_log_mask(LOG_GUEST_ERROR,
                      "%s: bad read offset 0x%" HWADDR_PRIx "\n",
                      __func__, addr);
        return 0;
    }
}

static void eliza_e1_npu_write(void *opaque, hwaddr addr, uint64_t val64,
                               unsigned size)
{
    ElizaE1NpuState *s = opaque;
    uint32_t val = (uint32_t)val64;

    if (addr >= R_SCRATCH0 && addr <= R_SCRATCH_END) {
        s->scratch[(addr - R_SCRATCH0) >> 2] = val;
        return;
    }

    switch (addr) {
    case R_OP_A: s->op_a = val; break;
    case R_OP_B: s->op_b = val; break;
    case R_ACC: s->acc = val; break;
    case R_OPCODE: s->opcode = val & 0xf; break;
    case R_GEMM_CFG: s->gemm_cfg = val; break;
    case R_GEMM_BASE: s->gemm_bases = val; break;
    case R_GEMM_STRIDE: s->gemm_strides = val; break;
    case R_CMD_PARAM: s->cmd_param = val; break;
    case R_DESC_BASE: s->desc_base = val; break;
    case R_DESC_HEAD: s->desc_head = val & 0x7; break;
    case R_DESC_TAIL: s->desc_tail = val & 0x7; break;
    case R_PERF_THERMAL_THROTTLE: s->perf_thermal_throttle++; break;
    case R_PERF_ERRORS:
        /* PERF clear: writing bit0 zeroes all perf/accounting counters. */
        if (val & 0x1) {
            s->perf_cycles = 0;
            s->perf_macs = 0;
            s->perf_errors = 0;
            s->perf_ops = 0;
            s->perf_unsupported_ops = 0;
            s->desc_bytes_read = 0;
            s->desc_bytes_written = 0;
            s->desc_read_beats = 0;
            s->desc_write_beats = 0;
            s->perf_stall_cycles = 0;
            s->perf_scratch_bytes = 0;
            s->perf_thermal_throttle = 0;
        }
        break;
    case R_CTRL_STATUS:
        if (val & CTRL_START) {
            eliza_e1_npu_doorbell(s);
        }
        if (val & CTRL_DONE) {
            /*
             * Writing DONE/ERROR clears the completion latch (the driver does
             * this before arming START). Only clear when START is not also
             * being asserted in the same write.
             */
            if (!(val & CTRL_START)) {
                s->status &= ~(CTRL_DONE | CTRL_ERROR);
                eliza_e1_npu_update_irq(s);
            }
        }
        break;
    default:
        qemu_log_mask(LOG_GUEST_ERROR,
                      "%s: bad write offset 0x%" HWADDR_PRIx
                      " val 0x%" PRIx32 "\n", __func__, addr, val);
        break;
    }
}

static const MemoryRegionOps eliza_e1_npu_ops = {
    .read = eliza_e1_npu_read,
    .write = eliza_e1_npu_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
    .impl.min_access_size = 4,
    .impl.max_access_size = 4,
};

static void eliza_e1_npu_reset_hold(Object *obj, ResetType type)
{
    ElizaE1NpuState *s = ELIZA_E1_NPU(obj);

    s->op_a = 0;
    s->op_b = 0;
    s->acc = 0;
    s->opcode = OP_ADD;
    s->result = 0;
    s->result_hi = 0;
    s->status = 0;
    s->cmd_param = 0;
    s->gemm_cfg = 0;
    s->gemm_bases = 0;
    s->gemm_strides = 0;
    s->desc_base = 0;
    s->desc_head = 0;
    s->desc_tail = 0;
    s->desc_status = 0x1;
    s->perf_cycles = 0;
    s->perf_macs = 0;
    s->perf_ops = 0;
    s->perf_errors = 0;
    s->perf_unsupported_ops = 0;
    s->desc_timeout_count = 0;
    s->desc_bytes_read = 0;
    s->desc_bytes_written = 0;
    s->desc_read_beats = 0;
    s->desc_write_beats = 0;
    s->perf_stall_cycles = 0;
    s->perf_scratch_bytes = 0;
    s->perf_thermal_throttle = 0;
    memset(s->scratch, 0, sizeof(s->scratch));
    eliza_e1_npu_update_irq(s);
}

static void eliza_e1_npu_init(Object *obj)
{
    ElizaE1NpuState *s = ELIZA_E1_NPU(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    memory_region_init_io(&s->iomem, obj, &eliza_e1_npu_ops, s,
                          TYPE_ELIZA_E1_NPU, 0x1000);
    sysbus_init_mmio(sbd, &s->iomem);
    sysbus_init_irq(sbd, &s->irq);
}

static void eliza_e1_npu_realize(DeviceState *dev, Error **errp)
{
    ElizaE1NpuState *s = ELIZA_E1_NPU(dev);

    if (!s->dma_as) {
        s->dma_as = &address_space_memory;
    }
}

static const VMStateDescription vmstate_eliza_e1_npu = {
    .name = TYPE_ELIZA_E1_NPU,
    .version_id = 1,
    .minimum_version_id = 1,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32(op_a, ElizaE1NpuState),
        VMSTATE_UINT32(op_b, ElizaE1NpuState),
        VMSTATE_UINT32(acc, ElizaE1NpuState),
        VMSTATE_UINT32(opcode, ElizaE1NpuState),
        VMSTATE_UINT32(result, ElizaE1NpuState),
        VMSTATE_UINT32(result_hi, ElizaE1NpuState),
        VMSTATE_UINT32(status, ElizaE1NpuState),
        VMSTATE_UINT32(cmd_param, ElizaE1NpuState),
        VMSTATE_UINT32(gemm_cfg, ElizaE1NpuState),
        VMSTATE_UINT32(gemm_bases, ElizaE1NpuState),
        VMSTATE_UINT32(gemm_strides, ElizaE1NpuState),
        VMSTATE_UINT32(desc_base, ElizaE1NpuState),
        VMSTATE_UINT32(desc_head, ElizaE1NpuState),
        VMSTATE_UINT32(desc_tail, ElizaE1NpuState),
        VMSTATE_UINT32(desc_status, ElizaE1NpuState),
        VMSTATE_UINT32(perf_cycles, ElizaE1NpuState),
        VMSTATE_UINT32(perf_macs, ElizaE1NpuState),
        VMSTATE_UINT32(perf_ops, ElizaE1NpuState),
        VMSTATE_UINT32(perf_errors, ElizaE1NpuState),
        VMSTATE_UINT32(perf_unsupported_ops, ElizaE1NpuState),
        VMSTATE_UINT32_ARRAY(scratch, ElizaE1NpuState,
                             ELIZA_E1_NPU_SCRATCH_WORDS),
        VMSTATE_END_OF_LIST()
    }
};

static void eliza_e1_npu_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);

    dc->realize = eliza_e1_npu_realize;
    dc->vmsd = &vmstate_eliza_e1_npu;
    rc->phases.hold = eliza_e1_npu_reset_hold;
}

static const TypeInfo eliza_e1_npu_info = {
    .name = TYPE_ELIZA_E1_NPU,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(ElizaE1NpuState),
    .instance_init = eliza_e1_npu_init,
    .class_init = eliza_e1_npu_class_init,
};

static void eliza_e1_npu_register_types(void)
{
    type_register_static(&eliza_e1_npu_info);
}

type_init(eliza_e1_npu_register_types)
