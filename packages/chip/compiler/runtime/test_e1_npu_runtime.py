import pytest
from e1_npu_lowering import (
    NpuLoweringError,
    lower_attention_av_smoke,
    lower_attention_qk_smoke,
    lower_attention_smoke,
    lower_attention_softmax_smoke,
    lower_batch_matmul_smoke,
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
    lower_stablehlo_module_smoke,
    lower_swiglu_smoke,
    lower_transformer_block_smoke,
)
from e1_npu_runtime import (
    E1NpuRuntime,
    NpuDescriptorSubmission,
    NpuRuntimeError,
    NpuStreamDescriptor,
    NpuTimeoutError,
    golden_dot4_fp8_e4m3,
    golden_dot16_s2,
    golden_exp2_neg_q0_8,
    golden_gemm_s4,
    golden_gemm_s8,
    golden_relu4_s8,
    golden_sdot4_s4_2_4,
    golden_vrelu_s8,
)
from e1_npu_stablehlo import materialize_module_lowering_graphs, parse_module


class FakeMmio:
    def __init__(self):
        self.regs = {}
        self.reads = []
        self.writes = []

    def read32(self, addr):
        self.reads.append(addr)
        return self.regs.get(addr, 0)

    def write32(self, addr, value):
        self.writes.append((addr, value & 0xFFFF_FFFF))
        self.regs[addr] = value & 0xFFFF_FFFF


