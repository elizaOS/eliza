#!/usr/bin/env python3
"""Cross-domain microarchitectural purge-sequence model (lane 04 section 6).

Models the ordered cd_state_purge sequence the future cd_purge_seq.sv (BLOCKED)
fans out on every confidential-domain boundary crossing. The hardware invariant
(proven later by SVA, BLOCKED on Verilator/formal) is: no boundary crossing
completes while any purge step is unacked, and the steps run in dependency
order. This pure-software model lets the order + completeness be tested now.
"""

from __future__ import annotations

# Dependency order from section 6: stop fetch -> drain store buffer + MSHRs ->
# writeback-invalidate L1D -> invalidate L1I + TLB/PWC -> flush BPU/RAS/BTB ->
# freeze+zero PMU -> ack.
PURGE_STEPS: tuple[str, ...] = (
    "stop-fetch",
    "drain-store-buffer-mshr",
    "writeback-invalidate-l1d",
    "invalidate-l1i-tlb-pwc",
    "flush-bpu-ras-btb",
    "freeze-zero-pmu",
    "ack",
)


class PurgeError(Exception):
    """Raised when the purge sequence is incomplete or out of order."""


class PurgeSequencer:
    """Tracks purge-step acks for one boundary crossing.

    A crossing may complete only after every step has acked in order. Acking a
    step before its predecessor, or completing before the final ack, faults.
    """

    def __init__(self) -> None:
        self._next_index = 0

    def ack(self, step: str) -> None:
        if self._next_index >= len(PURGE_STEPS):
            raise PurgeError(f"unexpected extra purge step {step!r} after ack")
        expected = PURGE_STEPS[self._next_index]
        if step != expected:
            raise PurgeError(f"purge step out of order: expected {expected!r}, got {step!r}")
        self._next_index += 1

    @property
    def complete(self) -> bool:
        return self._next_index == len(PURGE_STEPS)

    def assert_can_cross(self) -> None:
        if not self.complete:
            remaining = PURGE_STEPS[self._next_index:]
            raise PurgeError(
                "boundary crossing blocked: purge incomplete, "
                f"pending {', '.join(remaining)}"
            )
