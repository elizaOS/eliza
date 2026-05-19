from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import StrEnum

Read32 = Callable[[int], int]
Write32 = Callable[[int, int], None]


def _s8(value: int) -> int:
    value &= 0xFF
    return value - 0x100 if value & 0x80 else value


def _s4(value: int) -> int:
    value &= 0xF
    return value - 0x10 if value & 0x8 else value


def _s2(value: int) -> int:
    value &= 0x3
    return value - 0x4 if value & 0x2 else value


def _ternary_encode(value: int) -> int:
    """Encode a host ternary lane value into the RTL ternary 2-bit encoding.

    0b00=0, 0b01=+1, 0b10=-1; 0b11 is reserved and never produced by host code.
    """
    if value == 0:
        return 0b00
    if value == 1:
        return 0b01
    if value == -1:
        return 0b10
    raise ValueError("ternary lane must be -1, 0, or +1")


def _s32(value: int) -> int:
    value &= 0xFFFF_FFFF
    return value - 0x1_0000_0000 if value & 0x8000_0000 else value


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


def golden_exp2_neg_q0_8(delta: int) -> int:
    if not -128 <= delta <= 0:
        raise ValueError("EXP2_NEG_Q0_8 delta must be signed INT8 in -128..0")
    shift = min(8, -delta)
    return 256 >> shift


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


