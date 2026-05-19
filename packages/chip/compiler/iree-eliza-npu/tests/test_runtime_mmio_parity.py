"""Cross-language MMIO ABI parity tests for the e1 NPU runtime.

This module asserts that the C ABI in `compiler/iree-eliza-npu/runtime/
eliza_npu_runtime.h` agrees, byte-for-byte and bit-for-bit, with:

  - the Python oracle on `E1NpuRuntime` (compiler/runtime/e1_npu_runtime.py)
  - the AXI-Lite register decode in rtl/npu/e1_npu.sv

The Python oracle is treated as the canonical contract; the SystemVerilog
RTL is grep-checked against word-indexed offsets (byte_offset // 4); the C
header is parsed by tokenising `#define ELIZA_NPU_REG_*` lines.

No C compiler or RTL simulator is required to run these tests; the goal is
to catch silent drift between the three encodings during PR review.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parents[2]
RUNTIME_DIR = REPO_ROOT / "compiler" / "runtime"
C_HEADER = THIS_DIR.parent / "runtime" / "eliza_npu_runtime.h"
SV_FILE = REPO_ROOT / "rtl" / "npu" / "e1_npu.sv"

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from e1_npu_runtime import E1NpuRuntime  # noqa: E402

# Python-oracle name -> C-header symbol -> byte offset (relative to MMIO base).
# Every entry MUST be reflected in compiler/runtime/e1_npu_runtime.py with the
# same byte offset, in rtl/npu/e1_npu.sv at word offset = byte_offset // 4, and
# in the C header at the same byte offset.
REGISTERS: tuple[tuple[str, str, int], ...] = (
    ("OP_A", "ELIZA_NPU_REG_OP_A", 0x00),
    ("OP_B", "ELIZA_NPU_REG_OP_B", 0x04),
    ("RESULT", "ELIZA_NPU_REG_RESULT", 0x08),
    ("CTRL_STATUS", "ELIZA_NPU_REG_CTRL_STATUS", 0x0C),
    ("OPCODE", "ELIZA_NPU_REG_OPCODE", 0x10),
    ("ACC", "ELIZA_NPU_REG_ACC", 0x14),
    ("RESULT_HI", "ELIZA_NPU_REG_RESULT_HI", 0x18),
    ("DEBUG", "ELIZA_NPU_REG_DEBUG", 0x1C),
    ("GEMM_CFG", "ELIZA_NPU_REG_GEMM_CFG", 0x20),
    ("GEMM_BASE", "ELIZA_NPU_REG_GEMM_BASE", 0x24),
    ("GEMM_STRIDE", "ELIZA_NPU_REG_GEMM_STRIDE", 0x28),
    ("PERF_UNSUPPORTED_OPS", "ELIZA_NPU_REG_PERF_UNSUP_OPS", 0x2C),
    ("CMD_PARAM", "ELIZA_NPU_REG_CMD_PARAM", 0x30),
    ("DESC_BASE", "ELIZA_NPU_REG_DESC_BASE", 0x40),
    ("DESC_HEAD", "ELIZA_NPU_REG_DESC_HEAD", 0x44),
    ("DESC_TAIL", "ELIZA_NPU_REG_DESC_TAIL", 0x48),
    ("DESC_STATUS", "ELIZA_NPU_REG_DESC_STATUS", 0x4C),
    ("PERF_CYCLES", "ELIZA_NPU_REG_PERF_CYCLES", 0x50),
    ("PERF_MACS", "ELIZA_NPU_REG_PERF_MACS", 0x54),
    ("PERF_OPS", "ELIZA_NPU_REG_PERF_OPS", 0x58),
    ("PERF_ERRORS", "ELIZA_NPU_REG_PERF_ERRORS", 0x5C),
    ("DESC_TIMEOUT_COUNT", "ELIZA_NPU_REG_DESC_TIMEOUT_CNT", 0x60),
    ("DESC_BYTES_READ", "ELIZA_NPU_REG_DESC_BYTES_READ", 0x64),
    ("DESC_BYTES_WRITTEN", "ELIZA_NPU_REG_DESC_BYTES_WRITTEN", 0x68),
    ("DESC_READ_BEATS", "ELIZA_NPU_REG_DESC_READ_BEATS", 0x6C),
    ("DESC_WRITE_BEATS", "ELIZA_NPU_REG_DESC_WRITE_BEATS", 0x70),
    ("SCRATCH", "ELIZA_NPU_REG_SCRATCH", 0x80),
)

# Python-oracle opcode name -> C symbol -> integer value.
OPCODES: tuple[tuple[str, str, int], ...] = (
    ("OP_ADD", "ELIZA_NPU_OP_ADD", 0),
    ("OP_SUB", "ELIZA_NPU_OP_SUB", 1),
    ("OP_MUL_LO", "ELIZA_NPU_OP_MUL_LO", 2),
    ("OP_MAC_S16", "ELIZA_NPU_OP_MAC_S16", 3),
    ("OP_DOT4_S8", "ELIZA_NPU_OP_DOT4_S8", 4),
    ("OP_MAX_U32", "ELIZA_NPU_OP_MAX_U32", 5),
    ("OP_MIN_U32", "ELIZA_NPU_OP_MIN_U32", 6),
    ("OP_DOT8_S4", "ELIZA_NPU_OP_DOT8_S4", 7),
    ("OP_GEMM_S8", "ELIZA_NPU_OP_GEMM_S8", 8),
    ("OP_GEMM_S4", "ELIZA_NPU_OP_GEMM_S4", 9),
    ("OP_RELU4_S8", "ELIZA_NPU_OP_RELU4_S8", 10),
    ("OP_VRELU_S8", "ELIZA_NPU_OP_VRELU_S8", 11),
    ("OP_SDOT4_S4_2_4", "ELIZA_NPU_OP_SDOT4_S4_2_4", 12),
    ("OP_DOT16_S2", "ELIZA_NPU_OP_DOT16_S2", 13),
    ("OP_DOT4_FP8_E4M3", "ELIZA_NPU_OP_DOT4_FP8_E4M3", 14),
    ("OP_EXP2_NEG_Q0_8", "ELIZA_NPU_OP_EXP2_NEG_Q0_8", 15),
)

DESC_STATUS_BITS: tuple[tuple[str, str, int], ...] = (
    ("DESC_STATUS_EMPTY", "ELIZA_NPU_DESC_STATUS_EMPTY", 1 << 0),
    ("DESC_STATUS_DONE", "ELIZA_NPU_DESC_STATUS_DONE", 1 << 1),
    ("DESC_STATUS_ERROR", "ELIZA_NPU_DESC_STATUS_ERROR", 1 << 2),
    ("DESC_STATUS_TIMEOUT", "ELIZA_NPU_DESC_STATUS_TIMEOUT", 1 << 3),
    ("DESC_STATUS_MEM_ERROR", "ELIZA_NPU_DESC_STATUS_MEM_ERROR", 1 << 4),
    ("DESC_STATUS_STREAM_ERROR", "ELIZA_NPU_DESC_STATUS_STREAM_ERROR", 1 << 5),
    ("DESC_STATUS_OWNER_ERROR", "ELIZA_NPU_DESC_STATUS_OWNER_ERROR", 1 << 6),
    ("DESC_STATUS_WRITEBACK_UNSUPPORTED", "ELIZA_NPU_DESC_STATUS_WRITEBACK_UNSUPPORTED", 1 << 7),
)

DESC_FLAG_BITS: tuple[tuple[str, str, int], ...] = (
    ("DESC_FLAG_STREAM_TO_SCRATCH", "ELIZA_NPU_DESC_FLAG_STREAM_TO_SCRATCH", 1 << 8),
    ("DESC_FLAG_WRITEBACK_REQUEST", "ELIZA_NPU_DESC_FLAG_WRITEBACK_REQUEST", 1 << 30),
    ("DESC_FLAG_VALID_OWNER", "ELIZA_NPU_DESC_FLAG_VALID_OWNER", 1 << 31),
)


def _parse_c_defines(path: Path) -> dict[str, int]:
    """Return a {symbol: int_value} map from `#define <NAME> <expr>u?` lines.

    Supports decimal, hex, and `(1u << N)` shift forms. Strips trailing `u`.
    """
    text = path.read_text()
    out: dict[str, int] = {}
    define_re = re.compile(r"^#define\s+(\w+)\s+(.+?)(?:\s*/\*.*?\*/)?\s*$")
    for line in text.splitlines():
        m = define_re.match(line.strip())
        if not m:
            continue
        name, raw = m.group(1), m.group(2).strip()
        # strip trailing 'u' on integer literals
        raw_clean = re.sub(r"\b(\d+|0x[0-9a-fA-F]+)u\b", r"\1", raw)
        # (1 << N) form
        m_shift = re.match(r"^\(?\s*1\s*<<\s*(\d+)\s*\)?$", raw_clean)
        if m_shift:
            out[name] = 1 << int(m_shift.group(1))
            continue
        # plain integer
        if raw_clean.startswith("0x") or raw_clean.startswith("0X"):
            try:
                out[name] = int(raw_clean, 16)
                continue
            except ValueError:
                pass
        if raw_clean.lstrip("-").isdigit():
            try:
                out[name] = int(raw_clean)
                continue
            except ValueError:
                pass
    return out


@pytest.fixture(scope="module")
def c_defines() -> dict[str, int]:
    assert C_HEADER.exists(), f"C header missing: {C_HEADER}"
    return _parse_c_defines(C_HEADER)


@pytest.fixture(scope="module")
def sv_text() -> str:
    assert SV_FILE.exists(), f"NPU RTL missing: {SV_FILE}"
    return SV_FILE.read_text()


@pytest.mark.parametrize("python_name,c_symbol,byte_offset", REGISTERS)
def test_register_offset_matches_python(python_name: str, c_symbol: str, byte_offset: int) -> None:
    """Python-oracle register address == MMIO_BASE + expected byte_offset."""
    expected_addr = (
        E1NpuRuntime.SCRATCH if python_name == "SCRATCH" else getattr(E1NpuRuntime, python_name)
    )
    assert expected_addr == 0x1002_0000 + byte_offset, (
        f"{python_name}: Python has 0x{expected_addr:08x}, expected base+0x{byte_offset:02x}"
    )


@pytest.mark.parametrize("python_name,c_symbol,byte_offset", REGISTERS)
def test_register_offset_matches_c(
    python_name: str,
    c_symbol: str,
    byte_offset: int,
    c_defines: dict[str, int],
) -> None:
    assert c_symbol in c_defines, f"C header missing #define {c_symbol}"
    assert c_defines[c_symbol] == byte_offset, (
        f"{c_symbol}: C has 0x{c_defines[c_symbol]:02x}, expected 0x{byte_offset:02x}"
    )


@pytest.mark.parametrize("python_name,c_symbol,byte_offset", REGISTERS)
def test_register_offset_matches_sv_word_index(
    python_name: str,
    c_symbol: str,
    byte_offset: int,
    sv_text: str,
) -> None:
    """rtl/npu/e1_npu.sv decodes word_index = byte_offset // 4 in its case stmt."""
    word_index = byte_offset // 4
    # SV uses 6'hNN literals in the address decode case. Search for both read
    # (line shape `6'hNN: rdata = ...`) and write (`6'hNN: ... <= wdata...`)
    # contexts. We require at least one occurrence of the word index literal.
    pattern = rf"6'h{word_index:02x}\b"
    assert re.search(pattern, sv_text), (
        f"SV register decode missing word index 0x{word_index:02x} "
        f"(byte 0x{byte_offset:02x}) for {python_name}"
    )


