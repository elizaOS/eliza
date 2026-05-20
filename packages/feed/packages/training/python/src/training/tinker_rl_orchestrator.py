"""
Tinker-native RL orchestration for the canonical Babylon pipeline.

This stage reuses the deterministic Babylon reward/judge path, but performs
sampling and optimization through Tinker instead of local vLLM + Atropos.
"""

from __future__ import annotations

import json
import logging
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any

from atroposlib.envs.base import APIServerConfig, EvalHandlingEnum

from .babylon_env import BabylonEnvConfig, BabylonRLAIFEnv
from .deterministic_eval import (
    ACTION_REASON_PROMPTS,
    ACTION_REASON_SYSTEM_PROMPT,
    passes_action_reason_gate,
    score_action_reason_response,
    summarize_action_reason_results,
)
from .tinker_client import TINKER_AVAILABLE
from .tinker_trainer import BabylonTinkerTrainer, TinkerTrainingConfig

logger = logging.getLogger(__name__)


@dataclass
class TinkerRLConfig:
    base_model: str
    output_dir: str
    training_steps: int = 100
    group_size: int = 4
    learning_rate: float = 1e-5
    lora_rank: int = 32
    weight_sync_interval: int = 5
    use_wandb: bool = True
    trajectory_source: str = "db"
    source_dir: str | None = None
    database_url: str = ""
    hf_dataset: str | None = None
    hf_split: str = "raw"
    lookback_hours: int = 72
    min_actions_per_trajectory: int = 1
    max_trajectories: int | None = None
    reward_profile: str = "default"
    resume_from_state: str | None = None


