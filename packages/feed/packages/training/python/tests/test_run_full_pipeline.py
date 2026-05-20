"""
Tests for the full pipeline script entrypoint.

These focus on orchestration behavior rather than the heavy training stack.
"""

import json
import sys
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


sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).parent.parent))

import run_full_pipeline as run_full_pipeline_module
from run_full_pipeline import FullPipeline

from src.models import FeedTrajectory


@pytest.mark.asyncio
async def test_full_pipeline_skips_benchmark_when_requested(tmp_path):
    pipeline = FullPipeline(output_dir=str(tmp_path), skip_benchmark=True)
    steps: list[str] = []

    async def mark(step: str):
        steps.append(step)

    async def fail_benchmark():
        raise AssertionError("run_benchmark should not be called")

    pipeline.generate_data = lambda: mark("generate")  # type: ignore[method-assign]
    pipeline.score_trajectories = lambda: mark("score")  # type: ignore[method-assign]
    pipeline.train_model = lambda: mark("train")  # type: ignore[method-assign]
    pipeline.run_benchmark = fail_benchmark  # type: ignore[method-assign]

    result = await pipeline.run_full_pipeline()

    assert steps == ["generate", "score", "train"]
    assert result["benchmark"] == {}


@pytest.mark.asyncio
async def test_full_pipeline_runs_benchmark_by_default(tmp_path):
    pipeline = FullPipeline(output_dir=str(tmp_path))
    steps: list[str] = []

    async def mark(step: str):
        steps.append(step)

    pipeline.generate_data = lambda: mark("generate")  # type: ignore[method-assign]
    pipeline.score_trajectories = lambda: mark("score")  # type: ignore[method-assign]
    pipeline.train_model = lambda: mark("train")  # type: ignore[method-assign]
    pipeline.run_benchmark = lambda: mark("benchmark")  # type: ignore[method-assign]

    await pipeline.run_full_pipeline()

    assert steps == ["generate", "score", "train", "benchmark"]


@pytest.mark.asyncio
async def test_full_pipeline_reports_prepared_training_artifacts(tmp_path):
    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        skip_benchmark=True,
        local_training_enabled=False,
    )

    async def noop():
        return None

    async def prepare_only():
        pipeline.training_status = "prepared_data"
        pipeline.training_artifact_path = tmp_path / "training_data.json"

    pipeline.generate_data = noop  # type: ignore[method-assign]
    pipeline.score_trajectories = noop  # type: ignore[method-assign]
    pipeline.train_model = prepare_only  # type: ignore[method-assign]
    pipeline.run_benchmark = noop  # type: ignore[method-assign]

    result = await pipeline.run_full_pipeline()

    assert result["training_status"] == "prepared_data"
    assert result["trained_model"] is None
    assert result["training_artifact"] == str(tmp_path / "training_data.json")


@pytest.mark.asyncio
async def test_train_model_prefers_local_training_without_tinker(monkeypatch, tmp_path):
    monkeypatch.delenv("TINKER_API_KEY", raising=False)
    pipeline = FullPipeline(output_dir=str(tmp_path), skip_benchmark=True)
    pipeline.generated_trajectories = [object()]
    pipeline.scores = [0.5]

    async def mark_local():
        pipeline.training_status = "trained"
        pipeline.trained_model_path = tmp_path / "adapters"

    async def fail_prepare():
        raise AssertionError("_prepare_local_training_data should not be called")

    pipeline._train_locally = mark_local  # type: ignore[method-assign]
    pipeline._prepare_local_training_data = fail_prepare  # type: ignore[method-assign]

    await pipeline.train_model()

    assert pipeline.training_status == "trained"
    assert pipeline.trained_model_path == tmp_path / "adapters"


def test_default_local_model_for_mlx_uses_shared_registry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("FEED_LOCAL_MLX_MODEL", raising=False)
    pipeline = FullPipeline(output_dir=str(tmp_path))

    assert pipeline._default_local_model_for_backend("mlx") == "mlx-community/Qwen3.5-4B-MLX-4bit"


@pytest.mark.asyncio
async def test_train_model_raises_when_local_training_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("TINKER_API_KEY", raising=False)
    pipeline = FullPipeline(output_dir=str(tmp_path), skip_benchmark=True)
    pipeline.generated_trajectories = [object()]
    pipeline.scores = [0.5]

    async def fail_local():
        raise RuntimeError("synthetic local failure")

    async def fail_prepare():
        raise AssertionError("_prepare_local_training_data should not be called")

    pipeline._train_locally = fail_local  # type: ignore[method-assign]
    pipeline._prepare_local_training_data = fail_prepare  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="synthetic local failure"):
        await pipeline.train_model()


@pytest.mark.asyncio
async def test_train_model_raises_when_scores_missing(tmp_path: Path) -> None:
    pipeline = FullPipeline(output_dir=str(tmp_path), skip_benchmark=True)

    with pytest.raises(ValueError, match="No scored trajectories available for training"):
        await pipeline.train_model()


@pytest.mark.asyncio
async def test_train_locally_passes_cuda_recipe_options(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        run_full_pipeline_module,
        "trajectories_to_training_samples",
        lambda trajectories, sample_profile: [
            {
                "messages": [
                    {"role": "user", "content": f"prompt-{index}"},
                    {"role": "assistant", "content": f"answer-{index}"},
                ]
            }
            for index, _trajectory in enumerate(trajectories)
            for _ in range(10)
        ],
    )
    monkeypatch.setattr(run_full_pipeline_module, "detect_backend", lambda: "cuda")

    def fake_train_cuda(samples, model_name, output_dir, **kwargs):
        captured["sample_count"] = len(samples)
        captured["model_name"] = model_name
        captured["output_dir"] = output_dir
        captured.update(kwargs)
        output_path = Path(output_dir) / "adapter"
        output_path.mkdir(parents=True, exist_ok=True)
        (Path(output_dir) / "training_metrics.json").write_text(
            json.dumps({"loss": 0.1}),
            encoding="utf-8",
        )
        (Path(output_dir) / "training_capacity_report.json").write_text(
            json.dumps({"requested_recipe": {"name": "qlora_nf4"}}),
            encoding="utf-8",
        )
        return str(output_path)

    monkeypatch.setattr(run_full_pipeline_module, "train_cuda", fake_train_cuda)
    monkeypatch.setattr(
        run_full_pipeline_module, "validate_trained_model", lambda *_args, **_kwargs: True
    )

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        local_training_backend="cuda",
        local_training_model="Qwen/Qwen3.5-9B",
        local_training_sample_profile="canonical",
        local_training_steps=12,
        local_training_batch_size=2,
        local_training_learning_rate=5e-6,
        local_training_optimizer="adamw",
        local_training_quantization="nf4",
        local_training_use_lora=True,
        local_training_lora_rank=32,
        local_training_lora_alpha=64,
        local_training_lora_dropout=0.05,
        local_training_lora_target_modules=["q_proj", "v_proj"],
        local_training_max_seq_length=4096,
        local_training_gradient_accumulation_steps=4,
        local_training_seed=17,
        local_training_eval_split_ratio=0.2,
        local_validate=True,
    )
    pipeline.generated_trajectories = [object()]

    await pipeline._train_locally()

    assert captured["sample_count"] == 10
    assert captured["use_lora"] is True
    assert captured["quantization"] == "nf4"
    assert captured["lora_rank"] == 32
    assert captured["lora_alpha"] == 64
    assert captured["lora_dropout"] == 0.05
    assert captured["lora_target_modules"] == ["q_proj", "v_proj"]
    assert captured["max_steps"] == 12
    assert captured["max_seq_length"] == 4096
    assert captured["gradient_accumulation_steps"] == 4
    assert captured["seed"] == 17
    assert captured["validation_split_ratio"] == 0.2
    assert pipeline.training_metrics_path == tmp_path / "training_metrics.json"
    assert pipeline.training_capacity_report_path == tmp_path / "training_capacity_report.json"


