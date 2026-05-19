#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e1_npu_runtime import E1NpuRuntime, NpuDescriptorSubmission, golden_gemm_s8


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

    def _scratch_write_s32(self, offset: int, value: int) -> None:
        self.regs[self.runtime.SCRATCH + offset] = value & 0xFFFF_FFFF

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
        if opcode == self.runtime.OP_DOT8_S4:
            self.regs[self.runtime.RESULT] = 0
            self.regs[self.runtime.RESULT_HI] = 0
            self.regs[self.runtime.CTRL_STATUS] = 0x2
            return
        if opcode != self.runtime.OP_GEMM_S8:
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

    def test_runtime_rejects_tiles_outside_local_prototype_limits(self):
        sim = E1NpuMmioSim()
        with self.assertRaisesRegex(ValueError, "prototype limits"):
            sim.runtime.gemm_s8(
                [[1, 2, 3, 4, 5, 6, 7, 8]], [[1], [1], [1], [1], [1], [1], [1], [1]]
            )

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
