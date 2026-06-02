"""E1X3D 3D-stacked wafer-mesh architecture model.

E1X3D is the 3D extension of the E1X Cerebras-style planar wafer mesh: the same
array of tiny RV64 processing elements, now stacked in Z. Each logical core sits
in a vertical column spanning ``logical_tiers`` *logic* tiers; each logic tier
carries ``memory_tiers_per_core`` folded SRAM tiers above it (memory-on-logic).
The fabric is a 3D mesh (X/Y in-plane plus Z links between adjacent logic tiers)
and repairs around dead cores, dead in-plane links, dead inter-tier (Z) links,
and dead whole tiers via spare rows, columns, and planes.

Design contract: ``research/threed_ic_2026/03_implementation/e1x3d_design_decisions.md``.

The X/Y wafer mesh is Cerebras-proven; the Z tier-stack, dead-tier routing,
multi-tier thermal, and stacked yield are modeled and fail closed where they
depend on unavailable commercial 3D EDA, a sequential-integration PDK, or
measured silicon. This module emits architecture-simulation evidence only.

The 3D direction encoding reuses the E1X 3-bit fabric direction field
(``rtl/e1x/e1x_pkg.sv``): NORTH=0, EAST=1, SOUTH=2, WEST=3, LOCAL=4, plus the
previously-unused UP=5 and DOWN=6, with DROP=7. The repair-ROM route word
already carries a 3-bit first-hop direction, so the 3D fabric needs no ROM
format break.
"""

from __future__ import annotations

from dataclasses import dataclass
from heapq import heappop, heappush
from math import exp

from compiler.runtime.e1_npu_scale_model import OPEN_2028_SOTA
from compiler.runtime.e1x_wafer_model import (
    SCALED_8GB_MODEL,
    SCALED_8GB_RUN,
    QuantizedModelSpec,
    _stable_fraction,
    _u64_hex,
    _word_list_sha256,
    artifact_sha256,
    model_execution_plan,
    model_load_plan,
    model_shard_sample_artifact,
)

# Fabric direction codes, matching rtl/e1x/e1x_pkg.sv (e1x_dir_e).
DIR_NORTH = 0
DIR_EAST = 1
DIR_SOUTH = 2
DIR_WEST = 3
DIR_LOCAL = 4
DIR_UP = 5
DIR_DOWN = 6
DIR_DROP = 7


@dataclass(frozen=True)
class E1X3DConfig:
    name: str = "e1x3d_wse_riscv_stack_v0"
    logical_rows: int = 16
    logical_cols: int = 16
    logical_tiers: int = 2
    spare_rows: int = 2
    spare_cols: int = 2
    spare_tiers: int = 0
    core_clock_hz: int = 900_000_000
    int8_lanes_per_core: int = 8
    base_local_sram_kib_per_core: int = 48
    memory_tiers_per_core: int = 1
    fabric_payload_bits: int = 32
    routing_colors: int = 24
    link_bits_per_cycle_bidirectional: int = 64
    target_active_yield: float = 0.98
    # Stacking / packaging.
    bonding: str = "hybrid_bond_f2f"
    inter_tier_via_pitch_um: float = 6.0
    inter_tier_vias_per_core: int = 4096
    base_core_area_mm2: float = 0.050
    # Derived, not assumed: the block SRAM-on-logic split in e1x3d_placement_model
    # (logic 0.018 mm2 over SRAM 0.032 mm2 -> footprint max = 0.032 mm2) yields a
    # 1 - 0.032/0.050 = 0.36 XY footprint shrink. Kept in sync with that model so
    # packing_density_ratio is not an unsupported headline.
    xy_footprint_shrink: float = 0.36
    thermal_max_logic_tiers: int = 4
    # Thermal model (grounded in Open3DBench +10%/extra-tier, NSF W/mm2 ceiling).
    ambient_c: float = 45.0
    baseline_tier_rise_c: float = 40.0
    per_extra_logic_tier_temp_factor: float = 0.10
    tier_power_density_w_per_mm2: float = 0.6
    tier_power_density_ceiling_w_per_mm2: float = 1.0
    max_junction_temp_c: float = 105.0
    cooling: str = "dual_side"
    dual_side_rise_reduction: float = 0.40
    # Yield model.
    defect_density_per_mm2: float = 0.05
    bond_yield_per_interface: float = 0.9995
    target_stack_bond_yield: float = 0.95
    # Energy accounting (shared with the 2D E1X model for comparability).
    static_power_w_per_core: float = 0.018
    energy_pj_per_int8_op: float = 0.22
    local_sram_pj_per_byte: float = 0.035
    fabric_pj_per_byte_hop: float = 0.16

    @property
    def physical_rows(self) -> int:
        return self.logical_rows + self.spare_rows

    @property
    def physical_cols(self) -> int:
        return self.logical_cols + self.spare_cols

    @property
    def physical_tiers(self) -> int:
        return self.logical_tiers + self.spare_tiers

    @property
    def local_sram_kib_per_core(self) -> int:
        return self.base_local_sram_kib_per_core * (1 + self.memory_tiers_per_core)

    @property
    def logical_cores(self) -> int:
        return self.logical_rows * self.logical_cols * self.logical_tiers

    @property
    def physical_cores(self) -> int:
        return self.physical_rows * self.physical_cols * self.physical_tiers

    @property
    def spare_cores(self) -> int:
        return self.physical_cores - self.logical_cores

    @property
    def memory_tiers_total(self) -> int:
        return self.logical_tiers * self.memory_tiers_per_core

    @property
    def stack_tier_count(self) -> int:
        """Total physical Z tiers in the stack (logic plus folded memory)."""
        return self.logical_tiers + self.memory_tiers_total

    @property
    def dense_int8_peak_tops(self) -> float:
        return self.logical_cores * self.int8_lanes_per_core * 2 * self.core_clock_hz / 1e12

    @property
    def local_sram_mib(self) -> float:
        return self.logical_cores * self.local_sram_kib_per_core / 1024

    @property
    def fabric_bisection_gbps(self) -> float:
        # 3D bisection: the cut crosses a rows x tiers plane of bidirectional links.
        plane = self.logical_rows * self.logical_tiers
        return plane * self.link_bits_per_cycle_bidirectional * self.core_clock_hz / 1e9

    @property
    def core_xy_area_mm2(self) -> float:
        return self.base_core_area_mm2 * (1.0 - self.xy_footprint_shrink)

    @property
    def packing_density_ratio(self) -> float:
        """Cores per unit wafer area vs a planar (1 logic tier, no shrink) E1X."""
        return self.logical_tiers / (1.0 - self.xy_footprint_shrink)