@pytest.mark.asyncio
async def test_train_locally_persists_effective_apollo_recipe(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        run_full_pipeline_module,
        "trajectories_to_training_samples",
        lambda trajectories, sample_profile: [
            {
                "messages": [
                    {"role": "user", "content": f"prompt-{index}"},
                    {"role": "assistant", "content": f"answer-{index}"},
                ]
            }
            for index, _trajectory in enumerate(trajectories)
            for _ in range(10)
        ],
    )

    def fake_train_cuda(samples, model_name, output_dir, **kwargs):
        captured["sample_count"] = len(samples)
        captured["model_name"] = model_name
        captured.update(kwargs)
        output_path = Path(output_dir) / "checkpoint"
        output_path.mkdir(parents=True, exist_ok=True)
        (Path(output_dir) / "training_metrics.json").write_text(
            json.dumps({"loss": 0.2}),
            encoding="utf-8",
        )
        return str(output_path)

    monkeypatch.setattr(run_full_pipeline_module, "train_cuda", fake_train_cuda)
    monkeypatch.setattr(
        run_full_pipeline_module, "validate_trained_model", lambda *_args, **_kwargs: True
    )

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        local_training_backend="cuda",
        local_training_model="Qwen/Qwen3.5-9B",
        local_training_optimizer="apollo",
        local_training_use_lora=True,
        local_validate=True,
    )
    pipeline.generated_trajectories = [object()]

    await pipeline._train_locally()

    assert captured["use_lora"] is False
    manifest = json.loads((tmp_path / "training_manifest.json").read_text(encoding="utf-8"))
    assert manifest["optimizer"] == "apollo"
    assert manifest["lora_enabled"] is False
    assert manifest["requested_recipe"]["lora_enabled"] is True
    assert manifest["effective_recipe"]["lora_enabled"] is False


@pytest.mark.asyncio
async def test_train_locally_rejects_quantized_non_cuda_backend(tmp_path):
    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        local_training_backend="cpu",
        local_training_model="Qwen/Qwen3.5-4B",
        local_training_quantization="nf4",
    )

    with pytest.raises(ValueError, match="NF4 quantization is only supported on the CUDA backend"):
        await pipeline._train_locally()


@pytest.mark.asyncio
async def test_train_locally_routes_to_mlx_backend(monkeypatch, tmp_path):
    monkeypatch.setattr(
        run_full_pipeline_module,
        "trajectories_to_training_samples",
        lambda trajectories, sample_profile: [
            {
                "messages": [
                    {"role": "user", "content": f"prompt-{index}"},
                    {"role": "assistant", "content": f"answer-{index}"},
                ]
            }
            for index, _trajectory in enumerate(trajectories)
            for _ in range(10)
        ],
    )

    def fake_train_mlx(samples, model_name, output_dir, steps, batch_size, learning_rate):
        adapter_path = Path(output_dir) / "adapters"
        adapter_path.mkdir(parents=True, exist_ok=True)
        return str(adapter_path)

    monkeypatch.setattr(run_full_pipeline_module, "train_mlx", fake_train_mlx)
    monkeypatch.setattr(
        run_full_pipeline_module, "validate_trained_model", lambda *_args, **_kwargs: True
    )

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        local_training_backend="mlx",
        local_training_model="Qwen/Qwen3.5-4B",
        local_training_steps=6,
        local_training_batch_size=2,
        local_training_learning_rate=3e-5,
        local_validate=True,
    )
    pipeline.generated_trajectories = [object()]

    await pipeline._train_locally()

    manifest = json.loads((tmp_path / "training_manifest.json").read_text(encoding="utf-8"))
    assert pipeline.training_backend == "mlx"
    assert pipeline.validation_passed is True
    assert manifest["backend"] == "mlx"
    assert manifest["model_name"] == "Qwen/Qwen3.5-4B"
    assert manifest["effective_recipe"]["steps"] == 6
    assert manifest["effective_recipe"]["batch_size"] == 2


@pytest.mark.asyncio
async def test_generate_data_preserves_empty_database_error(monkeypatch, tmp_path):
    from src import data_bridge

    class EmptyReader:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get_window_ids(self, **_kwargs):
            return []

    monkeypatch.setattr(data_bridge, "PostgresTrajectoryReader", EmptyReader)

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        database_url="postgresql://example",
    )

    with pytest.raises(ValueError, match="No trajectory data in database"):
        await pipeline.generate_data()


@pytest.mark.asyncio
async def test_generate_data_reads_unscored_windows(monkeypatch, tmp_path):
    from src import data_bridge

    calls: list[dict] = []

    def make_row(trajectory_id: str):
        return type(
            "TrajectoryRow",
            (),
            {
                "trajectory_id": trajectory_id,
                "agent_id": "agent-1",
                "window_id": "window-1",
                "steps_json": '[{"stepNumber":1,"timestamp":1001,"environmentState":{"agentBalance":10000,"agentPnL":10,"openPositions":0,"activeMarkets":1},"llmCalls":[{"model":"tiny-test","systemPrompt":"ssssssssssssssssssssssssssssss","userPrompt":"uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu","response":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","temperature":0.2,"maxTokens":64,"purpose":"action"}],"action":{"actionType":"trade","parameters":{},"success":true},"reward":0.1}]',
                "total_reward": 0.1,
                "episode_length": 1,
                "final_status": "completed",
                "final_pnl": 1.5,
                "trades_executed": 1,
                "ai_judge_reward": None,
                "archetype": "trader",
            },
        )()

    class ReaderWithUnscoredWindows:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get_window_ids(self, **kwargs):
            calls.append(kwargs)
            return ["window-1"]

        async def get_trajectories_by_window(self, window_id, min_actions=1):
            assert window_id == "window-1"
            assert min_actions == 1
            return [make_row("traj-1"), make_row("traj-2")]

    monkeypatch.setattr(data_bridge, "PostgresTrajectoryReader", ReaderWithUnscoredWindows)

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        database_url="postgresql://example",
        num_agents=1,
    )

    await pipeline.generate_data()

    assert calls == [
        {
            "limit": 0,
            "min_agents": 1,
            "lookback_hours": 72,
            "only_scored": False,
        }
    ]
    assert len(pipeline.generated_trajectories) == 2


