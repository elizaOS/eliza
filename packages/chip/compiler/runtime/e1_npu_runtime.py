from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

Read32 = Callable[[int], int]
Write32 = Callable[[int, int], None]


class NpuPrecisionState(StrEnum):
    SUPPORTED = "supported"
    RESERVED = "reserved"
    BLOCKED = "blocked"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class NpuPrecisionSupport:
    precision: str
    state: NpuPrecisionState
    path: str
    evidence: str

    def as_dict(self) -> dict[str, str]:
        return {
            "precision": self.precision,
            "state": self.state.value,
            "path": self.path,
            "evidence": self.evidence,
        }


@dataclass(frozen=True)
class NpuRuntimeStatus:
    ok: bool
    status: int
    polls: int
    error: str | None = None
    desc_status: int | None = None
    perf: dict[str, int] | None = None


@dataclass(frozen=True)
class NpuDescriptorSubmission:
    base: int
    head: int
    tail: int
    timeout_polls: int = 1024


@dataclass(frozen=True)
class NpuStreamDescriptor:
    """Four-word local RTL descriptor used by the prototype stream path."""

    opcode: int
    source_addr: int
    scratch_offset: int
    byte_count: int
    op_b: int = 0
    acc: int = 0
    valid_owner: bool = True
    writeback_request: bool = False

    def words(self) -> tuple[int, int, int, int]:
        return (
            E1NpuRuntime.pack_stream_descriptor_word0(
                self.opcode,
                self.scratch_offset,
                self.byte_count,
                valid_owner=self.valid_owner,
                writeback_request=self.writeback_request,
            ),
            self.source_addr & 0xFFFF_FFFF,
            self.op_b & 0xFFFF_FFFF,
            self.acc & 0xFFFF_FFFF,
        )


class NpuRuntimeError(RuntimeError):
    def __init__(self, message: str, status: NpuRuntimeStatus):
        super().__init__(message)
        self.status = status


class NpuTimeoutError(TimeoutError):
    def __init__(self, message: str, status: NpuRuntimeStatus):
        super().__init__(message)
        self.status = status


