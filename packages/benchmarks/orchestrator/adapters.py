from __future__ import annotations

import os
import re
import shlex
import sys
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


IGNORED_BENCHMARK_DIRS = {
    "__pycache__",
    ".git",
    ".pytest_cache",
    "benchmark_results",
    "claw-eval",
    # Distribution-name shim for benchmarks.mmau, not a separate benchmark.
    "elizaos_mmau",
    "eliza-adapter",
    "hermes-adapter",
    "openclaw-adapter",
    "lib",
    "nl2repo",
    "orchestrator",
    "qwen-claw-bench",
    "qwen-web-bench",
    # Python package shim for benchmarks.registry, not a benchmark adapter dir.
    "registry",
    "scripts",
    "skillsbench",
    "swe-bench-pro",
    "swe-bench-multilingual",
    "swe-bench-workspace",
    "tests",
    "viewer",
}


# Harness compatibility lookup. The benchmark matrix is intentionally
# tri-harness by default so `--all-harnesses` remains a full Eliza/Hermes/
# OpenClaw comparison unless a future adapter adds a hard exclusion here.
ALL_HARNESSES: tuple[str, ...] = ("eliza", "openclaw", "hermes")
AGENT_COMPATIBILITY_OVERRIDES: dict[str, tuple[str, ...]] = {
    # CompactBench currently exercises elizaOS conversation-compactor
    # implementations through a Python bridge. Hermes/OpenClaw rows would be
    # misleading labels unless explicit per-agent compactor methods are added.
    "compactbench": ("eliza",),
    # LOCA has real Eliza and Hermes proxy paths. OpenClaw's current LOCA path
    # is an explicit provider-level smoke mode, not native OpenClaw agent
    # parity, so keep it out of cross-agent result matrices.
    "loca_bench": ("eliza", "hermes"),
    # ConfigBench currently has an in-process Eliza handler plus oracle/mock
    # handlers. Hermes/OpenClaw rows were previously scored against the
    # Perfect oracle fallback, which is not a real harness comparison.
    "configbench": ("eliza",),
    # FrameworkBench measures the local elizaOS TypeScript runtime with a mock
    # LLM. It does not invoke Hermes/OpenClaw, so tri-harness labels are
    # misleading until real per-harness framework drivers exist.
    "framework": ("eliza",),
    # VoiceBench currently instantiates the local TypeScript runtime directly;
    # Hermes/OpenClaw labels run the same mock voice path with zero LLM calls.
    "voicebench": ("eliza",),
    # These tracks are native hermes-agent environments invoked through
    # hermes_adapter/run_env_cli.py. Eliza/OpenClaw labels would still run the
    # Hermes loop, so keep them Hermes-only until separate env drivers exist.
    "hermes_tblite": ("hermes",),
    "hermes_terminalbench_2": ("hermes",),
    "hermes_yc_bench": ("hermes",),
    "hermes_swe_env": ("hermes",),
    # These benchmarks currently bypass the selected harness entirely. Keeping
    # them out of real-agent publication is safer than emitting rows labeled as
    # Eliza/Hermes/OpenClaw that all exercised the same direct-provider path.
    "openclaw_bench": (),
    "interrupt_bench": (),
}


def _agent_compatibility_for(benchmark_id: str) -> tuple[str, ...]:
    return AGENT_COMPATIBILITY_OVERRIDES.get(benchmark_id, ALL_HARNESSES)


def _is_benchmark_directory(path: Path) -> bool:
    if not path.is_dir():
        return False
    name = path.name
    if name.startswith("."):
        return False
    return name not in IGNORED_BENCHMARK_DIRS


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
    adapter_python_paths = [
        str((benchmarks_root / "eliza-adapter").resolve()),
        str((benchmarks_root / "hermes-adapter").resolve()),
        str((benchmarks_root / "openclaw-adapter").resolve()),
    ]
    lifeops_bench_path = benchmarks_root / "lifeops-bench"
    if lifeops_bench_path.exists():
        adapter_python_paths.append(str(lifeops_bench_path.resolve()))
    if benchmark_id == "gauntlet":
        adapter_python_paths.append(str((benchmarks_root / "gauntlet" / "src").resolve()))

    def env_builder(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
        existing = ctx.env.get("PYTHONPATH", "")
        pythonpath = (
            os.pathsep.join([*adapter_python_paths, existing])
            if existing
            else os.pathsep.join(adapter_python_paths)
        )
        env = {"PYTHONPATH": pythonpath}
        for extra_key, env_key in (
            ("openclaw_timeout_s", "OPENCLAW_TIMEOUT_S"),
            ("hermes_timeout_s", "HERMES_TIMEOUT_S"),
            ("eliza_bench_http_timeout_s", "ELIZA_BENCH_HTTP_TIMEOUT"),
        ):
            value = ctx.request.extra_config.get(extra_key)
            if isinstance(value, (int, float)) and value > 0:
                env[env_key] = str(float(value))
        harness = str(
            ctx.request.extra_config.get("agent")
            or ctx.request.extra_config.get("harness")
            or ctx.request.agent
        ).strip().lower()
        if benchmark_id == "bfcl" and harness == "openclaw":
            env["OPENCLAW_DIRECT_OPENAI_COMPAT"] = "1"
            env["OPENCLAW_USE_CLI"] = "0"
        return env

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
        env_builder=env_builder,
        agent_compatibility=_agent_compatibility_for(benchmark_id),
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
        agent_compatibility=_agent_compatibility_for(adapter_id),
    )


def _command_hyperliquid(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        sys.executable,
        "-m",
        "benchmarks.HyperliquidBench",
        "--coverage",
        "--output",
        str(ctx.output_root),
    ]
    if ctx.request.model:
        args.extend(["--model", ctx.request.model])
    if "max_steps" in ctx.request.extra_config:
        args.extend(["--max-steps", str(int(ctx.request.extra_config["max_steps"]))])
    return args


