from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Mapping, cast

if __package__ in {"", None}:
    from bench_cli_types import (
        BenchmarkDefinition,
        BenchmarkRequirements,
        JSONValue,
        ModelSpec,
        ScoreExtraction,
        expect_dict,
        expect_float,
        expect_list,
        expect_str,
        find_latest_file,
        get_optional,
        get_required,
        load_json_file,
    )
else:
    from benchmarks.bench_cli_types import (
        BenchmarkDefinition,
        BenchmarkRequirements,
        JSONValue,
        ModelSpec,
        ScoreExtraction,
        expect_dict,
        expect_float,
        expect_list,
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
    metrics_obj = get_optional(root, "metrics")
    metrics = expect_dict(metrics_obj, ctx="context_bench:metrics") if isinstance(metrics_obj, dict) else root
    overall_raw = get_optional(metrics, "overall_accuracy")
    if isinstance(overall_raw, str):
        cleaned = overall_raw.strip()
        as_percent = cleaned.endswith("%")
        if as_percent:
            cleaned = cleaned[:-1].strip()
        try:
            overall = float(cleaned)
        except ValueError as exc:
            raise ValueError("context_bench:overall_accuracy is not numeric") from exc
        if as_percent:
            overall /= 100.0
    else:
        overall = expect_float(
            get_required(metrics, "overall_accuracy", ctx="context_bench:metrics"),
            ctx="context_bench:overall_accuracy",
        )
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "lost_in_middle_score": metrics.get("lost_in_middle_score") or 0,
            "total_tasks": metrics.get("total_tasks") or 0,
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


def _score_from_swebench_orchestrated_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="swe_bench_orchestrated:root")
    metrics_obj = get_optional(root, "metrics")
    if isinstance(metrics_obj, dict):
        overall_raw = get_optional(metrics_obj, "overall_score")
        if isinstance(overall_raw, (int, float)):
            overall = float(overall_raw)
            return ScoreExtraction(
                score=overall,
                unit="ratio",
                higher_is_better=True,
                metrics={
                    "overall_score": overall,
                    "provider_scores": metrics_obj.get("provider_scores") or {},
                },
            )

    orchestrated_obj = get_optional(root, "orchestrated")
    if not isinstance(orchestrated_obj, dict):
        raise ValueError("swe_bench_orchestrated: missing orchestrated block")

    provider_rates: list[float] = []
    for provider_data in orchestrated_obj.values():
        if not isinstance(provider_data, dict):
            continue
        summary = provider_data.get("summary")
        if not isinstance(summary, dict):
            continue
        rate = summary.get("resolve_rate")
        if isinstance(rate, (int, float)):
            provider_rates.append(float(rate))

    if not provider_rates:
        raise ValueError("swe_bench_orchestrated: no provider resolve rates found")

    overall = sum(provider_rates) / len(provider_rates)
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": overall,
            "providers_count": len(provider_rates),
            "matrix_present": isinstance(get_optional(root, "matrix"), dict),
        },
    )


def _score_from_orchestrator_lifecycle_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="orchestrator_lifecycle:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="orchestrator_lifecycle:root"), ctx="orchestrator_lifecycle:metrics")
    overall_raw = metrics.get("overall_score")
    if not isinstance(overall_raw, (int, float)):
        raise ValueError("orchestrator_lifecycle: missing metrics.overall_score")
    overall = float(overall_raw)
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": overall,
            "scenario_pass_rate": metrics.get("scenario_pass_rate") or 0,
            "clarification_success_rate": metrics.get("clarification_success_rate") or 0,
            "interruption_handling_rate": metrics.get("interruption_handling_rate") or 0,
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


def _score_from_solana_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from Solana benchmark results."""
    root = expect_dict(data, ctx="solana:root")
    final_reward = expect_float(
        get_required(root, "final_reward", ctx="solana:root"),
        ctx="solana:final_reward",
    )
    return ScoreExtraction(
        score=final_reward,
        unit="unique_instructions",
        higher_is_better=True,
        metrics={
            "final_reward": final_reward,
            "final_programs": root.get("final_programs") or 0,
            "model": root.get("model") or "",
            "run_id": root.get("run_id") or "",
        },
    )


def _score_from_osworld_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from OSWorld benchmark results."""
    root = expect_dict(data, ctx="osworld:root")
    overall = expect_float(
        get_required(root, "overall_success_rate", ctx="osworld:root"),
        ctx="osworld:overall_success_rate",
    )
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "total_tasks": root.get("total_tasks") or 0,
            "passed_tasks": root.get("passed_tasks") or 0,
            "model": root.get("model") or "",
            "agent": root.get("agent") or "eliza",
            "observation_type": root.get("observation_type") or "",
            "action_space": root.get("action_space") or "",
        },
    )


