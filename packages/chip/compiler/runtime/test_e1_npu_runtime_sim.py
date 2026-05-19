#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e1_npu_lowering import (
    lower_attention_av_smoke,
    lower_attention_qk_smoke,
    lower_attention_smoke,
    lower_attention_softmax_smoke,
    lower_bf16_matmul_smoke,
    lower_bias_add_smoke,
    lower_conv2d_smoke,
    lower_decode_attention_smoke,
    lower_depthwise_conv2d_smoke,
    lower_fp8_matmul_smoke,
    lower_fp16_matmul_smoke,
    lower_gelu_smoke,
    lower_group_scaled_int4_matmul_smoke,
    lower_grouped_conv2d_smoke,
    lower_int2_matmul_smoke,
    lower_kv_cache_update_smoke,
    lower_matmul_smoke,
    lower_mlp_smoke,
    lower_modern_decoder_block_smoke,
    lower_qkv_projection_smoke,
    lower_residual_add_smoke,
    lower_rmsnorm_smoke,
    lower_rope_smoke,
    lower_silu_smoke,
    lower_sparse_int4_matmul_smoke,
    lower_swiglu_smoke,
    lower_transformer_block_smoke,
)
from e1_npu_runtime import (
    E1NpuRuntime,
    NpuDescriptorSubmission,
    golden_dot4_fp8_e4m3,
    golden_dot16_s2,
    golden_exp2_neg_q0_8,
    golden_gemm_s4,
    golden_gemm_s8,
    golden_sdot4_s4_2_4,
    golden_vrelu_s8,
)


