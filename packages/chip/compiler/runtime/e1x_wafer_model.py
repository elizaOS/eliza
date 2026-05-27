from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from hashlib import blake2s
from math import ceil

from compiler.runtime.e1_npu_scale_model import OPEN_2028_SOTA


@dataclass(frozen=True)
class E1XConfig:
    name: str = "e1x_wse_riscv_mesh_v0"
    logical_rows: int = 32
    logical_cols: int = 32
    spare_rows: int = 2
    spare_cols: int = 2
    core_clock_hz: int = 900_000_000
    int8_lanes_per_core: int = 8
    local_sram_kib_per_core: int = 48
    fabric_payload_bits: int = 32
    routing_colors: int = 24
    link_bits_per_cycle_bidirectional: int = 64
    target_active_yield: float = 0.98
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
    def logical_cores(self) -> int:
        return self.logical_rows * self.logical_cols

    @property
    def physical_cores(self) -> int:
        return self.physical_rows * self.physical_cols

    @property
    def spare_cores(self) -> int:
        return self.physical_cores - self.logical_cores

    @property
    def dense_int8_peak_tops(self) -> float:
        return self.logical_cores * self.int8_lanes_per_core * 2 * self.core_clock_hz / 1e12

    @property
    def local_sram_mib(self) -> float:
        return self.logical_cores * self.local_sram_kib_per_core / 1024

    @property
    def fabric_bisection_gbps(self) -> float:
        cut_links = self.logical_rows
        return cut_links * self.link_bits_per_cycle_bidirectional * self.core_clock_hz / 1e9


@dataclass(frozen=True)
class DefectScenario:
    name: str
    core_failure_rate: float
    link_failure_rate: float
    seed: str
    max_route_checks: int | None = None


@dataclass(frozen=True)
class QuantizedModelSpec:
    name: str
    parameters: int
    bits_per_weight: int
    activation_mib: int
    runtime_mib: int
    metadata_mib: int

    @property
    def weight_bytes(self) -> int:
        return ceil(self.parameters * self.bits_per_weight / 8)

    @property
    def weight_mib(self) -> float:
        return self.weight_bytes / (1024 * 1024)

    @property
    def total_required_mib(self) -> float:
        return self.weight_mib + self.activation_mib + self.runtime_mib + self.metadata_mib


SCALED_8GB_MODEL = QuantizedModelSpec(
    name="e1x_llm_13b_w4a8_static_graph",
    parameters=13_000_000_000,
    bits_per_weight=4,
    activation_mib=512,
    runtime_mib=256,
    metadata_mib=96,
)

NORMAL_DEFECT_SCENARIO = DefectScenario(
    name="normal_wafer_sort",
    core_failure_rate=0.002,
    link_failure_rate=0.0005,
    seed="e1x-normal-v1",
    max_route_checks=4096,
)

HIGH_DEFECT_SCENARIO = DefectScenario(
    name="high_failure_rate_repair_stress",
    core_failure_rate=0.02,
    link_failure_rate=0.005,
    seed="e1x-high-failure-v1",
    max_route_checks=8192,
)


def scaled_8gb_config() -> E1XConfig:
    return E1XConfig(
        name="e1x_wse_riscv_mesh_8gb_v0",
        logical_rows=512,
        logical_cols=342,
        spare_rows=16,
        spare_cols=16,
        int8_lanes_per_core=16,
        local_sram_kib_per_core=48,
    )


@dataclass(frozen=True, order=True)
class Coord:
    row: int
    col: int


@dataclass(frozen=True)
class Link:
    a: Coord
    b: Coord

    def normalized(self) -> Link:
        return self if self.a <= self.b else Link(self.b, self.a)


@dataclass(frozen=True)
class Workload:
    name: str
    macs: int
    external_bytes: int
    local_bytes: int
    average_hops: int
    active_fraction: float


