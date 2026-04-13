#!/usr/bin/env python3
"""CLI for running SWE-bench benchmark."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

# Add workspace root, local elizaos python package, and plugin packages to sys.path.
_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT))
_PYTHON_PKG = _ROOT / "packages" / "python"
if _PYTHON_PKG.exists():
    sys.path.insert(0, str(_PYTHON_PKG))
# Agent orchestrator plugin
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
if _ORCH_PKG.exists():
    sys.path.insert(0, str(_ORCH_PKG))

# SWE-agent package
_SWEAGENT_PKG = _ROOT / "eliza" / "packages" / "sweagent" / "python"
if _SWEAGENT_PKG.exists():
    sys.path.insert(0, str(_SWEAGENT_PKG))

from .character import create_swe_bench_character
from .dataset import SWEBenchDataset
from .runner import SWEBenchRunner
from .types import SWEBenchConfig, SWEBenchVariant

# Orchestrated benchmark imports (lazy to avoid import errors if orchestrator deps missing)
_ORCHESTRATOR_AVAILABLE = False
try:
    from .orchestrator.types import (
        ExecutionMode,
        OrchestratedBenchmarkConfig,
        ProviderType,
    )
    from .orchestrator.runner import OrchestratedSWEBenchRunner
    _ORCHESTRATOR_AVAILABLE = True
except ImportError:
    pass


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def _is_anthropic_model(model_name: str) -> bool:
    lowered = model_name.lower()
    if "/" in lowered:
        lowered = lowered.split("/", 1)[1]
    return "claude" in lowered or lowered.startswith("anthropic/")


def _is_openai_model(model_name: str) -> bool:
    lowered = model_name.lower()
    if "/" in lowered:
        lowered = lowered.split("/", 1)[1]
    return lowered.startswith(("gpt-", "o1", "o3", "o4"))


def _strip_model_prefix(model_name: str) -> str:
    lowered = model_name.lower().strip()
    for prefix in ("openai/", "anthropic/", "groq/", "openrouter/"):
        if lowered.startswith(prefix):
            return model_name[len(prefix) :]
    return model_name


def _model_provider_from_name(model_name: str) -> str | None:
    lowered = model_name.lower().strip()
    for prefix in ("openai/", "anthropic/", "groq/", "openrouter/"):
        if lowered.startswith(prefix):
            return prefix.rstrip("/")
    return None


def _provider_key_var(provider: str) -> str:
    return {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "groq": "GROQ_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
    }.get(provider, "OPENAI_API_KEY")


def _pick_backend(explicit_provider: str | None, requested_model: str, mock_model: bool) -> str:
    if mock_model:
        return "mock"

    if explicit_provider:
        return explicit_provider.strip().lower()

    from_model = _model_provider_from_name(requested_model)
    if from_model is not None:
        return from_model

    normalized = _strip_model_prefix(requested_model).lower()
    if "claude" in normalized and os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if normalized.startswith("qwen") and os.environ.get("GROQ_API_KEY"):
        return "groq"
    if normalized.startswith(("gpt-", "o1", "o3", "o4")) and os.environ.get("OPENAI_API_KEY"):
        return "openai"

    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("GROQ_API_KEY"):
        return "groq"
    if os.environ.get("OPENROUTER_API_KEY"):
        return "openrouter"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return "openai"


def _pick_runtime_model(
    backend: str,
    requested_model: str,
    fallback_model: str,
) -> str:
    requested = requested_model.strip()
    fallback = fallback_model.strip()

    if backend == "anthropic":
        if requested and _is_anthropic_model(requested):
            return requested
        if fallback and _is_anthropic_model(fallback):
            return fallback
        return "claude-sonnet-4-20250514"

    if backend == "openai":
        requested = _strip_model_prefix(requested)
        fallback = _strip_model_prefix(fallback)
        if requested and _is_openai_model(requested):
            return requested
        if fallback and _is_openai_model(fallback):
            return fallback
        return "gpt-4o"

    if backend in {"groq", "openrouter"}:
        if requested:
            return _strip_model_prefix(requested)
        if fallback:
            return _strip_model_prefix(fallback)
        return "qwen3-32b"

    return requested if requested else fallback


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run SWE-bench benchmark on ElizaOS Python",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run on SWE-bench Lite (default, 300 instances)
  python -m benchmarks.swe_bench.cli

  # Run on first 10 instances
  python -m benchmarks.swe_bench.cli --max-instances 10

  # Run on specific repository
  python -m benchmarks.swe_bench.cli --repo-filter django

  # Run single instance
  python -m benchmarks.swe_bench.cli --instance django__django-12345

  # Run on SWE-bench Verified
  python -m benchmarks.swe_bench.cli --variant verified

  # List available instances
  python -m benchmarks.swe_bench.cli --list

  # Skip Docker evaluation
  python -m benchmarks.swe_bench.cli --no-docker
""",
    )

    parser.add_argument(
        "--variant",
        choices=["lite", "verified", "full"],
        default="lite",
        help="SWE-bench variant to use (default: lite)",
    )

    parser.add_argument(
        "--max-instances",
        type=int,
        default=None,
        help="Maximum number of instances to evaluate",
    )

    parser.add_argument(
        "--repo-filter",
        type=str,
        default=None,
        help="Filter instances by repository name",
    )

    parser.add_argument(
        "--instance",
        type=str,
        default=None,
        help="Run on a single instance by ID",
    )

    parser.add_argument(
        "--max-steps",
        type=int,
        default=30,
        help="Maximum agent steps per instance (default: 30)",
    )

    parser.add_argument(
        "--workspace",
        type=str,
        default="./swe-bench-workspace",
        help="Workspace directory for cloned repos",
    )

    parser.add_argument(
        "--output",
        type=str,
        default="./benchmark_results/swe-bench",
        help="Output directory for results",
    )

    parser.add_argument(
        "--no-docker",
        action="store_true",
        help="Skip Docker-based test evaluation",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=600,
        help="Timeout per instance in seconds (default: 600)",
    )

    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4",
        help="Model to use for the agent",
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=["openai", "anthropic", "groq", "openrouter"],
        default=None,
        help="Model provider override (default: infer from model/env keys)",
    )

    parser.add_argument(
        "--gold",
        action="store_true",
        help="Evaluate using the gold (ground-truth) patches instead of running the agent (useful to validate the harness).",
    )

    parser.add_argument(
        "--mock-model",
        action="store_true",
        help="Use a deterministic mock model (no API calls). Useful for smoke tests.",
    )

    parser.add_argument(
        "--swebench-namespace",
        type=str,
        default=None,
        help="Optional Docker registry namespace for SWE-bench instance images (e.g., 'ghcr.io/epoch-research')",
    )

    parser.add_argument(
        "--swebench-max-workers",
        type=int,
        default=1,
        help="Max parallel SWE-bench harness workers (default: 1)",
    )

    parser.add_argument(
        "--list",
        action="store_true",
        help="List available instances and exit",
    )

    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show dataset statistics and exit",
    )

    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    # ---- Orchestrated benchmark flags ----
    parser.add_argument(
        "--orchestrated",
        action="store_true",
        help="Run orchestrated benchmark (agent delegates to sub-agent providers)",
    )

    parser.add_argument(
        "--providers",
        type=str,
        nargs="+",
        choices=["claude-code", "swe-agent", "codex", "eliza-code"],
        default=None,
        help="Provider(s) to benchmark in orchestrated mode (default: claude-code, swe-agent, codex)",
    )

    parser.add_argument(
        "--execution-mode",
        type=str,
        choices=["orchestrated", "direct_shell"],
        default="orchestrated",
        help="Control-plane mode for provider execution (default: orchestrated)",
    )

    parser.add_argument(
        "--matrix",
        action="store_true",
        help="Run full matrix across direct_shell and orchestrated for all selected providers",
    )

    parser.add_argument(
        "--no-baseline",
        action="store_true",
        help="Skip direct baseline comparison in orchestrated mode",
    )

    parser.add_argument(
        "--orchestrator-model",
        type=str,
        default="claude-sonnet-4-20250514",
        help="Model for the orchestrating agent (default: claude-sonnet-4-20250514)",
    )

    parser.add_argument(
        "--verify-provider",
        type=str,
        choices=["claude-code", "swe-agent", "codex", "eliza-code"],
        default=None,
        help="Run a single verification instance with specified provider",
    )

    parser.add_argument(
        "--allow-task-fallback",
        action="store_true",
        help=(
            "Allow fallback to raw issue text if orchestrator model fails. "
            "Disabled by default to avoid silent non-orchestrated behavior."
        ),
    )

    parser.add_argument(
        "--trace-dir",
        type=str,
        default=None,
        help="Optional directory to write full per-run trace files",
    )

    parser.add_argument(
        "--required-capabilities",
        type=str,
        default="",
        help="Comma-separated capability IDs required for each provider execution",
    )

    parser.add_argument(
        "--strict-capabilities",
        action="store_true",
        help="Fail fast when required capabilities are missing",
    )

    return parser.parse_args()


