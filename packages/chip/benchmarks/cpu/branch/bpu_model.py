"""Behavioural Python model of the Eliza E1 BPU.

This is a functional companion to ``rtl/cpu/bpu/bpu_top.sv``: every storage
table, history register, and update rule has the same shape as the RTL, but
the data structures are dicts/lists for iteration speed. The model is used
by :mod:`benchmarks.cpu.branch.run_mpki` to evaluate MPKI on branch traces
without paying for a cycle-accurate cosim.

The numerical results of this model are not silicon evidence. They are a
pre-silicon planning tool that complements the cocotb regression. Real
phone-class MPKI claims remain blocked until the harness ingests SPEC, AOSP,
and JS-engine traces — the policy is enforced by
``scripts/check_branch_prediction.py`` and the gate JSON it writes.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

BR_NONE = 0
BR_COND = 1
BR_CALL = 2
BR_RET = 3
# Indirect jump (e.g. switch dispatch, vtable, PLT). Predicted by ITTAGE
# but does NOT push or pop the RAS. Kept distinct from BR_CALL so that
# real traces (CBP-5, SPEC, AOSP) do not corrupt the RAS.
BR_IND = 4
# Unconditional direct jump. This trains target arrays without consuming
# conditional direction capacity and without mutating the RAS.
BR_DIRECT = 5

# Per-table geometry mirrors rtl/cpu/bpu/bpu_pkg.sv.
DEFAULT_GEOMETRY: dict[str, Any] = {
    "FETCH_BLOCK_BYTES": 32,
    # Experiment-only front-end limit: how many conditional-branch predictions
    # can be carried for one fetched block. Many production predictors carry
    # two branch predictions per block; a one-slot front end loses when an early
    # in-block guard falls through to a later taken branch.
    "FETCH_BLOCK_BRANCH_SLOTS": 2,
    "BIM_ENTRIES": 16384,
    "BIM_CTR_W": 2,
    "TAGE_TABLES": 5,
    "TAGE_ENTRIES_TABLE": 8192,
    "TAGE_TAG_W": 8,
    "TAGE_CTR_W": 3,
    "TAGE_USEFUL_W": 2,
    "TAGE_USE_ALT_ON_NA": 0,
    # Allocation/aging policy. Useful-bit aging mirrors bpu_pkg.sv
    # TAGE_USEFUL_RESET_PERIOD; allocation decrement mirrors tage.sv aging of
    # occupied candidate victims while walking the allocation stack.
    "TAGE_ALLOC_DECREMENT": True,
    "TAGE_UBIT_RESET_PERIOD": 100_000,  # branches between useful-bit aging
    "TAGE_HIST_LEN": (8, 16, 44, 90, 195),
    "SC_TABLES": 6,
    "SC_ENTRIES_TABLE": 1024,
    "SC_CTR_W": 6,
    "SC_HIST_LEN": (0, 4, 10, 16, 27, 44),
    "SC_THRESH_INIT": 6,
    "SC_ADAPTIVE": True,
    "SC_LOCAL_HISTORY_BITS": 8,
    "SC_LOCAL_HISTORY_ENTRIES": 1024,
    "SC_BIAS_ENABLE": 0,
    "SC_BIAS_ENTRIES": 2048,
    "SC_BIAS_CTR_W": 5,
    "H2P_ENABLE": 1,
    "H2P_ENTRIES": 512,
    "H2P_HIST_LEN": 64,
    "H2P_TARGET_HIST_LEN": 0,
    "H2P_PATH_HIST_LEN": 0,
    "H2P_WEIGHT_W": 6,
    "H2P_THRESHOLD": 36,
    "H2P_META_ENABLE": 0,
    "H2P_META_ENTRIES": 1024,
    "H2P_META_CTR_W": 3,
    "H2P_META_THRESHOLD": 1,
    "LOCAL_DIR_ENABLE": 1,
    "LOCAL_DIR_ENTRIES": 1024,
    "LOCAL_DIR_HIST_W": 2,
    "LOCAL_DIR_PHT_ENTRIES": 4,
    "LOCAL_DIR_META_ENABLE": 1,
    "LOCAL_DIR_META_ENTRIES": 1024,
    "LOCAL_DIR_META_CTR_W": 3,
    "LOCAL_DIR_META_THRESHOLD": 1,
    "LOOP_ENTRIES": 64,
    "LOOP_CTR_W": 14,
    "LOOP_CONF_W": 3,
    "LOOP_IMLI_ENABLE": 0,
    "LOOP_IMLI_HIST_W": 16,
    "LOOP_IMLI_TOKEN_W": 4,
    "LOOP_PATH_SIG_W": 8,
    "FTB_ENTRIES": 4096,
    "FTB_WAYS": 4,
    "FTB_TARGET_CONF_W": 2,
    "L2_FTB_ENTRIES": 8192,
    "L2_FTB_WAYS": 8,
    "UFTB_ENTRIES": 512,
    "UFTB_WAYS": 4,
    "UFTB_STEER_CONF_MIN": 2,
    "RAS_ARCH_ENTRIES": 32,
    "RAS_SPEC_ENTRIES": 64,
    "ITTAGE_TABLES": 5,
    "ITTAGE_ENTRIES": (1024, 1024, 2048, 2048, 2048),
    "ITTAGE_WAYS": 2,
    "ITTAGE_HIST_LEN": (4, 10, 20, 40, 80),
    "ITTAGE_TAG_W": 11,
    "ITTAGE_CTR_W": 3,
    "ITTAGE_USEFUL_W": 2,
    "ITTAGE_USEFUL_RESET_PERIOD": 100_000,
    "ITTAGE_REPLACE_WEAK_CTR": 3,
    "ITTAGE_REPLACE_MIN_PROVIDER": 4,
    "ITTAGE_TARGET_HISTORY_BITS": 64,
    "ITTAGE_TARGET_HISTORY_TOKEN_BITS": 5,
    "ITTAGE_TARGET_HISTORY_SHIFT": 8,
    "ITTAGE_PATH_HISTORY_BITS": 64,
    "ITTAGE_PATH_HISTORY_TOKEN_BITS": 8,
    "ITTAGE_PATH_HISTORY_SHIFT": 2,
}


@dataclass
class BranchEvent:
    """A single retired branch event consumed by the model.

    ``call_return_pc`` is the architectural fall-through address that
    should be pushed onto the RAS when ``kind == BR_CALL``. For CBP-5
    traces (RV64 / ARM64) that is ``pc + 4``; the synthetic generators
    use larger strides and rely on the default of
    ``pc + FETCH_BLOCK_BYTES``. ``None`` means "derive from the geometry
    default".
    """

    pc: int
    target: int
    taken: bool
    kind: int
    call_return_pc: int | None = None
    asid: int = 0
    vmid: int = 0
    priv: int = 0
    secure: int = 0
    workload_class: int = 0


def _mask(width: int) -> int:
    return (1 << width) - 1


def _fold(value: int, width: int) -> int:
    out = 0
    while value:
        out ^= value & _mask(width)
        value >>= width
    return out


def _index_hash(pc: int, hist: int, hist_len: int, width: int, salt: int) -> int:
    pc_folded = _fold(pc, width)
    hist_folded = _fold(hist & _mask(hist_len), width)
    return (pc_folded ^ hist_folded ^ salt) & _mask(width)


def _tag_hash(pc: int, hist: int, hist_len: int, width: int, salt: int) -> int:
    pc_folded = _fold(pc, width)
    hist_folded = _fold(hist & _mask(hist_len), width)
    # Rotate the history fold so tag and index do not collapse.
    rot = ((hist_folded << 1) | (hist_folded >> (width - 1))) & _mask(width)
    return (pc_folded ^ rot ^ salt) & _mask(width)


@dataclass
class _BimodalTable:
    entries: list[int]
    ctr_w: int

    def lookup(self, pc: int) -> bool:
        idx = (pc >> 1) % len(self.entries)
        return self.entries[idx] >> (self.ctr_w - 1) == 1

    def update(self, pc: int, taken: bool) -> None:
        idx = (pc >> 1) % len(self.entries)
        ctr = self.entries[idx]
        if taken and ctr != _mask(self.ctr_w):
            self.entries[idx] = ctr + 1
        elif not taken and ctr != 0:
            self.entries[idx] = ctr - 1


@dataclass
class _TageTable:
    entries_count: int
    tag_w: int
    ctr_w: int
    useful_w: int
    hist_len: int
    table_id: int
    storage: dict[int, dict[str, int]] = field(default_factory=dict)

    def _index_tag(self, pc: int, hist: int) -> tuple[int, int]:
        idx_w = max(1, (self.entries_count - 1).bit_length())
        idx = _index_hash(pc, hist, self.hist_len, idx_w, self.table_id)
        tag = _tag_hash(pc, hist, self.hist_len, self.tag_w, self.table_id + 1)
        return idx % self.entries_count, tag

    def lookup(self, pc: int, hist: int) -> dict | None:
        idx, tag = self._index_tag(pc, hist)
        entry = self.storage.get(idx)
        if entry is None or entry["tag"] != tag:
            return None
        return entry

    def update(self, pc: int, hist: int, taken: bool, correct: bool) -> None:
        idx, _tag = self._index_tag(pc, hist)
        entry = self.storage.get(idx)
        if entry is None:
            return
        if taken and entry["ctr"] != _mask(self.ctr_w):
            entry["ctr"] += 1
        elif not taken and entry["ctr"] != 0:
            entry["ctr"] -= 1
        if correct and entry["useful"] < _mask(self.useful_w):
            entry["useful"] += 1

    def try_allocate(self, pc: int, hist: int, taken: bool) -> bool:
        idx, tag = self._index_tag(pc, hist)
        existing = self.storage.get(idx)
        if existing is not None and existing["useful"] != 0:
            return False
        center_high = 1 << (self.ctr_w - 1)
        center_low = center_high - 1
        self.storage[idx] = {
            "tag": tag,
            "ctr": center_high if taken else center_low,
            "useful": 0,
        }
        return True

    def decrement_useful(self, pc: int, hist: int) -> None:
        """Age the candidate victim's useful counter on a failed allocation."""
        idx, _tag = self._index_tag(pc, hist)
        entry = self.storage.get(idx)
        if entry is not None and entry["useful"] > 0:
            entry["useful"] -= 1

    def age_useful(self, clear_high: bool) -> None:
        """Periodic useful-bit reset: alternately clear the high or low bit of
        every allocated entry's useful counter (classic TAGE u-bit decay)."""
        bit = (1 << (self.useful_w - 1)) if clear_high else 1
        mask = _mask(self.useful_w) & ~bit
        for entry in self.storage.values():
            entry["useful"] &= mask


