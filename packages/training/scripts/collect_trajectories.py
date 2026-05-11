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
LIVE_PROVIDER_KEYS = (
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
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
    validation_errors: list[str] = field(default_factory=list)
    started_at: str | None = None
    completed_at: str | None = None

    def to_manifest(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "kind": "trajectory_collection_manifest",
            "createdAt": self.started_at,
            "completedAt": self.completed_at,
            "repoRoot": str(REPO_ROOT),
            "run": {
                "id": self.run_id,
                "dir": str(self.run_dir),
                "dryRun": self.dry_run,
                "suites": self.suites,
            },
            "costCaps": {
                "maxCostUsd": self.max_cost_usd,
                "lifeopsBenchEnforced": "lifeops-bench" in self.suites,
                "scenarioRunnerEnforced": False,
                "notes": [
                    "LifeOpsBench receives --max-cost-usd.",
                    (
                        "Scenario runner wrappers do not expose a native cost cap; "
                        "the cap is recorded for operator accounting."
                    ),
                ],
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
        f"{args.max_cost_usd:g}" if args.max_cost_usd is not None else "10",
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
        help="Write the manifest without running commands.",
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
    plan = build_plan(args)
    return execute_plan(plan, continue_on_error=args.continue_on_error)


if __name__ == "__main__":
    raise SystemExit(main())