@pytest.mark.asyncio
async def test_generate_data_reads_local_export_source(tmp_path):
    export_dir = tmp_path / "feed-export"
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
    (export_dir / "trajectories.jsonl").write_text(json.dumps(payload) + "\n", encoding="utf-8")

    pipeline = FullPipeline(
        output_dir=str(tmp_path / "output"),
        trajectory_source="local_export",
        source_dir=str(export_dir),
    )

    await pipeline.generate_data()

    assert len(pipeline.generated_trajectories) == 1
    assert pipeline.generated_trajectories[0].trajectory_id == "traj-local-1"
    assert pipeline.generated_trajectories[0].final_pnl == 12.5
    assert len(pipeline.generated_trajectories[0].steps) == 1


@pytest.mark.asyncio
async def test_generate_data_honors_max_trajectories(monkeypatch, tmp_path):
    from src import data_bridge

    class ReaderWithManyRows:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get_window_ids(self, **_kwargs):
            return ["window-1", "window-2"]

        async def get_trajectories_by_window(self, window_id, min_actions=1):
            assert min_actions == 1
            rows = []
            for i in range(3):
                rows.append(
                    type(
                        "TrajectoryRow",
                        (),
                        {
                            "trajectory_id": f"{window_id}-traj-{i}",
                            "agent_id": "agent-1",
                            "window_id": window_id,
                            "steps_json": '[{"stepNumber":1,"timestamp":1001,"environmentState":{"agentBalance":10000,"agentPnL":10,"openPositions":0,"activeMarkets":1},"llmCalls":[{"model":"tiny-test","systemPrompt":"ssssssssssssssssssssssssssssss","userPrompt":"uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu","response":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","temperature":0.2,"maxTokens":64,"purpose":"action"}],"action":{"actionType":"trade","parameters":{},"success":true},"reward":0.1}]',
                            "total_reward": 0.1,
                            "episode_length": 1,
                            "final_status": "completed",
                            "final_pnl": 1.5,
                            "trades_executed": 1,
                            "ai_judge_reward": None,
                            "archetype": "trader",
                        },
                    )()
                )
            return rows

    monkeypatch.setattr(data_bridge, "PostgresTrajectoryReader", ReaderWithManyRows)

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        database_url="postgresql://example",
        max_trajectories=4,
    )

    await pipeline.generate_data()

    assert len(pipeline.generated_trajectories) == 4


@pytest.mark.asyncio
async def test_generate_data_supports_huggingface_source(monkeypatch, tmp_path):
    if "tenacity" not in sys.modules:
        fake_tenacity = ModuleType("tenacity")
        fake_tenacity.retry = lambda *args, **kwargs: (lambda func: func)
        fake_tenacity.stop_after_attempt = lambda *args, **kwargs: None
        fake_tenacity.wait_exponential = lambda *args, **kwargs: None
        fake_tenacity.retry_if_exception_type = lambda *args, **kwargs: None
        sys.modules["tenacity"] = fake_tenacity
    from src.data_bridge import hf_reader

    class HFReader:
        def __init__(self, config):
            assert config.dataset_id == "elizaos/test-trajectories"
            assert config.split == "raw"
            assert config.min_actions == 1

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get_window_ids(self, **kwargs):
            assert kwargs == {
                "limit": 0,
                "min_agents": 1,
                "lookback_hours": 72,
                "only_scored": False,
            }
            return ["window-1"]

        async def get_trajectories_by_window(self, window_id, min_actions=1):
            assert window_id == "window-1"
            assert min_actions == 1
            return [
                type(
                    "TrajectoryRow",
                    (),
                    {
                        "trajectory_id": "hf-traj-1",
                        "agent_id": "agent-1",
                        "window_id": "window-1",
                        "steps_json": '[{"stepNumber":1,"timestamp":1001,"environmentState":{"agentBalance":10000,"agentPnL":10,"openPositions":0,"activeMarkets":1},"llmCalls":[{"model":"tiny-test","systemPrompt":"ssssssssssssssssssssssssssssss","userPrompt":"uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu","response":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","temperature":0.2,"maxTokens":64,"purpose":"action"}],"action":{"actionType":"trade","parameters":{},"success":true},"reward":0.1}]',
                        "total_reward": 0.1,
                        "episode_length": 1,
                        "final_status": "completed",
                        "final_pnl": 2.0,
                        "trades_executed": 1,
                        "archetype": "trader",
                    },
                )()
            ]

    monkeypatch.setattr(hf_reader, "HuggingFaceTrajectoryReader", HFReader)
    monkeypatch.setenv("TRAJECTORY_SOURCE", "huggingface")
    monkeypatch.setenv("HF_TRAJECTORY_DATASET", "elizaos/test-trajectories")
    monkeypatch.setenv("HF_TRAJECTORY_SPLIT", "raw")

    pipeline = FullPipeline(output_dir=str(tmp_path), max_trajectories=5)

    await pipeline.generate_data()

    assert len(pipeline.generated_trajectories) == 1
    assert pipeline.generated_trajectories[0].trajectory_id == "hf-traj-1"