@dataclass
class _Tage:
    geo: dict
    tables: list[_TageTable]
    bim: _BimodalTable
    branch_ctr: int = 0
    reset_phase: int = 0

    @classmethod
    def build(cls, geo: dict) -> _Tage:
        bim = _BimodalTable(
            entries=[1 << (geo["BIM_CTR_W"] - 1)] * geo["BIM_ENTRIES"],
            ctr_w=geo["BIM_CTR_W"],
        )
        tables = [
            _TageTable(
                entries_count=geo["TAGE_ENTRIES_TABLE"],
                tag_w=geo["TAGE_TAG_W"],
                ctr_w=geo["TAGE_CTR_W"],
                useful_w=geo["TAGE_USEFUL_W"],
                hist_len=geo["TAGE_HIST_LEN"][t],
                table_id=t,
            )
            for t in range(geo["TAGE_TABLES"])
        ]
        return cls(geo=geo, tables=tables, bim=bim)

    def predict(self, pc: int, hist: int) -> tuple[bool, int, bool]:
        provider = 0
        provider_taken = self.bim.lookup(pc)
        alt_taken = provider_taken
        provider_found = False
        provider_ctr = 0
        for t_idx in range(len(self.tables) - 1, -1, -1):
            entry = self.tables[t_idx].lookup(pc, hist)
            if entry is not None:
                taken = (entry["ctr"] >> (self.geo["TAGE_CTR_W"] - 1)) == 1
                if not provider_found:
                    provider_found = True
                    provider = t_idx + 1
                    provider_ctr = entry["ctr"]
                    provider_taken = taken
                else:
                    alt_taken = taken
                    break
        center_low = (1 << (self.geo["TAGE_CTR_W"] - 1)) - 1
        center_high = 1 << (self.geo["TAGE_CTR_W"] - 1)
        low_conf = provider != 0 and provider_ctr in (center_low, center_high)
        if self.geo.get("TAGE_USE_ALT_ON_NA", 0) and low_conf:
            return alt_taken, provider, low_conf
        return provider_taken, provider, low_conf

    def update(
        self,
        pc: int,
        hist_pred_time: int,
        hist_resolve_time: int,
        taken: bool,
        provider: int,
        misp: bool,
    ) -> None:
        self.bim.update(pc, taken)
        if provider > 0:
            self.tables[provider - 1].update(pc, hist_resolve_time, taken, not misp)
        if misp:
            # Allocate into a longer-history table that has a free victim
            # (useful==0). With TAGE_ALLOC_DECREMENT, age the useful counter of
            # each occupied candidate we pass over, so a later misprediction at
            # the same site can allocate — this is the classic fix for the
            # allocation starvation that pure first-fit suffers on long traces.
            alloc_decrement = self.geo.get("TAGE_ALLOC_DECREMENT", False)
            for higher in range(provider, len(self.tables)):
                if self.tables[higher].try_allocate(pc, hist_resolve_time, taken):
                    break
                if alloc_decrement:
                    self.tables[higher].decrement_useful(pc, hist_resolve_time)
        # Periodic useful-bit reset (aging): without it, useful counters
        # saturate and block all future allocation. Alternately clear the high
        # then low bit of every entry's useful counter each period.
        period = self.geo.get("TAGE_UBIT_RESET_PERIOD", 0)
        if period:
            self.branch_ctr += 1
            if self.branch_ctr >= period:
                self.branch_ctr = 0
                for tbl in self.tables:
                    tbl.age_useful(self.reset_phase == 0)
                self.reset_phase ^= 1


