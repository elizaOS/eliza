from __future__ import annotations

import sys
from pathlib import Path
from typing import Mapping, cast

from benchmarks.bench_cli_types import (
    BenchmarkDefinition,
    BenchmarkRequirements,
    JSONValue,
    ModelSpec,
    ScoreExtraction,
    expect_dict,
    expect_float,
    expect_str,
    find_latest_file,
    get_optional,
    get_required,
    load_json_file,
)


def _score_from_bfcl_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="bfcl:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="bfcl:root"), ctx="bfcl:metrics")
    overall = expect_float(get_required(metrics, "overall_score", ctx="bfcl:metrics"), ctx="bfcl:overall_score")

    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": overall,
            "ast_accuracy": get_optional(metrics, "ast_accuracy") or 0,
            "exec_accuracy": get_optional(metrics, "exec_accuracy") or 0,
            "relevance_accuracy": get_optional(metrics, "relevance_accuracy") or 0,
            "total_tests": get_optional(metrics, "total_tests") or 0,
        },
    )


def _score_from_realm_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="realm:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="realm:root"), ctx="realm:metrics")
    overall = expect_float(
        get_required(metrics, "overall_success_rate", ctx="realm:metrics"),
        ctx="realm:overall_success_rate",
    )
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "total_tasks": get_optional(metrics, "total_tasks") or 0,
            "passed_tasks": get_optional(metrics, "passed_tasks") or 0,
            "avg_plan_quality": get_optional(metrics, "avg_plan_quality") or 0,
            "avg_efficiency": get_optional(metrics, "avg_efficiency") or 0,
        },
    )


def _score_from_mint_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="mint:root")

    def get_rate(config_key: str) -> float | None:
        cr_raw = get_optional(root, config_key)
        if cr_raw is None:
            return None
        cr = expect_dict(cr_raw, ctx=f"mint:{config_key}")
        metrics = expect_dict(get_required(cr, "metrics", ctx=f"mint:{config_key}"), ctx=f"mint:{config_key}.metrics")
        return expect_float(
            get_required(metrics, "overall_success_rate", ctx=f"mint:{config_key}.metrics"),
            ctx=f"mint:{config_key}.overall_success_rate",
        )

    full_rate = get_rate("full_results")
    baseline_rate = get_rate("baseline_results")

    chosen = full_rate if full_rate is not None else baseline_rate
    if chosen is None:
        raise ValueError("mint: could not determine overall_success_rate (missing full_results and baseline_results)")

    return ScoreExtraction(
        score=chosen,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": chosen,
            "full_results_present": full_rate is not None,
            "baseline_success_rate": baseline_rate if baseline_rate is not None else 0,
        },
    )


def _score_from_agentbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="agentbench:root")
    overall = expect_float(
        get_required(root, "overall_success_rate", ctx="agentbench:root"),
        ctx="agentbench:overall_success_rate",
    )
    total = root.get("total_tasks")
    passed = root.get("passed_tasks")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "total_tasks": total if total is not None else 0,
            "passed_tasks": passed if passed is not None else 0,
        },
    )


def _score_from_contextbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="context_bench:root")
    overall = expect_float(
        get_required(root, "overall_accuracy", ctx="context_bench:root"),
        ctx="context_bench:overall_accuracy",
    )
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "lost_in_middle_score": root.get("lost_in_middle_score") or 0,
            "total_tasks": root.get("total_tasks") or 0,
        },
    )


def _score_from_terminalbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="terminal_bench:root")
    summary = expect_dict(get_required(root, "summary", ctx="terminal_bench:root"), ctx="terminal_bench:summary")
    acc = expect_float(
        get_required(summary, "accuracy", ctx="terminal_bench:summary"),
        ctx="terminal_bench:accuracy",
    )
    return ScoreExtraction(
        score=acc,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "accuracy": acc,
            "total_tasks": summary.get("total_tasks") or 0,
            "passed_tasks": summary.get("passed_tasks") or 0,
        },
    )


def _score_from_gaia_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="gaia:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="gaia:root"), ctx="gaia:metrics")
    overall = expect_float(get_required(metrics, "overall_accuracy", ctx="gaia:metrics"), ctx="gaia:overall_accuracy")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "total_questions": metrics.get("total_questions") or 0,
            "correct_answers": metrics.get("correct_answers") or 0,
        },
    )


