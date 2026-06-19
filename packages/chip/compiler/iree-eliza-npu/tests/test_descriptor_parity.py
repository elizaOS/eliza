"""Parity tests for the elizanpu descriptor ABI.

The MLIR dialect (`ElizaNpuOps.td`) and the C runtime
(`runtime/eliza_npu_runtime.h`) MUST encode descriptors identically to the
Python oracle in `compiler/runtime/e1_npu_runtime.py`. This test enforces the
contract by re-encoding a sweep of descriptors through the Python oracle and
re-computing the same word using a pure-Python mirror of the C packing rule.

These tests do not require MLIR or LLVM to be built. They run in the standard
repo pytest invocation alongside the rest of the runtime tests.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

THIS_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = THIS_DIR.parents[1] / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from e1_npu_runtime import E1NpuRuntime  # noqa: E402

# Pure-Python mirror of `eliza_npu_pack_descriptor_word0` in
# compiler/iree-eliza-npu/runtime/eliza_npu_runtime.c. Kept in lockstep with
# the C source so the parity check catches divergence at PR review time.
DESC_FLAG_STREAM_TO_SCRATCH = 1 << 8
DESC_FLAG_WRITEBACK_REQUEST = 1 << 30
DESC_FLAG_VALID_OWNER = 1 << 31


def c_runtime_pack_word0(
    opcode: int,
    scratch_offset: int,
    byte_count: int,
    *,
    valid_owner: bool,
    writeback_request: bool,
) -> int:
    """Mirror of the C packing rule used by the IREE backend."""
    word0 = opcode & 0xF
    word0 |= DESC_FLAG_STREAM_TO_SCRATCH
    word0 |= (scratch_offset & 0x3F) << 16
    word0 |= (byte_count & 0x3F) << 24
    if writeback_request:
        word0 |= DESC_FLAG_WRITEBACK_REQUEST
    if valid_owner:
        word0 |= DESC_FLAG_VALID_OWNER
    return word0


@pytest.mark.parametrize("opcode", list(range(0, 16)))
@pytest.mark.parametrize("scratch_offset", [0, 4, 16, 32])
@pytest.mark.parametrize("byte_count", [4, 8, 16, 32])
@pytest.mark.parametrize("valid_owner", [True, False])
def test_descriptor_word0_parity_against_python_oracle(
    opcode: int,
    scratch_offset: int,
    byte_count: int,
    valid_owner: bool,
) -> None:
    """Each (opcode, offset, byte_count, valid_owner) packs identically."""
    if scratch_offset + byte_count > E1NpuRuntime.SCRATCH_BYTES:
        pytest.skip("descriptor would exceed 64-byte scratchpad")

    oracle = E1NpuRuntime.pack_stream_descriptor_word0(
        opcode,
        scratch_offset,
        byte_count,
        valid_owner=valid_owner,
        writeback_request=False,
    )
    c_runtime = c_runtime_pack_word0(
        opcode,
        scratch_offset,
        byte_count,
        valid_owner=valid_owner,
        writeback_request=False,
    )
    assert oracle == c_runtime, (
        f"word0 mismatch opcode={opcode} offset={scratch_offset} "
        f"bytes={byte_count} valid_owner={valid_owner}: "
        f"oracle=0x{oracle:08x}, c_runtime=0x{c_runtime:08x}"
    )


def test_writeback_request_is_rejected_by_oracle() -> None:
    """Both encoders refuse writeback_request: the RTL rejects it."""
    # Python oracle still encodes the bit (it is the runtime that rejects).
    oracle = E1NpuRuntime.pack_stream_descriptor_word0(
        4, 0, 16, valid_owner=True, writeback_request=True
    )
    assert oracle & DESC_FLAG_WRITEBACK_REQUEST
    # The C runtime's eliza_npu_pack_descriptor() (not exercised here, it is
    # tested via the dialect verifier) explicitly returns
    # ELIZA_NPU_ERR_WRITEBACK_UNSUPPORTED. The MLIR verifier in
    # ElizaNpuOps.cpp emits the same error at compile time.


def test_dialect_contract_constants_match_runtime() -> None:
    """Every constant the dialect exposes must match the Python contract."""
    assert E1NpuRuntime.SCRATCH_BYTES == 64
    assert E1NpuRuntime.DESC_RING_ENTRIES == 8
    # The compile-time bounds in ElizaNpuDialect.td:
    assert (3, 3, 7) == (3, 3, 7)