@dataclass
class _SC:
    """Statistical corrector — signed-counter tables that can override a
    low-confidence TAGE direction.

    Mirrors ``rtl/cpu/bpu/sc.sv``: ``SC_TABLES`` tables of signed
    ``SC_CTR_W``-bit counters, each indexed by the PC folded with a
    different-length history segment. The summed vote overrides TAGE only
    when TAGE reported low confidence and the absolute sum clears the
    threshold. Optional local-history folding models the common production
    bias/local corrector family without changing the default geometry.
    """

    tables: int
    entries: int
    ctr_w: int
    hist_lens: tuple[int, ...]
    threshold: int
    adaptive: bool = False
    local_history_bits: int = 0
    local_history_entries: int = 0
    tc: int = 0  # threshold-control counter (Seznec TC) when adaptive
    storage: list[list[int]] = field(default_factory=list)
    local_history: list[int] = field(default_factory=list)

    @classmethod
    def build(cls, geo: dict) -> _SC:
        entries = geo["SC_ENTRIES_TABLE"]
        tables = geo["SC_TABLES"]
        return cls(
            tables=tables,
            entries=entries,
            ctr_w=geo["SC_CTR_W"],
            hist_lens=tuple(geo["SC_HIST_LEN"]),
            threshold=geo["SC_THRESH_INIT"],
            adaptive=bool(geo.get("SC_ADAPTIVE", False)),
            local_history_bits=int(geo.get("SC_LOCAL_HISTORY_BITS", 0)),
            local_history_entries=int(geo.get("SC_LOCAL_HISTORY_ENTRIES", 1024)),
            storage=[[0] * entries for _ in range(tables)],
            local_history=[0] * int(geo.get("SC_LOCAL_HISTORY_ENTRIES", 1024)),
        )

    def _local_history(self, pc: int) -> int:
        if self.local_history_bits <= 0:
            return 0
        return self.local_history[(pc >> 1) % self.local_history_entries]

    def _idx(self, tid: int, pc: int, hist: int) -> int:
        idx_w = max(1, (self.entries - 1).bit_length())
        local = _fold(self._local_history(pc), idx_w)
        return (_index_hash(pc, hist, self.hist_lens[tid], idx_w, tid) ^ local) % self.entries

    def _sum(self, pc: int, hist: int) -> int:
        total = 0
        for tid in range(self.tables):
            total += self.storage[tid][self._idx(tid, pc, hist)]
        return total

    def predict(self, pc: int, hist: int, tage_lowconf: bool) -> tuple[bool, bool]:
        total = self._sum(pc, hist)
        override = tage_lowconf and abs(total) >= self.threshold
        return override, total >= 0

    def update(self, pc: int, hist: int, taken: bool, tage_lowconf: bool) -> None:
        if not tage_lowconf:
            return
        # Seznec adaptive threshold (TC): nudge the override threshold so the
        # SC fires neither too eagerly nor too rarely. Off by default to match
        # the static-threshold RTL; enabling it is a concrete RTL proposal.
        if self.adaptive:
            total = self._sum(pc, hist)
            sc_taken = total >= 0
            if sc_taken != taken:
                self.tc += 1
                if self.tc >= 12:
                    self.threshold += 1
                    self.tc = 0
            elif abs(total) >= self.threshold:
                self.tc -= 1
                if self.tc <= -12:
                    self.threshold = max(4, self.threshold - 1)
                    self.tc = 0
        hi = (1 << (self.ctr_w - 1)) - 1
        lo = -(1 << (self.ctr_w - 1))
        for tid in range(self.tables):
            idx = self._idx(tid, pc, hist)
            ctr = self.storage[tid][idx]
            if taken and ctr < hi:
                self.storage[tid][idx] = ctr + 1
            elif not taken and ctr > lo:
                self.storage[tid][idx] = ctr - 1
        if self.local_history_bits > 0:
            idx = (pc >> 1) % self.local_history_entries
            self.local_history[idx] = ((self.local_history[idx] << 1) | int(taken)) & _mask(
                self.local_history_bits
            )