@pytest.mark.asyncio
async def test_generate_data_records_window_selection_policy_and_filters_local_export(tmp_path):
    export_dir = tmp_path / "feed-export"
    export_dir.mkdir()
    payloads = [
        {
            "trajectoryId": "traj-keep",
            "agentId": "agent-keep",
            "windowId": "window-b",
            "stepsJson": json.dumps(
                [
                    {
                        "stepNumber": 1,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 10,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "tiny-test",
                                "systemPrompt": "s" * 30,
                                "userPrompt": "u" * 30,
                                "response": "r" * 40,
                                "temperature": 0.2,
                                "maxTokens": 64,
                                "purpose": "action",
                            }
                        ],
                        "action": {
                            "actionType": "trade",
                            "parameters": {"marketId": "BTC"},
                            "success": True,
                        },
                        "reward": 0.1,
                    },
                    {
                        "stepNumber": 2,
                        "timestamp": 1002,
                        "environmentState": {
                            "agentBalance": 10010,
                            "agentPnL": 20,
                            "openPositions": 1,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "tiny-test",
                                "systemPrompt": "s" * 30,
                                "userPrompt": "u" * 30,
                                "response": "r" * 40,
                                "temperature": 0.2,
                                "maxTokens": 64,
                                "purpose": "action",
                            }
                        ],
                        "action": {
                            "actionType": "hold",
                            "parameters": {},
                            "success": True,
                        },
                        "reward": 0.1,
                    },
                ]
            ),
            "finalPnL": 12.5,
            "episodeLength": 2,
            "finalStatus": "completed",
        },
        {
            "trajectoryId": "traj-drop",
            "agentId": "agent-drop",
            "windowId": "window-a",
            "stepsJson": json.dumps(
                [
                    {
                        "stepNumber": 1,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 10,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "tiny-test",
                                "systemPrompt": "s" * 30,
                                "userPrompt": "u" * 30,
                                "response": "r" * 40,
                                "temperature": 0.2,
                                "maxTokens": 64,
                                "purpose": "action",
                            }
                        ],
                        "action": {
                            "actionType": "trade",
                            "parameters": {"marketId": "ETH"},
                            "success": True,
                        },
                        "reward": 0.1,
                    },
                    {
                        "stepNumber": 2,
                        "timestamp": 1002,
                        "environmentState": {
                            "agentBalance": 10010,
                            "agentPnL": 20,
                            "openPositions": 1,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "tiny-test",
                                "systemPrompt": "s" * 30,
                                "userPrompt": "u" * 30,
                                "response": "r" * 40,
                                "temperature": 0.2,
                                "maxTokens": 64,
                                "purpose": "observation",
                            }
                        ],
                        "reward": 0.1,
                    },
                ]
            ),
            "finalPnL": 2.0,
            "episodeLength": 2,
            "finalStatus": "completed",
        },
    ]
    for index, payload in enumerate(payloads, start=1):
        (export_dir / f"traj-{index}.json").write_text(json.dumps(payload), encoding="utf-8")

    pipeline = FullPipeline(
        output_dir=str(tmp_path / "output"),
        trajectory_source="local_export",
        source_dir=str(export_dir),
        min_actions=2,
        window_selection_limit=1,
    )

    await pipeline.generate_data()

    assert len(pipeline.generated_trajectories) == 1
    assert pipeline.generated_trajectories[0].trajectory_id == "traj-keep"
    assert pipeline.selected_window_ids == ["window-b"]
    assert pipeline.selected_trajectory_count == 1
    assert pipeline.window_selection_policy["strategy"] == "all_loaded_stable_hash_trajectory"
    assert pipeline.data_provenance["min_actions"] == 2
    assert (
        pipeline.data_provenance["window_selection_policy"]["strategy"]
        == "all_loaded_stable_hash_trajectory"
    )
    assert pipeline.data_provenance["window_selection_policy"]["limit"] is None


@pytest.mark.asyncio
async def test_generate_data_accepts_scam_defense_local_export_without_step_action(
    tmp_path,
):
    export_dir = tmp_path / "feed-export"
    export_dir.mkdir()
    payload = {
        "trajectory": {
            "trajectoryId": "scam-defense-1",
            "id": "scam-defense-1",
            "agentId": "agent-1",
            "windowId": "window-scam",
            "steps": [
                {
                    "stepNumber": 0,
                    "timestamp": 1001,
                    "environmentState": {
                        "agentBalance": 10000,
                        "agentPnL": 0,
                        "openPositions": 0,
                        "activeMarkets": 1,
                    },
                    "llmCalls": [
                        {
                            "model": "synthetic-supervisor",
                            "systemPrompt": "s" * 80,
                            "userPrompt": "u" * 80,
                            "response": "I will not provide secrets or comply with this request.",
                            "temperature": 0.0,
                            "maxTokens": 250,
                            "purpose": "action",
                            "actionType": "scam_defense_decision",
                        }
                    ],
                    "reward": 1.0,
                }
            ],
            "totalReward": 1.0,
            "episodeLength": 1,
            "finalStatus": "completed",
            "finalPnL": 0.0,
        }
    }
    (export_dir / "trajectories.jsonl").write_text(
        json.dumps(payload) + "\n",
        encoding="utf-8",
    )

    pipeline = FullPipeline(
        output_dir=str(tmp_path / "output"),
        trajectory_source="local_export",
        source_dir=str(export_dir),
        min_actions=1,
    )

    await pipeline.generate_data()

    assert len(pipeline.generated_trajectories) == 1
    assert pipeline.generated_trajectories[0].trajectory_id == "scam-defense-1"


def test_persist_training_manifest_uses_cached_sample_count(tmp_path, monkeypatch):
    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.training_sample_count = 7
    pipeline.training_status = "prepared_data"

    def fail(*_args, **_kwargs):
        raise AssertionError("training samples should not be recomputed")

    monkeypatch.setattr(
        run_full_pipeline_module,
        "trajectories_to_training_samples",
        fail,
    )

    pipeline._persist_training_manifest()

    manifest = json.loads((tmp_path / "training_manifest.json").read_text(encoding="utf-8"))
    assert manifest["training_sample_count"] == 7


def test_build_tinker_scored_groups_uses_global_fallback_for_tiny_singleton_corpora(tmp_path):
    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-a",
                "id": "traj-a",
                "agentId": "agent-a",
                "windowId": "window-a",
                "scenarioId": "scenario-a",
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 0,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "synthetic-supervisor",
                                "systemPrompt": "s" * 80,
                                "userPrompt": "u" * 80,
                                "response": "Refuse and protect secrets.",
                                "temperature": 0.0,
                                "maxTokens": 250,
                                "purpose": "action",
                                "actionType": "scam_defense_decision",
                            }
                        ],
                        "reward": 1.0,
                    }
                ],
                "totalReward": 1.0,
                "episodeLength": 1,
                "finalStatus": "completed",
                "finalPnL": 0.0,
            }
        ),
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-b",
                "id": "traj-b",
                "agentId": "agent-b",
                "windowId": "window-b",
                "scenarioId": "scenario-b",
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 1002,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 0,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "synthetic-supervisor",
                                "systemPrompt": "s" * 80,
                                "userPrompt": "u" * 80,
                                "response": "Ask for verification and avoid disclosure.",
                                "temperature": 0.0,
                                "maxTokens": 250,
                                "purpose": "action",
                                "actionType": "scam_defense_decision",
                            }
                        ],
                        "reward": 0.2,
                    }
                ],
                "totalReward": 0.2,
                "episodeLength": 1,
                "finalStatus": "completed",
                "finalPnL": 0.0,
            }
        ),
    ]
    pipeline.scores = [1.0, 0.0]

    groups = pipeline._build_tinker_scored_groups()

    assert len(groups) == 1
    assert groups[0]["group_key"] == "global_fallback"
    assert len(groups[0]["trajectories"]) == 2


def test_build_tinker_scored_groups_uses_score_stratified_fallback_for_large_singleton_corpora(
    tmp_path,
):
    pipeline = FullPipeline(output_dir=str(tmp_path))

    def make_singleton_trajectory(index: int) -> FeedTrajectory:
        return FeedTrajectory.model_validate(
            {
                "trajectoryId": f"traj-{index}",
                "id": f"traj-{index}",
                "agentId": f"agent-{index}",
                "windowId": f"window-{index}",
                "scenarioId": f"scenario-{index}",
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 1000 + index,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": float(index),
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "synthetic-supervisor",
                                "systemPrompt": "s" * 80,
                                "userPrompt": "u" * 80,
                                "response": "Refuse and protect secrets.",
                                "temperature": 0.0,
                                "maxTokens": 250,
                                "purpose": "action",
                                "actionType": "scam_defense_decision",
                            }
                        ],
                        "reward": float(index),
                    }
                ],
                "totalReward": float(index),
                "episodeLength": 1,
                "finalStatus": "completed",
                "finalPnL": float(index),
            }
        )

    pipeline.generated_trajectories = [make_singleton_trajectory(index) for index in range(8)]
    pipeline.scores = [1.0, 0.9, 0.8, 0.7, 0.3, 0.2, 0.1, 0.0]

    groups = pipeline._build_tinker_scored_groups()

    assert len(groups) == 2
    assert {group["group_key"] for group in groups} == {
        "score_stratified_fallback_000",
        "score_stratified_fallback_001",
    }
    assert sorted(len(group["trajectories"]) for group in groups) == [4, 4]
    assert sorted(
        trajectory["trajectory_id"] for group in groups for trajectory in group["trajectories"]
    ) == [f"traj-{index}" for index in range(8)]


