"""Trace ingest and synthetic trace generation for the BPU MPKI harness.

Three trace sources are supported today:

  * ``cbp5``: Championship Branch Prediction 2025 ``.gz`` instruction stream
    as defined by ``lib/trace_reader.h`` in
    https://github.com/ramisheikh/cbp2025 . Each instruction is a
    variable-length record (PC, type, optional mem/branch fields,
    register operands, register values). :func:`read_cbp5` walks the
    stream, yields only branch instructions as :class:`BranchEvent`,
    and returns the total instruction count via :func:`read_cbp5_with_count`
    so MPKI can be computed against the true retired-instruction count
    rather than a 5-instr/branch estimate.
  * ``json``: a portable JSON-lines trace (one object per branch) with the
    keys ``pc``, ``target``, ``taken``, ``kind``. Useful for hand-authored
    micro-traces and for the synthetic generators here.
  * ``synthetic``: a set of deterministic generators that exercise the BPU
    along each direction-class axis. No external dependencies.

The synthetic generators are explicitly NOT SPEC or AOSP. They produce
order-of-magnitude MPKI numbers good enough to validate the model is wired
correctly, never as a phone-class workload claim.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, cast

from .bpu_model import BR_CALL, BR_COND, BR_IND, BR_NONE, BR_RET, BranchEvent

# InstClass enum from lib/sim_common_structs.h in ramisheikh/cbp2025.
CBP5_ALU = 0
CBP5_LOAD = 1
CBP5_STORE = 2
CBP5_COND_BR = 3
CBP5_UNCOND_DIR_BR = 4
CBP5_UNCOND_IND_BR = 5
CBP5_FP = 6
CBP5_SLOW_ALU = 7
CBP5_UNDEF = 8
CBP5_CALL_DIR = 9
CBP5_CALL_IND = 10
CBP5_RETURN = 11

# Map CBP-5 InstClass to bpu_model branch kind constants.
_CBP5_KIND_MAP: dict[int, int] = {
    CBP5_COND_BR: BR_COND,
    CBP5_UNCOND_DIR_BR: BR_COND,  # direct unconditional jump; FTB has target
    CBP5_UNCOND_IND_BR: BR_IND,  # indirect jump (switch/PLT); no RAS push
    CBP5_CALL_DIR: BR_CALL,
    CBP5_CALL_IND: BR_CALL,
    CBP5_RETURN: BR_RET,
}

_CBP5_BRANCH_TYPES: frozenset[int] = frozenset(_CBP5_KIND_MAP)

# Register encoding from lib/trace_reader.h: 0-31 GPR (31=SP), 32-63 SIMD/FP,
# 64=flag, 65=zero. INT regs are 8B output values; SIMD regs are 16B.
_CBP5_VEC_OFFSET = 32
_CBP5_FLAG_REG = 64
_CBP5_ZERO_REG = 65


def _read_exact(handle: BinaryIO, n: int) -> bytes | None:
    chunk = handle.read(n)
    if len(chunk) != n:
        return None
    return chunk


def _read_u8(handle: BinaryIO) -> int | None:
    chunk = _read_exact(handle, 1)
    if chunk is None:
        return None
    return chunk[0]


def _read_u64_le(handle: BinaryIO) -> int | None:
    chunk = _read_exact(handle, 8)
    if chunk is None:
        return None
    return int.from_bytes(chunk, "little", signed=False)


def _reg_is_int(reg: int) -> bool:
    return reg < _CBP5_VEC_OFFSET or reg in (_CBP5_FLAG_REG, _CBP5_ZERO_REG)


@dataclass
class Cbp5TraceStats:
    """Summary of one CBP-5 trace walk.

    ``instruction_count`` is the true retired-instruction count (every
    record in the .gz stream, including non-branches), which is what
    MPKI = misses * 1000 / instructions requires. ``branch_count`` and the
    per-class breakdown are reported as cross-checks against the CBP-5
    reference results CSV.
    """

    instruction_count: int
    branch_count: int
    cond_branch_count: int
    indirect_branch_count: int
    call_count: int
    return_count: int

    def as_dict(self) -> dict[str, int]:
        return {
            "instruction_count": self.instruction_count,
            "branch_count": self.branch_count,
            "cond_branch_count": self.cond_branch_count,
            "indirect_branch_count": self.indirect_branch_count,
            "call_count": self.call_count,
            "return_count": self.return_count,
        }


def _open_cbp5(path: Path) -> BinaryIO:
    """Open a CBP-5 trace, transparently decompressing .gz."""
    suffix = path.suffix.lower()
    if suffix == ".gz":
        # ``gzip.open`` in binary mode returns ``GzipFile`` which is read/seek
        # compatible with ``BinaryIO`` for our walker's needs.
        return cast(BinaryIO, gzip.open(str(path), "rb"))
    return path.open("rb")


def _iter_cbp5_records(handle: BinaryIO) -> Iterator[tuple[int, int, bool, int]]:
    """Walk every record in a CBP-5 trace stream.

    Yields ``(pc, kind, is_branch, next_pc)``. ``next_pc`` is only valid
    for taken branches; otherwise ``pc + 4``. Non-branch instructions are
    yielded with ``is_branch=False`` so callers can keep the true retired
    instruction count.
    """
    while True:
        pc = _read_u64_le(handle)
        if pc is None:
            return
        inst_type_byte = _read_u8(handle)
        if inst_type_byte is None:
            return
        inst_type = inst_type_byte

        next_pc = pc + 4
        is_branch = inst_type in _CBP5_BRANCH_TYPES
        taken = False

        if inst_type in (CBP5_LOAD, CBP5_STORE):
            # eff_addr (8) + mem_size (1) + base_update (1)
            if _read_exact(handle, 10) is None:
                return
            if inst_type == CBP5_STORE and _read_u8(handle) is None:
                return

        if is_branch:
            taken_byte = _read_u8(handle)
            if taken_byte is None:
                return
            taken = bool(taken_byte)
            if taken:
                tgt = _read_u64_le(handle)
                if tgt is None:
                    return
                next_pc = tgt

        num_in_regs = _read_u8(handle)
        if num_in_regs is None:
            return
        if num_in_regs and _read_exact(handle, num_in_regs) is None:
            return

        num_out_regs = _read_u8(handle)
        if num_out_regs is None:
            return
        if num_out_regs:
            out_regs_chunk = _read_exact(handle, num_out_regs)
            if out_regs_chunk is None:
                return
        else:
            out_regs_chunk = b""

        for reg in out_regs_chunk:
            payload_bytes = 8 if _reg_is_int(reg) else 16
            if _read_exact(handle, payload_bytes) is None:
                return

        yield pc, inst_type, is_branch, next_pc


def read_cbp5(path: Path) -> Iterator[BranchEvent]:
    """Yield only the branch events from a CBP-5 .gz instruction trace.

    Non-branch instructions are walked and discarded. For MPKI you almost
    always want :func:`read_cbp5_with_count` instead, which also returns
    the true retired-instruction count.

    ``call_return_pc`` is set to ``pc + 4`` for CALL events; CBP-5 traces
    are RV64 / ARM64 fixed-width 32-bit instructions so the architectural
    return address is always one instruction past the call.
    """
    with _open_cbp5(path) as handle:
        for pc, inst_type, is_branch, next_pc in _iter_cbp5_records(handle):
            if not is_branch:
                continue
            kind = _CBP5_KIND_MAP.get(inst_type, BR_NONE)
            yield BranchEvent(
                pc=pc,
                target=next_pc,
                taken=(next_pc != pc + 4),
                kind=kind,
                call_return_pc=(pc + 4) if inst_type in (CBP5_CALL_DIR, CBP5_CALL_IND) else None,
            )


def read_cbp5_with_count(path: Path) -> tuple[list[BranchEvent], Cbp5TraceStats]:
    """Walk a CBP-5 .gz trace once; return the branch list and full stats.

    Materialises the branch list in memory because the cocotb RTL harness
    needs random access. Training traces are 10 - 130 M instructions
    each which fits comfortably (~30 MB per branch list).
    """
    branches: list[BranchEvent] = []
    inst_count = 0
    cond = ind = call = ret = 0
    with _open_cbp5(path) as handle:
        for pc, inst_type, is_branch, next_pc in _iter_cbp5_records(handle):
            inst_count += 1
            if not is_branch:
                continue
            kind = _CBP5_KIND_MAP.get(inst_type, BR_NONE)
            branches.append(
                BranchEvent(
                    pc=pc,
                    target=next_pc,
                    taken=(next_pc != pc + 4),
                    kind=kind,
                    call_return_pc=(pc + 4)
                    if inst_type in (CBP5_CALL_DIR, CBP5_CALL_IND)
                    else None,
                )
            )
            if inst_type == CBP5_COND_BR:
                cond += 1
            elif inst_type in (CBP5_UNCOND_IND_BR, CBP5_CALL_IND):
                ind += 1
                if inst_type == CBP5_CALL_IND:
                    call += 1
            elif inst_type == CBP5_CALL_DIR:
                call += 1
            elif inst_type == CBP5_RETURN:
                ret += 1
    stats = Cbp5TraceStats(
        instruction_count=inst_count,
        branch_count=len(branches),
        cond_branch_count=cond,
        indirect_branch_count=ind,
        call_count=call,
        return_count=ret,
    )
    return branches, stats


def read_jsonl(path: Path) -> Iterator[BranchEvent]:
    """Yield branch events from a JSON-lines trace."""
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            yield BranchEvent(
                pc=int(row["pc"]),
                target=int(row["target"]),
                taken=bool(row["taken"]),
                kind=int(row["kind"]),
            )


def synthetic_always_taken_loop(iterations: int = 1_000) -> Iterator[BranchEvent]:
    pc = 0x8000_1000
    target = 0x8000_0F00
    for _ in range(iterations):
        yield BranchEvent(pc=pc, target=target, taken=True, kind=BR_COND)


def synthetic_always_not_taken(iterations: int = 1_000) -> Iterator[BranchEvent]:
    """Forward-going conditional that never resolves taken.

    Models the canonical fall-through branch (e.g. an early-exit guard that
    is almost never triggered). TAGE+bimodal should converge to a stable
    not-taken prediction after a small training window.
    """
    pc = 0x8000_1800
    target = 0x8000_1880
    for _ in range(iterations):
        yield BranchEvent(pc=pc, target=target, taken=False, kind=BR_COND)


def synthetic_alternating(iterations: int = 1_000) -> Iterator[BranchEvent]:
    pc = 0x8000_2000
    target = 0x8000_2080
    for i in range(iterations):
        taken = (i % 2) == 0
        yield BranchEvent(pc=pc, target=target, taken=taken, kind=BR_COND)


def synthetic_loop_known_count(trips: int = 16, repetitions: int = 64) -> Iterator[BranchEvent]:
    pc = 0x8000_3000
    target = 0x8000_3000 - 0x40
    for _ in range(repetitions):
        for i in range(trips):
            yield BranchEvent(pc=pc, target=target, taken=i < trips - 1, kind=BR_COND)


def synthetic_recursive_call_return(depth: int = 32, repeats: int = 8) -> Iterator[BranchEvent]:
    call_base = 0x8000_4000
    return_base = 0x8000_5000
    for _ in range(repeats):
        for i in range(depth):
            call_pc = call_base + i * 0x40
            yield BranchEvent(
                pc=call_pc,
                target=call_base + (i + 1) * 0x40,
                taken=True,
                kind=BR_CALL,
                # Match the return target stored by the corresponding RET
                # below so the RAS push and pop are consistent. The synthetic
                # uses a 0x20 stride between call and return-target to mirror
                # a 32-byte fetch block, not the per-instruction CBP-5 layout.
                call_return_pc=call_pc + 0x20,
            )
        for i in range(depth - 1, -1, -1):
            yield BranchEvent(
                pc=return_base + i * 0x40,
                target=call_base + i * 0x40 + 0x20,
                taken=True,
                kind=BR_RET,
            )


def synthetic_irregular_calls(depth: int = 96, repeats: int = 4) -> Iterator[BranchEvent]:
    """Push more than RAS_SPEC_ENTRIES to exercise overflow logic."""
    for _ in range(repeats):
        for i in range(depth):
            call_pc = 0x8000_6000 + i * 0x40
            yield BranchEvent(
                pc=call_pc,
                target=0x8000_7000 + i * 0x40,
                taken=True,
                kind=BR_CALL,
                call_return_pc=call_pc + 0x20,
            )
        for i in range(depth):
            yield BranchEvent(
                pc=0x8000_7000 + i * 0x40,
                target=0x8000_6000 + i * 0x40 + 0x20,
                taken=True,
                kind=BR_RET,
            )


def synthetic_indirect_dispatch(
    sites: int = 4, choices: int = 8, repeats: int = 128
) -> Iterator[BranchEvent]:
    """V8-style indirect dispatch: a few call sites rotating through targets."""
    for r in range(repeats):
        for site in range(sites):
            target = 0x8000_A000 + ((r + site) % choices) * 0x80
            yield BranchEvent(
                pc=0x8000_9000 + site * 0x40,
                target=target,
                taken=True,
                kind=BR_CALL,
            )


def synthetic_mixed_workload(rounds: int = 64) -> Iterator[BranchEvent]:
    """Interleaved hot loops, easy calls/returns, and one cold indirect site
    per round. Approximates a phase-rich application pattern."""
    base_loop = 0x8001_0000
    base_call = 0x8001_2000
    base_ind = 0x8001_4000
    for r in range(rounds):
        for i in range(8):
            yield BranchEvent(
                pc=base_loop,
                target=base_loop - 0x40,
                taken=i < 7,
                kind=BR_COND,
            )
        yield BranchEvent(
            pc=base_call,
            target=base_call + 0x200,
            taken=True,
            kind=BR_CALL,
            call_return_pc=base_call + 0x40,
        )
        yield BranchEvent(
            pc=base_call + 0x208,
            target=base_call + 0x40,
            taken=True,
            kind=BR_RET,
        )
        yield BranchEvent(
            pc=base_ind,
            target=base_ind + 0x100 * (r % 3),
            taken=True,
            kind=BR_IND,
            call_return_pc=base_ind + 4,
        )


def synthetic_jit_dispatch_warmup(
    sites: int = 12, warmup_choices: int = 5, steady_repeats: int = 128
) -> Iterator[BranchEvent]:
    """V8-style: a JIT-emitted dispatch site is polymorphic during warm-up
    (rotates through `warmup_choices` targets) then becomes monomorphic for
    the steady state. ITTAGE should converge on the monomorphic target."""
    sticky = 0x8005_0000
    for site in range(sites):
        # Warm-up phase
        for c in range(warmup_choices):
            yield BranchEvent(
                pc=sticky + site * 0x40,
                target=sticky + 0x1000 + c * 0x100,
                taken=True,
                kind=BR_CALL,
            )
        # Steady-state phase on one chosen target.
        steady_target = sticky + 0x1000 + site * 0x100
        for _ in range(steady_repeats):
            yield BranchEvent(
                pc=sticky + site * 0x40,
                target=steady_target,
                taken=True,
                kind=BR_CALL,
            )


SYNTHETIC_GENERATORS: dict[str, Callable[[], Iterable[BranchEvent]]] = {
    "always_taken": synthetic_always_taken_loop,
    "always_not_taken": synthetic_always_not_taken,
    "alternating": synthetic_alternating,
    "loop_with_known_trip": synthetic_loop_known_count,
    "deep_recursion": synthetic_recursive_call_return,
    "v8_indirect_dispatch": synthetic_indirect_dispatch,
    "mixed_workload": synthetic_mixed_workload,
    "jit_dispatch_warmup": synthetic_jit_dispatch_warmup,
}

# Stress test on RAS overflow — kept available for direct invocation by the
# RAS regression but not part of the canonical 8-workload MPKI suite.
EXTENDED_GENERATORS: dict[str, Callable[[], Iterable[BranchEvent]]] = {
    "irregular_calls": synthetic_irregular_calls,
}