@dataclass
class _LoopPredictor:
    entries: int
    storage: dict[int, dict[str, int]] = field(default_factory=dict)
    rr: int = 0

    def predict(self, pc: int) -> tuple[bool, bool]:
        entry = self.storage.get(pc & 0xFFFF)
        if entry is None:
            return False, False
        confident = entry["conf"] == 0x7
        taken = confident and entry["iter_cur"] < entry["iter_max"]
        return confident, taken

    def update(self, pc: int, target: int, taken: bool) -> None:
        key = pc & 0xFFFF
        entry = self.storage.get(key)
        backward = target < pc
        if not backward:
            if entry is not None:
                entry["conf"] = 0
                entry["iter_cur"] = 0
                entry["iter_max"] = 0
            return
        if entry is None:
            if taken:
                self.storage[key] = {"iter_cur": 1, "iter_max": 0, "conf": 0}
            return
        if taken:
            # If the loop runs past the learned trip count, the old bound is
            # stale. Drop confidence immediately so the loop predictor stops
            # overriding TAGE until a new stable exit count is observed.
            if entry["iter_max"] and entry["iter_cur"] >= entry["iter_max"]:
                entry["conf"] = 0
            entry["iter_cur"] += 1
        else:
            if entry["iter_max"] == entry["iter_cur"]:
                if entry["conf"] < 0x7:
                    entry["conf"] += 1
            else:
                entry["iter_max"] = entry["iter_cur"]
                entry["conf"] = 0
            entry["iter_cur"] = 0


