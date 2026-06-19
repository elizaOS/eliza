"""Baseline branch predictors for apples-to-apples MPKI comparison.

These models replay the *same* :class:`benchmarks.cpu.branch.bpu_model.BranchEvent`
stream that drives the Eliza E1 :class:`BPUSimulator`, so a single trace can be
scored against the E1 BPU and against a classic predictor under identical
conditions (same branch list, same retired-instruction denominator).

The primary baseline is :class:`Cva6BaselinePredictor`, a faithful behavioural
model of the CVA6/Ariane front-end predictor. CVA6 is a deliberately simple
in-order core: it has no TAGE, no statistical corrector, no ITTAGE, and no loop
predictor. Its predictor is three small structures, sized from the canonical
64-bit default configuration ``cv64a6_imafdc_sv39_config_pkg.sv``:

  * **BHT** (``bht.sv``, ``CVA6ConfigBHTEntries = 128``): 128-entry table of
    2-bit saturating counters, indexed by PC only (no global history).
    Predicts the *direction* of conditional branches. The counter update rule
    is the one in ``bht.sv``: increment toward taken, decrement toward
    not-taken, saturating at ``2'b11`` / ``2'b00``. When an entry has never
    been written (``valid == 0``) CVA6 falls back to the static rule in
    ``frontend.sv``: predict taken iff the branch displacement is negative
    (backward branch). The model applies the same backward-taken static
    default until the first update writes the entry.

  * **BTB** (``btb.sv``, ``CVA6ConfigBTBEntries = 32``): 32-entry, PC-indexed,
    untagged target buffer. In ``frontend.sv`` it resolves *only* register-
    indirect jumps (``JumpR`` / ``is_jalr``). Direct jumps and conditional
    branches take their target from the decoded immediate, so those targets are
    always architecturally correct. The BTB therefore matters for indirect
    jumps and indirect calls.

  * **RAS** (``ras.sv``, ``CVA6ConfigRASDepth = 2``): a 2-entry return-address
    stack. Calls push ``pc + insn_size``; returns pop the top. With depth 2 it
    mispredicts any return whose matching call is more than two frames deep.

Citations (paths relative to the chip package):
  * ``external/cva6/cva6/core/include/cv64a6_imafdc_sv39_config_pkg.sv:62-64``
    — ``RASDepth=2``, ``BTBEntries=32``, ``BHTEntries=128``.
  * ``external/cva6/cva6/core/frontend/bht.sv:24-103`` — 2-bit counter table,
    PC-indexed, saturating update.
  * ``external/cva6/cva6/core/frontend/btb.sv:28-203`` — untagged target buffer
    used for register-indirect jumps.
  * ``external/cva6/cva6/core/frontend/ras.sv:17-78`` — depth-parameterised RAS.
  * ``external/cva6/cva6/core/frontend/frontend.sv:236-297`` — prediction flow:
    JumpR via BTB, Jump via immediate, Return via RAS, Branch via BHT with a
    backward-taken static fallback.

These are behavioural models (claim level L2_ARCH_SIM), not the CVA6 RTL. They
exist to bound how a simple BHT/BTB/RAS predictor behaves on the identical
traces the E1 BPU is scored on.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

from .bpu_model import BR_CALL, BR_COND, BR_DIRECT, BR_IND, BR_RET, BranchEvent

# CVA6 64-bit default predictor sizing (cv64a6_imafdc_sv39_config_pkg.sv).
CVA6_BHT_ENTRIES = 128
CVA6_BTB_ENTRIES = 32
CVA6_RAS_DEPTH = 2
CVA6_BHT_CTR_W = 2

CVA6_CONFIG: dict[str, object] = {
    "predictor": "cva6_ariane_bht_btb_ras",
    "source": "external/cva6/cva6/core",
    "config_pkg": "cv64a6_imafdc_sv39_config_pkg.sv",
    "BHT_ENTRIES": CVA6_BHT_ENTRIES,
    "BHT_CTR_W": CVA6_BHT_CTR_W,
    "BHT_INDEX": "pc_only_no_history",
    "BTB_ENTRIES": CVA6_BTB_ENTRIES,
    "BTB_USED_FOR": "register_indirect_jumps_only",
    "RAS_DEPTH": CVA6_RAS_DEPTH,
    "static_fallback": "backward_taken_when_bht_entry_invalid",
    "has_tage": False,
    "has_statistical_corrector": False,
    "has_ittage": False,
    "has_loop_predictor": False,
    "citations": [
        "external/cva6/cva6/core/include/cv64a6_imafdc_sv39_config_pkg.sv:62-64",
        "external/cva6/cva6/core/frontend/bht.sv:24-103",
        "external/cva6/cva6/core/frontend/btb.sv:28-203",
        "external/cva6/cva6/core/frontend/ras.sv:17-78",
        "external/cva6/cva6/core/frontend/frontend.sv:236-297",
    ],
}


@dataclass
class _Bht:
    """CVA6 bht.sv: PC-indexed 2-bit saturating counters with a valid bit."""

    entries: int
    ctr_w: int
    counters: list[int] = field(default_factory=list)
    valid: list[bool] = field(default_factory=list)

    @classmethod
    def build(cls, entries: int, ctr_w: int) -> _Bht:
        return cls(
            entries=entries,
            ctr_w=ctr_w,
            counters=[0] * entries,
            valid=[False] * entries,
        )

    def _idx(self, pc: int) -> int:
        # frontend.sv indexes the BHT row from pc bits above the offset; the
        # low bits are the fetch-block offset. Mirror "pc >> 1" the E1 bimodal
        # uses so both predictors hash the same PC bits onto their tables.
        return (pc >> 1) % self.entries

    def predict_valid(self, pc: int) -> tuple[bool, bool]:
        """Return (entry_valid, predicted_taken_from_counter)."""
        idx = self._idx(pc)
        taken = (self.counters[idx] >> (self.ctr_w - 1)) == 1
        return self.valid[idx], taken

    def update(self, pc: int, taken: bool) -> None:
        idx = self._idx(pc)
        self.valid[idx] = True
        ctr = self.counters[idx]
        top = (1 << self.ctr_w) - 1
        if taken and ctr != top:
            self.counters[idx] = ctr + 1
        elif not taken and ctr != 0:
            self.counters[idx] = ctr - 1


@dataclass
class _Btb:
    """CVA6 btb.sv: small untagged, PC-indexed target buffer.

    Untagged means aliasing PCs share an entry — exactly the CVA6 behaviour.
    Only register-indirect jumps consult the BTB for their target.
    """

    entries: int
    targets: list[int | None] = field(default_factory=list)

    @classmethod
    def build(cls, entries: int) -> _Btb:
        return cls(entries=entries, targets=[None] * entries)

    def _idx(self, pc: int) -> int:
        return (pc >> 1) % self.entries

    def lookup(self, pc: int) -> int | None:
        return self.targets[self._idx(pc)]

    def update(self, pc: int, target: int) -> None:
        self.targets[self._idx(pc)] = target


@dataclass
class _Ras:
    """CVA6 ras.sv: fixed-depth return-address stack (default depth 2).

    A depth-2 stack drops the oldest entry on overflow, so any return whose
    matching call sits more than two frames down mispredicts.
    """

    depth: int
    stack: list[int] = field(default_factory=list)

    def push(self, addr: int) -> None:
        self.stack.append(addr)
        if len(self.stack) > self.depth:
            # Bottom of stack is overwritten (shift register, depth entries).
            self.stack.pop(0)

    def pop(self) -> int | None:
        if not self.stack:
            return None
        return self.stack.pop()


@dataclass
class Cva6BaselinePredictor:
    """Faithful behavioural model of the CVA6/Ariane front-end predictor.

    Drives the same :class:`BranchEvent` stream as :class:`BPUSimulator`. A
    misprediction is counted exactly like the E1 model: wrong direction, or a
    taken branch sent to the wrong target.
    """

    bht_entries: int = CVA6_BHT_ENTRIES
    btb_entries: int = CVA6_BTB_ENTRIES
    ras_depth: int = CVA6_RAS_DEPTH
    bht_ctr_w: int = CVA6_BHT_CTR_W
    fetch_block_bytes: int = 32
    bht: _Bht = field(init=False)
    btb: _Btb = field(init=False)
    ras: _Ras = field(init=False)
    counters: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def __post_init__(self) -> None:
        self.bht = _Bht.build(self.bht_entries, self.bht_ctr_w)
        self.btb = _Btb.build(self.btb_entries)
        self.ras = _Ras(depth=self.ras_depth)

    def _fall_through(self, event: BranchEvent) -> int:
        if event.call_return_pc is not None:
            return event.call_return_pc
        return event.pc + self.fetch_block_bytes

    def _predict(self, event: BranchEvent) -> tuple[bool, int]:
        if event.kind == BR_COND:
            valid, ctr_taken = self.bht.predict_valid(event.pc)
            # frontend.sv static fallback (entry invalid): backward branch taken.
            taken = ctr_taken if valid else event.target < event.pc
            # Conditional-branch target is the decoded immediate, always correct
            # when taken (frontend.sv: predict_address = pc + imm).
            target = event.target if taken else self._fall_through(event)
            return taken, target
        if event.kind == BR_RET:
            top = self.ras.pop()
            return True, top if top is not None else self._fall_through(event)
        if event.kind == BR_CALL:
            # A direct call's target is the decoded immediate (always correct);
            # an indirect call must come from the BTB. We cannot see the encoding
            # here, so use the BTB target when present and fall back to the
            # decoded target otherwise — this is favourable to CVA6 (it treats
            # direct calls as correctly targeted), keeping the comparison honest.
            btb_target = self.btb.lookup(event.pc)
            target = btb_target if btb_target is not None else event.target
            self.ras.push(self._fall_through(event))
            return True, target
        if event.kind == BR_DIRECT:
            return True, event.target
        if event.kind == BR_IND:
            btb_target = self.btb.lookup(event.pc)
            # JumpR with no valid BTB entry: frontend.sv leaves cf_type NoCF, so
            # the indirect jump is not predicted taken — a guaranteed miss on a
            # taken indirect. Model that as a fall-through prediction.
            target = btb_target if btb_target is not None else self._fall_through(event)
            return True, target
        return False, self._fall_through(event)

    def _step(self, event: BranchEvent) -> None:
        pred_taken, pred_target = self._predict(event)
        misp = (pred_taken != event.taken) or (event.taken and pred_target != event.target)

        self.counters["pred"] += 1
        if event.kind == BR_COND:
            self.counters["cond"] += 1
            if misp:
                self.counters["cond_misp"] += 1
        elif event.kind == BR_CALL:
            self.counters["call"] += 1
            if misp:
                self.counters["ind_misp"] += 1
        elif event.kind == BR_IND:
            self.counters["ind"] += 1
            if misp:
                self.counters["ind_misp"] += 1
        elif event.kind == BR_RET:
            self.counters["ret"] += 1
            if misp:
                self.counters["ret_misp"] += 1
        elif event.kind == BR_DIRECT:
            self.counters["direct"] += 1
        if misp:
            self.counters["misp"] += 1

        # Train. CVA6 updates the BHT on conditional resolution, the BTB on a
        # mispredicted target, and the RAS structurally on call/return.
        if event.kind == BR_COND:
            self.bht.update(event.pc, event.taken)
        elif event.kind in (BR_CALL, BR_IND, BR_DIRECT):
            self.btb.update(event.pc, event.target)

    def feed(self, events: Iterable[BranchEvent]) -> None:
        for event in events:
            self._step(event)

    def mpki(self, instruction_count: int) -> float:
        if instruction_count <= 0:
            return float("nan")
        return self.counters["misp"] * 1000.0 / instruction_count

    def stats(self) -> dict[str, int]:
        return dict(self.counters)