@pytest.mark.parametrize("python_name,c_symbol,value", OPCODES)
def test_opcode_value_python(python_name: str, c_symbol: str, value: int) -> None:
    assert getattr(E1NpuRuntime, python_name) == value, (
        f"{python_name}: Python has {getattr(E1NpuRuntime, python_name)}, expected {value}"
    )


@pytest.mark.parametrize("python_name,c_symbol,value", OPCODES)
def test_opcode_value_c(
    python_name: str,
    c_symbol: str,
    value: int,
    c_defines: dict[str, int],
) -> None:
    assert c_symbol in c_defines, f"C header missing #define {c_symbol}"
    assert c_defines[c_symbol] == value


@pytest.mark.parametrize("python_name,c_symbol,value", DESC_STATUS_BITS)
def test_desc_status_bit_python(python_name: str, c_symbol: str, value: int) -> None:
    assert getattr(E1NpuRuntime, python_name) == value


@pytest.mark.parametrize("python_name,c_symbol,value", DESC_STATUS_BITS)
def test_desc_status_bit_c(
    python_name: str,
    c_symbol: str,
    value: int,
    c_defines: dict[str, int],
) -> None:
    assert c_defines.get(c_symbol) == value, (
        f"{c_symbol}: C has {c_defines.get(c_symbol)}, expected 0x{value:x}"
    )