def test_build_tinker_scored_groups_keeps_strict_pairs_and_packs_singleton_remainder(
    tmp_path,
):
    pipeline = FullPipeline(output_dir=str(tmp_path))

    def make_trajectory(index: int, *, window_id: str, scenario_id: str) -> FeedTrajectory:
        return FeedTrajectory.model_validate(
            {
                "trajectoryId": f"traj-{index}",
                "id": f"traj-{index}",
                "agentId": f"agent-{index}",
                "windowId": window_id,
                "scenarioId": scenario_id,
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 2000 + index,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": float(index),
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "synthetic-supervisor",
                                "systemPrompt": "s" * 80,
                                "userPrompt": "u" * 80,
                                "response": "Refuse and protect secrets.",
                                "temperature": 0.0,
                                "maxTokens": 250,
                                "purpose": "action",
                                "actionType": "scam_defense_decision",
                            }
                        ],
                        "reward": float(index),
                    }
                ],
                "totalReward": float(index),
                "episodeLength": 1,
                "finalStatus": "completed",
                "finalPnL": float(index),
            }
        )

    pipeline.generated_trajectories = [
        make_trajectory(0, window_id="shared-window", scenario_id="shared-scenario"),
        make_trajectory(1, window_id="shared-window", scenario_id="shared-scenario"),
        *[
            make_trajectory(
                index,
                window_id=f"window-{index}",
                scenario_id=f"scenario-{index}",
            )
            for index in range(2, 10)
        ],
    ]
    pipeline.scores = [float(10 - index) / 10.0 for index in range(10)]

    groups = pipeline._build_tinker_scored_groups()

    assert len(groups) == 3
    assert groups[0]["group_key"] == "shared-window_shared-scenario"
    assert sorted(len(group["trajectories"]) for group in groups) == [2, 4, 4]
    assert sorted(
        trajectory["trajectory_id"] for group in groups for trajectory in group["trajectories"]
    ) == [f"traj-{index}" for index in range(10)]


@pytest.mark.asyncio
async def test_generate_data_uses_explicit_window_selection_limit(monkeypatch, tmp_path):
    from src import data_bridge

    calls: list[dict] = []

    def make_row(window_id: str):
        return type(
            "TrajectoryRow",
            (),
            {
                "trajectory_id": f"{window_id}-traj",
                "agent_id": f"agent-{window_id}",
                "window_id": window_id,
                "steps_json": '[{"stepNumber":1,"timestamp":1001,"environmentState":{"agentBalance":10000,"agentPnL":10,"openPositions":0,"activeMarkets":1},"llmCalls":[{"model":"tiny-test","systemPrompt":"ssssssssssssssssssssssssssssss","userPrompt":"uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu","response":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","temperature":0.2,"maxTokens":64,"purpose":"action"}],"action":{"actionType":"trade","parameters":{},"success":true},"reward":0.1}]',
                "total_reward": 0.1,
                "episode_length": 1,
                "final_status": "completed",
                "final_pnl": 1.5,
                "trades_executed": 1,
                "ai_judge_reward": None,
                "archetype": "trader",
            },
        )()

    class ReaderWithWindows:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get_window_ids(self, **kwargs):
            calls.append(kwargs)
            return ["window-a", "window-c", "window-b"]

        async def get_trajectories_by_window(self, window_id, min_actions=1):
            return [make_row(window_id)]

    monkeypatch.setattr(data_bridge, "PostgresTrajectoryReader", ReaderWithWindows)

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        database_url="postgresql://example",
        window_selection_limit=2,
    )

    await pipeline.generate_data()

    assert calls == [
        {
            "limit": 0,
            "min_agents": 1,
            "lookback_hours": 72,
            "only_scored": False,
        }
    ]
    assert pipeline.selected_window_ids == pipeline._select_window_ids(
        ["window-a", "window-c", "window-b"]
    )
    assert pipeline.source_window_count == 3


@pytest.mark.asyncio
async def test_score_trajectories_uses_current_reward_api(tmp_path):
    pipeline = FullPipeline(output_dir=str(tmp_path), skip_benchmark=True)
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectory_id": "traj-1",
                "agent_id": "agent-1",
                "window_id": "window-1",
                "steps": [
                    {
                        "stepNumber": 1,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 0,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [],
                        "action": {
                            "actionType": "trade",
                            "parameters": {},
                            "success": True,
                        },
                        "reward": 0.1,
                    }
                ],
                "finalPnl": 50,
                "episodeLength": 1,
                "tradesExecuted": 1,
                "finalStatus": "completed",
            }
        ),
        FeedTrajectory.model_validate(
            {
                "trajectory_id": "traj-2",
                "agent_id": "agent-2",
                "window_id": "window-1",
                "steps": [
                    {
                        "stepNumber": 1,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 0,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [],
                        "action": {
                            "actionType": "trade",
                            "parameters": {},
                            "success": False,
                        },
                        "reward": -0.1,
                    }
                ],
                "finalPnl": -50,
                "episodeLength": 1,
                "tradesExecuted": 1,
                "finalStatus": "completed",
            }
        ),
    ]

    await pipeline.score_trajectories()

    assert len(pipeline.scores) == 2
    assert pipeline.scores[0] > pipeline.scores[1]


@pytest.mark.asyncio
async def test_run_benchmark_loads_existing_local_training_manifest(tmp_path):
    adapter_dir = tmp_path / "adapters"
    adapter_dir.mkdir()
    (tmp_path / "training_manifest.json").write_text(
        """
{
  "training_status": "trained",
  "backend": "mlx",
  "model_name": "Qwen/Qwen3.5-4B",
  "output_path": "%s",
  "training_artifact": "%s",
  "validation_passed": true
}
        """.strip()
        % (adapter_dir, adapter_dir)
    )

    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectory_id": "traj-1",
                "agent_id": "agent-1",
                "window_id": "window-1",
                "steps": [],
                "finalPnl": 10,
                "episodeLength": 1,
                "tradesExecuted": 1,
                "finalStatus": "completed",
            }
        )
    ]

    async def fake_served_eval():
        return {
            "status": "skipped",
            "reason": "test stub",
        }

    pipeline._run_served_comparison = fake_served_eval  # type: ignore[method-assign]

    await pipeline.run_benchmark()

    assert pipeline.benchmark_results["trained_model"]["status"] == "validated"
    assert pipeline.benchmark_results["trained_model"]["model"] == str(adapter_dir)