class CommandBuffer:
    """Batched descriptor ring entry queue with a single completion wait.

    A CommandBuffer collects NpuStreamDescriptor entries that the host writes
    contiguously into the descriptor ring at ``base``, then dispatches with one
    ``submit`` call that arms head/tail once and waits for a single descriptor
    completion bit from the RTL. The buffer is the runtime-side analogue of the
    IREE Stream dialect command buffer and the prerequisite for the partitioner
    (B-5) to schedule multi-op subgraphs without per-op MMIO sync.

    The single-op MMIO path remains available through ``E1NpuRuntime.run`` and
    is internally treated as a one-entry buffer when callers prefer the batched
    API.
    """

    DESCRIPTOR_WORDS = 4
    DESCRIPTOR_BYTES = DESCRIPTOR_WORDS * 4
    MAX_ENTRIES = 7

    def __init__(self, base: int, *, timeout_polls: int = 1024) -> None:
        if base < 0 or base & 0x3:
            raise ValueError("command buffer base must be non-negative and 32-bit aligned")
        if timeout_polls <= 0:
            raise ValueError("timeout_polls must be positive")
        self._base = base
        self._timeout_polls = timeout_polls
        self._descriptors: list[NpuStreamDescriptor] = []

    @property
    def base(self) -> int:
        return self._base

    @property
    def timeout_polls(self) -> int:
        return self._timeout_polls

    @property
    def descriptors(self) -> tuple[NpuStreamDescriptor, ...]:
        return tuple(self._descriptors)

    def __len__(self) -> int:
        return len(self._descriptors)

    def append(self, descriptor: NpuStreamDescriptor) -> None:
        if not isinstance(descriptor, NpuStreamDescriptor):
            raise TypeError("command buffer entries must be NpuStreamDescriptor instances")
        if len(self._descriptors) >= self.MAX_ENTRIES:
            raise ValueError(
                f"command buffer exceeds RTL ring window of {self.MAX_ENTRIES} entries"
            )
        self._descriptors.append(descriptor)

    def extend(self, descriptors: Iterable[NpuStreamDescriptor]) -> None:
        for descriptor in descriptors:
            self.append(descriptor)

    def submission(self) -> NpuDescriptorSubmission:
        if not self._descriptors:
            raise ValueError("command buffer submission requires at least one descriptor")
        return NpuDescriptorSubmission(
            base=self._base,
            head=0,
            tail=len(self._descriptors),
            timeout_polls=self._timeout_polls,
        )

    def words(self) -> tuple[tuple[int, int, int, int], ...]:
        return tuple(descriptor.words() for descriptor in self._descriptors)

    def descriptor_image(self) -> dict[int, int]:
        """Return the word-addressed descriptor image to stage at ``base``."""
        image: dict[int, int] = {}
        for descriptor_index, descriptor_words in enumerate(self.words()):
            descriptor_base = self._base + descriptor_index * self.DESCRIPTOR_BYTES
            for word_index, word in enumerate(descriptor_words):
                image[descriptor_base + word_index * 4] = word & 0xFFFF_FFFF
        return image

    def stage(self, write_word32: Write32) -> None:
        """Stage descriptor words through a caller-provided 32-bit memory writer."""
        if not callable(write_word32):
            raise TypeError("command buffer stage requires a callable word writer")
        if not self._descriptors:
            raise ValueError("command buffer staging requires at least one descriptor")
        for address, word in self.descriptor_image().items():
            write_word32(address, word)


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
    PERF_STALL_CYCLES = 0x1002_0074
    PERF_SCRATCH_BYTES = 0x1002_0078
    PERF_THERMAL_THROTTLE = 0x1002_007C
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
    OP_GEMM_S4 = 9
    OP_RELU4_S8 = 10
    OP_VRELU_S8 = 11
    OP_SDOT4_S4_2_4 = 12
    OP_DOT16_S2 = 13
    OP_DOT4_FP8_E4M3 = 14
    OP_EXP2_NEG_Q0_8 = 15
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
    CMD_PARAM_DESC_SUBMIT = 1 << 0
    CMD_PARAM_DOT16_TERNARY = 1 << 1

    PRECISION_MATRIX = (
        NpuPrecisionSupport(
            "INT8",
            NpuPrecisionState.SUPPORTED,
            "DOT4_S8, RELU4_S8, VRELU_S8, and bounded GEMM_S8 through 64-byte MMIO scratchpad",
            "runtime tests plus e1-npu-runtime-contract.json",
        ),
        NpuPrecisionSupport(
            "INT4",
            NpuPrecisionState.SUPPORTED,
            "DOT8_S4 packed dot, SDOT4_S4_2_4 sparse dot, bounded sparse/group-scaled INT4 matmul lowering smoke, and bounded GEMM_S4 through 64-byte MMIO scratchpad",
            "runtime opcode, sparse metadata, bounded sparse and group-scaled INT4 matmul, and bounded GEMM_S4 tests only; no compiler path",
        ),
        NpuPrecisionSupport(
            "INT4_GROUP_SCALED",
            NpuPrecisionState.SUPPORTED,
            "bounded W4A8 group-scaled INT4 matmul smoke with signed Q8.8 scales applied through scalar MUL_LO/ADD; no GEMM_S4_GS RTL opcode/compiler path",
            "group_scaled_int4_matmul lowering smoke and runtime simulator tests only",
        ),
        NpuPrecisionSupport(
            "INT2",
            NpuPrecisionState.SUPPORTED,
            "DOT16_S2 packed scalar dot prototype with bounded INT2 matmul lowering smoke; no tensor INT2 GEMM/compiler path",
            "runtime opcode, packed INT2 reference tests, and int2_matmul lowering smoke only",
        ),
        NpuPrecisionSupport(
            "FP16",
            NpuPrecisionState.SUPPORTED,
            "raw FP16 finite normal/zero inputs converted by host to signed Q8.8, then bounded scalar MUL_LO/ADD matmul smoke; no tensor FP16 GEMM/compiler path",
            "runtime scalar arithmetic tests and fp16_matmul lowering smoke only",
        ),
        NpuPrecisionSupport(
            "BF16",
            NpuPrecisionState.SUPPORTED,
            "raw BF16 finite normal/zero inputs converted by host to signed Q8.8, then bounded scalar MUL_LO/ADD matmul smoke; no tensor BF16 GEMM/compiler path",
            "runtime scalar arithmetic tests and bf16_matmul lowering smoke only",
        ),
        NpuPrecisionSupport(
            "FP8",
            NpuPrecisionState.SUPPORTED,
            "DOT4_FP8_E4M3 scalar E4M3 dot prototype with bounded FP8 matmul lowering smoke and signed Q8.8 output; no tensor FP8 GEMM/compiler path",
            "runtime opcode, E4M3 fixed-point reference tests, and fp8_matmul lowering smoke only",
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

    def run(
        self,
        opcode: int,
        a: int,
        b: int,
        acc: int = 0,
        timeout_polls: int = 1024,
        cmd_param: int = 0,
    ) -> int:
        self.write32(self.CMD_PARAM, cmd_param & 0xFFFF_FFFF)
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

    def max_u32(self, a: int, b: int) -> int:
        return self.run(self.OP_MAX_U32, a, b)

    def min_u32(self, a: int, b: int) -> int:
        return self.run(self.OP_MIN_U32, a, b)

    def mac_s16(self, a: int, b: int, acc: int = 0) -> int:
        return self.run(self.OP_MAC_S16, a, b, acc)

    def dot4_s8(self, a_packed: int, b_packed: int, acc: int = 0) -> int:
        return self.run(self.OP_DOT4_S8, a_packed, b_packed, acc)

    def dot8_s4(self, a_packed: int, b_packed: int, acc: int = 0) -> int:
        return self.run(self.OP_DOT8_S4, a_packed, b_packed, acc)

    def sdot4_s4_2_4(
        self,
        nonzero_weights: list[int],
        dense_values: list[int],
        positions: list[int],
    ) -> int:
        if len(nonzero_weights) != 4:
            raise ValueError("SDOT4_S4_2_4 requires exactly four nonzero INT4 weights")
        if len(dense_values) != 8:
            raise ValueError("SDOT4_S4_2_4 requires exactly eight dense INT4 values")
        if len(positions) != 4:
            raise ValueError("SDOT4_S4_2_4 requires exactly four metadata positions")
        if any(not -8 <= value <= 7 for value in nonzero_weights + dense_values):
            raise ValueError("SDOT4_S4_2_4 input outside signed INT4 range")
        if any(not 0 <= position <= 3 for position in positions):
            raise ValueError("SDOT4_S4_2_4 metadata positions must be in 0..3")
        if len(set(positions[:2])) != 2 or len(set(positions[2:])) != 2:
            raise ValueError("SDOT4_S4_2_4 requires two distinct positions per 2:4 group")

        weights = sum((value & 0xF) << (4 * index) for index, value in enumerate(nonzero_weights))
        dense = sum((value & 0xF) << (4 * index) for index, value in enumerate(dense_values))
        metadata = sum((position & 0x3) << (2 * index) for index, position in enumerate(positions))
        return _s32(self.run(self.OP_SDOT4_S4_2_4, weights, dense, metadata))

    def dot16_s2(self, a_values: list[int], b_values: list[int], acc: int = 0) -> int:
        if len(a_values) != 16 or len(b_values) != 16:
            raise ValueError("DOT16_S2 requires exactly sixteen values per operand")
        if any(not -2 <= value <= 1 for value in a_values + b_values):
            raise ValueError("DOT16_S2 input outside signed INT2 range")
        a_packed = sum((value & 0x3) << (2 * index) for index, value in enumerate(a_values))
        b_packed = sum((value & 0x3) << (2 * index) for index, value in enumerate(b_values))
        return _s32(self.run(self.OP_DOT16_S2, a_packed, b_packed, acc))

    def dot16_ternary(self, a_values: list[int], b_values: list[int], acc: int = 0) -> int:
        """BitNet ternary mode of DOT16_S2: lanes carry {-1, 0, +1}.

        Lane encoding for the RTL: 0b00=0, 0b01=+1, 0b10=-1, 0b11 reserved.
        The RTL rejects any 0b11 encoding via PERF_ERRORS and CTRL_STATUS.error,
        so the host helper guarantees only the three legal values reach MMIO.
        """
        if len(a_values) != 16 or len(b_values) != 16:
            raise ValueError("DOT16 ternary requires exactly sixteen values per operand")
        if any(value not in (-1, 0, 1) for value in a_values + b_values):
            raise ValueError("DOT16 ternary input outside {-1, 0, +1}")
        a_packed = sum(
            _ternary_encode(value) << (2 * index) for index, value in enumerate(a_values)
        )
        b_packed = sum(
            _ternary_encode(value) << (2 * index) for index, value in enumerate(b_values)
        )
        return _s32(
            self.run(
                self.OP_DOT16_S2,
                a_packed,
                b_packed,
                acc,
                cmd_param=self.CMD_PARAM_DOT16_TERNARY,
            )
        )

    def dot4_fp8_e4m3(self, a_fp8: list[int], b_fp8: list[int], acc_q8_8: int = 0) -> int:
        if len(a_fp8) != 4 or len(b_fp8) != 4:
            raise ValueError("DOT4_FP8_E4M3 requires exactly four FP8 values per operand")
        if any(not 0 <= value <= 0xFF for value in a_fp8 + b_fp8):
            raise ValueError("DOT4_FP8_E4M3 inputs must be raw 8-bit FP8 encodings")
        a_packed = sum((value & 0xFF) << (8 * index) for index, value in enumerate(a_fp8))
        b_packed = sum((value & 0xFF) << (8 * index) for index, value in enumerate(b_fp8))
        return _s32(self.run(self.OP_DOT4_FP8_E4M3, a_packed, b_packed, acc_q8_8))

    def exp2_neg_q0_8(self, delta: int) -> int:
        if not -128 <= delta <= 0:
            raise ValueError("EXP2_NEG_Q0_8 delta must be signed INT8 in -128..0")
        return self.run(self.OP_EXP2_NEG_Q0_8, delta & 0xFF, 0)

    def relu4_s8(self, values: list[int]) -> list[int]:
        if len(values) != 4:
            raise ValueError("RELU4_S8 requires exactly four INT8 values")
        packed = 0
        for index, value in enumerate(values):
            if not -128 <= value <= 127:
                raise ValueError("RELU4_S8 input outside signed INT8 range")
            packed |= (value & 0xFF) << (8 * index)
        result = self.run(self.OP_RELU4_S8, packed, 0)
        return [_s8(result >> (8 * index)) for index in range(4)]

    def vrelu_s8(self, values: list[int]) -> list[int]:
        if not 1 <= len(values) <= self.SCRATCH_BYTES:
            raise ValueError("VRELU_S8 requires 1..64 INT8 values")
        for value in values:
            if not -128 <= value <= 127:
                raise ValueError("VRELU_S8 input outside signed INT8 range")
        self.clear_perf()
        self.write_scratch(0, bytes(value & 0xFF for value in values))
        self.write32(self.GEMM_CFG, len(values))
        self.write32(self.GEMM_BASE, 0)
        self.write32(self.OPCODE, self.OP_VRELU_S8)
        self.write32(self.CTRL_STATUS, 2)
        self.write32(self.CTRL_STATUS, 1)
        self._poll_status(1024, "e1 NPU VRELU_S8 command")
        return [_s8(value) for value in self.read_scratch(0, len(values))]

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

    def extended_perf(self) -> dict[str, int]:
        """Power-per-counter telemetry beyond the legacy perf() set.

        `thermal_throttle` is a simulation-only host-writable shadow latch
        until a real thermal HAL drives it; see docs/arch/npu.md.
        """
        return {
            "stall_cycles": self.read32(self.PERF_STALL_CYCLES),
            "scratch_bytes": self.read32(self.PERF_SCRATCH_BYTES),
            "thermal_throttle": self.read32(self.PERF_THERMAL_THROTTLE),
        }

    def increment_thermal_throttle(self) -> int:
        """Simulation-only host helper that bumps PERF_THERMAL_THROTTLE.

        Any 32-bit write to PERF_THERMAL_THROTTLE increments the counter
        by one. This stays in place until the thermal HAL drives the
        latch from real platform telemetry.
        """
        self.write32(self.PERF_THERMAL_THROTTLE, 0)
        return self.read32(self.PERF_THERMAL_THROTTLE)

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

    def submit(self, command_buffer: CommandBuffer) -> NpuRuntimeStatus:
        """Submit a batched CommandBuffer and wait for a single completion.

        The descriptor payloads themselves must already be staged in DRAM at
        ``command_buffer.base``; this entry point arms the ring head/tail and
        completion wait. A one-element CommandBuffer is equivalent to the
        existing single-op MMIO path that ``submit_descriptors`` already covers.
        """
        if not isinstance(command_buffer, CommandBuffer):
            raise TypeError("submit requires a CommandBuffer instance")
        return self.submit_descriptors(command_buffer.submission())

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

    def gemm_s4(self, a, b):
        """Run bounded packed INT4 GEMM, returning an MxN int32 matrix.

        A and B are row-major signed INT4 values packed two per scratchpad byte.
        GEMM_BASE A/B fields and A/B strides are interpreted as INT4 element
        offsets for this opcode. C remains a byte offset and stores signed int32.
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
        packed_input_bytes = (b_base + k * n + 1) // 2
        c_base = (packed_input_bytes + 3) & ~3
        c_bytes = m * n * 4
        if c_base + c_bytes > self.SCRATCH_BYTES:
            raise ValueError("GEMM tile exceeds 64-byte NPU scratchpad")

        def s4(value):
            if not -8 <= value <= 7:
                raise ValueError("GEMM input outside signed INT4 range")
            return value & 0xF

        packed = bytearray(packed_input_bytes)
        values = [s4(value) for row in a for value in row] + [
            s4(b[row][col]) for row in range(k) for col in range(n)
        ]
        for index, value in enumerate(values):
            if index & 1:
                packed[index // 2] |= value << 4
            else:
                packed[index // 2] |= value

        self.clear_perf()
        self.write_scratch(0, bytes(packed))
        self.write_scratch(c_base, bytes(c_bytes))
        self.write32(self.GEMM_CFG, m | (n << 8) | (k << 16))
        self.write32(self.GEMM_BASE, a_base | (b_base << 8) | (c_base << 16))
        self.write32(self.GEMM_STRIDE, k | (n << 8) | ((n * 4) << 16))
        self.write32(self.OPCODE, self.OP_GEMM_S4)
        self.write32(self.CTRL_STATUS, 2)
        self.write32(self.CTRL_STATUS, 1)
        self._poll_status(1024, "e1 NPU GEMM_S4 command")
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


def golden_gemm_s4(a, b):
    return golden_gemm_s8(a, b)


def golden_sdot4_s4_2_4(
    nonzero_weights: list[int],
    dense_values: list[int],
    positions: list[int],
) -> int:
    if len(nonzero_weights) != 4:
        raise ValueError("SDOT4_S4_2_4 requires exactly four nonzero INT4 weights")
    if len(dense_values) != 8:
        raise ValueError("SDOT4_S4_2_4 requires exactly eight dense INT4 values")
    if len(positions) != 4:
        raise ValueError("SDOT4_S4_2_4 requires exactly four metadata positions")
    if any(not -8 <= value <= 7 for value in nonzero_weights + dense_values):
        raise ValueError("SDOT4_S4_2_4 input outside signed INT4 range")
    if any(not 0 <= position <= 3 for position in positions):
        raise ValueError("SDOT4_S4_2_4 metadata positions must be in 0..3")
    if len(set(positions[:2])) != 2 or len(set(positions[2:])) != 2:
        raise ValueError("SDOT4_S4_2_4 requires two distinct positions per 2:4 group")
    return sum(
        nonzero_weights[index] * dense_values[(index // 2) * 4 + positions[index]]
        for index in range(4)
    )


def golden_dot16_s2(a_values: list[int], b_values: list[int], acc: int = 0) -> int:
    if len(a_values) != 16 or len(b_values) != 16:
        raise ValueError("DOT16_S2 requires exactly sixteen values per operand")
    if any(not -2 <= value <= 1 for value in a_values + b_values):
        raise ValueError("DOT16_S2 input outside signed INT2 range")
    return acc + sum(a * b for a, b in zip(a_values, b_values, strict=True))


def golden_dot16_ternary(a_values: list[int], b_values: list[int], acc: int = 0) -> int:
    if len(a_values) != 16 or len(b_values) != 16:
        raise ValueError("DOT16 ternary requires exactly sixteen values per operand")
    if any(value not in (-1, 0, 1) for value in a_values + b_values):
        raise ValueError("DOT16 ternary input outside {-1, 0, +1}")
    return acc + sum(a * b for a, b in zip(a_values, b_values, strict=True))


def golden_dot4_fp8_e4m3(a_fp8: list[int], b_fp8: list[int], acc_q8_8: int = 0) -> int:
    if len(a_fp8) != 4 or len(b_fp8) != 4:
        raise ValueError("DOT4_FP8_E4M3 requires exactly four FP8 values per operand")
    if any(not 0 <= value <= 0xFF for value in a_fp8 + b_fp8):
        raise ValueError("DOT4_FP8_E4M3 inputs must be raw 8-bit FP8 encodings")
    return acc_q8_8 + sum(
        (_fp8_e4m3_to_q8_8(a) * _fp8_e4m3_to_q8_8(b)) >> 8
        for a, b in zip(a_fp8, b_fp8, strict=True)
    )


def golden_relu4_s8(values: list[int]) -> list[int]:
    if len(values) != 4:
        raise ValueError("RELU4_S8 requires exactly four INT8 values")
    if any(not -128 <= value <= 127 for value in values):
        raise ValueError("RELU4_S8 input outside signed INT8 range")
    return [max(0, value) for value in values]


def golden_vrelu_s8(values: list[int]) -> list[int]:
    if not 1 <= len(values) <= E1NpuRuntime.SCRATCH_BYTES:
        raise ValueError("VRELU_S8 requires 1..64 INT8 values")
    if any(not -128 <= value <= 127 for value in values):
        raise ValueError("VRELU_S8 input outside signed INT8 range")
    return [max(0, value) for value in values]


HelloNpuRuntime = E1NpuRuntime