async def list_instances(args: argparse.Namespace) -> None:
    """List available instances."""
    variant = SWEBenchVariant(args.variant)
    dataset = SWEBenchDataset(variant)

    print(f"Loading SWE-bench {variant.value}...")
    await dataset.load()

    instances = dataset.get_instances(
        repo_filter=args.repo_filter,
        limit=args.max_instances,
    )

    print(f"\nFound {len(instances)} instances:\n")

    for instance in instances:
        print(f"  {instance.instance_id}")
        print(f"    Repo: {instance.repo}")
        print(f"    Created: {instance.created_at}")
        print(f"    Tests to pass: {len(instance.fail_to_pass)}")
        print()


async def show_stats(args: argparse.Namespace) -> None:
    """Show dataset statistics."""
    variant = SWEBenchVariant(args.variant)
    dataset = SWEBenchDataset(variant)

    print(f"Loading SWE-bench {variant.value}...")
    await dataset.load()

    stats = dataset.get_statistics()
    by_repo = dataset.get_by_repo()

    print(f"\n=== SWE-bench {variant.value.upper()} Statistics ===\n")
    print(f"Total instances: {stats.total_instances}")
    print(f"Number of repositories: {stats.num_repos}")
    print(f"Average per repository: {stats.avg_per_repo:.1f}")

    print("\nBy Repository:")
    for repo, instances in sorted(by_repo.items(), key=lambda x: -len(x[1])):
        print(f"  {repo}: {len(instances)} instances")