@pytest.mark.asyncio
async def test_run_benchmark_records_served_evaluation_summary(tmp_path):
    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.training_status = "trained"
    pipeline.training_backend = "mlx"
    pipeline.training_base_model = "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
    pipeline.trained_model_path = tmp_path / "adapters"
    pipeline.trained_model_path.mkdir()
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectory_id": "traj-1",
                "agent_id": "agent-1",
                "window_id": "window-1",
                "steps": [],
                "finalPnl": 10,
                "episodeLength": 1,
                "tradesExecuted": 1,
                "finalStatus": "completed",
            }
        )
    ]

    async def fake_served_eval():
        pipeline.served_eval_path = tmp_path / "served_eval.json"
        pipeline.served_eval_summary = {
            "base_summary": {"avg_score": 0.8},
            "adapter_summary": {"avg_score": 1.0},
            "comparison": {"adapter_wins": 1},
        }
        return {
            "status": "completed",
            "report_path": str(pipeline.served_eval_path),
            "summary": pipeline.served_eval_summary,
        }

    pipeline._run_served_comparison = fake_served_eval  # type: ignore[method-assign]

    await pipeline.run_benchmark()

    assert pipeline.benchmark_results["served_evaluation"]["status"] == "completed"
    assert (
        pipeline.benchmark_results["served_evaluation"]["summary"]["comparison"]["adapter_wins"]
        == 1
    )


@pytest.mark.asyncio
async def test_training_manifest_records_data_provenance_and_selection_policy(tmp_path):
    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectory_id": "traj-1",
                "agent_id": "agent-1",
                "window_id": "window-b",
                "steps": [
                    {
                        "stepNumber": 1,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 10,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "tiny-test",
                                "systemPrompt": "s" * 30,
                                "userPrompt": "u" * 30,
                                "response": "r" * 40,
                                "temperature": 0.2,
                                "maxTokens": 64,
                                "purpose": "action",
                            }
                        ],
                        "action": {
                            "actionType": "trade",
                            "parameters": {"marketId": "BTC"},
                            "success": True,
                        },
                        "reward": 0.1,
                    }
                ],
                "finalPnl": 10,
                "episodeLength": 1,
                "tradesExecuted": 1,
                "finalStatus": "completed",
            }
        )
    ]
    pipeline.trained_model_path = tmp_path / "adapters"
    pipeline.trained_model_path.mkdir()
    pipeline.training_artifact_path = pipeline.trained_model_path
    pipeline.training_status = "trained"
    pipeline.training_backend = "mlx"
    pipeline.training_base_model = "Qwen/Qwen3.5-4B"
    pipeline.selected_window_ids = ["window-b"]
    pipeline.selected_trajectory_count = 1
    pipeline.window_selection_policy = {
        "strategy": "stable_hash_window_then_trajectory",
        "limit": 50,
        "seed": pipeline.selection_seed,
    }
    pipeline.data_provenance = {
        "trajectory_source": "db",
        "source_split": "db",
        "source_dir": None,
        "hf_dataset": None,
        "hf_split": None,
        "lookback_hours": 72,
        "min_agents": 2,
        "min_actions": 3,
        "max_trajectories": 40,
        "window_selection_limit": 50,
        "window_selection_policy": pipeline.window_selection_policy,
        "candidate_window_count": 8,
        "selected_window_ids": ["window-b"],
        "selected_window_count": 1,
        "selected_trajectory_count": 1,
    }

    pipeline._persist_training_manifest()

    manifest = json.loads((tmp_path / "training_manifest.json").read_text(encoding="utf-8"))
    assert manifest["data_provenance"]["min_agents"] == 2
    assert manifest["data_provenance"]["min_actions"] == 3
    assert manifest["window_selection_policy"]["strategy"] == "stable_hash_window_then_trajectory"
    assert manifest["selected_window_ids"] == ["window-b"]
    assert manifest["selected_trajectory_count"] == 1


@pytest.mark.asyncio
async def test_prepare_local_training_data_records_curation_metadata(monkeypatch, tmp_path):
    from src import training as training_pkg

    captured: dict[str, object] = {}

    class FakeBuilder:
        def __init__(self):
            self.trajectories = []

        def add_trajectory(self, trajectory, trajectory_score):
            self.trajectories.append((trajectory, trajectory_score))

        def get_statistics(self):
            return {
                "total_trajectories": 1,
                "total_samples": 3,
                "by_purpose": {"action": {"count": 3, "avg_score": 0.9}},
            }

        def save_dataset(self, output_path):
            captured["output_path"] = output_path
            Path(output_path).write_text("[]", encoding="utf-8")

    monkeypatch.setattr(training_pkg, "MultiPromptDatasetBuilder", FakeBuilder)

    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectory_id": "traj-1",
                "agent_id": "agent-1",
                "window_id": "window-c",
                "steps": [
                    {
                        "stepNumber": 1,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 10,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "llmCalls": [
                            {
                                "model": "tiny-test",
                                "systemPrompt": "s" * 30,
                                "userPrompt": "u" * 30,
                                "response": "r" * 40,
                                "temperature": 0.2,
                                "maxTokens": 64,
                                "purpose": "action",
                            }
                        ],
                        "action": {
                            "actionType": "trade",
                            "parameters": {"marketId": "BTC"},
                            "success": True,
                        },
                        "reward": 0.1,
                    }
                ],
                "finalPnl": 10,
                "episodeLength": 1,
                "tradesExecuted": 1,
                "finalStatus": "completed",
            }
        )
    ]
    pipeline.scores = [0.75]

    await pipeline._prepare_local_training_data()

    config = json.loads(
        (tmp_path / "training_data" / "training_config.json").read_text(encoding="utf-8")
    )
    assert captured["output_path"] == str(tmp_path / "training_data.json")
    assert config["data_provenance"]["trajectory_source"] == "db"
    assert config["selected_window_ids"] == ["window-c"]
    assert config["selected_trajectory_count"] == 1


@pytest.mark.asyncio
async def test_train_model_requires_tinker_key_when_backend_is_explicit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.delenv("TINKER_API_KEY", raising=False)

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        training_backend_preference="tinker",
    )
    pipeline.generated_trajectories = [object()]
    pipeline.scores = [0.25]

    with pytest.raises(ValueError, match="requires TINKER_API_KEY"):
        await pipeline.train_model()


