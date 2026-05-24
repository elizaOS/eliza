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
    "BPU_ASID_W": 8,
    "BPU_VMID_W": 4,
    "BPU_PRIV_W": 2,
    "BPU_WORKLOAD_CLASS_W": 2,
    "BPU_CONTEXT_HASH_W": 12,
    "BIM_ENTRIES": 16384,
    "BIM_CTR_W": 2,
    "TAGE_TABLES": 5,
    "TAGE_ENTRIES_TABLE": 8192,
    "TAGE_TAG_W": 8,
    "TAGE_CTR_W": 3,
    "TAGE_USEFUL_W": 2,
    "TAGE_USE_ALT_ON_NA": 0,
    "TAGE_ALT_ON_NA_ENTRIES": 1024,
    "TAGE_ALT_ON_NA_CTR_W": 4,
    "TAGE_ALT_ON_NA_THRESHOLD": 1,
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
    "SC_SAME_EVENT_OVERRIDE": True,
    "H2P_ENABLE": 1,
    "H2P_ENTRIES": 1024,
    "H2P_HIST_LEN": 48,
    "H2P_TARGET_HIST_LEN": 0,
    "H2P_PATH_HIST_LEN": 0,
    "H2P_WEIGHT_W": 6,
    "H2P_SCORE_W": 16,
    "H2P_THRESHOLD": 36,
    "H2P_LOWCONF_ONLY": 0,
    "H2P_META_ENABLE": 0,
    "H2P_META_ENTRIES": 1024,
    "H2P_META_CTR_W": 3,
    "H2P_META_THRESHOLD": 1,
    "H2P_SAME_EVENT_OVERRIDE": True,
    "LOCAL_DIR_ENABLE": 1,
    "LOCAL_DIR_ENTRIES": 1024,
    "LOCAL_DIR_HIST_W": 2,
    "LOCAL_DIR_PHT_ENTRIES": 4,
    "LOCAL_DIR_META_ENABLE": 1,
    "LOCAL_DIR_META_ENTRIES": 1024,
    "LOCAL_DIR_META_CTR_W": 3,
    "LOCAL_DIR_META_THRESHOLD": 1,
    "LOCAL_DIR_SAME_EVENT_OVERRIDE": True,
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
    "L2_FTB_SAME_EVENT_LATE_REDIRECT": False,
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
    "ITTAGE_SAME_EVENT_TARGET": True,
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
    alt_on_na: list[int] = field(default_factory=list)

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
        return cls(
            geo=geo,
            tables=tables,
            bim=bim,
            alt_on_na=[0] * int(geo.get("TAGE_ALT_ON_NA_ENTRIES", 1024)),
        )

    def _alt_idx(self, pc: int) -> int:
        return (pc >> 2) % max(1, len(self.alt_on_na))

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
        if low_conf and self.geo.get("TAGE_USE_ALT_ON_NA", 0):
            return alt_taken, provider, low_conf
        if low_conf and provider != 0 and self.alt_on_na:
            threshold = int(self.geo.get("TAGE_ALT_ON_NA_THRESHOLD", 1))
            if self.alt_on_na[self._alt_idx(pc)] >= threshold:
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
        if provider > 0 and self.alt_on_na:
            idx = self._alt_idx(pc)
            max_ctr = _mask(int(self.geo.get("TAGE_ALT_ON_NA_CTR_W", 4)))
            if not misp and self.alt_on_na[idx] < max_ctr:
                self.alt_on_na[idx] += 1
            elif misp and self.alt_on_na[idx] > 0:
                self.alt_on_na[idx] -= 1
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
    bias_enable: bool = False
    bias_ctr_w: int = 5
    tc: int = 0  # threshold-control counter (Seznec TC) when adaptive
    storage: list[list[int]] = field(default_factory=list)
    local_history: list[int] = field(default_factory=list)
    bias: list[int] = field(default_factory=list)

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
            bias_enable=bool(geo.get("SC_BIAS_ENABLE", False)),
            bias_ctr_w=int(geo.get("SC_BIAS_CTR_W", 5)),
            storage=[[0] * entries for _ in range(tables)],
            local_history=[0] * int(geo.get("SC_LOCAL_HISTORY_ENTRIES", 1024)),
            bias=[0] * int(geo.get("SC_BIAS_ENTRIES", 2048)),
        )

    def _local_history(self, pc: int) -> int:
        if self.local_history_bits <= 0:
            return 0
        return self.local_history[(pc >> 1) % self.local_history_entries]

    def _idx(self, tid: int, pc: int, hist: int) -> int:
        idx_w = max(1, (self.entries - 1).bit_length())
        local = _fold(self._local_history(pc), idx_w)
        return (_index_hash(pc, hist, self.hist_lens[tid], idx_w, tid) ^ local) % self.entries

    def _bias_idx(self, pc: int) -> int:
        return (pc >> 2) % max(1, len(self.bias))

    def _sum(self, pc: int, hist: int) -> int:
        total = 0
        for tid in range(self.tables):
            total += self.storage[tid][self._idx(tid, pc, hist)]
        if self.bias_enable:
            total += self.bias[self._bias_idx(pc)]
        return total

    def predict(self, pc: int, hist: int, tage_lowconf: bool) -> tuple[bool, bool]:
        total = self._sum(pc, hist)
        override = tage_lowconf and abs(total) >= self.threshold
        return override, total >= 0

    def update(self, pc: int, hist: int, taken: bool, tage_lowconf: bool) -> None:
        if self.local_history_bits > 0:
            idx = (pc >> 1) % self.local_history_entries
            self.local_history[idx] = ((self.local_history[idx] << 1) | int(taken)) & _mask(
                self.local_history_bits
            )
        if self.bias_enable:
            idx = self._bias_idx(pc)
            hi = (1 << (self.bias_ctr_w - 1)) - 1
            lo = -(1 << (self.bias_ctr_w - 1))
            if taken and self.bias[idx] < hi:
                self.bias[idx] += 1
            elif not taken and self.bias[idx] > lo:
                self.bias[idx] -= 1
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