@dataclass(frozen=True, order=True)
class Coord3:
    row: int
    col: int
    tier: int


@dataclass(frozen=True)
class Link3:
    a: Coord3
    b: Coord3

    def normalized(self) -> Link3:
        return self if self.a <= self.b else Link3(self.b, self.a)


@dataclass(frozen=True)
class DefectScenario3D:
    name: str
    core_failure_rate: float
    link_failure_rate: float
    z_link_failure_rate: float
    seed: str
    dead_tier: int | None = None
    dead_tier_rows: int = 0
    dead_tier_cols: int = 0
    max_route_checks: int | None = None


NORMAL_DEFECT_SCENARIO_3D = DefectScenario3D(
    "normal_wafer_sort_3d", 0.002, 0.0005, 0.001, "e1x3d-normal-v1", max_route_checks=4096
)
HIGH_DEFECT_SCENARIO_3D = DefectScenario3D(
    "high_failure_rate_repair_stress_3d",
    0.02,
    0.005,
    0.008,
    "e1x3d-high-failure-v1",
    max_route_checks=8192,
)
# A localized dead-tier region (a knocked-out block on one tier) proves Z-reroute
# plus bounded spare remap. A *full* dead logical tier needs a spare plane
# (spare_tiers >= 1), which is a separately-budgeted resource the scaled wafer
# config does not carry; that case fails closed in stack_yield_model instead.
DEAD_TIER_SCENARIO_3D = DefectScenario3D(
    "dead_tier_region_graceful_degradation_3d",
    0.004,
    0.001,
    0.002,
    "e1x3d-dead-tier-v1",
    dead_tier=1,
    dead_tier_rows=8,
    dead_tier_cols=8,
    max_route_checks=8192,
)


def scaled_e1x3d_config() -> E1X3DConfig:
    """Cerebras-scale E1X3D: E1X-class per-tier mesh, two logic tiers, SRAM tier.

    Per-tier logical mesh matches the E1X 512 x 342 scaled point so the two chips
    compare apples-to-apples; the 3D wins are tier count (2x cores), folded SRAM
    (2x per-core memory), and tighter XY packing.
    """
    return E1X3DConfig(
        name="e1x3d_wse_riscv_stack_16gb_v0",
        logical_rows=512,
        logical_cols=342,
        logical_tiers=2,
        spare_rows=16,
        spare_cols=16,
        spare_tiers=0,
        int8_lanes_per_core=16,
        memory_tiers_per_core=1,
    )


def deterministic_defects(config: E1X3DConfig) -> tuple[set[Coord3], set[Link3]]:
    candidates = [
        Coord3(0, 7, 0),
        Coord3(3, 3, 1),
        Coord3(5, 9, 0),
        Coord3(9, 9, 1),
        Coord3(12, 3, 0),
        Coord3(2, 14, 1),
        Coord3(15, 4, 0),
        Coord3(11, 11, 1),
    ]
    blocked_cores = {
        c
        for c in candidates
        if c.row < config.physical_rows
        and c.col < config.physical_cols
        and c.tier < config.physical_tiers
    }
    raw_links = [
        Link3(Coord3(2, 2, 0), Coord3(2, 3, 0)),
        Link3(Coord3(7, 4, 1), Coord3(8, 4, 1)),
        Link3(Coord3(5, 5, 0), Coord3(5, 5, 1)),
        Link3(Coord3(10, 8, 0), Coord3(10, 8, 1)),
    ]
    blocked_links = {
        link.normalized()
        for link in raw_links
        if _in_bounds(config, link.a) and _in_bounds(config, link.b)
    }
    return blocked_cores, blocked_links


def _in_bounds(config: E1X3DConfig, coord: Coord3) -> bool:
    return (
        0 <= coord.row < config.physical_rows
        and 0 <= coord.col < config.physical_cols
        and 0 <= coord.tier < config.physical_tiers
    )


def physical_nodes(config: E1X3DConfig) -> list[Coord3]:
    return [
        Coord3(row, col, tier)
        for tier in range(config.physical_tiers)
        for row in range(config.physical_rows)
        for col in range(config.physical_cols)
    ]


def generated_defects(
    config: E1X3DConfig, scenario: DefectScenario3D
) -> tuple[set[Coord3], set[Link3]]:
    blocked_cores: set[Coord3] = set()
    for coord in physical_nodes(config):
        if (
            scenario.dead_tier is not None
            and coord.tier == scenario.dead_tier
            and coord.row < min(scenario.dead_tier_rows, config.logical_rows)
            and coord.col < min(scenario.dead_tier_cols, config.logical_cols)
        ):
            blocked_cores.add(coord)
            continue
        if (
            _stable_fraction((scenario.seed, "core", coord.row, coord.col, coord.tier))
            < scenario.core_failure_rate
        ):
            blocked_cores.add(coord)
    blocked_links: set[Link3] = set()
    for coord in physical_nodes(config):
        planar = (
            (Coord3(coord.row + 1, coord.col, coord.tier), scenario.link_failure_rate, "p"),
            (Coord3(coord.row, coord.col + 1, coord.tier), scenario.link_failure_rate, " p"),
            (Coord3(coord.row, coord.col, coord.tier + 1), scenario.z_link_failure_rate, "z"),
        )
        for nxt, rate, kind in planar:
            if not _in_bounds(config, nxt):
                continue
            if (
                _stable_fraction(
                    (
                        scenario.seed,
                        "link",
                        kind,
                        coord.row,
                        coord.col,
                        coord.tier,
                        nxt.row,
                        nxt.col,
                        nxt.tier,
                    )
                )
                < rate
            ):
                blocked_links.add(Link3(coord, nxt).normalized())
    return blocked_cores, blocked_links