@pytest.mark.asyncio
async def test_train_with_tinker_uses_pre_scored_groups(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    from src.training import tinker_client, tinker_trainer

    captured: dict[str, object] = {}

    class FakeTrainer:
        def __init__(self, config):
            captured["config"] = config
            self.tinker_client = type(
                "FakeTinkerClient",
                (),
                {
                    "download_checkpoint_archive": staticmethod(
                        lambda **_kwargs: tmp_path / "checkpoint.tar"
                    )
                },
            )()

        async def train_from_scored_groups(self, groups):
            captured["groups"] = groups
            return {
                "success": True,
                "run_id": "run-123",
                "steps": 12,
                "initial_sampler_path": "tinker://run/train/sampler_weights/000000",
                "final_weights": "tinker://run/train/sampler_weights/000012",
                "final_state_path": "tinker://run/train/state/000012",
            }

    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr(tinker_client, "TINKER_AVAILABLE", True)
    monkeypatch.setattr(tinker_trainer, "FeedTinkerTrainer", FakeTrainer)

    async def fake_download(self, trainer):
        return None

    monkeypatch.setattr(
        FullPipeline,
        "_download_tinker_artifacts",
        fake_download,
    )

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        training_backend_preference="tinker",
        tinker_training_steps=12,
        tinker_group_size=3,
    )
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-1",
                "agentId": "agent-1",
                "windowId": "window-1",
                "scenarioId": "scam-a",
                "steps": [],
                "finalPnl": 10,
                "episodeLength": 1,
                "finalStatus": "completed",
            }
        ),
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-2",
                "agentId": "agent-2",
                "windowId": "window-1",
                "scenarioId": "scam-a",
                "steps": [],
                "finalPnl": -5,
                "episodeLength": 1,
                "finalStatus": "completed",
            }
        ),
    ]
    pipeline.scores = [0.75, -0.25]

    await pipeline._train_with_tinker()

    groups = captured["groups"]
    assert isinstance(groups, list)
    assert len(groups) == 1
    assert groups[0]["group_key"] == "window-1_scam-a"
    assert groups[0]["scores"] == [0.75, -0.25]
    assert len(groups[0]["trajectories"]) == 2
    assert pipeline.training_status == "trained"
    assert pipeline.training_backend == "tinker"
    assert pipeline.training_remote_ref == "tinker://run/train/sampler_weights/000012"
    assert pipeline.training_remote_base_ref == "tinker://run/train/sampler_weights/000000"
    assert pipeline.training_remote_state_ref == "tinker://run/train/state/000012"


@pytest.mark.asyncio
async def test_train_with_tinker_falls_back_to_local_training_on_unsuccessful_result(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.training import tinker_client, tinker_trainer

    class FakeTrainer:
        def __init__(self, _config):
            self.tinker_client = object()

        async def train_from_scored_groups(self, _groups):
            return {
                "success": False,
                "message": "remote quota exhausted",
            }

    fallback_called = {"local": 0, "prepared": 0}

    async def fake_local_train():
        fallback_called["local"] += 1
        pipeline.training_status = "trained"
        pipeline.training_backend = "cuda"
        pipeline.trained_model_path = tmp_path / "local-model"

    async def fake_prepare():
        fallback_called["prepared"] += 1

    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr(tinker_client, "TINKER_AVAILABLE", True)
    monkeypatch.setattr(tinker_trainer, "FeedTinkerTrainer", FakeTrainer)

    pipeline = FullPipeline(output_dir=str(tmp_path), training_backend_preference="auto")
    pipeline.generated_trajectories = [object()]
    pipeline.scores = [0.5]
    pipeline._train_locally = fake_local_train  # type: ignore[method-assign]
    pipeline._prepare_local_training_data = fake_prepare  # type: ignore[method-assign]

    await pipeline._train_with_tinker()

    assert fallback_called == {"local": 1, "prepared": 0}
    assert pipeline.training_backend == "cuda"


@pytest.mark.asyncio
async def test_train_with_tinker_prepares_data_only_when_local_training_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.training import tinker_client, tinker_trainer

    class FakeTrainer:
        def __init__(self, _config):
            self.tinker_client = object()

        async def train_from_scored_groups(self, _groups):
            return {
                "success": False,
                "message": "remote quota exhausted",
            }

    prepared = {"count": 0}

    async def fake_prepare():
        prepared["count"] += 1
        pipeline.training_status = "prepared_data"

    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr(tinker_client, "TINKER_AVAILABLE", True)
    monkeypatch.setattr(tinker_trainer, "FeedTinkerTrainer", FakeTrainer)

    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        training_backend_preference="auto",
        local_training_enabled=False,
    )
    pipeline.generated_trajectories = [object()]
    pipeline.scores = [0.5]
    pipeline._prepare_local_training_data = fake_prepare  # type: ignore[method-assign]

    await pipeline._train_with_tinker()

    assert prepared["count"] == 1
    assert pipeline.training_status == "prepared_data"


@pytest.mark.asyncio
async def test_download_tinker_artifacts_records_export_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class FakeClient:
        async def download_checkpoint_archive_async(self, **_kwargs):
            raise RuntimeError("network down")

    trainer = type("FakeTrainer", (), {"tinker_client": FakeClient()})()
    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.training_remote_ref = "tinker://run/train/sampler_weights/000012"

    await pipeline._download_tinker_artifacts(trainer)

    assert pipeline.training_export_error == "network down"


def test_load_existing_training_artifact_downgrades_missing_output_and_restores_export_error(
    tmp_path: Path,
) -> None:
    artifact_path = tmp_path / "tinker_trained"
    artifact_path.mkdir()
    manifest_path = tmp_path / "training_manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "training_status": "trained",
                "backend": "tinker",
                "model_name": "Qwen/Qwen3.5-9B",
                "output_path": str(tmp_path / "missing-exported-adapter"),
                "training_artifact": str(artifact_path),
                "training_export_error": "checkpoint archive download failed",
            }
        ),
        encoding="utf-8",
    )

    pipeline = FullPipeline(output_dir=str(tmp_path))

    pipeline._load_existing_training_artifact()

    assert pipeline.training_status == "prepared_data"
    assert pipeline.trained_model_path is None
    assert pipeline.training_artifact_path == artifact_path
    assert pipeline.training_export_error == "checkpoint archive download failed"


@pytest.mark.asyncio
async def test_full_pipeline_result_includes_training_export_error(tmp_path: Path) -> None:
    pipeline = FullPipeline(
        output_dir=str(tmp_path),
        skip_benchmark=True,
        local_training_enabled=False,
    )

    async def noop():
        return None

    async def prepare_only():
        pipeline.training_status = "prepared_data"
        pipeline.training_artifact_path = tmp_path / "training_data.json"
        pipeline.training_export_error = "remote artifact export failed"

    pipeline.generate_data = noop  # type: ignore[method-assign]
    pipeline.score_trajectories = noop  # type: ignore[method-assign]
    pipeline.train_model = prepare_only  # type: ignore[method-assign]
    pipeline.run_benchmark = noop  # type: ignore[method-assign]

    result = await pipeline.run_full_pipeline()

    assert result["training_export_error"] == "remote artifact export failed"