class CommandCompletingMmio(FakeMmio):
    def __init__(self, runtime_cls=E1NpuRuntime):
        super().__init__()
        self.runtime_cls = runtime_cls
        self.commands = []

    @staticmethod
    def _s32(value):
        value &= 0xFFFF_FFFF
        return value - 0x1_0000_0000 if value & 0x8000_0000 else value

    @staticmethod
    def _s16(value):
        value &= 0xFFFF
        return value - 0x1_0000 if value & 0x8000 else value

    @staticmethod
    def _s8(value):
        value &= 0xFF
        return value - 0x100 if value & 0x80 else value

    @staticmethod
    def _s4(value):
        value &= 0xF
        return value - 0x10 if value & 0x8 else value

    @staticmethod
    def _s2(value):
        value &= 0x3
        return value - 0x4 if value & 0x2 else value

    @staticmethod
    def _fp8_e4m3_to_q8_8(value):
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

    def write32(self, addr, value):
        super().write32(addr, value)
        if addr == self.runtime_cls.CTRL_STATUS and (value & 0x1):
            self._complete_command()

    def _complete_command(self):
        opcode = self.regs.get(self.runtime_cls.OPCODE, 0)
        self.commands.append(opcode)
        if opcode == self.runtime_cls.OP_ADD:
            result = self.regs.get(self.runtime_cls.OP_A, 0) + self.regs.get(
                self.runtime_cls.OP_B, 0
            )
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_SUB:
            result = self.regs.get(self.runtime_cls.OP_A, 0) - self.regs.get(
                self.runtime_cls.OP_B, 0
            )
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_MUL_LO:
            result = self.regs.get(self.runtime_cls.OP_A, 0) * self.regs.get(
                self.runtime_cls.OP_B, 0
            )
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_MAX_U32:
            self.regs[self.runtime_cls.RESULT] = max(
                self.regs.get(self.runtime_cls.OP_A, 0),
                self.regs.get(self.runtime_cls.OP_B, 0),
            )
        elif opcode == self.runtime_cls.OP_MIN_U32:
            self.regs[self.runtime_cls.RESULT] = min(
                self.regs.get(self.runtime_cls.OP_A, 0),
                self.regs.get(self.runtime_cls.OP_B, 0),
            )
        elif opcode == self.runtime_cls.OP_MAC_S16:
            a = self._s16(self.regs.get(self.runtime_cls.OP_A, 0))
            b = self._s16(self.regs.get(self.runtime_cls.OP_B, 0))
            result = self._s32(self.regs.get(self.runtime_cls.ACC, 0)) + a * b
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_DOT4_S8:
            a = self.regs.get(self.runtime_cls.OP_A, 0)
            b = self.regs.get(self.runtime_cls.OP_B, 0)
            acc = self._s32(self.regs.get(self.runtime_cls.ACC, 0))
            result = acc + sum(
                self._s8(a >> (8 * index)) * self._s8(b >> (8 * index)) for index in range(4)
            )
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_RELU4_S8:
            a = self.regs.get(self.runtime_cls.OP_A, 0)
            result = 0
            for index in range(4):
                result |= (max(0, self._s8(a >> (8 * index))) & 0xFF) << (8 * index)
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_SDOT4_S4_2_4:
            weights = self.regs.get(self.runtime_cls.OP_A, 0)
            dense = self.regs.get(self.runtime_cls.OP_B, 0)
            metadata = self.regs.get(self.runtime_cls.ACC, 0)
            result = 0
            for index in range(4):
                position = (metadata >> (2 * index)) & 0x3
                dense_lane = (index // 2) * 4 + position
                result += self._s4(weights >> (4 * index)) * self._s4(dense >> (4 * dense_lane))
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_DOT16_S2:
            a = self.regs.get(self.runtime_cls.OP_A, 0)
            b = self.regs.get(self.runtime_cls.OP_B, 0)
            result = self._s32(self.regs.get(self.runtime_cls.ACC, 0))
            for index in range(16):
                result += self._s2(a >> (2 * index)) * self._s2(b >> (2 * index))
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_DOT4_FP8_E4M3:
            a = self.regs.get(self.runtime_cls.OP_A, 0)
            b = self.regs.get(self.runtime_cls.OP_B, 0)
            result = self._s32(self.regs.get(self.runtime_cls.ACC, 0))
            for index in range(4):
                result += (
                    self._fp8_e4m3_to_q8_8(a >> (8 * index))
                    * self._fp8_e4m3_to_q8_8(b >> (8 * index))
                ) >> 8
            self.regs[self.runtime_cls.RESULT] = result & 0xFFFF_FFFF
        elif opcode == self.runtime_cls.OP_EXP2_NEG_Q0_8:
            delta = self._s8(self.regs.get(self.runtime_cls.OP_A, 0))
            self.regs[self.runtime_cls.RESULT] = golden_exp2_neg_q0_8(min(0, delta))
        elif opcode in (self.runtime_cls.OP_GEMM_S8, self.runtime_cls.OP_GEMM_S4):
            self._complete_gemm()
        elif opcode == self.runtime_cls.OP_VRELU_S8:
            self._complete_vrelu()
        else:
            self.regs[self.runtime_cls.CTRL_STATUS] = 0x4
            return
        self.regs[self.runtime_cls.CTRL_STATUS] = 0x2

    def _read_scratch_byte(self, offset):
        word = self.regs.get(self.runtime_cls.SCRATCH + (offset & ~0x3), 0)
        return (word >> (8 * (offset & 0x3))) & 0xFF

    def _read_scratch_s4(self, offset):
        byte = self._read_scratch_byte(offset // 2)
        value = (byte >> 4) & 0xF if offset & 1 else byte & 0xF
        return value - 0x10 if value & 0x8 else value

    def _write_scratch_i32(self, offset, value):
        self.regs[self.runtime_cls.SCRATCH + offset] = value & 0xFFFF_FFFF

    def _write_scratch_byte(self, offset, value):
        word_addr = self.runtime_cls.SCRATCH + (offset & ~0x3)
        shift = 8 * (offset & 0x3)
        mask = 0xFF << shift
        word = self.regs.get(word_addr, 0)
        self.regs[word_addr] = (word & ~mask) | ((value & 0xFF) << shift)

    def _complete_gemm(self):
        cfg = self.regs.get(self.runtime_cls.GEMM_CFG, 0)
        base = self.regs.get(self.runtime_cls.GEMM_BASE, 0)
        stride = self.regs.get(self.runtime_cls.GEMM_STRIDE, 0)
        m = cfg & 0xFF
        n = (cfg >> 8) & 0xFF
        k = (cfg >> 16) & 0xFF
        a_base = base & 0xFF
        b_base = (base >> 8) & 0xFF
        c_base = (base >> 16) & 0xFF
        a_stride = stride & 0xFF
        b_stride = (stride >> 8) & 0xFF
        c_stride = (stride >> 16) & 0xFF
        macs = 0
        for row in range(m):
            for col in range(n):
                acc = 0
                for kk in range(k):
                    if self.regs.get(self.runtime_cls.OPCODE, 0) == self.runtime_cls.OP_GEMM_S4:
                        a = self._read_scratch_s4(a_base + row * a_stride + kk)
                        b = self._read_scratch_s4(b_base + kk * b_stride + col)
                    else:
                        a = self._s8(self._read_scratch_byte(a_base + row * a_stride + kk))
                        b = self._s8(self._read_scratch_byte(b_base + kk * b_stride + col))
                    acc += a * b
                    macs += 1
                self._write_scratch_i32(c_base + row * c_stride + col * 4, acc)
        self.regs[self.runtime_cls.PERF_CYCLES] = (
            self.regs.get(self.runtime_cls.PERF_CYCLES, 0) + macs
        )
        self.regs[self.runtime_cls.PERF_MACS] = self.regs.get(self.runtime_cls.PERF_MACS, 0) + macs

    def _complete_vrelu(self):
        length = self.regs.get(self.runtime_cls.GEMM_CFG, 0) & 0x3F
        base = self.regs.get(self.runtime_cls.GEMM_BASE, 0)
        src_base = base & 0x3F
        dst_base = (base >> 8) & 0x3F
        if (
            length == 0
            or src_base + length > self.runtime_cls.SCRATCH_BYTES
            or dst_base + length > self.runtime_cls.SCRATCH_BYTES
        ):
            self.regs[self.runtime_cls.CTRL_STATUS] = 0x4
            return
        for index in range(length):
            value = self._s8(self._read_scratch_byte(src_base + index))
            self._write_scratch_byte(dst_base + index, max(0, value))
        self.regs[self.runtime_cls.PERF_CYCLES] = (
            self.regs.get(self.runtime_cls.PERF_CYCLES, 0) + length
        )


class RejectingMmio(FakeMmio):
    def write32(self, addr, value):
        super().write32(addr, value)
        if addr == E1NpuRuntime.CTRL_STATUS and (value & 0x1):
            self.regs[E1NpuRuntime.CTRL_STATUS] = 0x4


class DescriptorDoneWithoutProofMmio(FakeMmio):
    def write32(self, addr, value):
        super().write32(addr, value)
        if addr == E1NpuRuntime.CTRL_STATUS and (value & 0x1):
            self.regs[E1NpuRuntime.CTRL_STATUS] = 0x2
            self.regs[E1NpuRuntime.DESC_STATUS] = 0


class DescriptorCompletingMmio(FakeMmio):
    def write32(self, addr, value):
        super().write32(addr, value)
        if addr == E1NpuRuntime.CTRL_STATUS and (value & 0x1):
            self.regs[E1NpuRuntime.CTRL_STATUS] = 0x2
            self.regs[E1NpuRuntime.DESC_STATUS] = E1NpuRuntime.DESC_STATUS_DONE
            self.regs[E1NpuRuntime.DESC_TAIL] = self.regs.get(E1NpuRuntime.DESC_HEAD, 0)


def make_runtime():
    mmio = FakeMmio()
    return E1NpuRuntime(mmio.read32, mmio.write32), mmio


def make_completing_runtime():
    mmio = CommandCompletingMmio()
    return E1NpuRuntime(mmio.read32, mmio.write32), mmio


def test_scratch_write_only_touches_overlapped_words_and_preserves_bytes():
    runtime, mmio = make_runtime()
    mmio.regs[runtime.SCRATCH + 0] = 0x11223344
    mmio.regs[runtime.SCRATCH + 4] = 0x55667788
    mmio.regs[runtime.SCRATCH + 8] = 0x99AABBCC

    runtime.write_scratch(3, bytes([0xDE, 0xAD, 0xBE]))

    assert mmio.reads == [runtime.SCRATCH + 0, runtime.SCRATCH + 4]
    assert mmio.writes == [
        (runtime.SCRATCH + 0, 0xDE223344),
        (runtime.SCRATCH + 4, 0x5566BEAD),
    ]
    assert mmio.regs[runtime.SCRATCH + 8] == 0x99AABBCC


def test_scratch_read_only_touches_overlapped_words():
    runtime, mmio = make_runtime()
    mmio.regs[runtime.SCRATCH + 4] = 0x04030201
    mmio.regs[runtime.SCRATCH + 8] = 0x08070605

    assert runtime.read_scratch(6, 4) == bytes([0x03, 0x04, 0x05, 0x06])
    assert mmio.reads == [runtime.SCRATCH + 4, runtime.SCRATCH + 8]


@pytest.mark.parametrize(
    ("method", "args"),
    [
        ("write_scratch", (-1, b"x")),
        ("write_scratch", (64, b"x")),
        ("read_scratch", (-1, 1)),
        ("read_scratch", (63, 2)),
    ],
)
def test_scratch_accesses_fail_closed_outside_64_byte_window(method, args):
    runtime, mmio = make_runtime()

    with pytest.raises(ValueError, match="64-byte NPU scratchpad"):
        getattr(runtime, method)(*args)

    assert mmio.reads == []
    assert mmio.writes == []


def test_golden_gemm_s8_reference_model():
    assert golden_gemm_s8([[1, -2, 3], [4, 5, -6]], [[7, -8], [9, 10], [-11, 12]]) == [
        [-44, 8],
        [139, -54],
    ]


def test_golden_gemm_s4_reference_model():
    assert golden_gemm_s4([[7, -8, 3], [-4, 5, -6]], [[-7, 6], [5, -4], [3, -2]]) == [
        [-80, 68],
        [35, -32],
    ]


def test_golden_sparse_s4_reference_model():
    assert golden_sdot4_s4_2_4([7, -3, 5, -6], [1, -2, 3, -4, 5, -6, 7, -8], [0, 2, 1, 3]) == 16


def test_golden_dot16_s2_reference_model():
    a = [1, -1, -2, 0, 1, 1, -2, -1, 0, 1, -1, -2, 1, 0, -2, 1]
    b = [-2, 1, 1, -1, 1, -2, 0, -1, 1, 1, -2, -1, 0, -2, 1, 1]

    assert golden_dot16_s2(a, b, acc=5) == 4


def test_golden_dot4_fp8_e4m3_reference_model():
    assert golden_dot4_fp8_e4m3([0x38, 0xBC, 0x30, 0x40], [0x40, 0xB8, 0x28, 0xB0], 64) == 736


def test_golden_activation_reference_models():
    assert golden_relu4_s8([-128, -1, 0, 7]) == [0, 0, 0, 7]
    assert golden_vrelu_s8([-3, 2, -1, 9, 0]) == [0, 2, 0, 9, 0]


def test_scalar_commands_program_mmio_and_return_completed_results():
    runtime, mmio = make_completing_runtime()

    assert runtime.add(0xFFFF_FFFE, 5) == 3
    assert runtime.sub(2, 5) == 0xFFFF_FFFD
    assert runtime.mul_lo(0x1_0001, 0x1_0001) == 0x0002_0001
    assert runtime.mac_s16(0xFFFF, 3, 10) == 7
    assert runtime.dot4_s8(0x04_03_FE_01, 0xFD_02_05_06, 1) == (1 + 6 - 10 + 6 - 12) & 0xFFFF_FFFF
    assert runtime.sdot4_s4_2_4([7, -3, 5, -6], [1, -2, 3, -4, 5, -6, 7, -8], [0, 2, 1, 3]) == 16
    assert (
        runtime.dot16_s2(
            [1, -1, -2, 0, 1, 1, -2, -1, 0, 1, -1, -2, 1, 0, -2, 1],
            [-2, 1, 1, -1, 1, -2, 0, -1, 1, 1, -2, -1, 0, -2, 1, 1],
            acc=5,
        )
        == 4
    )
    assert runtime.dot4_fp8_e4m3([0x38, 0xBC, 0x30, 0x40], [0x40, 0xB8, 0x28, 0xB0], 64) == 736
    assert runtime.max_u32(7, 11) == 11
    assert runtime.min_u32(7, 11) == 7
    assert runtime.exp2_neg_q0_8(0) == 256
    assert runtime.exp2_neg_q0_8(-3) == 32
    assert runtime.relu4_s8([-128, -1, 0, 7]) == [0, 0, 0, 7]

    assert mmio.commands == [
        runtime.OP_ADD,
        runtime.OP_SUB,
        runtime.OP_MUL_LO,
        runtime.OP_MAC_S16,
        runtime.OP_DOT4_S8,
        runtime.OP_SDOT4_S4_2_4,
        runtime.OP_DOT16_S2,
        runtime.OP_DOT4_FP8_E4M3,
        runtime.OP_MAX_U32,
        runtime.OP_MIN_U32,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_RELU4_S8,
    ]
    assert (runtime.CTRL_STATUS, 2) in mmio.writes
    assert (runtime.CTRL_STATUS, 1) in mmio.writes


def test_scalar_command_reject_and_timeout_paths_fail_closed():
    mmio = RejectingMmio()
    runtime = E1NpuRuntime(mmio.read32, mmio.write32)
    with pytest.raises(NpuRuntimeError, match="rejected"):
        runtime.add(1, 2)

    runtime, mmio = make_runtime()
    with pytest.raises(NpuTimeoutError, match="did not complete") as exc_info:
        runtime.run(runtime.OP_ADD, 1, 2, timeout_polls=3)
    assert exc_info.value.status.error == "timeout"
    assert exc_info.value.status.polls == 3


def test_descriptor_submission_programs_queue_registers_and_reports_reject_status():
    mmio = RejectingMmio()
    runtime = E1NpuRuntime(mmio.read32, mmio.write32)

    with pytest.raises(NpuRuntimeError, match="descriptor submission rejected") as exc_info:
        runtime.submit_descriptors(NpuDescriptorSubmission(base=0x2000, head=0, tail=1))

    assert (runtime.DESC_BASE, 0x2000) in mmio.writes
    assert (runtime.DESC_HEAD, 0) in mmio.writes
    assert (runtime.DESC_TAIL, 1) in mmio.writes
    assert (runtime.CMD_PARAM, 1) in mmio.writes
    assert exc_info.value.status.error == "rejected"
    assert exc_info.value.status.desc_status == 0


def test_descriptor_submission_rejects_invalid_requests_before_mmio():
    runtime, mmio = make_runtime()

    with pytest.raises(ValueError, match="aligned uint32"):
        runtime.submit_descriptors(NpuDescriptorSubmission(base=0x2002, head=0, tail=1))
    with pytest.raises(ValueError, match="at least one"):
        runtime.submit_descriptors(NpuDescriptorSubmission(base=0x2000, head=2, tail=2))
    with pytest.raises(ValueError, match="3-bit queue window"):
        runtime.submit_descriptors(NpuDescriptorSubmission(base=0x2000, head=0, tail=8))

    assert mmio.writes == []


def test_descriptor_submission_accepts_hardware_completion_proof():
    mmio = DescriptorCompletingMmio()
    runtime = E1NpuRuntime(mmio.read32, mmio.write32)

    status = runtime.submit_descriptors(NpuDescriptorSubmission(base=0x2000, head=3, tail=1))

    assert status.ok
    assert status.desc_status == runtime.DESC_STATUS_DONE
    assert mmio.regs[runtime.DESC_TAIL] == 3


def test_descriptor_submission_requires_descriptor_completion_proof():
    mmio = DescriptorDoneWithoutProofMmio()
    runtime = E1NpuRuntime(mmio.read32, mmio.write32)

    with pytest.raises(NpuRuntimeError, match="descriptor submission failed") as exc_info:
        runtime.submit_descriptors(NpuDescriptorSubmission(base=0x2000, head=0, tail=1))

    assert exc_info.value.status.status == 0x2
    assert exc_info.value.status.desc_status == 0


def test_stream_descriptor_word0_packing_and_validation():
    word0 = E1NpuRuntime.pack_stream_descriptor_word0(E1NpuRuntime.OP_GEMM_S8, 0, 12)

    assert word0 == (
        E1NpuRuntime.DESC_FLAG_VALID_OWNER | E1NpuRuntime.OP_GEMM_S8 | (1 << 8) | (12 << 24)
    )
    assert (
        E1NpuRuntime.pack_stream_descriptor_word0(
            E1NpuRuntime.OP_GEMM_S8,
            0,
            12,
            writeback_request=True,
        )
        & E1NpuRuntime.DESC_FLAG_WRITEBACK_REQUEST
    )
    assert NpuStreamDescriptor(
        E1NpuRuntime.OP_GEMM_S8,
        source_addr=0x8000_0200,
        scratch_offset=0,
        byte_count=12,
    ).words() == (word0, 0x8000_0200, 0, 0)
    with pytest.raises(ValueError, match="scratch offset"):
        E1NpuRuntime.pack_stream_descriptor_word0(E1NpuRuntime.OP_GEMM_S8, 2, 12)
    with pytest.raises(ValueError, match="byte count"):
        E1NpuRuntime.pack_stream_descriptor_word0(E1NpuRuntime.OP_GEMM_S8, 0, 13)


def test_descriptor_counters_expose_read_writeback_boundary():
    runtime, mmio = make_runtime()
    mmio.regs.update(
        {
            runtime.DESC_STATUS: runtime.DESC_STATUS_DONE,
            runtime.DESC_HEAD: 3,
            runtime.DESC_TAIL: 3,
            runtime.DESC_TIMEOUT_COUNT: 0,
            runtime.DESC_BYTES_READ: 28,
            runtime.DESC_BYTES_WRITTEN: 0,
            runtime.DESC_READ_BEATS: 7,
            runtime.DESC_WRITE_BEATS: 0,
        }
    )

    assert runtime.descriptor_counters() == {
        "status": runtime.DESC_STATUS_DONE,
        "head": 3,
        "tail": 3,
        "timeout_count": 0,
        "bytes_read": 28,
        "bytes_written": 0,
        "read_beats": 7,
        "write_beats": 0,
    }


def test_precision_matrix_reports_supported_and_blocked_states_without_overclaiming():
    runtime, _ = make_runtime()
    matrix = {entry["precision"]: entry for entry in runtime.precision_matrix()}

    assert matrix["INT8"]["state"] == "supported"
    assert matrix["INT4"]["state"] == "supported"
    assert matrix["INT2"]["state"] == "supported"
    assert "GEMM_S4" in matrix["INT4"]["path"]
    assert "SDOT4_S4_2_4" in matrix["INT4"]["path"]
    assert matrix["INT4_GROUP_SCALED"]["state"] == "supported"
    assert "Q8.8" in matrix["INT4_GROUP_SCALED"]["path"]
    assert "DOT16_S2" in matrix["INT2"]["path"]
    assert matrix["FP8"]["state"] == "supported"
    assert "DOT4_FP8_E4M3" in matrix["FP8"]["path"]
    for precision in ("FP16", "BF16"):
        assert matrix[precision]["state"] == "supported"
        assert "Q8.8" in matrix[precision]["path"]
        assert "no tensor" in matrix[precision]["path"]


def test_gemm_s8_programs_scratchpad_and_matches_golden_model():
    runtime, mmio = make_completing_runtime()
    a = [[1, -2, 3], [4, 5, -6]]
    b = [[7, -8], [9, 10], [-11, 12]]

    assert runtime.gemm_s8(a, b) == golden_gemm_s8(a, b)
    assert mmio.commands[-1] == runtime.OP_GEMM_S8
    assert mmio.regs[runtime.GEMM_CFG] == 2 | (2 << 8) | (3 << 16)
    assert mmio.regs[runtime.PERF_MACS] == 12


def test_gemm_s4_programs_packed_scratchpad_and_matches_golden_model():
    runtime, mmio = make_completing_runtime()
    a = [[7, -8, 3], [-4, 5, -6]]
    b = [[-7, 6], [5, -4], [3, -2]]

    assert runtime.gemm_s4(a, b) == golden_gemm_s4(a, b)
    assert mmio.commands[-1] == runtime.OP_GEMM_S4
    assert mmio.regs[runtime.GEMM_CFG] == 2 | (2 << 8) | (3 << 16)
    assert mmio.regs[runtime.GEMM_BASE] == 0 | (6 << 8) | (8 << 16)
    assert mmio.regs[runtime.PERF_MACS] == 12


def test_stablehlo_matmul_smoke_lowers_to_gemm_s8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "int8",
        "lhs": [[1, -2, 3], [4, 5, -6]],
        "rhs": [[7, -8], [9, 10], [-11, 12]],
    }

    lowered = lower_matmul_smoke(runtime, graph)

    assert lowered.result == lowered.golden == golden_gemm_s8(graph["lhs"], graph["rhs"])
    assert lowered.abi_opcode == runtime.OP_GEMM_S8
    assert lowered.cpu_fallback is False
    assert lowered.tile_count == 1
    assert lowered.tiled_dispatch is False
    assert lowered.split_k is False
    assert lowered.host_accumulates_partials is False
    assert "single_matmul_tiled_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-1] == runtime.OP_GEMM_S8


def test_stablehlo_materialized_int8_dot_graph_lowers_to_gemm_s8():
    runtime, mmio = make_completing_runtime()
    module = parse_module(
        {
            "schema": "eliza.e1_npu_stablehlo_subset.v1",
            "name": "int8_dot_import_smoke",
            "ops": [
                {
                    "op": "stablehlo.dot",
                    "name": "dot0",
                    "lhs_type": {"shape": [2, 3], "dtype": "int8"},
                    "rhs_type": {"shape": [3, 2], "dtype": "int8"},
                    "result_type": {"shape": [2, 2], "dtype": "int8"},
                    "precision": "int8",
                }
            ],
        }
    )
    graph = materialize_module_lowering_graphs(
        module,
        {
            "dot0": {
                "lhs": [[1, -2, 3], [4, 5, -6]],
                "rhs": [[7, -8], [9, 10], [-11, 12]],
            }
        },
    )[0]

    lowered = lower_matmul_smoke(runtime, graph)

    assert lowered.result == lowered.golden == golden_gemm_s8(graph["lhs"], graph["rhs"])
    assert lowered.source_dialect == "stablehlo"
    assert lowered.source_op == "stablehlo.dot"
    assert lowered.cpu_fallback is False
    assert mmio.commands[-1] == runtime.OP_GEMM_S8


def test_stablehlo_module_smoke_dispatches_materialized_dot_graphs_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    module = {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "mixed_dot_import_smoke",
        "ops": [
            {
                "op": "stablehlo.dot",
                "name": "int8_dot",
                "lhs_type": {"shape": [2, 3], "dtype": "int8"},
                "rhs_type": {"shape": [3, 2], "dtype": "int8"},
                "result_type": {"shape": [2, 2], "dtype": "int8"},
                "precision": "int8",
            },
            {
                "op": "stablehlo.dot_general",
                "name": "fp8_dot",
                "lhs_type": {"shape": [2, 5], "dtype": "fp8_e4m3"},
                "rhs_type": {"shape": [5, 2], "dtype": "fp8_e4m3"},
                "result_type": {"shape": [2, 2], "dtype": "fp8_e4m3"},
                "precision": "fp8_e4m3",
            },
        ],
    }

    lowered = lower_stablehlo_module_smoke(
        runtime,
        module,
        {
            "int8_dot": {
                "lhs": [[1, -2, 3], [4, 5, -6]],
                "rhs": [[7, -8], [9, 10], [-11, 12]],
            },
            "fp8_dot": {
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
            },
        },
    )

    int8_lowered, fp8_lowered = lowered.lowered_ops
    assert lowered.schema == "eliza.e1_npu_lowered_stablehlo_module_result.v1"
    assert lowered.module_name == "mixed_dot_import_smoke"
    assert lowered.op_count == 2
    assert lowered.dispatch_order == ("int8_dot", "fp8_dot")
    assert lowered.runtime_apis == ("lower_matmul_smoke", "lower_fp8_matmul_smoke")
    assert lowered.cpu_fallback is False
    assert lowered.all_npu_dispatch is True
    assert lowered.lowering_plans[0]["op_name"] == "int8_dot"
    assert lowered.lowering_plans[1]["schema"] == "eliza.e1_npu_fp8_matmul_smoke.v1"
    assert lowered.lowering_graphs[0]["schema"] == "eliza.e1_npu_matmul_smoke.v1"
    assert lowered.lowering_graphs[1]["schema"] == "eliza.e1_npu_fp8_matmul_smoke.v1"
    assert int8_lowered.result == golden_gemm_s8(
        lowered.lowering_graphs[0]["lhs"], lowered.lowering_graphs[0]["rhs"]
    )
    assert fp8_lowered.result_q8_8 == [[0, 1536], [320, -384]]
    assert "stablehlo_smoke_module_dispatch_only" in lowered.claim_boundary
    assert lowered.as_dict()["dispatch_order"] == ["int8_dot", "fp8_dot"]
    assert lowered.as_dict()["all_npu_dispatch"] is True
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 1
    assert mmio.commands.count(runtime.OP_DOT4_FP8_E4M3) == 8


def test_stablehlo_module_smoke_rejects_invalid_import_before_touching_mmio():
    runtime, mmio = make_runtime()
    module = {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "invalid_import_smoke",
        "ops": [
            {
                "op": "stablehlo.dot_general",
                "name": "dot0",
                "lhs_type": {"shape": [2, 3], "dtype": "mxint8"},
                "rhs_type": {"shape": [3, 2], "dtype": "mxint8"},
                "result_type": {"shape": [2, 2], "dtype": "mxint8"},
                "precision": "mxint8",
            }
        ],
    }

    with pytest.raises(NpuLoweringError, match="invalid StableHLO smoke module"):
        lower_stablehlo_module_smoke(runtime, module, {"dot0": {"lhs": [[1]], "rhs": [[1]]}})
    with pytest.raises(NpuLoweringError, match="invalid StableHLO smoke module"):
        lower_stablehlo_module_smoke(runtime, {**module, "schema": "other"}, {})
    first_op: dict[str, object] = dict(module["ops"][0])  # type: ignore[arg-type]
    duplicate = {
        **module,
        "ops": [first_op, {**first_op, "precision": "int8"}],
    }
    with pytest.raises(NpuLoweringError, match="DUPLICATE_OP_NAME"):
        lower_stablehlo_module_smoke(runtime, duplicate, {"dot0": {"lhs": [[1]], "rhs": [[1]]}})

    assert mmio.writes == []


def test_batch_matmul_smoke_reuses_tiled_matmul_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_batch_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.batch_matmul",
        "precision": "int8",
        "lhs": [
            [
                [[1, -2, 3], [4, 5, -6]],
                [[-1, 2, 0], [3, -4, 5]],
            ]
        ],
        "rhs": [
            [
                [[7, -8], [9, 10], [-11, 12]],
                [[1, 2], [-3, 4], [5, -6]],
            ]
        ],
    }

    lowered = lower_batch_matmul_smoke(runtime, graph)

    assert (
        lowered.result
        == lowered.golden
        == [
            [
                [[-44, 8], [139, -54]],
                [[-7, 6], [40, -40]],
            ]
        ]
    )
    assert lowered.input_shape == [1, 2, 2, 3, 2]
    assert lowered.output_shape == [1, 2, 2, 2]
    assert lowered.total_tile_count == 2
    assert lowered.cpu_fallback is False
    assert lowered.host_iterates_batch_heads is True
    assert "batch_matmul_reuses_tiled_matmul_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [runtime.OP_GEMM_S8, runtime.OP_GEMM_S8]