WORKLOADS = (
    Workload(
        name="mesh_gemm_tile_stream",
        macs=4096 * 4096 * 4096,
        external_bytes=4096 * 4096 * 3,
        local_bytes=4096 * 4096 * 24,
        average_hops=5,
        active_fraction=0.82,
    ),
    Workload(
        name="stencil_halo_exchange",
        macs=1024 * 1024 * 96,
        external_bytes=1024 * 1024 * 2,
        local_bytes=1024 * 1024 * 18,
        average_hops=1,
        active_fraction=0.91,
    ),
    Workload(
        name="sparse_attention_wavelets",
        macs=16 * 2048 * 2048 * 128,
        external_bytes=16 * 2048 * 128 * 3,
        local_bytes=16 * 2048 * 2048 * 8,
        average_hops=8,
        active_fraction=0.68,
    ),
)


def deterministic_defects(config: E1XConfig) -> tuple[set[Coord], set[Link]]:
    blocked_cores = {
        Coord(0, 7),
        Coord(3, 3),
        Coord(5, 19),
        Coord(9, 9),
        Coord(12, 23),
        Coord(16, 4),
        Coord(18, 30),
        Coord(25, 11),
        Coord(31, 31),
        Coord(33, 5),
    }
    blocked_cores = {
        coord
        for coord in blocked_cores
        if coord.row < config.physical_rows and coord.col < config.physical_cols
    }
    blocked_links = {
        Link(Coord(2, 2), Coord(2, 3)).normalized(),
        Link(Coord(7, 14), Coord(8, 14)).normalized(),
        Link(Coord(15, 15), Coord(15, 16)).normalized(),
        Link(Coord(22, 8), Coord(23, 8)).normalized(),
        Link(Coord(30, 29), Coord(30, 30)).normalized(),
    }
    blocked_links = {
        link
        for link in blocked_links
        if link.a.row < config.physical_rows
        and link.b.row < config.physical_rows
        and link.a.col < config.physical_cols
        and link.b.col < config.physical_cols
    }
    return blocked_cores, blocked_links


def _stable_fraction(parts: tuple[object, ...]) -> float:
    text = "|".join(str(part) for part in parts).encode()
    digest = blake2s(text, digest_size=8).digest()
    return int.from_bytes(digest, "big") / float(1 << 64)


def generated_defects(config: E1XConfig, scenario: DefectScenario) -> tuple[set[Coord], set[Link]]:
    blocked_cores = {
        coord
        for coord in physical_nodes(config)
        if _stable_fraction((scenario.seed, "core", coord.row, coord.col))
        < scenario.core_failure_rate
    }
    blocked_links: set[Link] = set()
    for coord in physical_nodes(config):
        for nxt in (Coord(coord.row + 1, coord.col), Coord(coord.row, coord.col + 1)):
            if nxt.row >= config.physical_rows or nxt.col >= config.physical_cols:
                continue
            if _stable_fraction(
                (scenario.seed, "link", coord.row, coord.col, nxt.row, nxt.col)
            ) < scenario.link_failure_rate:
                blocked_links.add(Link(coord, nxt).normalized())
    return blocked_cores, blocked_links


def physical_nodes(config: E1XConfig) -> list[Coord]:
    return [
        Coord(row, col)
        for row in range(config.physical_rows)
        for col in range(config.physical_cols)
    ]


def neighbors(config: E1XConfig, coord: Coord) -> list[Coord]:
    candidates = (
        Coord(coord.row - 1, coord.col),
        Coord(coord.row + 1, coord.col),
        Coord(coord.row, coord.col - 1),
        Coord(coord.row, coord.col + 1),
    )
    return [
        nxt
        for nxt in candidates
        if 0 <= nxt.row < config.physical_rows and 0 <= nxt.col < config.physical_cols
    ]


def repair_map(config: E1XConfig, blocked_cores: set[Coord]) -> dict[Coord, Coord]:
    spare_nodes = [
        node
        for node in physical_nodes(config)
        if node not in blocked_cores
        and (node.row >= config.logical_rows or node.col >= config.logical_cols)
    ]
    logical_blocked = [
        Coord(row, col)
        for row in range(config.logical_rows)
        for col in range(config.logical_cols)
        if Coord(row, col) in blocked_cores
    ]
    if len(spare_nodes) < len(logical_blocked):
        raise ValueError("not enough usable spare cores to repair logical mesh")
    mapping: dict[Coord, Coord] = {}
    used: set[Coord] = set()
    for row in range(config.logical_rows):
        for col in range(config.logical_cols):
            logical = Coord(row, col)
            if logical not in blocked_cores:
                mapping[logical] = logical
                used.add(logical)
                continue
            replacement = min(
                (node for node in spare_nodes if node not in used),
                key=lambda node: (abs(node.row - row) + abs(node.col - col), node.row, node.col),
            )
            mapping[logical] = replacement
            used.add(replacement)
    return mapping


