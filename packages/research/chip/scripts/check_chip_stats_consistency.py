#!/usr/bin/env python3
"""Fail-closed cross-file consistency gate for the chip nameplate stats.

``docs/spec-db/chip-topology.yaml`` (schema ``eliza.chip_topology.v1``) is the
single nameplate source of truth. Many other YAMLs restate the same numbers
(core counts, NPU dense-INT8 TOPS, memory, storage). Before this gate existed,
the repo carried six different core-count answers and an NPU dense-INT8 TOPS
target of 160 in spec-DB vs 44 in the rail plan / operating point, with no gate
catching the drift.

This gate loads the topology as truth, then walks every external source that
restates a nameplate field. Each restated value must either:

  * match the topology field exactly, or
  * be listed in ``ALLOWANCES`` with an explicit ``override_reason`` documenting
    why the source legitimately encodes a different intent (e.g. the rail plan
    and operating point describe a power-optimized 2-core DVFS subset, not the
    full 8-core nameplate; the 44 TOPS figure is the nominal base operating
    point, not the peak nameplate).

Any restated value that neither matches nor carries a documented override is
unjustified drift and fails the gate.

Output is compatible with ``scripts/aggregate_tapeout_readiness.py``:
  * exit 0 + ``STATUS: PASS``  -> PASS
  * exit 1 + ``STATUS: FAIL``  -> real drift FAIL
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from spec_db_models import ChipTopology, load_chip_topology

ROOT = Path(__file__).resolve().parents[1]


def _load_yaml(rel: str) -> dict[str, Any]:
    data = yaml.safe_load((ROOT / rel).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel} must contain a YAML mapping")
    return data


@dataclass(frozen=True)
class Allowance:
    """A documented, intentional divergence from the nameplate truth."""

    source: str
    field: str
    expected_value: object
    override_reason: str


# Sources that legitimately diverge from the nameplate, with the reason each is
# NOT a drift bug. Every entry is a power-optimized subset or a base operating
# point, not a competing nameplate claim.
ALLOWANCES: tuple[Allowance, ...] = (
    Allowance(
        source="docs/pd/rail-plan-2028.yaml",
        field="soc_topology.cpu_big_cores",
        expected_value=2,
        override_reason=(
            "Rail plan models a power-optimized DVFS rail grouping (2 big-class "
            "rails) for the PDN/thermal budget, not the 1+3+4 nameplate. The big "
            "+ mid cores share the VDD_CPU_BIG class rail; the rail plan counts "
            "rail-active cores, not the full hart inventory."
        ),
    ),
    Allowance(
        source="docs/pd/rail-plan-2028.yaml",
        field="soc_topology.cpu_little_cores",
        expected_value=4,
        override_reason=(
            "Matches the nameplate little-core count (4); the rail plan groups "
            "the 4 little cores onto one VDD_CPU_LITTLE rail."
        ),
    ),
    Allowance(
        source="docs/pd/rail-plan-2028.yaml",
        field="soc_topology.npu_dense_int8_tops_target",
        expected_value=44.0,
        override_reason=(
            "Rail plan uses the 44 TOPS nominal base operating point (the value "
            "the PDN/thermal model is sized for, 1.2 W NPU active), NOT the 160 "
            "TOPS peak nameplate. Peak is bursty; the rail plan sizes for "
            "sustained active draw."
        ),
    ),
    Allowance(
        source="docs/architecture-optimization/soc-optimized-operating-point.yaml",
        field="selected_modeled_point.cpu_cores",
        expected_value=2,
        override_reason=(
            "Operating point is the best modeled CPU+NPU DVFS subset found by "
            "the 14A sweep: 2 active cores at the selected scalable point, not "
            "the 8-core nameplate. The optimizer activates the minimum core set "
            "that meets the perf/W envelope."
        ),
    ),
    Allowance(
        source="docs/architecture-optimization/soc-optimized-operating-point.yaml",
        field="selected_modeled_point.npu_base_tops",
        expected_value=44.0,
        override_reason=(
            "Operating point uses the 44 TOPS nominal base operating point at "
            "1.2 W NPU active, NOT the 160 TOPS peak nameplate."
        ),
    ),
)


def _allowance(source: str, field: str) -> Allowance | None:
    for entry in ALLOWANCES:
        if entry.source == source and entry.field == field:
            return entry
    return None


@dataclass(frozen=True)
class Expectation:
    """One nameplate field restated by an external source."""

    source: str
    field: str
    truth: object


def _dig(data: dict[str, Any], dotted: str) -> object:
    cur: Any = data
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return _MISSING
        cur = cur[part]
    return cur


class _Missing:
    def __repr__(self) -> str:
        return "<missing>"


_MISSING = _Missing()


def _numeric_equal(a: object, b: object) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return float(a) == float(b)
    return a == b


def build_expectations(topo: ChipTopology) -> list[Expectation]:
    """Every external restatement of a nameplate field, paired with truth."""

    return [
        # ---- npu-2028-target.yaml: peak/sustained nameplate ----------------
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.dense_int8_peak_tops_min",
            topo.npu.dense_int8_peak_tops,
        ),
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.dense_int8_sustained_tops_min",
            topo.npu.dense_int8_sustained_tops,
        ),
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.sparse_int4_peak_tops_min",
            topo.npu.sparse_int4_peak_tops,
        ),
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.sparse_int4_sustained_tops_min",
            topo.npu.sparse_int4_sustained_tops,
        ),
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.int2_bitnet_peak_tops_min",
            topo.npu.int2_bitnet_peak_tops,
        ),
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.fp8_peak_tflops_min",
            topo.npu.fp8_peak_tflops,
        ),
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.local_sram_mib_min",
            topo.npu.local_sram_mib_min,
        ),
        Expectation(
            "docs/spec-db/npu-2028-target.yaml",
            "numeric_targets.shared_system_cache_mib_min",
            topo.memory.shared_system_cache_mib_min,
        ),
        # ---- memory-2028-target.yaml: external memory nameplate ------------
        Expectation(
            "docs/spec-db/memory-2028-target.yaml",
            "external_memory.standard",
            topo.memory.external_class,
        ),
        Expectation(
            "docs/spec-db/memory-2028-target.yaml",
            "external_memory.capacity_gib_min",
            topo.memory.capacity_gib_min,
        ),
        Expectation(
            "docs/spec-db/memory-2028-target.yaml",
            "external_memory.capacity_gib_target_ai_sku",
            topo.memory.capacity_gib_ai_sku,
        ),
        Expectation(
            "docs/spec-db/memory-2028-target.yaml",
            "external_memory.peak_bandwidth_gbps_min",
            topo.memory.peak_bandwidth_gbps_min,
        ),
        Expectation(
            "docs/spec-db/memory-2028-target.yaml",
            "external_memory.sustained_bandwidth_gbps_min",
            topo.memory.sustained_bandwidth_gbps_min,
        ),
        Expectation(
            "docs/spec-db/memory-2028-target.yaml",
            "shared_system_cache.capacity_mib_min",
            topo.memory.shared_system_cache_mib_min,
        ),
        # ---- rail-plan-2028.yaml: power-optimized subset (allowances) ------
        Expectation(
            "docs/pd/rail-plan-2028.yaml",
            "soc_topology.cpu_big_cores",
            topo.cpu.big_cores,
        ),
        Expectation(
            "docs/pd/rail-plan-2028.yaml",
            "soc_topology.cpu_little_cores",
            topo.cpu.little_cores,
        ),
        Expectation(
            "docs/pd/rail-plan-2028.yaml",
            "soc_topology.npu_dense_int8_tops_target",
            topo.npu.dense_int8_peak_tops,
        ),
        # ---- soc-optimized-operating-point.yaml: DVFS subset (allowances) --
        Expectation(
            "docs/architecture-optimization/soc-optimized-operating-point.yaml",
            "selected_modeled_point.cpu_cores",
            topo.cpu.application_cores,
        ),
        Expectation(
            "docs/architecture-optimization/soc-optimized-operating-point.yaml",
            "selected_modeled_point.npu_base_tops",
            topo.npu.dense_int8_peak_tops,
        ),
        # ---- aosp-simulator-completion-gate.yaml: target FLOOR -------------
        # The AOSP floor must be <= the nameplate (it is a minimum the
        # nameplate is required to clear). cpu_cores=8 equals the nameplate
        # application-core count exactly.
        Expectation(
            "docs/project/aosp-simulator-completion-gate.yaml",
            "eliza_target_floor.cpu_cores",
            topo.cpu.application_cores,
        ),
        Expectation(
            "docs/project/aosp-simulator-completion-gate.yaml",
            "eliza_target_floor.storage_gb",
            topo.storage.capacity_gb_min,
        ),
    ]


def main() -> int:
    errors: list[str] = []

    try:
        topo = load_chip_topology()
    except Exception as exc:  # noqa: BLE001 - surface any load/schema failure verbatim
        print(f"STATUS: FAIL chip-topology.yaml did not load/validate: {exc}")
        return 1

    # Invariant: the nameplate must be internally consistent.
    if topo.cpu.total_application_cores() != topo.cpu.application_cores:
        errors.append(
            "chip-topology.yaml: cpu.application_cores "
            f"({topo.cpu.application_cores}) != big+mid+little "
            f"({topo.cpu.total_application_cores()})"
        )
    if topo.npu.dense_int8_base_operating_tops > topo.npu.dense_int8_peak_tops:
        errors.append(
            "chip-topology.yaml: npu base operating TOPS "
            f"({topo.npu.dense_int8_base_operating_tops}) exceeds peak "
            f"({topo.npu.dense_int8_peak_tops})"
        )

    loaded: dict[str, dict[str, Any]] = {}
    matched = 0
    overridden = 0

    for exp in build_expectations(topo):
        if exp.source not in loaded:
            try:
                loaded[exp.source] = _load_yaml(exp.source)
            except (OSError, ValueError) as exc:
                errors.append(f"{exp.source}: could not load: {exc}")
                loaded[exp.source] = {}
        actual = _dig(loaded[exp.source], exp.field)

        if actual is _MISSING:
            errors.append(f"{exp.source}#{exp.field}: field missing (expected {exp.truth!r})")
            continue

        if _numeric_equal(actual, exp.truth):
            matched += 1
            continue

        allow = _allowance(exp.source, exp.field)
        if allow is not None and _numeric_equal(actual, allow.expected_value):
            overridden += 1
            print(
                f"OVERRIDE: {exp.source}#{exp.field} = {actual!r} "
                f"(nameplate {exp.truth!r}) — {allow.override_reason}"
            )
            continue

        errors.append(
            f"{exp.source}#{exp.field} = {actual!r} drifts from nameplate "
            f"{exp.truth!r} with no documented override_reason"
        )

    # Catch stale allowances: an allowance that no longer corresponds to a real
    # divergence is itself drift (the source was fixed or renamed).
    for allow in ALLOWANCES:
        data = loaded.get(allow.source)
        if data is None:
            try:
                data = _load_yaml(allow.source)
            except (OSError, ValueError) as exc:
                errors.append(f"allowance {allow.source}#{allow.field}: source unloadable: {exc}")
                continue
        actual = _dig(data, allow.field)
        if actual is _MISSING:
            errors.append(
                f"allowance {allow.source}#{allow.field}: field no longer exists; "
                "remove the stale allowance"
            )
        elif not _numeric_equal(actual, allow.expected_value):
            errors.append(
                f"allowance {allow.source}#{allow.field} = {actual!r} no longer matches "
                f"the documented override value {allow.expected_value!r}; update or remove it"
            )

    if errors:
        for err in errors:
            print(f"FAIL: {err}")
        print(f"STATUS: FAIL chip-stats-consistency: {len(errors)} unjustified drift(s)")
        return 1

    print(
        f"STATUS: PASS chip-stats-consistency: {matched} fields match nameplate, "
        f"{overridden} documented override(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
