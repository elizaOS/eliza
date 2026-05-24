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

from .bpu_model import BR_CALL, BR_COND, BR_DIRECT, BR_IND, BR_NONE, BR_RET, BranchEvent

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
    CBP5_UNCOND_DIR_BR: BR_DIRECT,  # direct unconditional jump; FTB has target
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
                kind=BR_IND,
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
                kind=BR_IND,
            )
        # Steady-state phase on one chosen target.
        steady_target = sticky + 0x1000 + site * 0x100
        for _ in range(steady_repeats):
            yield BranchEvent(
                pc=sticky + site * 0x40,
                target=steady_target,
                taken=True,
                kind=BR_IND,
            )


def synthetic_gpu_tile_kernel(blocks: int = 96, tile_iters: int = 32) -> Iterator[BranchEvent]:
    """GPU shader / compute-kernel shape: deeply regular tile loops plus a
    boundary guard that is almost always not taken. This rewards loop and
    TAGE stability without letting GPU weighting overfit to indirects."""
    loop_pc = 0x8006_0000
    edge_pc = 0x8006_0040
    for block in range(blocks):
        for i in range(tile_iters):
            yield BranchEvent(
                pc=loop_pc,
                target=loop_pc - 0x80,
                taken=i < tile_iters - 1,
                kind=BR_COND,
            )
        edge = (block % 16) == 15
        yield BranchEvent(
            pc=edge_pc,
            target=edge_pc + 0x180,
            taken=edge,
            kind=BR_COND,
        )


def synthetic_gpu_warp_divergence(warps: int = 256) -> Iterator[BranchEvent]:
    """SIMT divergence/reconvergence proxy: a handful of PCs see masks that
    alternate by warp id, then reconverge through a fixed backedge."""
    branch_base = 0x8006_2000
    reconv_pc = 0x8006_2400
    for warp in range(warps):
        yield BranchEvent(
            pc=branch_base,
            target=branch_base + 0x100,
            taken=(warp & 1) == 0,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=branch_base + 0x40,
            target=branch_base + 0x180,
            taken=(warp % 3) == 0,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=branch_base + 0x80,
            target=branch_base + 0x200,
            taken=(warp % 5) in (0, 1),
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=reconv_pc,
            target=reconv_pc - 0x200,
            taken=(warp % 8) != 7,
            kind=BR_COND,
        )


def synthetic_gpu_command_processor(
    queues: int = 6, kernels: int = 9, repeats: int = 160
) -> Iterator[BranchEvent]:
    """GPU driver / firmware scheduler proxy: command-ring conditionals plus
    indirect kernel dispatch with a small hot target set."""
    ring_pc = 0x8006_4000
    dispatch_base = 0x8006_5000
    target_base = 0x8006_8000
    for r in range(repeats):
        for q in range(queues):
            empty = ((r + q) % 11) == 0
            yield BranchEvent(
                pc=ring_pc + q * 0x40,
                target=ring_pc + 0x600 + q * 0x40,
                taken=empty,
                kind=BR_COND,
            )
            if not empty:
                target = target_base + ((r * 3 + q) % kernels) * 0x100
                yield BranchEvent(
                    pc=dispatch_base + q * 0x40,
                    target=target,
                    taken=True,
                    kind=BR_IND,
                )


def synthetic_dual_branch_fetch_block(repetitions: int = 256) -> Iterator[BranchEvent]:
    """Two conditional branches in one 32-byte fetch block.

    The first branch is a mostly fall-through guard; the second branch is a
    stable taken redirect. A one-branch-per-block prediction model cannot see
    the second branch in time, while a dual-slot front end can.
    """
    guard_pc = 0x8007_0000
    redirect_pc = guard_pc + 0x10
    for r in range(repetitions):
        guard_taken = (r % 17) == 16
        yield BranchEvent(
            pc=guard_pc,
            target=guard_pc + 0x200,
            taken=guard_taken,
            kind=BR_COND,
        )
        if not guard_taken:
            yield BranchEvent(
                pc=redirect_pc,
                target=redirect_pc + 0x300,
                taken=True,
                kind=BR_COND,
            )


def synthetic_nested_imli_loop(outer_reps: int = 96) -> Iterator[BranchEvent]:
    """Nested-loop shape where the inner trip count follows outer iteration.

    This is the classic IMLI/loop-iteration-history stressor: the same inner
    backedge exits at different counts, but the count is predictable from the
    surrounding loop phase.
    """
    outer_pc = 0x8007_2000
    inner_pc = 0x8007_2040
    trip_pattern = (3, 5, 7, 11, 7, 5)
    for outer in range(outer_reps):
        trips = trip_pattern[outer % len(trip_pattern)]
        for i in range(trips):
            yield BranchEvent(
                pc=inner_pc,
                target=inner_pc - 0x40,
                taken=i < trips - 1,
                kind=BR_COND,
            )
        yield BranchEvent(
            pc=outer_pc,
            target=outer_pc - 0x80,
            taken=outer < outer_reps - 1,
            kind=BR_COND,
        )