@pytest.mark.parametrize("python_name,c_symbol,value", DESC_FLAG_BITS)
def test_desc_flag_bit_python_c(
    python_name: str,
    c_symbol: str,
    value: int,
    c_defines: dict[str, int],
) -> None:
    assert getattr(E1NpuRuntime, python_name) == value
    assert c_defines.get(c_symbol) == value


def test_scratch_bytes_constant_parity(c_defines: dict[str, int]) -> None:
    assert c_defines["ELIZA_NPU_SCRATCH_BYTES"] == E1NpuRuntime.SCRATCH_BYTES
    assert E1NpuRuntime.SCRATCH_BYTES == 64


def test_desc_ring_entries_constant_parity(c_defines: dict[str, int]) -> None:
    assert c_defines["ELIZA_NPU_DESC_RING_ENTRIES"] == E1NpuRuntime.DESC_RING_ENTRIES
    assert E1NpuRuntime.DESC_RING_ENTRIES == 8


def test_mmio_base_constant(c_defines: dict[str, int]) -> None:
    assert c_defines["ELIZA_NPU_MMIO_BASE"] == 0x10020000


def test_opcode_max_constant_is_full_4bit_space(c_defines: dict[str, int]) -> None:
    assert c_defines["ELIZA_NPU_OPCODE_MAX"] == 0xF