async def run_benchmark(args: argparse.Namespace) -> None:
    """Run the benchmark."""
    # Import here to avoid import errors if elizaos not installed
    try:
        from elizaos.runtime import AgentRuntime
    except ImportError:
        print("Error: elizaos package not found. Please install it first.")
        print("  pip install elizaos")
        sys.exit(1)

    # Create configuration
    variant = SWEBenchVariant(args.variant)

    backend: str | None = None
    runtime_model_name = args.model
    if not args.gold:
        backend = _pick_backend(args.provider, args.model, args.mock_model)
        if backend != "mock":
            key_var = _provider_key_var(backend)
            if not os.environ.get(key_var):
                print(f"Error: Set {key_var} for provider '{backend}'.")
                sys.exit(1)

        runtime_model_name = _pick_runtime_model(
            backend=backend,
            requested_model=args.model,
            fallback_model=args.model,
        )
        if backend != "mock" and _strip_model_prefix(runtime_model_name) != _strip_model_prefix(args.model):
            logging.getLogger(__name__).warning(
                "Requested --model '%s' is incompatible with %s backend; using '%s'.",
                args.model,
                backend,
                runtime_model_name,
            )

        if backend and backend != "mock":
            os.environ["BENCHMARK_MODEL_PROVIDER"] = backend
            os.environ["BENCHMARK_MODEL_NAME"] = runtime_model_name

    config = SWEBenchConfig(
        variant=variant,
        workspace_dir=args.workspace,
        output_dir=args.output,
        max_steps=args.max_steps,
        max_instances=args.max_instances,
        repo_filter=args.repo_filter,
        use_docker_eval=not args.no_docker,
        timeout_seconds=args.timeout,
        model_name=runtime_model_name,
        use_gold_patches=bool(args.gold),
        swebench_namespace=args.swebench_namespace,
        swebench_max_workers=args.swebench_max_workers,
    )

    # Create SWE-bench character with proper templates and settings
    character = create_swe_bench_character(
        name="SWE-Agent",
        model_name=runtime_model_name,
    )

    # Create runtime with character - basicCapabilities enabled by default
    runtime = AgentRuntime(
        character=character,
        log_level="DEBUG" if args.verbose else "INFO",
        # Don't disable basic capabilities - we want providers, actions, etc.
        disable_basic_capabilities=False,
        # Disable the should-respond check - always respond in benchmark mode
        check_should_respond=False,
        # Bypass validation-code checks for mock model (it can't generate them)
        settings={"VALIDATION_LEVEL": "trusted"} if backend == "mock" else None,
    )

    # Initialize runtime - this registers bootstrap plugin with basic capabilities
    await runtime.initialize()

    # Register a model handler (Python runtime does not ship with one by default).
    # When running in --gold mode we don't need any model handler.
    if args.gold:
        pass
    else:
        from elizaos.types.model import ModelType

        if backend == "mock":
            # Counter to track mock calls for varied responses
            _mock_call_count = [0]

            async def _mock_text_large(_runtime: object, params: dict[str, object]) -> str:
                """Mock model that returns XML-formatted responses for testing."""
                _ = _runtime
                _ = params
                _mock_call_count[0] += 1
                call_num = _mock_call_count[0]

                # Return a sequence of actions for testing the flow
                if call_num == 1:
                    return """<response>
<thought>Let me start by listing the files to understand the repository structure.</thought>
<text>Listing repository files...</text>
<actions>LIST_FILES</actions>
<params>
<LIST_FILES>
<directory>.</directory>
<pattern>*.py</pattern>
</LIST_FILES>
</params>
</response>"""
                elif call_num == 2:
                    return """<response>
<thought>I found the relevant file. Let me make a small edit to fix the issue.</thought>
<text>Editing file to apply fix...</text>
<actions>EDIT_FILE</actions>
<params>
<EDIT_FILE>
<file_path>README.rst</file_path>
<old_content>Astropy</old_content>
<new_content>Astropy  # mock-patched</new_content>
</EDIT_FILE>
</params>
</response>"""
                elif call_num == 3:
                    return """<response>
<thought>Edit applied. Now submitting the solution.</thought>
<text>Submitting fix...</text>
<actions>SUBMIT</actions>
<params>
</params>
</response>"""
                else:
                    # Default: just submit
                    return """<response>
<thought>Mock mode - submitting.</thought>
<text>Done.</text>
<actions>SUBMIT</actions>
<params>
</params>
</response>"""

            runtime.register_model(
                ModelType.TEXT_LARGE, _mock_text_large, provider="mock", priority=100
            )
        elif backend == "anthropic":
            from anthropic import AsyncAnthropic

            anthropic_client = AsyncAnthropic()
            model_name = runtime_model_name

            async def _anthropic_text_large(_runtime: object, params: dict[str, object]) -> str:
                """Anthropic model handler for SWE-bench."""
                _ = _runtime
                prompt_raw = params.get("prompt", "")
                prompt = str(prompt_raw) if prompt_raw is not None else ""

                system_raw = params.get("system", "")
                system = str(system_raw) if system_raw else None

                temperature_raw = params.get("temperature", 0.1)
                temperature = (
                    float(temperature_raw) if isinstance(temperature_raw, int | float) else 0.1
                )
                max_tokens_raw = params.get("maxTokens", 4096)
                max_tokens = (
                    int(max_tokens_raw) if isinstance(max_tokens_raw, int | float) else 4096
                )

                messages = [{"role": "user", "content": prompt}]
                resp = await anthropic_client.messages.create(
                    model=model_name,
                    max_tokens=max_tokens,
                    system=system or "",
                    messages=messages,
                    temperature=temperature,
                )
                texts = [blk.text for blk in resp.content if getattr(blk, "type", None) == "text"]
                return "".join(texts).strip()

            runtime.register_model(
                ModelType.TEXT_LARGE, _anthropic_text_large, provider="anthropic", priority=100
            )
        elif backend in {"openai", "groq", "openrouter"}:
            from openai import AsyncOpenAI

            if backend == "openai":
                client = AsyncOpenAI()
            else:
                base_url = {
                    "groq": "https://api.groq.com/openai/v1",
                    "openrouter": "https://openrouter.ai/api/v1",
                }[backend]
                api_key = os.environ.get(_provider_key_var(backend), "")
                client = AsyncOpenAI(base_url=base_url, api_key=api_key)
            model_name = runtime_model_name

            async def _openai_text_large(_runtime: object, params: dict[str, object]) -> str:
                """OpenAI-compatible model handler for SWE-bench."""
                _ = _runtime
                prompt_raw = params.get("prompt", "")
                prompt = str(prompt_raw) if prompt_raw is not None else ""

                system_raw = params.get("system", "")
                system = str(system_raw) if system_raw else None

                temperature_raw = params.get("temperature", 0.1)
                temperature = (
                    float(temperature_raw) if isinstance(temperature_raw, int | float) else 0.1
                )

                max_tokens_raw = params.get("maxTokens")
                max_tokens: int | None = None
                if isinstance(max_tokens_raw, int):
                    max_tokens = max_tokens_raw
                elif isinstance(max_tokens_raw, float):
                    max_tokens = int(max_tokens_raw)

                messages: list[dict[str, str]] = []
                if system:
                    messages.append({"role": "system", "content": system})
                messages.append({"role": "user", "content": prompt})

                extra: dict[str, object] = {}
                if backend == "openai":
                    # gpt-5/o1/o3 reasoning models: max_completion_tokens, no temperature
                    if max_tokens is not None:
                        extra["max_completion_tokens"] = max_tokens
                    is_reasoning = any(model_name.startswith(p) for p in ("gpt-5", "o1", "o3"))
                    if not is_reasoning:
                        extra["temperature"] = temperature
                else:
                    if max_tokens is not None:
                        extra["max_tokens"] = max_tokens
                    extra["temperature"] = temperature

                resp = await client.chat.completions.create(
                    model=model_name,
                    messages=messages,  # type: ignore[arg-type]
                    **extra,
                )
                content = resp.choices[0].message.content
                return content or ""

            runtime.register_model(
                ModelType.TEXT_LARGE, _openai_text_large, provider=backend, priority=100
            )

    # Create and run benchmark
    runner = SWEBenchRunner(runtime, config)

    if args.instance:
        # Run single instance
        print(f"Running on single instance: {args.instance}")
        result = await runner.run_single(args.instance)

        print("\n=== Result ===")
        print(f"Instance: {result.instance_id}")
        print(f"Success: {result.success}")
        print(f"Patch Status: {result.patch_status.value}")
        print(f"Duration: {result.duration_seconds:.1f}s")
        print(f"Tests Passed: {len(result.tests_passed)}")
        print(f"Tests Failed: {len(result.tests_failed)}")

        if result.error:
            print(f"Error: {result.error}")

        if result.generated_patch:
            print("\n=== Generated Patch ===")
            print(result.generated_patch[:2000])
            if len(result.generated_patch) > 2000:
                print(f"... ({len(result.generated_patch)} bytes total)")
    else:
        # Run full benchmark
        report = await runner.run_benchmark()

        print("\n" + "=" * 60)
        print("SWE-BENCH BENCHMARK RESULTS")
        print("=" * 60)
        print(f"Variant: {report.variant}")
        print(f"Total Instances: {report.total_instances}")
        print(f"Resolved: {report.resolved}")
        print(f"Resolve Rate: {report.resolve_rate:.1%}")
        print(f"Apply Rate: {report.apply_rate:.1%}")
        print(f"Average Duration: {report.average_duration:.1f}s")
        print("=" * 60)

    # Cleanup (bounded so shutdown hangs do not stall CLI forever)
    try:
        await asyncio.wait_for(runtime.stop(), timeout=30.0)
    except asyncio.TimeoutError:
        logging.getLogger(__name__).warning(
            "Runtime stop timed out after 30s; continuing shutdown."
        )