@pytest.mark.asyncio
async def test_tinker_served_comparison_uses_local_proxy_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    captured: dict[str, object] = {}

    def fake_report(**kwargs):
        captured.update(kwargs)
        output_path = kwargs["output_path"]
        output_path.write_text("{}", encoding="utf-8")
        return {
            "base_model": {"summary": {"avg_score": 0.2}},
            "adapter_model": {"summary": {"avg_score": 0.9}},
            "comparison": {"adapter_wins": 4},
        }

    monkeypatch.setenv("TINKER_API_KEY", "test-key")
    monkeypatch.setattr(
        "compare_served_models.generate_tinker_proxy_comparison_report",
        fake_report,
    )

    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.training_status = "trained"
    pipeline.training_backend = "tinker"
    pipeline.training_base_model = "Qwen/Qwen3.5-4B"
    pipeline.training_remote_base_ref = "tinker://run/train/sampler_weights/000000"
    pipeline.training_remote_ref = "tinker://run/train/sampler_weights/000012"
    pipeline.trained_model_path = tmp_path / "tinker_trained"
    pipeline.trained_model_path.mkdir()

    result = await pipeline._run_served_comparison()

    assert result["status"] == "completed"
    assert captured["base_model_ref"] == "tinker://run/train/sampler_weights/000000"
    assert captured["trained_model_ref"] == "tinker://run/train/sampler_weights/000012"
    assert pipeline.served_eval_summary["evaluation_kind"] == "served_tinker_proxy"
    assert pipeline.served_eval_summary["comparison"]["adapter_wins"] == 4


@pytest.mark.asyncio
async def test_run_benchmark_reports_remote_tinker_checkpoint(tmp_path: Path):
    trained_dir = tmp_path / "tinker_trained"
    trained_dir.mkdir()

    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.training_status = "trained"
    pipeline.training_backend = "tinker"
    pipeline.training_base_model = "Qwen/Qwen3.5-4B"
    pipeline.training_remote_ref = "feed-remote-final"
    pipeline.trained_model_path = trained_dir
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-1",
                "agentId": "agent-1",
                "windowId": "window-1",
                "steps": [],
                "finalPnl": 10,
                "episodeLength": 1,
                "finalStatus": "completed",
            }
        )
    ]

    await pipeline.run_benchmark()

    assert pipeline.benchmark_results["trained_model"]["status"] == "remote_checkpoint"
    assert pipeline.benchmark_results["trained_model"]["remote_model_ref"] == "feed-remote-final"
    assert pipeline.benchmark_results["served_evaluation"]["status"] == "skipped"


def test_build_tinker_scored_groups_partitions_by_dominant_market(tmp_path: Path):
    pipeline = FullPipeline(output_dir=str(tmp_path))
    pipeline.generated_trajectories = [
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-1",
                "agentId": "agent-1",
                "windowId": "window-1",
                "scenarioId": "scam-a",
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 1000,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 10,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "action": {
                            "actionType": "TRADE",
                            "parameters": {"marketId": "market-one"},
                            "success": True,
                        },
                    }
                ],
                "finalPnl": 10,
                "episodeLength": 1,
                "finalStatus": "completed",
            }
        ),
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-2",
                "agentId": "agent-2",
                "windowId": "window-1",
                "scenarioId": "scam-a",
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 1001,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": -5,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "action": {
                            "actionType": "TRADE",
                            "parameters": {"marketId": "market-one"},
                            "success": True,
                        },
                    }
                ],
                "finalPnl": -5,
                "episodeLength": 1,
                "finalStatus": "completed",
            }
        ),
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-3",
                "agentId": "agent-3",
                "windowId": "window-1",
                "scenarioId": "scam-a",
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 1002,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": 7,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "action": {
                            "actionType": "TRADE",
                            "parameters": {"marketId": "market-two"},
                            "success": True,
                        },
                    }
                ],
                "finalPnl": 7,
                "episodeLength": 1,
                "finalStatus": "completed",
            }
        ),
        FeedTrajectory.model_validate(
            {
                "trajectoryId": "traj-4",
                "agentId": "agent-4",
                "windowId": "window-1",
                "scenarioId": "scam-a",
                "steps": [
                    {
                        "stepNumber": 0,
                        "timestamp": 1003,
                        "environmentState": {
                            "agentBalance": 10000,
                            "agentPnL": -2,
                            "openPositions": 0,
                            "activeMarkets": 1,
                        },
                        "action": {
                            "actionType": "TRADE",
                            "parameters": {"marketId": "market-two"},
                            "success": True,
                        },
                    }
                ],
                "finalPnl": -2,
                "episodeLength": 1,
                "finalStatus": "completed",
            }
        ),
    ]
    pipeline.scores = [0.8, -0.2, 0.6, -0.1]

    groups = pipeline._build_tinker_scored_groups()

    assert len(groups) == 2
    assert {group["group_key"] for group in groups} == {
        "window-1_scam-a__dominant_market_market-one",
        "window-1_scam-a__dominant_market_market-two",
    }


@pytest.mark.asyncio
async def test_run_full_pipeline_main_lists_archetypes(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import src.training as training_pkg

    monkeypatch.setattr(training_pkg, "get_available_archetypes", lambda: ["trader", "scammer"])
    monkeypatch.setattr(
        run_full_pipeline_module,
        "FullPipeline",
        lambda *args, **kwargs: pytest.fail(
            "FullPipeline should not be constructed for --list-archetypes"
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["run_full_pipeline.py", "--list-archetypes"],
    )

    await run_full_pipeline_module.main()

    stdout = capsys.readouterr().out
    assert "Available archetypes:" in stdout
    assert "trader" in stdout
    assert "scammer" in stdout


@pytest.mark.asyncio
async def test_run_full_pipeline_main_prepare_only_wires_recipe_and_prints_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    captured: dict[str, object] = {}
    steps: list[str] = []

    class FakePipeline:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.generated_trajectories: list[object] = []
            self.training_status = "not_started"
            self.trained_model_path = None
            self.training_artifact_path = None
            self.training_export_error = None

        async def generate_data(self):
            steps.append("generate")
            self.generated_trajectories = [object(), object()]

        async def score_trajectories(self):
            steps.append("score")

        async def train_model(self):
            steps.append("train")
            self.training_status = "prepared_data"
            self.training_artifact_path = tmp_path / "training_data.json"
            self.training_export_error = "remote artifact export failed"

    monkeypatch.setattr(run_full_pipeline_module, "FullPipeline", FakePipeline)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "run_full_pipeline.py",
            "--mode",
            "train",
            "--output",
            str(tmp_path),
            "--prepare-only",
            "--local-backend",
            "cuda",
            "--local-optimizer",
            "apollo",
            "--local-lora-target-modules",
            "q_proj,v_proj,q_proj",
        ],
    )

    await run_full_pipeline_module.main()

    stdout = capsys.readouterr().out
    payload = json.loads(stdout.split("Result:", 1)[1])
    assert steps == ["generate", "score", "train"]
    assert captured["local_training_enabled"] is False
    assert captured["local_training_backend"] == "cuda"
    assert captured["local_training_optimizer"] == "apollo"
    assert captured["local_training_lora_target_modules"] == ["q_proj", "v_proj"]
    assert payload["training_status"] == "prepared_data"
    assert payload["training_artifact"] == str(tmp_path / "training_data.json")
    assert payload["training_export_error"] == "remote artifact export failed"