def test_stablehlo_module_smoke_dispatches_batch_matmul_graph_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    module = {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "batch_matmul_import_smoke",
        "ops": [
            {
                "op": "stablehlo.batch_matmul",
                "name": "batch0",
                "lhs_type": {"shape": [1, 2, 2, 3], "dtype": "int8"},
                "rhs_type": {"shape": [1, 2, 3, 2], "dtype": "int8"},
                "result_type": {"shape": [1, 2, 2, 2], "dtype": "int8"},
                "precision": "int8",
            }
        ],
    }

    lowered = lower_stablehlo_module_smoke(
        runtime,
        module,
        {
            "batch0": {
                "lhs": [
                    [
                        [[1, -2, 3], [4, 5, -6]],
                        [[-1, 2, 0], [3, -4, 5]],
                    ]
                ],
                "rhs": [
                    [
                        [[7, -8], [9, 10], [-11, 12]],
                        [[1, 2], [-3, 4], [5, -6]],
                    ]
                ],
            }
        },
    )

    batch_lowered = lowered.lowered_ops[0]
    assert lowered.runtime_apis == ("lower_batch_matmul_smoke",)
    assert lowered.dispatch_order == ("batch0",)
    assert lowered.all_npu_dispatch is True
    assert lowered.lowering_plans[0]["schema"] == "eliza.e1_npu_batch_matmul_smoke.v1"
    assert batch_lowered.total_tile_count == 2
    assert batch_lowered.result == batch_lowered.golden
    assert mmio.commands == [runtime.OP_GEMM_S8, runtime.OP_GEMM_S8]


def test_batch_matmul_smoke_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_batch_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.batch_matmul",
        "precision": "int8",
        "lhs": [[[[1]]]],
        "rhs": [[[[1]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_batch_matmul_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported batch_matmul source op"):
        lower_batch_matmul_smoke(runtime, {**base, "op": "stablehlo.dot"})
    with pytest.raises(NpuLoweringError, match="unsupported batch_matmul precision"):
        lower_batch_matmul_smoke(runtime, {**base, "precision": "fp8_e4m3"})
    with pytest.raises(NpuLoweringError, match="batch_matmul slice"):
        lower_batch_matmul_smoke(runtime, {**base, "lhs": [[[[1, 2]]]]})

    assert mmio.writes == []


def test_tflite_matmul_smoke_lowers_to_gemm_s4_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_matmul_smoke.v1",
        "dialect": "tflite",
        "op": "tflite.fully_connected",
        "precision": "int4",
        "lhs": [[7, -8, 3], [-4, 5, -6]],
        "rhs": [[-7, 6], [5, -4], [3, -2]],
    }

    lowered = lower_matmul_smoke(runtime, graph)

    assert lowered.result == lowered.golden == golden_gemm_s4(graph["lhs"], graph["rhs"])
    assert lowered.abi_opcode == runtime.OP_GEMM_S4
    assert lowered.cpu_fallback is False
    assert lowered.tile_count == 1
    assert lowered.split_k is False
    assert mmio.commands[-1] == runtime.OP_GEMM_S4


def test_matmul_smoke_lowers_larger_mn_to_multiple_npu_tiles_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot",
        "precision": "int8",
        "lhs": [
            [1, 2, -3, 4],
            [-4, 3, 2, -1],
            [5, -6, 7, -8],
            [2, 0, -1, 3],
        ],
        "rhs": [
            [1, -2, 3, 4],
            [5, 6, -7, 8],
            [-1, 2, 0, 3],
            [4, -5, 6, -8],
        ],
    }

    lowered = lower_matmul_smoke(runtime, graph)

    assert lowered.result == lowered.golden == golden_gemm_s8(graph["lhs"], graph["rhs"])
    assert lowered.abi_opcode == runtime.OP_GEMM_S8
    assert lowered.cpu_fallback is False
    assert lowered.tile_count == 4
    assert lowered.tiled_dispatch is True
    assert lowered.split_k is False
    assert lowered.host_accumulates_partials is False
    assert lowered.tile_shape_limit == {"m": 3, "n": 3, "k": 7}
    assert mmio.commands[-4:] == [runtime.OP_GEMM_S8] * 4


def test_matmul_smoke_split_k_uses_npu_tiles_and_host_partial_accumulation():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "int8",
        "lhs": [[1, -2, 3, 4, -5, 6, 7, -8], [-1, 2, -3, 4, 5, -6, 7, 8]],
        "rhs": [[1, -1], [2, 3], [-4, 5], [6, -7], [8, 1], [-2, 4], [3, -5], [7, 2]],
    }

    lowered = lower_matmul_smoke(runtime, graph)

    assert lowered.result == lowered.golden == golden_gemm_s8(graph["lhs"], graph["rhs"])
    assert lowered.abi_opcode == runtime.OP_GEMM_S8
    assert lowered.cpu_fallback is False
    assert lowered.tile_count == 2
    assert lowered.tiled_dispatch is True
    assert lowered.split_k is True
    assert lowered.host_accumulates_partials is True
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S8] * 2


def test_qkv_projection_smoke_lowers_packed_weight_to_sliced_qkv_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_qkv_projection_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.qkv_projection",
        "precision": "int8",
        "projection_shift": 0,
        "input": [[1, 2], [3, 4]],
        "packed_weight": [[1, 0, 0, 1, 1, 1], [0, 1, 1, 0, -1, 2]],
    }

    lowered = lower_qkv_projection_smoke(runtime, graph)

    assert lowered.packed_accumulator == [[1, 2, 2, 1, -1, 5], [3, 4, 4, 3, -1, 11]]
    assert lowered.q_accumulator == lowered.q_requantized == [[1, 2], [3, 4]]
    assert lowered.k_accumulator == lowered.k_requantized == [[2, 1], [4, 3]]
    assert lowered.v_accumulator == lowered.v_requantized == [[-1, 5], [-1, 11]]
    assert lowered.packed_matmul.result == lowered.packed_accumulator
    assert lowered.total_tile_count == 2
    assert lowered.host_slices_packed_qkv is True
    assert lowered.host_requantizes_qkv is True
    assert lowered.cpu_fallback is False
    assert "qkv_projection_packed_gemm_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [runtime.OP_GEMM_S8, runtime.OP_GEMM_S8]


def test_stablehlo_conv2d_smoke_lowers_im2col_to_gemm_s8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_conv2d_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.convolution",
        "precision": "int8",
        "data_format": "NHWC",
        "filter_format": "HWIO",
        "padding": "VALID",
        "strides": [1, 1],
        "dilations": [1, 1],
        "input": [[[[1], [2], [3]], [[4], [5], [6]], [[7], [8], [9]]]],
        "filter": [[[[1, -1]], [[2, 0]]], [[[0, 3]], [[-1, 1]]]],
    }

    lowered = lower_conv2d_smoke(runtime, graph)

    assert lowered.output == lowered.golden == [[[[0, 16], [2, 19]], [[6, 25], [8, 28]]]]
    assert lowered.output_shape == [1, 2, 2, 2]
    assert lowered.im2col_shape == [4, 4]
    assert lowered.filter_matrix_shape == [4, 2]
    assert lowered.matmul.cpu_fallback is False
    assert lowered.matmul.tile_count == 2
    assert lowered.host_materializes_im2col is True
    assert lowered.cpu_fallback is False
    assert "single_conv2d_im2col_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S8] * 2


def test_stablehlo_module_smoke_dispatches_convolution_graph_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    module = {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "conv2d_import_smoke",
        "ops": [
            {
                "op": "stablehlo.convolution",
                "name": "conv0",
                "input_type": {"shape": [1, 3, 3, 1], "dtype": "int8"},
                "filter_type": {"shape": [2, 2, 1, 2], "dtype": "int8"},
                "result_type": {"shape": [1, 2, 2, 2], "dtype": "int8"},
                "precision": "int8",
                "padding": "VALID",
                "stride": 1,
                "dilation": 1,
            }
        ],
    }

    lowered = lower_stablehlo_module_smoke(
        runtime,
        module,
        {
            "conv0": {
                "input": [[[[1], [2], [3]], [[4], [5], [6]], [[7], [8], [9]]]],
                "filter": [[[[1, -1]], [[2, 0]]], [[[0, 3]], [[-1, 1]]]],
            }
        },
    )

    conv_lowered = lowered.lowered_ops[0]
    assert lowered.runtime_apis == ("lower_conv2d_smoke",)
    assert lowered.dispatch_order == ("conv0",)
    assert lowered.all_npu_dispatch is True
    assert lowered.lowering_plans[0]["static_graph_fields"]["data_format"] == "NHWC"
    assert lowered.lowering_graphs[0]["schema"] == "eliza.e1_npu_conv2d_smoke.v1"
    assert conv_lowered.output == conv_lowered.golden == [[[[0, 16], [2, 19]], [[6, 25], [8, 28]]]]
    assert conv_lowered.matmul.cpu_fallback is False
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S8] * 2


def test_tflite_conv2d_smoke_lowers_im2col_to_gemm_s4_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_conv2d_smoke.v1",
        "dialect": "tflite",
        "op": "tflite.conv_2d",
        "precision": "int4",
        "input": [[[[7, -8], [3, -4]], [[5, -6], [1, 2]]]],
        "filter": [[[[1], [-1]], [[2], [3]]], [[[0], [1]], [[-2], [2]]]],
    }

    lowered = lower_conv2d_smoke(runtime, graph)

    assert lowered.output == lowered.golden == [[[[5]]]]
    assert lowered.output_shape == [1, 1, 1, 1]
    assert lowered.im2col_shape == [1, 8]
    assert lowered.matmul.split_k is True
    assert lowered.matmul.host_accumulates_partials is True
    assert lowered.cpu_fallback is False
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S4] * 2


def test_tflite_depthwise_conv2d_smoke_lowers_direct_scalar_macs_without_im2col():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_depthwise_conv2d_smoke(runtime, graph)

    expected = [[[[24, -7, 8, 2], [32, -9, 12, 4]], [[48, -13, 20, 8], [56, -15, 24, 10]]]]
    assert lowered.output == lowered.golden == expected
    assert lowered.output_shape == [1, 2, 2, 4]
    assert lowered.input_channels == 2
    assert lowered.channel_multiplier == 2
    assert lowered.scalar_mul_count == 64
    assert lowered.scalar_add_count == 64
    assert lowered.cpu_fallback is False
    assert lowered.host_uses_direct_depthwise_loops is True
    assert lowered.host_materializes_im2col is False
    assert "depthwise_conv2d_direct_scalar_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_MUL_LO) == 64
    assert mmio.commands.count(runtime.OP_ADD) == 64


