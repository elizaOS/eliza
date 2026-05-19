"""Trace ingest and synthetic trace generation for the BPU MPKI harness.

Three trace sources are supported today:

  * ``cbp5``: Championship Branch Prediction 2025 binary trace format,
    eight bytes per record packed as
    ``<uint64 pc><uint64 target><uint8 taken><uint8 kind>``. The CBP-5
    distribution is the same shape; we parse a minimal subset.
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

import json
import struct
from pathlib import Path
from typing import Iterable, Iterator

from .bpu_model import BR_CALL, BR_COND, BR_NONE, BR_RET, BranchEvent


def read_cbp5(path: Path) -> Iterator[BranchEvent]:
    """Yield branch events from a CBP-5-formatted binary trace."""
    record = struct.Struct("<QQBB")
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(record.size)
            if len(chunk) != record.size:
                return
            pc, target, taken, kind = record.unpack(chunk)
            yield BranchEvent(pc=pc, target=target, taken=bool(taken), kind=kind)


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


def synthetic_alternating(iterations: int = 1_000) -> Iterator[BranchEvent]:
    pc = 0x8000_2000
    target = 0x8000_2080
    for i in range(iterations):
        taken = (i % 2) == 0
        yield BranchEvent(pc=pc, target=target, taken=taken, kind=BR_COND)


def synthetic_loop_known_count(
    trips: int = 16, repetitions: int = 64
) -> Iterator[BranchEvent]:
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
            yield BranchEvent(
                pc=call_base + i * 0x40,
                target=call_base + (i + 1) * 0x40,
                taken=True,
                kind=BR_CALL,
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
            yield BranchEvent(
                pc=0x8000_6000 + i * 0x40,
                target=0x8000_7000 + i * 0x40,
                taken=True,
                kind=BR_CALL,
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


SYNTHETIC_GENERATORS: dict[str, callable[[], Iterable[BranchEvent]]] = {
    "always_taken_loop": synthetic_always_taken_loop,
    "alternating": synthetic_alternating,
    "loop_known_count": synthetic_loop_known_count,
    "recursive_call_return": synthetic_recursive_call_return,
    "irregular_calls": synthetic_irregular_calls,
    "indirect_dispatch": synthetic_indirect_dispatch,
}