class E1NpuMmioSim:
    """Tiny behavioral MMIO model for userspace runtime smoke tests."""

    def __init__(self):
        self.runtime = E1NpuRuntime(self.read32, self.write32)
        self.memory: dict[int, int] = {}
        self.regs: dict[int, int] = {
            self.runtime.CTRL_STATUS: 0,
            self.runtime.PERF_UNSUPPORTED_OPS: 0,
            self.runtime.PERF_CYCLES: 0,
            self.runtime.PERF_MACS: 0,
            self.runtime.PERF_OPS: 0,
            self.runtime.PERF_ERRORS: 0,
            self.runtime.DESC_STATUS: self.runtime.DESC_STATUS_EMPTY,
            self.runtime.DESC_HEAD: 0,
            self.runtime.DESC_TAIL: 0,
            self.runtime.DESC_TIMEOUT_COUNT: 0,
            self.runtime.DESC_BYTES_READ: 0,
            self.runtime.DESC_BYTES_WRITTEN: 0,
            self.runtime.DESC_READ_BEATS: 0,
            self.runtime.DESC_WRITE_BEATS: 0,
        }
        for word in range(self.runtime.SCRATCH_BYTES // 4):
            self.regs[self.runtime.SCRATCH + word * 4] = 0

    def read32(self, addr: int) -> int:
        return self.regs.get(addr, 0) & 0xFFFF_FFFF

    def write32(self, addr: int, value: int) -> None:
        value &= 0xFFFF_FFFF
        if addr == self.runtime.PERF_ERRORS and value & 1:
            for reg in (
                self.runtime.PERF_UNSUPPORTED_OPS,
                self.runtime.PERF_CYCLES,
                self.runtime.PERF_MACS,
                self.runtime.PERF_OPS,
                self.runtime.PERF_ERRORS,
            ):
                self.regs[reg] = 0
            return
        if addr == self.runtime.CTRL_STATUS and value & 2:
            self.regs[self.runtime.CTRL_STATUS] = 0
            return
        self.regs[addr] = value
        if addr == self.runtime.CTRL_STATUS and value & 1:
            self._execute()

    def write_mem32(self, addr: int, value: int) -> None:
        if addr < 0 or addr & 0x3:
            raise ValueError("sim memory writes must be non-negative and 32-bit aligned")
        self.memory[addr] = value & 0xFFFF_FFFF

    def _scratch_read_s8(self, offset: int) -> int:
        word = self.regs[self.runtime.SCRATCH + (offset & ~3)]
        value = (word >> (8 * (offset & 3))) & 0xFF
        return value - 0x100 if value & 0x80 else value

    @staticmethod
    def _s4(value: int) -> int:
        value &= 0xF
        return value - 0x10 if value & 0x8 else value

    @staticmethod
    def _s2(value: int) -> int:
        value &= 0x3
        return value - 0x4 if value & 0x2 else value

    @staticmethod
    def _fp8_e4m3_to_q8_8(value: int) -> int:
        value &= 0xFF
        exp = (value >> 3) & 0xF
        mant = value & 0x7
        if exp == 0:
            abs_q = mant >> 1
        elif exp >= 2:
            abs_q = (8 + mant) << (exp - 2)
        else:
            abs_q = (8 + mant) >> 1
        return -abs_q if value & 0x80 else abs_q

    def _scratch_read_s4(self, offset: int) -> int:
        byte = self.regs[self.runtime.SCRATCH + ((offset // 2) & ~3)]
        byte = (byte >> (8 * ((offset // 2) & 3))) & 0xFF
        value = (byte >> 4) & 0xF if offset & 1 else byte & 0xF
        return value - 0x10 if value & 0x8 else value

    def _scratch_write_s32(self, offset: int, value: int) -> None:
        self.regs[self.runtime.SCRATCH + offset] = value & 0xFFFF_FFFF

    def _scratch_read_u32(self, offset: int) -> int:
        return self.regs[self.runtime.SCRATCH + offset] & 0xFFFF_FFFF

    def _memory_read_u8(self, address: int) -> int:
        word_address = address & ~3
        if word_address not in self.memory:
            raise KeyError(word_address)
        return (self.memory[word_address] >> (8 * (address & 3))) & 0xFF

    def _scratch_write_u8(self, offset: int, value: int) -> None:
        word_addr = self.runtime.SCRATCH + (offset & ~3)
        shift = 8 * (offset & 3)
        mask = 0xFF << shift
        self.regs[word_addr] = (self.regs[word_addr] & ~mask) | ((value & 0xFF) << shift)

    def _scratch_write_s8(self, offset: int, value: int) -> None:
        word_addr = self.runtime.SCRATCH + (offset & ~3)
        shift = 8 * (offset & 3)
        mask = 0xFF << shift
        self.regs[word_addr] = (self.regs[word_addr] & ~mask) | ((value & 0xFF) << shift)

    def _execute(self) -> None:
        if self.regs.get(self.runtime.CMD_PARAM, 0) == 1:
            head = self.regs.get(self.runtime.DESC_HEAD, 0)
            tail = self.regs.get(self.runtime.DESC_TAIL, 0)
            queued = (tail - head) & (self.runtime.DESC_RING_ENTRIES - 1)
            if queued == 0:
                self.regs[self.runtime.DESC_STATUS] = (
                    self.runtime.DESC_STATUS_EMPTY | self.runtime.DESC_STATUS_ERROR
                )
                self.regs[self.runtime.CTRL_STATUS] = 0x6
                return
            if self._execute_memory_backed_descriptors(head, queued):
                return
            self.regs[self.runtime.DESC_BYTES_READ] += queued * 16
            self.regs[self.runtime.DESC_BYTES_WRITTEN] += 0
            self.regs[self.runtime.DESC_READ_BEATS] += queued
            self.regs[self.runtime.DESC_WRITE_BEATS] += 0
            self.regs[self.runtime.DESC_HEAD] = tail
            self.regs[self.runtime.DESC_STATUS] = self.runtime.DESC_STATUS_DONE
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return

        opcode = self.regs.get(self.runtime.OPCODE, 0)
        self.regs[self.runtime.PERF_OPS] += 1
        if opcode == self.runtime.OP_ADD:
            self.regs[self.runtime.RESULT] = (
                self.regs.get(self.runtime.OP_A, 0) + self.regs.get(self.runtime.OP_B, 0)
            ) & 0xFFFF_FFFF
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_SUB:
            self.regs[self.runtime.RESULT] = (
                self.regs.get(self.runtime.OP_A, 0) - self.regs.get(self.runtime.OP_B, 0)
            ) & 0xFFFF_FFFF
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_MUL_LO:
            self.regs[self.runtime.RESULT] = (
                self.regs.get(self.runtime.OP_A, 0) * self.regs.get(self.runtime.OP_B, 0)
            ) & 0xFFFF_FFFF
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_MAX_U32:
            self.regs[self.runtime.RESULT] = max(
                self.regs.get(self.runtime.OP_A, 0),
                self.regs.get(self.runtime.OP_B, 0),
            )
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_MIN_U32:
            self.regs[self.runtime.RESULT] = min(
                self.regs.get(self.runtime.OP_A, 0),
                self.regs.get(self.runtime.OP_B, 0),
            )
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_EXP2_NEG_Q0_8:
            delta = self.regs.get(self.runtime.OP_A, 0) & 0xFF
            delta = delta - 0x100 if delta & 0x80 else delta
            self.regs[self.runtime.RESULT] = golden_exp2_neg_q0_8(min(0, delta))
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_DOT8_S4:
            self.regs[self.runtime.RESULT] = 0
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_RELU4_S8:
            a = self.regs.get(self.runtime.OP_A, 0)
            result = 0
            for index in range(4):
                value = (a >> (8 * index)) & 0xFF
                if value & 0x80:
                    value -= 0x100
                result |= (max(0, value) & 0xFF) << (8 * index)
            self.regs[self.runtime.RESULT] = result
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_SDOT4_S4_2_4:
            weights = self.regs.get(self.runtime.OP_A, 0)
            dense = self.regs.get(self.runtime.OP_B, 0)
            metadata = self.regs.get(self.runtime.ACC, 0)
            result = 0
            for index in range(4):
                position = (metadata >> (2 * index)) & 0x3
                dense_lane = (index // 2) * 4 + position
                result += self._s4(weights >> (4 * index)) * self._s4(dense >> (4 * dense_lane))
            self.regs[self.runtime.RESULT] = result & 0xFFFF_FFFF
            self.regs[self.runtime.RESULT_HI] = 0xFFFF_FFFF if result < 0 else 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_DOT16_S2:
            a = self.regs.get(self.runtime.OP_A, 0)
            b = self.regs.get(self.runtime.OP_B, 0)
            acc = self.regs.get(self.runtime.ACC, 0)
            if acc & 0x8000_0000:
                acc -= 0x1_0000_0000
            result = acc
            for index in range(16):
                result += self._s2(a >> (2 * index)) * self._s2(b >> (2 * index))
            self.regs[self.runtime.RESULT] = result & 0xFFFF_FFFF
            self.regs[self.runtime.RESULT_HI] = 0xFFFF_FFFF if result < 0 else 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_DOT4_FP8_E4M3:
            a = self.regs.get(self.runtime.OP_A, 0)
            b = self.regs.get(self.runtime.OP_B, 0)
            acc = self.regs.get(self.runtime.ACC, 0)
            if acc & 0x8000_0000:
                acc -= 0x1_0000_0000
            result = acc
            for index in range(4):
                result += (
                    self._fp8_e4m3_to_q8_8(a >> (8 * index))
                    * self._fp8_e4m3_to_q8_8(b >> (8 * index))
                ) >> 8
            self.regs[self.runtime.RESULT] = result & 0xFFFF_FFFF
            self.regs[self.runtime.RESULT_HI] = 0xFFFF_FFFF if result < 0 else 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_EXP2_NEG_Q0_8:
            delta = self.regs.get(self.runtime.OP_A, 0) & 0xFF
            delta = delta - 0x100 if delta & 0x80 else delta
            self.regs[self.runtime.RESULT] = golden_exp2_neg_q0_8(min(0, delta))
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode == self.runtime.OP_VRELU_S8:
            length = self.regs[self.runtime.GEMM_CFG] & 0x3F
            bases = self.regs[self.runtime.GEMM_BASE]
            src_base = bases & 0x3F
            dst_base = (bases >> 8) & 0x3F
            for index in range(length):
                value = max(0, self._scratch_read_s8(src_base + index))
                self._scratch_write_s8(dst_base + index, value)
            self.regs[self.runtime.PERF_CYCLES] += length
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode not in (self.runtime.OP_GEMM_S8, self.runtime.OP_GEMM_S4):
            self.regs[self.runtime.PERF_UNSUPPORTED_OPS] += 1
            self.regs[self.runtime.PERF_ERRORS] += 1
            self.regs[self.runtime.CTRL_STATUS] = 0x6
            return

        self._execute_gemm_from_scratch(opcode)

    def _execute_gemm_from_scratch(self, opcode: int) -> int:
        cfg = self.regs[self.runtime.GEMM_CFG]
        bases = self.regs[self.runtime.GEMM_BASE]
        strides = self.regs[self.runtime.GEMM_STRIDE]
        m = cfg & 0x3
        n = (cfg >> 8) & 0x3
        k = (cfg >> 16) & 0x7
        a_base = bases & 0x3F
        b_base = (bases >> 8) & 0x3F
        c_base = (bases >> 16) & 0x3F
        a_stride = strides & 0xF
        b_stride = (strides >> 8) & 0xF
        c_stride = (strides >> 16) & 0xF
        macs = 0
        for row in range(m):
            for col in range(n):
                acc = 0
                for kk in range(k):
                    if opcode == self.runtime.OP_GEMM_S4:
                        acc += self._scratch_read_s4(
                            a_base + row * a_stride + kk
                        ) * self._scratch_read_s4(b_base + kk * b_stride + col)
                    else:
                        acc += self._scratch_read_s8(
                            a_base + row * a_stride + kk
                        ) * self._scratch_read_s8(b_base + kk * b_stride + col)
                    macs += 1
                self._scratch_write_s32(c_base + row * c_stride + col * 4, acc)
        self.regs[self.runtime.PERF_CYCLES] += macs
        self.regs[self.runtime.PERF_MACS] += macs
        self.regs[self.runtime.CTRL_STATUS] = 0x2
        return macs

    def _execute_memory_backed_descriptors(self, head: int, queued: int) -> bool:
        desc_base = self.regs.get(self.runtime.DESC_BASE, 0)
        addresses = [
            desc_base + ((head + index) & (self.runtime.DESC_RING_ENTRIES - 1)) * 16 + word * 4
            for index in range(queued)
            for word in range(4)
        ]
        if not all(address in self.memory for address in addresses):
            return False

        bytes_read = queued * 16
        read_beats = queued
        bytes_written = 0
        write_beats = 0
        completed_index = head
        for index in range(queued):
            slot = (head + index) & (self.runtime.DESC_RING_ENTRIES - 1)
            base = desc_base + slot * 16
            word0 = self.memory[base]
            word1 = self.memory[base + 4]
            word2 = self.memory[base + 8]
            opcode = word0 & 0xF
            byte_count = (word0 >> 24) & 0x3F
            stream_to_scratch = bool(word0 & self.runtime.DESC_FLAG_STREAM_TO_SCRATCH)
            writeback_request = bool(word0 & self.runtime.DESC_FLAG_WRITEBACK_REQUEST)
            completed_index = slot

            if not word0 & self.runtime.DESC_FLAG_VALID_OWNER:
                self._descriptor_error(self.runtime.DESC_STATUS_OWNER_ERROR, slot)
                return True
            if stream_to_scratch:
                if byte_count == 0 or byte_count & 0x3:
                    self._descriptor_error(self.runtime.DESC_STATUS_STREAM_ERROR, slot)
                    return True
                scratch_offset = (word0 >> 16) & 0x3F
                try:
                    for offset in range(byte_count):
                        self._scratch_write_u8(
                            scratch_offset + offset,
                            self._memory_read_u8(word1 + offset),
                        )
                except KeyError:
                    self._descriptor_error(self.runtime.DESC_STATUS_MEM_ERROR, slot)
                    return True
                bytes_read += byte_count
                read_beats += byte_count // 4
            self.regs[self.runtime.OPCODE] = opcode
            if opcode in (self.runtime.OP_GEMM_S8, self.runtime.OP_GEMM_S4):
                self._execute_gemm_from_scratch(opcode)
            if writeback_request:
                if opcode not in (self.runtime.OP_GEMM_S8, self.runtime.OP_GEMM_S4) or word2 & 0x3:
                    self._descriptor_error(self.runtime.DESC_STATUS_WRITEBACK_UNSUPPORTED, slot)
                    return True
                cfg = self.regs.get(self.runtime.GEMM_CFG, 0)
                writeback_bytes = (cfg & 0x3) * ((cfg >> 8) & 0x3) * 4
                if writeback_bytes == 0:
                    self._descriptor_error(self.runtime.DESC_STATUS_WRITEBACK_UNSUPPORTED, slot)
                    return True
                bytes_written += writeback_bytes
                write_beats += writeback_bytes // 4
                c_base = (self.regs.get(self.runtime.GEMM_BASE, 0) >> 16) & 0x3F
                c_stride = (self.regs.get(self.runtime.GEMM_STRIDE, 0) >> 16) & 0xF
                n = (cfg >> 8) & 0x3
                for offset in range(0, writeback_bytes, 4):
                    row = offset // max(1, n * 4)
                    col = (offset // 4) % max(1, n)
                    self.memory[word2 + offset] = self._scratch_read_u32(
                        c_base + row * c_stride + col * 4
                    )
            if not stream_to_scratch:
                self.regs[self.runtime.OP_A] = word1
                self.regs[self.runtime.OP_B] = word2
                self.regs[self.runtime.ACC] = self.memory[base + 12]

        self.regs[self.runtime.DESC_BYTES_READ] += bytes_read
        self.regs[self.runtime.DESC_BYTES_WRITTEN] += bytes_written
        self.regs[self.runtime.DESC_READ_BEATS] += read_beats
        self.regs[self.runtime.DESC_WRITE_BEATS] += write_beats
        self.regs[self.runtime.DESC_HEAD] = self.regs.get(self.runtime.DESC_TAIL, 0)
        self.regs[self.runtime.DESC_STATUS] = self.runtime.DESC_STATUS_DONE | (
            (completed_index & 0x7) << 9
        )
        self.regs[self.runtime.CTRL_STATUS] = 0x2
        return True

    def _descriptor_error(self, status: int, index: int) -> None:
        self.regs[self.runtime.DESC_STATUS] = (
            self.runtime.DESC_STATUS_ERROR | status | ((index & 0x7) << 9)
        )
        self.regs[self.runtime.PERF_ERRORS] += 1
        self.regs[self.runtime.CTRL_STATUS] = 0x6


class E1NpuRuntimeSimTest(unittest.TestCase):
    def test_runtime_gemm_s8_matches_golden_and_reports_perf(self):
        sim = E1NpuMmioSim()
        a = [[1, -2, 3], [4, 5, -6]]
        b = [[7, -8], [9, 10], [-11, 12]]

        self.assertEqual(sim.runtime.gemm_s8(a, b), golden_gemm_s8(a, b))
        self.assertEqual(
            sim.runtime.perf(),
            {
                "cycles": 12,
                "macs": 12,
                "ops": 1,
                "errors": 0,
                "unsupported_ops": 0,
            },
        )

    def test_runtime_gemm_s4_matches_golden_and_reports_perf(self):
        sim = E1NpuMmioSim()
        a = [[7, -8, 3], [-4, 5, -6]]
        b = [[-7, 6], [5, -4], [3, -2]]

        self.assertEqual(sim.runtime.gemm_s4(a, b), golden_gemm_s4(a, b))
        self.assertEqual(sim.runtime.perf()["macs"], 12)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_matmul_smoke_lowering_dispatches_to_gemm(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": [[1, -2, 3], [4, 5, -6]],
            "rhs": [[7, -8], [9, 10], [-11, 12]],
        }

        lowered = lower_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result, golden_gemm_s8(graph["lhs"], graph["rhs"]))
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(lowered.abi_opcode, sim.runtime.OP_GEMM_S8)
        self.assertEqual(lowered.tile_count, 1)
        self.assertFalse(lowered.split_k)

    def test_runtime_matmul_smoke_lowering_dispatches_multiple_tiles(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.dot",
            "precision": "int8",
            "lhs": [[1, 2, -3, 4], [-4, 3, 2, -1], [5, -6, 7, -8], [2, 0, -1, 3]],
            "rhs": [[1, -2, 3, 4], [5, 6, -7, 8], [-1, 2, 0, 3], [4, -5, 6, -8]],
        }

        lowered = lower_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result, golden_gemm_s8(graph["lhs"], graph["rhs"]))
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(lowered.tile_count, 4)
        self.assertTrue(lowered.tiled_dispatch)
        self.assertFalse(lowered.split_k)

    def test_runtime_matmul_smoke_lowering_split_k_accumulates_npu_partials(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "lhs": [[1, -2, 3, 4, -5, 6, 7, -8], [-1, 2, -3, 4, 5, -6, 7, 8]],
            "rhs": [[1, -1], [2, 3], [-4, 5], [6, -7], [8, 1], [-2, 4], [3, -5], [7, 2]],
        }

        lowered = lower_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result, golden_gemm_s8(graph["lhs"], graph["rhs"]))
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(lowered.tile_count, 2)
        self.assertTrue(lowered.split_k)
        self.assertTrue(lowered.host_accumulates_partials)

    def test_runtime_qkv_projection_smoke_dispatches_packed_gemm_and_slices_qkv(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_qkv_projection_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.qkv_projection",
            "precision": "int8",
            "projection_shift": 0,
            "input": [[1, 2], [3, 4]],
            "packed_weight": [[1, 0, 0, 1, 1, 1], [0, 1, 1, 0, -1, 2]],
        }

        lowered = lower_qkv_projection_smoke(sim.runtime, graph)

        self.assertEqual(lowered.packed_accumulator, [[1, 2, 2, 1, -1, 5], [3, 4, 4, 3, -1, 11]])
        self.assertEqual(lowered.q_requantized, [[1, 2], [3, 4]])
        self.assertEqual(lowered.k_requantized, [[2, 1], [4, 3]])
        self.assertEqual(lowered.v_requantized, [[-1, 5], [-1, 11]])
        self.assertEqual(lowered.total_tile_count, 2)
        self.assertTrue(lowered.host_slices_packed_qkv)
        self.assertTrue(lowered.host_requantizes_qkv)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_conv2d_smoke_lowering_dispatches_im2col_tiles(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_conv2d_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.convolution",
            "precision": "int8",
            "input": [[[[1], [2], [3]], [[4], [5], [6]], [[7], [8], [9]]]],
            "filter": [[[[1, -1]], [[2, 0]]], [[[0, 3]], [[-1, 1]]]],
        }

        lowered = lower_conv2d_smoke(sim.runtime, graph)

        self.assertEqual(lowered.output, [[[[0, 16], [2, 19]], [[6, 25], [8, 28]]]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_materializes_im2col)
        self.assertEqual(lowered.matmul.tile_count, 2)
        self.assertEqual(lowered.matmul.abi_opcode, sim.runtime.OP_GEMM_S8)

    def test_runtime_depthwise_conv2d_smoke_dispatches_direct_scalar_macs(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_depthwise_conv2d_smoke.v1",
            "dialect": "tflite",
            "op": "tflite.depthwise_conv_2d",
            "precision": "int8",
            "data_format": "NHWC",
            "filter_format": "HWCM",
            "padding": "VALID",
            "strides": [1, 1],
            "dilations": [1, 1],
            "input": [
                [
                    [[1, 2], [3, 4], [5, 6]],
                    [[7, 8], [9, 10], [11, 12]],
                    [[13, 14], [15, 16], [17, 18]],
                ]
            ],
            "filter": [
                [[[1, -1], [2, 0]], [[0, 1], [-1, 2]]],
                [[[2, 0], [1, -2]], [[1, -1], [0, 1]]],
            ],
        }

        lowered = lower_depthwise_conv2d_smoke(sim.runtime, graph)

        expected = [[[[24, -7, 8, 2], [32, -9, 12, 4]], [[48, -13, 20, 8], [56, -15, 24, 10]]]]
        self.assertEqual(lowered.output, expected)
        self.assertEqual(lowered.output, lowered.golden)
        self.assertEqual(lowered.output_shape, [1, 2, 2, 4])
        self.assertEqual(lowered.scalar_mul_count, 64)
        self.assertEqual(lowered.scalar_add_count, 64)
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_uses_direct_depthwise_loops)
        self.assertFalse(lowered.host_materializes_im2col)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_grouped_conv2d_smoke_dispatches_direct_scalar_macs(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_grouped_conv2d_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.convolution",
            "precision": "int8",
            "data_format": "NHWC",
            "filter_format": "HWIO",
            "padding": "VALID",
            "strides": [1, 1],
            "dilations": [1, 1],
            "groups": 2,
            "input": [
                [
                    [[1, 2, 10, 20], [3, 4, 30, 40]],
                    [[5, 6, 50, 60], [7, 8, 70, 80]],
                ]
            ],
            "filter": [
                [[[1, 0, 1, 0], [0, 1, 0, 1]], [[2, -1, -1, 2], [1, 0, 1, 0]]],
                [[[0, 2, 0, -2], [-1, 1, 2, 1]], [[1, 1, 1, 1], [2, -2, -2, 2]]],
            ],
        }

        lowered = lower_grouped_conv2d_smoke(sim.runtime, graph)

        self.assertEqual(lowered.output, [[[[28, 6, 50, 270]]]])
        self.assertEqual(lowered.output, lowered.golden)
        self.assertEqual(lowered.output_shape, [1, 1, 1, 4])
        self.assertEqual(lowered.groups, 2)
        self.assertEqual(lowered.scalar_mul_count, 32)
        self.assertEqual(lowered.scalar_add_count, 32)
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_uses_direct_grouped_loops)
        self.assertFalse(lowered.host_materializes_im2col)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_silu_smoke_dispatches_exp2_piecewise_scalar_activation(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_silu_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.silu",
            "precision": "int8",
            "approximation": "exp2_q0_8_piecewise",
            "input": [[-8, -2, 0], [4, 8, 16]],
        }

        lowered = lower_silu_smoke(sim.runtime, graph)

        self.assertEqual(lowered.sigmoid_q0_8, [[0, 32, 128], [248, 256, 256]])
        self.assertEqual(lowered.output, [[0, -1, 0], [3, 8, 16]])
        self.assertEqual(lowered.output, lowered.golden)
        self.assertEqual(lowered.scalar_exp2_count, 6)
        self.assertEqual(lowered.scalar_sub_count, 4)
        self.assertEqual(lowered.scalar_mul_count, 6)
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_applies_shift_and_saturation)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_gelu_smoke_dispatches_quick_exp2_piecewise_scalar_activation(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_gelu_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.gelu",
            "precision": "int8",
            "approximation": "quick_gelu_exp2_q0_8",
            "input": [[-16, -4, 0], [4, 16, 32]],
        }

        lowered = lower_gelu_smoke(sim.runtime, graph)

        self.assertEqual(lowered.scaled_input, [[-28, -7, 0], [6, 27, 54]])
        self.assertEqual(lowered.sigmoid_q0_8, [[0, 1, 128], [254, 256, 256]])
        self.assertEqual(lowered.output, [[0, -1, 0], [3, 16, 32]])
        self.assertEqual(lowered.output, lowered.golden)
        self.assertEqual(lowered.scalar_scale_mul_count, 6)
        self.assertEqual(lowered.scalar_exp2_count, 6)
        self.assertEqual(lowered.scalar_sub_count, 4)
        self.assertEqual(lowered.scalar_gate_mul_count, 6)
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_applies_shift_and_saturation)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_attention_qk_smoke_lowering_dispatches_per_head_gemm(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_attention_qk_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.dot_general",
            "precision": "int8",
            "query": [
                [
                    [[1, -2, 3, 4], [-1, 2, -3, 5]],
                    [[2, 0, -1, 3], [4, -2, 1, -3]],
                ]
            ],
            "key": [
                [
                    [[1, 2, -1, 0], [3, -2, 1, 4], [-1, 0, 2, -3]],
                    [[0, 1, 2, -1], [-2, 3, 1, 0], [4, -1, 0, 2]],
                ]
            ],
        }

        lowered = lower_attention_qk_smoke(sim.runtime, graph)

        self.assertEqual(
            lowered.scores,
            [[[[-6, 26, -7], [6, 10, -20]], [[-5, -5, 14], [3, -13, 12]]]],
        )
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_transposes_keys)
        self.assertTrue(lowered.host_iterates_heads)
        self.assertEqual(lowered.total_tile_count, 2)
        self.assertEqual(
            [matmul.abi_opcode for matmul in lowered.matmuls], [sim.runtime.OP_GEMM_S8] * 2
        )

    def test_runtime_attention_av_smoke_lowering_dispatches_per_head_gemm(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_attention_av_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.attention_av",
            "precision": "int8",
            "attention": [[[[1, -2, 3], [-1, 4, 2]], [[2, 0, -1], [3, -2, 1]]]],
            "value": [[[[1, 2], [-3, 4], [5, -6]], [[0, 1], [2, -1], [-4, 3]]]],
        }

        lowered = lower_attention_av_smoke(sim.runtime, graph)

        self.assertEqual(lowered.context, [[[[22, -24], [-3, 2]], [[4, -1], [-8, 8]]]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_iterates_heads)
        self.assertTrue(lowered.requires_prequantized_attention)
        self.assertEqual(lowered.total_tile_count, 2)
        self.assertEqual(
            [matmul.abi_opcode for matmul in lowered.matmuls], [sim.runtime.OP_GEMM_S8] * 2
        )

    def test_runtime_attention_softmax_smoke_dispatches_scalar_exp2_path(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_attention_softmax_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.attention_softmax",
            "precision": "int8",
            "logits": [[[[4, 2, 0], [1, 0, -1]]]],
            "mask": [[[[True, True, False], [True, True, True]]]],
        }

        lowered = lower_attention_softmax_smoke(sim.runtime, graph)

        self.assertEqual(lowered.weights_q0_8, [[[[205, 51, 0], [146, 73, 37]]]])
        self.assertEqual(lowered.exp_q0_8, [[[[256, 64, 0], [256, 128, 64]]]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_applies_mask)
        self.assertTrue(lowered.host_divides_by_row_sum)
        self.assertEqual(lowered.scalar_exp_count, 5)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_attention_smoke_dispatches_qk_softmax_av(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_attention_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.attention",
            "precision": "int8",
            "query": [[[[1, 2], [3, 4]], [[-1, 2], [2, -1]]]],
            "key": [[[[1, 0], [0, 1]], [[1, 1], [-1, 1]]]],
            "value": [[[[5, 6], [7, 8]], [[-3, 4], [6, -5]]]],
            "qk_score_shift": 0,
            "attention_weight_shift": 1,
            "context_shift": 4,
        }

        lowered = lower_attention_smoke(sim.runtime, graph)

        self.assertEqual(
            lowered.attention_weights_s8,
            [[[[43, 86], [43, 86]], [[26, 103], [121, 8]]]],
        )
        self.assertEqual(
            lowered.context_requantized,
            [[[[51, 59], [51, 59]], [[33, -26], [-20, 27]]]],
        )
        self.assertEqual(lowered.total_tile_count, 4)
        self.assertTrue(lowered.computes_attention_softmax)
        self.assertFalse(lowered.requires_prequantized_attention)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_attention_smoke_dispatches_generated_causal_mask(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_attention_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.attention",
            "precision": "int8",
            "query": [[[[1, 2], [3, 4]]]],
            "key": [[[[1, 0], [0, 1]]]],
            "value": [[[[5, 6], [7, 8]]]],
            "mask_mode": "causal",
            "qk_score_shift": 0,
            "attention_weight_shift": 1,
            "context_shift": 4,
        }

        lowered = lower_attention_smoke(sim.runtime, graph)

        self.assertEqual(lowered.attention_mask, [[[[True, False], [True, True]]]])
        self.assertEqual(lowered.attention_weights_s8, [[[[127, 0], [43, 86]]]])
        self.assertEqual(lowered.context_requantized, [[[[39, 47], [51, 59]]]])
        self.assertTrue(lowered.host_generates_causal_mask)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_attention_smoke_dispatches_generated_sliding_window_mask(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_attention_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.attention",
            "precision": "int8",
            "query": [[[[1, 0], [0, 1], [1, 1]]]],
            "key": [[[[1, 0], [0, 1], [1, 1]]]],
            "value": [[[[2, 0], [0, 2], [1, 1]]]],
            "mask_mode": "sliding_window",
            "mask_window": 2,
            "qk_score_shift": 0,
            "attention_weight_shift": 1,
            "context_shift": 4,
        }

        lowered = lower_attention_smoke(sim.runtime, graph)

        self.assertEqual(
            lowered.attention_mask,
            [[[[True, False, False], [True, True, False], [False, True, True]]]],
        )
        self.assertEqual(lowered.attention_weights_s8, [[[[127, 0, 0], [43, 86, 0], [0, 43, 86]]]])
        self.assertEqual(lowered.context_requantized, [[[[15, 0], [5, 10], [5, 10]]]])
        self.assertTrue(lowered.host_generates_sliding_window_mask)
        self.assertFalse(lowered.host_generates_causal_mask)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_kv_cache_update_smoke_dispatches_scalar_copies(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_kv_cache_update_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.kv_cache_update",
            "precision": "int8",
            "key_cache": [[[[1, 2], [3, 4], [0, 0], [0, 0]]]],
            "value_cache": [[[[5, 6], [7, 8], [0, 0], [0, 0]]]],
            "new_key": [[[[9, -10], [11, -12]]]],
            "new_value": [[[[-13, 14], [15, -16]]]],
            "cache_lengths": [[2]],
        }

        lowered = lower_kv_cache_update_smoke(sim.runtime, graph)

        self.assertEqual(lowered.updated_key_cache, [[[[1, 2], [3, 4], [9, -10], [11, -12]]]])
        self.assertEqual(lowered.updated_value_cache, [[[[5, 6], [7, 8], [-13, 14], [15, -16]]]])
        self.assertEqual(lowered.cache_lengths, [[4]])
        self.assertEqual(lowered.scalar_copy_count, 8)
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_preserves_existing_cache)
        self.assertTrue(lowered.host_tracks_cache_lengths)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_decode_attention_smoke_dispatches_kv_append_and_attention(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_decode_attention_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.decode_attention",
            "precision": "int8",
            "query": [[[[1, 1]], [[2, -1]]]],
            "key_cache": [[[[1, 0], [0, 1], [0, 0], [0, 0]], [[1, 1], [0, 0], [0, 0], [0, 0]]]],
            "value_cache": [[[[5, 6], [7, 8], [0, 0], [0, 0]], [[-3, 4], [0, 0], [0, 0], [0, 0]]]],
            "new_key": [[[[2, 1]], [[-1, 1]]]],
            "new_value": [[[[9, 10]], [[6, -5]]]],
            "cache_lengths": [[2, 1]],
            "qk_score_shift": 0,
            "attention_weight_shift": 1,
            "context_shift": 4,
        }

        lowered = lower_decode_attention_smoke(sim.runtime, graph)

        self.assertEqual(lowered.updated_cache_lengths, [[3, 2]])
        self.assertEqual(lowered.attention_mask, [[[[True, True, True]], [[True, True, False]]]])
        self.assertEqual(lowered.attention.context_requantized, [[[[64, 73]], [[-20, 27]]]])
        self.assertTrue(lowered.updates_kv_cache)
        self.assertTrue(lowered.computes_attention_over_cache)
        self.assertTrue(lowered.host_materializes_cache_view)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_decode_attention_smoke_dispatches_recent_cache_window(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_decode_attention_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.decode_attention",
            "precision": "int8",
            "query": [[[[1, 1]], [[2, -1]]]],
            "key_cache": [[[[1, 0], [0, 1], [0, 0], [0, 0]], [[1, 1], [0, 0], [0, 0], [0, 0]]]],
            "value_cache": [[[[5, 6], [7, 8], [0, 0], [0, 0]], [[-3, 4], [0, 0], [0, 0], [0, 0]]]],
            "new_key": [[[[2, 1]], [[-1, 1]]]],
            "new_value": [[[[9, 10]], [[6, -5]]]],
            "cache_lengths": [[2, 1]],
            "qk_score_shift": 0,
            "attention_weight_shift": 1,
            "context_shift": 4,
            "cache_window": 2,
        }

        lowered = lower_decode_attention_smoke(sim.runtime, graph)

        self.assertEqual(lowered.updated_cache_lengths, [[3, 2]])
        self.assertEqual(lowered.max_attention_cache_length, 2)
        self.assertEqual(
            lowered.attention_key_cache_view,
            [[[[0, 1], [2, 1]], [[1, 1], [-1, 1]]]],
        )
        self.assertEqual(lowered.attention_mask, [[[[True, True]], [[True, True]]]])
        self.assertEqual(lowered.attention.context_requantized, [[[[69, 77]], [[-20, 27]]]])
        self.assertTrue(lowered.host_materializes_cache_view)
        self.assertTrue(lowered.host_applies_decode_cache_window)
        self.assertEqual(lowered.decode_cache_window, 2)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_transformer_mlp_smoke_dispatches_gemm_vrelu_gemm(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_mlp_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.transformer_mlp",
            "precision": "int8",
            "activation": "relu",
            "requant_shift": 1,
            "input": [[1, -2, 3], [-4, 5, -6]],
            "up_weight": [[2, -1, 3, 4], [-3, 2, -2, 1], [1, 0, 2, -3]],
            "down_weight": [[1, -2], [-1, 3], [2, 1], [-3, 2]],
        }

        lowered = lower_mlp_smoke(sim.runtime, graph)

        self.assertEqual(lowered.output, [[17, -4], [-16, 27]])
        self.assertEqual(lowered.hidden_activated, [[5, 0, 6, 0], [0, 7, 0, 3]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_requantizes_hidden)
        self.assertEqual(lowered.activation_opcode, "VRELU_S8")
        self.assertEqual(lowered.total_tile_count, 3)
        self.assertEqual(lowered.up_matmul.abi_opcode, sim.runtime.OP_GEMM_S8)
        self.assertEqual(lowered.down_matmul.abi_opcode, sim.runtime.OP_GEMM_S8)

    def test_runtime_swiglu_smoke_dispatches_gemm_scalar_gate_gemm(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_swiglu_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.swiglu",
            "precision": "int8",
            "activation": "linear_gate",
            "requant_shift": 0,
            "gate_shift": 3,
            "input": [[1, -2], [3, 4]],
            "up_weight": [[2, -1, 3], [-2, 1, 0]],
            "gate_weight": [[1, 2, -1], [0, -1, 3]],
            "down_weight": [[1, -2], [-3, 4], [2, 1]],
        }

        lowered = lower_swiglu_smoke(sim.runtime, graph)

        self.assertEqual(lowered.gated_hidden, [[0, -2, -3], [-1, 0, 10]])
        self.assertEqual(lowered.output, [[0, -11], [19, 12]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_requantizes_hidden)
        self.assertTrue(lowered.host_applies_gate_shift_and_saturation)
        self.assertEqual(lowered.total_tile_count, 3)
        self.assertEqual(lowered.scalar_mul_count, 6)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_swiglu_smoke_with_silu_gate_dispatches_exp2_gate_gemm(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_swiglu_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.swiglu",
            "precision": "int8",
            "activation": "silu",
            "requant_shift": 0,
            "gate_shift": 4,
            "input": [[8, 4]],
            "up_weight": [[2, 0], [0, 2]],
            "gate_weight": [[2, 0], [0, -2]],
            "down_weight": [[1, 0], [0, 1]],
        }

        lowered = lower_swiglu_smoke(sim.runtime, graph)

        self.assertEqual(lowered.gate_requantized, [[16, -8]])
        self.assertEqual(lowered.gate_activated, [[16, 0]])
        self.assertIsNotNone(lowered.gate_activation_result)
        self.assertEqual(lowered.gated_hidden, [[16, 0]])
        self.assertEqual(lowered.output, [[16, 0]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(lowered.total_tile_count, 3)
        self.assertEqual(lowered.scalar_mul_count, 2)
        self.assertIn("swiglu_s8_silu_gate_smoke_only", lowered.claim_boundary)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_residual_add_smoke_dispatches_scalar_adds(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_residual_add_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.add",
            "precision": "int8",
            "lhs": [[120, -120, 10], [-5, 64, -128]],
            "rhs": [[20, -20, -30], [-7, 80, -1]],
        }

        lowered = lower_residual_add_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result, [[127, -128, -20], [-12, 127, -128]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_saturates_int8)
        self.assertEqual(lowered.scalar_add_count, 6)

    def test_runtime_bias_add_smoke_dispatches_broadcast_scalar_adds(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_bias_add_smoke.v1",
            "dialect": "tflite",
            "op": "tflite.add",
            "precision": "int8",
            "input": [[120, -120, 10], [-5, 64, -128]],
            "bias": [20, -20, -30],
        }

        lowered = lower_bias_add_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result, [[127, -128, -20], [15, 44, -128]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_broadcasts_bias)
        self.assertTrue(lowered.host_saturates_int8)
        self.assertEqual(lowered.scalar_add_count, 6)

    def test_runtime_transformer_block_smoke_dispatches_composed_primitives(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_transformer_block_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.transformer_block",
            "precision": "int8",
            "requant_shift": 1,
            "input": [[1, -2], [3, 4]],
            "attention": [[[[1, 0], [0, 1]]]],
            "value": [[[[2, -1], [-3, 5]]]],
            "attention_bias": [1, -2],
            "mlp_up_weight": [[2, -1, 3], [-2, 1, 0]],
            "mlp_down_weight": [[1, -2], [-3, 4], [2, 1]],
        }

        lowered = lower_transformer_block_smoke(sim.runtime, graph)

        self.assertEqual(lowered.output, [[25, -17], [-6, 20]])
        self.assertEqual(lowered.post_attention_residual, [[4, -5], [1, 7]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.requires_prequantized_attention)
        self.assertEqual(lowered.total_tile_count, 3)
        self.assertEqual(lowered.scalar_add_count, 12)

    def test_runtime_modern_decoder_block_smoke_dispatches_composed_primitives(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_modern_decoder_block_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.decoder_block",
            "precision": "int8",
            "projection_shift": 0,
            "rms_epsilon": 0,
            "rms_inv_shift": 8,
            "rms_output_shift": 8,
            "rope_scale_shift": 7,
            "swiglu_requant_shift": 0,
            "swiglu_gate_shift": 6,
            "input": [[3, 4], [5, 12]],
            "norm1_weight": [64, 64],
            "norm2_weight": [64, 64],
            "q_weight": [[1, 0], [0, 1]],
            "k_weight": [[1, 0], [0, 1]],
            "v_weight": [[1, 0], [0, 1]],
            "attention": [[[[1, 0], [0, 1]]]],
            "attention_bias": [0, 0],
            "cos": [127],
            "sin": [0],
            "swiglu_up_weight": [[1, 0], [0, 1]],
            "swiglu_gate_weight": [[1, 0], [0, 1]],
            "swiglu_down_weight": [[1, 0], [0, 1]],
        }

        lowered = lower_modern_decoder_block_smoke(sim.runtime, graph)

        self.assertEqual(lowered.output, [[101, 127], [106, 127]])
        self.assertEqual(lowered.qk_scores.scores, [[[[10900, 9080], [9080, 8045]]]])
        self.assertEqual(lowered.attention_softmax.weights_q0_8, [[[[255, 1], [255, 1]]]])
        self.assertEqual(lowered.attention_context_requantized, [[62, 84], [62, 84]])
        self.assertEqual(lowered.swiglu.gated_hidden, [[36, 68], [39, 81]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.computes_qk_scores)
        self.assertTrue(lowered.computes_attention_softmax)
        self.assertFalse(lowered.requires_prequantized_attention)
        self.assertTrue(lowered.host_requantizes_qkv)
        self.assertTrue(lowered.host_requantizes_qk_scores)
        self.assertTrue(lowered.host_requantizes_attention_weights)
        self.assertEqual(lowered.total_tile_count, 8)
        self.assertEqual(lowered.scalar_mul_count, 44)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_modern_decoder_block_smoke_dispatches_packed_qkv_projection(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_modern_decoder_block_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.decoder_block",
            "precision": "int8",
            "projection_shift": 0,
            "rms_epsilon": 0,
            "rms_inv_shift": 8,
            "rms_output_shift": 8,
            "rope_scale_shift": 7,
            "swiglu_requant_shift": 0,
            "swiglu_gate_shift": 6,
            "input": [[3, 4], [5, 12]],
            "norm1_weight": [64, 64],
            "norm2_weight": [64, 64],
            "q_weight": [[1, 0], [0, 1]],
            "k_weight": [[1, 0], [0, 1]],
            "v_weight": [[1, 0], [0, 1]],
            "packed_qkv_weight": [[1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1]],
            "attention": [[[[1, 0], [0, 1]]]],
            "attention_bias": [0, 0],
            "cos": [127],
            "sin": [0],
            "swiglu_up_weight": [[1, 0], [0, 1]],
            "swiglu_gate_weight": [[1, 0], [0, 1]],
            "swiglu_down_weight": [[1, 0], [0, 1]],
        }

        lowered = lower_modern_decoder_block_smoke(sim.runtime, graph)

        self.assertIsNone(lowered.q_projection)
        self.assertIsNone(lowered.k_projection)
        self.assertIsNone(lowered.v_projection)
        self.assertIsNotNone(lowered.qkv_projection)
        self.assertEqual(lowered.q_requantized, [[63, 85], [35, 84]])
        self.assertEqual(lowered.k_requantized, [[63, 85], [35, 84]])
        self.assertEqual(lowered.v_requantized, [[63, 85], [35, 84]])
        self.assertEqual(lowered.output, [[101, 127], [106, 127]])
        self.assertEqual(lowered.total_tile_count, 7)
        self.assertTrue(lowered.host_slices_packed_qkv)
        self.assertTrue(lowered.host_requantizes_qkv)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_modern_decoder_block_smoke_dispatches_packed_qkv_silu_swiglu_gate(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_modern_decoder_block_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.decoder_block",
            "precision": "int8",
            "projection_shift": 0,
            "rms_epsilon": 0,
            "rms_inv_shift": 8,
            "rms_output_shift": 8,
            "rope_scale_shift": 7,
            "swiglu_requant_shift": 0,
            "swiglu_gate_shift": 6,
            "swiglu_activation": "silu",
            "input": [[3, 4], [5, 12]],
            "norm1_weight": [64, 64],
            "norm2_weight": [64, 64],
            "q_weight": [[1, 0], [0, 1]],
            "k_weight": [[1, 0], [0, 1]],
            "v_weight": [[1, 0], [0, 1]],
            "packed_qkv_weight": [[1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1]],
            "attention": [[[[1, 0], [0, 1]]]],
            "attention_bias": [0, 0],
            "cos": [127],
            "sin": [0],
            "swiglu_up_weight": [[1, 0], [0, 1]],
            "swiglu_gate_weight": [[1, 0], [0, 1]],
            "swiglu_down_weight": [[1, 0], [0, 1]],
        }

        lowered = lower_modern_decoder_block_smoke(sim.runtime, graph)

        self.assertIsNotNone(lowered.qkv_projection)
        self.assertTrue(lowered.host_slices_packed_qkv)
        self.assertEqual(lowered.swiglu.activation, "silu")
        self.assertIsNotNone(lowered.swiglu.gate_activation_result)
        self.assertEqual(lowered.swiglu.gate_activated, [[48, 66], [50, 72]])
        self.assertEqual(lowered.swiglu.gated_hidden, [[36, 68], [39, 81]])
        self.assertEqual(lowered.output, [[101, 127], [106, 127]])
        self.assertEqual(lowered.total_tile_count, 7)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_modern_decoder_block_smoke_dispatches_generated_causal_mask(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_modern_decoder_block_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.decoder_block",
            "precision": "int8",
            "projection_shift": 0,
            "rms_epsilon": 0,
            "rms_inv_shift": 8,
            "rms_output_shift": 8,
            "rope_scale_shift": 7,
            "swiglu_requant_shift": 0,
            "swiglu_gate_shift": 6,
            "swiglu_activation": "silu",
            "attention_mask_mode": "causal",
            "input": [[3, 4], [5, 12]],
            "norm1_weight": [64, 64],
            "norm2_weight": [64, 64],
            "q_weight": [[1, 0], [0, 1]],
            "k_weight": [[1, 0], [0, 1]],
            "v_weight": [[1, 0], [0, 1]],
            "packed_qkv_weight": [[1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1]],
            "attention": [[[[1, 0], [0, 1]]]],
            "attention_bias": [0, 0],
            "cos": [127],
            "sin": [0],
            "swiglu_up_weight": [[1, 0], [0, 1]],
            "swiglu_gate_weight": [[1, 0], [0, 1]],
            "swiglu_down_weight": [[1, 0], [0, 1]],
        }

        lowered = lower_modern_decoder_block_smoke(sim.runtime, graph)

        self.assertEqual(lowered.attention_softmax.mask, [[[[True, False], [True, True]]]])
        self.assertTrue(lowered.host_generates_causal_mask)
        self.assertTrue(lowered.host_slices_packed_qkv)
        self.assertEqual(lowered.swiglu.activation, "silu")
        self.assertEqual(lowered.output, [[101, 127], [106, 127]])
        self.assertEqual(lowered.total_tile_count, 7)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_modern_decoder_block_smoke_dispatches_generated_sliding_window_mask(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_modern_decoder_block_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.decoder_block",
            "precision": "int8",
            "projection_shift": 0,
            "rms_epsilon": 0,
            "rms_inv_shift": 8,
            "rms_output_shift": 8,
            "rope_scale_shift": 7,
            "swiglu_requant_shift": 0,
            "swiglu_gate_shift": 6,
            "swiglu_activation": "silu",
            "attention_mask_mode": "sliding_window",
            "attention_mask_window": 1,
            "input": [[3, 4], [5, 12]],
            "norm1_weight": [64, 64],
            "norm2_weight": [64, 64],
            "q_weight": [[1, 0], [0, 1]],
            "k_weight": [[1, 0], [0, 1]],
            "v_weight": [[1, 0], [0, 1]],
            "packed_qkv_weight": [[1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1]],
            "attention": [[[[1, 0], [0, 1]]]],
            "attention_bias": [0, 0],
            "cos": [127],
            "sin": [0],
            "swiglu_up_weight": [[1, 0], [0, 1]],
            "swiglu_gate_weight": [[1, 0], [0, 1]],
            "swiglu_down_weight": [[1, 0], [0, 1]],
        }

        lowered = lower_modern_decoder_block_smoke(sim.runtime, graph)

        self.assertEqual(lowered.attention_softmax.mask, [[[[True, False], [False, True]]]])
        self.assertTrue(lowered.host_generates_sliding_window_mask)
        self.assertFalse(lowered.host_generates_causal_mask)
        self.assertTrue(lowered.host_slices_packed_qkv)
        self.assertEqual(lowered.swiglu.activation, "silu")
        self.assertEqual(lowered.output, [[101, 127], [52, 127]])
        self.assertEqual(lowered.total_tile_count, 7)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_rope_smoke_dispatches_scalar_arithmetic(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_rope_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.rope",
            "precision": "int8",
            "scale_shift": 7,
            "input": [[64, 0, 32, -32], [10, 20, -30, 40]],
            "cos": [127, 90],
            "sin": [0, 90],
        }

        lowered = lower_rope_smoke(sim.runtime, graph)

        self.assertEqual(lowered.output, [[63, 0, 45, 0], [9, 19, -50, 7]])
        self.assertEqual(lowered.golden, lowered.output)
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.host_applies_shift_and_saturation)
        self.assertEqual(lowered.scalar_mul_count, 16)
        self.assertEqual(lowered.scalar_add_count, 8)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_rmsnorm_smoke_dispatches_scalar_arithmetic(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_rmsnorm_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.rms_norm",
            "precision": "int8",
            "epsilon": 0,
            "inv_rms_shift": 8,
            "output_shift": 8,
            "input": [[3, 4], [5, 12]],
            "weight": [64, 64],
        }

        lowered = lower_rmsnorm_smoke(sim.runtime, graph)

        self.assertEqual(lowered.output, [[63, 85], [35, 84]])
        self.assertEqual(lowered.golden, lowered.output)
        self.assertEqual(lowered.row_sum_squares, [25, 169])
        self.assertTrue(lowered.host_computes_reciprocal_rms)
        self.assertTrue(lowered.host_applies_shift_and_saturation)
        self.assertEqual(lowered.scalar_mul_count, 12)
        self.assertEqual(lowered.scalar_add_count, 4)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_sparse_dot_s4_matches_golden(self):
        sim = E1NpuMmioSim()
        nonzero_weights = [7, -3, 5, -6]
        dense_values = [1, -2, 3, -4, 5, -6, 7, -8]
        positions = [0, 2, 1, 3]

        self.assertEqual(
            sim.runtime.sdot4_s4_2_4(nonzero_weights, dense_values, positions),
            golden_sdot4_s4_2_4(nonzero_weights, dense_values, positions),
        )
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_sparse_int4_matmul_smoke_dispatches_sdot4_chunks(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_sparse_int4_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.sparse_2_4_matmul",
            "precision": "sparse_int4",
            "lhs": [
                [1, -2, 3, -4, 5, -6, 7, -8, 1, 2],
                [7, 6, 5, 4, 3, 2, 1, 0, -1, -2],
            ],
            "rhs_nonzero": [
                [[2, -3, 4, -5], [-1, 3, -2, 6]],
                [[7, -8, 1, -2], [4, -3, 2, -1]],
            ],
            "rhs_positions": [
                [[0, 2, 1, 3], [1, 3, 0, 2]],
                [[0, 1, 2, 3], [0, 2, 1, 3]],
            ],
        }

        lowered = lower_sparse_int4_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result, [[0, 26], [16, 2]])
        self.assertEqual(lowered.golden, lowered.result)
        self.assertEqual(lowered.sdot4_count, 8)
        self.assertTrue(lowered.host_pads_k_to_sparse_blocks)
        self.assertTrue(lowered.host_uses_2_4_metadata)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_group_scaled_int4_matmul_smoke_dispatches_scalar_scale_path(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_group_scaled_int4_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.group_scaled_int4_matmul",
            "precision": "int4_group_scaled",
            "group_size": 2,
            "lhs": [[2, -3, 4, 1], [-1, 5, -2, 3]],
            "rhs": [[3, -2], [-4, 1], [2, 7], [-1, -3]],
            "scales_q8_8": [[128, 256], [64, -128]],
        }

        lowered = lower_group_scaled_int4_matmul_smoke(sim.runtime, graph)

        self.assertEqual(
            lowered.group_dot_products,
            [[[18, 7], [-7, 25]], [[-23, -7], [7, -23]]],
        )
        self.assertEqual(lowered.result_q8_8, [[2752, -4992], [-3392, 4736]])
        self.assertEqual(lowered.golden_q8_8, lowered.result_q8_8)
        self.assertEqual(lowered.scalar_mul_count, 24)
        self.assertEqual(lowered.scalar_add_count, 24)
        self.assertTrue(lowered.host_applies_group_scales)
        self.assertTrue(lowered.host_uses_q8_8_scales)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_dot16_s2_matches_golden(self):
        sim = E1NpuMmioSim()
        a = [1, -1, -2, 0, 1, 1, -2, -1, 0, 1, -1, -2, 1, 0, -2, 1]
        b = [-2, 1, 1, -1, 1, -2, 0, -1, 1, 1, -2, -1, 0, -2, 1, 1]

        self.assertEqual(sim.runtime.dot16_s2(a, b, acc=5), golden_dot16_s2(a, b, acc=5))
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_int2_matmul_smoke_dispatches_dot16_chunks(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_int2_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "eliza.bitnet_matmul",
            "precision": "bitnet_int2",
            "lhs": [
                [1, -1, -2, 0, 1, 1, -2, -1, 0, 1, -1, -2, 1, 0, -2, 1, -1],
                [-2, 1, 0, -1, 1, -2, 1, 0, -1, 1, 1, -2, 0, -2, 1, 1, -2],
            ],
            "rhs": [
                [1, -2],
                [-1, 1],
                [0, 1],
                [1, -1],
                [-2, 1],
                [1, 0],
                [1, -2],
                [-1, 1],
                [0, -1],
                [1, 1],
                [-2, -1],
                [1, 0],
                [-1, 1],
                [0, -2],
                [1, 1],
                [-2, -1],
                [1, 0],
            ],
        }

        lowered = lower_int2_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result, [[-5, -1], [-13, 10]])
        self.assertEqual(lowered.golden, lowered.result)
        self.assertEqual(lowered.dot16_count, 8)
        self.assertTrue(lowered.host_pads_k_to_dot16)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_dot4_fp8_e4m3_matches_golden(self):
        sim = E1NpuMmioSim()
        a = [0x38, 0xBC, 0x30, 0x40]
        b = [0x40, 0xB8, 0x28, 0xB0]

        self.assertEqual(
            sim.runtime.dot4_fp8_e4m3(a, b, acc_q8_8=64),
            golden_dot4_fp8_e4m3(a, b, acc_q8_8=64),
        )
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_fp8_matmul_smoke_dispatches_dot4_chunks(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_fp8_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.dot_general",
            "precision": "fp8_e4m3",
            "lhs": [
                [0x38, 0x40, 0xB8, 0x30, 0x00],
                [0xBC, 0x28, 0x38, 0x00, 0x40],
            ],
            "rhs": [
                [0x40, 0x38],
                [0xB8, 0x40],
                [0x30, 0xB8],
                [0x38, 0x00],
                [0x40, 0x28],
            ],
        }

        lowered = lower_fp8_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.result_q8_8, [[0, 1536], [320, -384]])
        self.assertEqual(lowered.golden_q8_8, lowered.result_q8_8)
        self.assertEqual(lowered.dot4_count, 8)
        self.assertTrue(lowered.host_pads_k_to_dot4)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_fp16_matmul_smoke_dispatches_scalar_q8_8_path(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_fp16_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.dot_general",
            "precision": "fp16",
            "lhs": [[0x3C00, 0x4000], [0x3800, 0xBC00]],
            "rhs": [[0x4000, 0xBC00], [0x3800, 0x3E00]],
        }

        lowered = lower_fp16_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.lhs_q8_8, [[256, 512], [128, -256]])
        self.assertEqual(lowered.rhs_q8_8, [[512, -256], [128, 384]])
        self.assertEqual(lowered.result_q8_8, [[768, 512], [128, -512]])
        self.assertEqual(lowered.golden_q8_8, lowered.result_q8_8)
        self.assertEqual(lowered.scalar_mul_count, 8)
        self.assertEqual(lowered.scalar_add_count, 8)
        self.assertTrue(lowered.host_converts_float16_to_q8_8)
        self.assertTrue(lowered.host_requantizes_products)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_bf16_matmul_smoke_dispatches_scalar_q8_8_path(self):
        sim = E1NpuMmioSim()
        graph = {
            "schema": "eliza.e1_npu_bf16_matmul_smoke.v1",
            "dialect": "stablehlo",
            "op": "stablehlo.dot_general",
            "precision": "bf16",
            "lhs": [[0x3F80, 0x4000], [0x3F00, 0xBF80]],
            "rhs": [[0x4000, 0xBF80], [0x3F00, 0x3FC0]],
        }

        lowered = lower_bf16_matmul_smoke(sim.runtime, graph)

        self.assertEqual(lowered.lhs_q8_8, [[256, 512], [128, -256]])
        self.assertEqual(lowered.rhs_q8_8, [[512, -256], [128, 384]])
        self.assertEqual(lowered.result_q8_8, [[768, 512], [128, -512]])
        self.assertEqual(lowered.golden_q8_8, lowered.result_q8_8)
        self.assertEqual(lowered.scalar_mul_count, 8)
        self.assertEqual(lowered.scalar_add_count, 8)
        self.assertTrue(lowered.host_converts_float16_to_q8_8)
        self.assertTrue(lowered.host_requantizes_products)
        self.assertFalse(lowered.cpu_fallback)
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_rejects_tiles_outside_local_prototype_limits(self):
        sim = E1NpuMmioSim()
        with self.assertRaisesRegex(ValueError, "prototype limits"):
            sim.runtime.gemm_s8(
                [[1, 2, 3, 4, 5, 6, 7, 8]], [[1], [1], [1], [1], [1], [1], [1], [1]]
            )

    def test_runtime_vrelu_s8_matches_golden_and_reports_perf(self):
        sim = E1NpuMmioSim()
        values = [-128, -3, 0, 5, 127, -1]

        self.assertEqual(sim.runtime.vrelu_s8(values), golden_vrelu_s8(values))
        self.assertEqual(sim.runtime.perf()["cycles"], len(values))
        self.assertEqual(sim.runtime.perf()["unsupported_ops"], 0)

    def test_runtime_descriptor_submission_updates_descriptor_counters(self):
        sim = E1NpuMmioSim()

        status = sim.runtime.submit_descriptors(
            NpuDescriptorSubmission(base=0x2000, head=0, tail=1)
        )
        counters = sim.runtime.descriptor_counters()

        self.assertTrue(status.ok)
        self.assertEqual(status.desc_status, sim.runtime.DESC_STATUS_DONE)
        self.assertEqual(counters["status"], sim.runtime.DESC_STATUS_DONE)
        self.assertEqual(counters["bytes_read"], 16)
        self.assertEqual(counters["bytes_written"], 0)
        self.assertEqual(counters["read_beats"], 1)
        self.assertEqual(counters["write_beats"], 0)

    def test_runtime_stream_descriptor_word0_sets_owner_and_writeback_bits(self):
        word0 = E1NpuRuntime.pack_stream_descriptor_word0(
            E1NpuRuntime.OP_GEMM_S8,
            0,
            12,
            writeback_request=True,
        )

        self.assertTrue(word0 & E1NpuRuntime.DESC_FLAG_VALID_OWNER)
        self.assertTrue(word0 & E1NpuRuntime.DESC_FLAG_WRITEBACK_REQUEST)
        self.assertTrue(word0 & E1NpuRuntime.DESC_FLAG_STREAM_TO_SCRATCH)


if __name__ == "__main__":
    unittest.main()