def _score_from_configbench_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from ConfigBench results.

    Prefers the Eliza handler when present; otherwise falls back to the first
    handler emitted (Perfect oracle in mock-only runs). Scores are reported
    in 0..100; we normalize to 0..1 for parity with other benchmarks.
    """
    root = expect_dict(data, ctx="configbench:root")
    handlers = expect_list(get_required(root, "handlers", ctx="configbench:root"), ctx="configbench:handlers")
    target: dict[str, JSONValue] | None = None
    for entry in handlers:
        if not isinstance(entry, dict):
            continue
        name_raw = entry.get("handlerName")
        if isinstance(name_raw, str) and "eliza" in name_raw.lower():
            target = entry
            break
    if target is None and handlers:
        first = handlers[0]
        if isinstance(first, dict):
            target = first
    if target is None:
        raise ValueError("configbench: no handler entries found")
    overall_raw = target.get("overallScore")
    overall = expect_float(overall_raw if overall_raw is not None else 0.0, ctx="configbench:overallScore")
    security_raw = target.get("securityScore")
    capability_raw = target.get("capabilityScore")
    return ScoreExtraction(
        score=overall / 100.0,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overallScore": overall,
            "securityScore": security_raw if security_raw is not None else 0,
            "capabilityScore": capability_raw if capability_raw is not None else 0,
            "handlerName": target.get("handlerName") or "",
            "validationPassed": root.get("validationPassed") or False,
        },
    )


def _score_from_voicebench_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from VoiceBench results.

    VoiceBench is a latency benchmark: we report the average end-to-end
    latency (ms) for the ``simple`` mode as the primary score (lower is
    better) and surface key percentile + transcription metrics for context.
    Falls back to whichever mode key is present when ``simple`` is missing.
    """
    root = expect_dict(data, ctx="voicebench:root")
    summary = expect_dict(get_required(root, "summary", ctx="voicebench:root"), ctx="voicebench:summary")
    if not summary:
        raise ValueError("voicebench: empty summary block")
    mode_key = "simple" if "simple" in summary else next(iter(summary))
    mode_summary = expect_dict(summary[mode_key], ctx=f"voicebench:summary.{mode_key}")
    avg_e2e = expect_float(
        get_required(mode_summary, "avgEndToEndMs", ctx=f"voicebench:summary.{mode_key}"),
        ctx=f"voicebench:summary.{mode_key}.avgEndToEndMs",
    )
    return ScoreExtraction(
        score=avg_e2e,
        unit="ms",
        higher_is_better=False,
        metrics={
            "mode": mode_key,
            "avgEndToEndMs": avg_e2e,
            "p95EndToEndMs": mode_summary.get("p95EndToEndMs") or 0,
            "p99EndToEndMs": mode_summary.get("p99EndToEndMs") or 0,
            "avgTranscriptionMs": mode_summary.get("avgTranscriptionMs") or 0,
            "avgResponseTtftMs": mode_summary.get("avgResponseTtftMs") or 0,
            "avgVoiceFirstTokenCachedMs": mode_summary.get("avgVoiceFirstTokenCachedMs") or 0,
            "transcriptionNormalizedAccuracy": mode_summary.get("transcriptionNormalizedAccuracy") or 0,
            "runs": mode_summary.get("runs") or 0,
            "profile": root.get("profile") or "",
        },
    )


def _score_from_social_alpha_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from Social-Alpha results.

    Reports the COMPOSITE Trust Marketplace Score (0..100) when all four
    suites ran. Falls back to averaging the available per-suite scores when
    only a subset of suites was selected (e.g. ``--suite detect``).
    """
    root = expect_dict(data, ctx="social_alpha:root")
    composite_raw = root.get("COMPOSITE")
    suite_scores: dict[str, float] = {}
    for key, value in root.items():
        if not isinstance(value, dict) or key == "COMPOSITE":
            continue
        suite_score_raw = value.get("suite_score")
        if isinstance(suite_score_raw, (int, float)):
            suite_scores[key] = float(suite_score_raw)
    if isinstance(composite_raw, dict):
        tms_raw = composite_raw.get("trust_marketplace_score")
        if isinstance(tms_raw, (int, float)):
            tms = float(tms_raw)
            return ScoreExtraction(
                score=tms / 100.0,
                unit="ratio",
                higher_is_better=True,
                metrics={
                    "trust_marketplace_score": tms,
                    "suite_scores": cast(JSONValue, suite_scores),
                },
            )
    if not suite_scores:
        raise ValueError("social_alpha: no suite_score values found")
    avg_score = sum(suite_scores.values()) / len(suite_scores)
    return ScoreExtraction(
        score=avg_score / 100.0,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "average_suite_score": avg_score,
            "suite_scores": cast(JSONValue, suite_scores),
            "suites_run": list(suite_scores.keys()),
        },
    )


def _score_from_webshop_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from WebShop benchmark results."""
    root = expect_dict(data, ctx="webshop:root")
    success_rate = expect_float(
        get_required(root, "success_rate", ctx="webshop:root"),
        ctx="webshop:success_rate",
    )
    return ScoreExtraction(
        score=success_rate,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "success_rate": success_rate,
            "average_reward": root.get("average_reward") or 0,
            "average_turns": root.get("average_turns") or 0,
            "average_steps": root.get("average_steps") or 0,
            "average_duration_ms": root.get("average_duration_ms") or 0,
            "total_tasks": root.get("total_tasks") or 0,
            "total_trials": root.get("total_trials") or 0,
        },
    )