def _score_from_taubench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="tau_bench:root")
    overall = expect_float(
        get_required(root, "overall_success_rate", ctx="tau_bench:root"),
        ctx="tau_bench:overall_success_rate",
    )
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "overall_tool_accuracy": root.get("overall_tool_accuracy") or 0,
            "overall_policy_compliance": root.get("overall_policy_compliance") or 0,
        },
    )


def _score_from_vendingbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="vending_bench:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="vending_bench:root"), ctx="vending_bench:metrics")
    max_net_worth_raw = get_required(metrics, "max_net_worth", ctx="vending_bench:metrics")
    max_net_worth_str = expect_str(max_net_worth_raw, ctx="vending_bench:max_net_worth")
    max_net_worth = float(max_net_worth_str)
    return ScoreExtraction(
        score=max_net_worth,
        unit="usd",
        higher_is_better=True,
        metrics={
            "max_net_worth": max_net_worth_str,
            "avg_net_worth": metrics.get("avg_net_worth") or "0",
            "profitability_rate": metrics.get("profitability_rate") or 0,
            "coherence_score": metrics.get("coherence_score") or 0,
        },
    )


def _score_from_swebench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="swe_bench:root")
    summary = expect_dict(get_required(root, "summary", ctx="swe_bench:root"), ctx="swe_bench:summary")
    rr = expect_float(get_required(summary, "resolve_rate", ctx="swe_bench:summary"), ctx="swe_bench:resolve_rate")
    return ScoreExtraction(
        score=rr,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "resolve_rate": rr,
            "total_instances": summary.get("total_instances") or 0,
            "resolved": summary.get("resolved") or 0,
            "apply_rate": summary.get("apply_rate") or 0,
        },
    )


def _score_from_mind2web_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="mind2web:root")
    step_acc = expect_float(
        get_required(root, "overall_step_accuracy", ctx="mind2web:root"),
        ctx="mind2web:overall_step_accuracy",
    )
    return ScoreExtraction(
        score=step_acc,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_step_accuracy": step_acc,
            "overall_element_accuracy": get_optional(root, "overall_element_accuracy") or 0,
            "overall_operation_accuracy": get_optional(root, "overall_operation_accuracy") or 0,
            "overall_task_success_rate": get_optional(root, "overall_task_success_rate") or 0,
            "total_tasks": get_optional(root, "total_tasks") or 0,
        },
    )


