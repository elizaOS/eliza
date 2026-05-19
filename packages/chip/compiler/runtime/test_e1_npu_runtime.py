import pytest
from e1_npu_runtime import (
    E1NpuRuntime,
    NpuDescriptorSubmission,
    NpuRuntimeError,
    NpuStreamDescriptor,
    NpuTimeoutError,
    golden_gemm_s8,
)


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
        elif opcode == self.runtime_cls.OP_GEMM_S8:
            self._complete_gemm()
        else:
            self.regs[self.runtime_cls.CTRL_STATUS] = 0x4
            return
        self.regs[self.runtime_cls.CTRL_STATUS] = 0x2

    def _read_scratch_byte(self, offset):
        word = self.regs.get(self.runtime_cls.SCRATCH + (offset & ~0x3), 0)
        return (word >> (8 * (offset & 0x3))) & 0xFF

    def _write_scratch_i32(self, offset, value):
        self.regs[self.runtime_cls.SCRATCH + offset] = value & 0xFFFF_FFFF

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
                    a = self._s8(self._read_scratch_byte(a_base + row * a_stride + kk))
                    b = self._s8(self._read_scratch_byte(b_base + kk * b_stride + col))
                    acc += a * b
                    macs += 1
                self._write_scratch_i32(c_base + row * c_stride + col * 4, acc)
        self.regs[self.runtime_cls.PERF_CYCLES] = (
            self.regs.get(self.runtime_cls.PERF_CYCLES, 0) + macs
        )
        self.regs[self.runtime_cls.PERF_MACS] = self.regs.get(self.runtime_cls.PERF_MACS, 0) + macs


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


def test_scalar_commands_program_mmio_and_return_completed_results():
    runtime, mmio = make_completing_runtime()

    assert runtime.add(0xFFFF_FFFE, 5) == 3
    assert runtime.sub(2, 5) == 0xFFFF_FFFD
    assert runtime.mul_lo(0x1_0001, 0x1_0001) == 0x0002_0001
    assert runtime.mac_s16(0xFFFF, 3, 10) == 7
    assert runtime.dot4_s8(0x04_03_FE_01, 0xFD_02_05_06, 1) == (1 + 6 - 10 + 6 - 12) & 0xFFFF_FFFF

    assert mmio.commands == [
        runtime.OP_ADD,
        runtime.OP_SUB,
        runtime.OP_MUL_LO,
        runtime.OP_MAC_S16,
        runtime.OP_DOT4_S8,
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

    with pytest.raises(ValueError, match="32-bit aligned"):
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
    for precision in ("FP16", "BF16", "FP8"):
        assert matrix[precision]["state"] == "blocked"
        assert "no opcode" in matrix[precision]["path"]


def test_gemm_s8_programs_scratchpad_and_matches_golden_model():
    runtime, mmio = make_completing_runtime()
    a = [[1, -2, 3], [4, 5, -6]]
    b = [[7, -8], [9, 10], [-11, 12]]

    assert runtime.gemm_s8(a, b) == golden_gemm_s8(a, b)
    assert mmio.commands[-1] == runtime.OP_GEMM_S8
    assert mmio.regs[runtime.GEMM_CFG] == 2 | (2 << 8) | (3 << 16)
    assert mmio.regs[runtime.PERF_MACS] == 12


def test_gemm_s8_rejects_invalid_tiles_before_touching_mmio():
    runtime, mmio = make_runtime()
    with pytest.raises(ValueError, match="prototype limits"):
        runtime.gemm_s8([[1] * 8], [[1]])
    with pytest.raises(ValueError, match="outside signed INT8 range"):
        runtime.gemm_s8([[128]], [[1]])
    with pytest.raises(ValueError, match="ragged"):
        runtime.gemm_s8([[1], [1, 2]], [[1]])

    assert mmio.writes == []
