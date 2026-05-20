from __future__ import annotations

import sys
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

tinker_rl_orchestrator = import_module("src.training.tinker_rl_orchestrator")
TinkerRLConfig = tinker_rl_orchestrator.TinkerRLConfig
TinkerRLOrchestrator = tinker_rl_orchestrator.TinkerRLOrchestrator
TINKER_AVAILABLE = tinker_rl_orchestrator.TINKER_AVAILABLE

_skip_no_tinker = pytest.mark.skipif(
    not TINKER_AVAILABLE, reason="tinker package not installed"
)


class FakeTinkerClient:
    def __init__(self) -> None:
        self.initial_sampler_path = "tinker://sampler/initial"
        self.current_sampler_path = self.initial_sampler_path
        self.initial_state_path = "tinker://state/initial"
        self.current_state_path = self.initial_state_path
        self.loaded_state_paths: list[str] = []

    async def sync_weights_async(self, name: str | None = None) -> str | None:
        self.current_sampler_path = f"tinker://sampler/{name}"
        return self.current_sampler_path

    async def save_state_async(self, name: str | None = None) -> str | None:
        self.current_state_path = f"tinker://state/{name}"
        return self.current_state_path

    def load_state(self, path: str) -> None:
        self.loaded_state_paths.append(path)
        self.current_state_path = path
        self.current_sampler_path = f"tinker://sampler/materialized-from/{Path(path).name}"

    async def load_state_async(self, path: str) -> None:
        self.load_state(path)

    async def sample_async(
        self,
        messages,
        max_tokens=None,
        temperature=None,
        n=1,
        stop=None,
        include_logprobs=False,
    ):
        if "step-1" in self.current_sampler_path:
            completion = "Action: hold\nReason: price is flat at 0.50 and there is no catalyst."
        else:
            completion = "nope"

        return SimpleNamespace(completions=[completion], finish_reasons=["stop"])

    async def download_checkpoint_archive_async(
        self, *, tinker_path: str, output_path: Path
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"fake-archive")
        return output_path


class FakeTrainer:
    def __init__(self, client: FakeTinkerClient) -> None:
        self.tinker_client = client
        self.all_metrics = []
        self.run_id = "test-run"
        self.current_step = 0
        self.config = SimpleNamespace(log_file="metrics.jsonl", log_to_file=True)

    async def setup_for_scored_groups(self) -> None:
        return None

    async def cleanup(self) -> None:
        return None

    async def train_on_scored_data_group(self, scored_group, raw_scores=None):
        return SimpleNamespace(
            loss=1.0,
            num_samples=2,
            logprobs_mean=0.1,
            pos_advantage_mean=0.2,
            neg_advantage_mean=-0.2,
            avg_score=0.3,
        )

    def log_metrics(self, metrics) -> None:
        self.all_metrics.append(metrics)


class FakeEnv:
    def __init__(self) -> None:
        self.tinker_client = None
        self.trajectory_cache = [
            {"group_key": "group-1", "trajectories": [{"trajectory_id": "t1"}]},
            {"group_key": "group-2", "trajectories": [{"trajectory_id": "t2"}]},
        ]
        self._idx = 0
        self.judge_scores_buffer = []
        self.judge_format_scores = []
        self.judge_reasoning_scores = []

    async def setup(self) -> None:
        return None

    async def cleanup(self) -> None:
        return None

    async def get_next_item(self):
        if self._idx >= len(self.trajectory_cache):
            return None
        group = self.trajectory_cache[self._idx]
        self._idx += 1
        return group["group_key"], group["trajectories"]

    async def collect_trajectories(self, item):
        return (
            {"tokens": [[1, 2], [3, 4]], "masks": [[1, 1], [1, 1]], "scores": [0.4, 0.2]},
            [],
        )


@pytest.mark.asyncio
async def test_run_selects_best_checkpoint_from_deterministic_eval(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setattr(tinker_rl_orchestrator, "TINKER_AVAILABLE", True)

    fake_client = FakeTinkerClient()
    fake_trainer = FakeTrainer(fake_client)
    fake_env = FakeEnv()
    downloaded_refs: list[str] = []

    async def fake_download(trainer, remote_model_ref):
        downloaded_refs.append(remote_model_ref)
        return tmp_path / "checkpoint.tar", tmp_path / "exported_adapter"

    orchestrator = TinkerRLOrchestrator(
        TinkerRLConfig(
            base_model="Qwen/Qwen3-4B-Instruct-2507",
            output_dir=str(tmp_path),
            training_steps=2,
            group_size=2,
            weight_sync_interval=1,
            use_wandb=False,
        )
    )

    monkeypatch.setattr(orchestrator, "_build_trainer", lambda: fake_trainer)
    monkeypatch.setattr(orchestrator, "_build_env", lambda: fake_env)
    monkeypatch.setattr(orchestrator, "_download_final_artifacts", fake_download)

    report = await orchestrator.run()

    assert report["selected_checkpoint_source"] == "interval"
    assert report["selected_checkpoint_step"] == 1
    assert report["selected_checkpoint_ref"] == "tinker://sampler/babylon-rl-test-run-step-1"
    assert (
        report["selected_checkpoint_state_ref"] == "tinker://state/babylon-rl-test-run-step-1-state"
    )
    assert report["selected_checkpoint_materialized_ref"].startswith(
        "tinker://sampler/materialized-from/"
    )
    assert report["selection_summary"]["avg_score"] > 0.0
    assert (
        report["selection_summary"]["avg_score"]
        > report["selection_candidates"][-1]["summary"]["avg_score"]
    )
    assert report["final_reward"] == report["selection_summary"]["avg_score"]
    assert len(report["selection_candidates"]) == 3
    assert downloaded_refs == [report["selected_checkpoint_materialized_ref"]]
    assert fake_client.loaded_state_paths == ["tinker://state/babylon-rl-test-run-step-1-state"]


@_skip_no_tinker
def test_build_env_passes_local_export_configuration(tmp_path: Path):
    orchestrator = TinkerRLOrchestrator(
        TinkerRLConfig(
            base_model="Qwen/Qwen3-4B-Instruct-2507",
            output_dir=str(tmp_path),
            trajectory_source="local_export",
            source_dir="/tmp/local-export",
            use_wandb=False,
        )
    )

    env = orchestrator._build_env()

    assert env.config.trajectory_source == "local_export"
    assert env.config.local_export_dir == "/tmp/local-export"
    assert env.config.min_agents_per_window == 2
