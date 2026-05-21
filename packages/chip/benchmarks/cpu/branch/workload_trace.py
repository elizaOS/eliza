"""Real-workload branch-trace capture for the Eliza E1 BPU.

The CBP-5 traces and synthetic generators cover championship and corner-case
behaviour, but the E1's actual duty cycle is a looping multimodal agent:
``llama.cpp`` token loops, tokenizer/string processing, logit sampling, and
streamed-output state machines. This module turns a *real* execution of that
workload into the branch-event stream the :class:`BPUSimulator` consumes.

The capture path is privilege-free and ISA-faithful to the E1 target (RV64):

1. The workload is built for ``riscv64`` and run under ``qemu-riscv64`` user
   mode with QEMU's ``libexeclog`` TCG plugin, which emits one line per
   retired instruction (``cpu, pc, opcode, "disasm"[, mem...]``).
2. :func:`decode_execlog` walks that instruction stream. Every control
   transfer is reconstructed exactly: the *next* executed instruction's PC is
   ground truth for direction (taken vs fall-through) and indirect target,
   and the disassembler's ``# 0x...`` comment supplies direct targets.

No hardware PMU access, no ``perf_event_paranoid`` relaxation, and no Docker
are required — it is the native-toolchain path mandated for Linux x64 hosts.
Because the trace is RV64, FTB/ITTAGE/RAS targets match what the silicon BPU
will actually see, unlike an x86 host capture.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .bpu_model import BR_CALL, BR_COND, BR_IND, BR_NONE, BR_RET, BranchEvent

WORKLOAD_TRACE_SCHEMA = "eliza.bpu_workload_trace.v1"

# execlog line: `<cpu>, 0x<pc>, 0x<opcode>, "<disasm>"[, <memtype>, 0x<addr>]`
_EXECLOG_RE = re.compile(
    r'^\s*\d+,\s*0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+),\s*"([^"]*)"'
)
# Trailing `# 0x<target>` comment emitted for PC-relative control transfers.
_TARGET_COMMENT_RE = re.compile(r"#\s*0x([0-9a-fA-F]+)")

# RISC-V conditional branch mnemonics (base + canonicalised compressed forms).
_COND_MNEMONICS = frozenset(
    {"beq", "bne", "blt", "bge", "bltu", "bgeu", "beqz", "bnez", "blez", "bgez", "bltz", "bgtz"}
)


def _insn_size(opcode: int) -> int:
    """RV instruction length from the low bits: 16-bit unless ``op[1:0]==11``."""
    return 4 if (opcode & 0x3) == 0x3 else 2


@dataclass
class WorkloadTraceStats:
    instruction_count: int = 0
    branch_count: int = 0
    cond: int = 0
    direct_jump: int = 0
    call: int = 0
    indirect: int = 0
    ret: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "instruction_count": self.instruction_count,
            "branch_count": self.branch_count,
            "cond_branch_count": self.cond,
            "direct_jump_count": self.direct_jump,
            "call_count": self.call,
            "indirect_branch_count": self.indirect,
            "return_count": self.ret,
        }


@dataclass
class _PendingBranch:
    pc: int
    opcode: int
    mnemonic: str
    operands: str
    comment_target: int | None
    kind: int


def _classify(mnemonic: str, operands: str) -> int | None:
    """Map an RV64 control-transfer mnemonic to a BPU branch kind.

    Returns ``None`` for non-control instructions. Direct unconditional jumps
    map to :data:`BR_COND` (always-taken) to match the CBP-5 ingest mapping,
    where ``UNCOND_DIR_BR`` is a taken conditional with an FTB target.
    """
    if mnemonic in _COND_MNEMONICS:
        return BR_COND
    if mnemonic == "ret":
        return BR_RET
    if mnemonic == "j":
        return BR_COND  # unconditional direct jump, always taken
    if mnemonic == "jal":
        # `jal ra, ...` is a direct call; `jal x0` disassembles as `j`.
        return BR_CALL if operands.split(",", 1)[0].strip() == "ra" else BR_COND
    if mnemonic == "call":
        return BR_CALL
    if mnemonic in ("jalr", "jr", "tail", "jalrx"):
        # `jalr ra,...`/`call`-style indirect call vs plain indirect jump.
        first = operands.split(",", 1)[0].strip()
        if mnemonic == "jalr" and first == "ra":
            return BR_CALL
        return BR_IND
    return None


def decode_execlog(path: Path) -> tuple[list[BranchEvent], WorkloadTraceStats]:
    """Reconstruct an exact branch-event list from a QEMU execlog file.

    A single forward pass: a control transfer is buffered until the next
    instruction's PC is observed, which is the architectural next-PC and so
    resolves direction and indirect target exactly.
    """
    branches: list[BranchEvent] = []
    stats = WorkloadTraceStats()
    pending: _PendingBranch | None = None

    def flush(next_pc: int) -> None:
        nonlocal pending
        if pending is None:
            return
        size = _insn_size(pending.opcode)
        fall_through = pending.pc + size
        kind = pending.kind
        if kind == BR_COND:
            taken = next_pc != fall_through
            target = pending.comment_target if pending.comment_target is not None else next_pc
            if pending.mnemonic in ("j", "jal"):  # unconditional direct
                taken = True
                stats.direct_jump += 1
            else:
                stats.cond += 1
        else:
            taken = True
            target = next_pc  # indirect/call/ret: real target is the next PC
            if kind == BR_CALL:
                stats.call += 1
            elif kind == BR_IND:
                stats.indirect += 1
            elif kind == BR_RET:
                stats.ret += 1
        branches.append(
            BranchEvent(
                pc=pending.pc,
                target=target,
                taken=taken,
                kind=kind,
                call_return_pc=fall_through if kind == BR_CALL else None,
            )
        )
        stats.branch_count += 1
        pending = None

    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            m = _EXECLOG_RE.match(line)
            if m is None:
                continue
            pc = int(m.group(1), 16)
            opcode = int(m.group(2), 16)
            disasm = m.group(3)
            stats.instruction_count += 1
            flush(pc)
            tokens = disasm.split(None, 1)
            mnemonic = tokens[0] if tokens else ""
            operands = tokens[1].split("#", 1)[0].strip() if len(tokens) > 1 else ""
            kind = _classify(mnemonic, operands)
            if kind is None or kind == BR_NONE:
                continue
            ct = _TARGET_COMMENT_RE.search(disasm)
            pending = _PendingBranch(
                pc=pc,
                opcode=opcode,
                mnemonic=mnemonic,
                operands=operands,
                comment_target=int(ct.group(1), 16) if ct else None,
                kind=kind,
            )
    # A branch as the final retired instruction has no observed next PC; drop
    # it rather than invent a target (one event out of millions).
    return branches, stats


def write_workload_trace(
    out: Path,
    branches: list[BranchEvent],
    stats: WorkloadTraceStats,
    source: dict[str, object],
) -> None:
    """Persist a decoded trace as a ``.btrace.json`` document."""
    doc = {
        "schema": WORKLOAD_TRACE_SCHEMA,
        "source": source,
        "instruction_count": stats.instruction_count,
        "branch_count": stats.branch_count,
        "class_counts": stats.as_dict(),
        # Compact row form: [pc, target, taken(0/1), kind, call_return_pc(-1=None)]
        "branches": [
            [b.pc, b.target, int(b.taken), b.kind, -1 if b.call_return_pc is None else b.call_return_pc]
            for b in branches
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc) + "\n")


def read_workload_trace(path: Path) -> tuple[list[BranchEvent], int]:
    """Load a ``.btrace.json`` document; return (branches, instruction_count)."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    if doc.get("schema") != WORKLOAD_TRACE_SCHEMA:
        raise ValueError(f"{path} is not a {WORKLOAD_TRACE_SCHEMA} document")
    branches = [
        BranchEvent(
            pc=row[0],
            target=row[1],
            taken=bool(row[2]),
            kind=row[3],
            call_return_pc=None if row[4] < 0 else row[4],
        )
        for row in doc["branches"]
    ]
    return branches, int(doc["instruction_count"])


def iter_workload_branches(path: Path) -> Iterator[BranchEvent]:
    branches, _ = read_workload_trace(path)
    yield from branches