def test_stablehlo_grouped_conv2d_smoke_lowers_direct_scalar_macs_without_im2col():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_grouped_conv2d_smoke(runtime, graph)

    assert lowered.output == lowered.golden == [[[[28, 6, 50, 270]]]]
    assert lowered.output_shape == [1, 1, 1, 4]
    assert lowered.groups == 2
    assert lowered.input_channels_per_group == 2
    assert lowered.output_channels_per_group == 2
    assert lowered.scalar_mul_count == 32
    assert lowered.scalar_add_count == 32
    assert lowered.cpu_fallback is False
    assert lowered.host_uses_direct_grouped_loops is True
    assert lowered.host_materializes_im2col is False
    assert "grouped_conv2d_direct_scalar_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_MUL_LO) == 32
    assert mmio.commands.count(runtime.OP_ADD) == 32


def test_stablehlo_silu_smoke_dispatches_exp2_piecewise_scalar_activation():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_silu_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.silu",
        "precision": "int8",
        "approximation": "exp2_q0_8_piecewise",
        "input": [[-8, -2, 0], [4, 8, 16]],
    }

    lowered = lower_silu_smoke(runtime, graph)

    assert lowered.sigmoid_q0_8 == [[0, 32, 128], [248, 256, 256]]
    assert lowered.output == lowered.golden == [[0, -1, 0], [3, 8, 16]]
    assert lowered.shape == [2, 3]
    assert lowered.element_count == 6
    assert lowered.scalar_exp2_count == 6
    assert lowered.scalar_sub_count == 4
    assert lowered.scalar_mul_count == 6
    assert lowered.cpu_fallback is False
    assert lowered.host_applies_shift_and_saturation is True
    assert lowered.approximation == "exp2_q0_8_piecewise"
    assert "silu_s8_exp2_piecewise_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 6
    assert mmio.commands.count(runtime.OP_SUB) == 4
    assert mmio.commands.count(runtime.OP_MUL_LO) == 6


def test_stablehlo_gelu_smoke_dispatches_quick_exp2_piecewise_scalar_activation():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_gelu_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.gelu",
        "precision": "int8",
        "approximation": "quick_gelu_exp2_q0_8",
        "input": [[-16, -4, 0], [4, 16, 32]],
    }

    lowered = lower_gelu_smoke(runtime, graph)

    assert lowered.scaled_input == [[-28, -7, 0], [6, 27, 54]]
    assert lowered.sigmoid_q0_8 == [[0, 1, 128], [254, 256, 256]]
    assert lowered.output == lowered.golden == [[0, -1, 0], [3, 16, 32]]
    assert lowered.shape == [2, 3]
    assert lowered.element_count == 6
    assert lowered.scalar_scale_mul_count == 6
    assert lowered.scalar_exp2_count == 6
    assert lowered.scalar_sub_count == 4
    assert lowered.scalar_gate_mul_count == 6
    assert lowered.cpu_fallback is False
    assert lowered.host_applies_shift_and_saturation is True
    assert lowered.approximation == "quick_gelu_exp2_q0_8"
    assert "gelu_s8_quick_exp2_piecewise_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 6
    assert mmio.commands.count(runtime.OP_SUB) == 4
    assert mmio.commands.count(runtime.OP_MUL_LO) == 12


def test_attention_qk_smoke_lowers_per_head_scores_to_gemm_s8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_attention_qk_smoke(runtime, graph)

    assert (
        lowered.scores
        == lowered.golden
        == [[[[-6, 26, -7], [6, 10, -20]], [[-5, -5, 14], [3, -13, 12]]]]
    )
    assert lowered.score_shape == [1, 2, 2, 3]
    assert lowered.head_count == 2
    assert lowered.head_dim == 4
    assert lowered.total_tile_count == 2
    assert [matmul.tile_count for matmul in lowered.matmuls] == [1, 1]
    assert lowered.host_transposes_keys is True
    assert lowered.host_iterates_heads is True
    assert lowered.cpu_fallback is False
    assert "attention_qk_scores_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S8] * 2


def test_attention_qk_smoke_split_k_uses_gemm_s4_tiles_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_attention_qk_smoke.v1",
        "dialect": "tflite",
        "op": "tflite.batch_matmul",
        "precision": "int4",
        "query": [[[[1, -2, 3, -4, 5, -6, 7, -8]]]],
        "key": [[[[7, -6, 5, -4, 3, -2, 1, 0], [-1, 2, -3, 4, -5, 6, -7, 7]]]],
    }

    lowered = lower_attention_qk_smoke(runtime, graph)

    assert lowered.scores == lowered.golden == [[[[84, -196]]]]
    assert lowered.score_shape == [1, 1, 1, 2]
    assert lowered.total_tile_count == 2
    assert lowered.matmuls[0].split_k is True
    assert lowered.matmuls[0].host_accumulates_partials is True
    assert lowered.cpu_fallback is False
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S4] * 2


def test_attention_softmax_smoke_uses_scalar_max_exp_sum_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_attention_softmax_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.attention_softmax",
        "precision": "int8",
        "logits": [[[[4, 2, 0], [1, 0, -1]]]],
        "mask": [[[[True, True, False], [True, True, True]]]],
    }

    lowered = lower_attention_softmax_smoke(runtime, graph)

    assert lowered.row_max == [[[4, 1]]]
    assert lowered.exp_q0_8 == [[[[256, 64, 0], [256, 128, 64]]]]
    assert lowered.row_sum_exp == [[[320, 448]]]
    assert lowered.weights_q0_8 == [[[[205, 51, 0], [146, 73, 37]]]]
    assert lowered.scalar_max_count == 3
    assert lowered.scalar_sub_count == 5
    assert lowered.scalar_exp_count == 5
    assert lowered.scalar_add_count == 5
    assert lowered.host_applies_mask is True
    assert lowered.host_divides_by_row_sum is True
    assert lowered.cpu_fallback is False
    assert "attention_softmax_exp2_q0_8_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [
        runtime.OP_MAX_U32,
        runtime.OP_SUB,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_ADD,
        runtime.OP_SUB,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_ADD,
        runtime.OP_MAX_U32,
        runtime.OP_MAX_U32,
        runtime.OP_SUB,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_ADD,
        runtime.OP_SUB,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_ADD,
        runtime.OP_SUB,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_ADD,
    ]


def test_attention_av_smoke_lowers_context_to_gemm_s8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_attention_av_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.attention_av",
        "precision": "int8",
        "attention": [[[[1, -2, 3], [-1, 4, 2]], [[2, 0, -1], [3, -2, 1]]]],
        "value": [[[[1, 2], [-3, 4], [5, -6]], [[0, 1], [2, -1], [-4, 3]]]],
    }

    lowered = lower_attention_av_smoke(runtime, graph)

    assert lowered.context == lowered.golden == [[[[22, -24], [-3, 2]], [[4, -1], [-8, 8]]]]
    assert lowered.context_shape == [1, 2, 2, 2]
    assert lowered.head_count == 2
    assert lowered.value_dim == 2
    assert lowered.total_tile_count == 2
    assert [matmul.tile_count for matmul in lowered.matmuls] == [1, 1]
    assert lowered.host_iterates_heads is True
    assert lowered.requires_prequantized_attention is True
    assert lowered.cpu_fallback is False
    assert "attention_av_context_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S8] * 2


def test_attention_av_smoke_split_k_uses_gemm_s4_tiles_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_attention_av_smoke.v1",
        "dialect": "tflite",
        "op": "tflite.batch_matmul",
        "precision": "int4",
        "attention": [[[[1, -2, 3, -4, 5, -6, 7, -8]]]],
        "value": [[[[7, -6], [-5, 4], [3, -2], [-1, 1], [2, -3], [-4, 5], [6, -7], [-8, 7]]]],
    }

    lowered = lower_attention_av_smoke(runtime, graph)

    assert lowered.context == lowered.golden == [[[[170, -174]]]]
    assert lowered.context_shape == [1, 1, 1, 2]
    assert lowered.total_tile_count == 2
    assert lowered.matmuls[0].split_k is True
    assert lowered.matmuls[0].host_accumulates_partials is True
    assert lowered.cpu_fallback is False
    assert mmio.commands[-2:] == [runtime.OP_GEMM_S4] * 2


def test_attention_smoke_composes_multihead_qk_softmax_av_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_attention_smoke(runtime, graph)

    assert lowered.qk_scores.scores == [[[[1, 2], [3, 4]], [[1, 3], [1, -3]]]]
    assert lowered.qk_logits_s8 == lowered.qk_scores.scores
    assert lowered.attention_softmax.weights_q0_8 == [
        [[[85, 171], [85, 171]], [[51, 205], [241, 15]]]
    ]
    assert lowered.attention_weights_s8 == [[[[43, 86], [43, 86]], [[26, 103], [121, 8]]]]
    assert lowered.attention_av.context == [[[[817, 946], [817, 946]], [[540, -411], [-315, 444]]]]
    assert lowered.context_requantized == [[[[51, 59], [51, 59]], [[33, -26], [-20, 27]]]]
    assert lowered.head_count == 2
    assert lowered.total_tile_count == 4
    assert lowered.computes_qk_scores is True
    assert lowered.computes_attention_softmax is True
    assert lowered.requires_prequantized_attention is False
    assert lowered.host_requantizes_attention_weights is True
    assert lowered.cpu_fallback is False
    assert "multihead_attention_qk_exp2_softmax_av_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 4
    assert runtime.OP_EXP2_NEG_Q0_8 in mmio.commands


def test_attention_smoke_can_generate_causal_mask_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_attention_smoke(runtime, graph)

    assert lowered.attention_mask == [[[[True, False], [True, True]]]]
    assert lowered.attention_softmax.mask == lowered.attention_mask
    assert lowered.attention_softmax.weights_q0_8 == [[[[256, 0], [85, 171]]]]
    assert lowered.attention_weights_s8 == [[[[127, 0], [43, 86]]]]
    assert lowered.context_requantized == [[[[39, 47], [51, 59]]]]
    assert lowered.host_generates_causal_mask is True
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 2
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 3


def test_attention_smoke_can_generate_sliding_window_mask_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_attention_smoke(runtime, graph)

    assert lowered.attention_mask == [
        [[[True, False, False], [True, True, False], [False, True, True]]]
    ]
    assert lowered.attention_softmax.mask == lowered.attention_mask
    assert lowered.attention_softmax.weights_q0_8 == [[[[256, 0, 0], [85, 171, 0], [0, 85, 171]]]]
    assert lowered.attention_weights_s8 == [[[[127, 0, 0], [43, 86, 0], [0, 43, 86]]]]
    assert lowered.context_requantized == [[[[15, 0], [5, 10], [5, 10]]]]
    assert lowered.host_generates_sliding_window_mask is True
    assert lowered.host_generates_causal_mask is False
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 2
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 5


def test_kv_cache_update_smoke_appends_key_value_tokens_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_kv_cache_update_smoke(runtime, graph)

    assert lowered.updated_key_cache == [[[[1, 2], [3, 4], [9, -10], [11, -12]]]]
    assert lowered.updated_value_cache == [[[[5, 6], [7, 8], [-13, 14], [15, -16]]]]
    assert lowered.cache_lengths == [[4]]
    assert lowered.appended_tokens == 2
    assert lowered.head_count == 1
    assert lowered.head_dim == 2
    assert lowered.value_dim == 2
    assert lowered.scalar_copy_count == 8
    assert lowered.host_preserves_existing_cache is True
    assert lowered.host_tracks_cache_lengths is True
    assert lowered.cpu_fallback is False
    assert "kv_cache_update_s8_scalar_append_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-8:] == [runtime.OP_ADD] * 8


def test_decode_attention_smoke_appends_kv_and_attends_over_cache_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_decode_attention_smoke(runtime, graph)

    assert lowered.updated_cache_lengths == [[3, 2]]
    assert lowered.max_attention_cache_length == 3
    assert lowered.attention_mask == [[[[True, True, True]], [[True, True, False]]]]
    assert lowered.attention.qk_scores.scores == [[[[1, 1, 3]], [[1, -3, 0]]]]
    assert lowered.attention.attention_softmax.weights_q0_8 == [[[[43, 43, 171]], [[241, 15, 0]]]]
    assert lowered.attention.attention_weights_s8 == [[[[22, 22, 86]], [[121, 8, 0]]]]
    assert lowered.attention.context_requantized == [[[[64, 73]], [[-20, 27]]]]
    assert lowered.updates_kv_cache is True
    assert lowered.computes_attention_over_cache is True
    assert lowered.host_materializes_cache_view is True
    assert lowered.cpu_fallback is False
    assert "decode_attention_kv_append_qk_softmax_av_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 4
    assert runtime.OP_EXP2_NEG_Q0_8 in mmio.commands


def test_decode_attention_smoke_can_limit_attention_to_recent_cache_window():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_decode_attention_smoke(runtime, graph)

    assert lowered.updated_cache_lengths == [[3, 2]]
    assert lowered.max_attention_cache_length == 2
    assert lowered.decode_cache_window == 2
    assert lowered.attention_key_cache_view == [[[[0, 1], [2, 1]], [[1, 1], [-1, 1]]]]
    assert lowered.attention_value_cache_view == [[[[7, 8], [9, 10]], [[-3, 4], [6, -5]]]]
    assert lowered.attention_mask == [[[[True, True]], [[True, True]]]]
    assert lowered.attention.qk_scores.scores == [[[[1, 3]], [[1, -3]]]]
    assert lowered.attention.attention_softmax.weights_q0_8 == [[[[51, 205]], [[241, 15]]]]
    assert lowered.attention.attention_weights_s8 == [[[[26, 103]], [[121, 8]]]]
    assert lowered.attention.context_requantized == [[[[69, 77]], [[-20, 27]]]]
    assert lowered.host_materializes_cache_view is True
    assert lowered.host_applies_decode_cache_window is True
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 4
    assert runtime.OP_EXP2_NEG_Q0_8 in mmio.commands


def test_transformer_mlp_smoke_uses_gemm_vrelu_gemm_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_mlp_smoke(runtime, graph)

    assert lowered.hidden_accumulator == [[11, -5, 13, -7], [-29, 14, -34, 7]]
    assert lowered.hidden_requantized == [[5, -3, 6, -4], [-15, 7, -17, 3]]
    assert lowered.hidden_activated == [[5, 0, 6, 0], [0, 7, 0, 3]]
    assert lowered.output == lowered.golden == [[17, -4], [-16, 27]]
    assert lowered.up_matmul.tile_count == 2
    assert lowered.down_matmul.tile_count == 1
    assert lowered.total_tile_count == 3
    assert lowered.host_requantizes_hidden is True
    assert lowered.activation_opcode == "VRELU_S8"
    assert lowered.cpu_fallback is False
    assert "transformer_mlp_relu_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-4:] == [
        runtime.OP_GEMM_S8,
        runtime.OP_GEMM_S8,
        runtime.OP_VRELU_S8,
        runtime.OP_GEMM_S8,
    ]


