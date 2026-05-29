from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_graph_mapper import (  # noqa: E402
    MANIFEST_SCHEMA,
    PLACEMENT_SCHEMA,
    ManifestError,
    map_graph,
    parse_manifest,
    placement_to_model_spec,
    usable_bytes_per_core,
)
from compiler.runtime.e1x_wafer_model import (  # noqa: E402
    E1XConfig,
    build_real_graph_report,
    scaled_8gb_config,
)
from scripts.chip_utils import load_json_object  # noqa: E402

MANIFEST_PATH = ROOT / "benchmarks/models/llama13b-w4a8-manifest.json"


@pytest.fixture(scope="module")
def manifest_data() -> dict:
    return load_json_object(MANIFEST_PATH)


@pytest.fixture(scope="module")
def config() -> E1XConfig:
    return scaled_8gb_config()


def test_manifest_present_and_parses(manifest_data: dict) -> None:
    manifest = parse_manifest(manifest_data)
    assert manifest_data["schema"] == MANIFEST_SCHEMA
    assert manifest.architecture == "transformer_decoder"
    assert manifest.n_layers == 40
    assert manifest.d_model == 5120
    # embedding + 7 layers/block * 40 + output_norm + lm_head
    assert len(manifest.layers) == 1 + 7 * 40 + 1 + 1


def test_params_match_13b(manifest_data: dict) -> None:
    manifest = parse_manifest(manifest_data)
    # Standard 13B is ~13.0B params; assert within 1% of nominal 13e9.
    assert abs(manifest.total_parameters - 13_000_000_000) / 13e9 < 0.01


def test_placement_schema_and_every_layer_placed(manifest_data: dict, config: E1XConfig) -> None:
    manifest = parse_manifest(manifest_data)
    placement = map_graph(manifest, config)
    assert placement["schema"] == PLACEMENT_SCHEMA
    assert placement["layer_count"] == len(manifest.layers)
    layers = placement["layers"]
    assert len(layers) == len(manifest.layers)
    assert all(int(layer["assigned_cores"]) >= 1 for layer in layers)
    # core spans are contiguous and ordered
    expected = 0
    for layer in layers:
        assert int(layer["core_index_start"]) == expected
        expected = int(layer["core_index_end_exclusive"])
    assert expected == int(placement["cores_used"])


def test_sram_fit_and_capacity(manifest_data: dict, config: E1XConfig) -> None:
    manifest = parse_manifest(manifest_data)
    placement = map_graph(manifest, config)
    assert placement["sram_fit"] is True
    assert int(placement["cores_used"]) <= config.logical_cores
    assert float(placement["peak_core_occupancy"]) <= 1.0
    usable = usable_bytes_per_core(config)
    for layer in placement["layers"]:
        assert int(layer["max_core_shard_bytes"]) <= usable


def test_params_consistency(manifest_data: dict, config: E1XConfig) -> None:
    manifest = parse_manifest(manifest_data)
    placement = map_graph(manifest, config)
    assert int(placement["total_parameters"]) == manifest.total_parameters
    summed = sum(int(layer["parameters"]) for layer in placement["layers"])
    assert summed == manifest.total_parameters


def test_routing_colors_in_range(manifest_data: dict, config: E1XConfig) -> None:
    manifest = parse_manifest(manifest_data)
    placement = map_graph(manifest, config)
    for layer in placement["layers"]:
        assert 0 <= int(layer["routing_color"]) < config.routing_colors
    assert placement["routing_colors_used"] == list(range(config.routing_colors))


def test_deterministic(manifest_data: dict, config: E1XConfig) -> None:
    p1 = map_graph(parse_manifest(manifest_data), config)
    p2 = map_graph(parse_manifest(copy.deepcopy(manifest_data)), config)
    assert p1["artifact_sha256"] == p2["artifact_sha256"]
    assert p1 == p2


def test_wafer_consistency(manifest_data: dict, config: E1XConfig) -> None:
    manifest = parse_manifest(manifest_data)
    placement = map_graph(manifest, config)
    spec = placement_to_model_spec(
        manifest, placement, activation_mib=512, runtime_mib=256, metadata_mib=96
    )
    assert spec.parameters == manifest.total_parameters
    report = build_real_graph_report(placement, spec, config)
    assert report["placement_consistent_with_wafer_accounting"] is True
    assert report["mapper_sram_fit"] is True
    assert report["wafer_model_placement_successful"] is True
    assert report["model_loaded_under_high_failure"] == 1
    assert report["high_failure_repaired_logical_mesh"] == 1
    assert report["high_failure_model_run_successful"] == 1
    assert report["high_failure_output_checksum"] > 0
    high = report["model_execution_by_scenario"]["high_failure_rate_repair_stress"]
    assert high["golden_trace_match"] is True


def test_rejects_bad_schema(manifest_data: dict) -> None:
    bad = copy.deepcopy(manifest_data)
    bad["schema"] = "wrong.v9"
    with pytest.raises(ManifestError):
        parse_manifest(bad)


def test_rejects_unknown_layer_kind(manifest_data: dict) -> None:
    bad = copy.deepcopy(manifest_data)
    bad["layers"][1]["kind"] = "mystery_proj"
    with pytest.raises(ManifestError):
        parse_manifest(bad)


def test_rejects_block_count_mismatch(manifest_data: dict) -> None:
    bad = copy.deepcopy(manifest_data)
    bad["config"]["n_layers"] = 41
    with pytest.raises(ManifestError):
        parse_manifest(bad)


def test_rejects_oversized_row(manifest_data: dict, config: E1XConfig) -> None:
    bad = copy.deepcopy(manifest_data)
    # One output row of cols * weight_bits/8 that overflows the per-core budget.
    bad["layers"].append(
        {"name": "huge", "kind": "lm_head", "rows": 2, "cols": 10_000_000}
    )
    manifest = parse_manifest(bad)
    with pytest.raises(ManifestError):
        map_graph(manifest, config)


def test_graph_too_large_fails_closed(manifest_data: dict) -> None:
    manifest = parse_manifest(manifest_data)
    tiny = E1XConfig(name="tiny", logical_rows=2, logical_cols=2, spare_rows=0, spare_cols=0)
    with pytest.raises(ManifestError):
        map_graph(manifest, tiny)
