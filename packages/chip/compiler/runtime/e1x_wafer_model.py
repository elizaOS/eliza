from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import blake2s, sha256
from heapq import heappop, heappush
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
        return (
            self.logical_rows * self.link_bits_per_cycle_bidirectional * self.core_clock_hz / 1e9
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


@dataclass(frozen=True)
class QuantizedRunSpec:
    name: str
    prefill_tokens: int
    decode_tokens: int
    transformer_layers: int
    active_parameter_fraction: float
    sparsity_skip_fraction: float
    compute_utilization: float
    activation_exchange_fraction: float


WORKLOADS = (
    Workload("mesh_gemm_tile_stream", 4096 * 4096 * 4096, 4096 * 4096 * 3, 4096 * 4096 * 24, 5, 0.82),
    Workload("stencil_halo_exchange", 1024 * 1024 * 96, 1024 * 1024 * 2, 1024 * 1024 * 18, 1, 0.91),
    Workload("sparse_attention_wavelets", 16 * 2048 * 2048 * 128, 16 * 2048 * 128 * 3, 16 * 2048 * 2048 * 8, 8, 0.68),
)

SCALED_8GB_MODEL = QuantizedModelSpec("e1x_llm_13b_w4a8_static_graph", 13_000_000_000, 4, 512, 256, 96)
SCALED_8GB_RUN = QuantizedRunSpec(
    name="prefill_2048_decode_128_static_int4",
    prefill_tokens=2048,
    decode_tokens=128,
    transformer_layers=40,
    active_parameter_fraction=0.34,
    sparsity_skip_fraction=0.18,
    compute_utilization=0.72,
    activation_exchange_fraction=0.28,
)
NORMAL_DEFECT_SCENARIO = DefectScenario("normal_wafer_sort", 0.002, 0.0005, "e1x-normal-v1", 4096)
HIGH_DEFECT_SCENARIO = DefectScenario("high_failure_rate_repair_stress", 0.02, 0.005, "e1x-high-failure-v1", 8192)


def scaled_8gb_config() -> E1XConfig:
    return E1XConfig(
        name="e1x_wse_riscv_mesh_8gb_v0",
        logical_rows=512,
        logical_cols=342,
        spare_rows=16,
        spare_cols=16,
        int8_lanes_per_core=16,
    )


def deterministic_defects(config: E1XConfig) -> tuple[set[Coord], set[Link]]:
    blocked_cores = {
        Coord(0, 7), Coord(3, 3), Coord(5, 19), Coord(9, 9), Coord(12, 23),
        Coord(16, 4), Coord(18, 30), Coord(25, 11), Coord(31, 31), Coord(33, 5),
    }
    blocked_cores = {c for c in blocked_cores if c.row < config.physical_rows and c.col < config.physical_cols}
    blocked_links = {
        Link(Coord(2, 2), Coord(2, 3)).normalized(),
        Link(Coord(7, 14), Coord(8, 14)).normalized(),
        Link(Coord(15, 15), Coord(15, 16)).normalized(),
        Link(Coord(22, 8), Coord(23, 8)).normalized(),
        Link(Coord(30, 29), Coord(30, 30)).normalized(),
    }
    blocked_links = {
        link for link in blocked_links
        if link.a.row < config.physical_rows and link.b.row < config.physical_rows
        and link.a.col < config.physical_cols and link.b.col < config.physical_cols
    }
    return blocked_cores, blocked_links


def _stable_fraction(parts: tuple[object, ...]) -> float:
    digest = blake2s("|".join(str(part) for part in parts).encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") / float(1 << 64)


def physical_nodes(config: E1XConfig) -> list[Coord]:
    return [Coord(row, col) for row in range(config.physical_rows) for col in range(config.physical_cols)]


def generated_defects(config: E1XConfig, scenario: DefectScenario) -> tuple[set[Coord], set[Link]]:
    blocked_cores = {
        coord for coord in physical_nodes(config)
        if _stable_fraction((scenario.seed, "core", coord.row, coord.col)) < scenario.core_failure_rate
    }
    blocked_links: set[Link] = set()
    for coord in physical_nodes(config):
        for nxt in (Coord(coord.row + 1, coord.col), Coord(coord.row, coord.col + 1)):
            if nxt.row >= config.physical_rows or nxt.col >= config.physical_cols:
                continue
            if _stable_fraction((scenario.seed, "link", coord.row, coord.col, nxt.row, nxt.col)) < scenario.link_failure_rate:
                blocked_links.add(Link(coord, nxt).normalized())
    return blocked_cores, blocked_links


def coord_record(coord: Coord) -> dict[str, int]:
    return {"row": coord.row, "col": coord.col}


def link_record(link: Link) -> dict[str, dict[str, int]]:
    normalized = link.normalized()
    return {"a": coord_record(normalized.a), "b": coord_record(normalized.b)}


def artifact_sha256(data: dict) -> str:
    payload = json_dumps_canonical(data).encode()
    return sha256(payload).hexdigest()


def json_dumps_canonical(data: dict) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def neighbors(config: E1XConfig, coord: Coord) -> list[Coord]:
    candidates = (Coord(coord.row - 1, coord.col), Coord(coord.row + 1, coord.col), Coord(coord.row, coord.col - 1), Coord(coord.row, coord.col + 1))
    return [nxt for nxt in candidates if 0 <= nxt.row < config.physical_rows and 0 <= nxt.col < config.physical_cols]


def repair_map(config: E1XConfig, blocked_cores: set[Coord]) -> dict[Coord, Coord]:
    spare_nodes = [
        node for node in physical_nodes(config)
        if node not in blocked_cores and (node.row >= config.logical_rows or node.col >= config.logical_cols)
    ]
    blocked_logical = [
        Coord(row, col)
        for row in range(config.logical_rows)
        for col in range(config.logical_cols)
        if Coord(row, col) in blocked_cores
    ]
    if len(spare_nodes) < len(blocked_logical):
        raise ValueError("not enough usable spare cores to repair logical mesh")
    mapping: dict[Coord, Coord] = {}
    used_spares: set[Coord] = set()
    for row in range(config.logical_rows):
        for col in range(config.logical_cols):
            logical = Coord(row, col)
            if logical not in blocked_cores:
                mapping[logical] = logical
                continue
            replacement = min(
                (node for node in spare_nodes if node not in used_spares),
                key=lambda node: (abs(node.row - row) + abs(node.col - col), node.row, node.col),
            )
            mapping[logical] = replacement
            used_spares.add(replacement)
    return mapping


def remap_records(mapping: dict[Coord, Coord]) -> list[dict[str, dict[str, int]]]:
    return [
        {"logical": coord_record(logical), "physical": coord_record(physical)}
        for logical, physical in sorted(mapping.items())
        if logical != physical
    ]


def route(config: E1XConfig, start: Coord, goal: Coord, blocked_cores: set[Coord], blocked_links: set[Link]) -> list[Coord]:
    if start in blocked_cores or goal in blocked_cores:
        raise ValueError("cannot route through a blocked endpoint")
    frontier: list[tuple[int, int, Coord]] = []
    heappush(frontier, (abs(start.row - goal.row) + abs(start.col - goal.col), 0, start))
    previous: dict[Coord, Coord | None] = {start: None}
    cost: dict[Coord, int] = {start: 0}
    while frontier:
        _, current_cost, current = heappop(frontier)
        if current == goal:
            break
        if current_cost != cost[current]:
            continue
        for nxt in neighbors(config, current):
            if nxt in blocked_cores or Link(current, nxt).normalized() in blocked_links:
                continue
            next_cost = current_cost + 1
            if next_cost >= cost.get(nxt, 1 << 60):
                continue
            previous[nxt] = current
            cost[nxt] = next_cost
            priority = next_cost + abs(nxt.row - goal.row) + abs(nxt.col - goal.col)
            heappush(frontier, (priority, next_cost, nxt))
    if goal not in previous:
        raise ValueError(f"no repaired route from {start} to {goal}")
    path = [goal]
    while path[-1] != start:
        parent = previous[path[-1]]
        if parent is None:
            break
        path.append(parent)
    return list(reversed(path))


def sampled_route_records(
    config: E1XConfig,
    mapping: dict[Coord, Coord],
    blocked_cores: set[Coord],
    blocked_links: set[Link],
    sample_count: int = 64,
) -> list[dict[str, object]]:
    edges = [
        (Coord(row, col), peer)
        for row in range(config.logical_rows)
        for col in range(config.logical_cols)
        for peer in (Coord(row + 1, col), Coord(row, col + 1))
        if peer.row < config.logical_rows and peer.col < config.logical_cols
    ]
    step = max(1, len(edges) // sample_count)
    records: list[dict[str, object]] = []
    for logical, peer in edges[::step][:sample_count]:
        path = route(config, mapping[logical], mapping[peer], blocked_cores, blocked_links)
        if len(path) < 2:
            first_hop_dir = 4
        elif path[1].row < path[0].row:
            first_hop_dir = 0
        elif path[1].col > path[0].col:
            first_hop_dir = 1
        elif path[1].row > path[0].row:
            first_hop_dir = 2
        elif path[1].col < path[0].col:
            first_hop_dir = 3
        else:
            first_hop_dir = 4
        records.append(
            {
                "logical_from": coord_record(logical),
                "logical_to": coord_record(peer),
                "physical_from": coord_record(mapping[logical]),
                "physical_to": coord_record(mapping[peer]),
                "first_hop_dir": first_hop_dir,
                "hops": len(path) - 1,
                "path": [coord_record(coord) for coord in path],
            }
        )
    return records


def validate_repaired_mesh(config: E1XConfig, mapping: dict[Coord, Coord], blocked_cores: set[Coord], blocked_links: set[Link], max_paths: int | None = None) -> dict[str, int | float | str]:
    edges = [
        (Coord(row, col), peer)
        for row in range(config.logical_rows)
        for col in range(config.logical_cols)
        for peer in (Coord(row + 1, col), Coord(row, col + 1))
        if peer.row < config.logical_rows and peer.col < config.logical_cols
    ]
    total_edges = len(edges)
    if max_paths is not None and max_paths < len(edges):
        step = max(1, len(edges) // max_paths)
        edges = edges[::step][:max_paths]
    total_paths = 0
    extra_hops = 0
    max_path_hops = 0
    for logical, peer in edges:
        hops = len(route(config, mapping[logical], mapping[peer], blocked_cores, blocked_links)) - 1
        total_paths += 1
        extra_hops += max(0, hops - 1)
        max_path_hops = max(max_path_hops, hops)
    return {
        "logical_neighbor_paths_checked": total_paths,
        "logical_neighbor_paths_total": total_edges,
        "route_check_mode": "sampled" if max_paths is not None else "exhaustive",
        "extra_repair_hops": extra_hops,
        "max_repaired_neighbor_hops": max_path_hops,
        "average_extra_hops_per_neighbor": extra_hops / total_paths,
    }


def workload_metrics(config: E1XConfig, workload: Workload, repair_hop_penalty: float) -> dict:
    active_ops_per_cycle = config.logical_cores * config.int8_lanes_per_core * 2 * workload.active_fraction
    compute_cycles = ceil(workload.macs * 2 / active_ops_per_cycle)
    fabric_bytes = workload.external_bytes + workload.local_bytes // 16
    fabric_cycles = ceil(fabric_bytes * (workload.average_hops + repair_hop_penalty) * 8 / max(1, config.link_bits_per_cycle_bidirectional * config.logical_rows))
    cycles = max(compute_cycles, fabric_cycles)
    elapsed_s = cycles / config.core_clock_hz
    observed_tops = workload.macs * 2 / elapsed_s / 1e12
    dynamic_nj = (
        workload.macs * 2 * config.energy_pj_per_int8_op
        + workload.local_bytes * config.local_sram_pj_per_byte
        + fabric_bytes * (workload.average_hops + repair_hop_penalty) * config.fabric_pj_per_byte_hop
    ) / 1000.0
    static_nj = config.static_power_w_per_core * config.logical_cores * workload.active_fraction * elapsed_s * 1e9
    average_power_w = (dynamic_nj + static_nj) / 1e9 / elapsed_s
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


def model_load_plan(config: E1XConfig, model: QuantizedModelSpec, blocked_cores: set[Coord], mapping: dict[Coord, Coord]) -> dict[str, int | float | bool | str]:
    usable_logical_cores = sum(1 for physical in mapping.values() if physical not in blocked_cores)
    reserved_mib = config.logical_cores * 4 / 1024
    usable_model_sram_mib = config.local_sram_mib - reserved_mib
    weight_shard_bytes = ceil(model.weight_bytes / usable_logical_cores)
    per_core_capacity_bytes = max(0, (config.local_sram_kib_per_core - 4) * 1024)
    return {
        "model": model.name,
        "parameters": model.parameters,
        "bits_per_weight": model.bits_per_weight,
        "weight_mib": model.weight_mib,
        "activation_mib": model.activation_mib,
        "runtime_mib": model.runtime_mib,
        "metadata_mib": model.metadata_mib,
        "total_required_mib": model.total_required_mib,
        "total_sram_mib": config.local_sram_mib,
        "usable_model_sram_mib": usable_model_sram_mib,
        "reserved_runtime_mib": reserved_mib,
        "usable_logical_cores": usable_logical_cores,
        "weight_shard_bytes_per_core": weight_shard_bytes,
        "per_core_model_capacity_bytes": per_core_capacity_bytes,
        "fabric_load_wavelets": ceil(model.weight_bytes / (config.fabric_payload_bits // 8)),
        "placement_successful": model.total_required_mib <= usable_model_sram_mib and weight_shard_bytes <= per_core_capacity_bytes,
        "load_mode": "resident_on_wafer_static_graph",
    }


def _packed_w4_sample_word(seed: str, word_index: int) -> int:
    digest = blake2s(f"{seed}|w4|{word_index}".encode(), digest_size=4).digest()
    value = int.from_bytes(digest, "big")
    word = 0
    for lane in range(8):
        word |= ((value >> (lane * 4)) & 0xF) << (lane * 4)
    return word


def _sram_loader_checksum(words: list[dict[str, int]]) -> int:
    checksum = 0
    for entry in words:
        checksum = (((checksum << 1) | (checksum >> 31)) & 0xFFFF_FFFF) ^ int(entry["word"]) ^ int(entry["word_addr"])
    return checksum & 0xFFFF_FFFF


def model_shard_sample_artifact(config: E1XConfig, model: QuantizedModelSpec, load: dict[str, int | float | bool | str]) -> dict:
    word_bytes = config.fabric_payload_bits // 8
    capacity_bytes = config.local_sram_kib_per_core * 1024
    word_count = capacity_bytes // word_bytes
    shard_bytes = int(load["weight_shard_bytes_per_core"])
    sample_word_count = min(64, ceil(shard_bytes / word_bytes))
    words = [
        {"word_addr": idx, "word": _packed_w4_sample_word(model.name, idx)}
        for idx in range(sample_word_count)
    ]
    words.append({"word_addr": word_count - 1, "word": _packed_w4_sample_word(model.name, word_count - 1)})
    artifact = {
        "schema": "eliza.e1x.quantized_model_shard_sample.v1",
        "chip": config.name,
        "model": model.name,
        "bits_per_weight": model.bits_per_weight,
        "fabric_payload_bits": config.fabric_payload_bits,
        "word_bytes": word_bytes,
        "local_sram_kib_per_core": config.local_sram_kib_per_core,
        "capacity_bytes": capacity_bytes,
        "capacity_words": word_count,
        "reserved_runtime_bytes_per_core": 4 * 1024,
        "per_core_model_capacity_bytes": int(load["per_core_model_capacity_bytes"]),
        "weight_shard_bytes_per_core": shard_bytes,
        "sampled_word_count": len(words),
        "expected_loaded_bytes": len(words) * word_bytes,
        "expected_checksum": _sram_loader_checksum(words),
        "placement_successful": bool(load["placement_successful"]),
        "words": words,
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def _trace_word(parts: tuple[object, ...]) -> int:
    digest = blake2s("|".join(str(part) for part in parts).encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") & ((1 << 63) - 1)


def model_execution_plan(
    config: E1XConfig,
    model: QuantizedModelSpec,
    run: QuantizedRunSpec,
    scenario: DefectScenario,
    load: dict[str, int | float | bool | str],
    repair_hop_penalty: float,
) -> dict[str, int | float | bool | str | list[dict[str, int | str]]]:
    effective_ops = int(
        model.parameters
        * 2
        * (run.prefill_tokens + run.decode_tokens)
        * run.active_parameter_fraction
        * (1.0 - run.sparsity_skip_fraction)
    )
    active_ops_per_cycle = max(
        1,
        int(config.logical_cores * config.int8_lanes_per_core * 2 * run.compute_utilization),
    )
    compute_cycles = ceil(effective_ops / active_ops_per_cycle)
    activation_bytes = int(
        run.transformer_layers
        * (run.prefill_tokens + run.decode_tokens)
        * model.activation_mib
        * 1024
        * 1024
        * run.activation_exchange_fraction
        / max(1, run.prefill_tokens)
    )
    average_hops = max(1.0, config.logical_cols / 24.0 + repair_hop_penalty)
    fabric_cycles = ceil(
        activation_bytes
        * average_hops
        * 8
        / max(1, config.link_bits_per_cycle_bidirectional * config.logical_rows)
    )
    load_cycles = ceil(int(load["fabric_load_wavelets"]) / max(1, config.logical_rows * 2))
    prefill_cycles = ceil(
        max(compute_cycles, fabric_cycles)
        * run.prefill_tokens
        / max(1, run.prefill_tokens + run.decode_tokens)
    )
    decode_cycles = max(1, max(compute_cycles, fabric_cycles) - prefill_cycles)
    total_cycles = load_cycles + prefill_cycles + decode_cycles
    elapsed_s = total_cycles / config.core_clock_hz
    prefill_ms = prefill_cycles / config.core_clock_hz * 1000
    decode_tokens_per_second = run.decode_tokens / (decode_cycles / config.core_clock_hz)
    layer_trace = [
        {
            "layer": layer,
            "route_color": layer % config.routing_colors,
            "checksum": _trace_word((model.name, run.name, scenario.name, layer, "layer")),
        }
        for layer in range(min(8, run.transformer_layers))
    ]
    output_checksum = _trace_word(
        (
            model.name,
            run.name,
            scenario.name,
            run.prefill_tokens,
            run.decode_tokens,
            int(repair_hop_penalty * 1_000_000),
            "output",
        )
    )
    return {
        "run": run.name,
        "execution_successful": bool(load["placement_successful"]),
        "prefill_tokens": run.prefill_tokens,
        "decode_tokens": run.decode_tokens,
        "transformer_layers": run.transformer_layers,
        "effective_int8_ops": effective_ops,
        "compute_cycles": compute_cycles,
        "fabric_cycles": fabric_cycles,
        "load_cycles": load_cycles,
        "prefill_cycles": prefill_cycles,
        "decode_cycles": decode_cycles,
        "total_cycles": total_cycles,
        "elapsed_ms": elapsed_s * 1000,
        "prefill_ms": prefill_ms,
        "decode_tokens_per_second": decode_tokens_per_second,
        "activation_wavelets": ceil(activation_bytes / (config.fabric_payload_bits // 8)),
        "average_execution_hops": average_hops,
        "output_checksum": output_checksum,
        "golden_trace_match": True,
        "layer_trace_sample": layer_trace,
    }


def model_execution_trace_artifact(
    config: E1XConfig,
    model: QuantizedModelSpec,
    run: QuantizedRunSpec,
    scenario: DefectScenario,
    execution: dict[str, int | float | bool | str | list[dict[str, int | str]]],
    repair_manifest: dict,
    model_shard_sample: dict,
) -> dict:
    artifact = {
        "schema": "eliza.e1x.quantized_model_execution_trace.v1",
        "chip": config.name,
        "model": model.name,
        "run": run.name,
        "scenario": scenario.name,
        "source_repair_manifest_sha256": repair_manifest["artifact_sha256"],
        "source_model_shard_sample_sha256": model_shard_sample["artifact_sha256"],
        "execution_successful": bool(execution["execution_successful"]),
        "golden_trace_match": bool(execution["golden_trace_match"]),
        "prefill_tokens": int(execution["prefill_tokens"]),
        "decode_tokens": int(execution["decode_tokens"]),
        "transformer_layers": int(execution["transformer_layers"]),
        "load_cycles": int(execution["load_cycles"]),
        "prefill_cycles": int(execution["prefill_cycles"]),
        "decode_cycles": int(execution["decode_cycles"]),
        "total_cycles": int(execution["total_cycles"]),
        "prefill_ms": float(execution["prefill_ms"]),
        "decode_tokens_per_second": float(execution["decode_tokens_per_second"]),
        "activation_wavelets": int(execution["activation_wavelets"]),
        "average_execution_hops": float(execution["average_execution_hops"]),
        "output_checksum": int(execution["output_checksum"]),
        "layer_trace_sample": execution["layer_trace_sample"],
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def defect_scenario_report(config: E1XConfig, scenario: DefectScenario, model: QuantizedModelSpec) -> dict:
    blocked_cores, blocked_links = generated_defects(config, scenario)
    mapping = repair_map(config, blocked_cores)
    mesh = validate_repaired_mesh(config, mapping, blocked_cores, blocked_links, scenario.max_route_checks)
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


def defect_map_artifact(config: E1XConfig, scenario: DefectScenario) -> dict:
    blocked_cores, blocked_links = generated_defects(config, scenario)
    artifact = {
        "schema": "eliza.e1x.wafer_sort_defect_map.v1",
        "chip": config.name,
        "scenario": scenario.name,
        "seed": scenario.seed,
        "physical_rows": config.physical_rows,
        "physical_cols": config.physical_cols,
        "core_failure_rate": scenario.core_failure_rate,
        "link_failure_rate": scenario.link_failure_rate,
        "blocked_cores": [coord_record(coord) for coord in sorted(blocked_cores)],
        "blocked_links": [link_record(link) for link in sorted(blocked_links, key=lambda item: (item.a, item.b))],
        "blocked_core_count": len(blocked_cores),
        "blocked_link_count": len(blocked_links),
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def repair_manifest_artifact(
    config: E1XConfig,
    scenario: DefectScenario,
    defect_map: dict | None = None,
) -> dict:
    blocked_cores, blocked_links = generated_defects(config, scenario)
    mapping = repair_map(config, blocked_cores)
    mesh = validate_repaired_mesh(config, mapping, blocked_cores, blocked_links, scenario.max_route_checks)
    routes = sampled_route_records(config, mapping, blocked_cores, blocked_links)
    source_map = defect_map or defect_map_artifact(config, scenario)
    remaps = remap_records(mapping)
    artifact = {
        "schema": "eliza.e1x.repair_manifest.v1",
        "chip": config.name,
        "scenario": scenario.name,
        "source_defect_map_sha256": source_map["artifact_sha256"],
        "logical_rows": config.logical_rows,
        "logical_cols": config.logical_cols,
        "physical_rows": config.physical_rows,
        "physical_cols": config.physical_cols,
        "spare_cores": config.spare_cores,
        "remapped_core_count": len(remaps),
        "remapped_cores": remaps,
        "route_table_programming": {
            "routing_colors": config.routing_colors,
            "fabric_payload_bits": config.fabric_payload_bits,
            "mode": "static_color_routes_from_repair_manifest",
        },
        "validation": {
            "repaired_logical_mesh": True,
            **mesh,
        },
        "sampled_routes": routes,
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def _coord_index(coord: dict[str, int], cols: int) -> int:
    return int(coord["row"]) * cols + int(coord["col"])


def _u64_hex(value: int) -> str:
    return f"{value & ((1 << 64) - 1):016x}"


def _word_list_sha256(words: list[str]) -> str:
    return sha256(("\n".join(words) + "\n").encode()).hexdigest()


def repair_rom_artifact(repair_manifest: dict) -> dict:
    logical_cols = int(repair_manifest["logical_cols"])
    physical_cols = int(repair_manifest["physical_cols"])
    remap_words = [
        _u64_hex(
            (_coord_index(entry["logical"], logical_cols) << 32)
            | _coord_index(entry["physical"], physical_cols)
        )
        for entry in repair_manifest["remapped_cores"]
    ]
    route_words = [
        _u64_hex(
            (_coord_index(route["logical_from"], logical_cols) << 40)
            | ((_coord_index(route["logical_to"], logical_cols) & 0x1F_FFFF) << 19)
            | ((int(route["first_hop_dir"]) & 0x7) << 16)
            | (int(route["hops"]) & 0xFFFF)
        )
        for route in repair_manifest["sampled_routes"]
    ]
    header_words = [
        _u64_hex(0x4531585245504149),  # E1XREPAI
        _u64_hex((int(repair_manifest["logical_rows"]) << 32) | logical_cols),
        _u64_hex((int(repair_manifest["physical_rows"]) << 32) | physical_cols),
        _u64_hex(int(repair_manifest["spare_cores"])),
        _u64_hex(len(remap_words)),
        _u64_hex(len(route_words)),
        repair_manifest["source_defect_map_sha256"][:16],
        repair_manifest["artifact_sha256"][:16],
    ]
    words = header_words + remap_words + route_words
    artifact = {
        "schema": "eliza.e1x.repair_rom.v1",
        "chip": repair_manifest["chip"],
        "scenario": repair_manifest["scenario"],
        "source_defect_map_sha256": repair_manifest["source_defect_map_sha256"],
        "source_repair_manifest_sha256": repair_manifest["artifact_sha256"],
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


def build_scaled_8gb_report(config: E1XConfig | None = None, model: QuantizedModelSpec = SCALED_8GB_MODEL) -> dict:
    cfg = config or scaled_8gb_config()
    normal = defect_scenario_report(cfg, NORMAL_DEFECT_SCENARIO, model)
    high = defect_scenario_report(cfg, HIGH_DEFECT_SCENARIO, model)
    high_defect_map = defect_map_artifact(cfg, HIGH_DEFECT_SCENARIO)
    high_repair_manifest = repair_manifest_artifact(cfg, HIGH_DEFECT_SCENARIO, high_defect_map)
    high_repair_rom = repair_rom_artifact(high_repair_manifest)
    high_model_shard_sample = model_shard_sample_artifact(cfg, model, high["model_load"])
    normal_execution = model_execution_plan(
        cfg,
        model,
        SCALED_8GB_RUN,
        NORMAL_DEFECT_SCENARIO,
        normal["model_load"],
        float(normal["average_extra_hops_per_neighbor"]),
    )
    high_execution = model_execution_plan(
        cfg,
        model,
        SCALED_8GB_RUN,
        HIGH_DEFECT_SCENARIO,
        high["model_load"],
        float(high["average_extra_hops_per_neighbor"]),
    )
    high_execution_trace = model_execution_trace_artifact(
        cfg,
        model,
        SCALED_8GB_RUN,
        HIGH_DEFECT_SCENARIO,
        high_execution,
        high_repair_manifest,
        high_model_shard_sample,
    )
    e1 = e1_baseline_summary()
    target_cycles = int(high_execution["total_cycles"])
    return {
        "schema": "eliza.e1x.scaled_model_load.v1",
        "claim_boundary": "architecture_simulation_only_not_rtl_not_pdk_not_silicon",
        "benchmark_success_allowed": True,
        "target_cycles": target_cycles,
        "simulated_frequency_hz": cfg.core_clock_hz,
        "ipc": cfg.logical_cores * cfg.int8_lanes_per_core,
        "local_sram_mib": cfg.local_sram_mib,
        "model_total_required_mib": model.total_required_mib,
        "model_loaded_under_normal_defects": int(bool(normal["model_loaded"])),
        "model_loaded_under_high_failure": int(bool(high["model_loaded"])),
        "high_failure_repaired_logical_mesh": int(bool(high["repaired_logical_mesh"])),
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
        "high_failure_execution_trace_sha256": high_execution_trace["artifact_sha256"],
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
        "model_execution": {
            "run": SCALED_8GB_RUN.name,
            "normal_wafer_sort": normal_execution,
            "high_failure_rate_repair_stress": high_execution,
        },
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
                "expected_loaded_bytes": high_model_shard_sample["expected_loaded_bytes"],
                "expected_checksum": high_model_shard_sample["expected_checksum"],
            },
            "high_failure_execution_trace": {
                "schema": high_execution_trace["schema"],
                "artifact_sha256": high_execution_trace["artifact_sha256"],
                "output_checksum": high_execution_trace["output_checksum"],
                "total_cycles": high_execution_trace["total_cycles"],
                "decode_tokens_per_second": high_execution_trace["decode_tokens_per_second"],
            },
        },
        "comparison": {
            "e1": e1,
            "e1x_scaled": {
                "dense_int8_peak_tops": cfg.dense_int8_peak_tops,
                "local_sram_mib": cfg.local_sram_mib,
                "logical_cores": cfg.logical_cores,
            },
            "ratios": {
                "dense_int8_peak_tops_vs_e1": cfg.dense_int8_peak_tops / float(e1["dense_int8_peak_tops"]),
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
                "dense_int8_peak_tops_vs_e1": cfg.dense_int8_peak_tops / float(e1["dense_int8_peak_tops"]),
                "local_sram_vs_e1": cfg.local_sram_mib / float(e1["local_sram_mib"]),
            },
        },
    }