def test_stablehlo_module_smoke_dispatches_mlp_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    module = {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "mlp_import_smoke",
        "ops": [
            {
                "op": "stablehlo.mlp",
                "name": "mlp0",
                "input_type": {"shape": [2, 2], "dtype": "int8"},
                "up_weight_type": {"shape": [2, 3], "dtype": "int8"},
                "down_weight_type": {"shape": [3, 2], "dtype": "int8"},
                "result_type": {"shape": [2, 2], "dtype": "int8"},
                "activation": "relu",
                "precision": "int8",
            }
        ],
    }

    lowered = lower_stablehlo_module_smoke(
        runtime,
        module,
        {
            "mlp0": {
                "input": [[1, -2], [3, 4]],
                "up_weight": [[2, -1, 3], [-2, 1, 0]],
                "down_weight": [[1, -2], [-3, 4], [2, 1]],
            }
        },
    )

    mlp_lowered = lowered.lowered_ops[0]
    assert lowered.runtime_apis == ("lower_mlp_smoke",)
    assert lowered.dispatch_order == ("mlp0",)
    assert lowered.all_npu_dispatch is True
    assert lowered.lowering_plans[0]["static_graph_fields"] == {
        "activation": "relu",
        "requant_shift": 0,
    }
    assert mlp_lowered.hidden_activated == [[6, 0, 3], [0, 1, 9]]
    assert mlp_lowered.output == mlp_lowered.golden == [[12, -9], [15, 13]]
    assert mlp_lowered.total_tile_count == 2
    assert mmio.commands[-3:] == [runtime.OP_GEMM_S8, runtime.OP_VRELU_S8, runtime.OP_GEMM_S8]


def test_stablehlo_module_smoke_dispatches_attention_qk_and_av_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    module = {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "attention_qk_av_import_smoke",
        "ops": [
            {
                "op": "stablehlo.attention_qk",
                "name": "qk0",
                "query_type": {"shape": [1, 1, 2, 3], "dtype": "int8"},
                "key_type": {"shape": [1, 1, 2, 3], "dtype": "int8"},
                "result_type": {"shape": [1, 1, 2, 2], "dtype": "int8"},
                "precision": "int8",
            },
            {
                "op": "stablehlo.attention_av",
                "name": "av0",
                "weights_type": {"shape": [1, 1, 2, 2], "dtype": "int8"},
                "value_type": {"shape": [1, 1, 2, 3], "dtype": "int8"},
                "result_type": {"shape": [1, 1, 2, 3], "dtype": "int8"},
                "precision": "int8",
            },
        ],
    }

    lowered = lower_stablehlo_module_smoke(
        runtime,
        module,
        {
            "qk0": {
                "query": [[[[1, -2, 3], [4, 5, -6]]]],
                "key": [[[[7, -8, 9], [10, 11, -12]]]],
            },
            "av0": {
                "attention": [[[[1, 2], [3, 4]]]],
                "value": [[[[5, -6, 7], [8, 9, -10]]]],
            },
        },
    )

    qk_lowered, av_lowered = lowered.lowered_ops
    assert lowered.runtime_apis == ("lower_attention_qk_smoke", "lower_attention_av_smoke")
    assert lowered.dispatch_order == ("qk0", "av0")
    assert lowered.all_npu_dispatch is True
    assert lowered.cpu_fallback is False
    assert lowered.lowering_graphs[0]["op"] == "stablehlo.attention_qk"
    assert lowered.lowering_graphs[1]["op"] == "stablehlo.attention_av"
    assert qk_lowered.scores == qk_lowered.golden == [[[[50, -48], [-66, 167]]]]
    assert av_lowered.context == av_lowered.golden == [[[[21, 12, -13], [47, 18, -19]]]]
    assert qk_lowered.cpu_fallback is False
    assert av_lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 2


def test_transformer_mlp_smoke_tiled_projections_and_vrelu_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_mlp_smoke.v1",
        "dialect": "tflite",
        "op": "tflite.mlp",
        "precision": "int8",
        "activation": "relu",
        "requant_shift": 0,
        "input": [
            [1, 2, -3, 4],
            [-4, 3, 2, -1],
            [5, -6, 7, -8],
            [2, 0, -1, 3],
        ],
        "up_weight": [
            [1, -2, 3, 4],
            [5, 6, -7, 8],
            [-1, 2, 0, 3],
            [4, -5, 6, -8],
        ],
        "down_weight": [[1, 2], [-3, 4], [5, -6], [7, 1]],
    }

    lowered = lower_mlp_smoke(runtime, graph)

    assert lowered.hidden_activated == [
        [30, 0, 13, 0],
        [5, 35, 0, 22],
        [0, 8, 9, 57],
        [15, 0, 24, 0],
    ]
    assert lowered.output == lowered.golden == [[95, -18], [54, 172], [420, 35], [135, -114]]
    assert lowered.up_matmul.tile_count == 4
    assert lowered.down_matmul.tile_count == 2
    assert lowered.total_tile_count == 6
    assert lowered.up_matmul.tiled_dispatch is True
    assert lowered.down_matmul.tiled_dispatch is True
    assert lowered.cpu_fallback is False
    assert (
        mmio.commands[-7:]
        == [runtime.OP_GEMM_S8] * 4 + [runtime.OP_VRELU_S8] + [runtime.OP_GEMM_S8] * 2
    )


def test_swiglu_smoke_uses_gemm_scalar_gate_and_down_gemm_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_swiglu_smoke(runtime, graph)

    assert lowered.up_accumulator == [[6, -3, 3], [-2, 1, 9]]
    assert lowered.gate_accumulator == [[1, 4, -7], [3, 2, 9]]
    assert lowered.gated_hidden == [[0, -2, -3], [-1, 0, 10]]
    assert lowered.output == lowered.golden == [[0, -11], [19, 12]]
    assert lowered.total_tile_count == 3
    assert lowered.scalar_mul_count == 6
    assert lowered.host_requantizes_hidden is True
    assert lowered.host_applies_gate_shift_and_saturation is True
    assert lowered.cpu_fallback is False
    assert "swiglu_s8_scalar_gate_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [
        runtime.OP_GEMM_S8,
        runtime.OP_GEMM_S8,
        runtime.OP_MUL_LO,
        runtime.OP_MUL_LO,
        runtime.OP_MUL_LO,
        runtime.OP_MUL_LO,
        runtime.OP_MUL_LO,
        runtime.OP_MUL_LO,
        runtime.OP_GEMM_S8,
    ]


def test_swiglu_smoke_with_silu_gate_dispatches_exp2_gate_and_gemm():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_swiglu_smoke(runtime, graph)

    assert lowered.up_accumulator == [[16, 8]]
    assert lowered.gate_accumulator == [[16, -8]]
    assert lowered.gate_requantized == [[16, -8]]
    assert lowered.gate_activated == [[16, 0]]
    assert lowered.gate_activation_result is not None
    assert lowered.gate_activation_result.output == [[16, 0]]
    assert lowered.gated_hidden == [[16, 0]]
    assert lowered.output == lowered.golden == [[16, 0]]
    assert lowered.total_tile_count == 3
    assert lowered.scalar_mul_count == 2
    assert lowered.cpu_fallback is False
    assert "swiglu_s8_silu_gate_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 3
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 2
    assert mmio.commands.count(runtime.OP_SUB) == 1
    assert mmio.commands.count(runtime.OP_MUL_LO) == 4
    assert mmio.commands == [
        runtime.OP_GEMM_S8,
        runtime.OP_GEMM_S8,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_SUB,
        runtime.OP_MUL_LO,
        runtime.OP_EXP2_NEG_Q0_8,
        runtime.OP_MUL_LO,
        runtime.OP_MUL_LO,
        runtime.OP_MUL_LO,
        runtime.OP_GEMM_S8,
    ]


def test_residual_add_smoke_uses_scalar_add_and_saturates_int8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_residual_add_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.add",
        "precision": "int8",
        "lhs": [[120, -120, 10], [-5, 64, -128]],
        "rhs": [[20, -20, -30], [-7, 80, -1]],
    }

    lowered = lower_residual_add_smoke(runtime, graph)

    assert lowered.result == lowered.golden == [[127, -128, -20], [-12, 127, -128]]
    assert lowered.shape == [2, 3]
    assert lowered.element_count == 6
    assert lowered.scalar_add_count == 6
    assert lowered.host_saturates_int8 is True
    assert lowered.cpu_fallback is False
    assert "residual_add_s8_scalar_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-6:] == [runtime.OP_ADD] * 6


def test_bias_add_smoke_uses_scalar_add_broadcast_and_saturates_int8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_bias_add_smoke.v1",
        "dialect": "tflite",
        "op": "tflite.add",
        "precision": "int8",
        "input": [[120, -120, 10], [-5, 64, -128]],
        "bias": [20, -20, -30],
    }

    lowered = lower_bias_add_smoke(runtime, graph)

    assert lowered.result == lowered.golden == [[127, -128, -20], [15, 44, -128]]
    assert lowered.input_shape == [2, 3]
    assert lowered.bias_shape == [3]
    assert lowered.element_count == 6
    assert lowered.scalar_add_count == 6
    assert lowered.host_broadcasts_bias is True
    assert lowered.host_saturates_int8 is True
    assert lowered.cpu_fallback is False
    assert "bias_add_s8_scalar_broadcast_smoke_only" in lowered.claim_boundary
    assert mmio.commands[-6:] == [runtime.OP_ADD] * 6


def test_stablehlo_module_smoke_dispatches_add_and_bias_add_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    module = {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "add_bias_import_smoke",
        "ops": [
            {
                "op": "stablehlo.add",
                "name": "add0",
                "lhs_type": {"shape": [2, 3], "dtype": "int8"},
                "rhs_type": {"shape": [2, 3], "dtype": "int8"},
                "result_type": {"shape": [2, 3], "dtype": "int8"},
                "precision": "int8",
            },
            {
                "op": "stablehlo.bias_add",
                "name": "bias0",
                "input_type": {"shape": [2, 3], "dtype": "int8"},
                "bias_type": {"shape": [3], "dtype": "int8"},
                "result_type": {"shape": [2, 3], "dtype": "int8"},
                "precision": "int8",
            },
        ],
    }

    lowered = lower_stablehlo_module_smoke(
        runtime,
        module,
        {
            "add0": {
                "lhs": [[1, -2, 120], [4, 5, -6]],
                "rhs": [[7, -8, 20], [9, 10, -127]],
            },
            "bias0": {
                "input": [[1, -2, 120], [4, 5, -6]],
                "bias": [7, -8, 20],
            },
        },
    )

    add_lowered, bias_lowered = lowered.lowered_ops
    assert lowered.runtime_apis == ("lower_residual_add_smoke", "lower_bias_add_smoke")
    assert lowered.dispatch_order == ("add0", "bias0")
    assert lowered.all_npu_dispatch is True
    assert add_lowered.result == add_lowered.golden == [[8, -10, 127], [13, 15, -128]]
    assert bias_lowered.result == bias_lowered.golden == [[8, -10, 127], [11, -3, 14]]
    assert mmio.commands[-12:] == [runtime.OP_ADD] * 12


def test_transformer_block_smoke_composes_attention_mlp_and_residuals_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_transformer_block_smoke(runtime, graph)

    assert lowered.attention_context == [[2, -1], [-3, 5]]
    assert lowered.attention_projected == [[3, -3], [-2, 3]]
    assert lowered.post_attention_residual == [[4, -5], [1, 7]]
    assert lowered.mlp_output == [[21, -12], [-7, 13]]
    assert lowered.output == [[25, -17], [-6, 20]]
    assert lowered.total_tile_count == 3
    assert lowered.scalar_add_count == 12
    assert lowered.attention_av.total_tile_count == 1
    assert lowered.mlp.total_tile_count == 2
    assert lowered.requires_prequantized_attention is True
    assert lowered.cpu_fallback is False
    assert "single_head_transformer_block_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [
        runtime.OP_GEMM_S8,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_GEMM_S8,
        runtime.OP_VRELU_S8,
        runtime.OP_GEMM_S8,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
        runtime.OP_ADD,
    ]


def test_modern_decoder_block_smoke_composes_norm_qkv_rope_attention_swiglu_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_modern_decoder_block_smoke(runtime, graph)

    assert lowered.norm1.output == [[63, 85], [35, 84]]
    assert lowered.q_requantized == [[63, 85], [35, 84]]
    assert lowered.k_requantized == [[63, 85], [35, 84]]
    assert lowered.v_requantized == [[63, 85], [35, 84]]
    assert lowered.q_rope.output == [[62, 84], [34, 83]]
    assert lowered.k_rope.output == [[62, 84], [34, 83]]
    assert lowered.qk_scores.scores == [[[[10900, 9080], [9080, 8045]]]]
    assert lowered.qk_logits_s8 == [[[[85, 70], [70, 62]]]]
    assert lowered.attention_softmax.weights_q0_8 == [[[[255, 1], [255, 1]]]]
    assert lowered.attention_weights_s8 == [[[[127, 1], [127, 1]]]]
    assert lowered.attention_av.context == [[[[8036, 10879], [8036, 10879]]]]
    assert lowered.attention_context_requantized == [[62, 84], [62, 84]]
    assert lowered.attention_residual.result == [[65, 88], [67, 96]]
    assert lowered.norm2.output == [[48, 66], [50, 72]]
    assert lowered.swiglu.gated_hidden == [[36, 68], [39, 81]]
    assert lowered.output == [[101, 127], [106, 127]]
    assert lowered.total_tile_count == 8
    assert lowered.scalar_add_count == 28
    assert lowered.scalar_mul_count == 44
    assert lowered.computes_qk_scores is True
    assert lowered.computes_attention_softmax is True
    assert lowered.requires_prequantized_attention is False
    assert lowered.host_requantizes_qkv is True
    assert lowered.host_requantizes_qk_scores is True
    assert lowered.host_requantizes_attention_weights is True
    assert lowered.cpu_fallback is False
    assert "modern_decoder_block_single_head_exp2_softmax_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 8
    assert mmio.commands.count(runtime.OP_MUL_LO) == 44
    assert mmio.commands.count(runtime.OP_ADD) == 28
    assert mmio.commands.count(runtime.OP_SUB) == 8
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 4