def route(
    config: E1XConfig,
    start: Coord,
    goal: Coord,
    blocked_cores: set[Coord],
    blocked_links: set[Link],
) -> list[Coord]:
    if start in blocked_cores or goal in blocked_cores:
        raise ValueError("cannot route through a blocked endpoint")
    frontier: deque[Coord] = deque([start])
    previous: dict[Coord, Coord | None] = {start: None}
    while frontier:
        current = frontier.popleft()
        if current == goal:
            break
        for nxt in neighbors(config, current):
            if nxt in blocked_cores:
                continue
            if Link(current, nxt).normalized() in blocked_links:
                continue
            if nxt in previous:
                continue
            previous[nxt] = current
            frontier.append(nxt)
    if goal not in previous:
        raise ValueError(f"no repaired route from {start} to {goal}")
    path = [goal]
    while path[-1] != start:
        parent = previous[path[-1]]
        if parent is None:
            break
        path.append(parent)
    return list(reversed(path))


def validate_repaired_mesh(
    config: E1XConfig,
    mapping: dict[Coord, Coord],
    blocked_cores: set[Coord],
    blocked_links: set[Link],
    max_paths: int | None = None,
) -> dict[str, int | float]:
    logical_edges: list[tuple[Coord, Coord]] = []
    for row in range(config.logical_rows):
        for col in range(config.logical_cols):
            logical = Coord(row, col)
            for peer in (Coord(row + 1, col), Coord(row, col + 1)):
                if peer.row >= config.logical_rows or peer.col >= config.logical_cols:
                    continue
                logical_edges.append((logical, peer))
    if max_paths is not None and max_paths < len(logical_edges):
        step = max(1, len(logical_edges) // max_paths)
        logical_edges = logical_edges[::step][:max_paths]
    total_paths = 0
    extra_hops = 0
    max_path_hops = 0
    for logical, peer in logical_edges:
        path = route(config, mapping[logical], mapping[peer], blocked_cores, blocked_links)
        hops = len(path) - 1
        total_paths += 1
        extra_hops += max(0, hops - 1)
        max_path_hops = max(max_path_hops, hops)
    return {
        "logical_neighbor_paths_checked": total_paths,
        "logical_neighbor_paths_total": (
            config.logical_rows * (config.logical_cols - 1)
            + config.logical_cols * (config.logical_rows - 1)
        ),
        "route_check_mode": "sampled" if max_paths is not None else "exhaustive",
        "extra_repair_hops": extra_hops,
        "max_repaired_neighbor_hops": max_path_hops,
        "average_extra_hops_per_neighbor": extra_hops / total_paths,
    }


def workload_metrics(config: E1XConfig, workload: Workload, repair_hop_penalty: float) -> dict:
    active_ops_per_cycle = (
        config.logical_cores * config.int8_lanes_per_core * 2 * workload.active_fraction
    )
    compute_cycles = ceil(workload.macs * 2 / active_ops_per_cycle)
    fabric_bytes = workload.external_bytes + workload.local_bytes // 16
    fabric_cycles = ceil(
        fabric_bytes
        * (workload.average_hops + repair_hop_penalty)
        * 8
        / max(1, config.link_bits_per_cycle_bidirectional * config.logical_rows)
    )
    cycles = max(compute_cycles, fabric_cycles)
    elapsed_s = cycles / config.core_clock_hz
    observed_tops = workload.macs * 2 / elapsed_s / 1e12
    dynamic_nj = (
        workload.macs * 2 * config.energy_pj_per_int8_op
        + workload.local_bytes * config.local_sram_pj_per_byte
        + fabric_bytes
        * (workload.average_hops + repair_hop_penalty)
        * config.fabric_pj_per_byte_hop
    ) / 1000.0
    static_nj = (
        config.static_power_w_per_core
        * config.logical_cores
        * workload.active_fraction
        * elapsed_s
        * 1e9
    )
    energy_nj = dynamic_nj + static_nj
    average_power_w = energy_nj / 1e9 / elapsed_s
    return {
        "name": workload.name,
        "macs": workload.macs,
        "compute_cycles": compute_cycles,
        "fabric_cycles": fabric_cycles,
        "cycles": cycles,
        "observed_tops": observed_tops,
        "average_power_w": average_power_w,
        "tops_per_watt": observed_tops / average_power_w,
        "repair_hop_penalty": repair_hop_penalty,
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


def model_load_plan(
    config: E1XConfig,
    model: QuantizedModelSpec,
    blocked_cores: set[Coord],
    mapping: dict[Coord, Coord],
) -> dict[str, int | float | bool | str]:
    usable_logical_cores = sum(
        1 for physical in mapping.values() if physical not in blocked_cores
    )
    total_sram_mib = config.local_sram_mib
    reserved_mib = config.logical_cores * 4 / 1024
    usable_model_sram_mib = total_sram_mib - reserved_mib
    weight_shard_bytes = ceil(model.weight_bytes / usable_logical_cores)
    per_core_capacity_bytes = max(0, (config.local_sram_kib_per_core - 4) * 1024)
    load_wavelets = ceil(model.weight_bytes / (config.fabric_payload_bits // 8))
    placement_successful = (
        model.total_required_mib <= usable_model_sram_mib
        and weight_shard_bytes <= per_core_capacity_bytes
    )
    return {
        "model": model.name,
        "parameters": model.parameters,
        "bits_per_weight": model.bits_per_weight,
        "weight_mib": model.weight_mib,
        "activation_mib": model.activation_mib,
        "runtime_mib": model.runtime_mib,
        "metadata_mib": model.metadata_mib,
        "total_required_mib": model.total_required_mib,
        "total_sram_mib": total_sram_mib,
        "usable_model_sram_mib": usable_model_sram_mib,
        "reserved_runtime_mib": reserved_mib,
        "usable_logical_cores": usable_logical_cores,
        "weight_shard_bytes_per_core": weight_shard_bytes,
        "per_core_model_capacity_bytes": per_core_capacity_bytes,
        "fabric_load_wavelets": load_wavelets,
        "placement_successful": placement_successful,
        "load_mode": "resident_on_wafer_static_graph",
    }


def defect_scenario_report(
    config: E1XConfig,
    scenario: DefectScenario,
    model: QuantizedModelSpec,
) -> dict:
    blocked_cores, blocked_links = generated_defects(config, scenario)
    mapping = repair_map(config, blocked_cores)
    mesh = validate_repaired_mesh(
        config,
        mapping,
        blocked_cores,
        blocked_links,
        max_paths=scenario.max_route_checks,
    )
    load = model_load_plan(config, model, blocked_cores, mapping)
    return {
        "scenario": scenario.name,
        "core_failure_rate": scenario.core_failure_rate,
        "link_failure_rate": scenario.link_failure_rate,
        "blocked_core_count": len(blocked_cores),
        "blocked_link_count": len(blocked_links),
        "spare_cores": config.spare_cores,
        "repaired_logical_mesh": True,
        "model_loaded": load["placement_successful"],
        "model_load": load,
        **mesh,
    }


def build_scaled_8gb_report(
    config: E1XConfig | None = None,
    model: QuantizedModelSpec = SCALED_8GB_MODEL,
) -> dict:
    cfg = config or scaled_8gb_config()
    normal = defect_scenario_report(cfg, NORMAL_DEFECT_SCENARIO, model)
    high = defect_scenario_report(cfg, HIGH_DEFECT_SCENARIO, model)
    e1 = e1_baseline_summary()
    return {
        "schema": "eliza.e1x.scaled_model_load.v1",
        "claim_boundary": "architecture_simulation_only_not_rtl_not_pdk_not_silicon",
        "benchmark_success_allowed": True,
        "architecture": {
            "name": cfg.name,
            "logical_rows": cfg.logical_rows,
            "logical_cols": cfg.logical_cols,
            "physical_rows": cfg.physical_rows,
            "physical_cols": cfg.physical_cols,
            "logical_cores": cfg.logical_cores,
            "physical_cores": cfg.physical_cores,
            "spare_cores": cfg.spare_cores,
            "local_sram_kib_per_core": cfg.local_sram_kib_per_core,
            "local_sram_mib": cfg.local_sram_mib,
            "local_sram_gib": cfg.local_sram_mib / 1024,
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
            "scenarios": [normal, high],
            "normal_model_loaded": bool(normal["model_loaded"]),
            "high_failure_model_loaded": bool(high["model_loaded"]),
            "high_failure_repaired_logical_mesh": bool(high["repaired_logical_mesh"]),
        },
        "comparison": {
            "e1": e1,
            "e1x_scaled": {
                "dense_int8_peak_tops": cfg.dense_int8_peak_tops,
                "local_sram_mib": cfg.local_sram_mib,
                "logical_cores": cfg.logical_cores,
            },
            "ratios": {
                "dense_int8_peak_tops_vs_e1": cfg.dense_int8_peak_tops
                / float(e1["dense_int8_peak_tops"]),
                "local_sram_vs_e1": cfg.local_sram_mib / float(e1["local_sram_mib"]),
            },
        },
    }


def build_e1x_report(config: E1XConfig | None = None) -> dict:
    cfg = config or E1XConfig()
    blocked_cores, blocked_links = deterministic_defects(cfg)
    mapping = repair_map(cfg, blocked_cores)
    mesh = validate_repaired_mesh(cfg, mapping, blocked_cores, blocked_links)
    repair_hop_penalty = float(mesh["average_extra_hops_per_neighbor"])
    workloads = [workload_metrics(cfg, workload, repair_hop_penalty) for workload in WORKLOADS]
    min_tops = min(float(entry["observed_tops"]) for entry in workloads)
    worst_workload = max(workloads, key=lambda entry: int(entry["cycles"]))
    e1 = e1_baseline_summary()
    return {
        "schema": "eliza.e1x.wafer_mesh_model.v1",
        "claim_boundary": "architecture_simulation_only_not_rtl_not_pdk_not_silicon",
        "benchmark_success_allowed": True,
        "target_cycles": int(worst_workload["cycles"]),
        "simulated_frequency_hz": cfg.core_clock_hz,
        "ipc": cfg.logical_cores * cfg.int8_lanes_per_core,
        "architecture": {
            "name": cfg.name,
            "isa": "rv64imafdc_zicsr_zifencei_tiny_core_array_target",
            "logical_rows": cfg.logical_rows,
            "logical_cols": cfg.logical_cols,
            "physical_rows": cfg.physical_rows,
            "physical_cols": cfg.physical_cols,
            "logical_cores": cfg.logical_cores,
            "physical_cores": cfg.physical_cores,
            "spare_cores": cfg.spare_cores,
            "local_sram_kib_per_core": cfg.local_sram_kib_per_core,
            "local_sram_mib": cfg.local_sram_mib,
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
        "benchmarks": {
            "workloads": workloads,
            "min_observed_tops": min_tops,
            "max_observed_tops": max(float(entry["observed_tops"]) for entry in workloads),
            "min_tops_per_watt": min(float(entry["tops_per_watt"]) for entry in workloads),
        },
        "comparison": {
            "e1": e1,
            "e1x": {
                "dense_int8_peak_tops": cfg.dense_int8_peak_tops,
                "local_sram_mib": cfg.local_sram_mib,
                "logical_cores": cfg.logical_cores,
                "min_observed_tops": min_tops,
            },
            "ratios": {
                "dense_int8_peak_tops_vs_e1": cfg.dense_int8_peak_tops
                / float(e1["dense_int8_peak_tops"]),
                "local_sram_vs_e1": cfg.local_sram_mib / float(e1["local_sram_mib"]),
            },
        },
    }