def _score_from_rlmbench_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from RLM benchmark results.
    
    RLM benchmarks test Recursive Language Model performance on long-context tasks
    including S-NIAH (Streaming Needle-in-a-Haystack) and OOLONG (long document retrieval).
    
    Reference: arXiv:2512.24601 - Recursive Language Models
    """
    root = expect_dict(data, ctx="rlm_bench:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="rlm_bench:root"), ctx="rlm_bench:metrics")
    overall_acc = expect_float(
        get_required(metrics, "overall_accuracy", ctx="rlm_bench:metrics"),
        ctx="rlm_bench:overall_accuracy",
    )
    
    # s_niah_by_length is a dict {length_str: accuracy}, compute average if present
    s_niah_by_length = get_optional(metrics, "s_niah_by_length")
    s_niah_avg = 0.0
    if isinstance(s_niah_by_length, dict) and s_niah_by_length:
        accuracies = [v for v in s_niah_by_length.values() if isinstance(v, (int, float))]
        if accuracies:
            s_niah_avg = sum(accuracies) / len(accuracies)
    
    return ScoreExtraction(
        score=overall_acc,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall_acc,
            "total_tasks": get_optional(metrics, "total_tasks") or 0,
            "passed_tasks": get_optional(metrics, "passed_tasks") or 0,
            "s_niah_avg_accuracy": s_niah_avg,  # Computed from s_niah_by_length dict
            "oolong_accuracy": get_optional(metrics, "oolong_accuracy") or 0,
            "oolong_pairs_accuracy": get_optional(metrics, "oolong_pairs_accuracy") or 0,
            "total_cost_usd": get_optional(metrics, "total_cost_usd") or 0,
            "avg_iterations": get_optional(metrics, "avg_iterations") or 0,
        },
    )


def get_benchmark_registry(repo_root: Path) -> list[BenchmarkDefinition]:
    python = sys.executable

    def repo(path: str) -> str:
        return str((repo_root / path).resolve())

    def _bfcl_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.bfcl", "run", "--output", str(output_dir)]
        if model.provider:
            args.extend(["--provider", model.provider])
        if model.model:
            args.extend(["--model", model.model])
        sample = extra.get("sample")
        if isinstance(sample, int) and sample > 0:
            args.extend(["--sample", str(sample)])
        return args

    def _bfcl_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="bfcl_results_*.json")

    def _realm_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.realm.cli", "--output", str(output_dir)]
        categories = extra.get("categories")
        if isinstance(categories, list) and all(isinstance(x, str) for x in categories):
            args.extend(["--categories", *cast(list[str], categories)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        if model.model:
            # REALM currently treats --model as a reporting label; still useful to record.
            args.extend(["--model", model.model])
        return args

    def _realm_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="realm-benchmark-*.json")

    def _mint_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, repo("benchmarks/mint/run_benchmark.py"), "--output-dir", str(output_dir)]
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        categories = extra.get("categories")
        if isinstance(categories, list) and all(isinstance(x, str) for x in categories):
            args.extend(["--categories", *cast(list[str], categories)])
        return args

    def _mint_result(output_dir: Path) -> Path:
        return output_dir / "mint-benchmark-results.json"

    def _agentbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            repo("benchmarks/agentbench/python/run_benchmark.py"),
            "--output",
            str(output_dir),
        ]
        envs = extra.get("env")
        if isinstance(envs, list) and all(isinstance(x, str) for x in envs):
            args.extend(["--env", *cast(list[str], envs)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        # Agent runtime selection
        agent = extra.get("agent")
        if agent == "milaidy":
            args.append("--milaidy")
        elif extra.get("elizaos") is True:
            args.append("--elizaos")
        _ = model
        return args

    def _agentbench_result(output_dir: Path) -> Path:
        return output_dir / "agentbench-results.json"

    def _contextbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        agent = extra.get("agent")
        if agent == "milaidy":
            provider_str = "milaidy"
        else:
            provider = extra.get("provider")
            provider_str = provider if isinstance(provider, str) else "mock"
        args = [
            python,
            repo("benchmarks/context-bench/run_benchmark.py"),
            "--provider",
            provider_str,
            "--output-dir",
            str(output_dir),
        ]
        quick = extra.get("quick")
        if quick is True:
            args.append("--quick")
        _ = model
        return args

    def _contextbench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="context_bench_*.json")

    def _terminalbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        # Run module from its python project root.
        _ = extra
        args = [
            python,
            "-m",
            "elizaos_terminal_bench.cli",
            "--output-dir",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        sample = extra.get("sample")
        if sample is True:
            args.append("--sample")
        return args

    def _terminalbench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="terminal-bench-*.json")

    def _gaia_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            "-m",
            "elizaos_gaia.cli",
            "--output",
            str(output_dir),
        ]
        if model.provider:
            args.extend(["--provider", model.provider])
        if model.model:
            args.extend(["--model", model.model])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        max_q = extra.get("max_questions")
        if isinstance(max_q, int) and max_q > 0:
            args.extend(["--max-questions", str(max_q)])
        quick = extra.get("quick_test")
        if quick is True:
            args.append("--quick-test")
        return args

    def _gaia_result(output_dir: Path) -> Path:
        # Prefer latest file if present; otherwise grab any latest json under model subdir.
        try:
            return find_latest_file(output_dir, glob_pattern="**/gaia-results-latest.json")
        except FileNotFoundError:
            return find_latest_file(output_dir, glob_pattern="**/gaia-results_*.json")

    def _tau_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            "-m",
            "elizaos_tau_bench.cli",
            "--output",
            str(output_dir),
        ]
        agent = extra.get("agent")
        if agent == "milaidy":
            args.extend(["--real-llm", "--model-provider", "milaidy"])
        else:
            real = extra.get("real_llm")
            if real is True:
                args.append("--real-llm")
            if model.provider:
                args.extend(["--model-provider", model.provider])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        sample = extra.get("sample")
        if sample is True:
            args.append("--sample")
        return args

    def _tau_result(output_dir: Path) -> Path:
        return output_dir / "tau-bench-results.json"

    def _vending_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "elizaos_vending_bench.cli", "--output-dir", str(output_dir)]
        if model.model:
            args.extend(["--model", model.model])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        runs = extra.get("num_runs")
        if isinstance(runs, int) and runs > 0:
            args.extend(["--num-runs", str(runs)])
        return args

    def _vending_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="vending-bench-results-*.json")

    def _swe_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.swe_bench.cli", "--output", str(output_dir)]
        if model.model:
            args.extend(["--model", model.model])
        max_instances = extra.get("max_instances")
        if isinstance(max_instances, int) and max_instances > 0:
            args.extend(["--max-instances", str(max_instances)])
        variant = extra.get("variant")
        if isinstance(variant, str) and variant in ("lite", "verified", "full"):
            args.extend(["--variant", variant])
        no_docker = extra.get("no_docker")
        if no_docker is True:
            args.append("--no-docker")
        return args

    def _swe_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="swe-bench-*.json")

    def _mind2web_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.mind2web", "--output", str(output_dir)]
        agent = extra.get("agent")
        if agent == "milaidy":
            args.extend(["--real-llm", "--provider", "milaidy"])
        else:
            if model.provider:
                args.extend(["--provider", model.provider])
            real_llm = extra.get("real_llm")
            if real_llm is True:
                args.append("--real-llm")
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        sample = extra.get("sample")
        if sample is True:
            args.append("--sample")
        return args

    def _mind2web_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="mind2web-results*.json")

    def _rlm_bench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for RLM benchmark.
        
        Supports S-NIAH (Streaming Needle-in-a-Haystack) and OOLONG benchmarks
        from the RLM paper (arXiv:2512.24601).
        """
        args = [
            python,
            repo("benchmarks/rlm-bench/run_benchmark.py"),
            "--output-dir",
            str(output_dir),
        ]
        mode = extra.get("mode")
        if isinstance(mode, str) and mode in ("stub", "rlm", "custom"):
            args.extend(["--mode", mode])
        else:
            args.extend(["--mode", "stub"])  # Default to stub for testing
        backend = extra.get("backend")
        if isinstance(backend, str):
            args.extend(["--backend", backend])
        context_lengths = extra.get("context_lengths")
        if isinstance(context_lengths, str):
            args.extend(["--context-lengths", context_lengths])
        elif isinstance(context_lengths, list) and all(isinstance(x, int) for x in context_lengths):
            args.extend(["--context-lengths", ",".join(str(x) for x in cast(list[int], context_lengths))])
        tasks_per_config = extra.get("tasks_per_config")
        if isinstance(tasks_per_config, int) and tasks_per_config > 0:
            args.extend(["--tasks-per-config", str(tasks_per_config)])
        max_iterations = extra.get("max_iterations")
        if isinstance(max_iterations, int) and max_iterations > 0:
            args.extend(["--max-iterations", str(max_iterations)])
        max_depth = extra.get("max_depth")
        if isinstance(max_depth, int) and max_depth > 0:
            args.extend(["--max-depth", str(max_depth)])
        dual_model = extra.get("dual_model")
        if dual_model is True:
            args.append("--dual-model")
        no_s_niah = extra.get("no_s_niah")
        if no_s_niah is True:
            args.append("--no-s-niah")
        no_oolong = extra.get("no_oolong")
        if no_oolong is True:
            args.append("--no-oolong")
        _ = model
        return args

    def _rlm_bench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="rlm_bench_results_*.json")

    return [
        BenchmarkDefinition(
            id="bfcl",
            display_name="BFCL",
            description="Berkeley Function-Calling Leaderboard",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="Requires provider API key for real LLM runs; supports --provider/--model.",
            ),
            build_command=_bfcl_cmd,
            locate_result=_bfcl_result,
            extract_score=_score_from_bfcl_json,
        ),
        BenchmarkDefinition(
            id="realm",
            display_name="REALM-Bench",
            description="Real-World Planning benchmark",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("data/realm",),
                notes="Uses ./data/realm by default; set --data-path via extra config.",
            ),
            build_command=_realm_cmd,
            locate_result=_realm_result,
            extract_score=_score_from_realm_json,
        ),
        BenchmarkDefinition(
            id="mint",
            display_name="MINT",
            description="Multi-turn benchmark (tools + feedback ablations)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="Runs locally; uses mock LLM unless wired to runtime in benchmark code.",
            ),
            build_command=_mint_cmd,
            locate_result=_mint_result,
            extract_score=_score_from_mint_json,
        ),
        BenchmarkDefinition(
            id="agentbench",
            display_name="AgentBench",
            description="AgentBench environments (sample tasks in this repo)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="By default runs with mock runtime; --elizaos path is not fully model-wired yet.",
            ),
            build_command=_agentbench_cmd,
            locate_result=_agentbench_result,
            extract_score=_score_from_agentbench_json,
        ),
        BenchmarkDefinition(
            id="context_bench",
            display_name="ContextBench",
            description="Needle-in-a-haystack + multihop context retrieval benchmark",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="Provider-specific SDKs required for openai/anthropic; mock works without keys.",
            ),
            build_command=_contextbench_cmd,
            locate_result=_contextbench_result,
            extract_score=_score_from_contextbench_json,
        ),
        BenchmarkDefinition(
            id="terminal_bench",
            display_name="Terminal-Bench",
            description="Terminal proficiency benchmark",
            cwd_rel="benchmarks/terminal-bench/python",
            requirements=BenchmarkRequirements(
                env_vars=("OPENAI_API_KEY",),
                paths=(),
                notes="Can run with sample tasks; full runs require dataset and typically an API key.",
            ),
            build_command=_terminalbench_cmd,
            locate_result=_terminalbench_result,
            extract_score=_score_from_terminalbench_json,
        ),
        BenchmarkDefinition(
            id="gaia",
            display_name="GAIA",
            description="GAIA real-world tasks benchmark",
            cwd_rel="benchmarks/gaia/python",
            requirements=BenchmarkRequirements(
                env_vars=("GROQ_API_KEY",),
                paths=(),
                notes="Downloads dataset; requires provider key unless using local provider.",
            ),
            build_command=_gaia_cmd,
            locate_result=_gaia_result,
            extract_score=_score_from_gaia_json,
        ),
        BenchmarkDefinition(
            id="tau_bench",
            display_name="Tau-bench",
            description="Tool-Agent-User Interaction benchmark",
            cwd_rel="benchmarks/tau-bench/python",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmark-data/tau-bench",),
                notes="Defaults to mock mode; use extra real_llm=true to enable real LLM.",
            ),
            build_command=_tau_cmd,
            locate_result=_tau_result,
            extract_score=_score_from_taubench_json,
        ),
        BenchmarkDefinition(
            id="vending_bench",
            display_name="Vending-Bench",
            description="Vending machine management simulation benchmark",
            cwd_rel="benchmarks/vending-bench/python",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="Heuristic/LLM agent depending on CLI; output includes max_net_worth.",
            ),
            build_command=_vending_cmd,
            locate_result=_vending_result,
            extract_score=_score_from_vendingbench_json,
        ),
        BenchmarkDefinition(
            id="swe_bench",
            display_name="SWE-bench",
            description="Software engineering benchmark (Lite/Verified/Full)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="Requires datasets and often Docker for evaluation; model wiring depends on runtime plugins.",
            ),
            build_command=_swe_cmd,
            locate_result=_swe_result,
            extract_score=_score_from_swebench_json,
        ),
        BenchmarkDefinition(
            id="mind2web",
            display_name="Mind2Web",
            description="Web agent navigation benchmark (OSU-NLP-Group)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=("GROQ_API_KEY",),
                paths=(),
                notes="Uses sample tasks by default; --hf loads from HuggingFace. Supports Groq, OpenAI, Anthropic.",
            ),
            build_command=_mind2web_cmd,
            locate_result=_mind2web_result,
            extract_score=_score_from_mind2web_json,
        ),
        BenchmarkDefinition(
            id="rlm_bench",
            display_name="RLM-Bench",
            description="Recursive Language Model benchmark (S-NIAH, OOLONG) - arXiv:2512.24601",
            cwd_rel="benchmarks/rlm-bench",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="Tests long-context processing. Modes: stub (mock), rlm (full RLM). Requires RLM plugin for rlm mode.",
            ),
            build_command=_rlm_bench_cmd,
            locate_result=_rlm_bench_result,
            extract_score=_score_from_rlmbench_json,
        ),
    ]


def load_benchmark_result_json(path: Path) -> JSONValue:
    return load_json_file(path)