def _command_adhdbench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    provider = ctx.request.provider.strip().lower()
    # Route LLM-backed providers through the eliza TS bridge by default so
    # the registered eliza agent + plugins are exercised. Callers can
    # opt out via extra_config "use_direct_provider": True.
    bridge_providers = {"cerebras", "openai", "groq", "openrouter", "vllm", "eliza"}
    use_direct = bool(ctx.request.extra_config.get("use_direct_provider"))
    effective_provider = (
        "eliza" if (provider in bridge_providers and not use_direct) else ctx.request.provider
    )
    args = [
        sys.executable,
        "scripts/run_benchmark.py",
        "run",
        "--provider",
        effective_provider,
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
    if "ids" in ctx.request.extra_config and isinstance(ctx.request.extra_config["ids"], list):
        ids = [str(x) for x in ctx.request.extra_config["ids"] if str(x)]
        if ids:
            args.extend(["--ids", *ids])
    if "tags" in ctx.request.extra_config and isinstance(ctx.request.extra_config["tags"], list):
        tags = [str(x) for x in ctx.request.extra_config["tags"] if str(x)]
        if tags:
            args.extend(["--tags", *tags])
    if ctx.request.extra_config.get("basic_only"):
        args.append("--basic-only")
    if ctx.request.extra_config.get("full_only"):
        args.append("--full-only")
    return args


def _command_configbench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = ["bun", "run", "src/index.ts", "--output", str(ctx.output_root)]
    agent = ctx.request.extra_config.get("agent")
    provider_name = ctx.request.provider.strip().lower()
    if (
        ctx.request.agent.lower() == "eliza"
        or agent == "eliza"
        or ctx.request.extra_config.get("eliza") is True
        or provider_name == "eliza"
    ):
        args.append("--eliza")
    limit = ctx.request.extra_config.get("limit")
    if isinstance(limit, int) and limit > 0:
        args.extend(["--limit", str(limit)])
    if ctx.request.extra_config.get("verbose") is True:
        args.append("--verbose")
    return args


def _env_configbench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    provider_name = ctx.request.provider.strip().lower()
    env: dict[str, str] = {}
    if provider_name in {"groq", "openai", "anthropic"}:
        env["CONFIGBENCH_AGENT_PROVIDER"] = provider_name
    elif provider_name in {"cerebras", "openrouter", "vllm"}:
        env["CONFIGBENCH_AGENT_PROVIDER"] = "openai"
    if provider_name == "groq" and ctx.request.model.strip():
        env["GROQ_SMALL_MODEL"] = ctx.request.model.strip()
        env["GROQ_LARGE_MODEL"] = ctx.request.model.strip()
    elif provider_name in {"openai", "cerebras", "openrouter", "vllm"} and ctx.request.model.strip():
        env["OPENAI_SMALL_MODEL"] = ctx.request.model.strip()
        env["OPENAI_LARGE_MODEL"] = ctx.request.model.strip()
    return env


def _command_experience(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    mode = str(ctx.request.extra_config.get("mode", "eliza-agent"))
    args = [
        sys.executable,
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
    experiences = ctx.request.extra_config.get("experiences")
    if isinstance(experiences, int) and experiences > 0:
        args.extend(["--experiences", str(experiences)])
    queries = ctx.request.extra_config.get("queries", ctx.request.extra_config.get("max_tasks"))
    if isinstance(queries, int) and queries > 0:
        args.extend(["--queries", str(queries)])
    learning_cycles = ctx.request.extra_config.get(
        "learning_cycles",
        ctx.request.extra_config.get("max_tasks"),
    )
    if isinstance(learning_cycles, int) and learning_cycles > 0:
        args.extend(["--learning-cycles", str(learning_cycles)])
    if "seed" in ctx.request.extra_config:
        args.extend(["--seed", str(int(ctx.request.extra_config["seed"]))])
    return args


def _command_app_eval(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    mode = str(ctx.request.extra_config.get("mode", "bridge")).strip().lower()
    if mode in {"app-cli", "legacy"}:
        args = [
            "bun",
            "run",
            "run-benchmarks.ts",
            "--root",
            str(ctx.workspace_root.parent.resolve()),
        ]
        task_type = ctx.request.extra_config.get("type")
        if isinstance(task_type, str) and task_type.strip():
            args.extend(["--type", task_type.strip()])
        task_id = ctx.request.extra_config.get("task")
        if isinstance(task_id, str) and task_id.strip():
            args.extend(["--task", task_id.strip()])
        timeout = ctx.request.extra_config.get("timeout_ms")
        if isinstance(timeout, int) and timeout > 0:
            args.extend(["--timeout", str(timeout)])
        if ctx.request.extra_config.get("server") is True:
            args.append("--server")
        if ctx.request.extra_config.get("verbose") is True:
            args.append("--verbose")
        return args

    args = [
        sys.executable,
        "-m",
        "eliza_adapter.app_eval",
        "--tasks-dir",
        str((ctx.benchmarks_root / "app-eval" / "tasks").resolve()),
        "--output",
        str(ctx.output_root / "summary.json"),
    ]
    task_type = ctx.request.extra_config.get("type")
    if isinstance(task_type, str) and task_type.strip():
        args.extend(["--type", task_type.strip()])
    task_id = ctx.request.extra_config.get("task")
    if isinstance(task_id, str) and task_id.strip():
        args.extend(["--task", task_id.strip()])
    timeout = ctx.request.extra_config.get("timeout_ms")
    if isinstance(timeout, int) and timeout > 0:
        args.extend(["--timeout-ms", str(timeout)])
    return args


def _env_app_eval(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    existing = ctx.env.get("PYTHONPATH", "")
    adapter_path = str((ctx.benchmarks_root / "eliza-adapter").resolve())
    env = {
        "PYTHONPATH": os.pathsep.join([adapter_path, existing]).rstrip(os.pathsep),
        "ELIZA_APP_ROOT": str(ctx.workspace_root.parent.resolve()),
        "ELIZA_HEADLESS": "1",
        "LOG_LEVEL": "error",
    }
    model = ctx.request.model.strip()
    provider = ctx.request.provider.strip().upper()
    if model:
        env.update({
            "BENCHMARK_MODEL_NAME": model,
            "MODEL_NAME": model,
            "SMALL_MODEL": model,
            "LARGE_MODEL": model,
        })
        if provider and provider != "MOCK":
            env[f"{provider}_SMALL_MODEL"] = model
            env[f"{provider}_LARGE_MODEL"] = model
    return env


def _command_framework(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    flags = shlex.split(str(ctx.request.extra_config.get("flags", "")))
    output_path = ctx.output_root / "framework-results.json"
    return [
        "bun",
        "run",
        "benchmarks/framework/typescript/src/bench.ts",
        f"--output={output_path}",
        *flags,
    ]


def _command_rolodex(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        sys.executable,
        "-m",
        "benchmarks.rolodex.python_bench.run",
        "--output",
        str(ctx.output_root),
    ]
    if ctx.request.agent.lower() == "eliza":
        args.append("--eliza")
    return args


def _command_social_alpha(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    system_raw = ctx.request.extra_config.get("system")
    if isinstance(system_raw, str) and system_raw.strip():
        system = system_raw.strip()
    elif ctx.request.provider.strip().lower() in {
        "eliza",
        "eliza-bridge",
        "eliza-ts",
        "cerebras",
        "openai",
        "groq",
        "openrouter",
        "vllm",
    }:
        # Route LLM-backed providers through the eliza TS bridge so the actual
        # registered eliza agent + plugin-social-alpha is exercised, not the
        # Python port in benchmark/systems/full_system.py.
        system = "eliza-bridge"
    else:
        system = "baseline"
    data_dir = str(ctx.request.extra_config.get("data_dir", "trenches-chat-dataset/data"))
    output_dir = str(ctx.output_root)
    args = [
        sys.executable,
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
    handler = str(ctx.request.extra_config.get("handler", "oracle"))
    provider_name = ctx.request.provider.strip().lower()
    # Route LLM-backed providers through the eliza TS bridge handler when
    # the caller didn't explicitly request a different handler.
    bridge_providers = {"cerebras", "openai", "groq", "openrouter", "vllm", "eliza"}
    if (
        handler == "oracle"
        and "handler" not in ctx.request.extra_config
        and provider_name in bridge_providers
    ):
        handler = "eliza"
    args = [
        sys.executable,
        "run_benchmark.py",
        "--handler",
        handler,
        "--output",
        str(ctx.output_root / "trust-results.json"),
    ]
    if handler in {"eliza", "llm"}:
        args.extend(["--model-provider", ctx.request.provider, "--model", ctx.request.model])
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
        sys.executable,
        "-m",
        "elizaos_webshop",
        "--output",
        str(ctx.output_root),
    ]
    provider_lower = ctx.request.provider.strip().lower()
    if ctx.request.extra_config.get("mock") is True or provider_lower == "mock":
        args.append("--mock")
    else:
        args.append("--bridge")
        if ctx.request.provider and provider_lower not in {"eliza", "eliza-bridge", "eliza-ts"}:
            args.extend(["--model-provider", ctx.request.provider])
        if ctx.request.model:
            args.extend(["--model", ctx.request.model])

    for extra_key, cli_key in (
        ("max_tasks", "--max-tasks"),
        ("max_turns", "--max-turns"),
        ("trials", "--trials"),
    ):
        value = ctx.request.extra_config.get(extra_key)
        if isinstance(value, int) and value > 0:
            args.extend([cli_key, str(value)])

    if bool(ctx.request.extra_config.get("hf", False)):
        args.append("--hf")
        split = ctx.request.extra_config.get("split")
        if isinstance(split, str) and split.strip():
            args.extend(["--split", split.strip()])
    elif bool(ctx.request.extra_config.get("sample", True)):
        args.append("--sample")

    if bool(ctx.request.extra_config.get("trajectories", False)):
        args.append("--trajectories")
    if not bool(ctx.request.extra_config.get("trajectories", False)):
        args.append("--no-trajectories")
    temperature = ctx.request.extra_config.get("temperature")
    if isinstance(temperature, (int, float)):
        args.extend(["--temperature", str(float(temperature))])
    return args


def _env_webshop(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    existing = ctx.env.get("PYTHONPATH", "")
    adapter_path = str((ctx.benchmarks_root / "eliza-adapter").resolve())
    return {
        "PYTHONPATH": os.pathsep.join([adapter_path, existing]).rstrip(os.pathsep),
    }


def _command_woobench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        sys.executable,
        "-m",
        "benchmarks.woobench",
        "--model",
        ctx.request.model,
        "--output",
        str(ctx.output_root),
    ]
    provider_lower = ctx.request.provider.strip().lower()
    agent_lower = ctx.request.agent.strip().lower()
    payment_mode = ctx.request.extra_config.get("payment") is True or ctx.request.extra_config.get("payments") is True
    if ctx.request.extra_config.get("mock") is True or provider_lower == "mock" or agent_lower == "dummy":
        args.extend(["--agent", "dummy-charge" if payment_mode else "dummy"])
        args.extend(["--evaluator", "heuristic"])
    else:
        args.extend(["--agent", "eliza"])
        evaluator = ctx.request.extra_config.get("evaluator")
        if isinstance(evaluator, str) and evaluator in {"llm", "heuristic"}:
            args.extend(["--evaluator", evaluator])

    payment_mock_url = ctx.request.extra_config.get("payment_mock_url")
    if isinstance(payment_mock_url, str) and payment_mock_url.strip():
        args.extend(["--payment-mock-url", payment_mock_url.strip()])

    scenarios = ctx.request.extra_config.get("scenarios")
    if isinstance(scenarios, list):
        scenario_ids = [
            str(item).strip()
            for item in scenarios
            if isinstance(item, str) and item.strip()
        ]
        if scenario_ids:
            args.extend(["--scenarios", ",".join(scenario_ids)])
    elif isinstance(scenarios, str) and scenarios.strip():
        args.extend(["--scenarios", scenarios.strip()])

    if "--scenarios" not in args:
        for extra_key, cli_key in (
            ("scenario", "--scenario"),
            ("system", "--system"),
            ("persona", "--persona"),
        ):
            value = ctx.request.extra_config.get(extra_key)
            if isinstance(value, str) and value.strip():
                args.extend([cli_key, value.strip()])

    max_tasks = ctx.request.extra_config.get("max_tasks")
    has_scope_filter = False
    for key in ("scenarios", "scenario", "system", "persona"):
        value = ctx.request.extra_config.get(key)
        if isinstance(value, str) and value.strip():
            has_scope_filter = True
        elif isinstance(value, list) and any(
            isinstance(item, str) and item.strip() for item in value
        ):
            has_scope_filter = True
    if isinstance(max_tasks, int) and max_tasks == 1 and not has_scope_filter:
        args.extend(["--scenario", "skeptic_tarot_01"])

    concurrency = ctx.request.extra_config.get("concurrency")
    if isinstance(concurrency, int) and concurrency > 0:
        args.extend(["--concurrency", str(concurrency)])
    random_seed = ctx.request.extra_config.get("random_seed", ctx.request.extra_config.get("seed"))
    if isinstance(random_seed, int):
        args.extend(["--random-seed", str(random_seed)])
    return args


def _env_woobench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    existing = ctx.env.get("PYTHONPATH", "")
    adapter_path = str((ctx.benchmarks_root / "eliza-adapter").resolve())
    env = {
        "PYTHONPATH": os.pathsep.join([adapter_path, existing]).rstrip(os.pathsep),
    }
    model = ctx.request.model.strip()
    provider = ctx.request.provider.strip().upper()
    if model:
        env.update({
            "BENCHMARK_MODEL_NAME": model,
            "MODEL_NAME": model,
            "SMALL_MODEL": model,
            "LARGE_MODEL": model,
        })
        if provider and provider != "MOCK":
            env[f"{provider}_SMALL_MODEL"] = model
            env[f"{provider}_LARGE_MODEL"] = model
    return env


def _command_hyperliquid_env(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    existing = ctx.env.get("PYTHONPATH", "")
    adapter_path = str((ctx.benchmarks_root / "eliza-adapter").resolve())
    env: dict[str, str] = {
        "PYTHONPATH": os.pathsep.join([adapter_path, existing]).rstrip(os.pathsep),
    }
    model = ctx.request.model.strip()
    provider = ctx.request.provider.strip().lower()
    if model:
        env["MODEL_NAME"] = model
    if provider:
        env["MODEL_PROVIDER"] = provider
    return env


def _command_evm(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    return [sys.executable, "-m", "benchmarks.evm.eliza_explorer"]


def _env_evm(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    existing = ctx.env.get("PYTHONPATH", "")
    adapter_path = str((ctx.benchmarks_root / "eliza-adapter").resolve())
    env: dict[str, str] = {
        "PYTHONPATH": os.pathsep.join([adapter_path, existing]).rstrip(os.pathsep),
    }
    model = ctx.request.model.strip()
    provider = ctx.request.provider.strip().lower()
    model_name = model if "/" in model or not provider else f"{provider}/{model}"
    env.update({
        "MODEL_NAME": model_name,
        "MAX_MESSAGES": str(int(ctx.request.extra_config.get("max_messages", 50))),
        "METRICS_DIR": str(ctx.output_root / "metrics"),
    })

    passthrough = {
        "chain": "CHAIN",
        "environment_config": "ENVIRONMENT_CONFIG",
        "rpc_url": "RPC_URL",
        "chain_id": "CHAIN_ID",
        "fork_url": "FORK_URL",
        "agent_private_key": "AGENT_PRIVATE_KEY",
        "code_file": "CODE_FILE",
        "run_index": "RUN_INDEX",
    }
    for config_key, env_key in passthrough.items():
        value = ctx.request.extra_config.get(config_key)
        if value is not None and str(value).strip():
            env[env_key] = str(value).strip()

    if "use_external_node" in ctx.request.extra_config:
        env["USE_EXTERNAL_NODE"] = (
            "true" if bool(ctx.request.extra_config["use_external_node"]) else "false"
        )

    return env


def _score_from_evm(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    raw = data.get("final_reward")
    if not isinstance(raw, (int, float)):
        raise ValueError("evm result is incomplete: missing numeric final_reward")
    score = float(raw) if isinstance(raw, (int, float)) else None
    return ScoreSummary(
        score=score,
        unit="unique_selectors",
        higher_is_better=True,
        metrics={
            "final_reward": raw,
            "final_contracts": data.get("final_contracts", 0),
            "model": data.get("model", ""),
            "run_id": data.get("run_id", ""),
            "chain": data.get("chain", ""),
        },
    )


def _command_solana(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    return [
        sys.executable,
        "-m",
        "benchmarks.solana.eliza_agent",
        "--output-dir",
        str(ctx.output_root),
    ]


def _env_solana(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    existing = ctx.env.get("PYTHONPATH", "")
    adapter_path = str((ctx.benchmarks_root / "eliza-adapter").resolve())
    env: dict[str, str] = {
        "PYTHONPATH": os.pathsep.join([adapter_path, existing]).rstrip(os.pathsep),
        "MODEL_NAME": ctx.request.model.strip(),
        "OUTPUT_DIR": str(ctx.output_root),
        "USE_EXTERNAL_SURFPOOL": "true"
        if bool(ctx.request.extra_config.get("use_external_surfpool", False))
        else "false",
    }
    max_messages = ctx.request.extra_config.get("max_messages")
    if not isinstance(max_messages, int):
        max_messages = ctx.request.extra_config.get("max_tasks")
    if isinstance(max_messages, int) and max_messages >= 0:
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
        sys.executable,
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
    dry_run = ctx.request.extra_config.get("dry_run")
    if dry_run is True:
        args.append("--dry_run")
    return args


def _command_eliza_replay(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    capture_path_raw = str(ctx.request.extra_config.get("capture_path", "")).strip()
    if not capture_path_raw:
        raise ValueError(
            "eliza_replay requires per_benchmark.eliza_replay.capture_path to be set",
        )
    capture_path = Path(capture_path_raw).expanduser().resolve()
    if not capture_path.exists():
        raise ValueError(
            f"eliza_replay capture_path does not exist: {capture_path}",
        )
    capture_glob = str(
        ctx.request.extra_config.get("capture_glob", "*.replay.json"),
    ).strip()
    args = [
        sys.executable,
        "-m",
        "eliza_adapter.replay_eval",
        "--input",
        str(capture_path),
        "--glob",
        capture_glob,
        "--output",
        str(ctx.output_root / "eliza-replay-results.json"),
    ]
    return args


def _score_from_eliza_replay(path: Path) -> ScoreSummary:
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


def _score_from_experience(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    agent = data.get("eliza_agent", {}) if isinstance(data, dict) else {}
    if not isinstance(agent, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})

    values: list[float] = []
    metrics: dict[str, Any] = {}
    for key in (
        "learning_success_rate",
        "agent_recall_rate",
        "agent_keyword_incorporation_rate",
        "direct_recall_rate",
    ):
        raw = agent.get(key)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            val = float(raw)
            metrics[key] = val
            values.append(val)

    if not values:
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics=metrics)
    return ScoreSummary(
        score=sum(values) / len(values),
        unit="ratio",
        higher_is_better=True,
        metrics=metrics,
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


def _score_from_app_eval(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})

    overall_raw = data.get("overall_score")
    score = None
    if isinstance(overall_raw, (int, float)):
        # app-eval scores tasks on a 0..10 rubric; normalize for leaderboard
        # parity while keeping the raw score in metrics.
        score = max(0.0, min(float(overall_raw) / 10.0, 1.0))

    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": overall_raw,
            "total_tasks": data.get("total_tasks", 0),
            "completed": data.get("completed", 0),
            "failed": data.get("failed", 0),
            "timed_out": data.get("timed_out", 0),
            "avg_duration_ms": data.get("avg_duration_ms", 0),
        },
    )


def _score_from_social_alpha(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    composite = data.get("COMPOSITE")
    suite_scores: dict[str, float] = {}
    for key, value in data.items():
        if key == "COMPOSITE" or not isinstance(value, dict):
            continue
        suite_score = value.get("suite_score")
        if isinstance(suite_score, (int, float)):
            suite_scores[key] = float(suite_score)
    score = None
    if isinstance(composite, dict):
        raw = composite.get("trust_marketplace_score")
        if isinstance(raw, (int, float)):
            score = float(raw) / 100.0
    if score is None and suite_scores:
        score = (sum(suite_scores.values()) / len(suite_scores)) / 100.0
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={"composite": composite, "suite_scores": suite_scores},
    )


def _score_from_trust(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    raw = data.get("overall_f1")
    score = float(raw) if isinstance(raw, (int, float)) else None
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_f1": raw,
            "false_positive_rate": data.get("false_positive_rate"),
            "total_tests": data.get("total_tests"),
            "handler_name": data.get("handler_name"),
        },
    )


def _score_from_woobench(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    raw = data.get("overall_score")
    score = float(raw) / 100.0 if isinstance(raw, (int, float)) else None
    scenarios = data.get("scenarios", [])
    scenario_rows = scenarios if isinstance(scenarios, list) else []
    total_revenue_raw = data.get("total_revenue")
    total_revenue = float(total_revenue_raw) if isinstance(total_revenue_raw, (int, float)) else 0.0
    converted_count = sum(
        1 for scenario in scenario_rows
        if isinstance(scenario, dict) and scenario.get("payment_converted") is True
    )
    completed_count = sum(
        1 for scenario in scenario_rows
        if isinstance(scenario, dict) and scenario.get("agent_responsive") is True
    )
    total_instances = len(scenario_rows)
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": data.get("overall_score"),
            "revenue_efficiency": data.get("revenue_efficiency"),
            "resilience_score": data.get("resilience_score"),
            "failed_scenarios": data.get("failed_scenarios"),
            "total_revenue": total_revenue,
            "avg_revenue_per_scenario": (
                total_revenue / total_instances if total_instances else 0.0
            ),
            "payment_converted_count": converted_count,
            "completed_reading_count": completed_count,
            "total_instances": total_instances,
            "interrupted": data.get("interrupted") is True,
        },
    )


def _score_from_framework(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    scenarios = data.get("scenarios", {}) if isinstance(data, dict) else {}
    if not isinstance(scenarios, dict) or not scenarios:
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})

    total_messages = 0.0
    total_time_ms = 0.0
    latency_values: list[float] = []
    for result in scenarios.values():
        if not isinstance(result, dict):
            continue
        throughput = result.get("throughput", {})
        if isinstance(throughput, dict):
            messages = throughput.get("total_messages")
            elapsed = throughput.get("total_time_ms")
            if isinstance(messages, (int, float)) and isinstance(elapsed, (int, float)):
                total_messages += float(messages)
                total_time_ms += float(elapsed)
        latency = result.get("latency", {})
        avg_ms = latency.get("avg_ms") if isinstance(latency, dict) else None
        if isinstance(avg_ms, (int, float)):
            latency_values.append(float(avg_ms))

    if total_messages > 0 and total_time_ms > 0:
        score = (total_messages / total_time_ms) * 1000.0
        unit = "messages_per_second"
    elif latency_values:
        mean_latency = sum(latency_values) / len(latency_values)
        score = 1000.0 / mean_latency if mean_latency > 0 else None
        unit = "operations_per_second"
    else:
        score = None
        unit = None

    return ScoreSummary(
        score=score,
        unit=unit,
        higher_is_better=True,
        metrics={
            "runtime": data.get("runtime"),
            "scenario_count": len(scenarios),
            "total_messages": total_messages,
            "total_time_ms": total_time_ms,
            "mean_latency_ms": sum(latency_values) / len(latency_values)
            if latency_values
            else None,
        },
    )


def _command_compactbench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    method = str(
        ctx.request.extra_config.get(
            "method",
            "eliza_compactbench/compactors/__init__.py:HybridLedgerCompactor",
        )
    )
    compactbench_root = Path(adapter.cwd)
    venv_python = compactbench_root / ".venv" / "bin" / "python"
    python_executable = str(venv_python) if venv_python.exists() else sys.executable
    args = [
        python_executable,
        "run_cerebras.py",
        "--method",
        method,
        "--model",
        ctx.request.model,
        "--output",
        str(ctx.output_root / "compactbench-results.jsonl"),
        "--case-count",
        str(int(ctx.request.extra_config.get("case_count", ctx.request.extra_config.get("max_tasks", 1)))),
        "--drift-cycles",
        str(int(ctx.request.extra_config.get("drift_cycles", 1))),
    ]
    suite = ctx.request.extra_config.get("suite")
    if isinstance(suite, str) and suite.strip():
        args.extend(["--suite", suite.strip()])
    difficulty = ctx.request.extra_config.get("difficulty")
    if isinstance(difficulty, str) and difficulty.strip():
        args.extend(["--difficulty", difficulty.strip()])
    benchmarks_dir = ctx.request.extra_config.get("benchmarks_dir")
    if isinstance(benchmarks_dir, str) and benchmarks_dir.strip():
        args.extend(["--benchmarks-dir", benchmarks_dir.strip()])
    if ctx.request.extra_config.get("resume") is True:
        args.append("--resume")
    if ctx.request.extra_config.get("score") is True:
        args.append("--score")
    if ctx.request.extra_config.get("analyze_valid_hits", True) is not False:
        args.append("--analyze-valid-hits")
        args.extend(
            [
                "--valid-hit-output",
                str(ctx.output_root / "compactbench-results.valid-hits.jsonl"),
            ]
        )
    return args


def _score_from_compactbench(path: Path) -> ScoreSummary:
    import json

    if path.name.endswith(".valid-hits.jsonl"):
        valid_path = path
    else:
        valid_path = path.with_name(f"{path.stem}.valid-hits.jsonl")
    if not valid_path.exists():
        raise ValueError(
            "compactbench repaired valid-hit analysis is required; "
            "set analyze_valid_hits=true or run run_cerebras.py with "
            "--analyze-valid-hits"
        )
    analysis_end: dict[str, Any] | None = None
    for line in valid_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and item.get("event") == "analysis_end":
            analysis_end = item
    if analysis_end is None:
        raise ValueError("compactbench valid-hit analysis missing analysis_end event")
    raw = analysis_end.get("overall_score")
    score = float(raw) if isinstance(raw, (int, float)) else None
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "scorer_name": "repaired_valid_hits",
            "overall_score": raw,
            "benchmark_quality_score": analysis_end.get(
                "benchmark_quality_score"
            ),
            "raw_lexical_overall_score": analysis_end.get(
                "raw_lexical_overall_score"
            ),
            "valid_false_negatives": analysis_end.get("valid_false_negatives"),
            "semantic_false_positives": analysis_end.get(
                "semantic_false_positives"
            ),
            "failures_remaining": analysis_end.get("failures_remaining"),
            "repaired_expected_conflicts": analysis_end.get(
                "repaired_expected_conflicts"
            ),
            "removed_invalid_items": analysis_end.get("removed_invalid_items"),
            "judge_refusals": analysis_end.get("judge_refusals"),
        },
    )


def _command_loca_bench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        sys.executable,
        "-m",
        "eliza_loca.run_cerebras",
        "--model",
        ctx.request.model,
        "--output-dir",
        str(ctx.output_root / "loca-output"),
        "--max-workers",
        str(int(ctx.request.extra_config.get("max_workers", 1))),
        "--max-tool-uses",
        str(int(ctx.request.extra_config.get("max_tool_uses", 10))),
        "--max-tokens",
        str(int(ctx.request.extra_config.get("max_tokens", 2048))),
        "--timeout",
        str(int(ctx.request.extra_config.get("timeout", 300))),
        "--max-retries",
        str(int(ctx.request.extra_config.get("max_retries", 1))),
    ]
    config = ctx.request.extra_config.get("config")
    if isinstance(config, str) and config.strip():
        args.extend(["--config", config.strip()])
    else:
        args.extend(["--config", "task-configs/debug.json"])
    strategy = ctx.request.extra_config.get("strategy")
    if isinstance(strategy, str) and strategy.strip():
        args.extend(["--strategy", strategy.strip()])
    max_steps = ctx.request.extra_config.get("max_steps", ctx.request.extra_config.get("max_tasks"))
    if isinstance(max_steps, int) and max_steps > 0:
        args.extend(["--max-steps", str(max_steps)])
    for key, flag, caster in [
        ("max_context_size", "--max-context-size", int),
        ("reset_size", "--reset-size", int),
        ("reset_ratio", "--reset-ratio", float),
        ("memory_warning_threshold", "--memory-warning-threshold", float),
        ("keep_thinking", "--keep-thinking", int),
    ]:
        if key in ctx.request.extra_config:
            args.extend([flag, str(caster(ctx.request.extra_config[key]))])
    context_summary = ctx.request.extra_config.get("context_summary")
    if context_summary is not False:
        args.append("--context-summary")
    if ctx.request.extra_config.get("context_awareness") is True:
        args.append("--context-awareness")
    reasoning_effort = ctx.request.extra_config.get("reasoning_effort")
    if isinstance(reasoning_effort, str) and reasoning_effort.strip():
        args.extend(["--reasoning-effort", reasoning_effort.strip()])
    if ctx.request.extra_config.get("dry_run") is True:
        args.append("--dry-run")
        args.append("--allow-empty")
    return args


def _score_from_loca_bench(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    summary = data.get("summary") if isinstance(data, dict) else None
    if not isinstance(summary, dict):
        raise ValueError("loca-bench audit missing summary")
    raw = summary.get("avg_accuracy")
    trajectory_count = summary.get("trajectory_count")
    aggregate_trajectory_count = summary.get("aggregate_trajectory_count")
    metadata_total_tasks = summary.get("metadata_total_tasks")
    score = float(raw) if isinstance(raw, (int, float)) else None
    if score is None:
        raise ValueError("loca-bench audit missing summary.avg_accuracy")
    if summary.get("issue_count"):
        raise ValueError(f"loca-bench audit has {summary.get('issue_count')} issue(s)")
    has_trajectories = (
        (isinstance(trajectory_count, int) and trajectory_count > 0)
        or (
            isinstance(aggregate_trajectory_count, int)
            and aggregate_trajectory_count > 0
        )
    )
    if not has_trajectories:
        raise ValueError("loca-bench run has no captured trajectories")
    if summary.get("total_api_tokens") in (None, 0) and (
        isinstance(metadata_total_tasks, int) and metadata_total_tasks > 0
    ):
        raise ValueError("loca-bench run has tasks but no API token usage")
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "avg_accuracy": raw,
            "aggregate_trajectory_count": aggregate_trajectory_count,
            "issue_count": summary.get("issue_count"),
            "metadata_total_tasks": metadata_total_tasks,
            "total_api_tokens": summary.get("total_api_tokens"),
            "max_prompt_tokens": summary.get("max_prompt_tokens"),
            "max_total_tokens": summary.get("max_total_tokens"),
            "trajectory_count": trajectory_count,
        },
    )


def _env_loca_bench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    del adapter
    env: dict[str, str] = {}
    max_context_size = ctx.request.extra_config.get("max_context_size")
    if isinstance(max_context_size, int) and max_context_size > 0:
        env["MAX_CONVERSATION_TOKENS"] = str(max_context_size)
    timeout = ctx.request.extra_config.get("timeout")
    if isinstance(timeout, int) and timeout > 10:
        env["LOCA_HARNESS_TIMEOUT_S"] = str(max(5, min(timeout - 5, 240)))
    harness = str(
        ctx.request.extra_config.get("agent")
        or ctx.request.extra_config.get("harness")
        or ctx.request.agent
    ).strip().lower()
    if harness == "openclaw":
        openclaw_thinking = ctx.request.extra_config.get("openclaw_thinking")
        if isinstance(openclaw_thinking, str) and openclaw_thinking.strip():
            env["LOCA_OPENCLAW_THINKING"] = openclaw_thinking.strip()
        else:
            reasoning_effort = ctx.request.extra_config.get("reasoning_effort")
            if isinstance(reasoning_effort, str) and reasoning_effort.strip():
                env["LOCA_OPENCLAW_THINKING"] = reasoning_effort.strip()
        # LOCA relies on native OpenAI chat/tool payloads. OpenClaw's CLI
        # transport flattens those into text, so use the adapter's direct
        # OpenAI-compatible path for this benchmark-specific bridge.
        env["OPENCLAW_DIRECT_OPENAI_COMPAT"] = "1"
        env["OPENCLAW_USE_CLI"] = "0"
    return env


def _command_interrupt_bench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    args = [
        "bun",
        "run",
        "src/runner.ts",
        "--mode=cerebras",
        f"--model={ctx.request.model}",
        f"--out={ctx.output_root}",
    ]
    scenario = ctx.request.extra_config.get("scenario")
    if isinstance(scenario, str) and scenario.strip():
        args.append(f"--scenario={scenario.strip()}")
    elif int(ctx.request.extra_config.get("max_tasks", 0) or 0) == 1:
        args.append("--scenario=A1-fragmented-email-draft")
    if ctx.request.extra_config.get("judge") is True:
        args.append("--judge")
    return args


def _score_from_interrupt_bench(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    final_score = data.get("finalScore")
    aggregate = data.get("aggregate")
    raw_score = final_score if isinstance(final_score, (int, float)) else aggregate
    score = float(raw_score) / 100.0 if isinstance(raw_score, (int, float)) else None
    scenarios = data.get("scenarios")
    scenario_count = len(scenarios) if isinstance(scenarios, list) else 0
    boundary_violations = 0
    if isinstance(scenarios, list):
        boundary_violations = sum(
            1
            for item in scenarios
            if isinstance(item, dict) and item.get("boundaryViolated") is True
        )
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "finalScore": final_score,
            "aggregate": aggregate,
            "judgeBonus": data.get("judgeBonus"),
            "passTier": data.get("passTier"),
            "scenario_count": scenario_count,
            "boundary_violations": boundary_violations,
            "mode": data.get("mode"),
            "model": data.get("model"),
        },
    )


def _command_personality_bench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
    return [
        "bun",
        "run",
        "src/runner.ts",
        "--calibration",
        "--calibration-dir",
        "tests/calibration",
        "--agent",
        ctx.request.agent.strip().lower() or "eliza",
        "--output",
        str(ctx.output_root / "report.md"),
        "--output-json",
        str(ctx.output_root / "report.json"),
    ]


def _env_personality_bench(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> dict[str, str]:
    enable_llm = ctx.request.extra_config.get("enable_llm_judge") is True
    return {
        "PERSONALITY_JUDGE_MODEL": ctx.request.model,
        "PERSONALITY_JUDGE_ENABLE_LLM": "1" if enable_llm else "0",
        "PERSONALITY_JUDGE_STRICT": "0",
    }


def _score_from_personality_bench(path: Path) -> ScoreSummary:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})
    calibration = data.get("calibration")
    totals = data.get("totals") if isinstance(data.get("totals"), dict) else {}
    if isinstance(calibration, dict):
        raw_score = calibration.get("score", calibration.get("agreementRate"))
        score = float(raw_score) if isinstance(raw_score, (int, float)) else None
        metrics = {
            "total": calibration.get("total"),
            "agreed": calibration.get("agreed"),
            "disagreed": calibration.get("disagreed"),
            "needsReview": calibration.get("needsReview"),
            "falsePositive": calibration.get("falsePositive"),
            "falseNegative": calibration.get("falseNegative"),
            "agreementRate": calibration.get("agreementRate"),
            "falsePositiveRate": calibration.get("falsePositiveRate"),
            "reviewRate": calibration.get("reviewRate"),
            "mismatch_count": len(calibration.get("mismatches", []))
            if isinstance(calibration.get("mismatches"), list)
            else 0,
        }
        return ScoreSummary(
            score=score,
            unit="ratio",
            higher_is_better=True,
            metrics=metrics,
        )

    scenario_count = totals.get("scenarios", 0) if isinstance(totals, dict) else 0
    passed = totals.get("pass", 0) if isinstance(totals, dict) else 0
    score = (float(passed) / float(scenario_count)) if scenario_count else None
    return ScoreSummary(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics=dict(totals) if isinstance(totals, dict) else {},
    )


def discover_adapters(workspace_root: Path) -> AdapterDiscovery:
    benchmarks_root = workspace_root / "benchmarks"
    benchmark_dirs = sorted(
        p.name
        for p in benchmarks_root.iterdir()
        if _is_benchmark_directory(p)
    )

    score_extractor_factory = RegistryScoreExtractor(workspace_root)
    adapters: dict[str, BenchmarkAdapter] = {}

    registry_entries = get_benchmark_registry(workspace_root)
    registry_default_extra: dict[str, dict[str, Any]] = {
        "agentbench": {
            "elizaos": True,
            "env": ["os"],
            "max_tasks": 1,
            "no_docker": True,
        },
        "context_bench": {
            "quick": True,
            "context_lengths": [1024],
            "positions": ["middle"],
            "tasks_per_position": 1,
        },
        "rlm_bench": {
            "mode": "eliza",
            "tasks_per_config": 1,
            "context_lengths": [1000, 10000],
            "max_iterations": 5,
            "max_depth": 3,
        },
        "mint": {
            "agent": "eliza",
        },
        "terminal_bench": {
            "max_tasks": 1,
            "sample": True,
            "timeout": 180,
            "no_docker": True,
            "no_markdown": True,
            "no_sessions": True,
            "no_leaderboard": True,
        },
        "visualwebbench": {
            "max_tasks": 1,
            "task_types": "web_caption",
        },
        "social_alpha": {
            "system": "eliza",
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
        "hermes_tblite": {
            "max_tasks": 5,
        },
        "hermes_terminalbench_2": {
            "max_tasks": 5,
        },
        "hermes_yc_bench": {
            "max_tasks": 3,
        },
        "hermes_swe_env": {
            "max_tasks": 1,
        },
        "scambench": {
            "max_examples": 2,
            "max_new_tokens": 128,
        },
        "mmau": {
            "limit": 2,
            "no_traces": True,
        },
        "voicebench_quality": {
            "suite": "openbookqa",
            "limit": 2,
            "fixtures": True,
        },
        "voiceagentbench": {
            "suite": "single",
            "limit": 2,
            "seeds": 1,
            "mock": True,
            "no_judge": True,
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
        "hyperliquid_bench": "HyperliquidBench",
        "openclaw_bench": "openclaw-benchmark",
        "lifeops_bench": "lifeops-bench",
        "voicebench_quality": "voicebench-quality",
        "mmlu": "standard",
        "humaneval": "standard",
        "gsm8k": "standard",
        "mt_bench": "standard",
    }
    hermes_env_benchmark_ids = {
        "hermes_tblite",
        "hermes_terminalbench_2",
        "hermes_yc_bench",
        "hermes_swe_env",
    }
    hermes_adapter_dir_exists = (benchmarks_root / "hermes-adapter").is_dir()
    for entry in registry_entries:
        directory = registry_dir_map.get(entry.id, entry.id)
        if entry.id in hermes_env_benchmark_ids:
            # Hermes-native envs live under benchmarks/hermes-adapter (which is
            # in IGNORED_BENCHMARK_DIRS because it's an adapter, not a benchmark
            # tree). Bypass the dir-existence check and force-map to that path
            # when the adapter checkout is present.
            if not hermes_adapter_dir_exists:
                continue
            directory = "hermes-adapter"
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
            continue
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
            requirements_env=() if entry.id == "mind2web" else entry.requirements.env_vars,
            default_extra_config=registry_default_extra.get(entry.id, {}),
        )

    extras: list[BenchmarkAdapter] = [
        _make_extra_adapter(
            adapter_id="hyperliquidbench",
            directory="HyperliquidBench",
            description="HyperliquidBench Eliza coverage benchmark",
            cwd=str(workspace_root.resolve()),
            command_builder=_command_hyperliquid,
            result_patterns=["hyperliquid_bench-*.json", "runs/hyperliquid_bench-*.json"],
            env_builder=_command_hyperliquid_env,
            score_extractor=score_extractor_factory.for_benchmark("hyperliquid_bench"),
        ),
        _make_extra_adapter(
            adapter_id="adhdbench",
            directory="adhdbench",
            description="ADHDBench attention/context scaling benchmark",
            cwd=str((benchmarks_root / "adhdbench").resolve()),
            command_builder=_command_adhdbench,
            # Only match the summary file. The traces JSON is bigger
            # and tends to be the last-written, so a generic `*.json`
            # fallback was picking traces and the scorer returned None.
            result_patterns=["adhdbench_summary_*.json"],
            score_extractor=_score_from_adhd,
        ),
        _make_extra_adapter(
            adapter_id="configbench",
            directory="configbench",
            description="ConfigBench plugin configuration/security benchmark",
            cwd=str((benchmarks_root / "configbench").resolve()),
            command_builder=_command_configbench,
            env_builder=_env_configbench,
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
            env_builder=lambda ctx, adapter: {
                "PYTHONPATH": os.pathsep.join(
                    [
                        str((ctx.benchmarks_root / "eliza-adapter").resolve()),
                        ctx.env.get("PYTHONPATH", ""),
                    ],
                ).rstrip(os.pathsep),
            },
            result_patterns=["experience-results.json", "*.json"],
            score_extractor=_score_from_experience,
        ),
        _make_extra_adapter(
            adapter_id="app-eval",
            directory="app-eval",
            description="elizaOS app agent research/coding benchmark",
            cwd=str((benchmarks_root / "app-eval").resolve()),
            command_builder=_command_app_eval,
            env_builder=_env_app_eval,
            result_patterns=["results/latest/summary.json", "results/*/summary.json", "summary.json", "evaluation.json"],
            score_extractor=_score_from_app_eval,
            default_timeout_seconds=14400,
            default_extra_config={"task": "research-001"},
        ),
        _make_extra_adapter(
            adapter_id="framework",
            directory="framework",
            description="Eliza TypeScript framework benchmark suite",
            cwd=str(workspace_root.resolve()),
            command_builder=_command_framework,
            result_patterns=["framework-results.json", "typescript-*.json", "results/*.json"],
            score_extractor=_score_from_framework,
        ),
        _make_extra_adapter(
            adapter_id="compactbench",
            directory="compactbench",
            description="CompactBench conversation-compaction benchmark",
            cwd=str((benchmarks_root / "compactbench").resolve()),
            command_builder=_command_compactbench,
            result_patterns=["compactbench-results.jsonl", "*.jsonl"],
            score_extractor=_score_from_compactbench,
            default_extra_config={
                "case_count": 1,
                "drift_cycles": 1,
            },
            default_timeout_seconds=7200,
        ),
        _make_extra_adapter(
            adapter_id="loca_bench",
            directory="loca-bench",
            description="LOCA long-context agent benchmark via elizaOS/Cerebras wrapper",
            cwd=str((benchmarks_root / "loca-bench").resolve()),
            command_builder=_command_loca_bench,
            result_patterns=["loca-output/eliza_loca_audit.json", "**/eliza_loca_audit.json"],
            score_extractor=_score_from_loca_bench,
            env_builder=_env_loca_bench,
            default_extra_config={
                "max_steps": 1,
                "max_tool_uses": 5,
                "max_retries": 1,
                "timeout": 120,
                "context_summary": True,
                "max_context_size": 131072,
                "reset_size": 65536,
            },
            default_timeout_seconds=7200,
        ),
        _make_extra_adapter(
            adapter_id="interrupt_bench",
            directory="interrupt-bench",
            description="InterruptBench response-handler interruption benchmark",
            cwd=str((benchmarks_root / "interrupt-bench").resolve()),
            command_builder=_command_interrupt_bench,
            result_patterns=["report.json"],
            score_extractor=_score_from_interrupt_bench,
            default_timeout_seconds=7200,
        ),
        _make_extra_adapter(
            adapter_id="personality_bench",
            directory="personality-bench",
            description="Personality-bench judge calibration suite",
            cwd=str((benchmarks_root / "personality-bench").resolve()),
            command_builder=_command_personality_bench,
            env_builder=_env_personality_bench,
            result_patterns=["report.json"],
            score_extractor=_score_from_personality_bench,
            default_timeout_seconds=600,
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
            env_builder=lambda ctx, adapter: {
                "PYTHONPATH": os.pathsep.join(
                    [str((ctx.benchmarks_root / "eliza-adapter").resolve()), ctx.env.get("PYTHONPATH", "")]
                ).rstrip(os.pathsep)
            },
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
            env_builder=lambda ctx, adapter: {
                "PYTHONPATH": os.pathsep.join(
                    [str((ctx.benchmarks_root / "eliza-adapter").resolve()), ctx.env.get("PYTHONPATH", "")]
                ).rstrip(os.pathsep)
            },
            result_patterns=["trust-results.json", "*.json"],
            score_extractor=_score_from_trust,
            default_extra_config={
                "handler": "oracle",
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
            env_builder=_env_webshop,
            result_patterns=["webshop-results.json"],
            score_extractor=score_extractor_factory.for_benchmark("webshop"),
            default_extra_config={
                "max_tasks": 1,
                "sample": True,
            },
        ),
        _make_extra_adapter(
            adapter_id="woobench",
            directory="woobench",
            description="WooBench mystical reading benchmark",
            cwd=str(workspace_root.resolve()),
            command_builder=_command_woobench,
            env_builder=_env_woobench,
            result_patterns=["woobench_*.json"],
            score_extractor=_score_from_woobench,
            default_extra_config={
                "scenarios": [
                    "friend_supporter_tarot_01",
                    "repeat_customer_tarot_01",
                ],
                "concurrency": 1,
                "evaluator": "heuristic",
                "random_seed": 1,
            },
        ),
        _make_extra_adapter(
            adapter_id="evm",
            directory="evm",
            description="EVM exploration benchmark",
            cwd=str((benchmarks_root / "evm").resolve()),
            command_builder=_command_evm,
            env_builder=_env_evm,
            result_patterns=["metrics/evm_*_metrics.json"],
            score_extractor=_score_from_evm,
        ),
        _make_extra_adapter(
            adapter_id="solana",
            directory="solana",
            description="Solana instruction discovery benchmark via Eliza agent",
            cwd=str(workspace_root.resolve()),
            command_builder=_command_solana,
            env_builder=_env_solana,
            result_patterns=[
                "eliza_*_metrics.json",
                "benchmarks/solana/solana-gym-env/metrics/eliza_*_metrics.json",
                "packages/benchmarks/solana/solana-gym-env/metrics/eliza_*_metrics.json",
            ],
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
            adapter_id="eliza_replay",
            directory="eliza-adapter",
            description="Replay benchmark over normalized Eliza PARALLAX captures",
            cwd=str((benchmarks_root / "eliza-adapter").resolve()),
            command_builder=_command_eliza_replay,
            result_patterns=["eliza-replay-results.json", "*.json"],
            score_extractor=_score_from_eliza_replay,
            default_timeout_seconds=300,
            default_extra_config={
                "capture_path": str((benchmarks_root / "eliza-adapter" / "fixtures" / "replay").resolve()),
                "capture_glob": "*.replay.json",
            },
            capability_notes="Offline replay scoring; capture_path should point to normalized replay artifacts.",
        ),
    ]

    for adapter in extras:
        adapter_dir_exists = (benchmarks_root / adapter.directory).is_dir()
        if adapter.directory in benchmark_dirs or (adapter.id == "eliza_replay" and adapter_dir_exists):
            adapters[adapter.id] = adapter

    return AdapterDiscovery(adapters=adapters, all_directories=tuple(benchmark_dirs))