def test_modern_decoder_block_smoke_can_use_packed_qkv_projection_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_modern_decoder_block_smoke(runtime, graph)

    assert lowered.q_projection is None
    assert lowered.k_projection is None
    assert lowered.v_projection is None
    assert lowered.qkv_projection is not None
    assert lowered.qkv_projection.packed_accumulator == [
        [63, 85, 63, 85, 63, 85],
        [35, 84, 35, 84, 35, 84],
    ]
    assert lowered.q_requantized == [[63, 85], [35, 84]]
    assert lowered.k_requantized == [[63, 85], [35, 84]]
    assert lowered.v_requantized == [[63, 85], [35, 84]]
    assert lowered.output == [[101, 127], [106, 127]]
    assert lowered.total_tile_count == 7
    assert lowered.host_slices_packed_qkv is True
    assert lowered.host_requantizes_qkv is True
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 7
    assert mmio.commands.count(runtime.OP_MUL_LO) == 44
    assert mmio.commands.count(runtime.OP_ADD) == 28


def test_modern_decoder_block_smoke_can_use_packed_qkv_and_silu_swiglu_gate():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_modern_decoder_block_smoke(runtime, graph)

    assert lowered.qkv_projection is not None
    assert lowered.host_slices_packed_qkv is True
    assert lowered.swiglu.activation == "silu"
    assert lowered.swiglu.gate_activation_result is not None
    assert lowered.swiglu.gate_activation_result.output == [[48, 66], [50, 72]]
    assert lowered.swiglu.gate_activated == [[48, 66], [50, 72]]
    assert lowered.swiglu.gated_hidden == [[36, 68], [39, 81]]
    assert lowered.output == [[101, 127], [106, 127]]
    assert lowered.total_tile_count == 7
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 7
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 8
    assert mmio.commands.count(runtime.OP_SUB) == 12
    assert mmio.commands.count(runtime.OP_MUL_LO) == 48


def test_modern_decoder_block_smoke_can_generate_causal_attention_mask():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_modern_decoder_block_smoke(runtime, graph)

    assert lowered.attention_softmax.mask == [[[[True, False], [True, True]]]]
    assert lowered.host_generates_causal_mask is True
    assert lowered.host_slices_packed_qkv is True
    assert lowered.swiglu.activation == "silu"
    assert lowered.output == [[101, 127], [106, 127]]
    assert lowered.total_tile_count == 7
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 7
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 7


def test_modern_decoder_block_smoke_can_generate_sliding_window_attention_mask():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_modern_decoder_block_smoke(runtime, graph)

    assert lowered.attention_softmax.mask == [[[[True, False], [False, True]]]]
    assert lowered.host_generates_sliding_window_mask is True
    assert lowered.host_generates_causal_mask is False
    assert lowered.host_slices_packed_qkv is True
    assert lowered.swiglu.activation == "silu"
    assert lowered.attention_context_requantized == [[62, 84], [34, 83]]
    assert lowered.output == [[101, 127], [52, 127]]
    assert lowered.total_tile_count == 7
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_GEMM_S8) == 7
    assert mmio.commands.count(runtime.OP_EXP2_NEG_Q0_8) == 6


def test_rope_smoke_uses_scalar_mul_add_sub_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_rope_smoke(runtime, graph)

    assert lowered.output == [[63, 0, 45, 0], [9, 19, -50, 7]]
    assert lowered.golden == lowered.output
    assert lowered.cpu_fallback is False
    assert lowered.host_applies_shift_and_saturation is True
    assert lowered.scalar_mul_count == 16
    assert lowered.scalar_add_count == 8
    assert "rope_s8_scalar_smoke_only" in lowered.claim_boundary
    assert (
        mmio.commands
        == [
            runtime.OP_MUL_LO,
            runtime.OP_MUL_LO,
            runtime.OP_MUL_LO,
            runtime.OP_MUL_LO,
            runtime.OP_SUB,
            runtime.OP_ADD,
        ]
        * 4
    )


def test_rmsnorm_smoke_uses_scalar_square_accumulate_and_scale_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_rmsnorm_smoke(runtime, graph)

    assert lowered.output == [[63, 85], [35, 84]]
    assert lowered.golden == lowered.output
    assert lowered.row_sum_squares == [25, 169]
    assert lowered.row_rms == [3, 9]
    assert lowered.row_inv_rms_q == [85, 28]
    assert lowered.cpu_fallback is False
    assert lowered.host_computes_reciprocal_rms is True
    assert lowered.host_applies_shift_and_saturation is True
    assert lowered.scalar_mul_count == 12
    assert lowered.scalar_add_count == 4
    assert "rmsnorm_s8_scalar_smoke_only" in lowered.claim_boundary
    assert (
        mmio.commands
        == [
            runtime.OP_MUL_LO,
            runtime.OP_ADD,
            runtime.OP_MUL_LO,
            runtime.OP_ADD,
            runtime.OP_MUL_LO,
            runtime.OP_MUL_LO,
            runtime.OP_MUL_LO,
            runtime.OP_MUL_LO,
        ]
        * 2
    )


def test_vrelu_s8_programs_scratchpad_and_matches_golden_model():
    runtime, mmio = make_completing_runtime()
    values = [-128, -3, 0, 5, 127, -1]

    assert runtime.vrelu_s8(values) == golden_vrelu_s8(values)
    assert mmio.commands[-1] == runtime.OP_VRELU_S8
    assert mmio.regs[runtime.GEMM_CFG] == len(values)
    assert mmio.regs[runtime.GEMM_BASE] == 0
    assert mmio.regs[runtime.PERF_CYCLES] == len(values)


def test_gemm_s8_rejects_invalid_tiles_before_touching_mmio():
    runtime, mmio = make_runtime()
    with pytest.raises(ValueError, match="prototype limits"):
        runtime.gemm_s8([[1] * 8], [[1]])
    with pytest.raises(ValueError, match="outside signed INT8 range"):
        runtime.gemm_s8([[128]], [[1]])
    with pytest.raises(ValueError, match="outside signed INT4 range"):
        runtime.gemm_s4([[8]], [[1]])
    with pytest.raises(ValueError, match="ragged"):
        runtime.gemm_s8([[1], [1, 2]], [[1]])

    assert mmio.writes == []