def coord_record(coord: Coord3) -> dict[str, int]:
    return {"row": coord.row, "col": coord.col, "tier": coord.tier}


def link_record(link: Link3) -> dict[str, dict[str, int]]:
    normalized = link.normalized()
    return {"a": coord_record(normalized.a), "b": coord_record(normalized.b)}


def neighbors(config: E1X3DConfig, coord: Coord3) -> list[Coord3]:
    candidates = (
        Coord3(coord.row - 1, coord.col, coord.tier),
        Coord3(coord.row + 1, coord.col, coord.tier),
        Coord3(coord.row, coord.col - 1, coord.tier),
        Coord3(coord.row, coord.col + 1, coord.tier),
        Coord3(coord.row, coord.col, coord.tier - 1),
        Coord3(coord.row, coord.col, coord.tier + 1),
    )
    return [nxt for nxt in candidates if _in_bounds(config, nxt)]


def _manhattan(a: Coord3, b: Coord3) -> int:
    return abs(a.row - b.row) + abs(a.col - b.col) + abs(a.tier - b.tier)


def _is_spare(config: E1X3DConfig, coord: Coord3) -> bool:
    return (
        coord.row >= config.logical_rows
        or coord.col >= config.logical_cols
        or coord.tier >= config.logical_tiers
    )


def repair_map(config: E1X3DConfig, blocked_cores: set[Coord3]) -> dict[Coord3, Coord3]:
    """Map every logical core to a physical core, replacing blocked logical cores.

    Spare cores live in the spare rows, columns, and planes. Replacements are
    chosen by nearest 3D Manhattan distance so a dead in-plane core prefers an
    in-plane spare and a dead tier slice can fall back to a spare plane.

    A blocked logical core (row < logical_rows, col < logical_cols) is almost
    always closest to the spare-row band cell directly below it in the same
    column, the spare-col band cell directly right of it in the same row, or a
    spare-plane cell directly above it. Those aligned bands are searched first
    (cheap at wafer scale); an exact global nearest search is the fallback that
    guarantees a spare is found while any remains.
    """
    available: set[Coord3] = {
        node
        for node in physical_nodes(config)
        if node not in blocked_cores and _is_spare(config, node)
    }
    blocked_logical = [
        Coord3(row, col, tier)
        for tier in range(config.logical_tiers)
        for row in range(config.logical_rows)
        for col in range(config.logical_cols)
        if Coord3(row, col, tier) in blocked_cores
    ]
    if len(available) < len(blocked_logical):
        raise ValueError("not enough usable spare cores to repair 3D logical mesh")

    def aligned_candidate(logical: Coord3) -> Coord3 | None:
        best: Coord3 | None = None
        best_key: tuple[int, int, int, int] | None = None
        for rr in range(config.logical_rows, config.physical_rows):
            cand = Coord3(rr, logical.col, logical.tier)
            if cand in available:
                best, best_key = cand, (rr - logical.row, cand.tier, cand.row, cand.col)
                break
        for cc in range(config.logical_cols, config.physical_cols):
            cand = Coord3(logical.row, cc, logical.tier)
            if cand in available:
                key = (cc - logical.col, cand.tier, cand.row, cand.col)
                if best_key is None or key < best_key:
                    best, best_key = cand, key
                break
        for tt in range(config.logical_tiers, config.physical_tiers):
            cand = Coord3(logical.row, logical.col, tt)
            if cand in available:
                key = (tt - logical.tier, cand.tier, cand.row, cand.col)
                if best_key is None or key < best_key:
                    best, best_key = cand, key
                break
        return best

    mapping: dict[Coord3, Coord3] = {}
    for tier in range(config.logical_tiers):
        for row in range(config.logical_rows):
            for col in range(config.logical_cols):
                logical = Coord3(row, col, tier)
                if logical not in blocked_cores:
                    mapping[logical] = logical
                    continue
                replacement = aligned_candidate(logical)
                if replacement is None:
                    replacement = min(
                        available,
                        key=lambda node: (_manhattan(node, logical), node.tier, node.row, node.col),
                    )
                mapping[logical] = replacement
                available.discard(replacement)
    return mapping


def remap_records(mapping: dict[Coord3, Coord3]) -> list[dict[str, dict[str, int]]]:
    return [
        {"logical": coord_record(logical), "physical": coord_record(physical)}
        for logical, physical in sorted(mapping.items())
        if logical != physical
    ]


def route(
    config: E1X3DConfig,
    start: Coord3,
    goal: Coord3,
    blocked_cores: set[Coord3],
    blocked_links: set[Link3],
) -> list[Coord3]:
    if start in blocked_cores or goal in blocked_cores:
        raise ValueError("cannot route through a blocked endpoint")
    frontier: list[tuple[int, int, Coord3]] = []
    heappush(frontier, (_manhattan(start, goal), 0, start))
    previous: dict[Coord3, Coord3 | None] = {start: None}
    cost: dict[Coord3, int] = {start: 0}
    while frontier:
        _, current_cost, current = heappop(frontier)
        if current == goal:
            break
        if current_cost != cost[current]:
            continue
        for nxt in neighbors(config, current):
            if nxt in blocked_cores or Link3(current, nxt).normalized() in blocked_links:
                continue
            next_cost = current_cost + 1
            if next_cost >= cost.get(nxt, 1 << 60):
                continue
            previous[nxt] = current
            cost[nxt] = next_cost
            heappush(frontier, (next_cost + _manhattan(nxt, goal), next_cost, nxt))
    if goal not in previous:
        raise ValueError(f"no repaired 3D route from {start} to {goal}")
    path = [goal]
    while path[-1] != start:
        parent = previous[path[-1]]
        if parent is None:
            break
        path.append(parent)
    return list(reversed(path))