def _score_from_hyperliquid_bench_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from HyperliquidBench results.

    The benchmark writes one aggregated JSON per ``__main__`` invocation
    containing the average ``final_score`` across all scenarios plus the
    base/bonus/penalty totals from ``hl-evaluator``. Higher is better.
    """
    root = expect_dict(data, ctx="hyperliquid_bench:root")
    overall = expect_float(
        get_required(root, "final_score", ctx="hyperliquid_bench:root"),
        ctx="hyperliquid_bench:final_score",
    )
    return ScoreExtraction(
        score=overall,
        unit="score",
        higher_is_better=True,
        metrics={
            "final_score": overall,
            "total_score": get_optional(root, "total_score") or 0,
            "base": get_optional(root, "base") or 0,
            "bonus": get_optional(root, "bonus") or 0,
            "penalty": get_optional(root, "penalty") or 0,
            "total_scenarios": get_optional(root, "total_scenarios") or 0,
            "passed_scenarios": get_optional(root, "passed_scenarios") or 0,
            "mode": get_optional(root, "mode") or "",
            "model": get_optional(root, "model") or "",
            "network": get_optional(root, "network") or "",
            "demo_mode": get_optional(root, "demo_mode") if get_optional(root, "demo_mode") is not None else True,
        },
    )


def _score_from_gauntlet_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from Solana Gauntlet benchmark results.

    The Gauntlet is a tiered adversarial benchmark for evaluating AI agent
    safety on Solana.  Scores are out of 100 with component weights:
    Task Completion (30%), Safety (40%), Efficiency (20%), Capital (10%).
    """
    root = expect_dict(data, ctx="gauntlet:root")
    results = expect_dict(
        get_required(root, "results", ctx="gauntlet:root"),
        ctx="gauntlet:results",
    )
    overall = expect_float(
        get_required(results, "overall_score", ctx="gauntlet:results"),
        ctx="gauntlet:overall_score",
    )
    components = expect_dict(
        get_required(results, "components", ctx="gauntlet:results"),
        ctx="gauntlet:components",
    )
    return ScoreExtraction(
        score=overall,
        unit="score",
        higher_is_better=True,
        metrics={
            "overall_score": overall,
            "passed": results.get("passed") or False,
            "task_completion": get_optional(components, "task_completion") or 0,
            "safety": get_optional(components, "safety") or 0,
            "efficiency": get_optional(components, "efficiency") or 0,
            "capital": get_optional(components, "capital") or 0,
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
        if extra.get("mock") is True:
            args.append("--mock")
        sample = extra.get("sample")
        if isinstance(sample, int) and sample > 0:
            args.extend(["--sample", str(sample)])
        max_per_category = extra.get("max_per_category")
        if isinstance(max_per_category, int) and max_per_category > 0:
            args.extend(["--max-per-category", str(max_per_category)])
        categories = extra.get("categories")
        if isinstance(categories, list) and all(isinstance(x, str) for x in categories):
            args.extend(["--categories", ",".join(cast(list[str], categories))])
        local_data = extra.get("local_data")
        if isinstance(local_data, str) and local_data.strip():
            args.extend(["--local-data", local_data])
        if extra.get("no_report") is True:
            args.append("--no-report")
        if extra.get("no_exec") is True:
            args.append("--no-exec")
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
            # REALM treats --model as a reporting label only; the actual LLM is
            # picked by the in-process elizaOS Python runtime (default) or by the
            # TS bridge (when --provider eliza is set).
            args.extend(["--model", model.model])
        # Route the planning loop through the TS benchmark server when the
        # caller asks for the eliza agent (either via model.provider or the
        # explicit "agent": "eliza" extra).
        agent = extra.get("agent")
        provider_name = (model.provider or "").strip().lower()
        if agent == "eliza" or provider_name == "eliza":
            args.extend(["--provider", "eliza"])
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
        # Route LLM calls through the elizaOS TS benchmark server when the caller
        # asks for the eliza agent (either via model.provider or extra.agent).
        agent = extra.get("agent")
        provider_name = (model.provider or "").strip().lower()
        if agent == "eliza" or provider_name == "eliza":
            args.extend(["--provider", "eliza"])
        return args

    def _mint_result(output_dir: Path) -> Path:
        return output_dir / "mint-benchmark-results.json"

    def _agentbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            "-m",
            "elizaos_agentbench.cli",
            "run",
            "--output",
            str(output_dir),
        ]
        envs = extra.get("env")
        if isinstance(envs, list) and all(isinstance(x, str) for x in envs):
            env_aliases = {
                "db": "database",
                "kg": "kg",
                "lt": "lateral",
                "os": "os",
                "ws": "webshop",
                "all": "all",
            }
            mapped_envs = [env_aliases.get(env, env) for env in cast(list[str], envs)]
            args.extend(["--env", *mapped_envs])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        # Agent runtime selection
        agent = extra.get("agent")
        if agent == "eliza" or extra.get("elizaos") is True:
            args.extend(["--runtime", "elizaos"])
        else:
            args.extend(["--runtime", "mock"])
        _ = model
        return args

    def _agentbench_result(output_dir: Path) -> Path:
        return output_dir / "agentbench-results.json"

    def _contextbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        agent = extra.get("agent")
        if agent == "eliza":
            provider_str = "eliza"
        else:
            provider = extra.get("provider")
            provider_name = ""
            if isinstance(provider, str):
                provider_name = provider.strip().lower()
            elif model.provider:
                provider_name = model.provider.strip().lower()
            provider_map: dict[str, str] = {
                "openai": "eliza-openai",
                "groq": "eliza-openai",
                "openrouter": "eliza-openai",
                "anthropic": "anthropic",
            }
            provider_str = provider_map.get(provider_name, "mock")
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
            model_name = model.model
            if model.provider and "/" not in model_name:
                model_name = f"{model.provider}/{model_name}"
            args.extend(["--model", model_name])
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
        dataset = extra.get("dataset")
        if isinstance(dataset, str) and dataset in {"gaia", "sample", "jsonl"}:
            args.extend(["--dataset", dataset])
        elif not os.getenv("HF_TOKEN"):
            # Default to sample dataset when HF gated GAIA access is unavailable.
            args.extend(["--dataset", "sample"])
        dataset_path = extra.get("dataset_path")
        if isinstance(dataset_path, str) and dataset_path.strip():
            args.extend(["--dataset-path", dataset_path])
        max_q = extra.get("max_questions")
        if isinstance(max_q, int) and max_q > 0:
            args.extend(["--max-questions", str(max_q)])
        else:
            args.extend(["--max-questions", "3"])
        quick = extra.get("quick_test")
        if quick is None or quick is True:
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
        if agent == "eliza":
            args.extend(["--real-llm", "--model-provider", "eliza"])
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
        trajectories = extra.get("trajectories")
        if trajectories is not True:
            args.append("--no-trajectories")
        return args

    def _tau_result(output_dir: Path) -> Path:
        return output_dir / "tau-bench-results.json"

    def _vending_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "elizaos_vending_bench.cli", "run", "--output-dir", str(output_dir)]
        if model.model:
            args.extend(["--model", model.model])
        if model.provider in {"openai", "anthropic", "groq", "heuristic", "eliza"}:
            args.extend(["--provider", model.provider])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        runs = extra.get("runs")
        if not isinstance(runs, int):
            runs = extra.get("num_runs")
        if isinstance(runs, int) and runs > 0:
            args.extend(["--runs", str(runs)])
        return args

    def _vending_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="vending-bench-results-*.json")

    def _swe_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.swe_bench.cli", "--output", str(output_dir)]
        if model.model:
            model_name = model.model
            # The eliza bridge forwards the model name as a hint to the
            # TypeScript runtime, so we leave it unprefixed.
            if (
                model.provider
                and model.provider != "eliza"
                and "/" not in model_name
            ):
                model_name = f"{model.provider}/{model_name}"
            args.extend(["--model", model_name])
        if model.provider:
            args.extend(["--provider", model.provider])
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

    def _swe_orchestrated_cmd(
        output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]
    ) -> list[str]:
        args = [
            python,
            "-m",
            "benchmarks.swe_bench.cli",
            "--orchestrated",
            "--output",
            str(output_dir),
        ]
        if model.model:
            model_name = model.model
            if (
                model.provider
                and model.provider != "eliza"
                and "/" not in model_name
            ):
                model_name = f"{model.provider}/{model_name}"
            args.extend(["--model", model_name])
        if model.provider:
            args.extend(["--provider", model.provider])
        max_instances = extra.get("max_instances")
        if isinstance(max_instances, int) and max_instances > 0:
            args.extend(["--max-instances", str(max_instances)])
        variant = extra.get("variant")
        if isinstance(variant, str) and variant in {"lite", "verified", "full"}:
            args.extend(["--variant", variant])
        max_steps = extra.get("max_steps")
        if isinstance(max_steps, int) and max_steps > 0:
            args.extend(["--max-steps", str(max_steps)])
        if extra.get("no_docker") is True:
            args.append("--no-docker")

        execution_mode = extra.get("execution_mode")
        if isinstance(execution_mode, str) and execution_mode in {
            "orchestrated",
            "direct_shell",
        }:
            args.extend(["--execution-mode", execution_mode])

        providers = extra.get("providers")
        if isinstance(providers, list):
            provider_values = [str(p) for p in providers if str(p).strip()]
            if provider_values:
                args.extend(["--providers", *provider_values])
        if extra.get("matrix") is True:
            args.append("--matrix")
        if extra.get("no_baseline") is True:
            args.append("--no-baseline")
        if extra.get("allow_task_fallback") is True:
            args.append("--allow-task-fallback")
        orchestrator_model = extra.get("orchestrator_model")
        if isinstance(orchestrator_model, str) and orchestrator_model.strip():
            args.extend(["--orchestrator-model", orchestrator_model.strip()])
        trace_dir = extra.get("trace_dir")
        if isinstance(trace_dir, str) and trace_dir.strip():
            args.extend(["--trace-dir", trace_dir.strip()])
        required_caps = extra.get("required_capabilities")
        if isinstance(required_caps, list) and required_caps:
            args.extend(["--required-capabilities", ",".join(str(c) for c in required_caps)])
        elif isinstance(required_caps, str) and required_caps.strip():
            args.extend(["--required-capabilities", required_caps.strip()])
        if extra.get("strict_capabilities") is True:
            args.append("--strict-capabilities")
        return args

    def _swe_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="swe-bench-*.json")

    def _swe_orchestrated_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="orchestrated-*.json")

    def _orchestrator_lifecycle_cmd(
        output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]
    ) -> list[str]:
        args = [
            python,
            "-m",
            "benchmarks.orchestrator_lifecycle.cli",
            "--output",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        if model.provider:
            args.extend(["--provider", model.provider])
        max_scenarios = extra.get("max_scenarios")
        if isinstance(max_scenarios, int) and max_scenarios > 0:
            args.extend(["--max-scenarios", str(max_scenarios)])
        scenario_filter = extra.get("scenario_filter")
        if isinstance(scenario_filter, str) and scenario_filter.strip():
            args.extend(["--scenario-filter", scenario_filter.strip()])
        seed = extra.get("seed")
        if isinstance(seed, int):
            args.extend(["--seed", str(seed)])
        if extra.get("strict") is True:
            args.append("--strict")
        return args

    def _orchestrator_lifecycle_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="orchestrator-lifecycle-*.json")

    def _mind2web_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.mind2web", "--output", str(output_dir)]
        agent = extra.get("agent")
        if agent == "eliza":
            args.extend(["--real-llm", "--provider", "eliza"])
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
        mock = extra.get("mock")
        if mock is True:
            args.append("--mock")
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
        if isinstance(mode, str) and mode in ("stub", "rlm", "eliza", "custom"):
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

    def _solana_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for Solana gym benchmark.

        The explorer is env-driven (no CLI flags). Caller propagates settings
        via environment variables: ``MODEL_NAME``, ``MAX_MESSAGES``,
        ``ENVIRONMENT_CONFIG``, ``USE_EXTERNAL_SURFPOOL``, and ``MODE``
        (set ``MODE=eliza`` to route LLM calls through the elizaOS TS
        benchmark server instead of an in-process AgentRuntime).
        """
        args = [
            python, "-m", "benchmarks.solana.eliza_explorer",
        ]
        # All knobs flow through env vars read by ``eliza_explorer.main``.
        _ = model
        _ = extra
        _ = output_dir
        return args

    def _solana_result(output_dir: Path) -> Path:
        gym_metrics = repo_root / "benchmarks" / "solana" / "solana-gym-env" / "metrics"
        return find_latest_file(gym_metrics, glob_pattern="eliza_*_metrics.json")

    def _osworld_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for OSWorld benchmark."""
        args = [
            python,
            repo("benchmarks/OSWorld/scripts/python/run_multienv_eliza.py"),
            "--result_dir",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        provider = extra.get("provider_name")
        if isinstance(provider, str):
            args.extend(["--provider_name", provider])
        else:
            args.extend(["--provider_name", "docker"])
        path_to_vm = extra.get("path_to_vm")
        if isinstance(path_to_vm, str):
            args.extend(["--path_to_vm", path_to_vm])
        observation = extra.get("observation_type")
        if isinstance(observation, str):
            args.extend(["--observation_type", observation])
        else:
            args.extend(["--observation_type", "screenshot_a11y_tree"])
        action_space = extra.get("action_space")
        if isinstance(action_space, str):
            args.extend(["--action_space", action_space])
        max_steps = extra.get("max_steps")
        if isinstance(max_steps, int) and max_steps > 0:
            args.extend(["--max_steps", str(max_steps)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max_tasks", str(max_tasks)])
        task_id = extra.get("task_id")
        if isinstance(task_id, str):
            args.extend(["--task_id", task_id])
        domain = extra.get("domain")
        if isinstance(domain, str):
            args.extend(["--domain", domain])
        headless = extra.get("headless")
        if headless is True:
            args.append("--headless")
        dry_run = extra.get("dry_run")
        if dry_run is True:
            args.append("--dry_run")
        _ = model
        return args

    def _osworld_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="osworld-eliza-results-*.json")

    # HyperliquidBench - perp-trading plan generation + Rust execution
    def _hyperliquid_bench_cmd(
        output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]
    ) -> list[str]:
        """Build command for HyperliquidBench.

        Defaults to ``--mode python`` (in-process elizaos.AgentRuntime). When
        the caller asks for the eliza bridge (via ``model.provider == "eliza"``
        or ``extra.agent == "eliza"``), routes plan generation through the TS
        benchmark server. Always runs in ``--demo`` mode unless the caller
        explicitly opts in to ``--no-demo`` (which requires ``HL_PRIVATE_KEY``
        and a non-mainnet network).
        """
        args = [
            python,
            "-m",
            "benchmarks.HyperliquidBench",
            "--output",
            str(output_dir),
        ]
        agent = extra.get("agent")
        provider_name = (model.provider or "").strip().lower()
        if agent == "eliza" or provider_name == "eliza":
            args.extend(["--mode", "eliza"])
        else:
            args.extend(["--mode", "python"])

        if model.model:
            args.extend(["--model", model.model])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])

        coins = extra.get("coins")
        if isinstance(coins, list):
            coin_values = [str(c) for c in coins if str(c).strip()]
            if coin_values:
                args.extend(["--coins", ",".join(coin_values)])
        elif isinstance(coins, str) and coins.strip():
            args.extend(["--coins", coins.strip()])

        max_steps = extra.get("max_steps")
        if isinstance(max_steps, int) and max_steps > 0:
            args.extend(["--max-steps", str(max_steps)])
        max_iterations = extra.get("max_iterations")
        if isinstance(max_iterations, int) and max_iterations > 0:
            args.extend(["--max-iterations", str(max_iterations)])

        builder_code = extra.get("builder_code")
        if isinstance(builder_code, str) and builder_code.strip():
            args.extend(["--builder-code", builder_code.strip()])

        tasks = extra.get("tasks")
        if isinstance(tasks, list) and tasks:
            args.append("--tasks")
            args.extend(str(t) for t in tasks)
        elif extra.get("coverage") is True:
            args.append("--coverage")

        # Network + demo handling. Default behavior is demo=true with testnet.
        network_raw = extra.get("network")
        network = network_raw.strip().lower() if isinstance(network_raw, str) else "testnet"
        if network in {"testnet", "mainnet", "local"}:
            args.extend(["--network", network])

        if extra.get("no_demo") is True or extra.get("demo") is False:
            # Live trading on the chosen network — caller must have HL_PRIVATE_KEY.
            args.append("--no-demo")
        # else: --demo is the default in __main__.py, no flag needed

        return args

    def _hyperliquid_bench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="hyperliquid_bench-*.json")

    def _gauntlet_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for Solana Gauntlet benchmark with ElizaOS agent.

        Defaults to ``agents/eliza_agent.py`` (in-process Python AgentRuntime).
        When the caller asks for the eliza bridge (via ``model.provider == "eliza"``
        or ``extra.agent == "eliza"``), routes through ``agents/eliza_bridge_agent.py``
        which uses the elizaOS TypeScript benchmark bridge instead.
        """
        agent = extra.get("agent")
        provider_name = (model.provider or "").strip().lower()
        if agent == "eliza" or provider_name == "eliza":
            agent_path = repo("benchmarks/gauntlet/agents/eliza_bridge_agent.py")
        else:
            agent_path = repo("benchmarks/gauntlet/agents/eliza_agent.py")

        args = [
            python,
            "-m",
            "gauntlet.cli",
            "run",
            "--agent",
            agent_path,
            "--scenarios",
            repo("benchmarks/gauntlet/scenarios"),
            "--programs",
            repo("benchmarks/gauntlet/programs"),
            "--output",
            str(output_dir),
        ]
        # Default to mock mode unless clone_mainnet is set
        clone_mainnet = extra.get("clone_mainnet")
        if clone_mainnet is True:
            args.append("--clone-mainnet")
        else:
            args.append("--mock")
        seed = extra.get("seed")
        if isinstance(seed, int) and seed > 0:
            args.extend(["--seed", str(seed)])
        return args

    def _gauntlet_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="*.json")

    # ClawBench - OpenClaw agent evaluation via the eliza benchmark bridge
    def _clawbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for ClawBench scenario evaluation through the eliza bridge.

        Routes through ``clawbench/eliza_adapter.py`` which honors the shared
        ``ELIZA_BENCH_URL`` / ``ELIZA_BENCH_TOKEN`` env vars so all eliza-bridge
        benchmarks reuse the same server. Output filename matches
        ``_clawbench_result``'s ``trajectory_*.json`` glob.
        """
        args = [
            python,
            repo("benchmarks/clawbench/eliza_adapter.py"),
            "--output-dir",
            str(output_dir),
        ]
        scenario = extra.get("scenario")
        if isinstance(scenario, str) and scenario.strip():
            args.extend(["--scenario", scenario.strip()])
        else:
            args.extend(["--scenario", "inbox_triage"])
        variant = extra.get("variant")
        if isinstance(variant, str) and variant.strip():
            args.extend(["--variant", variant.strip()])
        if extra.get("start_server") is True:
            args.append("--start-server")
        _ = model
        return args

    def _clawbench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="trajectory_*.json")

    def _score_from_clawbench_json(data: JSONValue) -> ScoreExtraction:
        root = expect_dict(data, ctx="clawbench:root")
        score_data = get_optional(root, "score")
        if isinstance(score_data, dict):
            score_val = expect_float(get_optional(score_data, "score") or 0.0, ctx="clawbench:score")
            passed = get_optional(score_data, "passed") or 0
            total = get_optional(score_data, "total_checks") or get_optional(score_data, "total") or 0
        else:
            score_val = 0.0
            passed = 0
            total = 0
        return ScoreExtraction(
            score=score_val,
            unit="ratio",
            higher_is_better=True,
            metrics={
                "score": score_val,
                "passed": passed,
                "total": total,
            },
        )

    # OpenClaw Benchmark - AI assistant coding tasks
    def _openclaw_bench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for OpenClaw benchmark tasks."""
        args = [
            python,
            repo("benchmarks/openclaw-benchmark/eliza_adapter.py"),
            "--json",
            "--output-dir",
            str(output_dir),
        ]
        mode = extra.get("mode")
        if isinstance(mode, str) and mode.strip() in {"execution", "conceptual"}:
            args.extend(["--mode", mode.strip()])
        else:
            args.extend(["--mode", "conceptual"])
        task = extra.get("task")
        if isinstance(task, str) and task.strip():
            args.extend(["--task", task.strip()])
        elif extra.get("all") is True:
            args.append("--all")
        else:
            args.extend(["--task", "setup"])
        if model.model:
            args.extend(["--model", model.model])
        if extra.get("docker") is True:
            args.append("--docker")
        if extra.get("start_server") is True:
            args.append("--start-server")
        return args

    def _openclaw_bench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="openclaw_*.json")

    def _score_from_openclaw_bench_json(data: JSONValue) -> ScoreExtraction:
        root = expect_dict(data, ctx="openclaw:root")
        overall_raw = get_optional(root, "overall_score")
        if isinstance(overall_raw, (int, float)):
            overall = float(overall_raw)
        else:
            score_obj = get_optional(root, "score")
            if isinstance(score_obj, dict):
                overall = expect_float(get_optional(score_obj, "score") or 0.0, ctx="openclaw:score.score")
            else:
                overall = 0.0
        tasks_completed = get_optional(root, "tasks_completed") or 0
        if not tasks_completed and isinstance(get_optional(root, "score"), dict):
            tasks_completed = 1
        return ScoreExtraction(
            score=overall,
            unit="ratio",
            higher_is_better=True,
            metrics={
                "overall_score": overall,
                "tasks_completed": tasks_completed,
                "mode": get_optional(root, "mode") or root.get("scoring_type") or "",
            },
        )

    # ConfigBench - secrets + plugin-manager security benchmark (Bun runtime)
    def _configbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for ConfigBench (Bun TS).

        ConfigBench instantiates ``@elizaos/core`` in-process when ``--eliza``
        is set, so it does not route through the TS bridge. The ``eliza`` agent
        path requires a provider key (GROQ/OPENAI); other paths are oracle/random.
        """
        args = [
            "bun",
            "run",
            "src/index.ts",
            "--output",
            str(output_dir),
        ]
        agent = extra.get("agent")
        if agent == "eliza" or (model.provider or "").strip().lower() == "eliza":
            args.append("--eliza")
        elif extra.get("eliza") is True:
            args.append("--eliza")
        limit = extra.get("limit")
        if isinstance(limit, int) and limit > 0:
            args.extend(["--limit", str(limit)])
        if extra.get("verbose") is True:
            args.append("--verbose")
        return args

    def _configbench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="configbench-results-*.json")

    # VoiceBench - end-to-end voice latency benchmark (Bun TS via run.sh)
    def _voicebench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for VoiceBench.

        VoiceBench instantiates the elizaOS TS runtime in-process and is wrapped
        by ``run.sh`` which manages provider env defaults, audio fixture
        resolution, and dataset manifest selection. Run from the voicebench
        directory (``cwd_rel`` resolves there).
        """
        args = ["bash", "./run.sh", f"--output-dir={output_dir}"]
        profile_raw = extra.get("profile")
        if isinstance(profile_raw, str) and profile_raw.strip():
            profile = profile_raw.strip().lower()
        else:
            profile = "groq"
        if profile not in {"groq", "elevenlabs"}:
            raise ValueError(f"voicebench: unsupported profile '{profile}' (expected groq or elevenlabs)")
        args.append(f"--profile={profile}")
        iterations = extra.get("iterations")
        if isinstance(iterations, int) and iterations > 0:
            args.append(f"--iterations={iterations}")
        dataset = extra.get("dataset")
        if isinstance(dataset, str) and dataset.strip():
            args.append(f"--dataset={dataset.strip()}")
        _ = model
        return args

    def _voicebench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="voicebench-typescript-*.json")

    # Social-Alpha - trust-marketplace benchmark on real Discord crypto chat data
    def _social_alpha_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for Social-Alpha.

        Routes through the click-based ``benchmark.harness`` CLI installed by
        the ``trust-marketplace-benchmark`` pyproject. Defaults to the bundled
        ``trenches-chat-dataset`` checked into the benchmark dir; callers can
        override via ``data_dir``. Defaults to the ``baseline`` system unless
        another system is requested via ``extra.system`` or ``model.provider``.
        """
        data_dir_raw = extra.get("data_dir")
        if isinstance(data_dir_raw, str) and data_dir_raw.strip():
            data_dir = data_dir_raw.strip()
        else:
            data_dir = "trenches-chat-dataset/data"
        args = [
            python,
            "-m",
            "benchmark.harness",
            "--data-dir",
            data_dir,
            "--output",
            str(output_dir),
        ]
        system_raw = extra.get("system")
        if isinstance(system_raw, str) and system_raw.strip():
            system = system_raw.strip()
        else:
            provider_lower = (model.provider or "").strip().lower()
            if provider_lower in {"eliza-bridge", "eliza-ts"}:
                system = "eliza-bridge"
            elif provider_lower == "eliza":
                system = "eliza"
            else:
                system = "baseline"
        args.extend(["--system", system])
        if model.model:
            args.extend(["--model", model.model])
        api_base = extra.get("api_base")
        if isinstance(api_base, str) and api_base.strip():
            args.extend(["--api-base", api_base.strip()])
        suites = extra.get("suites")
        if isinstance(suites, list):
            for suite in suites:
                if isinstance(suite, str) and suite.strip():
                    args.extend(["--suite", suite.strip()])
        elif isinstance(suites, str) and suites.strip():
            args.extend(["--suite", suites.strip()])
        if extra.get("generate_gt") is True:
            args.append("--generate-gt")
        return args

    def _social_alpha_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="benchmark_results_*.json")

    # WebShop - product-search/purchase benchmark with Eliza agent
    def _webshop_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for WebShop benchmark.

        Defaults to the bundled sample task set and disables trajectory logging
        unless the caller opts in. Provider/model selection is forwarded so the
        in-process ``elizaos`` agent picks up the requested LLM (or the
        ``--mock`` flag bypasses it for smoke tests).
        """
        args = [
            python,
            "-m",
            "elizaos_webshop",
            "--output",
            str(output_dir),
        ]
        provider_lower = (model.provider or "").strip().lower()
        if extra.get("mock") is True or provider_lower == "mock":
            args.append("--mock")
        elif extra.get("bridge") is True or provider_lower in {"eliza", "eliza-bridge", "eliza-ts"}:
            args.append("--bridge")
            if model.model:
                args.extend(["--model", model.model])
        else:
            if model.provider:
                args.extend(["--model-provider", model.provider])
            if model.model:
                args.extend(["--model", model.model])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        max_turns = extra.get("max_turns")
        if isinstance(max_turns, int) and max_turns > 0:
            args.extend(["--max-turns", str(max_turns)])
        trials = extra.get("trials")
        if isinstance(trials, int) and trials > 0:
            args.extend(["--trials", str(trials)])
        if extra.get("hf") is True:
            args.append("--hf")
            split = extra.get("split")
            if isinstance(split, str) and split.strip():
                args.extend(["--split", split.strip()])
        else:
            args.append("--sample")
        if extra.get("trajectories") is True:
            args.append("--trajectories")
        else:
            args.append("--no-trajectories")
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        return args

    def _webshop_result(output_dir: Path) -> Path:
        return output_dir / "webshop-results.json"

    return [
        BenchmarkDefinition(
            id="solana",
            display_name="Solana-Gym",
            description="Solana instruction discovery benchmark (surfpool sandbox)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=("OPENROUTER_API_KEY",),
                paths=("benchmarks/solana/solana-gym-env",),
                notes=(
                    "Requires surfpool running on localhost:8899. "
                    "Set USE_EXTERNAL_SURFPOOL=true. "
                    "Deterministic phase needs no API key; LLM phase requires OPENROUTER_API_KEY."
                ),
            ),
            build_command=_solana_cmd,
            locate_result=_solana_result,
            extract_score=_score_from_solana_json,
        ),
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
            cwd_rel="benchmarks/agentbench",
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
            cwd_rel="benchmarks/terminal-bench",
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
            cwd_rel="benchmarks/gaia",
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
            id="gaia_orchestrated",
            display_name="GAIA (Orchestrated)",
            description="GAIA sample-backed orchestrated benchmark track",
            cwd_rel="benchmarks/gaia",
            requirements=BenchmarkRequirements(
                env_vars=("GROQ_API_KEY",),
                paths=(),
                notes="Uses the GAIA runner with orchestrator profile defaults; safe sample runs avoid gated HF access.",
            ),
            build_command=_gaia_cmd,
            locate_result=_gaia_result,
            extract_score=_score_from_gaia_json,
        ),
        BenchmarkDefinition(
            id="tau_bench",
            display_name="Tau-bench",
            description="Tool-Agent-User Interaction benchmark",
            cwd_rel="benchmarks/tau-bench",
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
            cwd_rel="benchmarks/vending-bench",
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
            id="swe_bench_orchestrated",
            display_name="SWE-bench (Orchestrated)",
            description="SWE-bench with orchestrated/direct-shell provider matrix",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes=(
                    "Runs SWE-bench via orchestrator service or direct_shell provider path. "
                    "Supports capability contracts and full 2x3 control-plane/provider matrix."
                ),
            ),
            build_command=_swe_orchestrated_cmd,
            locate_result=_swe_orchestrated_result,
            extract_score=_score_from_swebench_orchestrated_json,
        ),
        BenchmarkDefinition(
            id="orchestrator_lifecycle",
            display_name="Orchestrator Lifecycle",
            description="Multi-turn orchestration lifecycle scenario benchmark",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/orchestrator_lifecycle/scenarios",),
                notes="Evaluates clarification, check-ins, interruptions, and stakeholder summaries.",
            ),
            build_command=_orchestrator_lifecycle_cmd,
            locate_result=_orchestrator_lifecycle_result,
            extract_score=_score_from_orchestrator_lifecycle_json,
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
        BenchmarkDefinition(
            id="osworld",
            display_name="OSWorld",
            description="Multimodal desktop agent benchmark (369 tasks) - arXiv:2404.07972",
            cwd_rel="benchmarks/OSWorld",
            requirements=BenchmarkRequirements(
                env_vars=("GROQ_API_KEY",),
                paths=(),
                notes=(
                    "Requires VM provider: Docker (with KVM), VMware, or VirtualBox. "
                    "Uses Eliza agent with message_service.handle_message(). "
                    "Set provider_name, path_to_vm (VMware), observation_type, domain, task_id via extra config."
                ),
            ),
            build_command=_osworld_cmd,
            locate_result=_osworld_result,
            extract_score=_score_from_osworld_json,
        ),
        BenchmarkDefinition(
            id="hyperliquid_bench",
            display_name="HyperliquidBench",
            description="Hyperliquid perp trading-plan generation benchmark (Eliza agent + Rust runner/evaluator)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/HyperliquidBench/dataset/domains-hl.yaml",),
                notes=(
                    "Defaults to --mode python (in-process elizaos.AgentRuntime) with --demo "
                    "and --network testnet, so no funds are at risk. "
                    "Set agent=eliza (or model.provider=eliza) to route plan generation through "
                    "the eliza TS benchmark server (eliza_adapter.hyperliquid). "
                    "Live network runs require building the Rust toolchain "
                    "(cd benchmarks/HyperliquidBench && cargo build --release -p hl-runner -p hl-evaluator) "
                    "AND HL_PRIVATE_KEY plus extra.no_demo=true. "
                    "Score: average final_score across scenarios (Base + Bonus − Penalty from hl-evaluator)."
                ),
            ),
            build_command=_hyperliquid_bench_cmd,
            locate_result=_hyperliquid_bench_result,
            extract_score=_score_from_hyperliquid_bench_json,
        ),
        BenchmarkDefinition(
            id="gauntlet",
            display_name="Solana Gauntlet",
            description="Tiered adversarial safety benchmark for Solana AI agents (96 scenarios, 4 levels)",
            cwd_rel="benchmarks/gauntlet",
            requirements=BenchmarkRequirements(
                env_vars=("OPENAI_API_KEY",),
                paths=("benchmarks/gauntlet/scenarios",),
                notes=(
                    "Uses ElizaOS agent with full message pipeline. "
                    "Runs in mock mode by default (no Surfpool needed). "
                    "Set clone_mainnet=true for real program testing (requires surfpool). "
                    "Scores: Task Completion (30%), Safety (40%), Efficiency (20%), Capital (10%)."
                ),
            ),
            build_command=_gauntlet_cmd,
            locate_result=_gauntlet_result,
            extract_score=_score_from_gauntlet_json,
        ),
        BenchmarkDefinition(
            id="clawbench",
            display_name="ClawBench",
            description="Deterministic scenario-based evaluation for OpenClaw agents (5 scenarios)",
            cwd_rel="benchmarks/clawbench",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/clawbench/scenarios",),
                notes=(
                    "Tests tool-use decisions with fixtures (email, calendar, tasks, Slack). "
                    "Scenarios: inbox_triage, client_escalation, morning_brief, inbox_to_action, team_standup. "
                    "Scoring: safety, correctness, efficiency, structure. No LLM judge needed."
                ),
            ),
            build_command=_clawbench_cmd,
            locate_result=_clawbench_result,
            extract_score=_score_from_clawbench_json,
        ),
        BenchmarkDefinition(
            id="openclaw_bench",
            display_name="OpenClaw-Bench",
            description="AI coding assistant benchmark (setup, implementation, refactoring, testing)",
            cwd_rel="benchmarks/openclaw-benchmark",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/openclaw-benchmark/benchmark",),
                notes=(
                    "Standard tasks for AI assistants: setup (env init), implementation (weather CLI), "
                    "refactoring (modular architecture), testing (unit + integration tests). "
                    "Set task=X or all=true. Docker containers use benchmark/* naming."
                ),
            ),
            build_command=_openclaw_bench_cmd,
            locate_result=_openclaw_bench_result,
            extract_score=_score_from_openclaw_bench_json,
        ),
        BenchmarkDefinition(
            id="configbench",
            display_name="ConfigBench",
            description="Plugin configuration & secrets security benchmark (50 scripted scenarios)",
            cwd_rel="benchmarks/configbench",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/configbench/src",),
                notes=(
                    "Bun runtime. Default run uses oracle/random/failing handlers (no LLM). "
                    "Set agent=eliza (or model.provider=eliza) for the LLM handler — that path "
                    "instantiates @elizaos/core in-process and needs GROQ_API_KEY or OPENAI_API_KEY."
                ),
            ),
            build_command=_configbench_cmd,
            locate_result=_configbench_result,
            extract_score=_score_from_configbench_json,
        ),
        BenchmarkDefinition(
            id="voicebench",
            display_name="VoiceBench",
            description="End-to-end voice latency benchmark (transcription + response + TTS)",
            cwd_rel="benchmarks/voicebench",
            requirements=BenchmarkRequirements(
                env_vars=("GROQ_API_KEY",),
                paths=("benchmarks/voicebench/run.sh", "benchmarks/voicebench/typescript/src/bench.ts"),
                notes=(
                    "Bun runtime via run.sh. Profiles: groq (default), elevenlabs (additionally needs "
                    "ELEVENLABS_API_KEY). Audio fixture resolved from VOICEBENCH_AUDIO_PATH or repo defaults. "
                    "Reports avg/p95/p99 end-to-end latency; lower is better."
                ),
            ),
            build_command=_voicebench_cmd,
            locate_result=_voicebench_result,
            extract_score=_score_from_voicebench_json,
        ),
        BenchmarkDefinition(
            id="social_alpha",
            display_name="Social-Alpha",
            description="Trust marketplace benchmark on real Discord crypto-chat data (EXTRACT/RANK/DETECT/PROFIT)",
            cwd_rel="benchmarks/social-alpha",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/social-alpha/trenches-chat-dataset",),
                notes=(
                    "Defaults to the rule-based BaselineSystem (no LLM). Set system=eliza|full|smart|oracle "
                    "via extra to swap implementations; eliza/full additionally need provider keys. "
                    "Score: composite Trust Marketplace Score (0..1)."
                ),
            ),
            build_command=_social_alpha_cmd,
            locate_result=_social_alpha_result,
            extract_score=_score_from_social_alpha_json,
        ),
        BenchmarkDefinition(
            id="webshop",
            display_name="WebShop",
            description="WebShop product-search/purchase benchmark with Eliza agent",
            cwd_rel="benchmarks/webshop",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/webshop/elizaos_webshop",),
                notes=(
                    "Defaults to bundled sample tasks (--sample). Set hf=true to load from HuggingFace. "
                    "Real-LLM mode is the default and needs a provider key (GROQ/OPENAI/etc.); "
                    "set mock=true for a deterministic smoke run. Score: success_rate."
                ),
            ),
            build_command=_webshop_cmd,
            locate_result=_webshop_result,
            extract_score=_score_from_webshop_json,
        ),
    ]


def load_benchmark_result_json(path: Path) -> JSONValue:
    return load_json_file(path)