def synthetic_correlated_xor_branches(iterations: int = 768) -> Iterator[BranchEvent]:
    """Branches whose third outcome is a function of earlier branch outcomes.

    The first two PCs are simple phase functions; the third PC is their XOR.
    This gives the sweep a hard global-correlation shape for GEHL/perceptron
    experiments without pretending the current predictor should solve it fully.
    """
    pc_a = 0x8007_4000
    pc_b = 0x8007_4040
    pc_x = 0x8007_4080
    for i in range(iterations):
        a_taken = ((i * 5 + 1) & 7) in (0, 1, 4, 6)
        b_taken = ((i * 3 + 2) & 7) in (1, 2, 5, 7)
        x_taken = a_taken ^ b_taken
        yield BranchEvent(pc=pc_a, target=pc_a + 0x100, taken=a_taken, kind=BR_COND)
        yield BranchEvent(pc=pc_b, target=pc_b + 0x140, taken=b_taken, kind=BR_COND)
        yield BranchEvent(pc=pc_x, target=pc_x + 0x180, taken=x_taken, kind=BR_COND)


def synthetic_vtable_path_correlated(paths: int = 4, repeats: int = 192) -> Iterator[BranchEvent]:
    """One indirect callsite whose target depends on the preceding call path."""
    call_base = 0x8007_6000
    ind_pc = 0x8007_7000
    target_base = 0x8007_9000
    for r in range(repeats):
        path = (r ^ (r >> 2)) % paths
        yield BranchEvent(
            pc=call_base + path * 0x40,
            target=call_base + 0x400 + path * 0x80,
            taken=True,
            kind=BR_CALL,
            call_return_pc=call_base + path * 0x40 + 0x20,
        )
        yield BranchEvent(
            pc=ind_pc,
            target=target_base + path * 0x100,
            taken=True,
            kind=BR_IND,
        )
        yield BranchEvent(
            pc=call_base + 0x500 + path * 0x80,
            target=call_base + path * 0x40 + 0x20,
            taken=True,
            kind=BR_RET,
        )


def synthetic_interpreter_dispatch_mixed(
    opcodes: int = 9, repeats: int = 160
) -> Iterator[BranchEvent]:
    """Interpreter/VM dispatch: bytecode indirects mixed with local branches."""
    dispatch_pc = 0x8007_A000
    guard_pc = 0x8007_A040
    loop_pc = 0x8007_A080
    handler_base = 0x8007_C000
    for r in range(repeats):
        opcode = ((r * 7) ^ (r >> 1)) % opcodes
        yield BranchEvent(
            pc=dispatch_pc,
            target=handler_base + opcode * 0x100,
            taken=True,
            kind=BR_IND,
        )
        yield BranchEvent(
            pc=guard_pc + (opcode % 3) * 0x40,
            target=handler_base + 0x1000 + opcode * 0x20,
            taken=(opcode in (0, 3, 5) and (r % 5) != 0),
            kind=BR_COND,
        )
        for i in range((opcode % 4) + 1):
            yield BranchEvent(
                pc=loop_pc,
                target=loop_pc - 0x60,
                taken=i < (opcode % 4),
                kind=BR_COND,
            )


def synthetic_phase_change_server(phases: int = 6, phase_len: int = 160) -> Iterator[BranchEvent]:
    """Server-like phase changes on stable PCs.

    The same conditional PCs flip bias across phases, and one indirect site
    changes from a small hot target set to a larger one and back. This stresses
    useful-bit aging, stale target replacement, and SC threshold decisions.
    """
    cond_a = 0x8008_0000
    cond_b = 0x8008_0040
    ind_pc = 0x8008_0100
    target_base = 0x8008_4000
    for phase in range(phases):
        mostly_taken = (phase % 2) == 0
        target_span = 3 if phase in (0, phases - 1) else 11
        for i in range(phase_len):
            a_taken = ((i % 16) != 0) if mostly_taken else ((i % 16) == 0)
            b_taken = (((i + phase) % 7) in (0, 1, 2)) ^ mostly_taken
            yield BranchEvent(
                pc=cond_a,
                target=cond_a + 0x200,
                taken=a_taken,
                kind=BR_COND,
            )
            yield BranchEvent(
                pc=cond_b,
                target=cond_b + 0x240,
                taken=b_taken,
                kind=BR_COND,
            )
            yield BranchEvent(
                pc=ind_pc,
                target=target_base + ((i * 5 + phase) % target_span) * 0x100,
                taken=True,
                kind=BR_IND,
            )


