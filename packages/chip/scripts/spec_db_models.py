#!/usr/bin/env python3
"""Typed loaders for the spec-DB nameplate source of truth.

This module provides pydantic v2 models for ``docs/spec-db/chip-topology.yaml``
(schema ``eliza.chip_topology.v1``), the single nameplate source of truth for
the Eliza E1 chip. Every consistency checker that needs the canonical core
counts, clocks, memory class, storage, NPU TOPS targets, fabric geometry,
debug, or process node loads it through :func:`load_chip_topology` instead of
re-parsing YAML and re-declaring numeric literals.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

CHIP_TOPOLOGY_SCHEMA = "eliza.chip_topology.v1"


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ChipTopologyCpu(_Frozen):
    big_cores: int = Field(ge=0)
    mid_cores: int = Field(ge=0)
    little_cores: int = Field(ge=0)
    application_cores: int = Field(ge=1)
    management_security_harts: int = Field(ge=0)
    big_core_base_ghz: float = Field(gt=0)
    big_core_burst_ghz: float = Field(gt=0)
    mid_core_base_ghz: float = Field(gt=0)
    mid_core_max_ghz: float = Field(gt=0)
    little_core_base_ghz: float = Field(gt=0)
    little_core_max_ghz: float = Field(gt=0)
    management_hart_max_mhz: int = Field(gt=0)

    def total_application_cores(self) -> int:
        return self.big_cores + self.mid_cores + self.little_cores


class ChipTopologyMemory(_Frozen):
    external_class: str
    baseline_sku_class: str
    capacity_gib_min: int = Field(gt=0)
    capacity_gib_ai_sku: int = Field(gt=0)
    peak_bandwidth_gbps_min: float = Field(gt=0)
    sustained_bandwidth_gbps_min: float = Field(gt=0)
    shared_system_cache_mib_min: int = Field(gt=0)


class ChipTopologyStorage(_Frozen):
    class_: str = Field(alias="class")
    fallback_class: str
    capacity_gb_min: int = Field(gt=0)


class ChipTopologyNpu(_Frozen):
    dense_int8_peak_tops: float = Field(gt=0)
    dense_int8_sustained_tops: float = Field(gt=0)
    dense_int8_base_operating_tops: float = Field(gt=0)
    sparse_int4_peak_tops: float = Field(gt=0)
    sparse_int4_sustained_tops: float = Field(gt=0)
    int2_bitnet_peak_tops: float = Field(gt=0)
    fp8_peak_tflops: float = Field(gt=0)
    local_sram_mib_min: int = Field(gt=0)
    tile_count_min: int = Field(gt=0)
    tile_count_max: int = Field(gt=0)


class ChipTopologyFabric(_Frozen):
    axi_addr_w: int = Field(gt=0)
    axi_data_w: int = Field(gt=0)
    axi_id_w: int = Field(gt=0)
    soc_phys_addr_w: int = Field(gt=0)
    topology: str
    coherence_protocol: str


class ChipTopologyDebug(_Frozen):
    standard: str
    transport: str
    status: str


class ChipTopologyProcess(_Frozen):
    marketing_name: str
    node_range_nm: str
    selected_option_status: str


class ChipTopology(_Frozen):
    schema_: Literal["eliza.chip_topology.v1"] = Field(alias="schema")
    as_of: str
    target_year: int
    target_class: str
    claim_boundary: str
    source_anchors: dict[str, str]
    cpu: ChipTopologyCpu
    memory: ChipTopologyMemory
    storage: ChipTopologyStorage
    npu: ChipTopologyNpu
    fabric: ChipTopologyFabric
    debug: ChipTopologyDebug
    process: ChipTopologyProcess
    forbidden_claims_until_complete: list[str]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_topology_path() -> Path:
    return _repo_root() / "docs/spec-db/chip-topology.yaml"


def load_chip_topology(path: Path | None = None) -> ChipTopology:
    """Load and validate ``chip-topology.yaml`` into a typed model.

    Raises ``pydantic.ValidationError`` on schema drift and ``ValueError`` if
    the file is not a YAML mapping.
    """

    target = path or default_topology_path()
    raw = yaml.safe_load(target.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{target} must contain a YAML mapping")
    return ChipTopology.model_validate(raw)
