from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

if __package__ == "orchestrator":
    from registry import get_benchmark_registry
else:
    from benchmarks.registry import get_benchmark_registry

from .scoring import RegistryScoreExtractor, generic_score_extractor
from .types import AdapterDiscovery, BenchmarkAdapter, ExecutionContext, ScoreSummary


def _sanitize(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip("-").lower() or "run"


def _find_latest_by_patterns(root: Path, patterns: list[str]) -> Path | None:
    matches: list[Path] = []
    for pattern in patterns:
        matches.extend([p for p in root.glob(pattern) if p.is_file()])
    if not matches:
        return None
    return max(matches, key=lambda p: p.stat().st_mtime)


def _find_latest_json(root: Path) -> Path | None:
    return _find_latest_by_patterns(root, ["**/*.json"])


def _json_score(path: Path) -> ScoreSummary:
    return generic_score_extractor(path)


def _make_registry_adapter(
    workspace_root: Path,
    benchmarks_root: Path,
    score_extractor_factory: RegistryScoreExtractor,
    benchmark_id: str,
    display_name: str,
    description: str,
    benchmark_dir: str,
    cwd_rel: str,
    build_command,
    locate_result,
    requirements_env: tuple[str, ...],
    default_extra_config: dict[str, Any] | None,
) -> BenchmarkAdapter:
    def command_builder(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
        model = type("ModelSpecShim", (), {"provider": ctx.request.provider, "model": ctx.request.model, "temperature": None})()
        return list(build_command(ctx.output_root, model, dict(ctx.request.extra_config)))

    def result_locator(ctx: ExecutionContext, adapter: BenchmarkAdapter, benchmark_output_root: Path) -> Path | None:
        try:
            path = locate_result(benchmark_output_root)
            if path.exists():
                return path
        except Exception:
            pass
        return _find_latest_json(benchmark_output_root)

    cwd_candidates = [
        (workspace_root / cwd_rel).resolve(),
        (benchmarks_root / cwd_rel).resolve(),
        (benchmarks_root / benchmark_dir).resolve(),
        workspace_root.resolve(),
    ]
    cwd_value = str(next((candidate for candidate in cwd_candidates if candidate.exists()), workspace_root.resolve()))

    return BenchmarkAdapter(
        id=benchmark_id,
        directory=benchmark_dir,
        description=f"{display_name}: {description}",
        cwd=cwd_value,
        command_builder=command_builder,
        result_locator=result_locator,
        score_extractor=score_extractor_factory.for_benchmark(benchmark_id),
        required_env=tuple(requirements_env),
        default_extra_config=dict(default_extra_config or {}),
    )


def _make_extra_adapter(
    *,
    adapter_id: str,
    directory: str,
    description: str,
    cwd: str,
    command_builder,
    result_patterns: list[str],
    required_env: tuple[str, ...] = (),
    default_extra_config: dict[str, Any] | None = None,
    env_builder=None,
    score_extractor=_json_score,
    capability_notes: str = "",
    default_timeout_seconds: int = 3600,
) -> BenchmarkAdapter:
    def result_locator(ctx: ExecutionContext, adapter: BenchmarkAdapter, benchmark_output_root: Path) -> Path | None:
        path = _find_latest_by_patterns(benchmark_output_root, result_patterns)
        if path is not None:
            return path
        cwd_root = Path(adapter.cwd)
        if cwd_root.exists():
            path = _find_latest_by_patterns(cwd_root, result_patterns)
            if path is not None:
                return path
        return _find_latest_json(benchmark_output_root)

    return BenchmarkAdapter(
        id=adapter_id,
        directory=directory,
        description=description,
        cwd=cwd,
        command_builder=command_builder,
        result_locator=result_locator,
        score_extractor=score_extractor,
        required_env=required_env,
        default_extra_config=dict(default_extra_config or {}),
        env_builder=env_builder,
        capability_notes=capability_notes,
        default_timeout_seconds=default_timeout_seconds,
    )


def _command_hyperliquid(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = ["python", "-m", "benchmarks.HyperliquidBench", "--coverage"]
    if ctx.request.model:
        args.extend(["--model", ctx.request.model])
    if "max_steps" in ctx.request.extra_config:
        args.extend(["--max-steps", str(int(ctx.request.extra_config["max_steps"]))])
    return args


def _command_adhdbench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        "python",
        "scripts/run_benchmark.py",
        "run",
        "--provider",
        ctx.request.provider,
        "--model",
        ctx.request.model,
        "--output",
        str(ctx.output_root),
    ]
    mode = str(ctx.request.extra_config.get("mode", "")).strip().lower()
    if mode in {"quick", "full"}:
        args.append(f"--{mode}")
    if "levels" in ctx.request.extra_config and isinstance(ctx.request.extra_config["levels"], list):
        levels = [str(int(x)) for x in ctx.request.extra_config["levels"]]
        if levels:
            args.extend(["--levels", *levels])
    return args


def _command_configbench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = ["bun", "run", "src/index.ts", "--output", str(ctx.output_root)]
    if ctx.request.agent.lower() == "eliza":
        args.append("--eliza")
    return args


def _command_experience(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    mode = str(ctx.request.extra_config.get("mode", "eliza-agent"))
    args = [
        "python",
        "run_benchmark.py",
        "--mode",
        mode,
        "--provider",
        ctx.request.provider,
        "--model",
        ctx.request.model,
    ]
    if "output_file" in ctx.request.extra_config:
        args.extend(["--output", str(ctx.request.extra_config["output_file"])])
    else:
        args.extend(["--output", str(ctx.output_root / "experience-results.json")])
    if "experiences" in ctx.request.extra_config:
        args.extend(["--experiences", str(int(ctx.request.extra_config["experiences"]))])
    if "queries" in ctx.request.extra_config:
        args.extend(["--queries", str(int(ctx.request.extra_config["queries"]))])
    if "learning_cycles" in ctx.request.extra_config:
        args.extend(["--learning-cycles", str(int(ctx.request.extra_config["learning_cycles"]))])
    if "seed" in ctx.request.extra_config:
        args.extend(["--seed", str(int(ctx.request.extra_config["seed"]))])
    return args


def _command_framework(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    flags = str(ctx.request.extra_config.get("flags", "")).split()
    output_path = ctx.output_root / "framework-python-results.json"
    return ["python", "-m", "src.bench", f"--output={output_path}", *flags]


def _command_rolodex(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        "python",
        "-m",
        "benchmarks.rolodex.python_bench.run",
        "--output",
        str(ctx.output_root),
    ]
    if ctx.request.agent.lower() == "eliza":
        args.append("--eliza")
    return args


def _command_social_alpha(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    system = str(ctx.request.extra_config.get("system", "eliza"))
    data_dir = str(ctx.request.extra_config.get("data_dir", "trenches-chat-dataset/data"))
    output_dir = str(ctx.output_root)
    args = [
        "python",
        "-m",
        "benchmark.harness",
        "--data-dir",
        data_dir,
        "--system",
        system,
        "--model",
        ctx.request.model,
        "--output",
        output_dir,
    ]
    suites = ctx.request.extra_config.get("suites")
    if isinstance(suites, list):
        for suite in suites:
            args.extend(["--suite", str(suite)])
    return args


def _command_trust(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    handler = str(ctx.request.extra_config.get("handler", "eliza"))
    args = [
        "python",
        "run_benchmark.py",
        "--handler",
        handler,
        "--model-provider",
        ctx.request.provider,
        "--model",
        ctx.request.model,
        "--output",
        str(ctx.output_root / "trust-results.json"),
    ]
    categories = ctx.request.extra_config.get("categories")
    if isinstance(categories, list) and categories:
        args.extend(["--categories", *[str(item) for item in categories]])
    difficulty = ctx.request.extra_config.get("difficulty")
    if isinstance(difficulty, list) and difficulty:
        args.extend(["--difficulty", *[str(item) for item in difficulty]])
    tags = ctx.request.extra_config.get("tags")
    if isinstance(tags, list) and tags:
        args.extend(["--tags", *[str(item) for item in tags]])
    threshold = ctx.request.extra_config.get("threshold")
    if isinstance(threshold, (int, float)):
        args.extend(["--threshold", str(float(threshold))])
    return args


def _command_webshop(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        "python",
        "-m",
        "elizaos_webshop",
        "--output",
        str(ctx.output_root),
        "--model-provider",
        ctx.request.provider,
        "--model",
        ctx.request.model,
    ]
    if "max_tasks" in ctx.request.extra_config:
        args.extend(["--max-tasks", str(int(ctx.request.extra_config["max_tasks"]))])
    if bool(ctx.request.extra_config.get("sample", True)):
        args.append("--sample")
    if bool(ctx.request.extra_config.get("hf", False)):
        args.append("--hf")
    if not bool(ctx.request.extra_config.get("trajectories", False)):
        args.append("--no-trajectories")
    return args


def _command_woobench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    return [
        "python",
        "-m",
        "benchmarks.woobench",
        "--model",
        ctx.request.model,
        "--output",
        str(ctx.output_root),
    ]


def _command_hyperliquid_env(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    env: dict[str, str] = {}
    model = ctx.request.model.strip()
    provider = ctx.request.provider.strip().lower()
    if model:
        env["MODEL_NAME"] = model
    if provider:
        env["MODEL_PROVIDER"] = provider
    return env


def _command_evm(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    return ["python", "-m", "benchmarks.evm.eliza_agent"]


def _env_evm(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    model = ctx.request.model.strip()
    provider = ctx.request.provider.strip().lower()
    model_name = model if "/" in model else f"{provider}/{model}"
    return {
        "MODEL_NAME": model_name,
        "MAX_MESSAGES": str(int(ctx.request.extra_config.get("max_messages", 50))),
    }


def _command_solana(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    return ["python", "-m", "benchmarks.solana.eliza_agent"]


def _env_solana(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    env: dict[str, str] = {
        "MODEL_NAME": ctx.request.model.strip(),
        "USE_EXTERNAL_SURFPOOL": "true"
        if bool(ctx.request.extra_config.get("use_external_surfpool", False))
        else "false",
    }
    max_messages = ctx.request.extra_config.get("max_messages")
    if isinstance(max_messages, int) and max_messages > 0:
        env["MAX_MESSAGES"] = str(max_messages)
    environment_config = ctx.request.extra_config.get("environment_config")
    if isinstance(environment_config, str) and environment_config.strip():
        env["ENVIRONMENT_CONFIG"] = environment_config.strip()
    else:
        env["ENVIRONMENT_CONFIG"] = "voyager/environments/basic_env.json"
    code_file = ctx.request.extra_config.get("code_file")
    if isinstance(code_file, str) and code_file.strip():
        env["CODE_FILE"] = code_file.strip()
    return env


def _command_osworld(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        "python",
        "scripts/python/run_multienv_eliza.py",
        "--result_dir",
        str(ctx.output_root),
        "--model",
        ctx.request.model,
    ]
    provider_name = str(ctx.request.extra_config.get("provider_name", "docker")).strip()
    args.extend(["--provider_name", provider_name])
    observation_type = str(
        ctx.request.extra_config.get("observation_type", "screenshot_a11y_tree")
    ).strip()
    args.extend(["--observation_type", observation_type])

    action_space = ctx.request.extra_config.get("action_space")
    if isinstance(action_space, str) and action_space.strip():
        args.extend(["--action_space", action_space.strip()])

    max_steps = ctx.request.extra_config.get("max_steps")
    if isinstance(max_steps, int) and max_steps > 0:
        args.extend(["--max_steps", str(max_steps)])
    else:
        args.extend(["--max_steps", "15"])

    max_tasks = ctx.request.extra_config.get("max_tasks")
    if isinstance(max_tasks, int) and max_tasks > 0:
        args.extend(["--max_tasks", str(max_tasks)])
    else:
        args.extend(["--max_tasks", "1"])

    task_id = ctx.request.extra_config.get("task_id")
    if isinstance(task_id, str) and task_id.strip():
        args.extend(["--task_id", task_id.strip()])

    domain = ctx.request.extra_config.get("domain")
    if isinstance(domain, str) and domain.strip():
        args.extend(["--domain", domain.strip()])

    path_to_vm = ctx.request.extra_config.get("path_to_vm")
    if isinstance(path_to_vm, str) and path_to_vm.strip():
        args.extend(["--path_to_vm", path_to_vm.strip()])

    region = ctx.request.extra_config.get("region")
    if isinstance(region, str) and region.strip():
        args.extend(["--region", region.strip()])

    headless = ctx.request.extra_config.get("headless")
    if headless is not False:
        args.append("--headless")
    return args


def _command_milaidy_replay(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    capture_path_raw = str(ctx.request.extra_config.get("capture_path", "")).strip()
    if not capture_path_raw:
        raise ValueError(
            "milaidy_replay requires per_benchmark.milaidy_replay.capture_path to be set",
        )
    capture_path = Path(capture_path_raw).expanduser().resolve()
    if not capture_path.exists():
        raise ValueError(
            f"milaidy_replay capture_path does not exist: {capture_path}",
        )
    capture_glob = str(
        ctx.request.extra_config.get("capture_glob", "*.replay.json"),
    ).strip()
    args = [
        "python",
        "-m",
        "milady_adapter.replay_eval",
        "--input",
        str(capture_path),
        "--glob",
        capture_glob,
        "--output",
        str(ctx.output_root / "milaidy-replay-results.json"),
    ]
    return args


def _score_from_milaidy_replay(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    raw = data.get("score")
    score = float(raw) if isinstance(raw, (int, float)) else None
    metrics = data.get("metrics")
    normalized_metrics = metrics if isinstance(metrics, dict) else {}
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics=normalized_metrics,
    )


def _env_osworld(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    env: dict[str, str] = {"OSWORLD_DOCKER_RAM_CHECK": "N"}
    vm_ready_timeout = ctx.request.extra_config.get("vm_ready_timeout_seconds")
    if isinstance(vm_ready_timeout, int) and vm_ready_timeout > 0:
        env["OSWORLD_VM_READY_TIMEOUT_SECONDS"] = str(vm_ready_timeout)
    else:
        env["OSWORLD_VM_READY_TIMEOUT_SECONDS"] = "3600"

    docker_ram_size = ctx.request.extra_config.get("docker_ram_size")
    if isinstance(docker_ram_size, str) and docker_ram_size.strip():
        env["OSWORLD_DOCKER_RAM_SIZE"] = docker_ram_size.strip()
    docker_cpu_cores = ctx.request.extra_config.get("docker_cpu_cores")
    if isinstance(docker_cpu_cores, int) and docker_cpu_cores > 0:
        env["OSWORLD_DOCKER_CPU_CORES"] = str(docker_cpu_cores)
    docker_disk_size = ctx.request.extra_config.get("docker_disk_size")
    if isinstance(docker_disk_size, str) and docker_disk_size.strip():
        env["OSWORLD_DOCKER_DISK_SIZE"] = docker_disk_size.strip()
    return env


def _score_from_configbench(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    handlers = data.get("handlers", []) if isinstance(data, dict) else []
    if not isinstance(handlers, list):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    target = None
    for item in handlers:
        if not isinstance(item, dict):
            continue
        name = str(item.get("handlerName", "")).lower()
        if "eliza" in name:
            target = item
            break
    if target is None and handlers:
        first = handlers[0]
        if isinstance(first, dict):
            target = first
    if target is None:
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    overall = target.get("overallScore")
    score = float(overall) / 100.0 if isinstance(overall, (int, float)) else None
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overallScore": target.get("overallScore"),
            "securityScore": target.get("securityScore"),
            "capabilityScore": target.get("capabilityScore"),
        },
    )


def _score_from_adhd(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    per = data.get("per_scenario", {}) if isinstance(data, dict) else {}
    if not isinstance(per, dict) or not per:
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    vals: list[float] = []
    for item in per.values():
        if isinstance(item, dict):
            raw = item.get("score")
            if isinstance(raw, (int, float)):
                vals.append(float(raw))
    if not vals:
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    score = sum(vals) / len(vals)
    return ScoreSummary(score=score, unit="ratio", higher_is_better=True, metrics={"mean_score": score, "num_cases": len(vals)})


def _score_from_social_alpha(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    composite = data.get("COMPOSITE")
    score = None
    if isinstance(composite, dict):
        raw = composite.get("trust_marketplace_score")
        if isinstance(raw, (int, float)):
            score = float(raw) / 100.0
    return ScoreSummary(score=score, unit="ratio", higher_is_better=True, metrics={"composite": composite})


def _score_from_trust(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    raw = data.get("overall_f1")
    score = float(raw) if isinstance(raw, (int, float)) else None
    return ScoreSummary(score=score, unit="ratio", higher_is_better=True, metrics={"overall_f1": raw})


def _score_from_woobench(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    raw = data.get("overall_score")
    score = float(raw) / 100.0 if isinstance(raw, (int, float)) else None
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": data.get("overall_score"),
            "revenue_efficiency": data.get("revenue_efficiency"),
            "resilience_score": data.get("resilience_score"),
        },
    )


def discover_adapters(workspace_root: Path) -> AdapterDiscovery:
    benchmarks_root = workspace_root / "benchmarks"
    benchmark_dirs = sorted(
        p.name
        for p in benchmarks_root.iterdir()
        if p.is_dir()
        and p.name
        not in {"__pycache__", ".git", "benchmark_results", "orchestrator", "eliza-adapter", "viewer"}
    )

    score_extractor_factory = RegistryScoreExtractor(workspace_root)
    adapters: dict[str, BenchmarkAdapter] = {}

    registry_entries = get_benchmark_registry(workspace_root)
    registry_default_extra: dict[str, dict[str, Any]] = {
        "agentbench": {
            "elizaos": True,
        },
        "rlm_bench": {
            "mode": "eliza",
            "tasks_per_config": 1,
            "context_lengths": [1000, 10000],
            "max_iterations": 5,
            "max_depth": 3,
        },
        "swe_bench": {
            "max_instances": 1,
            "no_docker": True,
        },
        "swe_bench_orchestrated": {
            "max_instances": 1,
            "no_docker": True,
            "execution_mode": "orchestrated",
            "providers": ["claude-code", "swe-agent", "codex"],
            "strict_capabilities": True,
        },
        "gaia_orchestrated": {
            "dataset": "sample",
            "max_questions": 5,
            "execution_mode": "orchestrated",
            "providers": ["claude-code", "swe-agent", "codex"],
            "strict_capabilities": True,
        },
        "orchestrator_lifecycle": {
            "max_scenarios": 12,
            "strict": True,
        },
    }
    registry_dir_map = {
        "context_bench": "context-bench",
        "terminal_bench": "terminal-bench",
        "tau_bench": "tau-bench",
        "vending_bench": "vending-bench",
        "rlm_bench": "rlm-bench",
        "swe_bench_orchestrated": "swe_bench",
        "gaia_orchestrated": "gaia",
    }
    for entry in registry_entries:
        directory = registry_dir_map.get(entry.id, entry.id)
        if directory not in benchmark_dirs:
            if entry.id in {"osworld"} and "OSWorld" in benchmark_dirs:
                directory = "OSWorld"
            elif entry.id == "gauntlet" and "gauntlet" in benchmark_dirs:
                directory = "gauntlet"
            elif entry.id == "solana" and "solana" in benchmark_dirs:
                directory = "solana"
            elif entry.id == "agentbench" and "agentbench" in benchmark_dirs:
                directory = "agentbench"
            elif entry.id == "mind2web" and "mind2web" in benchmark_dirs:
                directory = "mind2web"
            elif entry.id == "swe_bench" and "swe_bench" in benchmark_dirs:
                directory = "swe_bench"
            elif entry.id == "swe_bench_orchestrated" and "swe_bench" in benchmark_dirs:
                directory = "swe_bench"
            elif entry.id == "mint" and "mint" in benchmark_dirs:
                directory = "mint"
            elif entry.id == "bfcl" and "bfcl" in benchmark_dirs:
                directory = "bfcl"
            elif entry.id == "realm" and "realm" in benchmark_dirs:
                directory = "realm"
            elif entry.id == "gaia" and "gaia" in benchmark_dirs:
                directory = "gaia"
            elif entry.id == "gaia_orchestrated" and "gaia" in benchmark_dirs:
                directory = "gaia"
            elif entry.id == "orchestrator_lifecycle" and "orchestrator_lifecycle" in benchmark_dirs:
                directory = "orchestrator_lifecycle"
            else:
                continue
        adapters[entry.id] = _make_registry_adapter(
            workspace_root=workspace_root,
            benchmarks_root=benchmarks_root,
            score_extractor_factory=score_extractor_factory,
            benchmark_id=entry.id,
            display_name=entry.display_name,
            description=entry.description,
            benchmark_dir=directory,
            cwd_rel=entry.cwd_rel,
            build_command=entry.build_command,
            locate_result=entry.locate_result,
            requirements_env=entry.requirements.env_vars,
            default_extra_config=registry_default_extra.get(entry.id, {}),
        )

    extras: list[BenchmarkAdapter] = [
        _make_extra_adapter(
            adapter_id="hyperliquidbench",
            directory="HyperliquidBench",
            description="HyperliquidBench Eliza coverage benchmark",
            cwd=str((benchmarks_root / "HyperliquidBench").resolve()),
            command_builder=_command_hyperliquid,
            result_patterns=["runs/**/eval_score.json", "runs/**/run_meta.json"],
            env_builder=_command_hyperliquid_env,
        ),
        _make_extra_adapter(
            adapter_id="adhdbench",
            directory="adhdbench",
            description="ADHDBench attention/context scaling benchmark",
            cwd=str((benchmarks_root / "adhdbench").resolve()),
            command_builder=_command_adhdbench,
            result_patterns=["adhdbench_summary_*.json", "*.json"],
            score_extractor=_score_from_adhd,
        ),
        _make_extra_adapter(
            adapter_id="configbench",
            directory="configbench",
            description="ConfigBench plugin configuration/security benchmark",
            cwd=str((benchmarks_root / "configbench").resolve()),
            command_builder=_command_configbench,
            result_patterns=["configbench-results-*.json", "results/configbench-results-*.json"],
            score_extractor=_score_from_configbench,
            default_timeout_seconds=14400,
        ),
        _make_extra_adapter(
            adapter_id="experience",
            directory="experience",
            description="Experience memory benchmark via Eliza agent mode",
            cwd=str((benchmarks_root / "experience").resolve()),
            command_builder=_command_experience,
            result_patterns=["experience-results.json", "*.json"],
        ),
        _make_extra_adapter(
            adapter_id="framework",
            directory="framework",
            description="Cross-runtime framework benchmark suite",
            cwd=str((benchmarks_root / "framework" / "python").resolve()),
            command_builder=_command_framework,
            result_patterns=["*.json", "results/*.json"],
        ),
        _make_extra_adapter(
            adapter_id="rolodex",
            directory="rolodex",
            description="Rolodex social identity benchmark",
            cwd=str((benchmarks_root / "rolodex").resolve()),
            command_builder=_command_rolodex,
            result_patterns=["rolodex-results-*.json", "**/rolodex-results-*.json"],
        ),
        _make_extra_adapter(
            adapter_id="social_alpha",
            directory="social-alpha",
            description="Social-alpha trust marketplace benchmark",
            cwd=str((benchmarks_root / "social-alpha").resolve()),
            command_builder=_command_social_alpha,
            result_patterns=["benchmark_results_*.json"],
            score_extractor=_score_from_social_alpha,
            default_extra_config={"suites": ["detect"]},
        ),
        _make_extra_adapter(
            adapter_id="trust",
            directory="trust",
            description="Trust/security benchmark",
            cwd=str((benchmarks_root / "trust").resolve()),
            command_builder=_command_trust,
            result_patterns=["trust-results.json", "*.json"],
            score_extractor=_score_from_trust,
            default_extra_config={
                "handler": "eliza",
                "categories": ["prompt_injection"],
                "difficulty": ["easy"],
                "threshold": 0.0,
            },
        ),
        _make_extra_adapter(
            adapter_id="webshop",
            directory="webshop",
            description="WebShop benchmark with Eliza agent",
            cwd=str((benchmarks_root / "webshop").resolve()),
            command_builder=_command_webshop,
            result_patterns=["webshop-results.json"],
            default_extra_config={
                "max_tasks": 1,
                "sample": True,
            },
        ),
        _make_extra_adapter(
            adapter_id="woobench",
            directory="woobench",
            description="WooBench mystical reading benchmark",
            cwd=str((benchmarks_root / "woobench").resolve()),
            command_builder=_command_woobench,
            result_patterns=["woobench_*.json"],
            score_extractor=_score_from_woobench,
        ),
        _make_extra_adapter(
            adapter_id="evm",
            directory="evm",
            description="EVM exploration benchmark",
            cwd=str((benchmarks_root / "evm").resolve()),
            command_builder=_command_evm,
            env_builder=_env_evm,
            result_patterns=["metrics/evm_*_metrics.json"],
        ),
        _make_extra_adapter(
            adapter_id="solana",
            directory="solana",
            description="Solana instruction discovery benchmark via Eliza agent",
            cwd=str(workspace_root.resolve()),
            command_builder=_command_solana,
            env_builder=_env_solana,
            result_patterns=["benchmarks/solana/solana-gym-env/metrics/eliza_*_metrics.json"],
            score_extractor=score_extractor_factory.for_benchmark("solana"),
            default_timeout_seconds=14400,
            default_extra_config={
                "environment_config": "voyager/environments/basic_env.json",
                "max_messages": 2,
            },
        ),
        _make_extra_adapter(
            adapter_id="osworld",
            directory="OSWorld",
            description="OSWorld desktop benchmark via Eliza agent",
            cwd=str((benchmarks_root / "OSWorld").resolve()),
            command_builder=_command_osworld,
            env_builder=_env_osworld,
            result_patterns=["osworld-eliza-results-*.json"],
            score_extractor=score_extractor_factory.for_benchmark("osworld"),
            default_timeout_seconds=21600,
            default_extra_config={
                "docker_cpu_cores": 2,
                "headless": True,
                "max_tasks": 1,
                "vm_ready_timeout_seconds": 21600,
            },
        ),
        _make_extra_adapter(
            adapter_id="milaidy_replay",
            directory="milaidy-adapter",
            description="Replay benchmark over normalized Eliza PARALLAX captures",
            cwd=str((benchmarks_root / "milaidy-adapter").resolve()),
            command_builder=_command_milaidy_replay,
            result_patterns=["milaidy-replay-results.json", "*.json"],
            score_extractor=_score_from_milaidy_replay,
            default_timeout_seconds=300,
            default_extra_config={
                "capture_glob": "*.replay.json",
            },
            capability_notes="Offline replay scoring; capture_path should point to normalized replay artifacts.",
        ),
    ]

    for adapter in extras:
        if adapter.directory in benchmark_dirs:
            adapters[adapter.id] = adapter

    return AdapterDiscovery(adapters=adapters, all_directories=tuple(benchmark_dirs))
