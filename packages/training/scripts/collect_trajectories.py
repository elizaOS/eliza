#!/usr/bin/env python3
"""Plan and run development trajectory collection jobs.

This orchestrator is intentionally thin: it records and invokes the existing
scenario and benchmark entry points without changing their contracts. Provider
and model values are labels unless a downstream entry point already exposes a
safe environment hook for them.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT_DIR = Path("artifacts") / "trajectory-collection"
MANIFEST_NAME = "collection-manifest.json"
MANIFEST_SCHEMA = "eliza.trajectory_collection_manifest.v1"
MANIFEST_VERSION = 1
DEFAULT_LIFEOPS_MAX_COST_USD = 10.0
NATIVE_EXPORT_FILENAME = "app-trajectories.eliza-native.jsonl"
OWNED_FILES = (
    "packages/training/scripts/collect_trajectories.py",
    "packages/training/scripts/test_collect_trajectories.py",
    "docs/dataset/TRAJECTORY_COLLECTION_RUNBOOK.md",
)
LIVE_PROVIDER_KEYS = (
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
)
OPUS_MODEL_ENV_KEYS = (
    "ANTHROPIC_MODEL",
    "ANTHROPIC_LARGE_MODEL",
    "EVAL_ANTHROPIC_MODEL",
    "EVAL_MODEL",
    "EVAL_MODEL_NAME",
    "JUDGE_MODEL",
    "TRAIN_ANTHROPIC_MODEL",
    "TRAIN_MODEL_NAME",
)
SUITE_CHOICES = {
    "live-scenarios",
    "scenario-benchmark",
    "scenario-runner",
    "lifeops-bench",
}


@dataclass(frozen=True)
class EnvRequirement:
    reason: str
    name: str | None = None
    one_of: tuple[str, ...] = ()
    required: bool = True


@dataclass(frozen=True)
class ExpectedOutput:
    kind: str
    path: str
    required_for_collection: bool = False


@dataclass(frozen=True)
class ProviderLabel:
    label: str
    description: str
    runnable: bool = True
    env_requirements: tuple[EnvRequirement, ...] = ()
    notes: tuple[str, ...] = ()


@dataclass
class CommandPlan:
    suite: str
    label: str
    cwd: str
    argv: list[str]
    env_overrides: dict[str, str]
    env_requirements: list[EnvRequirement]
    expected_outputs: list[ExpectedOutput]
    provider_label: str
    supports_cost_cap: bool
    status: str = "planned"
    exit_code: int | None = None

    def manifest_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["command"] = self.argv
        return data


@dataclass
class CollectionPlan:
    run_id: str
    run_dir: Path
    manifest_path: Path
    dry_run: bool
    provider: str
    model: str | None
    max_cost_usd: float | None
    suites: list[str]
    commands: list[CommandPlan]
    provider_labels: dict[str, ProviderLabel]
    git: dict[str, Any]
    worktree: dict[str, Any]
    validation_errors: list[str] = field(default_factory=list)
    started_at: str | None = None
    completed_at: str | None = None

    def to_manifest(self) -> dict[str, Any]:
        expected_outputs = _expected_outputs(self.commands)
        downstream_inputs = _downstream_inputs(
            run_id=self.run_id,
            run_dir=self.run_dir,
            manifest_path=self.manifest_path,
            expected_outputs=expected_outputs,
        )
        cost_caps = _cost_caps(self.max_cost_usd, self.suites)
        return {
            "schema": MANIFEST_SCHEMA,
            "version": MANIFEST_VERSION,
            "schemaVersion": MANIFEST_VERSION,
            "kind": "trajectory_collection_manifest",
            "generated_at": self.started_at,
            "createdAt": self.started_at,
            "completed_at": self.completed_at,
            "completedAt": self.completed_at,
            "repoRoot": str(REPO_ROOT),
            "run_id": self.run_id,
            "provider_label": self.provider,
            "provider_model": self.model,
            "suites": self.suites,
            "cost_caps": cost_caps,
            "expected_outputs": expected_outputs,
            "downstream_inputs": downstream_inputs,
            "git": self.git,
            "worktree": self.worktree,
            "run": {
                "id": self.run_id,
                "dir": str(self.run_dir),
                "dryRun": self.dry_run,
                "suites": self.suites,
            },
            "costCaps": {
                "maxCostUsd": cost_caps["max_cost_usd"],
                "effectiveMaxCostUsdBySuite": cost_caps[
                    "effective_max_cost_usd_by_suite"
                ],
                "lifeopsBenchEffectiveMaxCostUsd": cost_caps[
                    "effective_max_cost_usd_by_suite"
                ]["lifeops-bench"],
                "lifeopsBenchEnforced": cost_caps["enforced_by_suite"]["lifeops-bench"],
                "scenarioRunnerEnforced": cost_caps["enforced_by_suite"]["scenario-runner"],
                "notes": cost_caps["notes"],
            },
            "provider": {
                "activeLabel": self.provider,
                "activeModel": self.model,
                "labels": {
                    key: asdict(value)
                    for key, value in sorted(self.provider_labels.items())
                },
            },
            "commands": [command.manifest_dict() for command in self.commands],
            "expectedOutputRoot": str(self.run_dir),
            "validationErrors": self.validation_errors,
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _expected_outputs(commands: list[CommandPlan]) -> list[dict[str, Any]]:
    outputs: list[dict[str, Any]] = []
    for command in commands:
        for output in command.expected_outputs:
            data = asdict(output)
            data["suite"] = command.suite
            data["command_label"] = command.label
            outputs.append(data)
    return outputs


def _unique_output_paths(
    expected_outputs: list[dict[str, Any]],
    kinds: set[str],
) -> list[str]:
    seen: set[str] = set()
    paths: list[str] = []
    for output in expected_outputs:
        path = output.get("path")
        if output.get("kind") in kinds and isinstance(path, str) and path not in seen:
            seen.add(path)
            paths.append(path)
    return paths


def _downstream_inputs(
    *,
    run_id: str,
    run_dir: Path,
    manifest_path: Path,
    expected_outputs: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_trajectory_paths = _unique_output_paths(
        expected_outputs,
        {"raw_trajectories_dir"},
    )
    ready_prepare_input_paths = _unique_output_paths(
        expected_outputs,
        {"lifeops_bench_results_dir"},
    )
    native_export_path = run_dir / "exports" / NATIVE_EXPORT_FILENAME
    pending_native_exports = [str(native_export_path)] if raw_trajectory_paths else []
    prepare_input_paths = [*pending_native_exports, *ready_prepare_input_paths]
    prepare_script = REPO_ROOT / "packages/training/scripts/prepare_eliza1_trajectory_dataset.py"
    prepare_output_dir = REPO_ROOT / "packages/training/data/trajectory-runs" / run_id
    command = [sys.executable, str(prepare_script)]
    for path in prepare_input_paths:
        command.extend(["--input", path])
    command.extend(["--output-dir", str(prepare_output_dir), "--strict-privacy"])
    return {
        "app_trajectory_export": {
            "schema": "eliza.app_trajectory_export_reference.v1",
            "method": "POST",
            "endpoint": "/api/trajectories/export",
            "ui": {
                "tab": "Trajectories",
                "menu_item": "JSONL Native Training",
            },
            "request_body": {
                "format": "jsonl",
                "includePrompts": True,
                "jsonShape": "eliza_native_v1",
            },
            "suggested_output_path": str(native_export_path),
            "source_raw_trajectory_paths": raw_trajectory_paths,
            "notes": [
                (
                    "Raw recorder JSON under source_raw_trajectory_paths is for "
                    "audit/aggregation. Export or convert it to eliza_native_v1 "
                    "before using it as training input."
                ),
                (
                    "The app endpoint and Trajectories UI can export "
                    "eliza_native_v1 JSONL from runtime trajectory storage."
                ),
            ],
        },
        "prepare_eliza1_trajectory_dataset": {
            "schema": "eliza.prepare_eliza1_trajectory_dataset.inputs.v1",
            "script": str(prepare_script),
            "collection_manifest": str(manifest_path),
            "collection_run_dir": str(run_dir),
            "input_paths": prepare_input_paths,
            "ready_input_paths": ready_prepare_input_paths,
            "pending_input_paths": pending_native_exports,
            "source_raw_trajectory_paths": raw_trajectory_paths,
            "output_dir": str(prepare_output_dir),
            "command": command,
            "requires_privacy_review": True,
            "notes": [
                (
                    "ready_input_paths can be consumed directly after privacy review. "
                    "pending_input_paths must be produced first, usually from the "
                    "app trajectory export reference above."
                ),
                (
                    "The prepare script accepts files or directories and recursively "
                    "reads JSON, JSONL, and NDJSON inputs."
                ),
            ],
        }
    }


def _cost_caps(max_cost_usd: float | None, suites: list[str]) -> dict[str, Any]:
    effective_by_suite = {
        "live-scenarios": None,
        "scenario-benchmark": None,
        "scenario-runner": None,
        "lifeops-bench": (
            max_cost_usd
            if max_cost_usd is not None
            else (DEFAULT_LIFEOPS_MAX_COST_USD if "lifeops-bench" in suites else None)
        ),
    }
    enforced_by_suite = {
        "live-scenarios": False,
        "scenario-benchmark": False,
        "scenario-runner": False,
        "lifeops-bench": "lifeops-bench" in suites,
    }
    return {
        "max_cost_usd": max_cost_usd,
        "effective_max_cost_usd_by_suite": effective_by_suite,
        "enforced_by_suite": enforced_by_suite,
        "recorded_only_for_suites": [
            suite for suite in suites if not enforced_by_suite.get(suite, False)
        ],
        "notes": [
            "LifeOpsBench receives --max-cost-usd.",
            (
                "Scenario runner wrappers do not expose a native cost cap; "
                "the cap is recorded for operator accounting."
            ),
        ],
    }


def _git_output(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.rstrip("\n")


def _git_metadata() -> dict[str, Any]:
    status_short = _git_output("status", "--short")
    return {
        "commit": _git_output("rev-parse", "HEAD"),
        "branch": _git_output("branch", "--show-current")
        or _git_output("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(status_short),
    }


def _worktree_metadata(run_dir: Path, manifest_path: Path) -> dict[str, Any]:
    owned_status = _git_output("status", "--short", "--", *OWNED_FILES)
    return {
        "repo_root": str(REPO_ROOT),
        "run_dir": str(run_dir),
        "manifest_path": str(manifest_path),
        "owned_files": [str(REPO_ROOT / path) for path in OWNED_FILES],
        "owned_files_status": owned_status.splitlines() if owned_status else [],
    }


def _default_run_id() -> str:
    return "traj-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _split_csv(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip())
    return cleaned.strip("-") or "run"


def provider_labels() -> dict[str, ProviderLabel]:
    return {
        "env": ProviderLabel(
            label="env",
            description=(
                "Use the existing process environment and the entry point's "
                "provider discovery."
            ),
        ),
        "cerebras-dev": ProviderLabel(
            label="cerebras-dev",
            description=(
                "Development-only Cerebras backend label. No model is pinned "
                "by the collector."
            ),
            env_requirements=(
                EnvRequirement(
                    name="CEREBRAS_API_KEY",
                    reason="required only for commands that actually route to Cerebras",
                ),
            ),
            notes=(
                "Pass --model to export CEREBRAS_MODEL for LifeOpsBench cerebras-direct runs.",
            ),
        ),
        "openai": ProviderLabel(
            label="openai",
            description=(
                "OpenAI provider label; existing entry points still read their "
                "normal OPENAI_* environment."
            ),
            env_requirements=(
                EnvRequirement(
                    name="OPENAI_API_KEY",
                    reason="required only for commands that actually route to OpenAI",
                ),
            ),
        ),
        "anthropic": ProviderLabel(
            label="anthropic",
            description=(
                "Anthropic provider label for non-Opus models; Opus execution "
                "is blocked by this collector."
            ),
            env_requirements=(
                EnvRequirement(
                    name="ANTHROPIC_API_KEY",
                    reason="required only for commands that actually route to Anthropic",
                ),
            ),
        ),
        "openai-placeholder": ProviderLabel(
            label="openai-placeholder",
            description=(
                "Configuration label only. It is recorded in manifests but is "
                "not executable."
            ),
            runnable=False,
        ),
        "opus-placeholder": ProviderLabel(
            label="opus-placeholder",
            description=(
                "Configuration label only. The collector refuses non-dry runs "
                "whose active model contains 'opus'."
            ),
            runnable=False,
            notes=("Do not use this label for execution.",),
        ),
    }


def _provider_config(labels: dict[str, ProviderLabel], provider: str) -> ProviderLabel:
    return labels.get(
        provider,
        ProviderLabel(
            label=provider,
            description=(
                "Custom provider label. The collector records it and leaves "
                "provider wiring to existing env/config."
            ),
        ),
    )


def _scenario_env_requirements() -> list[EnvRequirement]:
    return [
        EnvRequirement(
            one_of=LIVE_PROVIDER_KEYS,
            reason=(
                "scenario-runner live provider discovery requires at least one "
                "supported LLM provider API key"
            ),
        )
    ]


def _lifeops_bench_env_requirements(args: argparse.Namespace) -> list[EnvRequirement]:
    requirements: list[EnvRequirement] = []
    if args.lifeops_agent == "cerebras-direct":
        requirements.append(
            EnvRequirement(
                name="CEREBRAS_API_KEY",
                reason="LifeOpsBench cerebras-direct agent requires Cerebras credentials",
            )
        )
    if args.lifeops_mode == "live":
        requirements.extend(
            [
                EnvRequirement(
                    name="CEREBRAS_API_KEY",
                    reason="LifeOpsBench live mode simulates the user through the Cerebras client",
                ),
                EnvRequirement(
                    name="ANTHROPIC_API_KEY",
                    reason="LifeOpsBench live mode expects an explicitly configured judge client",
                ),
            ]
        )
    return requirements


def _common_env(
    *,
    args: argparse.Namespace,
    run_dir: Path,
    run_id: str,
) -> dict[str, str]:
    env = {
        "MILADY_COLLECTION_PROVIDER": args.provider,
        "MILADY_COLLECTION_RUN_ID": run_id,
        "MILADY_LIFEOPS_RUN_ID": run_id,
        "MILADY_LIFEOPS_RUN_DIR": str(run_dir),
        "MILADY_TRAJECTORY_DIR": str(run_dir / "trajectories"),
    }
    if args.model:
        env["MILADY_COLLECTION_MODEL"] = args.model
        if args.provider in {"cerebras", "cerebras-dev"}:
            env["CEREBRAS_MODEL"] = args.model
        if args.provider == "anthropic":
            env["ANTHROPIC_MODEL"] = args.model
            env["ANTHROPIC_LARGE_MODEL"] = args.model
        if args.provider == "openai":
            env["OPENAI_MODEL"] = args.model
            env["OPENAI_LARGE_MODEL"] = args.model
    if args.max_cost_usd is not None:
        env["MILADY_COLLECTION_MAX_COST_USD"] = f"{args.max_cost_usd:g}"
    return env


def _add_scenario_filter(env: dict[str, str], scenario_filter: str | None) -> None:
    if scenario_filter:
        env["SCENARIO_FILTER"] = scenario_filter


def _live_scenarios_plan(
    *,
    args: argparse.Namespace,
    run_dir: Path,
    run_id: str,
    env: dict[str, str],
    env_requirements: list[EnvRequirement],
) -> CommandPlan:
    reports_dir = run_dir / "reports"
    report_path = reports_dir / "live-scenarios.json"
    command_env = {
        **env,
        "ELIZA_LIVE_TEST": "1",
        "REPORT_PATH": str(report_path),
    }
    _add_scenario_filter(command_env, args.scenario_filter)
    argv = [
        "node",
        "scripts/run-live-scenarios.mjs",
        "--run-dir",
        str(run_dir),
        "--runId",
        run_id,
    ]
    return CommandPlan(
        suite="live-scenarios",
        label="scripts/run-live-scenarios.mjs",
        cwd=str(REPO_ROOT),
        argv=argv,
        env_overrides=command_env,
        env_requirements=env_requirements,
        expected_outputs=[
            ExpectedOutput("scenario_report_json", str(report_path), True),
            ExpectedOutput("scenario_matrix_json", str(run_dir / "matrix.json")),
            ExpectedOutput("raw_trajectories_dir", str(run_dir / "trajectories"), True),
        ],
        provider_label=args.provider,
        supports_cost_cap=False,
    )


def _scenario_benchmark_plan(
    *,
    args: argparse.Namespace,
    run_dir: Path,
    run_id: str,
    env: dict[str, str],
    env_requirements: list[EnvRequirement],
) -> CommandPlan:
    reports_dir = run_dir / "reports"
    report_json = reports_dir / "scenario-benchmark.json"
    report_md = reports_dir / "scenario-benchmark.md"
    command_env = {
        **env,
        "ELIZA_LIVE_TEST": "1",
        "REPORT_PATH": str(report_json),
        "BENCHMARK_REPORT_PATH": str(report_md),
    }
    _add_scenario_filter(command_env, args.scenario_filter)
    return CommandPlan(
        suite="scenario-benchmark",
        label="scripts/run-scenario-benchmark.mjs",
        cwd=str(REPO_ROOT),
        argv=["node", "scripts/run-scenario-benchmark.mjs"],
        env_overrides=command_env,
        env_requirements=env_requirements,
        expected_outputs=[
            ExpectedOutput("benchmark_report_json", str(report_json), True),
            ExpectedOutput("benchmark_report_markdown", str(report_md), True),
            ExpectedOutput("raw_trajectories_dir", str(run_dir / "trajectories"), True),
        ],
        provider_label=args.provider,
        supports_cost_cap=False,
    )


def _scenario_runner_plan(
    *,
    args: argparse.Namespace,
    run_dir: Path,
    run_id: str,
    env: dict[str, str],
    env_requirements: list[EnvRequirement],
) -> CommandPlan:
    reports_dir = run_dir / "reports"
    report_json = reports_dir / "scenario-runner.json"
    report_bundle = reports_dir / "scenario-runner"
    scenario_root = Path(args.scenario_root)
    if not scenario_root.is_absolute():
        scenario_root = REPO_ROOT / scenario_root
    argv = [
        "bun",
        "--bun",
        "packages/scenario-runner/src/cli.ts",
        "run",
        str(scenario_root),
        "--run-dir",
        str(run_dir),
        "--runId",
        run_id,
        "--report",
        str(report_json),
        "--report-dir",
        str(report_bundle),
    ]
    if args.scenario_filter:
        argv.extend(["--scenario", args.scenario_filter])
    for glob in args.file_glob:
        argv.append(glob)
    command_env = {
        **env,
        "ELIZA_LIVE_TEST": "1",
    }
    return CommandPlan(
        suite="scenario-runner",
        label="packages/scenario-runner/src/cli.ts",
        cwd=str(REPO_ROOT),
        argv=argv,
        env_overrides=command_env,
        env_requirements=env_requirements,
        expected_outputs=[
            ExpectedOutput("scenario_report_json", str(report_json), True),
            ExpectedOutput("scenario_report_bundle_dir", str(report_bundle)),
            ExpectedOutput("scenario_matrix_json", str(run_dir / "matrix.json")),
            ExpectedOutput("raw_trajectories_dir", str(run_dir / "trajectories"), True),
        ],
        provider_label=args.provider,
        supports_cost_cap=False,
    )


def _lifeops_bench_plan(
    *,
    args: argparse.Namespace,
    run_dir: Path,
    env: dict[str, str],
    env_requirements: list[EnvRequirement],
) -> CommandPlan:
    bench_root = REPO_ROOT / "packages/benchmarks/lifeops-bench"
    output_dir = run_dir / "lifeops-bench"
    evaluator_model = args.model or "configured-by-collector"
    judge_model = args.judge_model or "disabled-static-judge"
    max_cost_usd = (
        args.max_cost_usd
        if args.max_cost_usd is not None
        else DEFAULT_LIFEOPS_MAX_COST_USD
    )
    argv = [
        sys.executable,
        "-m",
        "eliza_lifeops_bench",
        "--agent",
        args.lifeops_agent,
        "--mode",
        args.lifeops_mode,
        "--evaluator-model",
        evaluator_model,
        "--judge-model",
        judge_model,
        "--concurrency",
        str(args.lifeops_concurrency),
        "--seeds",
        str(args.lifeops_seeds),
        "--max-cost-usd",
        f"{max_cost_usd:g}",
        "--output-dir",
        str(output_dir),
    ]
    if args.lifeops_domain:
        argv.extend(["--domain", args.lifeops_domain])
    if args.lifeops_scenario:
        argv.extend(["--scenario", args.lifeops_scenario])
    return CommandPlan(
        suite="lifeops-bench",
        label="packages/benchmarks/lifeops-bench CLI",
        cwd=str(bench_root),
        argv=argv,
        env_overrides=env,
        env_requirements=env_requirements,
        expected_outputs=[
            ExpectedOutput("lifeops_bench_results_dir", str(output_dir), True),
        ],
        provider_label=args.provider,
        supports_cost_cap=True,
    )


def _aggregate_plan(
    *,
    args: argparse.Namespace,
    run_dir: Path,
    run_id: str,
    env: dict[str, str],
) -> CommandPlan:
    return CommandPlan(
        suite="aggregate",
        label="scripts/aggregate-lifeops-run.mjs",
        cwd=str(REPO_ROOT),
        argv=[
            "node",
            "scripts/aggregate-lifeops-run.mjs",
            "--run-dir",
            str(run_dir),
            "--run-id",
            run_id,
        ],
        env_overrides=env,
        env_requirements=[],
        expected_outputs=[
            ExpectedOutput("aggregate_report_markdown", str(run_dir / "report.md")),
            ExpectedOutput("aggregate_steps_csv", str(run_dir / "steps.csv")),
            ExpectedOutput("aggregate_scenarios_dir", str(run_dir / "scenarios")),
        ],
        provider_label=args.provider,
        supports_cost_cap=False,
    )


def _opus_env_keys(env: dict[str, str]) -> list[str]:
    return [
        key
        for key in OPUS_MODEL_ENV_KEYS
        if "opus" in str(env.get(key, "")).lower()
    ]


def build_plan(args: argparse.Namespace) -> CollectionPlan:
    labels = provider_labels()
    provider = _provider_config(labels, args.provider)
    labels.setdefault(provider.label, provider)
    run_id = _slug(args.run_id or _default_run_id())
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = REPO_ROOT / output_dir
    run_dir = output_dir / run_id
    manifest_path = run_dir / MANIFEST_NAME
    suites = _split_csv(args.suites)
    unknown_suites = sorted(set(suites) - SUITE_CHOICES)

    common_env = _common_env(args=args, run_dir=run_dir, run_id=run_id)
    scenario_env_requirements = _scenario_env_requirements()
    lifeops_env_requirements = _lifeops_bench_env_requirements(args)
    commands: list[CommandPlan] = []
    if "live-scenarios" in suites:
        commands.append(
            _live_scenarios_plan(
                args=args,
                run_dir=run_dir,
                run_id=run_id,
                env=common_env,
                env_requirements=scenario_env_requirements,
            )
        )
    if "scenario-benchmark" in suites:
        commands.append(
            _scenario_benchmark_plan(
                args=args,
                run_dir=run_dir,
                run_id=run_id,
                env=common_env,
                env_requirements=scenario_env_requirements,
            )
        )
    if "scenario-runner" in suites:
        commands.append(
            _scenario_runner_plan(
                args=args,
                run_dir=run_dir,
                run_id=run_id,
                env=common_env,
                env_requirements=scenario_env_requirements,
            )
        )
    if "lifeops-bench" in suites:
        commands.append(
            _lifeops_bench_plan(
                args=args,
                run_dir=run_dir,
                env=common_env,
                env_requirements=lifeops_env_requirements,
            )
        )
    if args.aggregate and any(
        suite in suites
        for suite in ("live-scenarios", "scenario-benchmark", "scenario-runner")
    ):
        commands.append(
            _aggregate_plan(args=args, run_dir=run_dir, run_id=run_id, env=common_env)
        )

    validation_errors: list[str] = []
    if not suites:
        validation_errors.append("at least one suite is required")
    if unknown_suites:
        validation_errors.append(f"unknown suite(s): {', '.join(unknown_suites)}")
    if args.max_cost_usd is not None and args.max_cost_usd <= 0:
        validation_errors.append("--max-cost-usd must be greater than 0")
    if not provider.runnable and not args.dry_run:
        validation_errors.append(
            f"provider label {provider.label!r} is a config placeholder and cannot be executed"
        )
    if not args.dry_run and args.provider == "anthropic" and not args.model:
        validation_errors.append(
            "provider label 'anthropic' requires --model to avoid an Opus default"
        )
    active_model = (args.model or "").lower()
    judge_model = (args.judge_model or "").lower()
    if not args.dry_run and ("opus" in active_model or "opus" in judge_model):
        validation_errors.append("refusing to execute Opus; use dry-run for Opus labels only")
    if (
        not args.dry_run
        and "opus" not in active_model
        and "opus" not in judge_model
    ):
        effective_env = dict(os.environ)
        effective_env.update(common_env)
        blocked_env_keys = _opus_env_keys(effective_env)
        if blocked_env_keys:
            validation_errors.append(
                "refusing to execute Opus from environment: "
                + ", ".join(blocked_env_keys)
            )
    if (
        not args.dry_run
        and "lifeops-bench" in suites
        and args.lifeops_mode == "live"
        and not args.judge_model
    ):
        validation_errors.append(
            "lifeops-bench live mode requires --judge-model; no Opus default is allowed"
        )

    plan = CollectionPlan(
        run_id=run_id,
        run_dir=run_dir,
        manifest_path=manifest_path,
        dry_run=args.dry_run,
        provider=args.provider,
        model=args.model,
        max_cost_usd=args.max_cost_usd,
        suites=suites,
        commands=commands,
        provider_labels=labels,
        git=_git_metadata(),
        worktree=_worktree_metadata(run_dir, manifest_path),
        validation_errors=validation_errors,
        started_at=_now_iso(),
    )
    return plan


def _write_manifest(plan: CollectionPlan) -> None:
    plan.manifest_path.parent.mkdir(parents=True, exist_ok=True)
    plan.manifest_path.write_text(
        json.dumps(plan.to_manifest(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _missing_requirements(
    requirements: list[EnvRequirement],
    env: dict[str, str],
) -> list[str]:
    missing: list[str] = []
    for req in requirements:
        if not req.required:
            continue
        if req.name and not env.get(req.name):
            missing.append(f"{req.name}: {req.reason}")
        if req.one_of and not any(env.get(name) for name in req.one_of):
            missing.append(f"one of {', '.join(req.one_of)}: {req.reason}")
    return missing


def execute_plan(plan: CollectionPlan, *, continue_on_error: bool) -> int:
    plan.run_dir.mkdir(parents=True, exist_ok=True)
    (plan.run_dir / "trajectories").mkdir(parents=True, exist_ok=True)
    (plan.run_dir / "reports").mkdir(parents=True, exist_ok=True)
    _write_manifest(plan)

    if plan.validation_errors:
        for command in plan.commands:
            command.status = "blocked"
            command.exit_code = 2
        plan.completed_at = _now_iso()
        _write_manifest(plan)
        for error in plan.validation_errors:
            print(f"[collect-trajectories] {error}", file=sys.stderr)
        print(f"[collect-trajectories] manifest: {plan.manifest_path}")
        return 2

    if plan.dry_run:
        for command in plan.commands:
            command.status = "planned"
        plan.completed_at = _now_iso()
        _write_manifest(plan)
        print(f"[collect-trajectories] dry-run manifest: {plan.manifest_path}")
        for command in plan.commands:
            print(f"[collect-trajectories] plan {command.suite}: {' '.join(command.argv)}")
        return 0

    exit_code = 0
    for command in plan.commands:
        env = os.environ.copy()
        env.update(command.env_overrides)
        missing = _missing_requirements(command.env_requirements, env)
        if missing:
            command.status = "blocked"
            command.exit_code = 2
            exit_code = 2
            print(
                f"[collect-trajectories] blocked {command.suite}: missing env "
                + "; ".join(missing),
                file=sys.stderr,
            )
            _write_manifest(plan)
            if not continue_on_error:
                break
            continue

        print(f"[collect-trajectories] running {command.suite}: {' '.join(command.argv)}")
        result = subprocess.run(command.argv, cwd=command.cwd, env=env, check=False)
        command.exit_code = result.returncode
        command.status = "succeeded" if result.returncode == 0 else "failed"
        _write_manifest(plan)
        if result.returncode != 0:
            exit_code = result.returncode
            if not continue_on_error:
                break

    plan.completed_at = _now_iso()
    _write_manifest(plan)
    print(f"[collect-trajectories] manifest: {plan.manifest_path}")
    return exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Provider/model-agnostic development trajectory collection orchestrator.",
    )
    parser.add_argument(
        "--provider",
        default="env",
        help=(
            "Provider label to record. Built-ins: env, cerebras-dev, openai, "
            "anthropic, openai-placeholder, opus-placeholder."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Model label to record. For provider=cerebras-dev this also exports CEREBRAS_MODEL.",
    )
    parser.add_argument(
        "--suites",
        default="live-scenarios",
        help=(
            "Comma-separated suites: live-scenarios, scenario-benchmark, "
            "scenario-runner, lifeops-bench."
        ),
    )
    parser.add_argument(
        "--run-id",
        default=None,
        help="Stable run id. Defaults to traj-<UTC timestamp>.",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Base output directory; the run lands in <output-dir>/<run-id>.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Write the manifest without running commands. This is also the default.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually run planned commands. Required for non-dry collection.",
    )
    parser.add_argument(
        "--max-cost-usd",
        "--cost-cap-usd",
        dest="max_cost_usd",
        type=float,
        default=None,
        help="Run-level cost cap. Passed to LifeOpsBench; recorded for other suites.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue executing later suites after a suite fails or is blocked.",
    )
    parser.add_argument(
        "--aggregate",
        action="store_true",
        help="After scenario suites, run scripts/aggregate-lifeops-run.mjs.",
    )

    scenario = parser.add_argument_group("scenario runner options")
    scenario.add_argument(
        "--scenario-root",
        default="plugins/app-lifeops/test/scenarios",
        help="Scenario directory for the direct scenario-runner suite.",
    )
    scenario.add_argument(
        "--scenario-filter",
        default=None,
        help="Comma-separated scenario ids for wrappers or direct --scenario filter.",
    )
    scenario.add_argument(
        "--file-glob",
        action="append",
        default=[],
        help="Additional direct scenario-runner file glob. Repeatable.",
    )

    bench = parser.add_argument_group("lifeops-bench options")
    bench.add_argument(
        "--lifeops-agent",
        default="perfect",
        help=(
            "LifeOpsBench --agent value. Use cerebras-direct only when that "
            "backend is intentionally configured."
        ),
    )
    bench.add_argument(
        "--lifeops-mode",
        choices=("static", "live"),
        default="static",
        help="LifeOpsBench mode. Defaults to static to avoid accidental live judge calls.",
    )
    bench.add_argument(
        "--lifeops-domain",
        default=None,
        help="Optional LifeOpsBench --domain filter.",
    )
    bench.add_argument(
        "--lifeops-scenario",
        default=None,
        help="Optional LifeOpsBench --scenario filter.",
    )
    bench.add_argument("--lifeops-seeds", type=int, default=1, help="LifeOpsBench --seeds.")
    bench.add_argument(
        "--lifeops-concurrency",
        type=int,
        default=4,
        help="LifeOpsBench --concurrency.",
    )
    bench.add_argument(
        "--judge-model",
        default=None,
        help="LifeOpsBench judge model label for live mode. Opus labels are dry-run only.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.dry_run and args.execute:
        parser.error("--dry-run and --execute are mutually exclusive")
    args.dry_run = not args.execute
    plan = build_plan(args)
    return execute_plan(plan, continue_on_error=args.continue_on_error)


if __name__ == "__main__":
    raise SystemExit(main())
