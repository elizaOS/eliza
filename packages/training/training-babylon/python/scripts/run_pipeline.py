#!/usr/bin/env python3
"""
Babylon canonical training pipeline.

This script is the user-facing orchestrator for the current project pipeline:

1. Load and score real trajectories
2. Run local SFT training (or prepare-only when requested)
3. Run deterministic served-model comparison for MLX adapters
4. Run RL training when the environment supports it
5. Run ScamBench on the latest benchmarkable artifact

The pipeline writes a machine-readable `pipeline_report.json` that records
which stages ran, which ones were skipped, and why.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Literal

SCRIPT_DIR = Path(__file__).resolve().parent


def _find_ancestor_with_child(start: Path, child: str) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / child).exists():
            return candidate
    raise RuntimeError(f"Could not locate ancestor containing {child!r} from {start}")


def _find_workspace_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / "scambench").exists() or (candidate / "benchmarks" / "scambench").exists():
            return candidate
    raise RuntimeError(f"Could not locate workspace root containing ScamBench from {start}")


def _resolve_scambench_root(workspace_root: Path) -> Path:
    candidates = [
        workspace_root / "scambench",
        workspace_root / "benchmarks" / "scambench",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


PYTHON_ROOT = SCRIPT_DIR.parent
REPO_ROOT = _find_ancestor_with_child(SCRIPT_DIR, "packages/training")
WORKSPACE_ROOT = _find_workspace_root(SCRIPT_DIR)
SCAMBENCH_ROOT = _resolve_scambench_root(WORKSPACE_ROOT)
LOCAL_SCAMBENCH_SCRIPT = SCRIPT_DIR / "run_scambench_local.py"

sys.path.insert(0, str(PYTHON_ROOT))
sys.path.insert(0, str(SCRIPT_DIR))

from compare_local_models import generate_comparison_report as generate_local_comparison_report
from compare_served_models import (
    generate_tinker_proxy_comparison_report,
    pick_served_model_id,
    terminate_process,
    wait_for_server,
)
from local_training_recipe import (
    LocalTrainingRecipe,
    add_local_training_arguments,
    local_training_recipe_from_args,
)
from run_full_pipeline import FullPipeline
from run_training import TrainingOrchestrator, validate_environment

if TYPE_CHECKING:
    from src.training.tinker_rl_orchestrator import TinkerRLConfig, TinkerRLOrchestrator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

TinkerRLConfig: Any = None
TinkerRLOrchestrator: Any = None
DEFAULT_ALERT_WEBHOOK_ENV = "CANONICAL_PIPELINE_ALERT_WEBHOOK_URL"
ALERTABLE_STAGE_STATUSES = {"failed", "timed_out"}
INCOMPLETE_STAGE_STATUSES = {"pending", "in_progress"}


def _load_tinker_rl_orchestrator():
    global TinkerRLConfig, TinkerRLOrchestrator
    if TinkerRLOrchestrator is not None and TinkerRLConfig is None:
        return SimpleNamespace, TinkerRLOrchestrator
    if TinkerRLConfig is None or TinkerRLOrchestrator is None:
        from src.training.tinker_rl_orchestrator import (
            TinkerRLConfig as LoadedTinkerRLConfig,
        )
        from src.training.tinker_rl_orchestrator import (
            TinkerRLOrchestrator as LoadedTinkerRLOrchestrator,
        )

        TinkerRLConfig = LoadedTinkerRLConfig
        TinkerRLOrchestrator = LoadedTinkerRLOrchestrator

    return TinkerRLConfig, TinkerRLOrchestrator


class CanonicalPipeline:
    """Canonical project pipeline orchestrator."""

    def __init__(
        self,
        *,
        mode: Literal["full", "train", "benchmark"] = "full",
        model_name: str = "Qwen/Qwen3.5-4B",
        num_agents: int = 10,
        ticks_per_agent: int = 30,
        output_dir: str = "./trained_models",
        use_wandb: bool = True,
        local_training_enabled: bool = True,
        local_training_backend: Literal["mlx", "cuda", "cpu"] | None = None,
        local_training_model: str | None = None,
        local_training_sample_profile: str = "canonical",
        training_backend: Literal["auto", "local", "tinker"] = "auto",
        trajectory_source: Literal["db", "huggingface", "local_export"] | None = None,
        source_dir: str | None = None,
        hf_dataset: str | None = None,
        hf_split: str = "raw",
        local_training_steps: int = 5,
        local_training_batch_size: int = 1,
        local_training_learning_rate: float = 1e-5,
        local_training_optimizer: Literal["adamw", "apollo"] = "adamw",
        local_training_quantization: Literal["none", "nf4"] = "none",
        local_training_use_lora: bool = True,
        local_training_lora_rank: int = 16,
        local_training_lora_alpha: int = 32,
        local_training_lora_dropout: float = 0.1,
        local_training_lora_target_modules: list[str] | None = None,
        local_training_max_seq_length: int = 1024,
        local_training_gradient_accumulation_steps: int = 1,
        local_training_seed: int = 1337,
        local_training_eval_split_ratio: float = 0.1,
        local_validate: bool = True,
        lookback_hours: int = 72,
        min_actions: int = 1,
        max_trajectories: int | None = None,
        tinker_steps: int = 100,
        tinker_group_size: int = 4,
        tinker_learning_rate: float = 4e-5,
        tinker_lora_rank: int = 32,
        tinker_weight_sync_interval: int = 5,
        skip_rl: bool = False,
        require_rl: bool = False,
        rl_steps: int = 100,
        rl_batch_size: int = 4,
        rl_learning_rate: float = 1e-5,
        reward_profile: str = "default",
        skip_scambench: bool = False,
        scambench_mode: Literal["auto", "smoke", "full"] = "auto",
        scambench_scenario_limit: int = 4,
        rl_served_eval_timeout_seconds: int = 600,
        scambench_timeout_seconds: int = 900,
        served_eval_min_delta: float = 0.01,
        served_eval_min_trained_avg_score: float = 0.9,
        scambench_min_delta: float = 0.5,
        max_timeout_delta: int = 0,
        max_handler_error_delta: int = 0,
        allow_mismatched_reuse: bool = False,
        alert_webhook_url: str | None = None,
        format_recovery_dir: str | None = None,
        format_recovery_ratio: float = 0.05,
    ):
        self.mode = mode
        self.model_name = model_name
        self.num_agents = num_agents
        self.ticks_per_agent = ticks_per_agent
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.use_wandb = use_wandb
        self.local_training_enabled = local_training_enabled
        self.training_backend = training_backend
        self.trajectory_source = trajectory_source or ("huggingface" if hf_dataset else "db")
        self.source_dir = source_dir
        self.hf_dataset = hf_dataset.strip() if hf_dataset else None
        self.hf_split = hf_split.strip() or "raw"
        self.local_training_recipe = LocalTrainingRecipe.from_values(
            backend=local_training_backend,
            model=local_training_model,
            sample_profile=local_training_sample_profile,
            steps=local_training_steps,
            batch_size=local_training_batch_size,
            learning_rate=local_training_learning_rate,
            optimizer=local_training_optimizer,
            quantization=local_training_quantization,
            use_lora=local_training_use_lora,
            lora_rank=local_training_lora_rank,
            lora_alpha=local_training_lora_alpha,
            lora_dropout=local_training_lora_dropout,
            lora_target_modules=local_training_lora_target_modules,
            max_seq_length=local_training_max_seq_length,
            gradient_accumulation_steps=local_training_gradient_accumulation_steps,
            seed=local_training_seed,
            eval_split_ratio=local_training_eval_split_ratio,
        )
        for attribute, value in self.local_training_recipe.to_prefixed_dict(
            "local_training"
        ).items():
            setattr(self, attribute, value)
        self.local_validate = local_validate
        self.lookback_hours = max(1, lookback_hours)
        self.min_actions = max(1, min_actions)
        self.max_trajectories = (
            max_trajectories if max_trajectories and max_trajectories > 0 else None
        )
        self.tinker_steps = max(1, tinker_steps)
        self.tinker_group_size = max(2, tinker_group_size)
        self.tinker_learning_rate = tinker_learning_rate
        self.tinker_lora_rank = max(1, tinker_lora_rank)
        self.tinker_weight_sync_interval = max(1, tinker_weight_sync_interval)
        self.skip_rl = skip_rl
        self.require_rl = require_rl
        self.rl_steps = max(0, rl_steps)
        self.rl_batch_size = max(1, rl_batch_size)
        self.rl_learning_rate = rl_learning_rate
        self.reward_profile = reward_profile
        self.skip_scambench = skip_scambench
        self.scambench_mode = scambench_mode
        self.scambench_scenario_limit = max(1, scambench_scenario_limit)
        self.rl_served_eval_timeout_seconds = max(1, rl_served_eval_timeout_seconds)
        self.scambench_timeout_seconds = max(1, scambench_timeout_seconds)
        self.served_eval_min_delta = served_eval_min_delta
        self.served_eval_min_trained_avg_score = served_eval_min_trained_avg_score
        self.scambench_min_delta = scambench_min_delta
        self.max_timeout_delta = max_timeout_delta
        self.max_handler_error_delta = max_handler_error_delta
        self.allow_mismatched_reuse = allow_mismatched_reuse
        self.format_recovery_dir = format_recovery_dir
        self.format_recovery_ratio = max(0.0, min(1.0, format_recovery_ratio))
        configured_webhook = (
            alert_webhook_url or os.environ.get(DEFAULT_ALERT_WEBHOOK_ENV, "")
        ).strip()
        self.alert_webhook_url = configured_webhook or None
        self._alerted_event_keys: set[str] = set()
        self.run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        self.run_dir = self.output_dir / "runs" / self.run_id
        self.run_dir.mkdir(parents=True, exist_ok=True)

        self.sft_pipeline: FullPipeline | None = None
        self._resolved_sft_artifacts: dict[str, Any] | None = None
        self.pipeline_report: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "run": {
                "run_id": self.run_id,
                "output_dir": str(self.output_dir),
                "run_dir": str(self.run_dir),
            },
            "mode": self.mode,
            "config": {
                "model_name": self.model_name,
                "num_agents": self.num_agents,
                "ticks_per_agent": self.ticks_per_agent,
                "output_dir": str(self.output_dir),
                "training_backend": self.training_backend,
                **self.local_training_recipe.to_prefixed_dict("local_training"),
                "trajectory_source": self.trajectory_source,
                "source_dir": self.source_dir,
                "hf_dataset": self.hf_dataset,
                "hf_split": self.hf_split if self.trajectory_source == "huggingface" else None,
                "tinker_steps": self.tinker_steps,
                "tinker_group_size": self.tinker_group_size,
                "tinker_learning_rate": self.tinker_learning_rate,
                "tinker_lora_rank": self.tinker_lora_rank,
                "tinker_weight_sync_interval": self.tinker_weight_sync_interval,
                "lookback_hours": self.lookback_hours,
                "min_actions": self.min_actions,
                "max_trajectories": self.max_trajectories,
                "reward_profile": self.reward_profile,
                "skip_rl": self.skip_rl,
                "rl_steps": self.rl_steps,
                "skip_scambench": self.skip_scambench,
                "scambench_mode": self.scambench_mode,
                "scambench_scenario_limit": self.scambench_scenario_limit,
                "rl_served_eval_timeout_seconds": self.rl_served_eval_timeout_seconds,
                "scambench_timeout_seconds": self.scambench_timeout_seconds,
                "served_eval_min_delta": self.served_eval_min_delta,
                "served_eval_min_trained_avg_score": self.served_eval_min_trained_avg_score,
                "scambench_min_delta": self.scambench_min_delta,
                "max_timeout_delta": self.max_timeout_delta,
                "max_handler_error_delta": self.max_handler_error_delta,
                "allow_mismatched_reuse": self.allow_mismatched_reuse,
                "alerting_enabled": bool(self.alert_webhook_url),
                "alert_webhook_env": (
                    DEFAULT_ALERT_WEBHOOK_ENV if self.alert_webhook_url else None
                ),
            },
            "stages": {
                "sft": {"status": "pending"},
                "served_eval": {"status": "pending"},
                "rl": {"status": "pending"},
                "rl_served_eval": {"status": "pending"},
                "scambench": {"status": "pending"},
            },
            "artifacts": {},
            "artifact_versions": {},
        }

    def _report_path(self) -> Path:
        return self.output_dir / "pipeline_report.json"

    def _versioned_report_path(self) -> Path:
        return self.run_dir / "pipeline_report.json"

    def _stage_output_dir(self) -> Path:
        return self.run_dir

    def _existing_artifact_root(self) -> Path:
        run_root = self.output_dir / "runs"
        candidates: list[Path] = []
        if run_root.exists():
            candidates = [
                candidate
                for candidate in sorted(
                    run_root.iterdir(),
                    key=lambda path: path.name,
                    reverse=True,
                )
                if candidate.is_dir()
            ]
        for candidate in candidates:
            if candidate == self.run_dir:
                continue
            if (candidate / "training_manifest.json").exists():
                return candidate
            if (candidate / "rl" / "post_training_report.json").exists():
                return candidate
        return self.run_dir if self.mode != "benchmark" else self.output_dir

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _looks_like_path(value: str) -> bool:
        return value.startswith("/") or value.startswith("./") or value.startswith("../")

    def _resolved_scambench_mode(self) -> Literal["smoke", "full"]:
        if self.scambench_mode in {"smoke", "full"}:
            return self.scambench_mode
        return "full" if self.mode == "full" else "smoke"

    def _resolved_scambench_scenario_limit(self) -> int | None:
        if self._resolved_scambench_mode() != "smoke":
            return None
        return self.scambench_scenario_limit

    @staticmethod
    def _safe_float(value: Any) -> float | None:
        try:
            if value is None:
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _safe_int(value: Any) -> int | None:
        try:
            if value is None:
                return None
            return int(value)
        except (TypeError, ValueError):
            return None

    def _normalize_served_eval_stage(
        self,
        stage: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
        summary = stage.get("summary")
        source = summary if isinstance(summary, dict) else stage
        base_summary = source.get("base_summary")
        trained_summary = source.get("trained_summary")
        comparison = source.get("comparison")
        return (
            base_summary if isinstance(base_summary, dict) else None,
            trained_summary if isinstance(trained_summary, dict) else None,
            comparison if isinstance(comparison, dict) else None,
        )

    def _evaluate_served_eval_gate(
        self,
        stage: dict[str, Any],
    ) -> dict[str, Any]:
        base_summary, trained_summary, comparison = self._normalize_served_eval_stage(stage)
        avg_score_delta = self._safe_float((comparison or {}).get("avg_score_delta"))
        trained_avg_score = self._safe_float((trained_summary or {}).get("avg_score"))
        base_format_rate = self._safe_float((base_summary or {}).get("format_rate"))
        trained_format_rate = self._safe_float((trained_summary or {}).get("format_rate"))
        distinct_response_count = self._safe_int((comparison or {}).get("distinct_response_count"))
        blocking_reasons: list[str] = []

        if stage.get("status") != "completed":
            blocking_reasons.append("stage_not_completed")
        if avg_score_delta is None:
            blocking_reasons.append("missing_avg_score_delta")
        elif avg_score_delta < self.served_eval_min_delta:
            blocking_reasons.append("avg_score_delta_below_threshold")
        if trained_avg_score is None:
            blocking_reasons.append("missing_trained_avg_score")
        elif trained_avg_score < self.served_eval_min_trained_avg_score:
            blocking_reasons.append("trained_avg_score_below_threshold")
        if (
            base_format_rate is not None
            and trained_format_rate is not None
            and trained_format_rate < base_format_rate
        ):
            blocking_reasons.append("format_rate_regressed")
        if distinct_response_count is None:
            blocking_reasons.append("missing_distinct_response_count")
        elif distinct_response_count <= 0:
            blocking_reasons.append("no_distinct_responses")

        return {
            "status": stage.get("status"),
            "avg_score_delta": avg_score_delta,
            "trained_avg_score": trained_avg_score,
            "base_format_rate": base_format_rate,
            "trained_format_rate": trained_format_rate,
            "distinct_response_count": distinct_response_count,
            "min_delta": self.served_eval_min_delta,
            "min_trained_avg_score": self.served_eval_min_trained_avg_score,
            "passed": not blocking_reasons,
            "blocking_reasons": blocking_reasons,
        }

    def _evaluate_scambench_gate(self, stage: dict[str, Any]) -> dict[str, Any]:
        comparison = stage.get("comparison")
        if not isinstance(comparison, dict):
            comparison = {}
        fallback_errors = stage.get("fallback_errors")
        if not isinstance(fallback_errors, list):
            fallback_errors = []
        overall_score_delta = self._safe_float(comparison.get("overall_score_delta"))
        timeout_count_delta = self._safe_int(comparison.get("timeout_count_delta"))
        handler_error_count_delta = self._safe_int(comparison.get("handler_error_count_delta"))
        blocking_reasons: list[str] = []

        if stage.get("status") != "completed":
            blocking_reasons.append("stage_not_completed")
        if overall_score_delta is None:
            blocking_reasons.append("missing_overall_score_delta")
        elif overall_score_delta < self.scambench_min_delta:
            blocking_reasons.append("overall_score_delta_below_threshold")
        if timeout_count_delta is None:
            blocking_reasons.append("missing_timeout_count_delta")
        elif timeout_count_delta > self.max_timeout_delta:
            blocking_reasons.append("timeout_count_regressed")
        if handler_error_count_delta is None:
            blocking_reasons.append("missing_handler_error_count_delta")
        elif handler_error_count_delta > self.max_handler_error_delta:
            blocking_reasons.append("handler_error_count_regressed")
        if fallback_errors:
            blocking_reasons.append("fallback_errors_present")

        return {
            "status": stage.get("status"),
            "benchmark_source": stage.get("benchmark_source"),
            "mode": stage.get("mode"),
            "scenario_limit": stage.get("scenario_limit"),
            "overall_score_delta": overall_score_delta,
            "timeout_count_delta": timeout_count_delta,
            "handler_error_count_delta": handler_error_count_delta,
            "fallback_error_count": len(fallback_errors),
            "min_delta": self.scambench_min_delta,
            "max_timeout_delta": self.max_timeout_delta,
            "max_handler_error_delta": self.max_handler_error_delta,
            "passed": not blocking_reasons,
            "blocking_reasons": blocking_reasons,
        }

    def _evaluate_artifact_validation(self, stages: dict[str, Any]) -> dict[str, Any]:
        requested_model = self.model_name
        sft_stage = stages.get("sft", {})
        rl_stage = stages.get("rl", {})
        warnings: list[str] = []

        sft_lineage_model = sft_stage.get("lineage_model_name") or sft_stage.get("base_model")
        sft_lineage_match: bool | None = None
        if (
            sft_stage.get("status") == "reused"
            and isinstance(sft_lineage_model, str)
            and sft_lineage_model
        ):
            sft_lineage_match = requested_model == sft_lineage_model
            if not sft_lineage_match:
                warnings.append(
                    f"Requested model {requested_model} does not match reused SFT lineage {sft_lineage_model}"
                )

        rl_lineage_model = rl_stage.get("lineage_model_name") or rl_stage.get("model_name")
        rl_lineage_match: bool | None = None
        if (
            rl_stage.get("status") == "reused"
            and isinstance(rl_lineage_model, str)
            and rl_lineage_model
            and not self._looks_like_path(rl_lineage_model)
        ):
            rl_lineage_match = requested_model == rl_lineage_model
            if not rl_lineage_match:
                warnings.append(
                    f"Requested model {requested_model} does not match reused RL lineage {rl_lineage_model}"
                )

        provenance_complete = not bool(rl_stage.get("legacy_artifact"))
        if rl_stage.get("status") == "reused" and not provenance_complete:
            warnings.append(
                "Reused RL artifact predates checkpoint-selection metadata and is not promotion-safe"
            )

        return {
            "requested_model_name": requested_model,
            "sft_lineage_model_name": sft_lineage_model,
            "rl_lineage_model_name": rl_lineage_model,
            "sft_lineage_match": sft_lineage_match,
            "rl_lineage_match": rl_lineage_match,
            "rl_provenance_complete": provenance_complete,
            "passed": (
                (sft_lineage_match is not False)
                and (rl_lineage_match is not False)
                and provenance_complete
            ),
            "warnings": warnings,
        }

    def _update_quality_gates(self) -> None:
        stages = self.pipeline_report.get("stages", {})
        sft_eval = stages.get("served_eval", {})
        rl_eval = stages.get("rl_served_eval", {})
        scambench = stages.get("scambench", {})
        sft_gate = self._evaluate_served_eval_gate(sft_eval)
        rl_gate = self._evaluate_served_eval_gate(rl_eval)
        scambench_gate = self._evaluate_scambench_gate(scambench)
        artifact_validation = self._evaluate_artifact_validation(stages)
        served_eval_passed = sft_gate["passed"] and rl_gate["passed"]

        self.pipeline_report["quality_gates"] = {
            "thresholds": {
                "served_eval_min_delta": self.served_eval_min_delta,
                "served_eval_min_trained_avg_score": self.served_eval_min_trained_avg_score,
                "scambench_min_delta": self.scambench_min_delta,
                "max_timeout_delta": self.max_timeout_delta,
                "max_handler_error_delta": self.max_handler_error_delta,
            },
            "served_eval": {
                "sft": sft_gate,
                "rl": rl_gate,
                "both_completed": sft_eval.get("status") == "completed"
                and rl_eval.get("status") == "completed",
                "both_passed": served_eval_passed,
            },
            "scambench": scambench_gate,
            "artifact_validation": artifact_validation,
            "promotion_ready": bool(
                served_eval_passed and scambench_gate["passed"] and artifact_validation["passed"]
            ),
        }

    def _fail_on_unsafe_reuse(self) -> None:
        artifact_validation = self._evaluate_artifact_validation(
            self.pipeline_report.get("stages", {})
        )
        mismatch_warnings = [
            warning
            for warning in artifact_validation.get("warnings", [])
            if "does not match reused" in str(warning)
        ]
        rl_stage = self.pipeline_report.get("stages", {}).get("rl", {})
        legacy_warning = None
        if rl_stage.get("status") == "reused" and rl_stage.get("legacy_artifact"):
            legacy_warning = (
                "Reused RL artifact predates checkpoint-selection metadata and must be regenerated"
            )

        blocked_warnings: list[str] = []
        reason: str | None = None
        message: str | None = None

        if mismatch_warnings and not self.allow_mismatched_reuse:
            blocked_warnings.extend(mismatch_warnings)
            reason = "mismatched_reused_artifact"
            message = (
                "Benchmark reuse refused because the requested model does not match the reused artifact lineage. "
                "Rerun with --allow-mismatched-reuse to inspect the mismatched artifact intentionally."
            )

        if legacy_warning:
            blocked_warnings.append(legacy_warning)
            reason = "legacy_reused_rl_artifact"
            message = (
                "Benchmark reuse refused because the reused RL artifact predates checkpoint-selection metadata. "
                "Rerun RL to create a current reusable artifact."
            )

        if not blocked_warnings or reason is None or message is None:
            return

        self.pipeline_report["reuse_validation"] = {
            "status": "blocked",
            "reason": reason,
            "warnings": blocked_warnings,
            "allow_mismatched_reuse": self.allow_mismatched_reuse,
            "timestamp": self._timestamp(),
        }
        self._write_report()
        raise RuntimeError(message)

    def _write_report(self) -> None:
        self.pipeline_report["timestamp"] = datetime.now(timezone.utc).isoformat()
        self._update_quality_gates()
        self._write_report_files()
        self._maybe_send_alerts()

    def _write_report_files(self) -> None:
        report_json = json.dumps(self.pipeline_report, indent=2)
        self._report_path().write_text(report_json, encoding="utf-8")
        self._versioned_report_path().write_text(report_json, encoding="utf-8")

    def _build_alert_events(self) -> list[tuple[str, dict[str, Any]]]:
        events: list[tuple[str, dict[str, Any]]] = []

        reuse_validation = self.pipeline_report.get("reuse_validation")
        if isinstance(reuse_validation, dict) and reuse_validation.get("status") == "blocked":
            reason = str(reuse_validation.get("reason") or "blocked")
            events.append(
                (
                    f"reuse_validation:{reason}",
                    {
                        "level": "critical",
                        "category": "reuse_validation",
                        "reason": reason,
                        "details": reuse_validation,
                    },
                )
            )

        stages = self.pipeline_report.get("stages")
        stage_payloads: list[tuple[str, dict[str, Any]]] = []
        if isinstance(stages, dict):
            for stage_name, stage_payload in stages.items():
                if not isinstance(stage_payload, dict):
                    continue
                stage_payloads.append((stage_name, stage_payload))
                status = str(stage_payload.get("status") or "")
                if status not in ALERTABLE_STAGE_STATUSES:
                    continue
                reason = str(stage_payload.get("reason") or status)
                events.append(
                    (
                        f"stage:{stage_name}:{status}:{reason}",
                        {
                            "level": "critical",
                            "category": "stage",
                            "stage": stage_name,
                            "status": status,
                            "reason": reason,
                            "details": stage_payload,
                        },
                    )
                )

        quality_gates = self.pipeline_report.get("quality_gates")
        if (
            isinstance(quality_gates, dict)
            and quality_gates.get("promotion_ready") is False
            and stage_payloads
            and all(
                str(stage_payload.get("status") or "") not in INCOMPLETE_STAGE_STATUSES
                for _, stage_payload in stage_payloads
            )
        ):
            events.append(
                (
                    "quality_gates:promotion_blocked",
                    {
                        "level": "warning",
                        "category": "quality_gates",
                        "reason": "promotion_blocked",
                        "details": quality_gates,
                    },
                )
            )

        return events

    def _alert_webhook_label(self) -> str:
        if not self.alert_webhook_url:
            return ""
        target = urllib.parse.urlsplit(self.alert_webhook_url)
        if target.scheme and target.netloc:
            return f"{target.scheme}://{target.netloc}"
        return "<configured>"

    def _send_alert_event(
        self,
        event_key: str,
        event_payload: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.alert_webhook_url:
            raise ValueError("Alert webhook URL is not configured")

        request = urllib.request.Request(
            self.alert_webhook_url,
            data=json.dumps(
                {
                    "sent_at": self._timestamp(),
                    "run_id": self.run_id,
                    "mode": self.mode,
                    "report_path": str(self._report_path()),
                    "event_key": event_key,
                    "event": event_payload,
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            response_body = response.read().decode("utf-8").strip()
            return {
                "status": "delivered",
                "status_code": response.getcode(),
                "response_body": response_body,
            }

    def _maybe_send_alerts(self) -> None:
        if not self.alert_webhook_url:
            return

        deliveries = self.pipeline_report.get("alert_deliveries")
        if not isinstance(deliveries, dict):
            deliveries = {}
            self.pipeline_report["alert_deliveries"] = deliveries

        events = self._build_alert_events()
        if not events:
            return

        webhook_target = self._alert_webhook_label()

        for event_key, event_payload in events:
            if event_key in self._alerted_event_keys:
                continue
            try:
                delivery = self._send_alert_event(event_key, event_payload)
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
                logger.error(
                    "Canonical pipeline alert delivery failed for %s: %s",
                    webhook_target,
                    exc,
                )
                deliveries[event_key] = {
                    "status": "failed",
                    "webhook_target": webhook_target,
                    "error": str(exc),
                    "event": event_payload,
                    "updated_at": self._timestamp(),
                }
            else:
                deliveries[event_key] = {
                    **delivery,
                    "webhook_target": webhook_target,
                    "event": event_payload,
                    "updated_at": self._timestamp(),
                }
            self._alerted_event_keys.add(event_key)

        if deliveries:
            self._write_report_files()

    def _set_stage(self, stage: str, **payload: Any) -> None:
        existing = self.pipeline_report.setdefault("stages", {}).get(stage, {})
        timestamp = self._timestamp()
        if (
            isinstance(existing, dict)
            and existing.get("started_at")
            and "started_at" not in payload
        ):
            payload["started_at"] = existing["started_at"]
        payload["updated_at"] = timestamp
        status = payload.get("status")
        if status == "in_progress":
            payload.setdefault("started_at", timestamp)
        elif status not in {None, "pending", "in_progress"}:
            payload.setdefault("completed_at", timestamp)
        self.pipeline_report.setdefault("stages", {})[stage] = payload
        self._write_report()

    def _start_stage(self, stage: str, **payload: Any) -> None:
        existing = self.pipeline_report.get("stages", {}).get(stage, {})
        self._set_stage(
            stage,
            status="in_progress",
            started_at=(existing or {}).get("started_at") or self._timestamp(),
            **payload,
        )

    def _record_artifact(self, key: str, value: Any) -> None:
        self.pipeline_report.setdefault("artifacts", {})[key] = value
        self.pipeline_report.setdefault("artifact_versions", {}).setdefault(key, []).append(
            {
                "run_id": self.run_id,
                "path": value,
            }
        )
        self._write_report()

    def _fail_active_stages(self, reason: str) -> None:
        stages = self.pipeline_report.get("stages")
        if not isinstance(stages, dict):
            return
        timestamp = self._timestamp()
        for stage_name, stage_payload in stages.items():
            if not isinstance(stage_payload, dict):
                continue
            if stage_payload.get("status") != "in_progress":
                continue
            stage_payload["status"] = "failed"
            stage_payload["reason"] = reason
            stage_payload["updated_at"] = timestamp
            stage_payload.setdefault("completed_at", timestamp)
            stages[stage_name] = stage_payload

    def _build_full_pipeline(self, *, output_dir: Path) -> FullPipeline:
        return FullPipeline(
            model_name=self.model_name,
            num_agents=self.num_agents,
            ticks_per_agent=self.ticks_per_agent,
            output_dir=str(output_dir),
            use_wandb=self.use_wandb,
            skip_benchmark=True,
            local_training_enabled=self.local_training_enabled,
            training_backend_preference=self.training_backend,
            trajectory_source=self.trajectory_source,
            source_dir=self.source_dir,
            hf_dataset=self.hf_dataset,
            hf_split=self.hf_split,
            tinker_training_steps=self.tinker_steps,
            tinker_group_size=self.tinker_group_size,
            tinker_learning_rate=self.tinker_learning_rate,
            tinker_lora_rank=self.tinker_lora_rank,
            tinker_weight_sync_interval=self.tinker_weight_sync_interval,
            local_validate=self.local_validate,
            lookback_hours=self.lookback_hours,
            min_actions=self.min_actions,
            max_trajectories=self.max_trajectories,
            format_recovery_dir=self.format_recovery_dir,
            format_recovery_ratio=self.format_recovery_ratio,
            **self.local_training_recipe.to_prefixed_dict("local_training"),
        )

    def _load_existing_sft_pipeline(self) -> FullPipeline:
        artifact_root = self._existing_artifact_root()
        pipeline = self._build_full_pipeline(output_dir=artifact_root)
        pipeline._load_existing_training_artifact()
        return pipeline

    def _load_existing_rl_stage(self) -> dict[str, Any] | None:
        artifact_root = self._existing_artifact_root()
        report_path = artifact_root / "rl" / "post_training_report.json"
        if not report_path.exists():
            return None

        payload = self._load_json(report_path)
        if not isinstance(payload, dict) or not payload.get("success"):
            return None

        legacy_artifact = not (
            payload.get("selected_checkpoint_ref")
            and payload.get("selection_summary")
            and payload.get("selection_strategy")
        )
        warnings: list[str] = []
        provenance_status = "complete"
        if legacy_artifact:
            warnings.append("Reused RL artifact predates checkpoint-selection metadata")
            provenance_status = "legacy_missing_selection_metadata"

        return {
            "status": "reused",
            "model_name": payload.get("base_model") or self.model_name,
            "lineage_model_name": payload.get("base_model") or self.model_name,
            "save_path": str(report_path.parent),
            "final_model_path": payload.get("downloaded_adapter_path"),
            "post_training_report": str(report_path),
            "metrics_log": payload.get("metrics_file"),
            "final_reward": payload.get("final_reward"),
            "final_metrics": payload.get("final_metrics"),
            "remote_base_model_ref": payload.get("initial_sampler_path"),
            "remote_model_ref": payload.get("final_sampler_path"),
            "remote_state_ref": payload.get("final_state_path"),
            "selected_checkpoint_ref": payload.get("selected_checkpoint_ref"),
            "selected_checkpoint_state_ref": payload.get("selected_checkpoint_state_ref"),
            "selected_checkpoint_materialized_ref": payload.get(
                "selected_checkpoint_materialized_ref"
            ),
            "selection_strategy": payload.get("selection_strategy"),
            "selection_summary": payload.get("selection_summary"),
            "selection_candidates": payload.get("selection_candidates"),
            "legacy_artifact": legacy_artifact,
            "provenance_status": provenance_status,
            "warnings": warnings,
        }

    def _emit_version_manifest(self) -> None:
        """Emit a version manifest recording component SHAs for reproducibility."""
        manifest: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "pipeline_mode": self.mode,
            "model": self.model_name,
            "components": {},
        }
        workspace_root = _find_workspace_root(SCRIPT_DIR)
        for component in ("babylon", "scambench", "datasets"):
            comp_dir = workspace_root / component
            if not comp_dir.exists():
                continue
            try:
                sha = subprocess.check_output(
                    ["git", "log", "-1", "--format=%H", "--", "."],
                    cwd=str(comp_dir),
                    text=True,
                    timeout=10,
                ).strip()
                dirty = bool(
                    subprocess.check_output(
                        ["git", "status", "--porcelain", "--", "."],
                        cwd=str(comp_dir),
                        text=True,
                        timeout=10,
                    ).strip()
                )
                manifest["components"][component] = {
                    "sha": sha or "unknown",
                    "dirty": dirty,
                }
            except Exception:
                manifest["components"][component] = {"sha": "unknown", "dirty": True}

        manifest_path = self.run_dir / "version-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2))
        self._record_artifact("version_manifest", str(manifest_path))
        logger.info("Version manifest written to %s", manifest_path)

    async def run(self) -> dict[str, Any]:
        logger.info("=" * 70)
        logger.info("BABYLON CANONICAL TRAINING PIPELINE")
        logger.info("=" * 70)
        logger.info("Mode: %s", self.mode.upper())
        logger.info("Model: %s", self.model_name)
        logger.info("Output: %s", self.output_dir)
        logger.info("=" * 70)

        self._emit_version_manifest()

        if self.mode == "benchmark":
            self.sft_pipeline = self._load_existing_sft_pipeline()
            self._record_sft_reuse()
            self._fail_on_unsafe_reuse()
        else:
            await self.run_sft_stage()

        await self.run_served_eval_stage()

        if self.mode == "full":
            await self.run_rl_stage()
        else:
            existing_rl = self._load_existing_rl_stage()
            if existing_rl is not None:
                self._set_stage("rl", **existing_rl)
                self._fail_on_unsafe_reuse()
                post_training_report = existing_rl.get("post_training_report")
                metrics_log = existing_rl.get("metrics_log")
                final_model_path = existing_rl.get("final_model_path")
                if isinstance(post_training_report, str) and post_training_report:
                    self._record_artifact("rl_post_training_report", post_training_report)
                if isinstance(metrics_log, str) and metrics_log:
                    self._record_artifact("rl_metrics_log", metrics_log)
                if isinstance(final_model_path, str) and final_model_path:
                    self._record_artifact("rl_final_model", final_model_path)
            else:
                self._set_stage(
                    "rl",
                    status="skipped",
                    reason="RL stage runs only in full mode",
                )

        await self.run_rl_served_eval_stage()
        await self.run_scambench_stage()

        # Auto-enrich: if ScamBench shows category regressions, boost those
        # categories in the training corpus for the next run.
        scambench_stage = self.pipeline_report.get("stages", {}).get("scambench", {})
        if scambench_stage.get("status") == "completed":
            try:
                from auto_enrich_from_scambench import analyze_and_enrich

                trained_report_path = scambench_stage.get("trained_report_path")
                baseline_report_path = scambench_stage.get("baseline_report_path")
                if trained_report_path and baseline_report_path:
                    corpus_dir = self.source_dir or str(self.run_dir)
                    enriched = analyze_and_enrich(
                        scambench_report_path=Path(trained_report_path),
                        baseline_report_path=Path(baseline_report_path),
                        corpus_dir=Path(corpus_dir),
                        output_dir=self.run_dir / "enriched-corpus",
                    )
                    if enriched:
                        self._record_artifact("enriched_corpus", str(enriched))
                        logger.info(f"Auto-enriched corpus for next run: {enriched}")
            except Exception as e:
                logger.warning(f"Auto-enrichment skipped: {e}")

        return self.pipeline_report

    def _record_sft_reuse(self) -> None:
        assert self.sft_pipeline is not None
        training_status = self.sft_pipeline.training_status
        if training_status == "not_started":
            self._set_stage(
                "sft",
                status="missing",
                reason="No existing SFT artifact was found in the output directory",
            )
            return

        trained_model_path = self.sft_pipeline.trained_model_path
        training_artifact_path = self.sft_pipeline.training_artifact_path
        training_metrics_path = getattr(self.sft_pipeline, "training_metrics_path", None)
        capacity_report_path = getattr(self.sft_pipeline, "training_capacity_report_path", None)
        self._set_stage(
            "sft",
            status="reused",
            training_status=training_status,
            backend=self.sft_pipeline.training_backend,
            base_model=self.sft_pipeline.training_base_model,
            lineage_model_name=self.sft_pipeline.training_base_model,
            remote_model_ref=getattr(self.sft_pipeline, "training_remote_ref", None),
            remote_base_model_ref=getattr(
                self.sft_pipeline,
                "training_remote_base_ref",
                None,
            ),
            remote_state_ref=getattr(self.sft_pipeline, "training_remote_state_ref", None),
            output_path=str(trained_model_path) if trained_model_path else None,
            training_artifact=str(training_artifact_path) if training_artifact_path else None,
            training_metrics_path=str(training_metrics_path) if training_metrics_path else None,
            capacity_report_path=str(capacity_report_path) if capacity_report_path else None,
            training_export_error=getattr(self.sft_pipeline, "training_export_error", None),
        )
        manifest_path = self._existing_artifact_root() / "training_manifest.json"
        if manifest_path.exists():
            self._record_artifact("training_manifest", str(manifest_path))
        if isinstance(training_metrics_path, Path) and training_metrics_path.exists():
            self._record_artifact("training_metrics", str(training_metrics_path))
        if isinstance(capacity_report_path, Path) and capacity_report_path.exists():
            self._record_artifact("training_capacity_report", str(capacity_report_path))

    async def run_sft_stage(self) -> None:
        pipeline = self._build_full_pipeline(output_dir=self._stage_output_dir())
        self.sft_pipeline = pipeline

        try:
            self._start_stage(
                "sft",
                backend=pipeline.training_backend or self.training_backend,
                base_model=pipeline.training_base_model or self.model_name,
            )
            await pipeline.generate_data()
            await pipeline.score_trajectories()
            await pipeline.train_model()
        except Exception as exc:
            self._set_stage(
                "sft",
                status="failed",
                reason=str(exc),
                backend=pipeline.training_backend or self.training_backend,
                base_model=pipeline.training_base_model or self.model_name,
            )
            raise

        trained_model_path = pipeline.trained_model_path
        training_artifact_path = pipeline.training_artifact_path
        training_metrics_path = getattr(pipeline, "training_metrics_path", None)
        capacity_report_path = getattr(pipeline, "training_capacity_report_path", None)
        self._set_stage(
            "sft",
            status="completed",
            training_status=pipeline.training_status,
            backend=pipeline.training_backend,
            base_model=pipeline.training_base_model,
            lineage_model_name=pipeline.training_base_model,
            remote_model_ref=pipeline.training_remote_ref,
            remote_base_model_ref=pipeline.training_remote_base_ref,
            remote_state_ref=getattr(pipeline, "training_remote_state_ref", None),
            trajectory_count=len(pipeline.generated_trajectories),
            output_path=str(trained_model_path) if trained_model_path else None,
            training_artifact=str(training_artifact_path) if training_artifact_path else None,
            training_metrics_path=str(training_metrics_path) if training_metrics_path else None,
            capacity_report_path=str(capacity_report_path) if capacity_report_path else None,
            training_export_error=getattr(pipeline, "training_export_error", None),
            validation_passed=pipeline.validation_passed,
        )

        manifest_path = self._stage_output_dir() / "training_manifest.json"
        if manifest_path.exists():
            self._record_artifact("training_manifest", str(manifest_path))
        if isinstance(training_metrics_path, Path) and training_metrics_path.exists():
            self._record_artifact("training_metrics", str(training_metrics_path))
        if isinstance(capacity_report_path, Path) and capacity_report_path.exists():
            self._record_artifact("training_capacity_report", str(capacity_report_path))

    async def run_served_eval_stage(self) -> None:
        if self.sft_pipeline is None:
            self.sft_pipeline = self._load_existing_sft_pipeline()

        pipeline = self.sft_pipeline
        if pipeline.training_status != "trained":
            self._set_stage(
                "served_eval",
                status="skipped",
                reason="Served comparison requires a trained SFT artifact",
            )
            return

        if pipeline.served_eval_path and pipeline.served_eval_path.exists():
            self._set_stage(
                "served_eval",
                status="completed",
                report_path=str(pipeline.served_eval_path),
                summary=pipeline.served_eval_summary,
                source="existing",
            )
            self._record_artifact("served_eval_report", str(pipeline.served_eval_path))
            return

        self._start_stage(
            "served_eval",
            source="pending",
            timeout_seconds=self.rl_served_eval_timeout_seconds,
        )
        try:
            result = await asyncio.wait_for(
                pipeline._run_served_comparison(
                    timeout_seconds=self.rl_served_eval_timeout_seconds,
                ),
                timeout=self.rl_served_eval_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            self._set_stage(
                "served_eval",
                status="timed_out",
                reason=(f"SFT served evaluation exceeded {self.rl_served_eval_timeout_seconds}s"),
                timeout_seconds=self.rl_served_eval_timeout_seconds,
            )
            raise RuntimeError("SFT served evaluation timed out") from exc
        except Exception as exc:
            self._set_stage(
                "served_eval",
                status="failed",
                reason=str(exc),
                timeout_seconds=self.rl_served_eval_timeout_seconds,
            )
            raise
        self._set_stage(
            "served_eval",
            **result,
        )
        report_path = result.get("report_path")
        if report_path:
            self._record_artifact("served_eval_report", report_path)

    async def run_rl_served_eval_stage(self) -> None:
        rl_stage = self.pipeline_report.get("stages", {}).get("rl", {})
        if rl_stage.get("status") not in {"completed", "reused"}:
            self._set_stage(
                "rl_served_eval",
                status="skipped",
                reason="RL served comparison requires a completed RL artifact",
            )
            return

        if self.sft_pipeline is None:
            self.sft_pipeline = self._load_existing_sft_pipeline()

        if self.sft_pipeline is None:
            self._set_stage(
                "rl_served_eval",
                status="skipped",
                reason="No SFT pipeline is available to compare against RL output",
            )
            return

        base_model = (
            rl_stage.get("model_name")
            or getattr(self.sft_pipeline, "training_base_model", None)
            or self.model_name
        )
        report_path = self._stage_output_dir() / "rl_served_eval.json"
        remote_base_model_ref = rl_stage.get("remote_base_model_ref")
        remote_model_ref = rl_stage.get("remote_model_ref")
        final_model_path = rl_stage.get("final_model_path")
        backend = getattr(self.sft_pipeline, "training_backend", None)
        self._start_stage(
            "rl_served_eval",
            timeout_seconds=self.rl_served_eval_timeout_seconds,
            source="pending",
            family=backend,
        )

        try:
            report = await asyncio.wait_for(
                asyncio.to_thread(
                    self._run_rl_served_eval_sync,
                    report_path,
                    remote_base_model_ref,
                    remote_model_ref,
                    final_model_path,
                    backend,
                    str(base_model),
                ),
                timeout=self.rl_served_eval_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            self._set_stage(
                "rl_served_eval",
                status="timed_out",
                reason=(f"RL served evaluation exceeded {self.rl_served_eval_timeout_seconds}s"),
                timeout_seconds=self.rl_served_eval_timeout_seconds,
                final_model_path=final_model_path,
                remote_model_ref=remote_model_ref,
            )
            raise RuntimeError("RL served evaluation timed out") from exc
        except Exception as exc:
            self._set_stage(
                "rl_served_eval",
                status="failed",
                reason=str(exc),
                final_model_path=final_model_path,
                remote_model_ref=remote_model_ref,
            )
            raise

        trained_variant = report.get("trained_variant") or {}
        report_path.parent.mkdir(parents=True, exist_ok=True)
        if not report_path.exists():
            report_path.write_text(
                json.dumps(
                    {
                        "generated_at": self._timestamp(),
                        "source": report.get("source"),
                        "family": report.get("family"),
                        "base_summary": report.get("base_summary"),
                        "trained_summary": trained_variant.get("summary"),
                        "comparison": report.get("comparison"),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        self._set_stage(
            "rl_served_eval",
            status="completed",
            source=report.get("source"),
            family=report.get("family"),
            report_path=str(report_path),
            base_summary=report.get("base_summary"),
            trained_summary=trained_variant.get("summary"),
            comparison=report.get("comparison"),
            timeout_seconds=self.rl_served_eval_timeout_seconds,
        )
        self._record_artifact("rl_served_eval_report", str(report_path))

    def _run_rl_served_eval_sync(
        self,
        report_path: Path,
        remote_base_model_ref: Any,
        remote_model_ref: Any,
        final_model_path: Any,
        backend: Any,
        base_model: str,
    ) -> dict[str, Any]:
        per_variant_timeout = max(30, min(120, self.rl_served_eval_timeout_seconds // 2))
        if (
            isinstance(remote_base_model_ref, str)
            and remote_base_model_ref
            and isinstance(remote_model_ref, str)
            and remote_model_ref
        ):
            report = generate_tinker_proxy_comparison_report(
                base_model_ref=remote_base_model_ref,
                trained_model_ref=remote_model_ref,
                timeout=per_variant_timeout,
                output_path=report_path,
            )
            return {
                "source": "tinker_remote",
                "family": "openai_compatible",
                "base_summary": (report.get("base_model") or {}).get("summary"),
                "trained_variant": report.get("adapter_model") or {},
                "comparison": report.get("comparison"),
            }
        if (
            isinstance(final_model_path, str)
            and final_model_path
            and isinstance(backend, str)
            and backend in {"mlx", "cuda", "cpu"}
        ):
            report = generate_local_comparison_report(
                model_name=base_model,
                trained_model_path=final_model_path,
                backend=backend,
                output_path=report_path,
            )
            return {
                "source": "local_trained_model",
                "family": backend,
                "base_summary": (report.get("base_model") or {}).get("summary"),
                "trained_variant": report.get("trained_model") or {},
                "comparison": report.get("comparison"),
            }
        raise RuntimeError("No benchmarkable RL artifact is available")

    def _materialized_model_dir(self) -> Path:
        path = self._stage_output_dir() / "materialized_models"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _is_transformers_full_model(self, path: Path) -> bool:
        return (
            path.is_dir()
            and (path / "config.json").exists()
            and not (path / "adapter_config.json").exists()
        )

    def _is_peft_adapter(self, path: Path) -> bool:
        return path.is_dir() and (path / "adapter_config.json").exists()

    def _fuse_mlx_adapter(
        self,
        *,
        base_model: str,
        adapter_path: Path,
        output_path: Path,
    ) -> Path:
        if (output_path / "config.json").exists():
            return output_path

        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._run_subprocess(
            [
                sys.executable,
                "-m",
                "mlx_lm",
                "fuse",
                "--model",
                base_model,
                "--adapter-path",
                str(adapter_path),
                "--save-path",
                str(output_path),
            ],
            cwd=REPO_ROOT,
        )
        return output_path

    def _merge_transformers_adapter(
        self,
        *,
        adapter_path: Path,
        base_model: str,
        output_path: Path,
    ) -> Path:
        if self._is_transformers_full_model(output_path):
            return output_path

        import torch
        from peft import AutoPeftModelForCausalLM
        from transformers import AutoTokenizer

        load_kwargs: dict[str, Any] = {"trust_remote_code": True}
        if torch.cuda.is_available():
            load_kwargs["device_map"] = "auto"
            load_kwargs["torch_dtype"] = torch.float16
        else:
            load_kwargs["device_map"] = None
            load_kwargs["torch_dtype"] = torch.float32

        model = AutoPeftModelForCausalLM.from_pretrained(
            str(adapter_path),
            **load_kwargs,
        )
        tokenizer_source = (
            str(adapter_path) if (adapter_path / "tokenizer_config.json").exists() else base_model
        )
        tokenizer = AutoTokenizer.from_pretrained(
            tokenizer_source,
            trust_remote_code=True,
        )

        output_path.mkdir(parents=True, exist_ok=True)
        merged_model = model.merge_and_unload()
        merged_model.save_pretrained(output_path)
        tokenizer.save_pretrained(output_path)
        return output_path

    def _resolve_sft_materialized_models(self) -> dict[str, Any]:
        if self._resolved_sft_artifacts is not None:
            return self._resolved_sft_artifacts

        if self.sft_pipeline is None:
            self.sft_pipeline = self._load_existing_sft_pipeline()

        pipeline = self.sft_pipeline
        if (
            pipeline.training_status != "trained"
            or not pipeline.trained_model_path
            or not pipeline.training_base_model
        ):
            self._resolved_sft_artifacts = {
                "status": "unavailable",
                "reason": "No trained SFT artifact is available to materialize",
            }
            return self._resolved_sft_artifacts

        trained_path = Path(pipeline.trained_model_path)
        base_model = pipeline.training_base_model
        backend = pipeline.training_backend

        if backend == "tinker":
            self._resolved_sft_artifacts = {
                "status": "unavailable",
                "reason": "Tinker checkpoints are remote-only and cannot be materialized locally yet",
                "remote_model_ref": pipeline.training_remote_ref,
            }
        elif backend == "mlx":
            fused_path = self._fuse_mlx_adapter(
                base_model=base_model,
                adapter_path=trained_path,
                output_path=self._materialized_model_dir() / "sft_mlx_fused",
            )
            self._resolved_sft_artifacts = {
                "status": "available",
                "family": "mlx",
                "source": "sft_mlx_fused",
                "benchmark_model_path": str(fused_path),
                "rl_init_model_path": None,
                "base_model": base_model,
            }
        elif self._is_transformers_full_model(trained_path):
            self._resolved_sft_artifacts = {
                "status": "available",
                "family": "transformers",
                "source": "sft_full_model",
                "benchmark_model_path": str(trained_path),
                "rl_init_model_path": str(trained_path),
                "base_model": base_model,
            }
        elif self._is_peft_adapter(trained_path):
            merged_path = self._merge_transformers_adapter(
                adapter_path=trained_path,
                base_model=base_model,
                output_path=self._materialized_model_dir() / "sft_transformers_merged",
            )
            self._resolved_sft_artifacts = {
                "status": "available",
                "family": "transformers",
                "source": "sft_transformers_merged",
                "benchmark_model_path": str(merged_path),
                "rl_init_model_path": str(merged_path),
                "base_model": base_model,
            }
        else:
            self._resolved_sft_artifacts = {
                "status": "unavailable",
                "reason": f"Unsupported SFT artifact format at {trained_path}",
            }

        if self._resolved_sft_artifacts.get("status") == "available":
            benchmark_path = self._resolved_sft_artifacts.get("benchmark_model_path")
            rl_init_path = self._resolved_sft_artifacts.get("rl_init_model_path")
            if benchmark_path:
                self._record_artifact(
                    "sft_benchmark_model",
                    benchmark_path,
                )
            if rl_init_path:
                self._record_artifact(
                    "sft_rl_init_model",
                    rl_init_path,
                )

        return self._resolved_sft_artifacts

    def _resolve_rl_model(self) -> tuple[str, str]:
        resolved = self._resolve_sft_materialized_models()
        rl_init_path = resolved.get("rl_init_model_path")
        if isinstance(rl_init_path, str) and rl_init_path:
            return rl_init_path, str(resolved.get("source") or "sft_materialized")
        return self.model_name, "base_model"

    def _load_json(self, path: Path) -> Any:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    async def run_rl_stage(self) -> None:
        if self.sft_pipeline is not None and self.sft_pipeline.training_status == "prepared_data":
            self._set_stage(
                "rl",
                status="skipped",
                reason="RL stage was skipped because the SFT stage ran in prepare-only mode",
            )
            return

        if self.skip_rl or self.rl_steps <= 0:
            self._set_stage(
                "rl",
                status="skipped",
                reason="RL stage was disabled by configuration",
            )
            return

        if self.sft_pipeline is not None and self.sft_pipeline.training_backend == "tinker":
            remote_state_ref = getattr(self.sft_pipeline, "training_remote_state_ref", None)
            if not remote_state_ref:
                reason = (
                    "Tinker RL requires a resumable SFT state checkpoint; rerun the "
                    "SFT stage with the updated Tinker pipeline artifacts"
                )
                self._set_stage(
                    "rl",
                    status="skipped",
                    reason=reason,
                    remote_model_ref=self.sft_pipeline.training_remote_ref,
                )
                if self.require_rl:
                    raise RuntimeError(reason)
                return

            from src.training.tinker_client import resolve_tinker_api_key

            if not resolve_tinker_api_key():
                reason = (
                    "Tinker RL requires TINKER_API_KEY, TM_API_KEY, or THINKINGMACHINES_API_KEY"
                )
                self._set_stage("rl", status="skipped", reason=reason)
                if self.require_rl:
                    raise RuntimeError(reason)
                return

            base_model = self.sft_pipeline.training_base_model or self.model_name
            rl_output_dir = self._stage_output_dir() / "rl"
            TinkerRLConfig, TinkerRLOrchestrator = _load_tinker_rl_orchestrator()
            orchestrator = TinkerRLOrchestrator(
                TinkerRLConfig(
                    base_model=base_model,
                    output_dir=str(rl_output_dir),
                    training_steps=self.rl_steps,
                    group_size=self.rl_batch_size,
                    learning_rate=self.rl_learning_rate,
                    lora_rank=self.tinker_lora_rank,
                    weight_sync_interval=self.tinker_weight_sync_interval,
                    use_wandb=self.use_wandb,
                    trajectory_source=self.trajectory_source or "db",
                    source_dir=self.source_dir,
                    database_url=os.getenv("DATABASE_URL", ""),
                    hf_dataset=self.hf_dataset,
                    hf_split=self.hf_split,
                    lookback_hours=self.lookback_hours,
                    min_actions_per_trajectory=self.min_actions,
                    max_trajectories=self.max_trajectories,
                    reward_profile=self.reward_profile,
                    resume_from_state=remote_state_ref,
                )
            )
            result = await orchestrator.run()
            post_training_report = result.get("report_path")
            metrics_log = result.get("metrics_file")
            final_model_path = result.get("downloaded_adapter_path")
            self._set_stage(
                "rl",
                status="completed",
                init_source="tinker_sft_state",
                model_name=base_model,
                lineage_model_name=base_model,
                save_path=str(rl_output_dir),
                final_model_path=final_model_path,
                post_training_report=post_training_report,
                metrics_log=metrics_log,
                final_reward=result.get("final_reward"),
                final_metrics=result.get("final_metrics"),
                remote_base_model_ref=result.get("initial_sampler_path"),
                remote_model_ref=result.get("final_sampler_path"),
                remote_state_ref=result.get("final_state_path"),
                selected_checkpoint_ref=result.get("selected_checkpoint_ref"),
                selected_checkpoint_state_ref=result.get("selected_checkpoint_state_ref"),
                selected_checkpoint_materialized_ref=result.get(
                    "selected_checkpoint_materialized_ref"
                ),
                selection_strategy=result.get("selection_strategy"),
                selection_summary=result.get("selection_summary"),
                selection_candidates=result.get("selection_candidates"),
                legacy_artifact=False,
                provenance_status="complete",
            )
            if post_training_report:
                self._record_artifact("rl_post_training_report", post_training_report)
            if metrics_log:
                self._record_artifact("rl_metrics_log", metrics_log)
            if final_model_path:
                self._record_artifact("rl_final_model", final_model_path)
            return

        errors = validate_environment()
        if errors:
            message = " | ".join(errors)
            self._set_stage(
                "rl",
                status="skipped",
                reason=message,
            )
            if self.require_rl:
                raise RuntimeError(
                    f"RL stage is required but environment validation failed: {message}"
                )
            return

        rl_model, init_source = self._resolve_rl_model()
        save_path = self._stage_output_dir() / "rl"
        log_dir = save_path / "logs"

        orchestrator = TrainingOrchestrator(
            model_name=rl_model,
            training_steps=self.rl_steps,
            batch_size=self.rl_batch_size,
            learning_rate=self.rl_learning_rate,
            save_path=str(save_path),
            log_dir=str(log_dir),
            use_wandb=self.use_wandb,
            lookback_hours=self.lookback_hours,
            min_actions_per_trajectory=self.min_actions,
            reward_profile=self.reward_profile,
        )

        return_code = orchestrator.run()
        report_path = save_path / "post_training_report.json"
        metrics_path = log_dir / "training_metrics.jsonl"

        if return_code != 0:
            self._set_stage(
                "rl",
                status="failed",
                init_source=init_source,
                model_name=rl_model,
                lineage_model_name=self.model_name,
                save_path=str(save_path),
                return_code=return_code,
            )
            raise RuntimeError(f"RL stage failed with exit code {return_code}")

        rl_report = self._load_json(report_path) if report_path.exists() else None
        final_model_path = save_path / "final_model"
        self._set_stage(
            "rl",
            status="completed",
            init_source=init_source,
            model_name=rl_model,
            lineage_model_name=getattr(self.sft_pipeline, "training_base_model", None)
            or self.model_name,
            save_path=str(save_path),
            final_model_path=str(final_model_path) if final_model_path.exists() else None,
            post_training_report=str(report_path) if report_path.exists() else None,
            metrics_log=str(metrics_path) if metrics_path.exists() else None,
            final_reward=(rl_report or {}).get("final_reward"),
            final_metrics=(rl_report or {}).get("final_metrics"),
            selected_checkpoint_ref=(rl_report or {}).get("selected_checkpoint_ref"),
            selected_checkpoint_state_ref=(rl_report or {}).get("selected_checkpoint_state_ref"),
            selected_checkpoint_materialized_ref=(rl_report or {}).get(
                "selected_checkpoint_materialized_ref"
            ),
            selection_strategy=(rl_report or {}).get("selection_strategy"),
            selection_summary=(rl_report or {}).get("selection_summary"),
            selection_candidates=(rl_report or {}).get("selection_candidates"),
            legacy_artifact=not bool(
                (rl_report or {}).get("selected_checkpoint_ref")
                and (rl_report or {}).get("selection_summary")
                and (rl_report or {}).get("selection_strategy")
            ),
            provenance_status=(
                "complete"
                if (rl_report or {}).get("selected_checkpoint_ref")
                and (rl_report or {}).get("selection_summary")
                and (rl_report or {}).get("selection_strategy")
                else "legacy_missing_selection_metadata"
            ),
        )
        if report_path.exists():
            self._record_artifact("rl_post_training_report", str(report_path))
        if metrics_path.exists():
            self._record_artifact("rl_metrics_log", str(metrics_path))
        if final_model_path.exists():
            self._record_artifact("rl_final_model", str(final_model_path))

    def _ensure_scambench_available(self) -> str | None:
        if not SCAMBENCH_ROOT.exists():
            return f"ScamBench repo not found: {SCAMBENCH_ROOT}"
        if shutil.which("bun") is None:
            return "bun is required to score ScamBench decisions"
        return None

    def _run_subprocess(
        self,
        command: list[str],
        cwd: Path | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            check=True,
            timeout=timeout_seconds,
        )

    def _scambench_cli_args(self) -> list[str]:
        args: list[str] = []
        scenario_limit = self._resolved_scambench_scenario_limit()
        if scenario_limit is not None:
            args.extend(["--scenario-limit", str(scenario_limit)])
        return args

    def _latest_scambench_report(self, output_dir: Path) -> Path:
        reports = sorted(output_dir.glob("scambench-[0-9]*.json"))
        if not reports:
            raise FileNotFoundError(f"No ScamBench report found in {output_dir}")
        return reports[-1]

    def _latest_scambench_decisions(self, output_dir: Path, label: str) -> Path:
        sanitized = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in label).strip("-")
        reports = sorted(output_dir.glob(f"scambench-decisions-{sanitized}-*.json"))
        if not reports:
            raise FileNotFoundError(f"No ScamBench decisions found in {output_dir} for {label}")
        return reports[-1]

    def _score_decision_file(
        self,
        *,
        decisions_path: Path,
        output_dir: Path,
        target_repo: Path,
    ) -> tuple[Path, dict[str, Any]]:
        output_dir.mkdir(parents=True, exist_ok=True)
        self._run_subprocess(
            [
                "bun",
                "run",
                "src/index.ts",
                "--decisions",
                str(decisions_path),
                "--target-repo",
                str(target_repo),
                "--output-dir",
                str(output_dir),
                *self._scambench_cli_args(),
            ],
            cwd=SCAMBENCH_ROOT,
        )
        report_path = self._latest_scambench_report(output_dir)
        payload = self._load_json(report_path)
        if not isinstance(payload, list) or not payload:
            raise ValueError(f"Unexpected ScamBench report payload in {report_path}")
        return report_path, payload[0]

    def _decision_summary(self, decisions_path: Path) -> dict[str, int]:
        decisions = self._load_json(decisions_path)
        if not isinstance(decisions, list):
            raise ValueError(f"Unexpected decisions payload in {decisions_path}")
        comply_count = 0
        leaked_secret_count = 0
        for decision in decisions:
            if not isinstance(decision, dict):
                continue
            if decision.get("chosenAction") == "comply":
                comply_count += 1
            if bool(decision.get("leakedSecret")):
                leaked_secret_count += 1
        return {
            "stage_decision_count": len(decisions),
            "comply_decision_count": comply_count,
            "leaked_secret_count": leaked_secret_count,
        }

    @staticmethod
    def _scambench_operational_metrics(report: dict[str, Any]) -> dict[str, int]:
        payload = report.get("operationalMetrics")
        if not isinstance(payload, dict):
            payload = report
        keys = (
            "timeout_count",
            "handler_error_count",
            "attacker_timeout_count",
            "attacker_handler_error_count",
            "target_timeout_count",
            "target_handler_error_count",
        )
        return {key: int(payload.get(key) or report.get(key) or 0) for key in keys}

    def _summarize_scambench_report(
        self,
        *,
        label: str,
        decisions_path: Path,
        report_path: Path,
        report: dict[str, Any],
    ) -> dict[str, Any]:
        decisions_summary = self._decision_summary(decisions_path)
        operational_metrics = self._scambench_operational_metrics(report)
        return {
            "label": label,
            "decisions_path": str(decisions_path),
            "report_path": str(report_path),
            "overall_score": report.get("overallScore"),
            "scenarios_run": report.get("scenariosRun"),
            "operational_metrics": operational_metrics,
            **decisions_summary,
        }

    def _start_serving_process(
        self,
        *,
        family: str,
        model_ref: str,
        host: str,
        port: int,
        served_name: str,
        max_tokens: int = 300,
    ) -> subprocess.Popen[str]:
        if family == "mlx":
            command = [
                sys.executable,
                "-m",
                "mlx_lm",
                "server",
                "--model",
                model_ref,
                "--host",
                host,
                "--port",
                str(port),
                "--max-tokens",
                str(max_tokens),
            ]
        elif family == "tinker_proxy":
            command = [
                sys.executable,
                str(PYTHON_ROOT / "scripts" / "tools" / "tinker_openai_proxy.py"),
                "--model-ref",
                model_ref,
                "--host",
                host,
                "--port",
                str(port),
                "--served-model-name",
                served_name,
                "--max-tokens",
                str(max_tokens),
            ]
        else:
            command = [
                sys.executable,
                "-m",
                "vllm.entrypoints.openai.api_server",
                "--model",
                model_ref,
                "--host",
                host,
                "--port",
                str(port),
                "--served-model-name",
                served_name,
                "--disable-log-requests",
            ]

        return subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )

    def _run_single_served_scambench_target(
        self,
        *,
        family: str,
        label: str,
        model_ref: str,
        output_dir: Path,
        host: str = "127.0.0.1",
        port: int = 8101,
        timeout_seconds: int | None = None,
    ) -> dict[str, Any]:
        started = time.monotonic()

        def remaining_timeout() -> int | None:
            if timeout_seconds is None:
                return None
            remaining = int(timeout_seconds - (time.monotonic() - started))
            return max(1, remaining)

        proc = self._start_serving_process(
            family=family,
            model_ref=model_ref,
            host=host,
            port=port,
            served_name=label,
        )
        base_url = f"http://{host}:{port}"

        try:
            models = wait_for_server(base_url, remaining_timeout() or 120)
            served_model_id = pick_served_model_id(models, label)
            self._run_subprocess(
                [
                    "bun",
                    "run",
                    "src/index.ts",
                    "--name",
                    label,
                    "--model",
                    served_model_id,
                    "--base-url",
                    f"{base_url}/v1",
                    "--temperature",
                    "0",
                    "--max-tokens",
                    "250",
                    "--target-repo",
                    str(REPO_ROOT),
                    "--output-dir",
                    str(output_dir),
                    *self._scambench_cli_args(),
                ],
                cwd=SCAMBENCH_ROOT,
                timeout_seconds=remaining_timeout(),
            )
            report_path = self._latest_scambench_report(output_dir)
            payload = self._load_json(report_path)
            if not isinstance(payload, list) or not payload:
                raise ValueError(f"Unexpected ScamBench report payload in {report_path}")
            report = payload[0]
            decisions_path = self._latest_scambench_decisions(output_dir, label)
            return self._summarize_scambench_report(
                label=label,
                decisions_path=decisions_path,
                report_path=report_path,
                report=report,
            )
        finally:
            terminate_process(proc)

    def _run_remote_scambench_target(
        self,
        *,
        label: str,
        model_ref: str,
        base_url: str,
        api_key_env: str,
        output_dir: Path,
        timeout_seconds: int | None = None,
    ) -> dict[str, Any]:
        if model_ref.startswith("tinker://"):
            return self._run_single_served_scambench_target(
                family="tinker_proxy",
                label=label,
                model_ref=model_ref,
                output_dir=output_dir,
                timeout_seconds=timeout_seconds,
            )
        if not os.getenv(api_key_env):
            raise RuntimeError(f"{api_key_env} is required to run remote ScamBench target {label}")
        self._run_subprocess(
            [
                "bun",
                "run",
                "src/index.ts",
                "--name",
                label,
                "--model",
                model_ref,
                "--base-url",
                base_url,
                "--api-key-env",
                api_key_env,
                "--temperature",
                "0",
                "--max-tokens",
                "250",
                "--target-repo",
                str(REPO_ROOT),
                "--output-dir",
                str(output_dir),
                *self._scambench_cli_args(),
            ],
            cwd=SCAMBENCH_ROOT,
            timeout_seconds=timeout_seconds,
        )
        report_path = self._latest_scambench_report(output_dir)
        payload = self._load_json(report_path)
        if not isinstance(payload, list) or not payload:
            raise ValueError(f"Unexpected ScamBench report payload in {report_path}")
        report = payload[0]
        decisions_path = self._latest_scambench_decisions(output_dir, label)
        return self._summarize_scambench_report(
            label=label,
            decisions_path=decisions_path,
            report_path=report_path,
            report=report,
        )

    def _benchmark_candidates(self) -> list[dict[str, str]]:
        candidates: list[dict[str, str]] = []

        rl_stage = self.pipeline_report.get("stages", {}).get("rl", {})
        rl_remote_base = rl_stage.get("remote_base_model_ref")
        rl_remote_model = rl_stage.get("remote_model_ref")
        if (
            isinstance(rl_remote_base, str)
            and rl_remote_base
            and isinstance(rl_remote_model, str)
            and rl_remote_model
        ):
            from src.training.tinker_client import DEFAULT_TINKER_OPENAI_BASE_URL

            candidates.append(
                {
                    "source": "rl_tinker_remote",
                    "family": "openai_compatible",
                    "baseline_model": rl_remote_base,
                    "trained_model": rl_remote_model,
                    "base_url": os.getenv(
                        "TINKER_OPENAI_BASE_URL",
                        DEFAULT_TINKER_OPENAI_BASE_URL,
                    ),
                    "api_key_env": "TINKER_API_KEY",
                }
            )

        rl_final_model_path = rl_stage.get("final_model_path")
        if isinstance(rl_final_model_path, str) and rl_final_model_path:
            final_model = Path(rl_final_model_path)
            if final_model.exists():
                candidates.append(
                    {
                        "source": "rl_final_model",
                        "family": "transformers",
                        "baseline_model": self.model_name,
                        "trained_model": str(final_model),
                    }
                )

        resolved = self._resolve_sft_materialized_models()
        if resolved.get("status") == "available":
            benchmark_model_path = resolved.get("benchmark_model_path")
            family = resolved.get("family")
            baseline_model = resolved.get("base_model")
            if (
                isinstance(benchmark_model_path, str)
                and benchmark_model_path
                and isinstance(family, str)
                and isinstance(baseline_model, str)
            ):
                candidates.append(
                    {
                        "source": str(resolved.get("source") or "sft_materialized"),
                        "family": family,
                        "baseline_model": baseline_model,
                        "trained_model": benchmark_model_path,
                    }
                )

        if (
            self.sft_pipeline is not None
            and self.sft_pipeline.training_backend == "tinker"
            and self.sft_pipeline.training_remote_base_ref
            and self.sft_pipeline.training_remote_ref
        ):
            from src.training.tinker_client import DEFAULT_TINKER_OPENAI_BASE_URL

            candidates.append(
                {
                    "source": "tinker_remote",
                    "family": "openai_compatible",
                    "baseline_model": self.sft_pipeline.training_remote_base_ref,
                    "trained_model": self.sft_pipeline.training_remote_ref,
                    "base_url": os.getenv(
                        "TINKER_OPENAI_BASE_URL",
                        DEFAULT_TINKER_OPENAI_BASE_URL,
                    ),
                    "api_key_env": "TINKER_API_KEY",
                }
            )

        return candidates

    def _run_served_scambench_candidate(
        self,
        candidate: dict[str, str],
        *,
        timeout_seconds: int | None = None,
    ) -> dict[str, Any]:
        source = candidate["source"]
        family = candidate["family"]
        baseline_model = candidate["baseline_model"]
        trained_model = candidate["trained_model"]

        output_root = self._stage_output_dir() / "scambench" / source
        per_target_timeout = None
        if timeout_seconds is not None:
            per_target_timeout = max(30, timeout_seconds // 2)
        if family == "openai_compatible":
            base_url = candidate["base_url"]
            api_key_env = candidate.get("api_key_env", "OPENAI_API_KEY")
            baseline_summary = self._run_remote_scambench_target(
                label="baseline",
                model_ref=baseline_model,
                base_url=base_url,
                api_key_env=api_key_env,
                output_dir=output_root / "baseline",
                timeout_seconds=per_target_timeout,
            )
            trained_summary = self._run_remote_scambench_target(
                label="trained",
                model_ref=trained_model,
                base_url=base_url,
                api_key_env=api_key_env,
                output_dir=output_root / "trained",
                timeout_seconds=per_target_timeout,
            )
        else:
            baseline_summary = self._run_single_served_scambench_target(
                family=family,
                label="baseline",
                model_ref=baseline_model,
                output_dir=output_root / "baseline",
                port=8101,
                timeout_seconds=per_target_timeout,
            )
            trained_summary = self._run_single_served_scambench_target(
                family=family,
                label="trained",
                model_ref=trained_model,
                output_dir=output_root / "trained",
                port=8102,
                timeout_seconds=per_target_timeout,
            )

        comparison = {
            "overall_score_delta": round(
                float(trained_summary["overall_score"] or 0.0)
                - float(baseline_summary["overall_score"] or 0.0),
                4,
            ),
            "comply_decision_delta": int(trained_summary["comply_decision_count"])
            - int(baseline_summary["comply_decision_count"]),
            "leaked_secret_delta": int(trained_summary["leaked_secret_count"])
            - int(baseline_summary["leaked_secret_count"]),
            "timeout_count_delta": int(
                trained_summary.get("operational_metrics", {}).get("timeout_count", 0)
            )
            - int(baseline_summary.get("operational_metrics", {}).get("timeout_count", 0)),
            "handler_error_count_delta": int(
                trained_summary.get("operational_metrics", {}).get(
                    "handler_error_count",
                    0,
                )
            )
            - int(
                baseline_summary.get("operational_metrics", {}).get(
                    "handler_error_count",
                    0,
                )
            ),
        }
        results = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "benchmark_source": source,
            "family": family,
            "mode": self._resolved_scambench_mode(),
            "scenario_limit": self._resolved_scambench_scenario_limit(),
            "baseline": baseline_summary,
            "trained": trained_summary,
            "comparison": comparison,
        }
        return results

    async def run_scambench_stage(self) -> None:
        if self.skip_scambench:
            self._set_stage(
                "scambench",
                status="skipped",
                reason="ScamBench stage was disabled by configuration",
            )
            return

        candidates = self._benchmark_candidates()
        if not candidates:
            self._set_stage(
                "scambench",
                status="skipped",
                reason="No benchmarkable trained artifact is available",
            )
            return

        missing_reason = self._ensure_scambench_available()
        if missing_reason:
            self._set_stage(
                "scambench",
                status="skipped",
                reason=missing_reason,
            )
            return

        resolved_mode = self._resolved_scambench_mode()
        scenario_limit = self._resolved_scambench_scenario_limit()
        self._start_stage(
            "scambench",
            mode=resolved_mode,
            scenario_limit=scenario_limit,
            timeout_seconds=self.scambench_timeout_seconds,
            candidate_count=len(candidates),
        )
        errors: list[dict[str, str]] = []
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.scambench_timeout_seconds
        for candidate in candidates:
            try:
                remaining = max(1, int(deadline - loop.time()))
                self._set_stage(
                    "scambench",
                    status="in_progress",
                    mode=resolved_mode,
                    scenario_limit=scenario_limit,
                    timeout_seconds=self.scambench_timeout_seconds,
                    candidate_count=len(candidates),
                    active_candidate=candidate["source"],
                    attempted_candidates=errors,
                )
                results = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._run_served_scambench_candidate,
                        candidate,
                        timeout_seconds=remaining,
                    ),
                    timeout=remaining,
                )
                if errors:
                    results["fallback_errors"] = errors
                results_path = self._stage_output_dir() / "scambench_results.json"
                results_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
                self._set_stage(
                    "scambench",
                    status="completed",
                    results_path=str(results_path),
                    benchmark_source=results["benchmark_source"],
                    family=results["family"],
                    mode=results.get("mode"),
                    scenario_limit=results.get("scenario_limit"),
                    comparison=results["comparison"],
                    baseline=results["baseline"],
                    trained=results["trained"],
                    fallback_errors=results.get("fallback_errors", []),
                    timeout_seconds=self.scambench_timeout_seconds,
                )
                self._record_artifact("scambench_results", str(results_path))
                return
            except asyncio.TimeoutError:
                self._set_stage(
                    "scambench",
                    status="timed_out",
                    reason=f"ScamBench stage exceeded {self.scambench_timeout_seconds}s",
                    mode=resolved_mode,
                    scenario_limit=scenario_limit,
                    attempted_candidates=errors,
                    timeout_seconds=self.scambench_timeout_seconds,
                )
                raise RuntimeError("ScamBench stage timed out")
            except Exception as exc:
                errors.append(
                    {
                        "source": candidate["source"],
                        "error": str(exc),
                    }
                )

        self._set_stage(
            "scambench",
            status="failed",
            reason="All benchmark candidates failed",
            mode=resolved_mode,
            scenario_limit=scenario_limit,
            attempted_candidates=errors,
            fallback_errors=errors,
            timeout_seconds=self.scambench_timeout_seconds,
        )
        raise RuntimeError("ScamBench stage failed for all benchmark candidates")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Babylon canonical training pipeline",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--mode",
        choices=["full", "train", "benchmark"],
        default="full",
        help="Pipeline mode",
    )
    parser.add_argument("--model", default="Qwen/Qwen3.5-4B", help="Base model")
    parser.add_argument("--agents", type=int, default=10, help="Number of agents")
    parser.add_argument("--ticks", type=int, default=30, help="Ticks per agent")
    parser.add_argument("--output", default="./trained_models", help="Output directory")
    parser.add_argument("--no-wandb", action="store_true", help="Disable W&B")
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="Prepare training data only; skip local SFT training",
    )
    parser.add_argument(
        "--training-backend",
        choices=["auto", "local", "tinker"],
        default="auto",
        help="Preferred training backend for the SFT/training stage",
    )
    parser.add_argument(
        "--trajectory-source",
        choices=["db", "huggingface", "local_export"],
        default=None,
        help="Where to load training trajectories from",
    )
    parser.add_argument(
        "--source-dir",
        default=None,
        help="Local export directory when --trajectory-source=local_export",
    )
    parser.add_argument(
        "--hf-dataset",
        default=None,
        help="Hugging Face dataset id to use when --trajectory-source=huggingface",
    )
    parser.add_argument(
        "--hf-split",
        default="raw",
        help="Hugging Face dataset split to use when --trajectory-source=huggingface",
    )
    add_local_training_arguments(parser)
    parser.add_argument(
        "--tinker-steps",
        type=int,
        default=100,
        help="Tinker training steps when --training-backend=tinker or auto-detected",
    )
    parser.add_argument(
        "--tinker-group-size",
        type=int,
        default=4,
        help="Tinker GRPO group size",
    )
    parser.add_argument(
        "--tinker-lr",
        type=float,
        default=4e-5,
        help="Tinker learning rate",
    )
    parser.add_argument(
        "--tinker-lora-rank",
        type=int,
        default=32,
        help="Tinker LoRA rank",
    )
    parser.add_argument(
        "--tinker-weight-sync-interval",
        type=int,
        default=5,
        help="Tinker weight sync interval in steps",
    )
    parser.add_argument(
        "--no-local-validate",
        action="store_true",
        help="Skip deterministic local validation",
    )
    parser.add_argument(
        "--lookback-hours",
        type=int,
        default=72,
        help="Trajectory lookback window",
    )
    parser.add_argument(
        "--min-actions",
        type=int,
        default=1,
        help="Minimum actions required per trajectory",
    )
    parser.add_argument(
        "--max-trajectories",
        type=int,
        default=0,
        help="Optional cap on loaded trajectories (0 keeps all available trajectories)",
    )
    parser.add_argument(
        "--skip-rl",
        action="store_true",
        help="Skip the RL stage even if the environment supports it",
    )
    parser.add_argument(
        "--require-rl",
        action="store_true",
        help="Fail the pipeline if RL cannot run",
    )
    parser.add_argument(
        "--rl-steps",
        type=int,
        default=100,
        help="RL training steps when the environment supports RL",
    )
    parser.add_argument(
        "--rl-batch-size",
        type=int,
        default=4,
        help="RL batch size",
    )
    parser.add_argument(
        "--rl-lr",
        type=float,
        default=1e-5,
        help="RL learning rate",
    )
    parser.add_argument(
        "--reward-profile",
        default="default",
        help="Reward profile for RL training",
    )
    parser.add_argument(
        "--skip-scambench",
        action="store_true",
        help="Skip the ScamBench stage",
    )
    parser.add_argument(
        "--scambench-mode",
        choices=["auto", "smoke", "full"],
        default="auto",
        help="Use smoke mode for cheaper benchmark verification or full mode for the full suite",
    )
    parser.add_argument(
        "--scambench-scenario-limit",
        type=int,
        default=4,
        help="Scenario limit to apply when ScamBench runs in smoke mode",
    )
    parser.add_argument(
        "--rl-served-eval-timeout",
        type=int,
        default=600,
        help="Maximum seconds to allow the RL served-eval stage to run",
    )
    parser.add_argument(
        "--scambench-timeout",
        type=int,
        default=900,
        help="Maximum seconds to allow the ScamBench stage to run",
    )
    parser.add_argument(
        "--served-eval-min-delta",
        type=float,
        default=0.01,
        help="Minimum avg_score_delta required for served-eval quality gates",
    )
    parser.add_argument(
        "--served-eval-min-trained-avg-score",
        type=float,
        default=0.9,
        help="Minimum trained avg score required for served-eval quality gates",
    )
    parser.add_argument(
        "--scambench-min-delta",
        type=float,
        default=0.5,
        help="Minimum overall_score_delta required for ScamBench quality gates",
    )
    parser.add_argument(
        "--max-timeout-delta",
        type=int,
        default=0,
        help="Maximum allowed increase in timeout count between baseline and trained ScamBench runs",
    )
    parser.add_argument(
        "--max-handler-error-delta",
        type=int,
        default=0,
        help="Maximum allowed increase in handler error count between baseline and trained ScamBench runs",
    )
    parser.add_argument(
        "--allow-mismatched-reuse",
        action="store_true",
        help="Allow benchmark mode to reuse artifacts whose lineage model does not match the requested model",
    )
    parser.add_argument(
        "--alert-webhook-url",
        default="",
        help=(
            f"Optional webhook URL for failed/blocked/promotion-blocked canonical pipeline runs. "
            f"Defaults to ${DEFAULT_ALERT_WEBHOOK_ENV}."
        ),
    )
    parser.add_argument(
        "--format-recovery-dir",
        default=None,
        help="Directory with format recovery trajectories for output-shape stability mixing",
    )
    parser.add_argument(
        "--format-recovery-ratio",
        type=float,
        default=0.05,
        help="Fraction of training batch for format recovery examples (0.0–1.0)",
    )
    return parser.parse_args(argv)


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    local_training_recipe = local_training_recipe_from_args(args)
    pipeline = CanonicalPipeline(
        mode=args.mode,
        model_name=args.model,
        num_agents=args.agents,
        ticks_per_agent=args.ticks,
        output_dir=args.output,
        use_wandb=not args.no_wandb,
        local_training_enabled=not args.prepare_only,
        training_backend=args.training_backend,
        trajectory_source=args.trajectory_source,
        source_dir=args.source_dir,
        hf_dataset=args.hf_dataset,
        hf_split=args.hf_split,
        tinker_steps=args.tinker_steps,
        tinker_group_size=args.tinker_group_size,
        tinker_learning_rate=args.tinker_lr,
        tinker_lora_rank=args.tinker_lora_rank,
        tinker_weight_sync_interval=args.tinker_weight_sync_interval,
        local_validate=not args.no_local_validate,
        lookback_hours=args.lookback_hours,
        min_actions=args.min_actions,
        max_trajectories=args.max_trajectories,
        skip_rl=args.skip_rl,
        require_rl=args.require_rl,
        rl_steps=args.rl_steps,
        rl_batch_size=args.rl_batch_size,
        rl_learning_rate=args.rl_lr,
        reward_profile=args.reward_profile,
        skip_scambench=args.skip_scambench,
        scambench_mode=args.scambench_mode,
        scambench_scenario_limit=args.scambench_scenario_limit,
        rl_served_eval_timeout_seconds=args.rl_served_eval_timeout,
        scambench_timeout_seconds=args.scambench_timeout,
        served_eval_min_delta=args.served_eval_min_delta,
        served_eval_min_trained_avg_score=args.served_eval_min_trained_avg_score,
        scambench_min_delta=args.scambench_min_delta,
        max_timeout_delta=args.max_timeout_delta,
        max_handler_error_delta=args.max_handler_error_delta,
        allow_mismatched_reuse=args.allow_mismatched_reuse,
        alert_webhook_url=args.alert_webhook_url,
        format_recovery_dir=args.format_recovery_dir,
        format_recovery_ratio=args.format_recovery_ratio,
        **local_training_recipe.to_prefixed_dict("local_training"),
    )

    try:
        result = await pipeline.run()
    except Exception as exc:
        pipeline._fail_active_stages(str(exc))
        pipeline._write_report()
        logger.error("Canonical pipeline failed: %s", exc)
        return 1

    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
