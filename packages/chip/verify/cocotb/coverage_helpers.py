"""Shared cocotb-coverage helpers for the e1-chip cocotb suite.

This module wraps ``cocotb_coverage`` (when available) and otherwise provides
a small fallback that records cover-point hits in plain dictionaries. The
fallback exists so the cocotb tests stay importable in environments that do
not have ``cocotb-coverage`` installed; both paths produce the same JSON
schema consumed by ``scripts/check_cocotb_coverage.py``.

Required cover-point classes (one per block tested):

- ``opcode``       — NPU opcode coverage (``test_e1_npu``).
- ``mmio_region``  — MMIO decoded regions (``test_e1_soc``, ``test_e1_chip``,
                     ``test_e1_display``).
- ``irq_vector``   — IRQ assertion sources (``test_e1_soc``, ``test_e1_chip``,
                     ``test_e1_dma``).
- ``axi_resp``     — AXI-Lite response codes seen (``test_e1_dma``,
                     ``test_e1_npu``).

Each test writes a JSON file to ``build/reports/coverage/<block>.json``
holding the active cover-points and their bin counts. The merge step
(``scripts/check_cocotb_coverage.py``) fails closed if any required
cover-point class is missing for a target block.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
COVERAGE_DIR = REPO_ROOT / "build/reports/coverage"

COVERAGE_SCHEMA = "eliza.cocotb_coverage.v1"

REQUIRED_CLASSES: dict[str, frozenset[str]] = {
    "npu": frozenset({"opcode", "axi_resp"}),
    "dma": frozenset({"axi_resp", "irq_vector"}),
    "soc": frozenset({"mmio_region", "irq_vector"}),
    "chip": frozenset({"mmio_region", "irq_vector"}),
    "display": frozenset({"mmio_region"}),
}


class CoverPointSet:
    """Aggregates cover-point bin counts for a single test block.

    The class records every (cover_point, bin) pair observed during a test
    run. When ``cocotb-coverage`` is installed it is also used to register
    canonical CoverPoints, but the local counts are the authoritative source
    written to JSON because the upstream library's coverage_db is process
    global and not always purgeable between cocotb test invocations.
    """

    def __init__(self, block: str) -> None:
        self.block = block
        self._classes: dict[str, dict[str, dict[str, Any]]] = {}
        self._cc_available: bool | None = None
        self._cc_handles: dict[str, Any] = {}

    def _cc(self) -> Any | None:
        if self._cc_available is False:
            return None
        try:
            from cocotb_coverage import coverage as cc
        except ImportError:
            self._cc_available = False
            return None
        self._cc_available = True
        return cc

    def declare(self, cover_class: str, name: str, bins: Iterable[Any]) -> None:
        """Register a cover-point under ``cover_class`` with the listed bins.

        Bins start with count 0; bins not declared up-front are still recorded
        when ``sample`` sees them, but declared bins surface as missing in the
        merge report if never sampled.
        """
        bucket = self._classes.setdefault(cover_class, {})
        entry = bucket.setdefault(name, {"declared_bins": [], "bins": {}})
        for bin_value in bins:
            key = self._bin_key(bin_value)
            if key not in entry["declared_bins"]:
                entry["declared_bins"].append(key)
            entry["bins"].setdefault(key, 0)

        cc = self._cc()
        if cc is not None:
            handle_key = f"{cover_class}.{name}"
            if handle_key not in self._cc_handles:
                bin_list = entry["declared_bins"] or ["__catch_all__"]

                # cocotb-coverage's CoverPoint is a decorator factory; build a
                # no-op decorated function so we can call it from `sample`.
                @cc.CoverPoint(
                    f"top.{self.block}.{cover_class}.{name}",
                    xf=lambda value: value,
                    bins=bin_list,
                )
                def _record(value: Any) -> None:
                    return None

                self._cc_handles[handle_key] = _record

    def sample(self, cover_class: str, name: str, value: Any) -> None:
        """Record one observation of ``value`` for ``cover_class.name``."""
        bucket = self._classes.setdefault(cover_class, {})
        entry = bucket.setdefault(name, {"declared_bins": [], "bins": {}})
        key = self._bin_key(value)
        entry["bins"][key] = entry["bins"].get(key, 0) + 1
        handle = self._cc_handles.get(f"{cover_class}.{name}")
        if handle is not None:
            # Cover-point sampling must never fail the test; suppress any
            # bookkeeping exception from the upstream library.
            with contextlib.suppress(Exception):
                handle(value)

    @staticmethod
    def _bin_key(value: Any) -> str:
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int):
            return str(value)
        return repr(value)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": COVERAGE_SCHEMA,
            "block": self.block,
            "cocotb_coverage_available": bool(self._cc_available),
            "classes": {
                cover_class: {
                    name: {
                        "declared_bins": list(entry["declared_bins"]),
                        "bins": dict(entry["bins"]),
                        "hits": sum(entry["bins"].values()),
                        "unique_bins": len([count for count in entry["bins"].values() if count]),
                    }
                    for name, entry in points.items()
                }
                for cover_class, points in self._classes.items()
            },
        }

    def write_json(self, *, extra: Mapping[str, Any] | None = None) -> Path:
        COVERAGE_DIR.mkdir(parents=True, exist_ok=True)
        payload = self.to_dict()
        if extra:
            payload["extra"] = dict(extra)
        out = COVERAGE_DIR / f"{self.block}.json"
        out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return out


def axi_resp_name(code: int) -> str:
    """Canonical names for the AXI-Lite ``BRESP``/``RRESP`` 2-bit field."""
    return {
        0: "OKAY",
        1: "EXOKAY",
        2: "SLVERR",
        3: "DECERR",
    }.get(code & 0x3, f"UNKNOWN_{code & 0x3:02b}")