async def run_orchestrated_benchmark(args: argparse.Namespace) -> None:
    """Run the orchestrated benchmark."""
    if not _ORCHESTRATOR_AVAILABLE:
        print("Error: orchestrator dependencies not available.")
        print("  pip install elizaos_plugin_agent_orchestrator")
        sys.exit(1)

    try:
        from elizaos.runtime import AgentRuntime
    except ImportError:
        print("Error: elizaos package not found. Please install it first.")
        sys.exit(1)

    variant = SWEBenchVariant(args.variant)

    backend = _pick_backend(args.provider, args.model, args.mock_model)
    if backend != "mock":
        key_var = _provider_key_var(backend)
        if not os.environ.get(key_var):
            print(f"Error: Set {key_var} for provider '{backend}' in orchestrated mode.")
            sys.exit(1)

    runtime_model_name = _pick_runtime_model(
        backend=backend,
        requested_model=args.model,
        fallback_model=args.orchestrator_model,
    )
    if backend != "mock" and _strip_model_prefix(runtime_model_name) != _strip_model_prefix(args.model):
        logging.getLogger(__name__).warning(
            "Requested --model '%s' is incompatible with %s backend; using '%s'.",
            args.model,
            backend,
            runtime_model_name,
        )

    if backend != "mock":
        os.environ["BENCHMARK_MODEL_PROVIDER"] = backend
        os.environ["BENCHMARK_MODEL_NAME"] = runtime_model_name

    # Determine providers
    if args.providers:
        providers = [ProviderType(p) for p in args.providers]
    else:
        providers = [
            ProviderType.CLAUDE_CODE,
            ProviderType.SWE_AGENT,
            ProviderType.CODEX,
        ]
    
    if args.verify_provider:
        verify_pk = ProviderType(args.verify_provider)
        if verify_pk not in providers:
            providers.append(verify_pk)

    required_capabilities = [
        cap.strip()
        for cap in str(args.required_capabilities).split(",")
        if cap.strip()
    ]

    provider_models: dict[str, str] = {
        "swe-agent": runtime_model_name,
        "codex": runtime_model_name,
        "eliza-code": runtime_model_name,
    }
    if _is_anthropic_model(runtime_model_name):
        provider_models["claude-code"] = runtime_model_name

    config = OrchestratedBenchmarkConfig(
        variant=variant,
        workspace_dir=args.workspace,
        output_dir=args.output,
        max_steps=args.max_steps,
        max_instances=args.max_instances,
        repo_filter=args.repo_filter,
        use_docker_eval=not args.no_docker,
        timeout_seconds=args.timeout,
        model_name=args.model,
        providers=providers,
        execution_mode=ExecutionMode(args.execution_mode),
        matrix=bool(args.matrix),
        run_direct_baseline=not args.no_baseline,
        orchestrator_model=args.orchestrator_model,
        provider_max_steps=args.max_steps,
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
        openai_api_key=os.environ.get("OPENAI_API_KEY") or os.environ.get(_provider_key_var(backend)),
        provider_models=provider_models,
        swebench_namespace=args.swebench_namespace,
        swebench_max_workers=args.swebench_max_workers,
        allow_task_description_fallback=bool(args.allow_task_fallback),
        trace_dir=args.trace_dir,
        required_capabilities=required_capabilities,
        strict_capabilities=bool(args.strict_capabilities),
    )

    # Create character and runtime
    character = create_swe_bench_character(
        name="Orchestrator-Agent",
        model_name=args.orchestrator_model,
    )

    runtime = AgentRuntime(
        character=character,
        log_level="DEBUG" if args.verbose else "INFO",
        disable_basic_capabilities=False,
        check_should_respond=False,
        settings={"VALIDATION_LEVEL": "trusted"} if backend == "mock" else None,
    )
    await runtime.initialize()

    # Register model handler
    from elizaos.types.model import ModelType

    if backend == "mock":
        _mock_counter = [0]

        async def _mock_text_large(_runtime: object, params: dict[str, object]) -> str:
            """Mock model for orchestrated benchmark smoke tests."""
            _ = _runtime
            _mock_counter[0] += 1
            prompt = str(params.get("prompt", ""))

            # If the orchestrator is analyzing the task, return a task description
            if "analyze this issue" in prompt.lower() and "create a structured task description" in prompt.lower():
                return (
                    "## Task Analysis\n\n"
                    "This issue requires investigating the codebase.\n"
                    "1. Search for relevant code\n"
                    "2. Read the affected files\n"
                    "3. Make the necessary fix\n"
                    "4. Submit the solution\n"
                )
            # Sub-agent mock: LIST_FILES → EDIT_FILE → SUBMIT
            call = _mock_counter[0]
            
            # Check for SWE-agent (ThoughtActionParser expects Markdown/Code blocks)
            # We can detect this via args (captured from outer scope)
            if getattr(args, "verify_provider", None) == "swe-agent" or (hasattr(args, "providers") and "swe-agent" in args.providers):
                if call % 4 == 1:
                    return (
                        "DISCUSSION\n"
                        "I will list the files to understand the repo.\n\n"
                        "```bash\n"
                        "ls -R\n"
                        "```"
                    )
                if call % 4 == 2:
                    return (
                        "DISCUSSION\n"
                        "I found the file. I will edit it.\n\n"
                        "```bash\n"
                        "echo 'fixed' > README.rst\n"
                        "```"
                    )
                return (
                    "DISCUSSION\n"
                    "I have fixed the issue. Submitting.\n\n"
                    "```bash\n"
                    "submit\n"
                    "```"
                )

            if call % 4 == 1:
                return (
                    "<response><thought>Exploring codebase</thought>"
                    "<text>Listing files...</text>"
                    "<actions>LIST_FILES</actions>"
                    "<params></params></response>"
                )
            if call % 4 == 2:
                return (
                    "<response><thought>Editing file to fix the issue</thought>"
                    "<text>Applying fix...</text>"
                    "<actions>EDIT_FILE</actions>"
                    "<params><EDIT_FILE>"
                    "<file_path>README.rst</file_path>"
                    "<old_content>Astropy</old_content>"
                    "<new_content>Astropy  # mock-patched</new_content>"
                    "</EDIT_FILE></params></response>"
                )
            return (
                "<response><thought>Submitting</thought>"
                "<text>Done.</text>"
                "<actions>SUBMIT</actions>"
                "<params></params></response>"
            )

        runtime.register_model(
            ModelType.TEXT_LARGE, _mock_text_large, provider="mock", priority=100
        )
    elif backend == "anthropic":
        from anthropic import AsyncAnthropic

        anthropic_client = AsyncAnthropic()
        default_model_name = runtime_model_name

        async def _anthropic_text_large(_runtime: object, params: dict[str, object]) -> str:
            """Anthropic model handler for orchestrator."""
            _ = _runtime
            prompt = str(params.get("prompt", ""))
            system = str(params.get("system", "")) if params.get("system") else None
            temp_raw = params.get("temperature", 0.1)
            temperature = float(temp_raw) if isinstance(temp_raw, int | float) else 0.1
            max_tokens_raw = params.get("maxTokens", 4096)
            max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, int | float) else 4096
            requested_model_raw = params.get("model_name")
            requested_model = (
                requested_model_raw.strip()
                if isinstance(requested_model_raw, str) and requested_model_raw.strip()
                else default_model_name
            )
            selected_model = (
                requested_model
                if _is_anthropic_model(requested_model)
                else default_model_name
            )

            messages_list = [{"role": "user", "content": prompt}]

            resp = await anthropic_client.messages.create(
                model=selected_model,
                max_tokens=max_tokens,
                system=system or "",
                messages=messages_list,
                temperature=temperature,
            )
            text_blocks = [b for b in resp.content if getattr(b, "type", "") == "text"]
            return " ".join(getattr(b, "text", "") for b in text_blocks)

        runtime.register_model(
            ModelType.TEXT_LARGE, _anthropic_text_large, provider="anthropic", priority=100
        )
    elif backend in {"openai", "groq", "openrouter"}:
        from openai import AsyncOpenAI

        if backend == "openai":
            openai_client = AsyncOpenAI()
        else:
            base_url = {
                "groq": "https://api.groq.com/openai/v1",
                "openrouter": "https://openrouter.ai/api/v1",
            }[backend]
            api_key = os.environ.get(_provider_key_var(backend), "")
            openai_client = AsyncOpenAI(base_url=base_url, api_key=api_key)
        default_model_name = runtime_model_name

        async def _openai_text_large(_runtime: object, params: dict[str, object]) -> str:
            _ = _runtime
            prompt = str(params.get("prompt", ""))
            system = str(params.get("system", "")) if params.get("system") else None
            temp_raw = params.get("temperature", 0.1)
            temperature = float(temp_raw) if isinstance(temp_raw, int | float) else 0.1
            requested_model_raw = params.get("model_name")
            requested_model = (
                requested_model_raw.strip()
                if isinstance(requested_model_raw, str) and requested_model_raw.strip()
                else default_model_name
            )
            selected_model = (
                requested_model
                if backend != "openai" or _is_openai_model(requested_model)
                else default_model_name
            )
            max_tokens_raw = params.get("maxTokens")
            max_tokens: int | None = None
            if isinstance(max_tokens_raw, int):
                max_tokens = max_tokens_raw
            elif isinstance(max_tokens_raw, float):
                max_tokens = int(max_tokens_raw)

            messages_list: list[dict[str, str]] = []
            if system:
                messages_list.append({"role": "system", "content": system})
            messages_list.append({"role": "user", "content": prompt})

            extra: dict[str, object] = {}
            if backend == "openai":
                if max_tokens is not None:
                    extra["max_completion_tokens"] = max_tokens
                is_reasoning_model = any(selected_model.startswith(p) for p in ("gpt-5", "o1", "o3"))
                if not is_reasoning_model:
                    extra["temperature"] = temperature
            else:
                if max_tokens is not None:
                    extra["max_tokens"] = max_tokens
                extra["temperature"] = temperature

            resp = await openai_client.chat.completions.create(
                model=selected_model,
                messages=messages_list,
                **extra,
            )
            return resp.choices[0].message.content or ""

        runtime.register_model(
            ModelType.TEXT_LARGE, _openai_text_large, provider=backend, priority=100
        )

    runner = OrchestratedSWEBenchRunner(runtime, config)

    if args.instance and not args.verify_provider:
        instance_id = args.instance
        print(f"Single-instance orchestrated run: {instance_id}")

        if config.run_direct_baseline:
            direct_config = SWEBenchConfig(
                variant=variant,
                workspace_dir=args.workspace,
                output_dir=args.output,
                max_steps=args.max_steps,
                max_instances=1,
                repo_filter=args.repo_filter,
                use_docker_eval=not args.no_docker,
                timeout_seconds=args.timeout,
                model_name=args.model,
                swebench_namespace=args.swebench_namespace,
                swebench_max_workers=args.swebench_max_workers,
            )
            direct_runner = SWEBenchRunner(runtime, direct_config)
            direct_result = await direct_runner.run_single(instance_id)
            print(f"\n{'='*50}")
            print(f"Instance:    {direct_result.instance_id}")
            print("Provider:    direct-baseline")
            print(f"Success:     {direct_result.success}")
            print(f"Patch:       {direct_result.patch_status.value}")
            print(f"Duration:    {direct_result.duration_seconds:.1f}s")
            print(f"{'='*50}")
            if direct_result.generated_patch:
                print(f"\nPatch ({len(direct_result.generated_patch)} bytes):")
                print(direct_result.generated_patch[:2000])

        for provider in providers:
            print(f"\nVerification: {instance_id} via {provider.value}")
            result = await runner.run_single_verification(instance_id, provider)
            print(f"\n{'='*50}")
            print(f"Instance:    {result.instance_id}")
            print(f"Provider:    {result.provider.value}")
            print(f"Success:     {result.swe_result.success}")
            print(f"Patch:       {result.swe_result.patch_status.value}")
            print(f"Delegation:  {result.delegation_successful}")
            print(f"Orch Time:   {result.orchestration_time_seconds:.1f}s")
            print(f"Exec Time:   {result.provider_execution_time_seconds:.1f}s")
            if result.trace_file:
                print(f"Trace:       {result.trace_file}")
            print(f"{'='*50}")
            if result.swe_result.generated_patch:
                print(f"\nPatch ({len(result.swe_result.generated_patch)} bytes):")
                print(result.swe_result.generated_patch[:2000])

        try:
            await asyncio.wait_for(runtime.stop(), timeout=30.0)
        except asyncio.TimeoutError:
            logging.getLogger(__name__).warning(
                "Runtime stop timed out after 30s; continuing shutdown."
            )
        return

    if args.verify_provider:
        # Verification mode: run one instance per provider
        provider = ProviderType(args.verify_provider)
        instance_id = args.instance
        if not instance_id:
            print("Error: --instance required with --verify-provider")
            sys.exit(1)

        print(f"Verification: {instance_id} via {provider.value}")
        result = await runner.run_single_verification(instance_id, provider)

        print(f"\n{'='*50}")
        print(f"Instance:    {result.instance_id}")
        print(f"Provider:    {result.provider.value}")
        print(f"Success:     {result.swe_result.success}")
        print(f"Patch:       {result.swe_result.patch_status.value}")
        print(f"Delegation:  {result.delegation_successful}")
        print(f"Orch Time:   {result.orchestration_time_seconds:.1f}s")
        print(f"Exec Time:   {result.provider_execution_time_seconds:.1f}s")
        if result.trace_file:
            print(f"Trace:       {result.trace_file}")
        print(f"{'='*50}")

        if result.swe_result.generated_patch:
            print(f"\nPatch ({len(result.swe_result.generated_patch)} bytes):")
            print(result.swe_result.generated_patch[:2000])
    else:
        await runner.run_benchmark()

    try:
        await asyncio.wait_for(runtime.stop(), timeout=30.0)
    except asyncio.TimeoutError:
        logging.getLogger(__name__).warning(
            "Runtime stop timed out after 30s; continuing shutdown."
        )


async def async_main() -> None:
    """Async main entry point."""
    # Best-effort: load .env if present (no-op if missing).
    try:
        from dotenv import load_dotenv

        load_dotenv(dotenv_path=_ROOT / ".env", override=False)
    except Exception:
        pass

    args = parse_args()
    setup_logging(args.verbose)

    if args.list:
        await list_instances(args)
    elif args.stats:
        await show_stats(args)
    elif args.orchestrated or args.verify_provider:
        await run_orchestrated_benchmark(args)
    else:
        await run_benchmark(args)


def main() -> None:
    """Console-script entry point (sync wrapper)."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
