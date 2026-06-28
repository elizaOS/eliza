"""Tests for the E1 NPU MLPerf Inference harness (modeled, pre-silicon)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from benchmarks.mlperf.energy import (  # noqa: E402
    SCALE_CONFIGS,
    energy_block,
    modeled_energy_joules_per_inference,
)
from benchmarks.mlperf.loadgen import (  # noqa: E402
    LoadGenConfig,
    QueryResponse,
    QuerySample,
    Scenario,
    _percentile_nearest_rank,
    run_loadgen,
)
from benchmarks.mlperf.model import (  # noqa: E402
    build_dataset,
    macs_per_inference,
    reference_predict,
)
from benchmarks.mlperf.run_mlperf_inference import build_report  # noqa: E402
from benchmarks.mlperf.sut import E1NpuSut  # noqa: E402


def test_nearest_rank_percentile_matches_loadgen_convention() -> None:
    values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    assert _percentile_nearest_rank(values, 50.0) == 50
    assert _percentile_nearest_rank(values, 90.0) == 90
    assert _percentile_nearest_rank(values, 99.0) == 100


def test_single_stream_one_response_per_query() -> None:
    dataset = build_dataset(8)
    sut = E1NpuSut(dataset=dataset)
    result = run_loadgen(sut, LoadGenConfig(scenario=Scenario.SINGLE_STREAM, query_count=8))
    assert len(result.responses) == 8
    assert len(result.latencies_ns) == 8
    assert set(result.latency_percentiles_ns) == {"p50", "p90", "p99"}
    assert all(latency >= 0 for latency in result.latencies_ns)


def test_offline_returns_one_response_per_sample_and_reports_throughput() -> None:
    dataset = build_dataset(8)
    sut = E1NpuSut(dataset=dataset)
    result = run_loadgen(sut, LoadGenConfig(scenario=Scenario.OFFLINE, query_count=8))
    assert len(result.responses) == 8
    assert result.throughput_samples_per_second is not None
    assert result.throughput_samples_per_second > 0


def test_npu_sut_matches_reference_oracle() -> None:
    dataset = build_dataset(32)
    sut = E1NpuSut(dataset=dataset)
    responses = sut.issue_query([QuerySample(index=i) for i in range(32)])
    for response in responses:
        assert isinstance(response, QueryResponse)
        assert response.prediction == reference_predict(dataset[response.index].features)
    # Two GEMM_S8 NPU commands per inference were actually issued.
    assert sut.counters.npu_commands == 64
    assert sut.counters.npu_macs > 0


def test_sut_npu_mac_counter_matches_analytical_macs_per_inference() -> None:
    dataset = build_dataset(10)
    sut = E1NpuSut(dataset=dataset)
    sut.issue_query([QuerySample(index=i) for i in range(10)])
    assert sut.counters.npu_macs == macs_per_inference() * 10


def test_modeled_energy_is_positive_and_modeled_only() -> None:
    config = SCALE_CONFIGS["open_2028_first_50tops"]
    energy = modeled_energy_joules_per_inference(config)
    assert energy > 0
    block = energy_block(config, integration_window_seconds=0.01, sample_count=16)
    assert block["units"] == "J_per_inference"
    assert block["provenance"] == "simulator"
    assert block["calibration"]["status"] == "blocked-no-calibrated-assets"
    assert block["calibration"]["last_calibrated_utc"] is None


def test_report_is_self_consistent_and_fail_closed_on_power() -> None:
    report = build_report(query_count=16, config_name="open_2028_first_50tops")
    assert report["schema"] == "eliza.mlperf_inference.v1"
    assert (
        report["claim_boundary"]
        == "modeled_preSilicon_not_official_submission_and_not_measured_power"
    )
    scenarios = {s["scenario"] for s in report["scenarios"]}
    assert scenarios == {"SingleStream", "Offline"}
    for scenario in report["scenarios"]:
        assert scenario["accuracy"]["top1_accuracy"] == 1.0
        assert scenario["energy_joules_per_inference"]["value"] > 0
        assert scenario["npu_counters"]["npu_commands"] == scenario["query_count"] * 2
        assert (
            scenario["npu_counters"]["npu_macs"] == scenario["query_count"] * macs_per_inference()
        )
        assert scenario["observed_macs_per_inference"] == float(macs_per_inference())
    assert report["workload"]["macs_per_inference"] == macs_per_inference()
    assert report["summary"]["npu_macs_total"] == (
        len(report["scenarios"]) * 16 * macs_per_inference()
    )
    blocker_ids = {axis["blocker_id"] for axis in report["summary"]["blocked_axes"]}
    assert "mlperf-power-closed" in blocker_ids


def test_loadgen_rejects_invalid_config() -> None:
    with pytest.raises(ValueError):
        LoadGenConfig(scenario=Scenario.OFFLINE, query_count=0)
    with pytest.raises(ValueError):
        LoadGenConfig(scenario=Scenario.OFFLINE, query_count=4, percentiles=(0.0,))