def synthetic_alias_thrash(groups: int = 20, rounds: int = 64) -> Iterator[BranchEvent]:
    """Many branch PCs collide in low index bits but need different answers."""
    base = 0x8009_0000
    # Keep the low 16 bits stable to collide in the model's smaller direct
    # maps while changing higher tag bits enough for tagged tables to help.
    stride = 0x1_0000
    for r in range(rounds):
        for g in range(groups):
            pc = base + g * stride
            if g % 4 == 0:
                taken = (r % 8) != 0
            elif g % 4 == 1:
                taken = (r % 8) == 0
            elif g % 4 == 2:
                taken = ((r + g) & 1) == 0
            else:
                taken = ((r * 3 + g) % 7) in (0, 2, 5)
            yield BranchEvent(
                pc=pc,
                target=pc + 0x180 + (g % 5) * 0x40,
                taken=taken,
                kind=BR_COND,
            )


def synthetic_gpu_occupancy_phase(kernels: int = 48) -> Iterator[BranchEvent]:
    """GPU launch stream with changing occupancy and dispatch phases."""
    tile_loop = 0x800A_0000
    edge_guard = 0x800A_0040
    sparse_guard = 0x800A_0080
    early_exit = 0x800A_00C0
    dispatch_pc = 0x800A_0200
    target_base = 0x800A_4000
    for kernel in range(kernels):
        occupancy = kernel % 4
        trips = (32, 24, 9, 3)[occupancy]
        for i in range(trips):
            yield BranchEvent(
                pc=tile_loop,
                target=tile_loop - 0x80,
                taken=i < trips - 1,
                kind=BR_COND,
            )
        yield BranchEvent(
            pc=edge_guard,
            target=edge_guard + 0x200,
            taken=occupancy in (1, 2),
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=sparse_guard,
            target=sparse_guard + 0x240,
            taken=occupancy == 2 and (kernel % 3) != 0,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=early_exit,
            target=early_exit + 0x280,
            taken=occupancy == 3,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=dispatch_pc,
            target=target_base + ((kernel * 7 + occupancy) % 13) * 0x100,
            taken=True,
            kind=BR_IND,
        )


def synthetic_return_mismatch_exceptions(repeats: int = 32) -> Iterator[BranchEvent]:
    """Mostly normal calls with occasional tail-call/coroutine return targets."""
    call_base = 0x800B_0000
    ret_base = 0x800B_4000
    for r in range(repeats):
        depth = 4 + (r % 5)
        for i in range(depth):
            call_pc = call_base + i * 0x40
            yield BranchEvent(
                pc=call_pc,
                target=ret_base + i * 0x80,
                taken=True,
                kind=BR_CALL,
                call_return_pc=call_pc + 0x20,
            )
        for i in range(depth - 1, -1, -1):
            expected = call_base + i * 0x40 + 0x20
            if r % 11 == 10 and i == depth - 1:
                target = call_base + 0x900  # non-LIFO exception/coroutine resume
            elif r % 7 == 6 and i == 0:
                target = call_base + 0xA00  # tail-call style handoff
            else:
                target = expected
            yield BranchEvent(
                pc=ret_base + i * 0x80,
                target=target,
                taken=True,
                kind=BR_RET,
            )


def synthetic_gpu_nested_reconvergence(warps: int = 192) -> Iterator[BranchEvent]:
    """Nested SIMT divergence where inner masks depend on outer phase.

    GPU wavefronts often execute a short ladder of divergent guards before
    reconverging at a common post-dominator. This keeps the static PC set tiny
    but makes the same branch PCs see different biases in nested phases.
    """
    outer_pc = 0x800C_0000
    inner_a_pc = 0x800C_0040
    inner_b_pc = 0x800C_0080
    reconv_inner_pc = 0x800C_00C0
    reconv_outer_pc = 0x800C_0100
    for warp in range(warps):
        phase = (warp >> 4) & 3
        outer_taken = ((warp + phase) % 6) in (0, 1, 2)
        yield BranchEvent(
            pc=outer_pc,
            target=outer_pc + 0x300,
            taken=outer_taken,
            kind=BR_COND,
        )
        if outer_taken:
            yield BranchEvent(
                pc=inner_a_pc,
                target=inner_a_pc + 0x240,
                taken=((warp ^ phase) & 3) != 0,
                kind=BR_COND,
            )
        else:
            yield BranchEvent(
                pc=inner_b_pc,
                target=inner_b_pc + 0x280,
                taken=((warp + phase * 3) % 5) in (0, 2),
                kind=BR_COND,
            )
        yield BranchEvent(
            pc=reconv_inner_pc,
            target=reconv_inner_pc - 0x180,
            taken=(warp % 8) != 7,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=reconv_outer_pc,
            target=reconv_outer_pc - 0x300,
            taken=(warp % 32) != 31,
            kind=BR_COND,
        )