class E1NpuRuntime:
    """Reference runtime for the e1 NPU MMIO contract."""

    OP_A = 0x1002_0000
    OP_B = 0x1002_0004
    RESULT = 0x1002_0008
    CTRL_STATUS = 0x1002_000C
    OPCODE = 0x1002_0010
    ACC = 0x1002_0014
    RESULT_HI = 0x1002_0018
    DEBUG = 0x1002_001C
    GEMM_CFG = 0x1002_0020
    GEMM_BASE = 0x1002_0024
    GEMM_STRIDE = 0x1002_0028
    PERF_UNSUPPORTED_OPS = 0x1002_002C
    CMD_PARAM = 0x1002_0030
    DESC_BASE = 0x1002_0040
    DESC_HEAD = 0x1002_0044
    DESC_TAIL = 0x1002_0048
    DESC_STATUS = 0x1002_004C
    PERF_CYCLES = 0x1002_0050
    PERF_MACS = 0x1002_0054
    PERF_OPS = 0x1002_0058
    PERF_ERRORS = 0x1002_005C
    DESC_TIMEOUT_COUNT = 0x1002_0060
    DESC_BYTES_READ = 0x1002_0064
    DESC_BYTES_WRITTEN = 0x1002_0068
    DESC_READ_BEATS = 0x1002_006C
    DESC_WRITE_BEATS = 0x1002_0070
    SCRATCH = 0x1002_0080
    SCRATCH_BYTES = 64

    OP_ADD = 0
    OP_SUB = 1
    OP_MUL_LO = 2
    OP_MAC_S16 = 3
    OP_DOT4_S8 = 4
    OP_MAX_U32 = 5
    OP_MIN_U32 = 6
    OP_DOT8_S4 = 7
    OP_GEMM_S8 = 8
    DESC_RING_ENTRIES = 8
    DESC_STATUS_EMPTY = 0x1
    DESC_STATUS_DONE = 0x2
    DESC_STATUS_ERROR = 0x4
    DESC_STATUS_TIMEOUT = 0x8
    DESC_STATUS_MEM_ERROR = 0x10
    DESC_STATUS_STREAM_ERROR = 0x20
    DESC_STATUS_OWNER_ERROR = 0x40
    DESC_STATUS_WRITEBACK_UNSUPPORTED = 0x80
    DESC_FLAG_STREAM_TO_SCRATCH = 1 << 8
    DESC_FLAG_WRITEBACK_REQUEST = 1 << 30
    DESC_FLAG_VALID_OWNER = 1 << 31

    PRECISION_MATRIX = (
        NpuPrecisionSupport(
            "INT8",
            NpuPrecisionState.SUPPORTED,
            "DOT4_S8 and bounded GEMM_S8 through 64-byte MMIO scratchpad",
            "runtime tests plus e1-npu-runtime-contract.json",
        ),
        NpuPrecisionSupport(
            "INT4",
            NpuPrecisionState.SUPPORTED,
            "DOT8_S4 packed dot prototype only; no tensor GEMM/compiler path",
            "runtime opcode coverage only",
        ),
        NpuPrecisionSupport(
            "FP16",
            NpuPrecisionState.BLOCKED,
            "no opcode, RTL datapath, compiler lowering, or measured benchmark path",
            "blocked until hardware/runtime tests identify execution path",
        ),
        NpuPrecisionSupport(
            "BF16",
            NpuPrecisionState.BLOCKED,
            "no opcode, RTL datapath, compiler lowering, or measured benchmark path",
            "blocked until hardware/runtime tests identify execution path",
        ),
        NpuPrecisionSupport(
            "FP8",
            NpuPrecisionState.BLOCKED,
            "no opcode, RTL datapath, compiler lowering, or measured benchmark path",
            "blocked until hardware/runtime tests identify execution path",
        ),
    )

    def __init__(self, read32: Read32, write32: Write32):
        self.read32 = read32
        self.write32 = write32

    def _poll_status(self, timeout_polls: int, error_prefix: str) -> NpuRuntimeStatus:
        if timeout_polls <= 0:
            raise ValueError("timeout_polls must be positive")
        for poll in range(1, timeout_polls + 1):
            status = self.read32(self.CTRL_STATUS)
            if status & 0x4:
                runtime_status = NpuRuntimeStatus(
                    ok=False,
                    status=status,
                    polls=poll,
                    error="rejected",
                    desc_status=self.read32(self.DESC_STATUS),
                    perf=self.perf(),
                )
                raise NpuRuntimeError(
                    f"{error_prefix} rejected: ctrl_status=0x{status:08x}",
                    runtime_status,
                )
            if status & 0x2:
                return NpuRuntimeStatus(ok=True, status=status, polls=poll, perf=self.perf())
        status = self.read32(self.CTRL_STATUS)
        runtime_status = NpuRuntimeStatus(
            ok=False,
            status=status,
            polls=timeout_polls,
            error="timeout",
            desc_status=self.read32(self.DESC_STATUS),
            perf=self.perf(),
        )
        raise NpuTimeoutError(
            f"{error_prefix} did not complete after {timeout_polls} polls: ctrl_status=0x{status:08x}",
            runtime_status,
        )

    def run(self, opcode: int, a: int, b: int, acc: int = 0, timeout_polls: int = 1024) -> int:
        self.write32(self.CMD_PARAM, 0)
        self.write32(self.OP_A, a & 0xFFFF_FFFF)
        self.write32(self.OP_B, b & 0xFFFF_FFFF)
        self.write32(self.ACC, acc & 0xFFFF_FFFF)
        self.write32(self.OPCODE, opcode & 0xF)
        self.write32(self.CTRL_STATUS, 2)
        self.write32(self.CTRL_STATUS, 1)
        self._poll_status(timeout_polls, "e1 NPU command")
        return self.read32(self.RESULT)

    def add(self, a: int, b: int) -> int:
        return self.run(self.OP_ADD, a, b)

    def sub(self, a: int, b: int) -> int:
        return self.run(self.OP_SUB, a, b)

    def mul_lo(self, a: int, b: int) -> int:
        return self.run(self.OP_MUL_LO, a, b)

    def mac_s16(self, a: int, b: int, acc: int = 0) -> int:
        return self.run(self.OP_MAC_S16, a, b, acc)

    def dot4_s8(self, a_packed: int, b_packed: int, acc: int = 0) -> int:
        return self.run(self.OP_DOT4_S8, a_packed, b_packed, acc)

    def dot8_s4(self, a_packed: int, b_packed: int, acc: int = 0) -> int:
        return self.run(self.OP_DOT8_S4, a_packed, b_packed, acc)

    def clear_perf(self):
        self.write32(self.PERF_ERRORS, 1)

    def perf(self) -> dict:
        return {
            "cycles": self.read32(self.PERF_CYCLES),
            "macs": self.read32(self.PERF_MACS),
            "ops": self.read32(self.PERF_OPS),
            "errors": self.read32(self.PERF_ERRORS),
            "unsupported_ops": self.read32(self.PERF_UNSUPPORTED_OPS),
        }

    def precision_matrix(self) -> list[dict[str, str]]:
        return [entry.as_dict() for entry in self.PRECISION_MATRIX]

    def descriptor_counters(self) -> dict[str, int]:
        return {
            "status": self.read32(self.DESC_STATUS),
            "head": self.read32(self.DESC_HEAD),
            "tail": self.read32(self.DESC_TAIL),
            "timeout_count": self.read32(self.DESC_TIMEOUT_COUNT),
            "bytes_read": self.read32(self.DESC_BYTES_READ),
            "bytes_written": self.read32(self.DESC_BYTES_WRITTEN),
            "read_beats": self.read32(self.DESC_READ_BEATS),
            "write_beats": self.read32(self.DESC_WRITE_BEATS),
        }

    def submit_descriptors(self, submission: NpuDescriptorSubmission) -> NpuRuntimeStatus:
        """Program the RTL descriptor ring and wait for hardware completion proof."""
        if submission.base & 0x3:
            raise ValueError("descriptor base must be 32-bit aligned")
        if submission.head < 0 or submission.tail < 0:
            raise ValueError("descriptor head/tail must be non-negative")
        if submission.head >= self.DESC_RING_ENTRIES or submission.tail >= self.DESC_RING_ENTRIES:
            raise ValueError("descriptor head/tail exceed RTL 3-bit queue window")
        if submission.head == submission.tail:
            raise ValueError("descriptor submission requires at least one queued descriptor")
        self.write32(self.DESC_BASE, submission.base & 0xFFFF_FFFF)
        self.write32(self.DESC_HEAD, submission.head & 0xFFFF_FFFF)
        self.write32(self.DESC_TAIL, submission.tail & 0xFFFF_FFFF)
        self.write32(self.CMD_PARAM, 1)
        self.write32(self.CTRL_STATUS, 2)
        self.write32(self.CTRL_STATUS, 1)
        runtime_status = self._poll_status(submission.timeout_polls, "e1 NPU descriptor submission")
        desc_status = self.read32(self.DESC_STATUS)
        runtime_status = NpuRuntimeStatus(
            ok=bool(desc_status & self.DESC_STATUS_DONE)
            and not bool(desc_status & self.DESC_STATUS_ERROR),
            status=runtime_status.status,
            polls=runtime_status.polls,
            error=None,
            desc_status=desc_status,
            perf=runtime_status.perf,
        )
        if not runtime_status.ok:
            raise NpuRuntimeError(
                f"e1 NPU descriptor submission failed: desc_status=0x{desc_status:08x}",
                runtime_status,
            )
        return runtime_status

    @classmethod
    def pack_stream_descriptor_word0(
        cls,
        opcode: int,
        scratch_offset: int,
        byte_count: int,
        *,
        valid_owner: bool = True,
        writeback_request: bool = False,
    ) -> int:
        """Pack descriptor word 0 for memory-to-scratchpad prefetch plus command launch."""
        if opcode < 0 or opcode > 0xF:
            raise ValueError("descriptor opcode must fit in 4 bits")
        if scratch_offset < 0 or scratch_offset > 63 or scratch_offset & 0x3:
            raise ValueError("descriptor scratch offset must be 32-bit aligned within scratchpad")
        if byte_count <= 0 or byte_count > 63 or byte_count & 0x3:
            raise ValueError("descriptor byte count must be a positive aligned value below 64")
        if scratch_offset + byte_count > cls.SCRATCH_BYTES:
            raise ValueError("descriptor stream exceeds 64-byte NPU scratchpad")
        word0 = (
            (opcode & 0xF)
            | cls.DESC_FLAG_STREAM_TO_SCRATCH
            | ((scratch_offset & 0x3F) << 16)
            | ((byte_count & 0x3F) << 24)
        )
        if writeback_request:
            word0 |= cls.DESC_FLAG_WRITEBACK_REQUEST
        if valid_owner:
            word0 |= cls.DESC_FLAG_VALID_OWNER
        return word0

    def write_scratch(self, offset: int, data: bytes):
        if offset < 0 or offset + len(data) > self.SCRATCH_BYTES:
            raise ValueError("scratch write exceeds 64-byte NPU scratchpad")
        if not data:
            return
        first_word = offset // 4
        last_word = (offset + len(data) - 1) // 4
        base = first_word * 4
        padded = bytearray()
        for word in range(first_word, last_word + 1):
            padded.extend(self.read32(self.SCRATCH + word * 4).to_bytes(4, "little"))
        relative_offset = offset - base
        padded[relative_offset : relative_offset + len(data)] = data
        for word in range(first_word, last_word + 1):
            start = (word - first_word) * 4
            value = int.from_bytes(padded[start : start + 4], "little")
            self.write32(self.SCRATCH + word * 4, value)

    def read_scratch(self, offset: int, size: int) -> bytes:
        if offset < 0 or offset + size > self.SCRATCH_BYTES:
            raise ValueError("scratch read exceeds 64-byte NPU scratchpad")
        if size == 0:
            return b""
        first_word = offset // 4
        last_word = (offset + size - 1) // 4
        data = bytearray()
        for word in range(first_word, last_word + 1):
            data.extend(self.read32(self.SCRATCH + word * 4).to_bytes(4, "little"))
        relative_offset = offset - first_word * 4
        return bytes(data[relative_offset : relative_offset + size])

    def gemm_s8(self, a, b):
        """Run bounded INT8 GEMM, returning an MxN int32 matrix.

        Prototype limits are M,N <= 3 and K <= 7, constrained by the 64-byte
        MMIO scratchpad. Inputs are Python integers interpreted as signed INT8.
        """
        m = len(a)
        k = len(a[0]) if m else 0
        n = len(b[0]) if b else 0
        if not (1 <= m <= 3 and 1 <= n <= 3 and 1 <= k <= 7):
            raise ValueError("GEMM dimensions exceed prototype limits")
        if any(len(row) != k for row in a) or len(b) != k or any(len(row) != n for row in b):
            raise ValueError("ragged GEMM inputs")

        a_base = 0
        b_base = m * k
        c_base = (b_base + k * n + 3) & ~3
        c_bytes = m * n * 4
        if c_base + c_bytes > self.SCRATCH_BYTES:
            raise ValueError("GEMM tile exceeds 64-byte NPU scratchpad")

        def s8(value):
            if not -128 <= value <= 127:
                raise ValueError("GEMM input outside signed INT8 range")
            return value & 0xFF

        a_bytes = bytes(s8(value) for row in a for value in row)
        b_bytes = bytes(s8(b[row][col]) for row in range(k) for col in range(n))

        self.clear_perf()
        self.write_scratch(a_base, a_bytes)
        self.write_scratch(b_base, b_bytes)
        self.write_scratch(c_base, bytes(c_bytes))
        self.write32(self.GEMM_CFG, m | (n << 8) | (k << 16))
        self.write32(self.GEMM_BASE, a_base | (b_base << 8) | (c_base << 16))
        self.write32(self.GEMM_STRIDE, k | (n << 8) | ((n * 4) << 16))
        self.write32(self.OPCODE, self.OP_GEMM_S8)
        self.write32(self.CTRL_STATUS, 2)
        self.write32(self.CTRL_STATUS, 1)
        self._poll_status(1024, "e1 NPU GEMM command")
        raw = self.read_scratch(c_base, c_bytes)
        return [
            [
                int.from_bytes(raw[(r * n + c) * 4 : (r * n + c + 1) * 4], "little", signed=True)
                for c in range(n)
            ]
            for r in range(m)
        ]


def golden_gemm_s8(a, b):
    m = len(a)
    k = len(a[0]) if m else 0
    n = len(b[0]) if b else 0
    return [[sum(a[i][kk] * b[kk][j] for kk in range(k)) for j in range(n)] for i in range(m)]


HelloNpuRuntime = E1NpuRuntime
