#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e1_npu_lowering import (
    lower_attention_av_smoke,
    lower_attention_qk_smoke,
    lower_attention_softmax_smoke,
    lower_bias_add_smoke,
    lower_conv2d_smoke,
    lower_matmul_smoke,
    lower_mlp_smoke,
    lower_modern_decoder_block_smoke,
    lower_residual_add_smoke,
    lower_rmsnorm_smoke,
    lower_rope_smoke,
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

        self.assertEqual(lowered.output, [[103, 127], [54, 127]])
        self.assertEqual(lowered.qk_scores.scores, [[[[10900, 9080], [9080, 8045]]]])
        self.assertEqual(lowered.swiglu.gated_hidden, [[37, 68], [14, 81]])
        self.assertFalse(lowered.cpu_fallback)
        self.assertTrue(lowered.computes_qk_scores)
        self.assertTrue(lowered.requires_prequantized_attention)
        self.assertTrue(lowered.host_requantizes_qkv)
        self.assertEqual(lowered.total_tile_count, 8)
        self.assertEqual(lowered.scalar_mul_count, 44)
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

    def test_runtime_dot16_s2_matches_golden(self):
        sim = E1NpuMmioSim()
        a = [1, -1, -2, 0, 1, 1, -2, -1, 0, 1, -1, -2, 1, 0, -2, 1]
        b = [-2, 1, 1, -1, 1, -2, 0, -1, 1, 1, -2, -1, 0, -2, 1, 1]

        self.assertEqual(sim.runtime.dot16_s2(a, b, acc=5), golden_dot16_s2(a, b, acc=5))
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