@dataclass
class _LoopPredictor:
    entries: int
    imli_enable: bool = False
    imli_token_w: int = 4
    imli_hist_w: int = 16
    storage: dict[tuple[int, int], dict[str, int]] = field(default_factory=dict)
    imli_hist: int = 0
    rr: int = 0

    @classmethod
    def build(cls, geo: dict) -> _LoopPredictor:
        return cls(
            entries=geo["LOOP_ENTRIES"],
            imli_enable=bool(geo.get("LOOP_IMLI_ENABLE", False)),
            imli_token_w=int(geo.get("LOOP_IMLI_TOKEN_W", 4)),
            imli_hist_w=int(geo.get("LOOP_IMLI_HIST_W", 16)),
        )

    def _key(self, pc: int, path_sig: int = 0) -> tuple[int, int]:
        sig = path_sig & 0xFF
        if self.imli_enable:
            sig ^= self.imli_hist & 0xFF
        return pc & 0xFFFF, sig

    def predict(self, pc: int, path_sig: int = 0) -> tuple[bool, bool]:
        entry = self.storage.get(self._key(pc, path_sig))
        if entry is None:
            return False, False
        confident = entry["conf"] == 0x7
        taken = confident and entry["iter_cur"] < entry["iter_max"]
        return confident, taken

    def update(self, pc: int, target: int, taken: bool, path_sig: int = 0) -> None:
        key = self._key(pc, path_sig)
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
                self.storage[key] = {
                    "iter_cur": 1,
                    "iter_max": 0,
                    "conf": 0,
                    "early_exit_seen": 0,
                }
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
                entry["early_exit_seen"] = 0
            elif entry["iter_max"] and entry["iter_cur"] < entry["iter_max"] and entry["conf"] == 0x7:
                entry["conf"] -= 1
                entry["early_exit_seen"] = 1
            else:
                entry["iter_max"] = entry["iter_cur"]
                entry["conf"] = 0
                entry["early_exit_seen"] = 0
            if self.imli_enable:
                token = entry["iter_cur"] & _mask(self.imli_token_w)
                self.imli_hist = ((self.imli_hist << self.imli_token_w) ^ token) & _mask(
                    self.imli_hist_w
                )
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
    ways: int = 1
    block_bytes: int = 32
    storage: dict[int, list[dict]] = field(default_factory=dict)

    def _index(self, pc: int) -> int:
        sets = max(1, self.entries // max(1, self.ways))
        return (pc // self.block_bytes) % sets

    def _tag(self, pc: int) -> int:
        return pc // self.block_bytes

    def lookup(self, pc: int):
        tag = self._tag(pc)
        for entry in self.storage.get(self._index(pc), []):
            if entry["tag"] == tag:
                return entry
        return None

    def update(self, pc: int, target: int, kind: int) -> None:
        if self.entries <= 0:
            return
        idx = self._index(pc)
        tag = self._tag(pc)
        bucket = self.storage.setdefault(idx, [])
        old = next((entry for entry in bucket if entry["tag"] == tag), None)
        conf_mask = _mask(self.target_conf_w)
        conf = 1
        if old is not None and old["target"] == target:
            conf = min(old.get("target_conf", 0) + 1, conf_mask)
        if old is not None:
            bucket.remove(old)
        bucket.append({
            "tag": tag,
            "target": target,
            "kind": kind,
            "target_conf": conf,
            "offset": pc % self.block_bytes,
        })
        while len(bucket) > max(1, self.ways):
            bucket.pop(0)


@dataclass
class _LocalDirMeta:
    entries: int
    ctr_w: int = 3
    threshold: int = 1
    enable: bool = True
    ctrs: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.ctrs:
            self.ctrs = [0] * self.entries

    def _idx(self, pc: int) -> int:
        return (pc >> 2) % self.entries

    def allow(self, pc: int) -> bool:
        if not self.enable:
            return True
        return self.ctrs[self._idx(pc)] >= self.threshold

    def update(self, pc: int, base_taken: bool, side_taken: bool, actual: bool) -> None:
        if not self.enable or base_taken == side_taken:
            return
        idx = self._idx(pc)
        max_ctr = _mask(self.ctr_w)
        if side_taken == actual and self.ctrs[idx] < max_ctr:
            self.ctrs[idx] += 1
        elif base_taken == actual and self.ctrs[idx] > 0:
            self.ctrs[idx] -= 1


@dataclass
class _LocalDir:
    entries: int
    hist_w: int
    pht_entries: int
    history: list[int] = field(default_factory=list)
    pht: list[list[int]] = field(default_factory=list)

    @classmethod
    def build(cls, geo: dict) -> _LocalDir:
        entries = int(geo.get("LOCAL_DIR_ENTRIES", 1024))
        pht_entries = int(geo.get("LOCAL_DIR_PHT_ENTRIES", 4))
        return cls(
            entries=entries,
            hist_w=int(geo.get("LOCAL_DIR_HIST_W", 2)),
            pht_entries=pht_entries,
            history=[0] * entries,
            pht=[[1] * pht_entries for _ in range(entries)],
        )

    def _idx(self, pc: int) -> int:
        return (pc >> 2) % self.entries

    def predict(self, pc: int) -> tuple[bool, bool]:
        idx = self._idx(pc)
        h = self.history[idx] % self.pht_entries
        ctr = self.pht[idx][h]
        return ctr in (0, 3), ctr >= 2

    def update(self, pc: int, taken: bool) -> None:
        idx = self._idx(pc)
        h = self.history[idx] % self.pht_entries
        ctr = self.pht[idx][h]
        if taken and ctr < 3:
            self.pht[idx][h] = ctr + 1
        elif not taken and ctr > 0:
            self.pht[idx][h] = ctr - 1
        self.history[idx] = ((self.history[idx] << 1) | int(taken)) & _mask(self.hist_w)


@dataclass
class _H2P:
    entries: int
    hist_len: int
    target_hist_len: int
    path_hist_len: int
    weight_w: int
    score_w: int
    threshold: int
    weights: dict[int, list[int]] = field(default_factory=dict)

    @classmethod
    def build(cls, geo: dict) -> _H2P:
        return cls(
            entries=int(geo.get("H2P_ENTRIES", 512)),
            hist_len=int(geo.get("H2P_HIST_LEN", 64)),
            target_hist_len=int(geo.get("H2P_TARGET_HIST_LEN", 0)),
            path_hist_len=int(geo.get("H2P_PATH_HIST_LEN", 0)),
            weight_w=int(geo.get("H2P_WEIGHT_W", 6)),
            score_w=int(geo.get("H2P_SCORE_W", 16)),
            threshold=int(geo.get("H2P_THRESHOLD", 36)),
        )

    def _idx(self, pc: int) -> int:
        idx_w = max(1, (self.entries - 1).bit_length())
        folded_lo = 0
        folded_hi = 0
        for k in range(2, 64):
            if (pc >> k) & 1:
                folded_lo ^= 1 << ((k - 2) % idx_w)
        for k in range(11, 64):
            if (pc >> k) & 1:
                folded_hi ^= 1 << ((k - 11) % idx_w)
        return (folded_lo ^ folded_hi) % self.entries

    def _feature_count(self) -> int:
        return self.hist_len + self.target_hist_len + self.path_hist_len

    def _weights_for(self, pc: int) -> list[int]:
        idx = self._idx(pc)
        if idx not in self.weights:
            self.weights[idx] = [0] * (self._feature_count() + 1)
        return self.weights[idx]

    def _feature_bits(self, hist: int, target_hist: int, path_hist: int) -> list[int]:
        bits: list[int] = []
        bits.extend((hist >> i) & 1 for i in range(self.hist_len))
        bits.extend((target_hist >> i) & 1 for i in range(self.target_hist_len))
        bits.extend((path_hist >> i) & 1 for i in range(self.path_hist_len))
        return bits

    def _score(self, pc: int, hist: int, target_hist: int, path_hist: int) -> int:
        weights = self._weights_for(pc)
        total = weights[0]
        for feature, bit in zip(weights[1:], self._feature_bits(hist, target_hist, path_hist), strict=False):
            total = total + feature if bit else total - feature
        # RTL score width is intentionally wide for supported geometries; clamp
        # here instead of allowing Python evidence to exceed representable RTL.
        lo = -(1 << (self.score_w - 1))
        hi = (1 << (self.score_w - 1)) - 1
        return max(lo, min(hi, total))

    def _sat_add_weight(self, value: int, delta: int) -> int:
        lo = -(1 << (self.weight_w - 1))
        hi = (1 << (self.weight_w - 1)) - 1
        return max(lo, min(hi, value + delta))

    def predict(
        self, pc: int, hist: int, target_hist: int = 0, path_hist: int = 0
    ) -> tuple[bool, bool, int]:
        score = self._score(pc, hist, target_hist, path_hist)
        return abs(score) >= self.threshold, score >= 0, score

    def update(
        self,
        pc: int,
        hist: int,
        taken: bool,
        target_hist: int = 0,
        path_hist: int = 0,
    ) -> None:
        score = self._score(pc, hist, target_hist, path_hist)
        pred_taken = score >= 0
        if pred_taken == taken and abs(score) > self.threshold:
            return
        actual_sign = 1 if taken else -1
        weights = self._weights_for(pc)
        weights[0] = self._sat_add_weight(weights[0], actual_sign)
        for idx, bit in enumerate(self._feature_bits(hist, target_hist, path_hist), start=1):
            weights[idx] = self._sat_add_weight(
                weights[idx],
                actual_sign if bit else -actual_sign,
            )


@dataclass
class _ITTAGE:
    geo: dict
    storage: list[dict[int, list[dict]]] = field(default_factory=list)
    updates: int = 0
    counters: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    @classmethod
    def build(cls, geo: dict) -> _ITTAGE:
        return cls(geo=geo, storage=[{} for _ in range(geo["ITTAGE_TABLES"])])

    def _index_tag(self, table_id: int, pc: int, hist: int) -> tuple[int, int]:
        size = max(1, self.geo["ITTAGE_ENTRIES"][table_id] // max(1, self.geo["ITTAGE_WAYS"]))
        idx_w = max(1, (size - 1).bit_length())
        idx = (((pc >> 2) ^ _fold(hist, idx_w) ^ table_id) & _mask(idx_w)) % size
        tag = _tag_hash(
            pc, hist, self.geo["ITTAGE_HIST_LEN"][table_id], self.geo["ITTAGE_TAG_W"], table_id + 7
        )
        return idx, tag

    def predict(self, pc: int, hist: int) -> tuple[int | None, int, int]:
        for t in range(self.geo["ITTAGE_TABLES"] - 1, -1, -1):
            idx, tag = self._index_tag(t, pc, hist)
            for entry in self.storage[t].get(idx, []):
                if entry["tag"] == tag:
                    if (
                        int(self.geo.get("ITTAGE_PATH_HISTORY_BITS", 0)) <= 0
                        and int(self.geo.get("ITTAGE_TAG_W", 0)) < DEFAULT_GEOMETRY["ITTAGE_TAG_W"]
                        and entry["ctr"] <= (1 << (self.geo["ITTAGE_CTR_W"] - 1))
                    ):
                        continue
                    return entry["target"], t + 1, entry["ctr"]
        return None, 0, 0

    def update(self, pc: int, hist: int, target: int, provider: int, misp: bool) -> None:
        self.counters["updates"] += 1
        self.updates += 1
        if self.updates % self.geo["ITTAGE_USEFUL_RESET_PERIOD"] == 0:
            self.counters["useful_aging"] += 1
            for table in self.storage:
                for bucket in table.values():
                    for entry in bucket:
                        entry["useful"] = max(entry.get("useful", 0) - 1, 0)
        if provider > 0:
            idx, tag = self._index_tag(provider - 1, pc, hist)
            bucket = self.storage[provider - 1].get(idx, [])
            provider_entry = next((entry for entry in bucket if entry["tag"] == tag), None)
            if provider_entry is not None:
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
                    self.counters["weak_target_replacements"] += 1
                    provider_entry["target"] = target
                    provider_entry["ctr"] = 1 << (self.geo["ITTAGE_CTR_W"] - 1)
                    provider_entry["useful"] = 0
                elif provider_entry["ctr"] == 0:
                    self.counters["provider_evictions"] += 1
                    bucket.remove(provider_entry)
                else:
                    provider_entry["ctr"] -= 1
                    provider_entry["useful"] = max(provider_entry.get("useful", 0) - 1, 0)
        if misp:
            for higher in range(max(provider, 0), self.geo["ITTAGE_TABLES"]):
                idx, tag = self._index_tag(higher, pc, hist)
                bucket = self.storage[higher].setdefault(idx, [])
                if len(bucket) < max(1, self.geo["ITTAGE_WAYS"]):
                    self.counters["allocations"] += 1
                    bucket.append({
                        "tag": tag,
                        "target": target,
                        "ctr": 1 << (self.geo["ITTAGE_CTR_W"] - 1),
                        "useful": 0,
                    })
                    return
            for higher in range(max(provider, 0), self.geo["ITTAGE_TABLES"]):
                idx, tag = self._index_tag(higher, pc, hist)
                bucket = self.storage[higher].setdefault(idx, [])
                victim = next((entry for entry in bucket if entry.get("useful", 0) == 0), None)
                if victim is not None:
                    self.counters["victim_replacements"] += 1
                    bucket[bucket.index(victim)] = {
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
    l2_ftb: _FTB = field(init=False)
    l2_cond_bim: _BimodalTable = field(init=False)
    local_dir: _LocalDir = field(init=False)
    local_dir_meta: _LocalDirMeta = field(init=False)
    h2p: _H2P = field(init=False)
    h2p_meta: _LocalDirMeta = field(init=False)
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
        self.loop = _LoopPredictor.build(self.geometry)
        self.ras = _RAS(
            spec_capacity=self.geometry["RAS_SPEC_ENTRIES"],
            arch_capacity=self.geometry["RAS_ARCH_ENTRIES"],
        )
        self.ftb = _FTB(
            entries=self.geometry["FTB_ENTRIES"],
            target_conf_w=self.geometry["FTB_TARGET_CONF_W"],
            ways=self.geometry["FTB_WAYS"],
            block_bytes=self.geometry["FETCH_BLOCK_BYTES"],
        )
        self.l2_ftb = _FTB(
            entries=self.geometry.get("L2_FTB_ENTRIES", 0),
            target_conf_w=self.geometry["FTB_TARGET_CONF_W"],
            ways=self.geometry.get("L2_FTB_WAYS", 1),
            block_bytes=self.geometry["FETCH_BLOCK_BYTES"],
        )
        self.l2_cond_bim = _BimodalTable(
            entries=[1] * max(1, self.geometry.get("L2_FTB_ENTRIES", 1)),
            ctr_w=2,
        )
        self.local_dir = _LocalDir.build(self.geometry)
        self.local_dir_meta = _LocalDirMeta(
            entries=self.geometry["LOCAL_DIR_META_ENTRIES"],
            ctr_w=self.geometry["LOCAL_DIR_META_CTR_W"],
            threshold=self.geometry["LOCAL_DIR_META_THRESHOLD"],
            enable=bool(self.geometry.get("LOCAL_DIR_META_ENABLE", True)),
        )
        self.h2p = _H2P.build(self.geometry)
        self.h2p_meta = _LocalDirMeta(
            entries=self.geometry["H2P_META_ENTRIES"],
            ctr_w=self.geometry["H2P_META_CTR_W"],
            threshold=self.geometry["H2P_META_THRESHOLD"],
            enable=bool(self.geometry.get("H2P_META_ENABLE", False)),
        )
        self.ittage = _ITTAGE.build(self.geometry)

    def feed(self, events: Iterable[BranchEvent]) -> None:
        for event in events:
            self._step(event)

    def _predict(self, event: BranchEvent) -> tuple[bool, int]:
        pc = self._context_pc(event)
        ftb_entry = self.ftb.lookup(pc)
        l2_entry = self.l2_ftb.lookup(pc)
        ittage_hist = self._ittage_history()
        if event.kind == BR_RET:
            top = self.ras.pop()
            if top is None and self.ras.arch:
                top = self.ras.arch[-1]
            predicted_target = (
                top if top is not None else (event.pc + self.geometry["FETCH_BLOCK_BYTES"])
            )
            return True, predicted_target
        if event.kind == BR_CALL:
            itt_target, _provider, itt_ctr = self.ittage.predict(pc, ittage_hist)
            if itt_target is not None:
                self.counters["ittage_hit"] += 1
            ittage_same_event = bool(self.geometry.get("ITTAGE_SAME_EVENT_TARGET", True))
            if itt_target is not None and not ittage_same_event:
                self.counters["ittage_deferred_by_timing_model"] += 1
            prefer_ftb = self._prefer_ftb_indirect_target(ftb_entry, itt_target, itt_ctr)
            if prefer_ftb:
                self.counters["ittage_weak_yield_to_ftb"] += 1
            target = (
                ftb_entry["target"]
                if prefer_ftb
                else (
                    itt_target
                    if itt_target is not None and ittage_same_event
                    else (
                        ftb_entry["target"]
                        if ftb_entry
                        else None
                    )
                )
            )
            if (
                target is not None
                and itt_target is not None
                and target == itt_target
                and not prefer_ftb
                and ittage_same_event
            ):
                self.counters["ittage_target_used"] += 1
            if target is None:
                target = self._l2_late_target(event.kind, l2_entry)
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
            if itt_target is not None:
                self.counters["ittage_hit"] += 1
            ittage_same_event = bool(self.geometry.get("ITTAGE_SAME_EVENT_TARGET", True))
            if itt_target is not None and not ittage_same_event:
                self.counters["ittage_deferred_by_timing_model"] += 1
            prefer_ftb = self._prefer_ftb_indirect_target(ftb_entry, itt_target, itt_ctr)
            if prefer_ftb:
                self.counters["ittage_weak_yield_to_ftb"] += 1
            target = (
                ftb_entry["target"]
                if prefer_ftb
                else (
                    itt_target
                    if itt_target is not None and ittage_same_event
                    else (
                        ftb_entry["target"]
                        if ftb_entry
                        else None
                    )
                )
            )
            if (
                target is not None
                and itt_target is not None
                and target == itt_target
                and not prefer_ftb
                and ittage_same_event
            ):
                self.counters["ittage_target_used"] += 1
            if target is None:
                target = self._l2_late_target(event.kind, l2_entry)
            if target is None:
                return False, event.pc + self.geometry["FETCH_BLOCK_BYTES"]
            return True, target
        if event.kind == BR_DIRECT:
            if ftb_entry:
                return True, ftb_entry["target"]
            target = self._l2_late_target(event.kind, l2_entry)
            if target is not None:
                return True, target
            return False, event.pc + self.geometry["FETCH_BLOCK_BYTES"]
        if event.kind == BR_COND:
            loop_conf, loop_taken = self.loop.predict(pc, self._loop_path_sig())
            tage_taken, provider, low_conf = self.tage.predict(pc, self.hist)
            sc_override, sc_taken = self.sc.predict(pc, self.hist, low_conf)
            if loop_conf:
                taken = loop_taken
            else:
                taken = tage_taken
                if sc_override:
                    if bool(self.geometry.get("SC_SAME_EVENT_OVERRIDE", True)):
                        taken = sc_taken
                    else:
                        self.counters["sc_deferred_by_timing_model"] += 1
            base_taken = taken
            if (
                ftb_entry is None
                and l2_entry is not None
            ):
                self.counters["l2_ftb_hit"] += 1
                cond_idx = (pc >> 1) % len(self.l2_cond_bim.entries)
                cond_strong = self.l2_cond_bim.entries[cond_idx] == _mask(self.l2_cond_bim.ctr_w)
                if self._l2_same_event_enabled() and cond_strong:
                    self.counters["l2_ftb_late_redirect"] += 1
                    return True, l2_entry["target"]
                if not self._l2_same_event_enabled():
                    self.counters["l2_ftb_deferred_by_timing_model"] += 1
                return False, event.pc + self.geometry["FETCH_BLOCK_BYTES"]
            if ftb_entry is None:
                taken = False
            if bool(self.geometry.get("LOCAL_DIR_ENABLE", False)):
                local_conf, local_taken = self.local_dir.predict(pc)
                if local_conf and self.local_dir_meta.allow(pc):
                    if bool(self.geometry.get("LOCAL_DIR_SAME_EVENT_OVERRIDE", True)):
                        taken = local_taken
                        self.counters["local_dir_override"] += int(local_taken != base_taken)
                    else:
                        self.counters["local_dir_deferred_by_timing_model"] += int(
                            local_taken != base_taken
                        )
            if bool(self.geometry.get("H2P_ENABLE", False)):
                h2p_conf, h2p_taken, _score = self.h2p.predict(
                    pc, self.hist, self.target_hist, self.path_hist
                )
                if h2p_conf and bool(self.geometry.get("H2P_LOWCONF_ONLY", False)) and not low_conf:
                    self.counters["h2p_lowconf_blocked"] += 1
                    h2p_conf = False
                if h2p_conf and self.h2p_meta.allow(pc):
                    if bool(self.geometry.get("H2P_SAME_EVENT_OVERRIDE", True)):
                        taken = h2p_taken
                        self.counters["h2p_override"] += int(h2p_taken != base_taken)
                    else:
                        self.counters["h2p_deferred_by_timing_model"] += int(
                            h2p_taken != base_taken
                        )
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
            loop_conf, loop_taken = self.loop.predict(pc, self._loop_path_sig())
            tage_taken, _, _ = self.tage.predict(pc, self.hist)
            base_taken = loop_taken if loop_conf else tage_taken
            if sc_override:
                _, sc_taken = self.sc.predict(pc, self.hist, low_conf)
                base_taken = sc_taken
            local_conf, local_taken = self.local_dir.predict(pc)
            h2p_conf, h2p_taken, _ = self.h2p.predict(
                pc, self.hist, self.target_hist, self.path_hist
            )
            if h2p_conf and bool(self.geometry.get("H2P_LOWCONF_ONLY", False)) and not low_conf:
                h2p_conf = False
            self.tage.update(pc, self.hist, self.hist, actual_taken, provider, misp)
            self.sc.update(pc, self.hist, actual_taken, low_conf)
            self.loop.update(pc, actual_target, actual_taken, path_sig=self._loop_path_sig())
            if bool(self.geometry.get("H2P_ENABLE", False)):
                self.h2p.update(pc, self.hist, actual_taken, self.target_hist, self.path_hist)
                if h2p_conf and h2p_taken != base_taken:
                    if self.h2p_meta.enable and not self.h2p_meta.allow(pc):
                        self.counters["h2p_meta_blocked"] += 1
                    self.h2p_meta.update(pc, base_taken, h2p_taken, actual_taken)
                    self.counters["meta_train"] += 1
            if bool(self.geometry.get("LOCAL_DIR_ENABLE", False)):
                self.local_dir.update(pc, actual_taken)
                if (
                    local_conf
                    and local_taken != base_taken
                    and not (h2p_conf and h2p_taken != base_taken)
                ):
                    self.local_dir_meta.update(pc, base_taken, local_taken, actual_taken)
                    self.counters["meta_train"] += 1
            self.ftb.update(pc, actual_target, event.kind)
            self.l2_ftb.update(pc, actual_target, event.kind)
            self.l2_cond_bim.update(pc, actual_taken)
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
            self.l2_ftb.update(pc, actual_target, event.kind)
        elif event.kind == BR_IND:
            _, provider, _ = self.ittage.predict(pc, ittage_hist)
            self.ittage.update(pc, ittage_hist, actual_target, provider, misp)
            self.ftb.update(pc, actual_target, event.kind)
            self.l2_ftb.update(pc, actual_target, event.kind)
        elif event.kind == BR_DIRECT:
            self.ftb.update(pc, actual_target, event.kind)
            self.l2_ftb.update(pc, actual_target, event.kind)
        elif event.kind == BR_RET:
            self.ras.commit_pop()
            self.ftb.update(pc, actual_target, event.kind)
            self.l2_ftb.update(pc, actual_target, event.kind)

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

    def _l2_same_event_enabled(self) -> bool:
        return bool(self.geometry.get("L2_FTB_SAME_EVENT_LATE_REDIRECT", False))

    def _l2_late_target(self, kind: int, entry: dict | None) -> int | None:
        if entry is None or int(self.geometry.get("L2_FTB_ENTRIES", 0)) <= 0:
            return None
        self.counters["l2_ftb_hit"] += 1
        if not self._l2_same_event_enabled():
            self.counters["l2_ftb_deferred_by_timing_model"] += 1
            return None
        self.counters["l2_ftb_late_redirect"] += 1
        return entry["target"]

    def _loop_path_sig(self) -> int:
        return self.path_hist & _mask(int(self.geometry.get("LOOP_PATH_SIG_W", 8)))

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
        out = dict(self.counters)
        for key, value in self.ittage.counters.items():
            out[f"ittage_{key}"] = int(value)
        return out