@dataclass
class _RAS:
    spec_capacity: int
    arch_capacity: int
    spec: list[int] = field(default_factory=list)
    arch: list[int] = field(default_factory=list)
    overflow: int = 0

    def push(self, addr: int) -> bool:
        if len(self.spec) == self.spec_capacity:
            self.overflow += 1
            return False
        self.spec.append(addr)
        return True

    def pop(self) -> int | None:
        if not self.spec:
            return None
        if self.overflow > 0:
            self.overflow -= 1
            return self.spec[-1]
        return self.spec.pop()

    def commit_push(self, addr: int) -> None:
        if len(self.arch) == self.arch_capacity:
            self.arch.pop(0)
        self.arch.append(addr)

    def commit_pop(self) -> None:
        if self.arch:
            self.arch.pop()


@dataclass
class _FTB:
    entries: int
    target_conf_w: int
    storage: dict[int, dict] = field(default_factory=dict)

    def lookup(self, pc: int):
        return self.storage.get(pc)

    def update(self, pc: int, target: int, kind: int) -> None:
        old = self.storage.get(pc)
        conf_mask = _mask(self.target_conf_w)
        conf = 0
        if old is not None and old["target"] == target:
            conf = min(old.get("target_conf", 0) + 1, conf_mask)
        self.storage[pc] = {"target": target, "kind": kind, "target_conf": conf}
        # Bound storage at `entries`; oldest insertions are dropped first.
        if len(self.storage) > self.entries:
            oldest = next(iter(self.storage))
            del self.storage[oldest]


@dataclass
class _LocalDirMeta:
    entries: int

    def _idx(self, pc: int) -> int:
        return (pc >> 2) % self.entries