def synthetic_control_indirect_pair(iterations: int = 640) -> Iterator[BranchEvent]:
    """A conditional immediately selects the target family of one indirect PC.

    Models hot server code that validates a request/message shape and then
    dispatches through a vtable, RPC method table, or JIT stub. The indirect
    site alone is polymorphic; the preceding control outcome carries the
    missing target context.
    """
    guard_pc = 0x800C_2000
    mode_pc = 0x800C_2040
    dispatch_pc = 0x800C_2080
    fast_base = 0x800C_6000
    slow_base = 0x800C_9000
    for i in range(iterations):
        hot_request = ((i * 7 + (i >> 3)) % 17) < 12
        mode = ((i >> 2) ^ i) & 3
        yield BranchEvent(
            pc=guard_pc,
            target=guard_pc + 0x200,
            taken=hot_request,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=mode_pc,
            target=mode_pc + 0x240,
            taken=mode in (0, 3),
            kind=BR_COND,
        )
        target_base = fast_base if hot_request else slow_base
        yield BranchEvent(
            pc=dispatch_pc,
            target=target_base + mode * 0x100,
            taken=True,
            kind=BR_IND,
        )


def synthetic_btb_confidence_churn(
    sites: int = 768, phase_repeats: int = 3
) -> Iterator[BranchEvent]:
    """BTB/uBTB capacity and target-confidence stress with compact PCs.

    Many front-end-sized server kernels have a broad working set of cold-ish
    guards plus a smaller set of indirect exits whose targets are stable within
    a phase and then flip. This stresses set capacity and stale target
    confidence without requiring a long trace.
    """
    guard_base = 0x800D_0000
    exit_base = 0x8011_0000
    target_base = 0x8018_0000
    for phase in range(phase_repeats):
        for site in range(sites):
            guard_pc = guard_base + site * 0x20
            taken = ((site + phase * 13) % 19) == 0
            yield BranchEvent(
                pc=guard_pc,
                target=guard_pc + 0x100,
                taken=taken,
                kind=BR_COND,
            )
            if site % 4 == 0:
                exit_pc = exit_base + (site // 4) * 0x40
                target = target_base + (((site // 4) + phase) % 257) * 0x80
                yield BranchEvent(
                    pc=exit_pc,
                    target=target,
                    taken=True,
                    kind=BR_IND,
                )


def synthetic_command_buffer_validation(commands: int = 768) -> Iterator[BranchEvent]:
    """GPU command-buffer validation with rare slow invalid paths.

    Models Vulkan/Metal/D3D-style front-end control: opcode dispatch is
    indirect, while descriptor/resource/barrier checks are mostly biased but
    phase-dependent enough to catch overfitting to pure SIMT loops.
    """
    opcode_pc = 0x801D_0000
    desc_pc = 0x801D_0040
    barrier_pc = 0x801D_0080
    resource_pc = 0x801D_00C0
    invalid_pc = 0x801D_0100
    handler_base = 0x801D_4000
    for i in range(commands):
        opcode = ((i * 13) ^ (i >> 3)) % 17
        yield BranchEvent(
            pc=opcode_pc,
            target=handler_base + opcode * 0x100,
            taken=True,
            kind=BR_IND,
        )
        valid_descriptor = (opcode % 5) != 0 or (i % 23) != 0
        has_barrier = opcode in (3, 7, 11, 13) and (i % 4) != 0
        resource_ready = ((i + opcode * 3) % 29) != 0
        yield BranchEvent(pc=desc_pc, target=desc_pc + 0x200, taken=not valid_descriptor, kind=BR_COND)
        yield BranchEvent(pc=barrier_pc, target=barrier_pc + 0x240, taken=has_barrier, kind=BR_COND)
        yield BranchEvent(pc=resource_pc, target=resource_pc + 0x280, taken=not resource_ready, kind=BR_COND)
        if not valid_descriptor or not resource_ready:
            yield BranchEvent(
                pc=invalid_pc,
                target=handler_base + 0x3000 + (opcode % 4) * 0x100,
                taken=True,
                kind=BR_IND,
            )


def synthetic_work_stealing_queues(queues: int = 8, rounds: int = 192) -> Iterator[BranchEvent]:
    """Persistent-kernel/runtime scheduler queues with phase imbalance."""
    empty_base = 0x801E_0000
    steal_base = 0x801E_1000
    dispatch_base = 0x801E_2000
    target_base = 0x801E_8000
    for r in range(rounds):
        phase = (r // 32) & 3
        for q in range(queues):
            occupancy = (r * (q + 3) + phase * 7 + q) % 19
            empty = occupancy < (2 + phase)
            yield BranchEvent(
                pc=empty_base + q * 0x40,
                target=empty_base + 0x600 + q * 0x40,
                taken=empty,
                kind=BR_COND,
            )
            if empty:
                yield BranchEvent(
                    pc=steal_base + q * 0x40,
                    target=steal_base + 0x600 + ((q + phase) % queues) * 0x40,
                    taken=((r + q) % 3) != 0,
                    kind=BR_COND,
                )
            else:
                task = (occupancy + q * 5 + phase) % 11
                yield BranchEvent(
                    pc=dispatch_base + q * 0x40,
                    target=target_base + task * 0x100,
                    taken=True,
                    kind=BR_IND,
                )


def synthetic_hash_probe_inline_cache(lookups: int = 512) -> Iterator[BranchEvent]:
    """Hash-table probe loop plus polymorphic inline-cache dispatch."""
    probe_pc = 0x801F_0000
    shape_pc = 0x801F_0040
    miss_pc = 0x801F_0080
    ic_pc = 0x801F_00C0
    target_base = 0x801F_4000
    for i in range(lookups):
        probes = 1 + (((i * 7) ^ (i >> 2)) % 5)
        hit = (i % 17) != 0
        for p in range(probes):
            yield BranchEvent(
                pc=probe_pc,
                target=probe_pc - 0x40,
                taken=p < probes - 1,
                kind=BR_COND,
            )
        shape = ((i >> 3) ^ i) % 6
        yield BranchEvent(
            pc=shape_pc,
            target=shape_pc + 0x200,
            taken=shape in (0, 2, 5),
            kind=BR_COND,
        )
        yield BranchEvent(pc=miss_pc, target=miss_pc + 0x240, taken=not hit, kind=BR_COND)
        if hit:
            yield BranchEvent(
                pc=ic_pc,
                target=target_base + shape * 0x100,
                taken=True,
                kind=BR_IND,
            )


def synthetic_allocator_gc_barrier(ops: int = 768) -> Iterator[BranchEvent]:
    """Fast allocation/refcount/write-barrier path with periodic slow calls."""
    alloc_pc = 0x8020_0000
    ref_pc = 0x8020_0040
    barrier_pc = 0x8020_0080
    finalizer_pc = 0x8020_00C0
    target_base = 0x8020_4000
    for i in range(ops):
        refill = (i % 97) == 0
        zero_ref = (i % 43) == 0
        card_dirty = ((i * 5 + (i >> 4)) % 31) in (0, 3)
        yield BranchEvent(pc=alloc_pc, target=alloc_pc + 0x200, taken=refill, kind=BR_COND)
        yield BranchEvent(pc=ref_pc, target=ref_pc + 0x240, taken=zero_ref, kind=BR_COND)
        yield BranchEvent(pc=barrier_pc, target=barrier_pc + 0x280, taken=card_dirty, kind=BR_COND)
        if refill or zero_ref:
            yield BranchEvent(
                pc=finalizer_pc,
                target=target_base + ((i >> 3) % 7) * 0x100,
                taken=True,
                kind=BR_IND,
            )


def synthetic_l2_ftb_target_pressure(sites: int = 6144, passes: int = 2) -> Iterator[BranchEvent]:
    """Taken branch target working set that fits L2 FTB but exceeds L1 FTB.

    GPU drivers and command processors often revisit broad validation/dispatch
    regions after intervening runtime work. The direction of these branches is
    easy; the hard part is retaining enough target metadata. The default site
    count is above the 4096-entry L1 FTB and below the 8192-entry L2 tier, so
    the second pass should expose whether delayed L2 refill/redirect is modeled.
    """
    pc_base = 0x8021_0000
    target_base = 0x8028_0000
    for _pass in range(passes):
        for site in range(sites):
            pc = pc_base + site * 0x20
            yield BranchEvent(
                pc=pc,
                target=target_base + site * 0x20,
                taken=True,
                kind=BR_COND,
            )


def synthetic_gpu_wavefront_compaction(waves: int = 256) -> Iterator[BranchEvent]:
    """GPU wavefront compaction and material dispatch.

    Models shader code that filters inactive lanes, optionally runs a compacted
    path, then dispatches through a small material/function table. Direction
    outcomes are phase-correlated, while one indirect site remains polymorphic.
    """
    active_pc = 0x8022_0000
    compact_pc = 0x8022_0040
    spill_pc = 0x8022_0080
    dispatch_pc = 0x8022_00C0
    material_base = 0x8022_4000
    for wave in range(waves):
        phase = (wave // 32) & 3
        active_lanes = ((wave * 11 + phase * 5) % 33)
        sparse = active_lanes < 8
        full = active_lanes > 28
        yield BranchEvent(
            pc=active_pc,
            target=active_pc + 0x200,
            taken=sparse,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=compact_pc,
            target=compact_pc + 0x240,
            taken=(not full) and ((wave + phase) % 5 != 0),
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=spill_pc,
            target=spill_pc + 0x280,
            taken=sparse and (wave % 7 == 0),
            kind=BR_COND,
        )
        material = ((active_lanes >> 1) ^ wave ^ (phase * 3)) % 10
        yield BranchEvent(
            pc=dispatch_pc,
            target=material_base + material * 0x100,
            taken=True,
            kind=BR_IND,
        )


def synthetic_epoll_rpc_dispatch(connections: int = 640) -> Iterator[BranchEvent]:
    """General-purpose event-loop RPC dispatch with bursty readiness phases."""
    ready_pc = 0x8023_0000
    auth_pc = 0x8023_0040
    parse_pc = 0x8023_0080
    backpressure_pc = 0x8023_00C0
    dispatch_pc = 0x8023_0100
    handler_base = 0x8023_4000
    for i in range(connections):
        burst = (i // 80) & 3
        ready = ((i * 5 + burst) % 13) not in (0, 1)
        authenticated = ((i + burst * 7) % 31) != 0
        parse_fast = ((i ^ (i >> 4)) % 9) not in (0, 4)
        backpressure = burst == 3 and (i % 6) in (0, 1)
        yield BranchEvent(pc=ready_pc, target=ready_pc + 0x200, taken=not ready, kind=BR_COND)
        if not ready:
            continue
        yield BranchEvent(pc=auth_pc, target=auth_pc + 0x240, taken=not authenticated, kind=BR_COND)
        yield BranchEvent(pc=parse_pc, target=parse_pc + 0x280, taken=not parse_fast, kind=BR_COND)
        yield BranchEvent(
            pc=backpressure_pc,
            target=backpressure_pc + 0x2C0,
            taken=backpressure,
            kind=BR_COND,
        )
        if authenticated and not backpressure:
            method = ((i * 17) ^ (burst << 2) ^ (0 if parse_fast else 5)) % 14
            yield BranchEvent(
                pc=dispatch_pc,
                target=handler_base + method * 0x100,
                taken=True,
                kind=BR_IND,
            )


def synthetic_json_parser_state_machine(tokens: int = 768) -> Iterator[BranchEvent]:
    """Parser/state-machine workload with nested depth and rare error exits."""
    token_pc = 0x8024_0000
    depth_pc = 0x8024_0040
    escape_pc = 0x8024_0080
    error_pc = 0x8024_00C0
    state_pc = 0x8024_0100
    state_base = 0x8024_4000
    depth = 0
    for i in range(tokens):
        token = ((i * 19) ^ (i >> 2)) % 16
        opens = token in (0, 3)
        closes = token in (4, 7) and depth > 0
        if opens:
            depth += 1
        elif closes:
            depth -= 1
        string_escape = token in (9, 10) and (i % 5) == 0
        error = (i % 191) == 190 or depth > 12
        yield BranchEvent(pc=token_pc, target=token_pc + 0x200, taken=opens, kind=BR_COND)
        yield BranchEvent(pc=depth_pc, target=depth_pc + 0x240, taken=closes, kind=BR_COND)
        yield BranchEvent(pc=escape_pc, target=escape_pc + 0x280, taken=string_escape, kind=BR_COND)
        yield BranchEvent(pc=error_pc, target=error_pc + 0x2C0, taken=error, kind=BR_COND)
        state = (token + min(depth, 7) * 3 + (1 if string_escape else 0)) % 12
        yield BranchEvent(
            pc=state_pc,
            target=state_base + state * 0x80,
            taken=True,
            kind=BR_IND,
        )


def synthetic_android_runtime_inline_cache(objects: int = 640) -> Iterator[BranchEvent]:
    """Android ART/Hermes-style inline-cache dispatch with tiering phases.

    Models Java/Kotlin and React Native runtime hot paths: null/type guards,
    quickened bytecode checks, polymorphic inline-cache calls, and occasional
    deopt/megamorphic handlers. One indirect PC changes target family by tier.
    """
    null_pc = 0x8025_0000
    quickened_pc = 0x8025_0040
    shape_pc = 0x8025_0080
    deopt_pc = 0x8025_00C0
    dispatch_pc = 0x8025_0100
    handler_base = 0x8025_4000
    deopt_base = 0x8025_9000
    for i in range(objects):
        tier = (i // 160) & 3
        shape = ((i * 11) ^ (i >> 3) ^ tier) % (3 + tier * 2)
        nullish = (i % 97) == 0
        quickened = tier >= 1 and ((i + shape) % 13) != 0
        prototype_hit = shape in (0, 2, 5, 7) and (i % 17) != 0
        deopt = nullish or (tier == 3 and (i % 29) == 0)
        yield BranchEvent(pc=null_pc, target=null_pc + 0x200, taken=nullish, kind=BR_COND)
        yield BranchEvent(
            pc=quickened_pc,
            target=quickened_pc + 0x240,
            taken=quickened,
            kind=BR_COND,
        )
        yield BranchEvent(
            pc=shape_pc,
            target=shape_pc + 0x280,
            taken=prototype_hit,
            kind=BR_COND,
        )
        yield BranchEvent(pc=deopt_pc, target=deopt_pc + 0x2C0, taken=deopt, kind=BR_COND)
        if deopt:
            target = deopt_base + (tier % 4) * 0x100
        else:
            target = handler_base + (tier * 8 + shape) * 0x80
        yield BranchEvent(pc=dispatch_pc, target=target, taken=True, kind=BR_IND)


def synthetic_signal_exception_unwind(frames: int = 9, rounds: int = 48) -> Iterator[BranchEvent]:
    """OS signal/exception delivery and unwind with non-LIFO returns.

    Normal call stacks are interrupted by signal trampolines, catch blocks, and
    longjmp-like resumes. The trace keeps RAS-friendly call/return traffic but
    injects bounded non-LIFO return targets at production-relevant frequencies.
    """
    call_base = 0x8026_0000
    body_base = 0x8026_4000
    ret_base = 0x8026_8000
    signal_pc = 0x8026_C000
    handler_pc = 0x8026_C040
    resume_base = 0x8027_0000
    for r in range(rounds):
        depth = 3 + (r % frames)
        signal_pending = (r % 10) == 7
        exception_pending = (r % 13) == 12
        for i in range(depth):
            call_pc = call_base + i * 0x40
            yield BranchEvent(
                pc=call_pc,
                target=body_base + i * 0x80,
                taken=True,
                kind=BR_CALL,
                call_return_pc=call_pc + 0x20,
            )
        yield BranchEvent(
            pc=signal_pc,
            target=signal_pc + 0x200,
            taken=signal_pending,
            kind=BR_COND,
        )
        if signal_pending:
            yield BranchEvent(
                pc=handler_pc,
                target=resume_base + (r % 5) * 0x100,
                taken=True,
                kind=BR_CALL,
                call_return_pc=handler_pc + 0x20,
            )
            yield BranchEvent(
                pc=handler_pc + 0x80,
                target=call_base + ((r + 1) % depth) * 0x40 + 0x20,
                taken=True,
                kind=BR_RET,
            )
        unwind_cut = depth // 2 if exception_pending else -1
        for i in range(depth - 1, -1, -1):
            expected = call_base + i * 0x40 + 0x20
            if exception_pending and i == unwind_cut:
                target = resume_base + 0x800 + (r % 4) * 0x100
            else:
                target = expected
            yield BranchEvent(pc=ret_base + i * 0x80, target=target, taken=True, kind=BR_RET)


def synthetic_gpu_driver_submit_phases(submits: int = 384) -> Iterator[BranchEvent]:
    """GPU driver command-submission phases across validate/map/submit/wait."""
    batch_pc = 0x8028_0000
    residency_pc = 0x8028_0040
    fence_pc = 0x8028_0080
    throttle_pc = 0x8028_00C0
    ioctl_pc = 0x8028_0100
    handler_base = 0x8028_4000
    for i in range(submits):
        phase = (i // 64) % 6
        batch_full = ((i + phase * 3) % 16) in (0, 1, 2)
        residency_miss = phase in (1, 4) and ((i * 5 + phase) % 23) == 0
        fence_wait = phase in (2, 5) and (i % 7) in (0, 1)
        throttled = phase == 5 and (i % 11) in (0, 3)
        yield BranchEvent(pc=batch_pc, target=batch_pc + 0x200, taken=batch_full, kind=BR_COND)
        yield BranchEvent(
            pc=residency_pc,
            target=residency_pc + 0x240,
            taken=residency_miss,
            kind=BR_COND,
        )
        yield BranchEvent(pc=fence_pc, target=fence_pc + 0x280, taken=fence_wait, kind=BR_COND)
        yield BranchEvent(
            pc=throttle_pc,
            target=throttle_pc + 0x2C0,
            taken=throttled,
            kind=BR_COND,
        )
        if not throttled:
            queue = ((i * 13) ^ (phase << 3) ^ (4 if fence_wait else 0)) % 16
            yield BranchEvent(
                pc=ioctl_pc,
                target=handler_base + queue * 0x100,
                taken=True,
                kind=BR_IND,
                workload_class=1,
            )


def synthetic_workload_class_phase_alias(rounds: int = 256) -> Iterator[BranchEvent]:
    """Same virtual branch PCs reused by general and GPU runtime phases."""
    guard_pc = 0x8029_0000
    call_pc = 0x8029_0040
    general_target = 0x8029_8000
    gpu_target = 0x802A_0000
    for i in range(rounds):
        gpu_phase = (i // 8) & 1
        target = gpu_target if gpu_phase else general_target
        yield BranchEvent(
            pc=guard_pc,
            target=guard_pc + 0x200,
            taken=(i % 5) == (2 if gpu_phase else 0),
            kind=BR_COND,
            workload_class=gpu_phase,
        )
        yield BranchEvent(
            pc=call_pc,
            target=target + ((i % 4) * 0x80),
            taken=True,
            kind=BR_IND,
            workload_class=gpu_phase,
        )


def synthetic_cross_asid_same_pc_alias(rounds: int = 320) -> Iterator[BranchEvent]:
    """Same virtual PCs with conflicting behavior across ASID/VMID domains."""
    guard_pc = 0x802A_8000
    dispatch_pc = 0x802A_8040
    target_base = 0x802B_0000
    for i in range(rounds):
        domain = (i // 4) & 1
        asid = 0x21 if domain == 0 else 0xA7
        vmid = 1 if domain == 0 else 3
        taken = ((i + domain * 3) % 7) in ((0, 1, 4) if domain == 0 else (2, 5, 6))
        yield BranchEvent(
            pc=guard_pc,
            target=guard_pc + 0x200 + domain * 0x80,
            taken=taken,
            kind=BR_COND,
            asid=asid,
            vmid=vmid,
            priv=domain,
        )
        yield BranchEvent(
            pc=dispatch_pc,
            target=target_base + domain * 0x1000 + ((i >> 2) % 5) * 0x100,
            taken=True,
            kind=BR_IND,
            asid=asid,
            vmid=vmid,
            priv=domain,
        )


def synthetic_wasm_threaded_interpreter_tiering(ops: int = 704) -> Iterator[BranchEvent]:
    """Wasm/threaded interpreter dispatch with tier-up and deopt phases."""
    bounds_pc = 0x802C_0000
    type_pc = 0x802C_0040
    tier_pc = 0x802C_0080
    dispatch_pc = 0x802C_00C0
    handler_base = 0x802C_4000
    baseline_base = 0x802D_0000
    opt_base = 0x802D_8000
    for i in range(ops):
        tier = min(3, i // 176)
        opcode = ((i * 23) ^ (i >> 3) ^ (tier * 5)) % 19
        bounds_fail = opcode in (5, 11) and (i % 37) == 0
        type_slow = (opcode % 7) == (tier + 1) % 7
        tier_up = tier >= 1 and (i % 41) in (0, 1)
        yield BranchEvent(pc=bounds_pc, target=bounds_pc + 0x200, taken=bounds_fail, kind=BR_COND)
        yield BranchEvent(pc=type_pc, target=type_pc + 0x240, taken=type_slow, kind=BR_COND)
        yield BranchEvent(pc=tier_pc, target=tier_pc + 0x280, taken=tier_up, kind=BR_COND)
        if bounds_fail:
            target = handler_base + 0x3000 + (opcode % 4) * 0x100
        elif tier >= 2 and not type_slow:
            target = opt_base + opcode * 0x80
        else:
            target = baseline_base + opcode * 0x80
        yield BranchEvent(pc=dispatch_pc, target=target, taken=True, kind=BR_IND)


SYNTHETIC_GENERATORS: dict[str, Callable[[], Iterable[BranchEvent]]] = {
    "always_taken": synthetic_always_taken_loop,
    "always_not_taken": synthetic_always_not_taken,
    "alternating": synthetic_alternating,
    "loop_with_known_trip": synthetic_loop_known_count,
    "deep_recursion": synthetic_recursive_call_return,
    "v8_indirect_dispatch": synthetic_indirect_dispatch,
    "mixed_workload": synthetic_mixed_workload,
    "jit_dispatch_warmup": synthetic_jit_dispatch_warmup,
    "gpu_tile_kernel": synthetic_gpu_tile_kernel,
    "gpu_warp_divergence": synthetic_gpu_warp_divergence,
    "gpu_command_processor": synthetic_gpu_command_processor,
    "dual_branch_fetch_block": synthetic_dual_branch_fetch_block,
    "nested_imli_loop": synthetic_nested_imli_loop,
    "correlated_xor_branches": synthetic_correlated_xor_branches,
    "vtable_path_correlated": synthetic_vtable_path_correlated,
    "interpreter_dispatch_mixed": synthetic_interpreter_dispatch_mixed,
    "phase_change_server": synthetic_phase_change_server,
    "alias_thrash": synthetic_alias_thrash,
    "gpu_occupancy_phase": synthetic_gpu_occupancy_phase,
    "return_mismatch_exceptions": synthetic_return_mismatch_exceptions,
    "gpu_nested_reconvergence": synthetic_gpu_nested_reconvergence,
    "control_indirect_pair": synthetic_control_indirect_pair,
    "btb_confidence_churn": synthetic_btb_confidence_churn,
    "command_buffer_validation": synthetic_command_buffer_validation,
    "work_stealing_queues": synthetic_work_stealing_queues,
    "hash_probe_inline_cache": synthetic_hash_probe_inline_cache,
    "allocator_gc_barrier": synthetic_allocator_gc_barrier,
    "l2_ftb_target_pressure": synthetic_l2_ftb_target_pressure,
    "gpu_wavefront_compaction": synthetic_gpu_wavefront_compaction,
    "epoll_rpc_dispatch": synthetic_epoll_rpc_dispatch,
    "json_parser_state_machine": synthetic_json_parser_state_machine,
    "android_runtime_inline_cache": synthetic_android_runtime_inline_cache,
    "signal_exception_unwind": synthetic_signal_exception_unwind,
    "gpu_driver_submit_phases": synthetic_gpu_driver_submit_phases,
    "workload_class_phase_alias": synthetic_workload_class_phase_alias,
    "cross_asid_same_pc_alias": synthetic_cross_asid_same_pc_alias,
    "wasm_threaded_interpreter_tiering": synthetic_wasm_threaded_interpreter_tiering,
}

# Stress test on RAS overflow — kept available for direct invocation by the
# RAS regression but not part of the canonical 8-workload MPKI suite.
EXTENDED_GENERATORS: dict[str, Callable[[], Iterable[BranchEvent]]] = {
    "irregular_calls": synthetic_irregular_calls,
}