class TinkerRLOrchestrator:
    """Runs Babylon RL using Tinker-backed Atropos training plus Tinker sampling."""

    def __init__(self, config: TinkerRLConfig):
        if not TINKER_AVAILABLE:
            raise RuntimeError("Tinker not installed. Install with: pip install tinker")

        self.config = config
        self.output_dir = Path(config.output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir = self.output_dir / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def _build_trainer(self) -> BabylonTinkerTrainer:
        max_trajectories = self.config.max_trajectories or 1000
        trainer_config = TinkerTrainingConfig(
            base_model=self.config.base_model,
            resume_from_state=self.config.resume_from_state,
            training_steps=max(1, self.config.training_steps),
            group_size=max(2, self.config.group_size),
            learning_rate=self.config.learning_rate,
            lora_rank=max(1, self.config.lora_rank),
            weight_sync_interval=max(1, self.config.weight_sync_interval),
            database_url=self.config.database_url,
            lookback_hours=max(1, self.config.lookback_hours),
            min_actions_per_trajectory=max(1, self.config.min_actions_per_trajectory),
            max_trajectories=max_trajectories,
            log_file=str(self.log_dir / "training_metrics.jsonl"),
            max_trade_examples_per_trajectory=3,
            alignment_passes=max(2, min(6, self.config.training_steps // 6)),
            alignment_score=0.35,
        )
        return BabylonTinkerTrainer(trainer_config)

    def _build_env(self) -> BabylonRLAIFEnv:
        max_trajectories = self.config.max_trajectories or 1000
        env_config = BabylonEnvConfig(
            tokenizer_name=self.config.base_model,
            group_size=max(2, self.config.group_size),
            use_wandb=self.config.use_wandb,
            max_num_workers=64,
            rollout_server_url="http://unused",
            total_steps=max(1, self.config.training_steps),
            batch_size=max(2, self.config.group_size),
            steps_per_eval=max(10, min(100, self.config.training_steps)),
            max_token_length=4096,
            wandb_name="babylon-rlaif-tinker",
            eval_handling=EvalHandlingEnum.LIMIT_TRAIN,
            eval_limit_ratio=0.1,
            trajectory_source=self.config.trajectory_source,
            local_export_dir=self.config.source_dir or "",
            database_url=self.config.database_url,
            hf_trajectory_dataset=self.config.hf_dataset or "",
            hf_trajectory_split=self.config.hf_split,
            lookback_hours=max(1, self.config.lookback_hours),
            min_actions_per_trajectory=max(1, self.config.min_actions_per_trajectory),
            max_trajectories=max_trajectories,
            reward_weight_profile=self.config.reward_profile,
        )
        server_configs = [
            APIServerConfig(
                model_name=self.config.base_model,
                base_url="http://unused/v1",
                api_key="x",
                num_requests_for_eval=64,
            )
        ]
        return BabylonRLAIFEnv(env_config, server_configs, slurm=False, testing=True)

    @staticmethod
    def _extract_tinker_archive(archive_path: Path, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive_path, "r:*") as handle:
            handle.extractall(output_dir)

        if (output_dir / "adapter_config.json").exists():
            return output_dir

        for candidate in output_dir.rglob("adapter_config.json"):
            return candidate.parent

        return output_dir

    async def _download_final_artifacts(
        self,
        trainer: BabylonTinkerTrainer,
        remote_model_ref: str,
    ) -> tuple[Path | None, Path | None]:
        artifact_root = self.output_dir / "tinker_trained"
        archive_path = artifact_root / "checkpoint.tar"
        export_dir = artifact_root / "exported_adapter"
        try:
            downloaded = await trainer.tinker_client.download_checkpoint_archive_async(
                tinker_path=remote_model_ref,
                output_path=archive_path,
            )
            return downloaded, self._extract_tinker_archive(downloaded, export_dir)
        except Exception as exc:
            logger.warning(
                "Failed to download final Tinker RL checkpoint archive for %s: %s",
                remote_model_ref,
                exc,
            )
            return None, None

    @staticmethod
    def _mean(values: list[float]) -> float | None:
        if not values:
            return None
        return round(float(sum(values) / len(values)), 6)

    @staticmethod
    def _selection_messages(prompt_spec: dict[str, Any]) -> list[dict[str, str]]:
        return [
            {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
            {"role": "user", "content": str(prompt_spec.get("prompt", ""))},
        ]

    @staticmethod
    def _selection_rank(summary: dict[str, Any]) -> tuple[float, ...]:
        return (
            1.0 if summary.get("gate_passed") else 0.0,
            float(summary.get("avg_score", 0.0)),
            float(summary.get("policy_alignment_rate", 0.0)),
            float(summary.get("format_rate", 0.0)),
            float(summary.get("action_rate", 0.0)),
            float(summary.get("concrete_cue_rate", 0.0)),
            -float(summary.get("policy_mismatch_rate", 0.0)),
            -float(summary.get("avg_latency_ms", 0.0)),
        )

    async def _evaluate_checkpoint_selection(
        self,
        trainer: BabylonTinkerTrainer,
        *,
        checkpoint_ref: str,
        state_ref: str | None,
        step: int,
        source: str,
    ) -> dict[str, Any]:
        results: list[dict[str, Any]] = []
        prompt_errors: list[str] = []

        for prompt_spec in ACTION_REASON_PROMPTS:
            started = perf_counter()
            completion = ""
            try:
                sample = await trainer.tinker_client.sample_async(
                    messages=self._selection_messages(prompt_spec),
                    max_tokens=128,
                    temperature=0.0,
                    n=1,
                    include_logprobs=False,
                )
                completion = sample.completions[0] if sample.completions else ""
            except Exception as exc:
                prompt_errors.append(f"{prompt_spec.get('id', 'unknown')}: {exc}")

            scored = score_action_reason_response(completion, prompt_spec)
            results.append(
                {
                    "prompt_id": prompt_spec.get("id"),
                    "slice": prompt_spec.get("slice"),
                    "latency_ms": round((perf_counter() - started) * 1000.0, 1),
                    "completion": completion,
                    "score": scored,
                }
            )

        summary = summarize_action_reason_results(results)
        summary["gate_passed"] = passes_action_reason_gate(summary)
        summary["prompt_errors"] = prompt_errors

        return {
            "source": source,
            "step": step,
            "sampler_path": checkpoint_ref,
            "state_path": state_ref,
            "summary": summary,
            "rank": self._selection_rank(summary),
            "gate_passed": summary["gate_passed"],
        }

    def _summarize_metrics(
        self,
        trainer: BabylonTinkerTrainer,
        env: BabylonRLAIFEnv,
        *,
        windows_processed: int,
        skipped_batches: int,
    ) -> dict[str, Any]:
        losses = [float(metric.loss) for metric in trainer.all_metrics]
        avg_scores = [float(metric.avg_score) for metric in trainer.all_metrics]
        format_scores = [float(score) for score in env.judge_format_scores]
        reasoning_scores = [float(score) for score in env.judge_reasoning_scores]
        reward_scores = [float(score) for score in env.judge_scores_buffer]

        last_metrics = trainer.all_metrics[-1] if trainer.all_metrics else None
        return {
            "steps_completed": len(trainer.all_metrics),
            "windows_processed": windows_processed,
            "skipped_batches": skipped_batches,
            "loss_last": float(last_metrics.loss) if last_metrics else None,
            "loss_mean": self._mean(losses),
            "avg_score_last": float(last_metrics.avg_score) if last_metrics else None,
            "avg_score_mean": self._mean(avg_scores),
            "judge_reward_mean": self._mean(reward_scores),
            "format_score_mean": self._mean(format_scores),
            "reasoning_score_mean": self._mean(reasoning_scores),
        }

    async def run(self) -> dict[str, Any]:
        trainer = self._build_trainer()
        env = self._build_env()

        await trainer.setup_for_scored_groups()
        env.tinker_client = trainer.tinker_client
        await env.setup()

        initial_sampler_path = trainer.tinker_client.initial_sampler_path
        initial_state_path = trainer.tinker_client.current_state_path
        latest_sampler_path = initial_sampler_path
        latest_state_path = initial_state_path
        windows_processed = 0
        skipped_batches = 0
        checkpoint_candidates: list[dict[str, Any]] = []

        try:
            if not env.trajectory_cache:
                raise RuntimeError("No RL trajectory groups were available for Tinker RL")

            for step in range(max(1, self.config.training_steps)):
                trainer.current_step = step + 1
                item = await env.get_next_item()
                if item is None:
                    skipped_batches += 1
                    continue

                score_start = len(env.judge_scores_buffer)
                scored_group, _ = await env.collect_trajectories(item)
                raw_scores = [float(score) for score in env.judge_scores_buffer[score_start:]]
                if not scored_group:
                    skipped_batches += 1
                    continue

                metrics = await trainer.train_on_scored_data_group(
                    scored_group,
                    raw_scores=raw_scores or None,
                )
                if metrics is None:
                    skipped_batches += 1
                    continue

                windows_processed += 1
                metrics.windows_processed = windows_processed
                trainer.log_metrics(metrics)

                if trainer.current_step % max(1, self.config.weight_sync_interval) == 0:
                    latest_sampler_path = await trainer.tinker_client.sync_weights_async(
                        name=f"babylon-rl-{trainer.run_id}-step-{trainer.current_step}"
                    )
                    latest_state_path = await trainer.tinker_client.save_state_async(
                        name=f"babylon-rl-{trainer.run_id}-step-{trainer.current_step}-state"
                    )
                    checkpoint_candidates.append(
                        await self._evaluate_checkpoint_selection(
                            trainer,
                            checkpoint_ref=latest_sampler_path,
                            state_ref=latest_state_path,
                            step=trainer.current_step,
                            source="interval",
                        )
                    )

            final_name = f"babylon-rl-{trainer.run_id}-final"
            latest_sampler_path = await trainer.tinker_client.sync_weights_async(name=final_name)
            latest_state_path = await trainer.tinker_client.save_state_async(
                name=f"{final_name}-state"
            )
            checkpoint_candidates.append(
                await self._evaluate_checkpoint_selection(
                    trainer,
                    checkpoint_ref=latest_sampler_path,
                    state_ref=latest_state_path,
                    step=trainer.current_step,
                    source="final",
                )
            )

            selected_checkpoint = max(
                checkpoint_candidates,
                key=lambda candidate: candidate["rank"],
            )

            selected_materialized_sampler = selected_checkpoint["sampler_path"]
            selected_materialized_state = selected_checkpoint["state_path"]
            if selected_materialized_state and (
                selected_materialized_state != trainer.tinker_client.current_state_path
            ):
                await trainer.tinker_client.load_state_async(selected_materialized_state)
                selected_materialized_sampler = (
                    trainer.tinker_client.current_sampler_path or selected_materialized_sampler
                )
                selected_materialized_state = (
                    trainer.tinker_client.current_state_path or selected_materialized_state
                )

            archive_path: Path | None = None
            export_dir: Path | None = None
            if selected_materialized_sampler:
                archive_path, export_dir = await self._download_final_artifacts(
                    trainer,
                    selected_materialized_sampler,
                )

            final_metrics = self._summarize_metrics(
                trainer,
                env,
                windows_processed=windows_processed,
                skipped_batches=skipped_batches,
            )
            selected_summary = selected_checkpoint.get("summary", {})
            selected_reward = float(selected_summary.get("avg_score", 0.0) or 0.0)

            report = {
                "success": True,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "base_model": self.config.base_model,
                "resume_from_state": self.config.resume_from_state,
                "steps_requested": self.config.training_steps,
                "steps_completed": len(trainer.all_metrics),
                "windows_processed": windows_processed,
                "skipped_batches": skipped_batches,
                "initial_sampler_path": initial_sampler_path,
                "final_synced_sampler_path": latest_sampler_path,
                "final_synced_state_path": latest_state_path,
                "selected_checkpoint_ref": selected_checkpoint["sampler_path"],
                "selected_checkpoint_state_ref": selected_checkpoint["state_path"],
                "selected_checkpoint_materialized_ref": selected_materialized_sampler,
                "selected_checkpoint_source": selected_checkpoint["source"],
                "selected_checkpoint_step": selected_checkpoint["step"],
                "initial_state_path": initial_state_path,
                "final_sampler_path": selected_materialized_sampler,
                "final_state_path": selected_materialized_state,
                "downloaded_checkpoint_archive": str(archive_path) if archive_path else None,
                "downloaded_adapter_path": str(export_dir) if export_dir else None,
                "metrics_file": trainer.config.log_file if trainer.config.log_to_file else None,
                "final_reward": selected_reward,
                "final_metrics": final_metrics,
                "selection_strategy": "deterministic_action_reason_eval",
                "selection_summary": selected_summary,
                "selection_candidates": [
                    {
                        "source": candidate["source"],
                        "step": candidate["step"],
                        "sampler_path": candidate["sampler_path"],
                        "state_path": candidate["state_path"],
                        "gate_passed": candidate["gate_passed"],
                        "rank": list(candidate["rank"]),
                        "summary": candidate["summary"],
                    }
                    for candidate in checkpoint_candidates
                ],
            }
            report_path = self.output_dir / "post_training_report.json"
            report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            report["report_path"] = str(report_path)
            return report
        finally:
            await env.cleanup()
            await trainer.cleanup()