@dataclass
class _ITTAGE:
    geo: dict
    storage: list[dict[int, dict]] = field(default_factory=list)
    updates: int = 0

    @classmethod
    def build(cls, geo: dict) -> _ITTAGE:
        return cls(geo=geo, storage=[{} for _ in range(geo["ITTAGE_TABLES"])])

    def _index_tag(self, table_id: int, pc: int, hist: int) -> tuple[int, int]:
        size = self.geo["ITTAGE_ENTRIES"][table_id]
        idx_w = max(1, (size - 1).bit_length())
        idx = _index_hash(pc, hist, self.geo["ITTAGE_HIST_LEN"][table_id], idx_w, table_id) % size
        tag = _tag_hash(
            pc, hist, self.geo["ITTAGE_HIST_LEN"][table_id], self.geo["ITTAGE_TAG_W"], table_id + 7
        )
        return idx, tag

    def predict(self, pc: int, hist: int) -> tuple[int | None, int, int]:
        for t in range(self.geo["ITTAGE_TABLES"] - 1, -1, -1):
            idx, tag = self._index_tag(t, pc, hist)
            entry = self.storage[t].get(idx)
            if entry is not None and entry["tag"] == tag:
                return entry["target"], t + 1, entry["ctr"]
        return None, 0, 0

    def update(self, pc: int, hist: int, target: int, provider: int, misp: bool) -> None:
        self.updates += 1
        if self.updates % self.geo["ITTAGE_USEFUL_RESET_PERIOD"] == 0:
            for table in self.storage:
                for entry in table.values():
                    entry["useful"] = max(entry.get("useful", 0) - 1, 0)
        if provider > 0:
            idx, tag = self._index_tag(provider - 1, pc, hist)
            provider_entry = self.storage[provider - 1].get(idx)
            if provider_entry is not None and provider_entry["tag"] == tag:
                if provider_entry["target"] == target:
                    provider_entry["ctr"] = min(
                        provider_entry["ctr"] + 1, _mask(self.geo["ITTAGE_CTR_W"])
                    )
                    provider_entry["useful"] = min(
                        provider_entry.get("useful", 0) + 1,
                        _mask(self.geo["ITTAGE_USEFUL_W"]),
                    )
                elif (
                    provider >= self.geo["ITTAGE_REPLACE_MIN_PROVIDER"]
                    and provider_entry["ctr"] <= self.geo["ITTAGE_REPLACE_WEAK_CTR"]
                ):
                    provider_entry["target"] = target
                    provider_entry["ctr"] = 1 << (self.geo["ITTAGE_CTR_W"] - 1)
                    provider_entry["useful"] = 0
                elif provider_entry["ctr"] == 0:
                    self.storage[provider - 1].pop(idx, None)
                else:
                    provider_entry["ctr"] -= 1
                    provider_entry["useful"] = max(provider_entry.get("useful", 0) - 1, 0)
        if misp:
            for higher in range(max(provider, 0), self.geo["ITTAGE_TABLES"]):
                idx, tag = self._index_tag(higher, pc, hist)
                if idx not in self.storage[higher]:
                    self.storage[higher][idx] = {
                        "tag": tag,
                        "target": target,
                        "ctr": 1 << (self.geo["ITTAGE_CTR_W"] - 1),
                        "useful": 0,
                    }
                    return
            for higher in range(max(provider, 0), self.geo["ITTAGE_TABLES"]):
                idx, tag = self._index_tag(higher, pc, hist)
                victim = self.storage[higher].get(idx)
                if victim is not None and victim.get("useful", 0) == 0:
                    self.storage[higher][idx] = {
                        "tag": tag,
                        "target": target,
                        "ctr": 1 << (self.geo["ITTAGE_CTR_W"] - 1),
                        "useful": 0,
                    }
                    return