def first_hop_dir(path: list[Coord3]) -> int:
    if len(path) < 2:
        return DIR_LOCAL
    a, b = path[0], path[1]
    if b.row < a.row:
        return DIR_NORTH
    if b.col > a.col:
        return DIR_EAST
    if b.row > a.row:
        return DIR_SOUTH
    if b.col < a.col:
        return DIR_WEST
    if b.tier > a.tier:
        return DIR_UP
    if b.tier < a.tier:
        return DIR_DOWN
    return DIR_LOCAL


def _logical_edges(config: E1X3DConfig) -> list[tuple[Coord3, Coord3]]:
    edges: list[tuple[Coord3, Coord3]] = []
    for tier in range(config.logical_tiers):
        for row in range(config.logical_rows):
            for col in range(config.logical_cols):
                here = Coord3(row, col, tier)
                for peer in (
                    Coord3(row + 1, col, tier),
                    Coord3(row, col + 1, tier),
                    Coord3(row, col, tier + 1),
                ):
                    if (
                        peer.row < config.logical_rows
                        and peer.col < config.logical_cols
                        and peer.tier < config.logical_tiers
                    ):
                        edges.append((here, peer))
    return edges


def sampled_route_records(
    config: E1X3DConfig,
    mapping: dict[Coord3, Coord3],
    blocked_cores: set[Coord3],
    blocked_links: set[Link3],
    sample_count: int = 64,
) -> list[dict[str, object]]:
    edges = _logical_edges(config)
    step = max(1, len(edges) // sample_count)
    records: list[dict[str, object]] = []
    for logical, peer in edges[::step][:sample_count]:
        path = route(config, mapping[logical], mapping[peer], blocked_cores, blocked_links)
        records.append(
            {
                "logical_from": coord_record(logical),
                "logical_to": coord_record(peer),
                "physical_from": coord_record(mapping[logical]),
                "physical_to": coord_record(mapping[peer]),
                "first_hop_dir": first_hop_dir(path),
                "hops": len(path) - 1,
                "path": [coord_record(coord) for coord in path],
            }
        )
    return records


def validate_repaired_mesh(
    config: E1X3DConfig,
    mapping: dict[Coord3, Coord3],
    blocked_cores: set[Coord3],
    blocked_links: set[Link3],
    max_paths: int | None = None,
) -> dict[str, int | float | str]:
    edges = _logical_edges(config)
    total_edges = len(edges)
    z_edges_total = sum(1 for a, b in edges if a.tier != b.tier)
    if max_paths is not None and max_paths < len(edges):
        step = max(1, len(edges) // max_paths)
        edges = edges[::step][:max_paths]
    total_paths = 0
    extra_hops = 0
    max_path_hops = 0
    z_paths_checked = 0
    for logical, peer in edges:
        hops = len(route(config, mapping[logical], mapping[peer], blocked_cores, blocked_links)) - 1
        total_paths += 1
        extra_hops += max(0, hops - 1)
        max_path_hops = max(max_path_hops, hops)
        if logical.tier != peer.tier:
            z_paths_checked += 1
    return {
        "logical_neighbor_paths_checked": total_paths,
        "logical_neighbor_paths_total": total_edges,
        "z_neighbor_paths_total": z_edges_total,
        "z_neighbor_paths_checked": z_paths_checked,
        "route_check_mode": "sampled" if max_paths is not None else "exhaustive",
        "extra_repair_hops": extra_hops,
        "max_repaired_neighbor_hops": max_path_hops,
        "average_extra_hops_per_neighbor": extra_hops / total_paths,
    }


def thermal_model(config: E1X3DConfig) -> dict[str, object]:
    """Stacked-logic thermal estimate and ceiling gate.

    Uses the Open3DBench measured +~10% peak temperature per extra logic tier and
    an NSF-class per-tier power-density ceiling. Memory tiers act as cool buffers
    and add no active power. Dual-sided / backside cooling reduces the temperature
    rise above ambient. The gate fails closed when logic tiers, per-tier power
    density, or peak junction temperature exceed their ceilings.
    """
    extra = max(0, config.logical_tiers - 1)
    rise = config.baseline_tier_rise_c * (1.0 + config.per_extra_logic_tier_temp_factor * extra)
    cooling_factor = 1.0 - config.dual_side_rise_reduction if config.cooling == "dual_side" else 1.0
    effective_rise = rise * cooling_factor
    peak_junction_c = config.ambient_c + effective_rise
    per_tier = [
        {
            "logic_tier": tier,
            "power_density_w_per_mm2": config.tier_power_density_w_per_mm2,
            "junction_c": round(
                config.ambient_c
                + config.baseline_tier_rise_c
                * (1.0 + config.per_extra_logic_tier_temp_factor * tier)
                * cooling_factor,
                3,
            ),
        }
        for tier in range(config.logical_tiers)
    ]
    tiers_ok = config.logical_tiers <= config.thermal_max_logic_tiers
    density_ok = config.tier_power_density_w_per_mm2 <= config.tier_power_density_ceiling_w_per_mm2
    temp_ok = peak_junction_c <= config.max_junction_temp_c
    status = "PASS" if (tiers_ok and density_ok and temp_ok) else "BLOCKED"
    reasons: list[str] = []
    if not tiers_ok:
        reasons.append(
            f"logic tiers {config.logical_tiers} exceed thermal max {config.thermal_max_logic_tiers}"
        )
    if not density_ok:
        reasons.append(
            f"per-tier power density {config.tier_power_density_w_per_mm2} W/mm2 exceeds "
            f"ceiling {config.tier_power_density_ceiling_w_per_mm2} W/mm2"
        )
    if not temp_ok:
        reasons.append(
            f"peak junction {peak_junction_c:.1f} C exceeds max {config.max_junction_temp_c} C"
        )
    artifact = {
        "schema": "eliza.e1x3d.thermal_model.v1",
        "chip": config.name,
        "logic_tiers": config.logical_tiers,
        "memory_tiers_per_core": config.memory_tiers_per_core,
        "stack_tier_count": config.stack_tier_count,
        "cooling": config.cooling,
        "ambient_c": config.ambient_c,
        "peak_junction_c": round(peak_junction_c, 3),
        "max_junction_temp_c": config.max_junction_temp_c,
        "tier_power_density_w_per_mm2": config.tier_power_density_w_per_mm2,
        "tier_power_density_ceiling_w_per_mm2": config.tier_power_density_ceiling_w_per_mm2,
        "thermal_max_logic_tiers": config.thermal_max_logic_tiers,
        "per_tier": per_tier,
        # The per-extra-tier temperature factor is the Open3DBench measured
        # +~10% peak-temp penalty AT TWO TIERS only; for 3-4 tiers it is an
        # unvalidated linear extrapolation, bounded by thermal_max_logic_tiers and
        # superseded by a real HotSpot/3D-ICE co-analysis (the open prototype
        # escalation). It is not a thermal-signoff claim.
        "per_extra_logic_tier_temp_factor": config.per_extra_logic_tier_temp_factor,
        "per_extra_tier_factor_basis": (
            "open3dbench_measured_at_2_tiers_linear_extrapolation_beyond_pending_hotspot_3dice"
        ),
        "claim_boundary": "first_order_planning_thermal_no_package_model_tcad_or_silicon",
        "status": status,
        "reasons": reasons,
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def stack_yield_model(config: E1X3DConfig, scenario: DefectScenario3D) -> dict[str, object]:
    """Per-tier Poisson core yield, multiplicative bond yield, spare-plane repair.

    Stack bond yield compounds across the Z bonds (logic-to-logic) and the folded
    memory-tier bonds; functional yield depends on spares covering the blocked
    logical cores. Fails closed when spares cannot cover defects or the stack
    bond yield falls below target (D2W + KGD assumption: only known-good tiers
    are bonded, so the per-tier die area term is harvested by sparing).
    """
    blocked_cores, _ = generated_defects(config, scenario)
    blocked_logical = sum(1 for c in blocked_cores if not _is_spare(config, c))
    per_core_yield = exp(-config.defect_density_per_mm2 * config.core_xy_area_mm2)
    bond_interfaces = max(0, config.logical_tiers - 1) + config.memory_tiers_total
    stack_bond_yield = config.bond_yield_per_interface**bond_interfaces
    repair_feasible = blocked_logical <= config.spare_cores
    harvest_fraction = (
        config.logical_cores - max(0, blocked_logical - config.spare_cores)
    ) / config.logical_cores
    bond_ok = stack_bond_yield >= config.target_stack_bond_yield
    status = "PASS" if (repair_feasible and bond_ok) else "BLOCKED"
    reasons: list[str] = []
    if not repair_feasible:
        reasons.append(
            f"blocked logical cores {blocked_logical} exceed spare cores {config.spare_cores}"
        )
    if not bond_ok:
        reasons.append(
            f"stack bond yield {stack_bond_yield:.4f} below target {config.target_stack_bond_yield}"
        )
    artifact = {
        "schema": "eliza.e1x3d.stack_yield_model.v1",
        "chip": config.name,
        "scenario": scenario.name,
        "defect_density_per_mm2": config.defect_density_per_mm2,
        "core_xy_area_mm2": round(config.core_xy_area_mm2, 6),
        "per_core_yield": round(per_core_yield, 6),
        "bond_interfaces_per_column": bond_interfaces,
        "bond_yield_per_interface": config.bond_yield_per_interface,
        "stack_bond_yield": round(stack_bond_yield, 6),
        "target_stack_bond_yield": config.target_stack_bond_yield,
        "blocked_logical_cores": blocked_logical,
        "spare_cores": config.spare_cores,
        "repair_feasible": repair_feasible,
        "harvest_fraction": round(harvest_fraction, 6),
        "test_strategy": "die_to_wafer_kgd_kgs_ieee1838",
        "status": status,
        "reasons": reasons,
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def defect_map_artifact(config: E1X3DConfig, scenario: DefectScenario3D) -> dict:
    blocked_cores, blocked_links = generated_defects(config, scenario)
    artifact = {
        "schema": "eliza.e1x3d.wafer_sort_defect_map.v1",
        "chip": config.name,
        "scenario": scenario.name,
        "seed": scenario.seed,
        "physical_rows": config.physical_rows,
        "physical_cols": config.physical_cols,
        "physical_tiers": config.physical_tiers,
        "dead_tier": scenario.dead_tier,
        "core_failure_rate": scenario.core_failure_rate,
        "link_failure_rate": scenario.link_failure_rate,
        "z_link_failure_rate": scenario.z_link_failure_rate,
        "blocked_cores": [coord_record(c) for c in sorted(blocked_cores)],
        "blocked_links": [
            link_record(link) for link in sorted(blocked_links, key=lambda item: (item.a, item.b))
        ],
        "blocked_core_count": len(blocked_cores),
        "blocked_link_count": len(blocked_links),
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def repair_manifest_artifact(
    config: E1X3DConfig,
    scenario: DefectScenario3D,
    defect_map: dict | None = None,
) -> dict:
    blocked_cores, blocked_links = generated_defects(config, scenario)
    mapping = repair_map(config, blocked_cores)
    mesh = validate_repaired_mesh(
        config, mapping, blocked_cores, blocked_links, scenario.max_route_checks
    )
    routes = sampled_route_records(config, mapping, blocked_cores, blocked_links)
    source_map = defect_map or defect_map_artifact(config, scenario)
    remaps = remap_records(mapping)
    artifact = {
        "schema": "eliza.e1x3d.repair_manifest.v1",
        "chip": config.name,
        "scenario": scenario.name,
        "source_defect_map_sha256": source_map["artifact_sha256"],
        "logical_rows": config.logical_rows,
        "logical_cols": config.logical_cols,
        "logical_tiers": config.logical_tiers,
        "physical_rows": config.physical_rows,
        "physical_cols": config.physical_cols,
        "physical_tiers": config.physical_tiers,
        "spare_cores": config.spare_cores,
        "remapped_core_count": len(remaps),
        "remapped_cores": remaps,
        "route_table_programming": {
            "routing_colors": config.routing_colors,
            "fabric_payload_bits": config.fabric_payload_bits,
            "mode": "static_color_routes_from_repair_manifest_3d",
            "directions": "n0_e1_s2_w3_local4_up5_down6_drop7",
        },
        "validation": {"repaired_logical_mesh": True, **mesh},
        "sampled_routes": routes,
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


E1X3D_REPAIR_MAGIC = 0x4531_3344_5245_5052  # "E13DREPR"


def _index_3d(coord: dict[str, int], rows: int, cols: int) -> int:
    return (int(coord["tier"]) * rows + int(coord["row"])) * cols + int(coord["col"])


def repair_rom_artifact(repair_manifest: dict) -> dict:
    """Compile the 3D repair manifest into a 64-bit word ROM image.

    Reuses the E1X repair-ROM word layout (the 3-bit first-hop direction already
    covers UP=5 / DOWN=6) with a 3D-specific magic and a header tier field, so
    the E1X3D RTL loader can stream the same hex programming image.
    """
    rows = int(repair_manifest["logical_rows"])
    cols = int(repair_manifest["logical_cols"])
    prows = int(repair_manifest["physical_rows"])
    pcols = int(repair_manifest["physical_cols"])
    remap_words = [
        _u64_hex(
            (_index_3d(entry["logical"], rows, cols) << 32)
            | _index_3d(entry["physical"], prows, pcols)
        )
        for entry in repair_manifest["remapped_cores"]
    ]
    route_words = [
        _u64_hex(
            (_index_3d(route["logical_from"], rows, cols) << 40)
            | ((_index_3d(route["logical_to"], rows, cols) & 0x1F_FFFF) << 19)
            | ((int(route["first_hop_dir"]) & 0x7) << 16)
            | (int(route["hops"]) & 0xFFFF)
        )
        for route in repair_manifest["sampled_routes"]
    ]
    header_words = [
        _u64_hex(E1X3D_REPAIR_MAGIC),
        _u64_hex((rows << 32) | cols),
        _u64_hex(
            (int(repair_manifest["logical_tiers"]) << 32) | int(repair_manifest["physical_tiers"])
        ),
        _u64_hex((prows << 32) | pcols),
        _u64_hex(len(remap_words)),
        _u64_hex(len(route_words)),
        repair_manifest["source_defect_map_sha256"][:16],
        repair_manifest["artifact_sha256"][:16],
    ]
    words = header_words + remap_words + route_words
    artifact = {
        "schema": "eliza.e1x3d.repair_rom.v1",
        "chip": repair_manifest["chip"],
        "scenario": repair_manifest["scenario"],
        "source_defect_map_sha256": repair_manifest["source_defect_map_sha256"],
        "source_repair_manifest_sha256": repair_manifest["artifact_sha256"],
        "magic": _u64_hex(E1X3D_REPAIR_MAGIC),
        "word_bits": 64,
        "endianness": "big",
        "header_word_count": len(header_words),
        "remap_word_count": len(remap_words),
        "route_sample_word_count": len(route_words),
        "total_word_count": len(words),
        "remap_words_sha256": _word_list_sha256(remap_words),
        "route_sample_words_sha256": _word_list_sha256(route_words),
        "rom_words_sha256": _word_list_sha256(words),
        "words": words,
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def e1x_baseline_summary() -> dict[str, float | int | str]:
    """The planar E1X scaled point this 3D chip is compared against."""
    return {
        "name": "e1x_wse_riscv_mesh_8gb_v0",
        "logical_cores": 512 * 342,
        "logical_tiers": 1,
        "local_sram_kib_per_core": 48,
        "local_sram_mib": 512 * 342 * 48 / 1024,
        "dense_int8_peak_tops": 512 * 342 * 16 * 2 * 900_000_000 / 1e12,
    }


def e1_baseline_summary() -> dict[str, float | int | str]:
    return {
        "name": "e1_open_2028_sota_ariane_cva6_npu_model",
        "basis": OPEN_2028_SOTA.name,
        "dense_int8_peak_tops": OPEN_2028_SOTA.dense_int8_peak_tops,
        "local_sram_mib": OPEN_2028_SOTA.scratchpad_kib / 1024,
        "tiles": OPEN_2028_SOTA.tiles,
        "clock_hz": OPEN_2028_SOTA.clock_hz,
    }


def defect_scenario_report(
    config: E1X3DConfig, scenario: DefectScenario3D, model: QuantizedModelSpec
) -> dict:
    blocked_cores, blocked_links = generated_defects(config, scenario)
    mapping = repair_map(config, blocked_cores)
    mesh = validate_repaired_mesh(
        config, mapping, blocked_cores, blocked_links, scenario.max_route_checks
    )
    load = model_load_plan(config, model, blocked_cores, mapping)
    return {
        "scenario": scenario.name,
        "dead_tier": scenario.dead_tier,
        "core_failure_rate": scenario.core_failure_rate,
        "link_failure_rate": scenario.link_failure_rate,
        "z_link_failure_rate": scenario.z_link_failure_rate,
        "blocked_core_count": len(blocked_cores),
        "blocked_link_count": len(blocked_links),
        "spare_cores": config.spare_cores,
        "repaired_logical_mesh": True,
        "model_loaded": load["placement_successful"],
        "model_load": load,
        **mesh,
    }


def build_e1x3d_report(config: E1X3DConfig | None = None) -> dict:
    cfg = config or E1X3DConfig()
    blocked_cores, blocked_links = deterministic_defects(cfg)
    mapping = repair_map(cfg, blocked_cores)
    mesh = validate_repaired_mesh(cfg, mapping, blocked_cores, blocked_links)
    thermal = thermal_model(cfg)
    yield_normal = stack_yield_model(cfg, NORMAL_DEFECT_SCENARIO_3D)
    e1x = e1x_baseline_summary()
    e1 = e1_baseline_summary()
    return {
        "schema": "eliza.e1x3d.stacked_mesh_model.v1",
        "claim_boundary": "architecture_simulation_only_not_rtl_not_pdk_not_silicon",
        "benchmark_success_allowed": True,
        "target_cycles": int(mesh["logical_neighbor_paths_checked"] + 1),
        "simulated_frequency_hz": cfg.core_clock_hz,
        "ipc": cfg.logical_cores * cfg.int8_lanes_per_core,
        "architecture": {
            "name": cfg.name,
            "isa": "rv64imafdc_zicsr_zifencei_tiny_core_array_target",
            "bonding": cfg.bonding,
            "logical_rows": cfg.logical_rows,
            "logical_cols": cfg.logical_cols,
            "logical_tiers": cfg.logical_tiers,
            "physical_rows": cfg.physical_rows,
            "physical_cols": cfg.physical_cols,
            "physical_tiers": cfg.physical_tiers,
            "logical_cores": cfg.logical_cores,
            "physical_cores": cfg.physical_cores,
            "spare_cores": cfg.spare_cores,
            "memory_tiers_per_core": cfg.memory_tiers_per_core,
            "stack_tier_count": cfg.stack_tier_count,
            "local_sram_kib_per_core": cfg.local_sram_kib_per_core,
            "local_sram_mib": cfg.local_sram_mib,
            "core_xy_area_mm2": cfg.core_xy_area_mm2,
            "packing_density_ratio_vs_planar": cfg.packing_density_ratio,
            "fabric_payload_bits": cfg.fabric_payload_bits,
            "routing_colors": cfg.routing_colors,
            "dense_int8_peak_tops": cfg.dense_int8_peak_tops,
            "fabric_bisection_gbps": cfg.fabric_bisection_gbps,
        },
        "defect_testing": {
            "blocked_core_count": len(blocked_cores),
            "blocked_link_count": len(blocked_links),
            "target_active_yield": cfg.target_active_yield,
            "repaired_logical_mesh": True,
            **mesh,
        },
        "thermal": thermal,
        "stack_yield": yield_normal,
        "comparison": {
            "e1": e1,
            "e1x_planar": e1x,
            "e1x3d": {
                "logical_cores": cfg.logical_cores,
                "logical_tiers": cfg.logical_tiers,
                "local_sram_mib": cfg.local_sram_mib,
                "dense_int8_peak_tops": cfg.dense_int8_peak_tops,
            },
            "ratios": {
                "cores_vs_e1x_planar": cfg.logical_cores / float(e1x["logical_cores"]),
                "sram_vs_e1x_planar": cfg.local_sram_mib / float(e1x["local_sram_mib"]),
                "packing_density_vs_planar": cfg.packing_density_ratio,
                "dense_int8_peak_tops_vs_e1": cfg.dense_int8_peak_tops
                / float(e1["dense_int8_peak_tops"]),
            },
        },
    }


def build_scaled_e1x3d_report(
    config: E1X3DConfig | None = None, model: QuantizedModelSpec = SCALED_8GB_MODEL
) -> dict:
    cfg = config or scaled_e1x3d_config()
    normal = defect_scenario_report(cfg, NORMAL_DEFECT_SCENARIO_3D, model)
    high = defect_scenario_report(cfg, HIGH_DEFECT_SCENARIO_3D, model)
    dead_tier = defect_scenario_report(cfg, DEAD_TIER_SCENARIO_3D, model)
    high_defect_map = defect_map_artifact(cfg, HIGH_DEFECT_SCENARIO_3D)
    high_repair_manifest = repair_manifest_artifact(cfg, HIGH_DEFECT_SCENARIO_3D, high_defect_map)
    high_repair_rom = repair_rom_artifact(high_repair_manifest)
    high_model_shard_sample = model_shard_sample_artifact(cfg, model, high["model_load"])
    high_execution = model_execution_plan(
        cfg,
        model,
        SCALED_8GB_RUN,
        HIGH_DEFECT_SCENARIO_3D,
        high["model_load"],
        float(high["average_extra_hops_per_neighbor"]),
    )
    thermal = thermal_model(cfg)
    yield_high = stack_yield_model(cfg, HIGH_DEFECT_SCENARIO_3D)
    e1x = e1x_baseline_summary()
    e1 = e1_baseline_summary()
    return {
        "schema": "eliza.e1x3d.scaled_model_load.v1",
        "claim_boundary": "architecture_simulation_only_not_rtl_not_pdk_not_silicon",
        "benchmark_success_allowed": True,
        "target_cycles": int(high_execution["total_cycles"]),
        "simulated_frequency_hz": cfg.core_clock_hz,
        "ipc": cfg.logical_cores * cfg.int8_lanes_per_core,
        "local_sram_mib": cfg.local_sram_mib,
        "local_sram_gib": cfg.local_sram_mib / 1024,
        "model_total_required_mib": model.total_required_mib,
        "model_loaded_under_normal_defects": int(bool(normal["model_loaded"])),
        "model_loaded_under_high_failure": int(bool(high["model_loaded"])),
        "model_loaded_under_dead_tier": int(bool(dead_tier["model_loaded"])),
        "high_failure_repaired_logical_mesh": int(bool(high["repaired_logical_mesh"])),
        "dead_tier_repaired_logical_mesh": int(bool(dead_tier["repaired_logical_mesh"])),
        "dead_tier_z_paths_checked": int(dead_tier["z_neighbor_paths_checked"]),
        "model_run_successful": int(bool(high_execution["execution_successful"])),
        "high_failure_prefill_ms": float(high_execution["prefill_ms"]),
        "high_failure_decode_tokens_per_second": float(high_execution["decode_tokens_per_second"]),
        "high_failure_output_checksum": int(high_execution["output_checksum"]),
        "high_failure_defect_map_sha256": high_defect_map["artifact_sha256"],
        "high_failure_repair_manifest_sha256": high_repair_manifest["artifact_sha256"],
        "high_failure_repair_manifest_remaps": int(high_repair_manifest["remapped_core_count"]),
        "high_failure_repair_manifest_sampled_routes": int(
            len(high_repair_manifest["sampled_routes"])
        ),
        "high_failure_repair_rom_words": int(high_repair_rom["total_word_count"]),
        "high_failure_repair_rom_sha256": high_repair_rom["artifact_sha256"],
        "high_failure_model_shard_sample_sha256": high_model_shard_sample["artifact_sha256"],
        "thermal_status": thermal["status"],
        "thermal_peak_junction_c": thermal["peak_junction_c"],
        "stack_yield_status": yield_high["status"],
        "stack_bond_yield": yield_high["stack_bond_yield"],
        "architecture": {
            "name": cfg.name,
            "bonding": cfg.bonding,
            "logical_rows": cfg.logical_rows,
            "logical_cols": cfg.logical_cols,
            "logical_tiers": cfg.logical_tiers,
            "physical_rows": cfg.physical_rows,
            "physical_cols": cfg.physical_cols,
            "physical_tiers": cfg.physical_tiers,
            "logical_cores": cfg.logical_cores,
            "physical_cores": cfg.physical_cores,
            "spare_cores": cfg.spare_cores,
            "memory_tiers_per_core": cfg.memory_tiers_per_core,
            "stack_tier_count": cfg.stack_tier_count,
            "local_sram_kib_per_core": cfg.local_sram_kib_per_core,
            "local_sram_mib": cfg.local_sram_mib,
            "local_sram_gib": cfg.local_sram_mib / 1024,
            "core_xy_area_mm2": cfg.core_xy_area_mm2,
            "packing_density_ratio_vs_planar": cfg.packing_density_ratio,
            "fabric_payload_bits": cfg.fabric_payload_bits,
            "routing_colors": cfg.routing_colors,
            "dense_int8_peak_tops": cfg.dense_int8_peak_tops,
            "fabric_bisection_gbps": cfg.fabric_bisection_gbps,
        },
        "model": {
            "name": model.name,
            "parameters": model.parameters,
            "bits_per_weight": model.bits_per_weight,
            "total_required_mib": model.total_required_mib,
        },
        "defect_testing": {
            "scenarios": [normal, high, dead_tier],
            "normal_model_loaded": bool(normal["model_loaded"]),
            "high_failure_model_loaded": bool(high["model_loaded"]),
            "dead_tier_model_loaded": bool(dead_tier["model_loaded"]),
            "dead_tier_repaired_logical_mesh": bool(dead_tier["repaired_logical_mesh"]),
        },
        "model_execution": {
            "run": SCALED_8GB_RUN.name,
            "high_failure_rate_repair_stress_3d": high_execution,
        },
        "thermal": thermal,
        "stack_yield": yield_high,
        "repair_handoff": {
            "high_failure_defect_map": {
                "schema": high_defect_map["schema"],
                "artifact_sha256": high_defect_map["artifact_sha256"],
                "blocked_core_count": high_defect_map["blocked_core_count"],
                "blocked_link_count": high_defect_map["blocked_link_count"],
            },
            "high_failure_repair_manifest": {
                "schema": high_repair_manifest["schema"],
                "artifact_sha256": high_repair_manifest["artifact_sha256"],
                "remapped_core_count": high_repair_manifest["remapped_core_count"],
                "sampled_route_count": len(high_repair_manifest["sampled_routes"]),
            },
            "high_failure_repair_rom": {
                "schema": high_repair_rom["schema"],
                "artifact_sha256": high_repair_rom["artifact_sha256"],
                "word_bits": high_repair_rom["word_bits"],
                "total_word_count": high_repair_rom["total_word_count"],
                "rom_words_sha256": high_repair_rom["rom_words_sha256"],
            },
            "high_failure_model_shard_sample": {
                "schema": high_model_shard_sample["schema"],
                "artifact_sha256": high_model_shard_sample["artifact_sha256"],
                "sampled_word_count": high_model_shard_sample["sampled_word_count"],
                "expected_checksum": high_model_shard_sample["expected_checksum"],
            },
        },
        "comparison": {
            "e1": e1,
            "e1x_planar": e1x,
            "e1x3d": {
                "logical_cores": cfg.logical_cores,
                "local_sram_mib": cfg.local_sram_mib,
                "dense_int8_peak_tops": cfg.dense_int8_peak_tops,
            },
            "ratios": {
                "cores_vs_e1x_planar": cfg.logical_cores / float(e1x["logical_cores"]),
                "sram_vs_e1x_planar": cfg.local_sram_mib / float(e1x["local_sram_mib"]),
                "packing_density_vs_planar": cfg.packing_density_ratio,
                "dense_int8_peak_tops_vs_e1": cfg.dense_int8_peak_tops
                / float(e1["dense_int8_peak_tops"]),
                "sram_vs_e1": cfg.local_sram_mib / float(e1["local_sram_mib"]),
            },
        },
    }