def test_matmul_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "int8",
        "lhs": [[1]],
        "rhs": [[1]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_matmul_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported matmul source op"):
        lower_matmul_smoke(runtime, {**base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported matmul precision"):
        lower_matmul_smoke(runtime, {**base, "precision": "fp8"})
    with pytest.raises(NpuLoweringError, match="K mismatch"):
        lower_matmul_smoke(runtime, {**base, "lhs": [[1, 2]], "rhs": [[1]]})

    assert mmio.writes == []


def test_qkv_projection_smoke_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_qkv_projection_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.qkv_projection",
        "precision": "int8",
        "input": [[1, 2]],
        "packed_weight": [[1, 0, 0, 1, 1, 1], [0, 1, 1, 0, -1, 2]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_qkv_projection_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported qkv_projection source op"):
        lower_qkv_projection_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported qkv_projection precision"):
        lower_qkv_projection_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="packed output width must be divisible by 3"):
        lower_qkv_projection_smoke(runtime, {**base, "packed_weight": [[1, 2], [3, 4]]})
    with pytest.raises(NpuLoweringError, match="hidden width mismatch"):
        lower_qkv_projection_smoke(
            runtime,
            {**base, "packed_weight": [[1, 0, 0], [0, 1, 1]]},
        )
    with pytest.raises(NpuLoweringError, match="qkv_projection shift must be in 0..31"):
        lower_qkv_projection_smoke(runtime, {**base, "projection_shift": 32})

    assert mmio.writes == []


def test_fp8_matmul_smoke_lowers_to_dot4_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_fp8_matmul_smoke(runtime, graph)

    assert lowered.result_q8_8 == [[0, 1536], [320, -384]]
    assert lowered.golden_q8_8 == lowered.result_q8_8
    assert lowered.abi_opcode == runtime.OP_DOT4_FP8_E4M3
    assert lowered.dot4_count == 8
    assert lowered.padded_k == 8
    assert lowered.host_pads_k_to_dot4 is True
    assert lowered.cpu_fallback is False
    assert "fp8_e4m3_matmul_dot4_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [runtime.OP_DOT4_FP8_E4M3] * 8


def test_fp8_matmul_smoke_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_fp8_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "fp8_e4m3",
        "lhs": [[0x38]],
        "rhs": [[0x40]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_fp8_matmul_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported fp8_matmul source op"):
        lower_fp8_matmul_smoke(runtime, {**base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported fp8_matmul precision"):
        lower_fp8_matmul_smoke(runtime, {**base, "precision": "int8"})
    with pytest.raises(NpuLoweringError, match="K mismatch"):
        lower_fp8_matmul_smoke(runtime, {**base, "lhs": [[0x38, 0x40]], "rhs": [[0x40]]})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_fp8_matmul_smoke(runtime, {**base, "lhs": [[0x100]]})

    assert mmio.writes == []


def test_fp16_matmul_smoke_lowers_to_scalar_q8_8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_fp16_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "fp16",
        "lhs": [[0x3C00, 0x4000], [0x3800, 0xBC00]],
        "rhs": [[0x4000, 0xBC00], [0x3800, 0x3E00]],
    }

    lowered = lower_fp16_matmul_smoke(runtime, graph)

    assert lowered.lhs_q8_8 == [[256, 512], [128, -256]]
    assert lowered.rhs_q8_8 == [[512, -256], [128, 384]]
    assert lowered.result_q8_8 == lowered.golden_q8_8 == [[768, 512], [128, -512]]
    assert lowered.input_shape == [2, 2, 2]
    assert lowered.output_shape == [2, 2]
    assert lowered.scalar_mul_count == 8
    assert lowered.scalar_add_count == 8
    assert lowered.host_converts_float16_to_q8_8 is True
    assert lowered.host_requantizes_products is True
    assert lowered.cpu_fallback is False
    assert "fp16_matmul_q8_8_scalar_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [runtime.OP_MUL_LO, runtime.OP_ADD] * 8


def test_bf16_matmul_smoke_lowers_to_scalar_q8_8_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
    graph = {
        "schema": "eliza.e1_npu_bf16_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "bf16",
        "lhs": [[0x3F80, 0x4000], [0x3F00, 0xBF80]],
        "rhs": [[0x4000, 0xBF80], [0x3F00, 0x3FC0]],
    }

    lowered = lower_bf16_matmul_smoke(runtime, graph)

    assert lowered.lhs_q8_8 == [[256, 512], [128, -256]]
    assert lowered.rhs_q8_8 == [[512, -256], [128, 384]]
    assert lowered.result_q8_8 == lowered.golden_q8_8 == [[768, 512], [128, -512]]
    assert lowered.input_shape == [2, 2, 2]
    assert lowered.output_shape == [2, 2]
    assert lowered.scalar_mul_count == 8
    assert lowered.scalar_add_count == 8
    assert lowered.host_converts_float16_to_q8_8 is True
    assert lowered.host_requantizes_products is True
    assert lowered.cpu_fallback is False
    assert "bf16_matmul_q8_8_scalar_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [runtime.OP_MUL_LO, runtime.OP_ADD] * 8


def test_fp16_and_bf16_matmul_smoke_reject_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    fp16_base = {
        "schema": "eliza.e1_npu_fp16_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "fp16",
        "lhs": [[0x3C00]],
        "rhs": [[0x4000]],
    }
    bf16_base = {
        "schema": "eliza.e1_npu_bf16_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "bf16",
        "lhs": [[0x3F80]],
        "rhs": [[0x4000]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_fp16_matmul_smoke(runtime, {**fp16_base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported fp16_matmul source op"):
        lower_fp16_matmul_smoke(runtime, {**fp16_base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported fp16_matmul precision"):
        lower_fp16_matmul_smoke(runtime, {**fp16_base, "precision": "int8"})
    with pytest.raises(NpuLoweringError, match="K mismatch"):
        lower_fp16_matmul_smoke(
            runtime, {**fp16_base, "lhs": [[0x3C00, 0x4000]], "rhs": [[0x4000]]}
        )
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_fp16_matmul_smoke(runtime, {**fp16_base, "lhs": [[0x1_0000]]})
    with pytest.raises(NpuLoweringError, match="NaN/Inf"):
        lower_fp16_matmul_smoke(runtime, {**fp16_base, "lhs": [[0x7C00]]})

    with pytest.raises(NpuLoweringError, match="unsupported bf16_matmul source op"):
        lower_bf16_matmul_smoke(runtime, {**bf16_base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported bf16_matmul precision"):
        lower_bf16_matmul_smoke(runtime, {**bf16_base, "precision": "int8"})
    with pytest.raises(NpuLoweringError, match="NaN/Inf"):
        lower_bf16_matmul_smoke(runtime, {**bf16_base, "lhs": [[0x7F80]]})

    assert mmio.writes == []


def test_int2_matmul_smoke_lowers_to_dot16_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_int2_matmul_smoke(runtime, graph)

    assert lowered.result == [[-5, -1], [-13, 10]]
    assert lowered.golden == lowered.result
    assert lowered.abi_opcode == runtime.OP_DOT16_S2
    assert lowered.dot16_count == 8
    assert lowered.padded_k == 32
    assert lowered.host_pads_k_to_dot16 is True
    assert lowered.cpu_fallback is False
    assert "int2_matmul_dot16_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [runtime.OP_DOT16_S2] * 8


def test_int2_matmul_smoke_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_int2_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.int2_matmul",
        "precision": "int2",
        "lhs": [[1]],
        "rhs": [[-2]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_int2_matmul_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported int2_matmul source op"):
        lower_int2_matmul_smoke(runtime, {**base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported int2_matmul precision"):
        lower_int2_matmul_smoke(runtime, {**base, "precision": "int8"})
    with pytest.raises(NpuLoweringError, match="K mismatch"):
        lower_int2_matmul_smoke(runtime, {**base, "lhs": [[1, -1]], "rhs": [[1]]})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_int2_matmul_smoke(runtime, {**base, "lhs": [[2]]})

    assert mmio.writes == []


def test_sparse_int4_matmul_smoke_lowers_to_sdot4_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_sparse_int4_matmul_smoke(runtime, graph)

    assert lowered.result == [[0, 26], [16, 2]]
    assert lowered.golden == lowered.result
    assert lowered.abi_opcode == runtime.OP_SDOT4_S4_2_4
    assert lowered.sparse_block_count == 2
    assert lowered.sdot4_count == 8
    assert lowered.padded_k == 16
    assert lowered.host_pads_k_to_sparse_blocks is True
    assert lowered.host_uses_2_4_metadata is True
    assert lowered.cpu_fallback is False
    assert "sparse_int4_2_4_matmul_sdot4_smoke_only" in lowered.claim_boundary
    assert mmio.commands.count(runtime.OP_SDOT4_S4_2_4) == 8
    assert mmio.commands.count(runtime.OP_ADD) == 8


def test_stablehlo_materialized_sparse_int4_dot_graph_lowers_to_sdot4():
    runtime, mmio = make_completing_runtime()
    module = parse_module(
        {
            "schema": "eliza.e1_npu_stablehlo_subset.v1",
            "name": "sparse_int4_dot_import_smoke",
            "ops": [
                {
                    "op": "stablehlo.dot_general",
                    "name": "dot0",
                    "lhs_type": {"shape": [2, 3], "dtype": "sparse_int4_2_4"},
                    "rhs_type": {"shape": [3, 2], "dtype": "sparse_int4_2_4"},
                    "result_type": {"shape": [2, 2], "dtype": "sparse_int4_2_4"},
                    "precision": "sparse_int4_2_4",
                }
            ],
        }
    )
    graph = materialize_module_lowering_graphs(
        module,
        {
            "dot0": {
                "lhs": [[1, -2, 3, -4, 5, -6, 7, -8], [7, 6, 5, 4, 3, 2, 1, 0]],
                "rhs_nonzero": [
                    [[2, -3, 4, -5], [-1, 3, -2, 6]],
                ],
                "rhs_positions": [
                    [[0, 2, 1, 3], [1, 3, 0, 2]],
                ],
            }
        },
    )[0]

    lowered = lower_sparse_int4_matmul_smoke(runtime, graph)

    assert lowered.result == lowered.golden == [[9, 22], [7, 6]]
    assert lowered.source_dialect == "stablehlo"
    assert lowered.cpu_fallback is False
    assert mmio.commands.count(runtime.OP_SDOT4_S4_2_4) == 4


def test_sparse_int4_matmul_smoke_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_sparse_int4_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.sparse_int4_matmul",
        "precision": "sparse_int4",
        "lhs": [[1, -2, 3, -4, 5, -6, 7, -8]],
        "rhs_nonzero": [[[2, -3, 4, -5]]],
        "rhs_positions": [[[0, 2, 1, 3]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_sparse_int4_matmul_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported sparse_int4_matmul source op"):
        lower_sparse_int4_matmul_smoke(runtime, {**base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported sparse_int4_matmul precision"):
        lower_sparse_int4_matmul_smoke(runtime, {**base, "precision": "int8"})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_sparse_int4_matmul_smoke(runtime, {**base, "lhs": [[8]]})
    with pytest.raises(NpuLoweringError, match="requires distinct 2:4 positions"):
        lower_sparse_int4_matmul_smoke(runtime, {**base, "rhs_positions": [[[0, 0, 1, 2]]]})
    with pytest.raises(NpuLoweringError, match="unused sparse metadata blocks"):
        lower_sparse_int4_matmul_smoke(
            runtime,
            {
                **base,
                "lhs": [[1]],
                "rhs_nonzero": [[[1, 2, 3, 4]], [[1, 2, 3, 4]]],
                "rhs_positions": [[[0, 1, 0, 1]], [[0, 1, 0, 1]]],
            },
        )

    assert mmio.writes == []


def test_group_scaled_int4_matmul_smoke_applies_q8_8_scales_without_cpu_fallback():
    runtime, mmio = make_completing_runtime()
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

    lowered = lower_group_scaled_int4_matmul_smoke(runtime, graph)

    assert lowered.group_dot_products == [[[18, 7], [-7, 25]], [[-23, -7], [7, -23]]]
    assert lowered.result_q8_8 == lowered.golden_q8_8 == [[2752, -4992], [-3392, 4736]]
    assert lowered.input_shape == [2, 4, 2]
    assert lowered.output_shape == [2, 2]
    assert lowered.group_size == 2
    assert lowered.group_count == 2
    assert lowered.scalar_mul_count == 24
    assert lowered.scalar_add_count == 24
    assert lowered.host_applies_group_scales is True
    assert lowered.host_uses_q8_8_scales is True
    assert lowered.cpu_fallback is False
    assert "group_scaled_int4_matmul_q8_8_scalar_smoke_only" in lowered.claim_boundary
    assert mmio.commands == [runtime.OP_MUL_LO, runtime.OP_ADD] * 24


def test_stablehlo_materialized_group_scaled_int4_dot_graph_lowers_to_scalar_q8_8():
    runtime, mmio = make_completing_runtime()
    module = parse_module(
        {
            "schema": "eliza.e1_npu_stablehlo_subset.v1",
            "name": "group_scaled_int4_dot_import_smoke",
            "ops": [
                {
                    "op": "stablehlo.dot_general",
                    "name": "dot0",
                    "lhs_type": {"shape": [2, 3], "dtype": "int4_group_scaled"},
                    "rhs_type": {"shape": [3, 2], "dtype": "int4_group_scaled"},
                    "result_type": {"shape": [2, 2], "dtype": "int4_group_scaled"},
                    "precision": "int4_group_scaled",
                }
            ],
        }
    )
    graph = materialize_module_lowering_graphs(
        module,
        {
            "dot0": {
                "group_size": 2,
                "lhs": [[2, -3, 4], [-1, 5, -2]],
                "rhs": [[3, -2], [-4, 1], [2, 7]],
                "scales_q8_8": [[128, 256], [64, -128]],
            }
        },
    )[0]

    lowered = lower_group_scaled_int4_matmul_smoke(runtime, graph)

    assert lowered.result_q8_8 == lowered.golden_q8_8 == [[2816, -5376], [-3200, 3584]]
    assert lowered.source_dialect == "stablehlo"
    assert lowered.cpu_fallback is False
    assert mmio.commands == [runtime.OP_MUL_LO, runtime.OP_ADD] * 20


def test_group_scaled_int4_matmul_smoke_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_group_scaled_int4_matmul_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.group_scaled_int4_matmul",
        "precision": "int4_group_scaled",
        "group_size": 2,
        "lhs": [[1, -2]],
        "rhs": [[3], [-4]],
        "scales_q8_8": [[128]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_group_scaled_int4_matmul_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported group_scaled_int4_matmul source op"):
        lower_group_scaled_int4_matmul_smoke(runtime, {**base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported group_scaled_int4_matmul precision"):
        lower_group_scaled_int4_matmul_smoke(runtime, {**base, "precision": "int8"})
    with pytest.raises(NpuLoweringError, match="group_size must be positive"):
        lower_group_scaled_int4_matmul_smoke(runtime, {**base, "group_size": 0})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_group_scaled_int4_matmul_smoke(runtime, {**base, "rhs": [[8], [-4]]})
    with pytest.raises(NpuLoweringError, match="scale group mismatch"):
        lower_group_scaled_int4_matmul_smoke(runtime, {**base, "scales_q8_8": [[128], [64]]})
    with pytest.raises(NpuLoweringError, match="scale output-column mismatch"):
        lower_group_scaled_int4_matmul_smoke(runtime, {**base, "scales_q8_8": [[128, 64]]})

    assert mmio.writes == []


def test_conv2d_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_conv2d_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.convolution",
        "precision": "int8",
        "input": [[[[1]]]],
        "filter": [[[[1]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_conv2d_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported conv2d source op"):
        lower_conv2d_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported conv2d precision"):
        lower_conv2d_smoke(runtime, {**base, "precision": "fp8"})
    with pytest.raises(NpuLoweringError, match="VALID padding only"):
        lower_conv2d_smoke(runtime, {**base, "padding": "SAME"})
    with pytest.raises(NpuLoweringError, match="channel mismatch"):
        lower_conv2d_smoke(runtime, {**base, "input": [[[[1, 2]]]]})

    assert mmio.writes == []


def test_depthwise_conv2d_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_depthwise_conv2d_smoke.v1",
        "dialect": "tflite",
        "op": "tflite.depthwise_conv_2d",
        "precision": "int8",
        "input": [[[[1]]]],
        "filter": [[[[1]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_depthwise_conv2d_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported depthwise_conv2d source op"):
        lower_depthwise_conv2d_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported depthwise_conv2d precision"):
        lower_depthwise_conv2d_smoke(runtime, {**base, "precision": "fp8"})
    with pytest.raises(NpuLoweringError, match="VALID padding only"):
        lower_depthwise_conv2d_smoke(runtime, {**base, "padding": "SAME"})
    with pytest.raises(NpuLoweringError, match="channel mismatch"):
        lower_depthwise_conv2d_smoke(runtime, {**base, "input": [[[[1, 2]]]]})
    with pytest.raises(NpuLoweringError, match="input value 128 outside"):
        lower_depthwise_conv2d_smoke(runtime, {**base, "input": [[[[128]]]]})

    assert mmio.writes == []


def test_grouped_conv2d_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_grouped_conv2d_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.convolution",
        "precision": "int8",
        "groups": 2,
        "input": [[[[1, 2, 3, 4]]]],
        "filter": [[[[1, 1], [1, 1]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_grouped_conv2d_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported grouped_conv2d source op"):
        lower_grouped_conv2d_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported grouped_conv2d precision"):
        lower_grouped_conv2d_smoke(runtime, {**base, "precision": "fp8"})
    with pytest.raises(NpuLoweringError, match="groups greater than 1"):
        lower_grouped_conv2d_smoke(runtime, {**base, "groups": 1})
    with pytest.raises(NpuLoweringError, match="excludes depthwise groups"):
        lower_grouped_conv2d_smoke(runtime, {**base, "groups": 4})
    with pytest.raises(NpuLoweringError, match="VALID padding only"):
        lower_grouped_conv2d_smoke(runtime, {**base, "padding": "SAME"})
    with pytest.raises(NpuLoweringError, match="output channels must divide evenly"):
        lower_grouped_conv2d_smoke(runtime, {**base, "filter": [[[[1, 1, 1], [1, 1, 1]]]]})
    with pytest.raises(NpuLoweringError, match="input value 128 outside"):
        lower_grouped_conv2d_smoke(runtime, {**base, "input": [[[[128, 2, 3, 4]]]]})

    assert mmio.writes == []


def test_silu_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_silu_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.silu",
        "precision": "int8",
        "input": [[0]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_silu_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported silu source op"):
        lower_silu_smoke(runtime, {**base, "op": "stablehlo.tanh"})
    with pytest.raises(NpuLoweringError, match="unsupported silu precision"):
        lower_silu_smoke(runtime, {**base, "precision": "fp16"})
    with pytest.raises(NpuLoweringError, match="unsupported silu approximation"):
        lower_silu_smoke(runtime, {**base, "approximation": "exact_sigmoid"})
    with pytest.raises(NpuLoweringError, match="input value 128 outside"):
        lower_silu_smoke(runtime, {**base, "input": [[128]]})

    assert mmio.writes == []


def test_gelu_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_gelu_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.gelu",
        "precision": "int8",
        "input": [[0]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_gelu_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported gelu source op"):
        lower_gelu_smoke(runtime, {**base, "op": "stablehlo.tanh"})
    with pytest.raises(NpuLoweringError, match="unsupported gelu precision"):
        lower_gelu_smoke(runtime, {**base, "precision": "fp16"})
    with pytest.raises(NpuLoweringError, match="unsupported gelu approximation"):
        lower_gelu_smoke(runtime, {**base, "approximation": "exact_erf"})
    with pytest.raises(NpuLoweringError, match="input value 128 outside"):
        lower_gelu_smoke(runtime, {**base, "input": [[128]]})

    assert mmio.writes == []


def test_attention_qk_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_attention_qk_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.dot_general",
        "precision": "int8",
        "query": [[[[1]]]],
        "key": [[[[1]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_attention_qk_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported attention_qk source op"):
        lower_attention_qk_smoke(runtime, {**base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported attention_qk precision"):
        lower_attention_qk_smoke(runtime, {**base, "precision": "fp8"})
    with pytest.raises(NpuLoweringError, match="head_dim mismatch"):
        lower_attention_qk_smoke(runtime, {**base, "key": [[[[1, 2]]]]})
    with pytest.raises(NpuLoweringError, match="head mismatch"):
        lower_attention_qk_smoke(runtime, {**base, "key": [[[[1]], [[2]]]]})

    assert mmio.writes == []


def test_attention_av_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_attention_av_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.attention_av",
        "precision": "int8",
        "attention": [[[[1]]]],
        "value": [[[[1]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_attention_av_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported attention_av source op"):
        lower_attention_av_smoke(runtime, {**base, "op": "stablehlo.convolution"})
    with pytest.raises(NpuLoweringError, match="unsupported attention_av precision"):
        lower_attention_av_smoke(runtime, {**base, "precision": "fp8"})
    with pytest.raises(NpuLoweringError, match="key/value token mismatch"):
        lower_attention_av_smoke(runtime, {**base, "attention": [[[[1, 2]]]]})
    with pytest.raises(NpuLoweringError, match="head mismatch"):
        lower_attention_av_smoke(runtime, {**base, "value": [[[[1]], [[2]]]]})

    assert mmio.writes == []


def test_attention_softmax_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_attention_softmax_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.attention_softmax",
        "precision": "int8",
        "logits": [[[[1]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_attention_softmax_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported attention_softmax source op"):
        lower_attention_softmax_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported attention_softmax precision"):
        lower_attention_softmax_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="mask key-token mismatch"):
        lower_attention_softmax_smoke(runtime, {**base, "mask": [[[[True, False]]]]})
    with pytest.raises(NpuLoweringError, match="unmasked key"):
        lower_attention_softmax_smoke(runtime, {**base, "mask": [[[[False]]]]})
    with pytest.raises(NpuLoweringError, match="delta range"):
        lower_attention_softmax_smoke(runtime, {**base, "logits": [[[[127, -2]]]]})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_attention_softmax_smoke(runtime, {**base, "logits": [[[[128]]]]})

    assert mmio.writes == []


def test_attention_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_attention_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.attention",
        "precision": "int8",
        "query": [[[[1, 2]]]],
        "key": [[[[1, 2]]]],
        "value": [[[[3, 4]]]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_attention_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported attention source op"):
        lower_attention_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported attention precision"):
        lower_attention_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="unsupported attention mask_mode"):
        lower_attention_smoke(runtime, {**base, "mask_mode": "block_sparse"})
    with pytest.raises(NpuLoweringError, match="mask_window must be positive"):
        lower_attention_smoke(runtime, {**base, "mask_mode": "sliding_window", "mask_window": 0})
    with pytest.raises(NpuLoweringError, match="head_dim mismatch"):
        lower_attention_smoke(runtime, {**base, "key": [[[[1]]]]})
    with pytest.raises(NpuLoweringError, match="attention_softmax mask key-token mismatch"):
        lower_attention_smoke(runtime, {**base, "mask": [[[[True, False]]]]})
    with pytest.raises(NpuLoweringError, match="attention shifts must be in 0..31"):
        lower_attention_smoke(runtime, {**base, "context_shift": 32})

    assert mmio.writes == []


def test_kv_cache_update_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_kv_cache_update_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.kv_cache_update",
        "precision": "int8",
        "key_cache": [[[[0], [0]]]],
        "value_cache": [[[[0], [0]]]],
        "new_key": [[[[1]]]],
        "new_value": [[[[1]]]],
        "cache_lengths": [[1]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_kv_cache_update_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported kv_cache_update source op"):
        lower_kv_cache_update_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported kv_cache_update precision"):
        lower_kv_cache_update_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="exceeds cache capacity"):
        lower_kv_cache_update_smoke(runtime, {**base, "cache_lengths": [[2]]})
    with pytest.raises(NpuLoweringError, match="new key/value token mismatch"):
        lower_kv_cache_update_smoke(runtime, {**base, "new_value": [[[[1], [2]]]]})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_kv_cache_update_smoke(runtime, {**base, "new_key": [[[[128]]]]})

    assert mmio.writes == []


def test_transformer_mlp_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_mlp_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.transformer_mlp",
        "precision": "int8",
        "activation": "relu",
        "input": [[1]],
        "up_weight": [[1]],
        "down_weight": [[1]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_mlp_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported mlp source op"):
        lower_mlp_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported mlp precision"):
        lower_mlp_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="unsupported mlp activation"):
        lower_mlp_smoke(runtime, {**base, "activation": "gelu"})
    with pytest.raises(NpuLoweringError, match="requant_shift must be in 0..31"):
        lower_mlp_smoke(runtime, {**base, "requant_shift": 32})
    with pytest.raises(NpuLoweringError, match="hidden K mismatch"):
        lower_mlp_smoke(runtime, {**base, "down_weight": [[1], [2]]})

    assert mmio.writes == []


def test_swiglu_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_swiglu_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.swiglu",
        "precision": "int8",
        "activation": "linear_gate",
        "input": [[1]],
        "up_weight": [[1]],
        "gate_weight": [[1]],
        "down_weight": [[1]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_swiglu_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported swiglu source op"):
        lower_swiglu_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported swiglu precision"):
        lower_swiglu_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="unsupported swiglu activation"):
        lower_swiglu_smoke(runtime, {**base, "activation": "gelu"})
    with pytest.raises(NpuLoweringError, match="swiglu shifts must be in 0..31"):
        lower_swiglu_smoke(runtime, {**base, "gate_shift": 32})
    with pytest.raises(NpuLoweringError, match="gate width mismatch"):
        lower_swiglu_smoke(runtime, {**base, "gate_weight": [[1, 2]]})
    with pytest.raises(NpuLoweringError, match="down K mismatch"):
        lower_swiglu_smoke(runtime, {**base, "down_weight": [[1], [2]]})

    assert mmio.writes == []


def test_residual_add_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_residual_add_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.add",
        "precision": "int8",
        "lhs": [[1]],
        "rhs": [[1]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_residual_add_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported residual_add source op"):
        lower_residual_add_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported residual_add precision"):
        lower_residual_add_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="shape mismatch"):
        lower_residual_add_smoke(runtime, {**base, "rhs": [[1, 2]]})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_residual_add_smoke(runtime, {**base, "lhs": [[128]]})

    assert mmio.writes == []


def test_bias_add_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_bias_add_smoke.v1",
        "dialect": "stablehlo",
        "op": "stablehlo.add",
        "precision": "int8",
        "input": [[1]],
        "bias": [1],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_bias_add_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported bias_add source op"):
        lower_bias_add_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported bias_add precision"):
        lower_bias_add_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="width mismatch"):
        lower_bias_add_smoke(runtime, {**base, "bias": [1, 2]})
    with pytest.raises(NpuLoweringError, match="outside range"):
        lower_bias_add_smoke(runtime, {**base, "bias": [128]})

    assert mmio.writes == []


def test_decode_attention_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_decode_attention_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.decode_attention",
        "precision": "int8",
        "query": [[[[1]]]],
        "key_cache": [[[[0], [0]]]],
        "value_cache": [[[[0], [0]]]],
        "new_key": [[[[1]]]],
        "new_value": [[[[1]]]],
        "cache_lengths": [[1]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_decode_attention_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported decode_attention source op"):
        lower_decode_attention_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported decode_attention precision"):
        lower_decode_attention_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="head_dim mismatch"):
        lower_decode_attention_smoke(runtime, {**base, "key_cache": [[[[0, 1], [0, 1]]]]})
    with pytest.raises(NpuLoweringError, match="append exceeds cache capacity"):
        lower_decode_attention_smoke(runtime, {**base, "cache_lengths": [[2]]})
    with pytest.raises(NpuLoweringError, match="decode_attention shifts must be in 0..31"):
        lower_decode_attention_smoke(runtime, {**base, "context_shift": 32})
    with pytest.raises(NpuLoweringError, match="cache_window must be positive"):
        lower_decode_attention_smoke(runtime, {**base, "cache_window": 0})

    assert mmio.writes == []


def test_transformer_block_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_transformer_block_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.transformer_block",
        "precision": "int8",
        "input": [[1]],
        "attention": [[[[1]]]],
        "value": [[[[1]]]],
        "attention_bias": [0],
        "mlp_up_weight": [[1]],
        "mlp_down_weight": [[1]],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_transformer_block_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported transformer_block source op"):
        lower_transformer_block_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported transformer_block precision"):
        lower_transformer_block_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="batch=1 and heads=1"):
        lower_transformer_block_smoke(
            runtime, {**base, "attention": [[[[1]], [[1]]]], "value": [[[[1]], [[1]]]]}
        )
    with pytest.raises(NpuLoweringError, match="attention_bias mismatch"):
        lower_transformer_block_smoke(runtime, {**base, "attention_bias": [0, 1]})
    with pytest.raises(NpuLoweringError, match="mlp output mismatch"):
        lower_transformer_block_smoke(runtime, {**base, "mlp_down_weight": [[1, 2]]})

    assert mmio.writes == []


def test_modern_decoder_block_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_modern_decoder_block_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.decoder_block",
        "precision": "int8",
        "input": [[1, 2], [3, 4]],
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

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_modern_decoder_block_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported modern_decoder_block source op"):
        lower_modern_decoder_block_smoke(runtime, {**base, "op": "stablehlo.dot_general"})
    with pytest.raises(NpuLoweringError, match="unsupported modern_decoder_block precision"):
        lower_modern_decoder_block_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(
        NpuLoweringError, match="unsupported modern_decoder_block attention_mask_mode"
    ):
        lower_modern_decoder_block_smoke(runtime, {**base, "attention_mask_mode": "block_sparse"})
    with pytest.raises(NpuLoweringError, match="attention_mask_window must be positive"):
        lower_modern_decoder_block_smoke(
            runtime, {**base, "attention_mask_mode": "sliding_window", "attention_mask_window": 0}
        )
    with pytest.raises(NpuLoweringError, match="even model dimension"):
        lower_modern_decoder_block_smoke(runtime, {**base, "input": [[1], [2]]})
    with pytest.raises(NpuLoweringError, match="attention_mask must be"):
        lower_modern_decoder_block_smoke(runtime, {**base, "attention_mask": [[[[True]]]]})
    with pytest.raises(NpuLoweringError, match="q_weight output mismatch"):
        lower_modern_decoder_block_smoke(runtime, {**base, "q_weight": [[1], [1]]})
    with pytest.raises(
        NpuLoweringError, match="unsupported modern_decoder_block swiglu_activation"
    ):
        lower_modern_decoder_block_smoke(runtime, {**base, "swiglu_activation": "gelu"})
    with pytest.raises(NpuLoweringError, match="modern_decoder_block shifts must be in 0..31"):
        lower_modern_decoder_block_smoke(runtime, {**base, "projection_shift": 32})

    assert mmio.writes == []


def test_rope_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_rope_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.rope",
        "precision": "int8",
        "input": [[1, 2]],
        "cos": [127],
        "sin": [0],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_rope_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported rope source op"):
        lower_rope_smoke(runtime, {**base, "op": "stablehlo.add"})
    with pytest.raises(NpuLoweringError, match="unsupported rope precision"):
        lower_rope_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="even non-empty"):
        lower_rope_smoke(runtime, {**base, "input": [[1, 2, 3]]})
    with pytest.raises(NpuLoweringError, match="cos width mismatch"):
        lower_rope_smoke(runtime, {**base, "cos": [127, 0]})
    with pytest.raises(NpuLoweringError, match="sin width mismatch"):
        lower_rope_smoke(runtime, {**base, "sin": [0, 1]})
    with pytest.raises(NpuLoweringError, match="cos"):
        lower_rope_smoke(runtime, {**base, "cos": [128]})

    assert mmio.writes == []


def test_rmsnorm_smoke_lowering_rejects_unsupported_graphs_before_touching_mmio():
    runtime, mmio = make_runtime()
    base = {
        "schema": "eliza.e1_npu_rmsnorm_smoke.v1",
        "dialect": "stablehlo",
        "op": "eliza.rms_norm",
        "precision": "int8",
        "input": [[1, 2]],
        "weight": [64, 64],
    }

    with pytest.raises(NpuLoweringError, match="unsupported graph schema"):
        lower_rmsnorm_smoke(runtime, {**base, "schema": "other"})
    with pytest.raises(NpuLoweringError, match="unsupported rmsnorm source op"):
        lower_rmsnorm_smoke(runtime, {**base, "op": "stablehlo.add"})
    with pytest.raises(NpuLoweringError, match="unsupported rmsnorm precision"):
        lower_rmsnorm_smoke(runtime, {**base, "precision": "int4"})
    with pytest.raises(NpuLoweringError, match="weight width mismatch"):
        lower_rmsnorm_smoke(runtime, {**base, "weight": [64]})
    with pytest.raises(NpuLoweringError, match="input"):
        lower_rmsnorm_smoke(runtime, {**base, "input": [[129, 2]]})
    with pytest.raises(NpuLoweringError, match="weight"):
        lower_rmsnorm_smoke(runtime, {**base, "weight": [64, 128]})
    with pytest.raises(NpuLoweringError, match="epsilon"):
        lower_rmsnorm_smoke(runtime, {**base, "epsilon": -1})

    assert mmio.writes == []


def test_activation_rejects_invalid_inputs_before_touching_mmio():
    runtime, mmio = make_runtime()
    with pytest.raises(ValueError, match="exactly four"):
        runtime.relu4_s8([1, 2, 3])
    with pytest.raises(ValueError, match="outside signed INT8 range"):
        runtime.relu4_s8([0, 1, 2, 128])
    with pytest.raises(ValueError, match="1..64"):
        runtime.vrelu_s8([])
    with pytest.raises(ValueError, match="outside signed INT8 range"):
        runtime.vrelu_s8([0, -129])

    assert mmio.writes == []


def test_sparse_dot_rejects_invalid_metadata_before_touching_mmio():
    runtime, mmio = make_runtime()
    with pytest.raises(ValueError, match="exactly four"):
        runtime.sdot4_s4_2_4([1, 2, 3], [0] * 8, [0, 1, 0, 1])
    with pytest.raises(ValueError, match="exactly eight"):
        runtime.sdot4_s4_2_4([1, 2, 3, 4], [0] * 7, [0, 1, 0, 1])
    with pytest.raises(ValueError, match="outside signed INT4 range"):
        runtime.sdot4_s4_2_4([1, 2, 3, 8], [0] * 8, [0, 1, 0, 1])
    with pytest.raises(ValueError, match="two distinct"):
        runtime.sdot4_s4_2_4([1, 2, 3, 4], [0] * 8, [0, 0, 1, 2])

    assert mmio.writes == []


def test_dot16_s2_rejects_invalid_inputs_before_touching_mmio():
    runtime, mmio = make_runtime()
    with pytest.raises(ValueError, match="exactly sixteen"):
        runtime.dot16_s2([0] * 15, [0] * 16)
    with pytest.raises(ValueError, match="outside signed INT2 range"):
        runtime.dot16_s2([0] * 15 + [2], [0] * 16)

    assert mmio.writes == []


def test_dot4_fp8_e4m3_rejects_invalid_inputs_before_touching_mmio():
    runtime, mmio = make_runtime()
    with pytest.raises(ValueError, match="exactly four"):
        runtime.dot4_fp8_e4m3([0] * 3, [0] * 4)
    with pytest.raises(ValueError, match="raw 8-bit FP8"):
        runtime.dot4_fp8_e4m3([0, 1, 2, 256], [0] * 4)

    assert mmio.writes == []