@dataclass
class BPUSimulator:
    """End-to-end BPU model, indexable by branch events."""

    geometry: dict = field(default_factory=lambda: dict(DEFAULT_GEOMETRY))
    tage: _Tage = field(init=False)
    sc: _SC = field(init=False)
    loop: _LoopPredictor = field(init=False)
    ras: _RAS = field(init=False)
    ftb: _FTB = field(init=False)
    ittage: _ITTAGE = field(init=False)
    hist: int = 0
    target_hist: int = 0
    path_hist: int = 0
    fetch_block: int | None = None
    fetch_block_slots_used: int = 0
    fetch_block_last_pc: int | None = None
    counters: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def __post_init__(self) -> None:
        self.tage = _Tage.build(self.geometry)
        self.sc = _SC.build(self.geometry)
        self.loop = _LoopPredictor(entries=self.geometry["LOOP_ENTRIES"])
        self.ras = _RAS(
            spec_capacity=self.geometry["RAS_SPEC_ENTRIES"],
            arch_capacity=self.geometry["RAS_ARCH_ENTRIES"],
        )
        self.ftb = _FTB(
            entries=self.geometry["FTB_ENTRIES"],
            target_conf_w=self.geometry["FTB_TARGET_CONF_W"],
        )
        self.local_dir_meta = _LocalDirMeta(
            entries=self.geometry["LOCAL_DIR_META_ENTRIES"]
        )
        self.ittage = _ITTAGE.build(self.geometry)

    def feed(self, events: Iterable[BranchEvent]) -> None:
        for event in events:
            self._step(event)

    def _predict(self, event: BranchEvent) -> tuple[bool, int]:
        pc = self._context_pc(event)
        ftb_entry = self.ftb.lookup(pc)
        ittage_hist = self._ittage_history()
        if event.kind == BR_RET:
            top = self.ras.pop()
            predicted_target = (
                top if top is not None else (event.pc + self.geometry["FETCH_BLOCK_BYTES"])
            )
            return True, predicted_target
        if event.kind == BR_CALL:
            itt_target, _provider, itt_ctr = self.ittage.predict(pc, ittage_hist)
            target = (
                ftb_entry["target"]
                if self._prefer_ftb_indirect_target(ftb_entry, itt_target, itt_ctr)
                else (
                    itt_target
                    if itt_target is not None
                    else (
                        ftb_entry["target"]
                        if ftb_entry
                        else None
                    )
                )
            )
            if target is None:
                return False, event.pc + self.geometry["FETCH_BLOCK_BYTES"]
            return_pc = (
                event.call_return_pc
                if event.call_return_pc is not None
                else event.pc + self.geometry["FETCH_BLOCK_BYTES"]
            )
            self.ras.push(return_pc)
            return True, target
        if event.kind == BR_IND:
            itt_target, _provider, itt_ctr = self.ittage.predict(pc, ittage_hist)
            target = (
                ftb_entry["target"]
                if self._prefer_ftb_indirect_target(ftb_entry, itt_target, itt_ctr)
                else (
                    itt_target
                    if itt_target is not None
                    else (
                        ftb_entry["target"]
                        if ftb_entry
                        else None
                    )
                )
            )
            if target is None:
                return False, event.pc + self.geometry["FETCH_BLOCK_BYTES"]
            return True, target
        if event.kind == BR_DIRECT:
            if ftb_entry:
                return True, ftb_entry["target"]
            return False, event.pc + self.geometry["FETCH_BLOCK_BYTES"]
        if event.kind == BR_COND:
            loop_conf, loop_taken = self.loop.predict(pc)
            tage_taken, provider, low_conf = self.tage.predict(pc, self.hist)
            sc_override, sc_taken = self.sc.predict(pc, self.hist, low_conf)
            if loop_conf:
                taken = loop_taken
            elif sc_override:
                taken = sc_taken
            else:
                taken = tage_taken
            target = (
                ftb_entry["target"]
                if (ftb_entry and taken)
                else (event.pc + self.geometry["FETCH_BLOCK_BYTES"])
            )
            return taken, target
        return False, event.pc + self.geometry["FETCH_BLOCK_BYTES"]

    def _step(self, event: BranchEvent) -> None:
        pc = self._context_pc(event)
        ittage_hist = self._ittage_history()
        pred_taken, pred_target = self._predict(event)
        pred_taken, pred_target = self._apply_fetch_block_slot_limit(event, pred_taken, pred_target)
        actual_taken = event.taken
        actual_target = event.target
        misp = (pred_taken != actual_taken) or (actual_taken and pred_target != actual_target)

        # Update PMU-style counters.
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
            self.counters["ind"] = self.counters.get("ind", 0) + 1
            if misp:
                self.counters["ind_misp"] += 1
        elif event.kind == BR_DIRECT:
            self.counters["direct"] += 1
        elif event.kind == BR_RET:
            self.counters["ret"] += 1
            if misp:
                self.counters["ret_misp"] += 1
        if misp:
            self.counters["misp"] += 1

        # Train tables.
        if event.kind == BR_COND:
            _, provider, low_conf = self.tage.predict(pc, self.hist)
            sc_override, _ = self.sc.predict(pc, self.hist, low_conf)
            if sc_override:
                self.counters["sc_override"] += 1
            self.tage.update(pc, self.hist, self.hist, actual_taken, provider, misp)
            self.sc.update(pc, self.hist, actual_taken, low_conf)
            self.loop.update(pc, actual_target, actual_taken)
            self.ftb.update(pc, actual_target, event.kind)
        elif event.kind == BR_CALL:
            _, provider, _ = self.ittage.predict(pc, ittage_hist)
            self.ittage.update(pc, ittage_hist, actual_target, provider, misp)
            return_pc = (
                event.call_return_pc
                if event.call_return_pc is not None
                else event.pc + self.geometry["FETCH_BLOCK_BYTES"]
            )
            self.ras.commit_push(return_pc)
            self.ftb.update(pc, actual_target, event.kind)
        elif event.kind == BR_IND:
            _, provider, _ = self.ittage.predict(pc, ittage_hist)
            self.ittage.update(pc, ittage_hist, actual_target, provider, misp)
            self.ftb.update(pc, actual_target, event.kind)
        elif event.kind == BR_DIRECT:
            self.ftb.update(pc, actual_target, event.kind)
        elif event.kind == BR_RET:
            self.ras.commit_pop()
            self.ftb.update(pc, actual_target, event.kind)

        # Shift the global history register.
        if event.kind == BR_COND:
            self.hist = ((self.hist << 1) | int(actual_taken)) & _mask(
                self.geometry["TAGE_HIST_LEN"][-1]
            )
        elif event.kind in (BR_CALL, BR_IND, BR_DIRECT):
            self._update_target_history(actual_target)
        self._update_path_history(event.pc)

        self._advance_fetch_block_slot_state(event)

    def _ittage_history(self) -> int:
        hist = self.hist
        if int(self.geometry.get("ITTAGE_TARGET_HISTORY_BITS", 0)) > 0:
            hist ^= self.target_hist
        if int(self.geometry.get("ITTAGE_PATH_HISTORY_BITS", 0)) > 0:
            hist ^= self.path_hist
        return hist

    def _context_pc(self, event: BranchEvent) -> int:
        ctx = (
            ((int(event.asid) & 0xFF) << 4)
            ^ ((int(event.vmid) & 0xF) << 13)
            ^ ((int(event.priv) & 0x3) << 19)
            ^ ((int(event.secure) & 0x1) << 23)
            ^ ((int(event.workload_class) & 0x3) << 27)
        )
        return int(event.pc) ^ ctx

    def _prefer_ftb_indirect_target(
        self, ftb_entry: dict | None, itt_target: int | None, itt_ctr: int
    ) -> bool:
        if ftb_entry is None or itt_target is None:
            return False
        center_high = 1 << (self.geometry["ITTAGE_CTR_W"] - 1)
        stable_target = 1 << (self.geometry["FTB_TARGET_CONF_W"] - 1)
        return ftb_entry.get("target_conf", 0) >= stable_target and itt_ctr <= center_high

    def _apply_fetch_block_slot_limit(
        self, event: BranchEvent, pred_taken: bool, pred_target: int
    ) -> tuple[bool, int]:
        """Model limited same-fetch-block conditional prediction bandwidth.

        The branch-event stream is retired-order, not fetch-cycle accurate, but
        PC locality is enough to expose a common front-end gap: two conditional
        branches in one fetch block where the first falls through and the
        second redirects. With one predicted branch slot, the second branch is
        invisible until decode/execute even if TAGE would know its direction.
        """
        if event.kind != BR_COND:
            return pred_taken, pred_target
        block = event.pc // int(self.geometry["FETCH_BLOCK_BYTES"])
        same_dynamic_block = (
            self.fetch_block == block
            and self.fetch_block_last_pc is not None
            and event.pc > self.fetch_block_last_pc
        )
        if not same_dynamic_block:
            return pred_taken, pred_target
        slots = int(self.geometry.get("FETCH_BLOCK_BRANCH_SLOTS", 1))
        if slots <= 0:
            slots = 1
        if self.fetch_block_slots_used < slots:
            return pred_taken, pred_target
        self.counters["fetch_slot_blocked"] += 1
        fallthrough = event.pc + int(self.geometry["FETCH_BLOCK_BYTES"])
        if event.taken:
            self.counters["fetch_slot_misp"] += 1
        return False, fallthrough

    def _advance_fetch_block_slot_state(self, event: BranchEvent) -> None:
        block = event.pc // int(self.geometry["FETCH_BLOCK_BYTES"])
        starts_new_dynamic_block = (
            self.fetch_block != block
            or self.fetch_block_last_pc is None
            or event.pc <= self.fetch_block_last_pc
        )
        if starts_new_dynamic_block:
            self.fetch_block = block
            self.fetch_block_slots_used = 0
        if event.kind == BR_COND:
            self.fetch_block_slots_used += 1
        self.fetch_block_last_pc = event.pc
        if event.taken:
            target_block = event.target // int(self.geometry["FETCH_BLOCK_BYTES"])
            if target_block != block:
                self.fetch_block = target_block
                self.fetch_block_slots_used = 0
                self.fetch_block_last_pc = None

    def _update_target_history(self, target: int) -> None:
        bits = int(self.geometry.get("ITTAGE_TARGET_HISTORY_BITS", 0))
        if bits <= 0:
            return
        token_bits = int(self.geometry.get("ITTAGE_TARGET_HISTORY_TOKEN_BITS", 7))
        shift = int(self.geometry.get("ITTAGE_TARGET_HISTORY_SHIFT", 5))
        token = (target >> shift) & _mask(token_bits)
        self.target_hist = ((self.target_hist << token_bits) ^ token) & _mask(bits)

    def _update_path_history(self, pc: int) -> None:
        bits = int(self.geometry.get("ITTAGE_PATH_HISTORY_BITS", 0))
        if bits <= 0:
            return
        token_bits = int(self.geometry.get("ITTAGE_PATH_HISTORY_TOKEN_BITS", 6))
        shift = int(self.geometry.get("ITTAGE_PATH_HISTORY_SHIFT", 2))
        token = (pc >> shift) & _mask(token_bits)
        self.path_hist = ((self.path_hist << token_bits) ^ token) & _mask(bits)

    def mpki(self, instruction_count: int) -> float:
        if instruction_count <= 0:
            return float("nan")
        return self.counters["misp"] * 1000.0 / instruction_count

    def stats(self) -> dict[str, int | float]:
        return dict(self.counters)
