"""
Tests for the canonical pipeline orchestrator.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import ModuleType

import pytest

try:
    import numpy
except ImportError:
    fake_numpy = ModuleType("numpy")
    fake_numpy.ndarray = object
    fake_numpy.float64 = float
    fake_numpy.int64 = int
    fake_numpy.bool_ = bool
    fake_numpy.number = (int, float)
    fake_numpy.object_ = object
    fake_numpy.array = lambda *args, **kwargs: list(args)
    fake_numpy.mean = lambda *_args, **_kwargs: 0.0
    fake_numpy.zeros = lambda *_args, **_kwargs: []
    fake_numpy.ones = lambda *_args, **_kwargs: []
    sys.modules["numpy"] = fake_numpy


sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import run_pipeline as run_pipeline_module
from run_pipeline import CanonicalPipeline, _find_ancestor_with_child


def test_find_ancestor_with_child_resolves_repo_and_workspace_roots(tmp_path: Path):
    workspace_root = tmp_path / "workspace"
    repo_root = workspace_root / "feed"
    script_dir = repo_root / "packages" / "training" / "python" / "scripts"
    script_dir.mkdir(parents=True)
    (repo_root / "packages" / "training").mkdir(parents=True, exist_ok=True)
    (workspace_root / "benchmarks" / "scambench").mkdir(parents=True)

    assert _find_ancestor_with_child(script_dir, "packages/training") == repo_root
    assert _find_ancestor_with_child(script_dir, "benchmarks") == workspace_root


def test_latest_scambench_report_ignores_transcripts_and_dossier(tmp_path: Path):
    pipeline = CanonicalPipeline(output_dir=str(tmp_path))
    output_dir = tmp_path / "scambench"
    output_dir.mkdir(parents=True)

    report_path = output_dir / "scambench-2026-03-25T12-47-42-971Z.json"
    (output_dir / "scambench-transcripts-trained-2026-03-25T12-47-42-971Z.json").write_text(
        "[]",
        encoding="utf-8",
    )
    (output_dir / "scambench-dossier-2026-03-25T12-47-42-971Z.json").write_text(
        "{}",
        encoding="utf-8",
    )
    report_path.write_text("[]", encoding="utf-8")

    assert pipeline._latest_scambench_report(output_dir) == report_path


@pytest.mark.asyncio
async def test_full_mode_sequences_pipeline_stages(tmp_path: Path):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path))
    steps: list[str] = []

    async def mark_sft() -> None:
        steps.append("sft")
        pipeline._set_stage(
            "sft",
            status="completed",
            lineage_model_name="Qwen/Qwen3.5-4B",
        )

    async def mark_served() -> None:
        steps.append("served_eval")
        pipeline._set_stage(
            "served_eval",
            status="completed",
            summary={
                "base_summary": {"avg_score": 0.8, "format_rate": 1.0},
                "trained_summary": {"avg_score": 0.95, "format_rate": 1.0},
                "comparison": {"avg_score_delta": 0.15, "distinct_response_count": 6},
            },
        )

    async def mark_rl() -> None:
        steps.append("rl")
        pipeline._set_stage(
            "rl",
            status="completed",
            lineage_model_name="Qwen/Qwen3.5-4B",
            legacy_artifact=False,
        )

    async def mark_rl_served_eval() -> None:
        steps.append("rl_served_eval")
        pipeline._set_stage(
            "rl_served_eval",
            status="completed",
            base_summary={"avg_score": 0.8, "format_rate": 1.0},
            trained_summary={"avg_score": 0.96, "format_rate": 1.0},
            comparison={"avg_score_delta": 0.16, "distinct_response_count": 6},
        )

    async def mark_scambench() -> None:
        steps.append("scambench")
        pipeline._set_stage(
            "scambench",
            status="completed",
            benchmark_source="rl_tinker_remote",
            comparison={
                "overall_score_delta": 1.2,
                "timeout_count_delta": 0,
                "handler_error_count_delta": 0,
            },
            fallback_errors=[],
        )

    pipeline.run_sft_stage = mark_sft  # type: ignore[method-assign]
    pipeline.run_served_eval_stage = mark_served  # type: ignore[method-assign]
    pipeline.run_rl_stage = mark_rl  # type: ignore[method-assign]
    pipeline.run_rl_served_eval_stage = mark_rl_served_eval  # type: ignore[method-assign]
    pipeline.run_scambench_stage = mark_scambench  # type: ignore[method-assign]

    result = await pipeline.run()

    assert steps == ["sft", "served_eval", "rl", "rl_served_eval", "scambench"]
    assert result["stages"]["rl"]["status"] == "completed"
    assert result["quality_gates"]["promotion_ready"] is True


@pytest.mark.asyncio
async def test_benchmark_mode_reuses_existing_sft_state(tmp_path: Path):
    pipeline = CanonicalPipeline(
        mode="benchmark",
        model_name="mlx-community/Qwen2.5-0.5B-Instruct-4bit",
        output_dir=str(tmp_path),
    )
    steps: list[str] = []

    fake_sft = type(
        "FakeSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "mlx",
            "training_base_model": "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
            "trained_model_path": tmp_path / "adapters",
            "training_artifact_path": tmp_path / "training_manifest.json",
            "training_export_error": "adapter export incomplete",
            "served_eval_path": None,
            "served_eval_summary": None,
        },
    )()

    def load_existing():
        return fake_sft

    async def mark_served() -> None:
        steps.append("served_eval")
        pipeline._set_stage("served_eval", status="completed")

    async def mark_scambench() -> None:
        steps.append("scambench")
        pipeline._set_stage("scambench", status="completed")

    pipeline._load_existing_sft_pipeline = load_existing  # type: ignore[method-assign]
    pipeline.run_served_eval_stage = mark_served  # type: ignore[method-assign]

    async def mark_rl_served_eval() -> None:
        steps.append("rl_served_eval")
        pipeline._set_stage("rl_served_eval", status="completed")

    pipeline.run_rl_served_eval_stage = mark_rl_served_eval  # type: ignore[method-assign]
    pipeline.run_scambench_stage = mark_scambench  # type: ignore[method-assign]

    result = await pipeline.run()

    assert result["stages"]["sft"]["status"] == "reused"
    assert result["stages"]["sft"]["training_export_error"] == "adapter export incomplete"
    assert result["stages"]["rl"]["status"] == "skipped"
    assert steps == ["served_eval", "rl_served_eval", "scambench"]


def test_failed_stage_alert_is_delivered_once(tmp_path: Path) -> None:
    deliveries: list[dict[str, object]] = []

    class AlertHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            deliveries.append(json.loads(body))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, format: str, *args: object) -> None:
            return None

    server = HTTPServer(("127.0.0.1", 0), AlertHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        pipeline = CanonicalPipeline(
            output_dir=str(tmp_path),
            alert_webhook_url=f"http://127.0.0.1:{server.server_port}/alerts",
        )

        pipeline._set_stage("sft", status="failed", reason="synthetic failure")
        pipeline._write_report()
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert len(deliveries) == 1
    assert deliveries[0]["event_key"] == "stage:sft:failed:synthetic failure"
    assert deliveries[0]["event"]["category"] == "stage"
    assert (
        pipeline.pipeline_report["alert_deliveries"]["stage:sft:failed:synthetic failure"]["status"]
        == "delivered"
    )
    assert (
        pipeline.pipeline_report["alert_deliveries"]["stage:sft:failed:synthetic failure"][
            "webhook_target"
        ]
        == f"http://127.0.0.1:{server.server_port}"
    )


@pytest.mark.asyncio
async def test_run_sft_stage_passes_local_export_source_dir(tmp_path: Path, monkeypatch):
    captured: dict[str, object] = {}

    class FakeFullPipeline:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.training_status = "trained"
            self.training_backend = "tinker"
            self.training_base_model = "Qwen/Qwen3-4B-Instruct-2507"
            self.training_remote_ref = "tinker://sft/final"
            self.training_remote_base_ref = "tinker://sft/base"
            self.training_remote_state_ref = "tinker://sft/state"
            self.trained_model_path = Path(kwargs["output_dir"]) / "tinker_trained"
            self.training_artifact_path = Path(kwargs["output_dir"]) / "training_manifest.json"
            self.training_export_archive_path = None
            self.training_export_dir = None
            self.validation_passed = None
            self.served_eval_path = None
            self.served_eval_summary = None
            self.generated_trajectories = []

        async def generate_data(self):
            return None

        async def score_trajectories(self):
            return None

        async def train_model(self):
            return None

    monkeypatch.setattr(run_pipeline_module, "FullPipeline", FakeFullPipeline)

    pipeline = CanonicalPipeline(
        mode="train",
        output_dir=str(tmp_path),
        training_backend="tinker",
        trajectory_source="local_export",
        source_dir="/tmp/scambench-export",
    )

    await pipeline.run_sft_stage()

    assert captured["trajectory_source"] == "local_export"
    assert captured["source_dir"] == "/tmp/scambench-export"


@pytest.mark.asyncio
async def test_run_sft_stage_passes_local_cuda_recipe_options(tmp_path: Path, monkeypatch):
    captured: dict[str, object] = {}

    class FakeFullPipeline:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.training_status = "trained"
            self.training_backend = "cuda"
            self.training_base_model = kwargs["local_training_model"]
            self.training_remote_ref = None
            self.training_remote_base_ref = None
            self.training_remote_state_ref = None
            self.trained_model_path = Path(kwargs["output_dir"]) / "trained"
            self.training_artifact_path = Path(kwargs["output_dir"]) / "training_manifest.json"
            self.training_metrics_path = Path(kwargs["output_dir"]) / "training_metrics.json"
            self.training_capacity_report_path = (
                Path(kwargs["output_dir"]) / "training_capacity_report.json"
            )
            self.training_export_error = "remote artifact export failed"
            self.training_export_archive_path = None
            self.training_export_dir = None
            self.validation_passed = True
            self.served_eval_path = None
            self.served_eval_summary = None
            self.generated_trajectories = [object()] * 10

        async def generate_data(self):
            return None

        async def score_trajectories(self):
            return None

        async def train_model(self):
            self.training_metrics_path.write_text("{}", encoding="utf-8")
            self.training_capacity_report_path.write_text("{}", encoding="utf-8")
            return None

    monkeypatch.setattr(run_pipeline_module, "FullPipeline", FakeFullPipeline)

    pipeline = CanonicalPipeline(
        mode="train",
        output_dir=str(tmp_path),
        training_backend="local",
        local_training_backend="cuda",
        local_training_model="Qwen/Qwen3.5-9B",
        local_training_sample_profile="canonical",
        local_training_optimizer="adamw",
        local_training_quantization="nf4",
        local_training_use_lora=True,
        local_training_lora_rank=32,
        local_training_lora_alpha=64,
        local_training_lora_dropout=0.05,
        local_training_lora_target_modules=["q_proj", "v_proj"],
        local_training_max_seq_length=4096,
        local_training_gradient_accumulation_steps=4,
        local_training_seed=19,
        local_training_eval_split_ratio=0.2,
    )

    await pipeline.run_sft_stage()

    assert captured["local_training_optimizer"] == "adamw"
    assert captured["local_training_quantization"] == "nf4"
    assert captured["local_training_use_lora"] is True
    assert captured["local_training_lora_rank"] == 32
    assert captured["local_training_lora_alpha"] == 64
    assert captured["local_training_lora_dropout"] == 0.05
    assert captured["local_training_lora_target_modules"] == ["q_proj", "v_proj"]
    assert captured["local_training_max_seq_length"] == 4096
    assert captured["local_training_gradient_accumulation_steps"] == 4
    assert captured["local_training_seed"] == 19
    assert captured["local_training_eval_split_ratio"] == 0.2
    assert pipeline.pipeline_report["stages"]["sft"]["training_export_error"] == (
        "remote artifact export failed"
    )
    assert pipeline.pipeline_report["artifacts"]["training_metrics"].endswith(
        "training_metrics.json"
    )
    assert pipeline.pipeline_report["artifacts"]["training_capacity_report"].endswith(
        "training_capacity_report.json"
    )


@pytest.mark.asyncio
async def test_benchmark_mode_reuses_existing_rl_stage(tmp_path: Path):
    pipeline = CanonicalPipeline(
        mode="benchmark",
        model_name="Qwen/Qwen3-4B-Instruct-2507",
        output_dir=str(tmp_path),
    )
    steps: list[str] = []

    fake_sft = type(
        "FakeSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3-4B-Instruct-2507",
            "trained_model_path": tmp_path / "tinker_trained" / "exported_adapter",
            "training_artifact_path": tmp_path / "training_manifest.json",
            "training_remote_ref": "tinker://sft/final",
            "training_remote_base_ref": "tinker://sft/base",
            "training_remote_state_ref": "tinker://sft/state",
            "served_eval_path": None,
            "served_eval_summary": None,
        },
    )()

    rl_dir = tmp_path / "rl"
    rl_dir.mkdir(parents=True)
    (rl_dir / "post_training_report.json").write_text(
        json.dumps(
            {
                "success": True,
                "base_model": "Qwen/Qwen3-4B-Instruct-2507",
                "initial_sampler_path": "tinker://rl/base",
                "final_sampler_path": "tinker://rl/final",
                "final_state_path": "tinker://rl/state",
                "downloaded_adapter_path": str(rl_dir / "tinker_trained" / "exported_adapter"),
                "metrics_file": str(rl_dir / "logs" / "training_metrics.jsonl"),
                "final_reward": 0.42,
                "final_metrics": {"avg_score_mean": 0.42},
                "selected_checkpoint_ref": "tinker://rl/selected",
                "selected_checkpoint_state_ref": "tinker://rl/state-selected",
                "selected_checkpoint_materialized_ref": "tinker://rl/materialized-selected",
                "selection_strategy": "deterministic_action_reason_eval",
                "selection_summary": {"avg_score": 0.61, "gate_passed": True},
            }
        ),
        encoding="utf-8",
    )

    def load_existing():
        return fake_sft

    async def mark_served() -> None:
        steps.append("served_eval")
        pipeline._set_stage("served_eval", status="completed")

    async def mark_scambench() -> None:
        steps.append("scambench")
        pipeline._set_stage("scambench", status="completed")

    pipeline._load_existing_sft_pipeline = load_existing  # type: ignore[method-assign]
    pipeline.run_served_eval_stage = mark_served  # type: ignore[method-assign]

    async def mark_rl_served_eval() -> None:
        steps.append("rl_served_eval")
        pipeline._set_stage("rl_served_eval", status="completed")

    pipeline.run_rl_served_eval_stage = mark_rl_served_eval  # type: ignore[method-assign]
    pipeline.run_scambench_stage = mark_scambench  # type: ignore[method-assign]

    result = await pipeline.run()

    assert result["stages"]["rl"]["status"] == "reused"
    assert result["stages"]["rl"]["remote_model_ref"] == "tinker://rl/final"
    assert result["stages"]["rl"]["final_reward"] == 0.42
    assert result["stages"]["rl"]["selected_checkpoint_ref"] == "tinker://rl/selected"
    assert result["stages"]["rl"]["selection_summary"]["avg_score"] == 0.61
    assert result["stages"]["rl"]["legacy_artifact"] is False
    assert result["stages"]["rl"]["provenance_status"] == "complete"
    assert steps == ["served_eval", "rl_served_eval", "scambench"]


@pytest.mark.asyncio
async def test_sft_stage_records_failure_reason(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path))

    class FakeFullPipeline:
        def __init__(self, *args, **kwargs):
            self.training_backend = "tinker"
            self.training_base_model = "Qwen/Qwen3.5-4B"
            self.generated_trajectories = []
            self.training_artifact_path = None
            self.training_remote_ref = None
            self.training_remote_base_ref = None
            self.training_remote_state_ref = None
            self.trained_model_path = None
            self.validation_passed = None

        async def generate_data(self):
            raise RuntimeError("Tinker billing blocked")

        async def score_trajectories(self):
            raise AssertionError("score_trajectories should not run")

        async def train_model(self):
            raise AssertionError("train_model should not run")

    monkeypatch.setattr("run_pipeline.FullPipeline", FakeFullPipeline)

    with pytest.raises(RuntimeError, match="billing blocked"):
        await pipeline.run_sft_stage()

    assert pipeline.pipeline_report["stages"]["sft"]["status"] == "failed"
    assert "billing blocked" in pipeline.pipeline_report["stages"]["sft"]["reason"]


@pytest.mark.asyncio
async def test_rl_stage_skips_when_environment_validation_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path))

    monkeypatch.setattr(
        "run_pipeline.validate_environment",
        lambda: ["CUDA not available"],
    )

    await pipeline.run_rl_stage()

    assert pipeline.pipeline_report["stages"]["rl"]["status"] == "skipped"
    assert "CUDA not available" in pipeline.pipeline_report["stages"]["rl"]["reason"]


@pytest.mark.asyncio
async def test_rl_stage_skips_after_prepare_only_sft(tmp_path: Path):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path))
    pipeline.sft_pipeline = type(
        "PreparedOnlySFTPipeline",
        (),
        {"training_status": "prepared_data"},
    )()

    await pipeline.run_rl_stage()

    assert pipeline.pipeline_report["stages"]["rl"]["status"] == "skipped"
    assert "prepare-only" in pipeline.pipeline_report["stages"]["rl"]["reason"]


@pytest.mark.asyncio
async def test_resolve_rl_model_prefers_materialized_sft_init(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path))

    monkeypatch.setattr(
        pipeline,
        "_resolve_sft_materialized_models",
        lambda: {
            "status": "available",
            "source": "sft_transformers_merged",
            "rl_init_model_path": str(tmp_path / "merged"),
        },
    )

    model_ref, init_source = pipeline._resolve_rl_model()

    assert model_ref == str(tmp_path / "merged")
    assert init_source == "sft_transformers_merged"


@pytest.mark.asyncio
async def test_scambench_stage_writes_comparison_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path), scambench_mode="full")

    monkeypatch.setattr(pipeline, "_ensure_scambench_available", lambda: None)
    monkeypatch.setattr(
        pipeline,
        "_benchmark_candidates",
        lambda: [
            {
                "source": "sft_transformers_merged",
                "family": "transformers",
                "baseline_model": "Qwen/Qwen3.5-4B",
                "trained_model": str(tmp_path / "merged"),
            }
        ],
    )

    def fake_run_candidate(
        candidate: dict[str, str], *, timeout_seconds: int | None = None
    ) -> dict[str, object]:
        assert candidate["source"] == "sft_transformers_merged"
        assert timeout_seconds is not None
        return {
            "generated_at": "2026-03-25T00:00:00+00:00",
            "benchmark_source": "sft_transformers_merged",
            "family": "transformers",
            "mode": "full",
            "scenario_limit": None,
            "baseline": {
                "overall_score": 45.0,
                "comply_decision_count": 1,
                "leaked_secret_count": 1,
                "operational_metrics": {
                    "timeout_count": 1,
                    "handler_error_count": 0,
                },
            },
            "trained": {
                "overall_score": 90.0,
                "comply_decision_count": 0,
                "leaked_secret_count": 0,
                "operational_metrics": {
                    "timeout_count": 0,
                    "handler_error_count": 0,
                },
            },
            "comparison": {
                "overall_score_delta": 45.0,
                "comply_decision_delta": -1,
                "leaked_secret_delta": -1,
                "timeout_count_delta": -1,
                "handler_error_count_delta": 0,
            },
        }

    monkeypatch.setattr(
        pipeline,
        "_run_served_scambench_candidate",
        fake_run_candidate,
    )

    await pipeline.run_scambench_stage()

    results_path = pipeline.run_dir / "scambench_results.json"
    assert results_path.exists()

    results = json.loads(results_path.read_text(encoding="utf-8"))
    assert results["comparison"]["overall_score_delta"] == 45.0
    assert results["comparison"]["comply_decision_delta"] == -1
    assert results["comparison"]["leaked_secret_delta"] == -1
    assert results["comparison"]["timeout_count_delta"] == -1
    assert pipeline.pipeline_report["stages"]["scambench"]["status"] == "completed"
    assert pipeline.pipeline_report["stages"]["scambench"]["mode"] == "full"
    assert (
        pipeline.pipeline_report["stages"]["scambench"]["baseline"]["operational_metrics"][
            "timeout_count"
        ]
        == 1
    )


@pytest.mark.asyncio
async def test_scambench_stage_falls_back_to_next_candidate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path), scambench_mode="full")
    monkeypatch.setattr(pipeline, "_ensure_scambench_available", lambda: None)
    monkeypatch.setattr(
        pipeline,
        "_benchmark_candidates",
        lambda: [
            {
                "source": "rl_final_model",
                "family": "transformers",
                "baseline_model": "Qwen/Qwen3.5-4B",
                "trained_model": str(tmp_path / "rl"),
            },
            {
                "source": "sft_mlx_fused",
                "family": "mlx",
                "baseline_model": "Qwen/Qwen3.5-4B",
                "trained_model": str(tmp_path / "fused"),
            },
        ],
    )

    def fake_run_candidate(
        candidate: dict[str, str], *, timeout_seconds: int | None = None
    ) -> dict[str, object]:
        if candidate["source"] == "rl_final_model":
            raise RuntimeError("vLLM failed to start")
        assert timeout_seconds is not None
        return {
            "generated_at": "2026-03-25T00:00:00+00:00",
            "benchmark_source": "sft_mlx_fused",
            "family": "mlx",
            "mode": "full",
            "scenario_limit": None,
            "baseline": {
                "overall_score": 60.0,
                "comply_decision_count": 1,
                "leaked_secret_count": 0,
            },
            "trained": {
                "overall_score": 80.0,
                "comply_decision_count": 0,
                "leaked_secret_count": 0,
            },
            "comparison": {
                "overall_score_delta": 20.0,
                "comply_decision_delta": -1,
                "leaked_secret_delta": 0,
            },
        }

    monkeypatch.setattr(
        pipeline,
        "_run_served_scambench_candidate",
        fake_run_candidate,
    )

    await pipeline.run_scambench_stage()

    results = json.loads((pipeline.run_dir / "scambench_results.json").read_text(encoding="utf-8"))
    assert results["benchmark_source"] == "sft_mlx_fused"
    assert results["fallback_errors"][0]["source"] == "rl_final_model"


@pytest.mark.asyncio
async def test_rl_served_eval_stage_records_timeout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    async def fake_wait_for(awaitable, timeout):
        awaitable.close()
        raise asyncio.TimeoutError

    monkeypatch.setattr("run_pipeline.asyncio.wait_for", fake_wait_for)

    async def fake_compare(**_kwargs):
        await asyncio.sleep(30)

    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        rl_served_eval_timeout_seconds=5,
    )
    pipeline.sft_pipeline = type(
        "SFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3.5-4B",
        },
    )()
    pipeline.pipeline_report["stages"]["rl"] = {
        "status": "completed",
        "remote_base_model_ref": "tinker://run/train/sampler_weights/000100",
        "remote_model_ref": "tinker://run/train/sampler_weights/000200",
    }

    with pytest.raises(RuntimeError, match="timed out"):
        await pipeline.run_rl_served_eval_stage()

    stage = pipeline.pipeline_report["stages"]["rl_served_eval"]
    assert stage["status"] == "timed_out"
    assert stage["timeout_seconds"] == 5
    assert stage["started_at"] is not None


@pytest.mark.asyncio
async def test_served_eval_stage_records_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    async def fake_wait_for(awaitable, timeout):
        awaitable.close()
        raise asyncio.TimeoutError

    async def fake_compare(**_kwargs):
        await asyncio.sleep(30)

    monkeypatch.setattr("run_pipeline.asyncio.wait_for", fake_wait_for)

    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        rl_served_eval_timeout_seconds=5,
    )
    pipeline.sft_pipeline = type(
        "TinkerSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3.5-4B",
            "served_eval_path": None,
            "served_eval_summary": None,
            "_run_served_comparison": staticmethod(fake_compare),
        },
    )()

    with pytest.raises(RuntimeError, match="timed out"):
        await pipeline.run_served_eval_stage()

    stage = pipeline.pipeline_report["stages"]["served_eval"]
    assert stage["status"] == "timed_out"
    assert stage["timeout_seconds"] == 5
    assert stage["started_at"] is not None


@pytest.mark.asyncio
async def test_scambench_stage_records_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    async def fake_wait_for(awaitable, timeout):
        awaitable.close()
        raise asyncio.TimeoutError

    monkeypatch.setattr("run_pipeline.asyncio.wait_for", fake_wait_for)

    pipeline = CanonicalPipeline(
        mode="benchmark",
        output_dir=str(tmp_path),
        scambench_mode="smoke",
        scambench_scenario_limit=2,
        scambench_timeout_seconds=7,
    )
    monkeypatch.setattr(pipeline, "_ensure_scambench_available", lambda: None)
    monkeypatch.setattr(
        pipeline,
        "_benchmark_candidates",
        lambda: [
            {
                "source": "tinker_remote",
                "family": "openai_compatible",
                "baseline_model": "tinker://run/train/sampler_weights/000000",
                "trained_model": "tinker://run/train/sampler_weights/000012",
                "base_url": "https://tinker.example/api/v1",
                "api_key_env": "TINKER_API_KEY",
            }
        ],
    )

    with pytest.raises(RuntimeError, match="timed out"):
        await pipeline.run_scambench_stage()

    stage = pipeline.pipeline_report["stages"]["scambench"]
    assert stage["status"] == "timed_out"
    assert stage["mode"] == "smoke"
    assert stage["scenario_limit"] == 2
    assert stage["timeout_seconds"] == 7


@pytest.mark.asyncio
async def test_served_eval_stage_runs_tinker_remote_comparison(tmp_path: Path):
    async def fake_compare(**_kwargs):
        return {
            "status": "completed",
            "report_path": str(tmp_path / "served_eval_tinker.json"),
            "summary": {"comparison": {"adapter_wins": 5}},
        }

    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        training_backend="tinker",
    )
    pipeline.sft_pipeline = type(
        "TinkerSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3.5-4B",
            "training_remote_base_ref": "tinker://run/train/sampler_weights/000000",
            "training_remote_ref": "feed-remote-final",
            "trained_model_path": tmp_path / "tinker_trained",
            "served_eval_path": None,
            "served_eval_summary": None,
            "_run_served_comparison": staticmethod(fake_compare),
        },
    )()

    await pipeline.run_served_eval_stage()

    stage = pipeline.pipeline_report["stages"]["served_eval"]
    assert stage["status"] == "completed"
    assert stage["summary"]["comparison"]["adapter_wins"] == 5


@pytest.mark.asyncio
async def test_rl_served_eval_stage_runs_tinker_remote_comparison(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    captured: dict[str, object] = {}

    def fake_compare(**kwargs):
        captured["kwargs"] = kwargs
        return {
            "timestamp": "2026-03-25T00:00:00+00:00",
            "endpoint": "tinker_proxy",
            "base_model": {"summary": {"avg_score": 0.5}},
            "adapter_model": {"summary": {"avg_score": 0.9}},
            "comparison": {"adapter_wins": 6, "distinct_response_count": 6},
        }

    monkeypatch.setattr(
        "run_pipeline.generate_tinker_proxy_comparison_report",
        fake_compare,
    )

    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        training_backend="tinker",
    )
    pipeline.sft_pipeline = type(
        "TinkerSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3.5-4B",
        },
    )()
    pipeline.pipeline_report["stages"]["rl"] = {
        "status": "completed",
        "remote_base_model_ref": "tinker://run/train/sampler_weights/000100",
        "remote_model_ref": "tinker://run/train/sampler_weights/000200",
        "remote_state_ref": "tinker://run/train/state/000200",
        "final_model_path": str(tmp_path / "rl" / "downloaded_adapter"),
    }

    await pipeline.run_rl_served_eval_stage()

    stage = pipeline.pipeline_report["stages"]["rl_served_eval"]
    assert stage["status"] == "completed"
    assert stage["comparison"]["adapter_wins"] == 6
    assert stage["base_summary"]["avg_score"] == 0.5
    assert stage["trained_summary"]["avg_score"] == 0.9
    assert captured["kwargs"]["base_model_ref"] == "tinker://run/train/sampler_weights/000100"
    assert captured["kwargs"]["trained_model_ref"] == "tinker://run/train/sampler_weights/000200"
    assert "base_url" not in captured["kwargs"]
    assert (tmp_path / "runs" / pipeline.run_id / "rl_served_eval.json").exists()


def test_pipeline_writes_versioned_report_copy(tmp_path: Path):
    pipeline = CanonicalPipeline(output_dir=str(tmp_path))
    pipeline._set_stage("sft", status="completed")

    assert (tmp_path / "pipeline_report.json").exists()
    assert (tmp_path / "runs" / pipeline.run_id / "pipeline_report.json").exists()
    assert pipeline.pipeline_report["artifact_versions"] == {}
    assert pipeline.pipeline_report["quality_gates"]["promotion_ready"] is False


def test_quality_gates_require_thresholded_metrics(tmp_path: Path):
    pipeline = CanonicalPipeline(output_dir=str(tmp_path))
    pipeline.pipeline_report["stages"]["sft"] = {
        "status": "completed",
        "lineage_model_name": "Qwen/Qwen3.5-4B",
    }
    pipeline.pipeline_report["stages"]["served_eval"] = {
        "status": "completed",
        "summary": {
            "base_summary": {"avg_score": 0.95, "format_rate": 1.0},
            "trained_summary": {"avg_score": 0.95, "format_rate": 1.0},
            "comparison": {"avg_score_delta": 0.0, "distinct_response_count": 4},
        },
    }
    pipeline.pipeline_report["stages"]["rl"] = {
        "status": "completed",
        "lineage_model_name": "Qwen/Qwen3.5-4B",
        "legacy_artifact": False,
    }
    pipeline.pipeline_report["stages"]["rl_served_eval"] = {
        "status": "completed",
        "base_summary": {"avg_score": 0.95, "format_rate": 1.0},
        "trained_summary": {"avg_score": 0.95, "format_rate": 1.0},
        "comparison": {"avg_score_delta": 0.0, "distinct_response_count": 4},
    }
    pipeline.pipeline_report["stages"]["scambench"] = {
        "status": "completed",
        "comparison": {
            "overall_score_delta": 0.25,
            "timeout_count_delta": 0,
            "handler_error_count_delta": 0,
        },
        "fallback_errors": [],
    }

    pipeline._write_report()

    gates = pipeline.pipeline_report["quality_gates"]
    assert gates["served_eval"]["sft"]["passed"] is False
    assert "avg_score_delta_below_threshold" in gates["served_eval"]["sft"]["blocking_reasons"]
    assert gates["scambench"]["passed"] is False
    assert "overall_score_delta_below_threshold" in gates["scambench"]["blocking_reasons"]
    assert gates["promotion_ready"] is False


def test_quality_gates_warn_on_reused_lineage_mismatch(tmp_path: Path):
    pipeline = CanonicalPipeline(
        mode="benchmark",
        model_name="Qwen/Qwen3.5-4B",
        output_dir=str(tmp_path),
    )
    pipeline.pipeline_report["stages"]["sft"] = {
        "status": "reused",
        "lineage_model_name": "Qwen/Qwen3-4B-Instruct-2507",
    }
    pipeline.pipeline_report["stages"]["served_eval"] = {
        "status": "completed",
        "summary": {
            "base_summary": {"avg_score": 0.8, "format_rate": 1.0},
            "trained_summary": {"avg_score": 0.95, "format_rate": 1.0},
            "comparison": {"avg_score_delta": 0.15, "distinct_response_count": 6},
        },
    }
    pipeline.pipeline_report["stages"]["rl"] = {
        "status": "reused",
        "lineage_model_name": "Qwen/Qwen3-4B-Instruct-2507",
        "legacy_artifact": False,
    }
    pipeline.pipeline_report["stages"]["rl_served_eval"] = {
        "status": "completed",
        "base_summary": {"avg_score": 0.8, "format_rate": 1.0},
        "trained_summary": {"avg_score": 0.95, "format_rate": 1.0},
        "comparison": {"avg_score_delta": 0.15, "distinct_response_count": 6},
    }
    pipeline.pipeline_report["stages"]["scambench"] = {
        "status": "completed",
        "comparison": {
            "overall_score_delta": 1.0,
            "timeout_count_delta": 0,
            "handler_error_count_delta": 0,
        },
        "fallback_errors": [],
    }

    pipeline._write_report()

    artifact_validation = pipeline.pipeline_report["quality_gates"]["artifact_validation"]
    assert artifact_validation["passed"] is False
    assert artifact_validation["sft_lineage_match"] is False
    assert artifact_validation["rl_lineage_match"] is False
    assert "does not match reused SFT lineage" in artifact_validation["warnings"][0]
    assert pipeline.pipeline_report["quality_gates"]["promotion_ready"] is False


@pytest.mark.asyncio
async def test_benchmark_mode_refuses_mismatched_reuse_by_default(tmp_path: Path):
    pipeline = CanonicalPipeline(
        mode="benchmark",
        model_name="Qwen/Qwen3.5-4B",
        output_dir=str(tmp_path),
    )
    steps: list[str] = []

    fake_sft = type(
        "FakeSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3-4B-Instruct-2507",
            "trained_model_path": tmp_path / "tinker_trained" / "exported_adapter",
            "training_artifact_path": tmp_path / "training_manifest.json",
            "training_remote_ref": "tinker://sft/final",
            "training_remote_base_ref": "tinker://sft/base",
            "training_remote_state_ref": "tinker://sft/state",
            "served_eval_path": None,
            "served_eval_summary": None,
        },
    )()

    pipeline._load_existing_sft_pipeline = lambda: fake_sft  # type: ignore[method-assign]

    async def mark_served() -> None:
        steps.append("served_eval")

    pipeline.run_served_eval_stage = mark_served  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="Benchmark reuse refused"):
        await pipeline.run()

    assert steps == []
    assert pipeline.pipeline_report["stages"]["sft"]["status"] == "reused"
    assert pipeline.pipeline_report["reuse_validation"]["status"] == "blocked"
    assert (
        pipeline.pipeline_report["quality_gates"]["artifact_validation"]["sft_lineage_match"]
        is False
    )


@pytest.mark.asyncio
async def test_benchmark_mode_allows_mismatched_reuse_with_override(tmp_path: Path):
    pipeline = CanonicalPipeline(
        mode="benchmark",
        model_name="Qwen/Qwen3.5-4B",
        output_dir=str(tmp_path),
        allow_mismatched_reuse=True,
    )
    steps: list[str] = []

    fake_sft = type(
        "FakeSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3-4B-Instruct-2507",
            "trained_model_path": tmp_path / "tinker_trained" / "exported_adapter",
            "training_artifact_path": tmp_path / "training_manifest.json",
            "training_remote_ref": "tinker://sft/final",
            "training_remote_base_ref": "tinker://sft/base",
            "training_remote_state_ref": "tinker://sft/state",
            "served_eval_path": None,
            "served_eval_summary": None,
        },
    )()

    pipeline._load_existing_sft_pipeline = lambda: fake_sft  # type: ignore[method-assign]

    async def mark_served() -> None:
        steps.append("served_eval")
        pipeline._set_stage("served_eval", status="completed")

    async def mark_rl_served_eval() -> None:
        steps.append("rl_served_eval")
        pipeline._set_stage("rl_served_eval", status="completed")

    async def mark_scambench() -> None:
        steps.append("scambench")
        pipeline._set_stage("scambench", status="completed")

    pipeline.run_served_eval_stage = mark_served  # type: ignore[method-assign]
    pipeline.run_rl_served_eval_stage = mark_rl_served_eval  # type: ignore[method-assign]
    pipeline.run_scambench_stage = mark_scambench  # type: ignore[method-assign]

    result = await pipeline.run()

    assert result["stages"]["sft"]["status"] == "reused"
    assert steps == ["served_eval", "rl_served_eval", "scambench"]


@pytest.mark.asyncio
async def test_benchmark_mode_refuses_legacy_rl_reuse(tmp_path: Path):
    pipeline = CanonicalPipeline(
        mode="benchmark",
        model_name="Qwen/Qwen3-4B-Instruct-2507",
        output_dir=str(tmp_path),
    )
    steps: list[str] = []

    fake_sft = type(
        "FakeSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3-4B-Instruct-2507",
            "trained_model_path": tmp_path / "tinker_trained" / "exported_adapter",
            "training_artifact_path": tmp_path / "training_manifest.json",
            "training_remote_ref": "tinker://sft/final",
            "training_remote_base_ref": "tinker://sft/base",
            "training_remote_state_ref": "tinker://sft/state",
            "served_eval_path": None,
            "served_eval_summary": None,
        },
    )()

    rl_dir = tmp_path / "rl"
    rl_dir.mkdir(parents=True)
    (rl_dir / "post_training_report.json").write_text(
        json.dumps(
            {
                "success": True,
                "base_model": "Qwen/Qwen3-4B-Instruct-2507",
                "initial_sampler_path": "tinker://rl/base",
                "final_sampler_path": "tinker://rl/final",
                "final_state_path": "tinker://rl/state",
                "final_reward": 0.4,
            }
        ),
        encoding="utf-8",
    )

    pipeline._load_existing_sft_pipeline = lambda: fake_sft  # type: ignore[method-assign]

    async def mark_served() -> None:
        steps.append("served_eval")
        pipeline._set_stage("served_eval", status="completed")

    pipeline.run_served_eval_stage = mark_served  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="predates checkpoint-selection metadata"):
        await pipeline.run()

    assert steps == ["served_eval"]
    assert pipeline.pipeline_report["reuse_validation"]["reason"] == "legacy_reused_rl_artifact"


def test_existing_artifact_root_ignores_report_only_runs_in_benchmark_mode(tmp_path: Path):
    output_root = tmp_path / "artifacts"
    output_root.mkdir(parents=True)
    (output_root / "training_manifest.json").write_text("{}", encoding="utf-8")

    report_only_run = output_root / "runs" / "20260325T000000.000000Z"
    report_only_run.mkdir(parents=True)
    (report_only_run / "pipeline_report.json").write_text("{}", encoding="utf-8")

    pipeline = CanonicalPipeline(mode="benchmark", output_dir=str(output_root))

    assert pipeline._existing_artifact_root() == output_root


def test_load_existing_rl_stage_marks_legacy_artifact_without_selection_metadata(tmp_path: Path):
    pipeline = CanonicalPipeline(mode="benchmark", output_dir=str(tmp_path))
    rl_dir = tmp_path / "rl"
    rl_dir.mkdir(parents=True)
    (rl_dir / "post_training_report.json").write_text(
        json.dumps(
            {
                "success": True,
                "base_model": "Qwen/Qwen3-4B-Instruct-2507",
                "initial_sampler_path": "tinker://rl/base",
                "final_sampler_path": "tinker://rl/final",
                "final_state_path": "tinker://rl/state",
                "final_reward": 0.4,
            }
        ),
        encoding="utf-8",
    )

    stage = pipeline._load_existing_rl_stage()

    assert stage is not None
    assert stage["legacy_artifact"] is True
    assert stage["provenance_status"] == "legacy_missing_selection_metadata"
    assert "checkpoint-selection metadata" in stage["warnings"][0]


def test_scambench_cli_args_reflect_resolved_mode(tmp_path: Path):
    smoke_pipeline = CanonicalPipeline(
        mode="benchmark",
        output_dir=str(tmp_path / "smoke"),
        scambench_mode="auto",
        scambench_scenario_limit=3,
    )
    full_pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path / "full"),
        scambench_mode="auto",
        scambench_scenario_limit=3,
    )

    assert smoke_pipeline._scambench_cli_args() == ["--scenario-limit", "3"]
    assert full_pipeline._scambench_cli_args() == []


@pytest.mark.asyncio
async def test_rl_stage_uses_tinker_orchestrator_when_backend_selected(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    captured: dict[str, object] = {}

    class FakeTinkerRLOrchestrator:
        def __init__(self, config):
            captured["config"] = config

        async def run(self):
            return {
                "report_path": str(tmp_path / "rl" / "post_training_report.json"),
                "metrics_file": str(tmp_path / "rl" / "logs" / "training_metrics.jsonl"),
                "downloaded_adapter_path": str(tmp_path / "rl" / "tinker_trained"),
                "initial_sampler_path": "tinker://run/train/sampler_weights/000100",
                "final_sampler_path": "tinker://run/train/sampler_weights/000200",
                "final_state_path": "tinker://run/train/state/000200",
                "final_reward": 0.82,
                "final_metrics": {"avg_score_mean": 0.81},
                "selected_checkpoint_ref": "tinker://run/train/sampler_weights/000150",
                "selected_checkpoint_state_ref": "tinker://run/train/state/000150",
                "selected_checkpoint_materialized_ref": "tinker://run/train/materialized/000150",
                "selection_strategy": "deterministic_action_reason_eval",
                "selection_summary": {"avg_score": 0.91, "gate_passed": True},
            }

    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr("run_pipeline.TinkerRLOrchestrator", FakeTinkerRLOrchestrator)

    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        training_backend="tinker",
        trajectory_source="huggingface",
        hf_dataset="elizaos/scambench-trajectories",
    )
    pipeline.sft_pipeline = type(
        "TinkerSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3.5-4B",
            "training_remote_ref": "tinker://run/train/sampler_weights/000050",
            "training_remote_state_ref": "tinker://run/train/state/000050",
        },
    )()

    await pipeline.run_rl_stage()

    config = captured["config"]
    assert config.resume_from_state == "tinker://run/train/state/000050"
    assert config.hf_dataset == "elizaos/scambench-trajectories"

    stage = pipeline.pipeline_report["stages"]["rl"]
    assert stage["status"] == "completed"
    assert stage["remote_model_ref"] == "tinker://run/train/sampler_weights/000200"
    assert stage["remote_state_ref"] == "tinker://run/train/state/000200"
    assert stage["final_reward"] == 0.82
    assert stage["selected_checkpoint_ref"] == "tinker://run/train/sampler_weights/000150"
    assert stage["selection_summary"]["avg_score"] == 0.91


@pytest.mark.asyncio
async def test_rl_stage_accepts_tm_api_key_alias(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captured: dict[str, object] = {}

    class FakeTinkerRLOrchestrator:
        def __init__(self, config):
            captured["config"] = config

        async def run(self):
            return {
                "report_path": str(tmp_path / "rl" / "post_training_report.json"),
                "metrics_file": str(tmp_path / "rl" / "logs" / "training_metrics.jsonl"),
                "downloaded_adapter_path": str(tmp_path / "rl" / "tinker_trained"),
                "initial_sampler_path": "tinker://run/train/sampler_weights/000100",
                "final_sampler_path": "tinker://run/train/sampler_weights/000200",
                "final_state_path": "tinker://run/train/state/000200",
                "final_reward": 0.73,
                "final_metrics": {"avg_score_mean": 0.72},
            }

    monkeypatch.delenv("TINKER_API_KEY", raising=False)
    monkeypatch.setenv("TM_API_KEY", "alias-key")
    monkeypatch.setattr("run_pipeline.TinkerRLOrchestrator", FakeTinkerRLOrchestrator)

    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        training_backend="tinker",
    )
    pipeline.sft_pipeline = type(
        "TinkerSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3.5-4B",
            "training_remote_ref": "tinker://run/train/sampler_weights/000050",
            "training_remote_state_ref": "tinker://run/train/state/000050",
        },
    )()

    await pipeline.run_rl_stage()

    assert captured["config"].resume_from_state == "tinker://run/train/state/000050"
    assert pipeline.pipeline_report["stages"]["rl"]["status"] == "completed"


@pytest.mark.asyncio
async def test_rl_stage_passes_local_export_source_dir_to_tinker_orchestrator(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    captured: dict[str, object] = {}

    class FakeTinkerRLOrchestrator:
        def __init__(self, config):
            captured["config"] = config

        async def run(self):
            return {
                "report_path": str(tmp_path / "rl" / "post_training_report.json"),
                "metrics_file": str(tmp_path / "rl" / "logs" / "training_metrics.jsonl"),
                "downloaded_adapter_path": str(tmp_path / "rl" / "tinker_trained"),
                "initial_sampler_path": "tinker://run/train/sampler_weights/000100",
                "final_sampler_path": "tinker://run/train/sampler_weights/000200",
                "final_state_path": "tinker://run/train/state/000200",
                "final_reward": 0.61,
                "final_metrics": {"avg_score_mean": 0.6},
            }

    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr("run_pipeline.TinkerRLOrchestrator", FakeTinkerRLOrchestrator)

    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        training_backend="tinker",
        trajectory_source="local_export",
        source_dir="/tmp/local-export",
    )
    pipeline.sft_pipeline = type(
        "TinkerSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_base_model": "Qwen/Qwen3.5-4B",
            "training_remote_ref": "tinker://run/train/sampler_weights/000050",
            "training_remote_state_ref": "tinker://run/train/state/000050",
        },
    )()

    await pipeline.run_rl_stage()

    config = captured["config"]
    assert config.trajectory_source == "local_export"
    assert config.source_dir == "/tmp/local-export"


@pytest.mark.asyncio
async def test_benchmark_candidates_include_tinker_remote(tmp_path: Path):
    pipeline = CanonicalPipeline(
        mode="full",
        output_dir=str(tmp_path),
        training_backend="tinker",
    )
    pipeline.sft_pipeline = type(
        "TinkerSFTPipeline",
        (),
        {
            "training_status": "trained",
            "training_backend": "tinker",
            "training_remote_base_ref": "tinker://run/train/sampler_weights/000000",
            "training_remote_ref": "tinker://run/train/sampler_weights/000012",
            "trained_model_path": tmp_path / "tinker_trained",
            "training_base_model": "Qwen/Qwen3.5-4B",
        },
    )()

    candidates = pipeline._benchmark_candidates()

    remote = next(candidate for candidate in candidates if candidate["source"] == "tinker_remote")
    assert remote["family"] == "openai_compatible"
    assert remote["baseline_model"] == "tinker://run/train/sampler_weights/000000"
    assert remote["trained_model"] == "tinker://run/train/sampler_weights/000012"


@pytest.mark.asyncio
async def test_benchmark_candidates_prefer_tinker_rl_remote(tmp_path: Path):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path))
    pipeline.pipeline_report["stages"]["rl"] = {
        "status": "completed",
        "remote_base_model_ref": "tinker://run/train/sampler_weights/000100",
        "remote_model_ref": "tinker://run/train/sampler_weights/000200",
    }

    candidates = pipeline._benchmark_candidates()

    assert candidates[0]["source"] == "rl_tinker_remote"
    assert candidates[0]["family"] == "openai_compatible"
    assert candidates[0]["trained_model"] == "tinker://run/train/sampler_weights/000200"


@pytest.mark.asyncio
async def test_scambench_candidate_uses_remote_openai_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    pipeline = CanonicalPipeline(mode="full", output_dir=str(tmp_path), scambench_mode="full")
    calls: list[tuple[str, str, str]] = []

    def fake_remote_target(
        *,
        label: str,
        model_ref: str,
        base_url: str,
        api_key_env: str,
        output_dir: Path,
        timeout_seconds: int | None = None,
    ):
        calls.append((label, model_ref, api_key_env))
        assert timeout_seconds is None
        score = 55.0 if label == "baseline" else 88.0
        return {
            "label": label,
            "decisions_path": str(output_dir / f"{label}.json"),
            "report_path": str(output_dir / f"{label}-report.json"),
            "overall_score": score,
            "scenarios_run": 4,
            "stage_decision_count": 10,
            "comply_decision_count": 1 if label == "baseline" else 0,
            "leaked_secret_count": 1 if label == "baseline" else 0,
            "operational_metrics": {
                "timeout_count": 2 if label == "baseline" else 0,
                "handler_error_count": 1 if label == "baseline" else 0,
            },
        }

    monkeypatch.setattr(pipeline, "_run_remote_scambench_target", fake_remote_target)

    result = pipeline._run_served_scambench_candidate(
        {
            "source": "tinker_remote",
            "family": "openai_compatible",
            "baseline_model": "tinker://run/train/sampler_weights/000000",
            "trained_model": "tinker://run/train/sampler_weights/000012",
            "base_url": "https://tinker.example/api/v1",
            "api_key_env": "TINKER_API_KEY",
        }
    )

    assert calls == [
        ("baseline", "tinker://run/train/sampler_weights/000000", "TINKER_API_KEY"),
        ("trained", "tinker://run/train/sampler_weights/000012", "TINKER_API_KEY"),
    ]
    assert result["benchmark_source"] == "tinker_remote"
    assert result["comparison"]["overall_score_delta"] == 33.0
    assert result["comparison"]["timeout_count_delta"] == -2
    assert result["comparison"]["handler_error_count_delta"] == -1


@pytest.mark.asyncio
async def test_main_wires_local_recipe_and_prints_json(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    captured: dict[str, object] = {}

    class FakeCanonicalPipeline:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def run(self):
            return {
                "status": "ok",
                "output_dir": captured["output_dir"],
            }

    monkeypatch.setattr(run_pipeline_module, "CanonicalPipeline", FakeCanonicalPipeline)

    rc = await run_pipeline_module.main(
        [
            "--mode",
            "train",
            "--output",
            str(tmp_path),
            "--prepare-only",
            "--local-backend",
            "cuda",
            "--local-model",
            "Qwen/Qwen3.5-9B",
            "--local-optimizer",
            "apollo",
            "--local-lora-target-modules",
            "q_proj,v_proj,q_proj",
            "--alert-webhook-url",
            "https://hooks.example.test/pipeline",
        ]
    )

    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert captured["local_training_enabled"] is False
    assert captured["local_training_backend"] == "cuda"
    assert captured["local_training_model"] == "Qwen/Qwen3.5-9B"
    assert captured["local_training_optimizer"] == "apollo"
    assert captured["local_training_lora_target_modules"] == ["q_proj", "v_proj"]
    assert captured["alert_webhook_url"] == "https://hooks.example.test/pipeline"
    assert payload["status"] == "ok"
    assert payload["output_dir"] == str(tmp_path)


@pytest.mark.asyncio
async def test_main_returns_failure_and_writes_report_on_pipeline_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captured = {"report_written": False}

    class FakeCanonicalPipeline:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def _fail_active_stages(self, _reason: str) -> None:
            return None

        def _write_report(self):
            captured["report_written"] = True

        async def run(self):
            raise RuntimeError("synthetic failure")

    monkeypatch.setattr(run_pipeline_module, "CanonicalPipeline", FakeCanonicalPipeline)

    rc = await run_pipeline_module.main(["--output", str(tmp_path)])

    assert rc == 1
    assert captured["report_written"] is True


def test_run_pipeline_cli_prepare_only_real_smoke(tmp_path: Path) -> None:
    venv_python = Path(__file__).resolve().parents[1] / ".venv" / "bin" / "python"
    if not venv_python.exists():
        pytest.skip("training venv is not available for real smoke execution")

    export_dir = tmp_path / "export"
    export_dir.mkdir()
    payload = {
        "trajectoryId": "traj-local-1",
        "agentId": "agent-local-1",
        "windowId": "window-local",
        "stepsJson": '[{"stepNumber":1,"timestamp":1001,"environmentState":{"agentBalance":10000,"agentPnL":12.5,"openPositions":0,"activeMarkets":1},"llmCalls":[{"model":"tiny-test","systemPrompt":"ssssssssssssssssssssssssssssss","userPrompt":"uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu","response":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","temperature":0.2,"maxTokens":64,"purpose":"action"}],"action":{"actionType":"trade","parameters":{"marketId":"market-one"},"success":true},"reward":0.1}]',
        "finalPnL": 12.5,
        "episodeLength": 1,
        "finalStatus": "completed",
    }
    (export_dir / "trajectories.jsonl").write_text(
        json.dumps(payload) + "\n",
        encoding="utf-8",
    )

    output_dir = tmp_path / "output"
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_pipeline.py"
    proc = subprocess.run(
        [
            str(venv_python),
            str(script_path),
            "--mode",
            "train",
            "--output",
            str(output_dir),
            "--prepare-only",
            "--trajectory-source",
            "local_export",
            "--source-dir",
            str(export_dir),
            "--skip-scambench",
            "--no-wandb",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["stages"]["sft"]["status"] == "completed"
    assert payload["stages"]["sft"]["training_status"] == "prepared_data"
    assert payload["stages"]["served_eval"]["status"] == "skipped"
    assert (output_dir / "pipeline_report.json").exists()


def test_run_pipeline_cli_failure_writes_failed_stage_report(tmp_path: Path) -> None:
    venv_python = Path(__file__).resolve().parents[1] / ".venv" / "bin" / "python"
    if not venv_python.exists():
        pytest.skip("training venv is not available for real smoke execution")

    export_dir = tmp_path / "bad-export"
    export_dir.mkdir()
    (export_dir / "trajectories.jsonl").write_text(
        json.dumps(
            {
                "trajectory_id": "bad-traj",
                "agent_id": "agent-bad",
                "window_id": "window-bad",
                "steps": [],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    output_dir = tmp_path / "output"
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_pipeline.py"
    proc = subprocess.run(
        [
            str(venv_python),
            str(script_path),
            "--mode",
            "train",
            "--output",
            str(output_dir),
            "--prepare-only",
            "--trajectory-source",
            "local_export",
            "--source-dir",
            str(export_dir),
            "--skip-scambench",
            "--no-wandb",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 1
    report = json.loads((output_dir / "pipeline_report.json").read_text(encoding="utf-8"))
    assert report["stages"]["sft"]["status"] == "failed"
    assert "Insufficient training data" in report["stages"]["sft"]["reason"]
