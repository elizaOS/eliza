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
    total_tests = get_optional(metrics, "total_tests") or 0
    error_analysis = get_optional(metrics, "error_analysis")
    if total_tests == 0:
        no_ground_truth = 0
        if isinstance(error_analysis, dict):
            raw_no_gt = error_analysis.get("no_ground_truth")
            if isinstance(raw_no_gt, (int, float)):
                no_ground_truth = int(raw_no_gt)
        detail = f" (no_ground_truth={no_ground_truth})" if no_ground_truth else ""
        raise ValueError(
            "bfcl: result produced no evaluable ground-truth tests"
            f"{detail}; refusing to publish a zero-task score"
        )

    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": overall,
            "ast_accuracy": get_optional(metrics, "ast_accuracy") or 0,
            "exec_accuracy": get_optional(metrics, "exec_accuracy") or 0,
            "relevance_accuracy": get_optional(metrics, "relevance_accuracy") or 0,
            "total_tests": total_tests,
            "error_analysis": error_analysis or {},
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
    results_raw = root.get("results")

    def to_float(value: object) -> float:
        if isinstance(value, bool):
            return 0.0
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            cleaned = value.strip().replace("$", "").replace(",", "")
            if cleaned.endswith("%"):
                cleaned = cleaned[:-1]
            try:
                return float(cleaned)
            except ValueError:
                return 0.0
        return 0.0

    results = expect_list(results_raw, ctx="vending_bench:results") if isinstance(results_raw, list) else []
    total_revenue = 0.0
    total_incremental_revenue = 0.0
    has_incremental_revenue = False
    total_profit = 0.0
    total_items_sold = 0.0
    total_orders = 0.0
    for item in results:
        if not isinstance(item, dict):
            continue
        total_revenue += to_float(item.get("total_revenue"))
        if item.get("incremental_revenue") is not None:
            total_incremental_revenue += to_float(item.get("incremental_revenue"))
            has_incremental_revenue = True
        total_profit += to_float(item.get("profit"))
        total_items_sold += to_float(item.get("items_sold"))
        total_orders += to_float(item.get("orders_placed"))

    run_count = len([item for item in results if isinstance(item, dict)])
    avg_revenue = (total_revenue / run_count) if run_count else to_float(metrics.get("avg_revenue"))
    avg_incremental_revenue = (
        (total_incremental_revenue / run_count)
        if run_count and has_incremental_revenue
        else to_float(metrics.get("avg_incremental_revenue"))
    )
    score = avg_incremental_revenue if has_incremental_revenue or metrics.get("avg_incremental_revenue") is not None else avg_revenue
    avg_profit = (total_profit / run_count) if run_count else to_float(metrics.get("avg_profit"))
    max_net_worth = to_float(metrics.get("max_net_worth"))
    return ScoreExtraction(
        score=score,
        unit="usd_incremental_revenue_per_run" if has_incremental_revenue or metrics.get("avg_incremental_revenue") is not None else "usd_revenue_per_run",
        higher_is_better=True,
        metrics={
            "primary_score_note": "Average incremental revenue over the same no-op/starter-inventory baseline when available; gross revenue and net worth are secondary metrics.",
            "avg_revenue": avg_revenue,
            "total_revenue": total_revenue,
            "avg_incremental_revenue": avg_incremental_revenue,
            "total_incremental_revenue": total_incremental_revenue,
            "avg_starter_baseline_revenue": to_float(metrics.get("avg_starter_baseline_revenue")),
            "avg_profit": avg_profit,
            "max_net_worth": max_net_worth,
            "avg_net_worth": metrics.get("avg_net_worth") or "0",
            "profitability_rate": metrics.get("profitability_rate") or 0,
            "coherence_score": metrics.get("coherence_score") or 0,
            "avg_items_sold": (total_items_sold / run_count) if run_count else (metrics.get("avg_items_sold") or 0),
            "avg_orders_placed": (total_orders / run_count) if run_count else (metrics.get("avg_orders_placed") or 0),
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


def _score_from_visualwebbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="visualwebbench:root")
    overall = expect_float(
        get_required(root, "overall_accuracy", ctx="visualwebbench:root"),
        ctx="visualwebbench:overall_accuracy",
    )
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "exact_accuracy": get_optional(root, "exact_accuracy") or 0,
            "choice_accuracy": get_optional(root, "choice_accuracy") or 0,
            "bbox_accuracy": get_optional(root, "bbox_accuracy") or 0,
            "total_tasks": get_optional(root, "total_tasks") or 0,
            "average_latency_ms": get_optional(root, "average_latency_ms") or 0,
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
    final_reward_raw = get_optional(root, "final_reward")
    if final_reward_raw is None:
        cumulative = get_optional(root, "cumulative_rewards")
        if isinstance(cumulative, list) and cumulative:
            final_reward_raw = cumulative[-1]
    final_reward = expect_float(final_reward_raw, ctx="solana:final_reward")
    final_programs = root.get("final_programs")
    if final_programs is None and isinstance(root.get("programs_discovered"), dict):
        final_programs = len(root["programs_discovered"])
    return ScoreExtraction(
        score=final_reward,
        unit="unique_instructions",
        higher_is_better=True,
        metrics={
            "final_reward": final_reward,
            "final_programs": final_programs or 0,
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

    ConfigBench benchmark-matrix rows are only valid for the real Eliza
    handler. Do not fall back to the Perfect oracle row; that makes unsupported
    Hermes/OpenClaw runs look like successful agent comparisons.
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
    if target is None:
        raise ValueError("configbench: no Eliza handler entry found")
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


def _score_from_trust_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from the trust/security benchmark results."""
    root = expect_dict(data, ctx="trust:root")
    overall = expect_float(
        get_required(root, "overall_f1", ctx="trust:root"),
        ctx="trust:overall_f1",
    )
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_f1": overall,
            "false_positive_rate": get_optional(root, "false_positive_rate") or 0,
            "total_tests": get_optional(root, "total_tests") or 0,
            "handler_name": get_optional(root, "handler_name") or "",
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


def _score_from_woobench_json(data: JSONValue) -> ScoreExtraction:
    """Extract normalized WooBench score from its aggregate result JSON."""
    root = expect_dict(data, ctx="woobench:root")
    overall = expect_float(
        get_required(root, "overall_score", ctx="woobench:root"),
        ctx="woobench:overall_score",
    )
    scenarios_raw = get_optional(root, "scenarios")
    scenarios = scenarios_raw if isinstance(scenarios_raw, list) else []
    converted = 0
    completed = 0
    scenario_revenue = 0.0
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        if scenario.get("payment_converted") is True:
            converted += 1
        if scenario.get("agent_responsive") is True:
            completed += 1
        revenue_obj = scenario.get("revenue")
        if isinstance(revenue_obj, dict):
            amount = revenue_obj.get("total_paid") or revenue_obj.get("amount") or 0
        else:
            amount = revenue_obj if isinstance(revenue_obj, (int, float)) else 0
        try:
            scenario_revenue += float(amount)
        except (TypeError, ValueError):
            pass
    total_revenue = get_optional(root, "total_revenue")
    if not isinstance(total_revenue, (int, float)):
        total_revenue = scenario_revenue
    scenario_count = len(scenarios)
    return ScoreExtraction(
        score=overall / 100.0,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": overall,
            "revenue_efficiency": get_optional(root, "revenue_efficiency") or 0,
            "resilience_score": get_optional(root, "resilience_score") or 0,
            "failed_scenarios": get_optional(root, "failed_scenarios") or 0,
            "total_revenue": float(total_revenue),
            "scenario_count": scenario_count,
            "payment_converted_count": converted,
            "completed_reading_count": completed,
            "avg_revenue_per_scenario": (
                float(total_revenue) / scenario_count if scenario_count else 0.0
            ),
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


def _score_from_scambench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="scambench:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="scambench:root"), ctx="scambench:metrics")
    score = expect_float(get_required(metrics, "score", ctx="scambench:metrics"), ctx="scambench:metrics.score")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "scam_refuse_rate": metrics.get("scam_refuse_rate") or 0,
            "legit_help_rate": metrics.get("legit_help_rate") or 0,
            "n_scam": metrics.get("n_scam") or 0,
            "n_legit": metrics.get("n_legit") or 0,
            "n": metrics.get("n") or (
                (metrics.get("n_scam") or 0) + (metrics.get("n_legit") or 0)
            ),
            "processed_records": metrics.get("processed_records") or 0,
            "interrupted": root.get("interrupted") is True,
        },
    )


def _score_from_abliteration_robustness_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="abliteration_robustness:root")
    metrics = expect_dict(
        get_required(root, "metrics", ctx="abliteration_robustness:root"),
        ctx="abliteration_robustness:metrics",
    )
    score = expect_float(
        get_required(metrics, "score", ctx="abliteration_robustness:metrics"),
        ctx="abliteration_robustness:metrics.score",
    )
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "refusal_rate": metrics.get("refusal_rate") or 0,
            "n": metrics.get("n") or 0,
            "n_refused": metrics.get("n_refused") or 0,
        },
    )


def _score_from_lifeops_bench_json(data: JSONValue) -> ScoreExtraction:
    """Extract LifeOpsBench score from its aggregate result JSON.

    The runner writes one JSON per ``__main__`` invocation containing
    ``pass_at_1`` (headline), ``pass_at_k`` (multi-seed pass rate),
    plus per-domain mean scores and the agent/eval cost split.
    Higher is better; unit is ratio.
    """
    root = expect_dict(data, ctx="lifeops_bench:root")
    pass_at_1 = expect_float(
        get_required(root, "pass_at_1", ctx="lifeops_bench:root"),
        ctx="lifeops_bench:pass_at_1",
    )
    return ScoreExtraction(
        score=pass_at_1,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "pass_at_1": pass_at_1,
            "pass_at_k": get_optional(root, "pass_at_k") or 0,
            "seeds": get_optional(root, "seeds") or 0,
            "total_cost_usd": get_optional(root, "total_cost_usd") or 0,
            "agent_cost_usd": get_optional(root, "agent_cost_usd") or 0,
            "eval_cost_usd": get_optional(root, "eval_cost_usd") or 0,
            "total_latency_ms": get_optional(root, "total_latency_ms") or 0,
            "model_name": get_optional(root, "model_name") or "",
            "judge_model_name": get_optional(root, "judge_model_name") or "",
        },
    )


def _score_from_mmau_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="mmau:root")
    metrics_obj = get_optional(root, "metrics")
    metrics = expect_dict(metrics_obj, ctx="mmau:metrics") if isinstance(metrics_obj, dict) else root
    overall = expect_float(
        get_required(metrics, "overall_accuracy", ctx="mmau:metrics"),
        ctx="mmau:overall_accuracy",
    )
    total_samples_raw = get_optional(metrics, "total_samples")
    if not isinstance(total_samples_raw, (int, float)) or isinstance(total_samples_raw, bool) or total_samples_raw <= 0:
        raise ValueError("mmau: result contains no evaluated samples")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "speech_accuracy": get_optional(metrics, "speech_accuracy") or 0,
            "sound_accuracy": get_optional(metrics, "sound_accuracy") or 0,
            "music_accuracy": get_optional(metrics, "music_accuracy") or 0,
            "total_samples": total_samples_raw,
            "error_count": get_optional(metrics, "error_count") or 0,
        },
    )


def _score_from_voicebench_quality_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="voicebench_quality:root")
    score = expect_float(
        get_required(root, "score", ctx="voicebench_quality:root"),
        ctx="voicebench_quality:score",
    )
    n_raw = get_optional(root, "n")
    if not isinstance(n_raw, (int, float)) or isinstance(n_raw, bool) or n_raw <= 0:
        raise ValueError("voicebench_quality: result contains no evaluated samples")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "n": n_raw,
            "per_suite": get_optional(root, "per_suite") or {},
            "suites_run": get_optional(root, "suites_run") or [],
            "elapsed_s": get_optional(root, "elapsed_s") or 0,
            "judge_model": get_optional(root, "judge_model") or "",
            "stt_provider": get_optional(root, "stt_provider") or "",
        },
    )


def _score_from_voiceagentbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="voiceagentbench:root")
    pass_at_1 = expect_float(
        get_required(root, "pass_at_1", ctx="voiceagentbench:root"),
        ctx="voiceagentbench:pass_at_1",
    )
    tasks = get_optional(root, "tasks")
    tasks_run = len(tasks) if isinstance(tasks, list) else 0
    if tasks_run <= 0:
        raise ValueError("voiceagentbench: result contains no task trajectories")
    return ScoreExtraction(
        score=pass_at_1,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "pass_at_1": pass_at_1,
            "pass_at_k": get_optional(root, "pass_at_k") or {},
            "per_suite_pass_at_1": get_optional(root, "per_suite_pass_at_1") or {},
            "mean_tool_selection": get_optional(root, "mean_tool_selection") or 0,
            "mean_parameter_match": get_optional(root, "mean_parameter_match") or 0,
            "mean_coherence": get_optional(root, "mean_coherence") or 0,
            "mean_safety": get_optional(root, "mean_safety") or 0,
            "tasks_run": tasks_run,
            "seeds": get_optional(root, "seeds") or 0,
            "total_latency_ms": get_optional(root, "total_latency_ms") or 0,
            "judge_model_name": get_optional(root, "judge_model_name") or "",
        },
    )


def _score_from_action_calling_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="action_calling:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="action_calling:root"), ctx="action_calling:metrics")
    score = expect_float(get_required(metrics, "score", ctx="action_calling:metrics"), ctx="action_calling:metrics.score")
    generation_source = root.get("generation_source")
    n = root.get("n") or 0
    if not isinstance(n, int) or n <= 0:
        raise ValueError("action_calling:n must be positive")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "native_tool_calls_ok": metrics.get("native_tool_calls_ok") or 0,
            "tool_name_match": metrics.get("tool_name_match") or 0,
            "args_parse_ok": metrics.get("args_parse_ok") or 0,
            "required_keys_ok": metrics.get("required_keys_ok") or 0,
            "arguments_match": metrics.get("arguments_match") or 0,
            "n": n,
            "generation_source": generation_source or "",
        },
    )


def _score_from_eliza_format_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="eliza_format:root")
    metrics_obj = get_optional(root, "metrics")
    metrics = expect_dict(metrics_obj, ctx="eliza_format:metrics") if isinstance(metrics_obj, dict) else root
    score_raw = get_optional(metrics, "score")
    if score_raw is None:
        score_raw = get_optional(root, "score")
    score = expect_float(score_raw, ctx="eliza_format:score")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "format_ok": metrics.get("format_ok") or 0,
            "content_ok": metrics.get("content_ok") or 0,
            "examples": metrics.get("examples") or metrics.get("n") or 0,
        },
    )


def _standard_benchmark_metrics(
    metrics: dict[str, JSONValue],
    *,
    extra_keys: tuple[str, ...] = (),
) -> dict[str, JSONValue]:
    """Shared shape: pull ``score`` + ``n`` plus any extra known keys.

    Adapters under ``benchmarks/standard/`` all emit a ``metrics`` dict
    matching this contract; collapse to one helper instead of repeating
    five-line dict literals per benchmark.
    """

    out: dict[str, JSONValue] = {
        "score": metrics.get("score") or 0,
        "n": metrics.get("n") or 0,
    }
    for key in extra_keys:
        if key in metrics:
            out[key] = metrics[key] or 0
    return out


def _score_from_mmlu_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="mmlu:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="mmlu:root"), ctx="mmlu:metrics")
    score = expect_float(get_required(metrics, "score", ctx="mmlu:metrics"), ctx="mmlu:score")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics=_standard_benchmark_metrics(metrics, extra_keys=("accuracy", "correct")),
    )


def _score_from_humaneval_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="humaneval:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="humaneval:root"), ctx="humaneval:metrics")
    score = expect_float(get_required(metrics, "score", ctx="humaneval:metrics"), ctx="humaneval:score")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics=_standard_benchmark_metrics(metrics, extra_keys=("pass@1", "passed")),
    )


def _score_from_gsm8k_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="gsm8k:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="gsm8k:root"), ctx="gsm8k:metrics")
    score = expect_float(get_required(metrics, "score", ctx="gsm8k:metrics"), ctx="gsm8k:score")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics=_standard_benchmark_metrics(
            metrics,
            extra_keys=("accuracy", "format_ok", "correct"),
        ),
    )


def _score_from_mt_bench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="mt_bench:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="mt_bench:root"), ctx="mt_bench:metrics")
    score = expect_float(get_required(metrics, "score", ctx="mt_bench:metrics"), ctx="mt_bench:score")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics=_standard_benchmark_metrics(
            metrics,
            extra_keys=("mean_rating", "turn_1_mean", "turn_2_mean"),
        ),
    )


def _score_from_trajectory_replay_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="trajectory_replay:root")
    metrics = expect_dict(
        get_required(root, "metrics", ctx="trajectory_replay:root"),
        ctx="trajectory_replay:metrics",
    )
    score = expect_float(
        get_required(metrics, "score", ctx="trajectory_replay:metrics"),
        ctx="trajectory_replay:score",
    )
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics=_standard_benchmark_metrics(
            metrics,
            extra_keys=(
                "action_sequence_match_rate",
                "final_state_pass_rate",
                "reward_threshold",
                "n_stages",
            ),
        ),
    )


def get_benchmark_registry(repo_root: Path) -> list[BenchmarkDefinition]:
    python = sys.executable

    def repo(path: str) -> str:
        return str((repo_root / path).resolve())

    def _bfcl_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.bfcl", "run", "--output", str(output_dir)]
        provider_name = (model.provider or "").strip().lower()
        agent = str(extra.get("agent") or extra.get("harness") or "").strip().lower()
        # Route LLM-backed providers through the eliza TS bridge so the
        # ElizaBFCLAgent + registered runtime is exercised.
        bridge_providers = {"cerebras", "openai", "groq", "openrouter", "vllm", "eliza"}
        if agent in {"hermes", "openclaw"}:
            args.extend(["--provider", agent])
            if model.model:
                args.extend(["--model", model.model])
        elif agent == "eliza" or provider_name in bridge_providers:
            args.extend(["--provider", "eliza"])
            if model.model:
                args.extend(["--model", model.model])
        else:
            if model.provider:
                args.extend(["--provider", model.provider])
            if model.model:
                model_name = model.model
                if provider_name == "groq" and not model_name.startswith("groq/"):
                    model_name = f"groq/{model_name}"
                args.extend(["--model", model_name])
        if extra.get("mock") is True or provider_name == "mock":
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
        # The orchestrator scores BFCL from the generated bfcl_results_*.json.
        # Do not forward no_report here: it suppresses the result file and
        # turns a valid run into an unscoreable harness failure.
        if extra.get("no_exec") is True:
            args.append("--no-exec")
        return args

    def _bfcl_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="bfcl_results_*.json")

    def _realm_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.realm.cli", "--output", str(output_dir)]
        data_path = extra.get("data_path")
        if isinstance(data_path, str) and data_path.strip():
            args.extend(["--data-path", data_path.strip()])
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
        provider_name = (model.provider or "").strip().lower()
        if extra.get("mock") is True or provider_name == "mock":
            args.append("--mock")
        # Route the planning loop through the TS benchmark server when the
        # caller asks for the eliza agent or any LLM-backed provider.
        agent = extra.get("agent")
        if agent == "eliza" or provider_name in {
            "eliza",
            "cerebras",
            "openai",
            "groq",
            "openrouter",
            "vllm",
        }:
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
        # asks for the eliza agent; otherwise forward real provider/model labels
        # to the direct OpenAI-compatible runtime instead of silently using mock.
        agent = str(extra.get("agent") or extra.get("harness") or "").strip().lower()
        provider_name = (model.provider or "").strip().lower()
        if agent in {"eliza", "hermes", "openclaw"} or provider_name == "eliza":
            args.extend(["--provider", "eliza"])
        elif provider_name in {"mock", ""}:
            args.extend(["--provider", "mock"])
        elif provider_name in {"openai", "groq", "openrouter", "cerebras"}:
            args.extend(["--provider", provider_name])
            if model.model:
                args.extend(["--model", model.model])
            base_url = extra.get("base_url")
            if isinstance(base_url, str) and base_url.strip():
                args.extend(["--base-url", base_url.strip()])
        elif model.provider:
            raise ValueError(f"mint: unsupported provider '{model.provider}'")
        if extra.get("no_ablation") is True:
            args.append("--no-ablation")
        if extra.get("no_tools") is True:
            args.append("--no-tools")
        if extra.get("no_feedback") is True:
            args.append("--no-feedback")
        if extra.get("no_docker") is True:
            args.append("--no-docker")
        if extra.get("no_report") is True:
            args.append("--no-report")
        max_turns = extra.get("max_turns")
        if isinstance(max_turns, int) and max_turns > 0:
            args.extend(["--max-turns", str(max_turns)])
        timeout = extra.get("timeout")
        if isinstance(timeout, int) and timeout > 0:
            args.extend(["--timeout", str(timeout)])
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
            for env in mapped_envs:
                args.extend(["--env", env])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        if extra.get("no_docker") is True:
            args.append("--no-docker")
        # Agent runtime selection
        agent = extra.get("agent")
        if agent == "eliza" or extra.get("elizaos") is True:
            args.extend(["--runtime", "bridge"])
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
            # Route all OpenAI-compatible LLM providers (including cerebras)
            # through the eliza TS bridge instead of falling back to mock.
            provider_map: dict[str, str] = {
                "openai": "eliza",
                "groq": "eliza",
                "openrouter": "eliza",
                "vllm": "eliza",
                "cerebras": "eliza",
                "eliza": "eliza",
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
        context_lengths = extra.get("context_lengths")
        if isinstance(context_lengths, list) and all(isinstance(x, int) for x in context_lengths):
            args.extend(["--context-lengths", ",".join(str(x) for x in cast(list[int], context_lengths))])
        elif isinstance(context_lengths, str) and context_lengths.strip():
            args.extend(["--context-lengths", context_lengths.strip()])
        positions = extra.get("positions")
        if isinstance(positions, list) and all(isinstance(x, str) for x in positions):
            args.extend(["--positions", ",".join(cast(list[str], positions))])
        elif isinstance(positions, str) and positions.strip():
            args.extend(["--positions", positions.strip()])
        tasks_per_position = extra.get("tasks_per_position")
        if isinstance(tasks_per_position, int) and tasks_per_position > 0:
            args.extend(["--tasks-per-position", str(tasks_per_position)])
        _ = model
        return args

    def _contextbench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="context_bench_*.json")

    def _terminalbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        # Run module from its python project root.
        args = [
            python,
            "-m",
            "elizaos_terminal_bench.cli",
            "--output-dir",
            str(output_dir),
        ]
        provider_name = (model.provider or "").strip().lower()
        agent = extra.get("agent")
        # LLM-backed providers route through the eliza TS bridge so the
        # registered eliza agent + plugins are exercised. Hermes/OpenClaw also
        # use that Python bridge surface, but their delegate clients must keep
        # the real provider/model from the orchestrator environment.
        bridge_providers = {"cerebras", "openai", "groq", "openrouter", "vllm", "eliza"}
        if agent in {"eliza", "hermes", "openclaw"}:
            if model.model:
                args.extend(["--model", model.model])
            if agent == "eliza":
                args.extend(["--model-provider", "eliza"])
        elif provider_name in bridge_providers:
            if model.model:
                args.extend(["--model", model.model])
            args.extend(["--model-provider", "eliza"])
        else:
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
        timeout = extra.get("timeout")
        if isinstance(timeout, int) and timeout > 0:
            args.extend(["--timeout", str(timeout)])
        sample = extra.get("sample")
        if sample is True:
            args.append("--sample")
        if extra.get("dry_run") is True or extra.get("no_docker") is True:
            args.append("--dry-run")
        if extra.get("oracle") is True:
            args.append("--oracle")
        if extra.get("no_markdown") is True:
            args.append("--no-markdown")
        if extra.get("no_sessions") is True:
            args.append("--no-sessions")
        if extra.get("no_leaderboard") is True:
            args.append("--no-leaderboard")
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
        provider_name = (model.provider or "").strip().lower()
        agent = extra.get("agent")
        # Route LLM-backed providers through the eliza TS bridge.
        bridge_providers = {
            "cerebras",
            "openai",
            "groq",
            "openrouter",
            "vllm",
            "eliza",
            "mock",
        }
        if agent == "eliza" or provider_name in bridge_providers:
            args.extend(["--provider", "eliza"])
        elif model.provider:
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

    def _gaia_orchestrated_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            "-m",
            "elizaos_gaia.orchestrated",
            "--output",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        dataset = extra.get("dataset")
        if isinstance(dataset, str) and dataset in {"gaia", "sample", "jsonl"}:
            args.extend(["--dataset", dataset])
        elif not os.getenv("HF_TOKEN"):
            args.extend(["--dataset", "sample"])
        dataset_path = extra.get("dataset_path")
        if isinstance(dataset_path, str) and dataset_path.strip():
            args.extend(["--dataset-path", dataset_path.strip()])
        max_q = extra.get("max_questions")
        if isinstance(max_q, int) and max_q > 0:
            args.extend(["--max-questions", str(max_q)])
        else:
            args.extend(["--max-questions", "3"])
        execution_mode = extra.get("execution_mode")
        if isinstance(execution_mode, str) and execution_mode.strip():
            args.extend(["--execution-mode", execution_mode.strip()])
        providers = extra.get("providers")
        if isinstance(providers, list):
            provider_values = [str(p) for p in providers if str(p).strip()]
            if provider_values:
                args.extend(["--providers", *provider_values])
        if extra.get("matrix") is True:
            args.append("--matrix")
        required_caps = extra.get("required_capabilities")
        if isinstance(required_caps, list) and required_caps:
            args.extend(["--required-capabilities", ",".join(str(c) for c in required_caps)])
        elif isinstance(required_caps, str) and required_caps.strip():
            args.extend(["--required-capabilities", required_caps.strip()])
        if extra.get("strict_capabilities") is True:
            args.append("--strict-capabilities")
        return args

    def _gaia_orchestrated_result(output_dir: Path) -> Path:
        return output_dir / "gaia-orchestrated-latest.json"

    def _tau_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            "-m",
            "elizaos_tau_bench.cli",
            "--output",
            str(output_dir),
        ]
        agent = extra.get("agent")
        provider_name = (model.provider or "").strip().lower()
        # LLM-backed providers route through the eliza TS bridge so the
        # registered eliza agent is exercised, not python mock.
        if agent == "eliza" or provider_name in {
            "cerebras",
            "openai",
            "groq",
            "openrouter",
            "vllm",
            "eliza",
        }:
            args.extend(["--real-llm", "--model-provider", "eliza"])
        else:
            real = extra.get("real_llm")
            mock = extra.get("mock")
            mock_mode = not (real is True or mock is False)
            if mock_mode:
                args.append("--mock")
            else:
                args.append("--real-llm")
            if not mock_mode and model.provider:
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
        provider_name = (model.provider or "").strip().lower()
        agent = str(extra.get("agent") or extra.get("harness") or "").strip().lower()
        if agent in {"eliza", "hermes", "openclaw"} or provider_name == "cerebras":
            args.extend(["--provider", "eliza"])
        elif model.provider in {"openai", "anthropic", "groq", "heuristic", "eliza", "vllm"}:
            args.extend(["--provider", model.provider])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        runs = extra.get("runs")
        if not isinstance(runs, int):
            runs = extra.get("num_runs")
        if isinstance(runs, int) and runs > 0:
            args.extend(["--runs", str(runs)])
        elif extra.get("max_tasks") == 1:
            args.extend(["--runs", "1"])
        days = extra.get("days")
        if not isinstance(days, int):
            days = extra.get("max_days_per_run")
        effective_days = 3
        if isinstance(days, int) and days > 0:
            effective_days = max(3, days)
            args.extend(["--days", str(effective_days)])
        elif extra.get("max_tasks") == 1:
            effective_days = 3
            args.extend(["--days", "3"])
        else:
            effective_days = 3
            args.extend(["--days", "3"])
        starter_inventory = extra.get("starter_inventory")
        if starter_inventory is True or (
            starter_inventory is not False and effective_days <= 3
        ):
            args.append("--starter-inventory")
        max_actions_per_day = extra.get("max_actions_per_day")
        if not isinstance(max_actions_per_day, int):
            max_actions_per_day = extra.get("max_actions")
        if isinstance(max_actions_per_day, int) and max_actions_per_day > 0:
            args.extend(["--max-actions-per-day", str(max_actions_per_day)])
        elif effective_days <= 3:
            args.extend(["--max-actions-per-day", "6"])
        seed = extra.get("seed")
        if not isinstance(seed, int):
            seed = extra.get("random_seed")
        if isinstance(seed, int):
            args.extend(["--seed", str(seed)])
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
        provider_lower = (model.provider or "").strip().lower()
        if extra.get("mock") is True or provider_lower == "mock":
            args.append("--mock")
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
        provider_lower = (model.provider or "").strip().lower()
        if extra.get("mock") is True or provider_lower == "mock":
            args.append("--mock")

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
        # Default to bridge mode (real eliza TS agent) for any LLM-backed
        # provider; explicit `--extra '{"mode":"simulate"}'` opts into the
        # deterministic simulator for offline smoke-testing only.
        provider_name = (model.provider or "").strip().lower()
        mode_override = extra.get("mode")
        if isinstance(mode_override, str) and mode_override.strip() in {
            "bridge",
            "simulate",
        }:
            args.extend(["--mode", mode_override.strip()])
        elif provider_name in {"cerebras", "openai", "groq", "openrouter", "vllm", "anthropic", "google", "eliza"}:
            args.extend(["--mode", "bridge"])
        else:
            args.extend(["--mode", "simulate"])
        return args

    def _orchestrator_lifecycle_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="orchestrator-lifecycle-*.json")

    def _mind2web_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [python, "-m", "benchmarks.mind2web", "--output", str(output_dir)]
        agent = extra.get("agent")
        provider_name = (model.provider or "").strip().lower()
        # Route LLM-backed providers through the eliza TS bridge so the actual
        # registered eliza agent + plugins are exercised, not the python mock.
        if agent == "eliza" or provider_name in {
            "cerebras",
            "openai",
            "groq",
            "openrouter",
            "vllm",
            "eliza",
        }:
            args.extend(["--real-llm", "--provider", "eliza"])
            if model.model:
                args.extend(["--model", model.model])
        else:
            if model.provider and provider_name != "mock":
                args.extend(["--provider", model.provider])
            real_llm = extra.get("real_llm")
            if real_llm is True:
                args.append("--real-llm")
            if model.model:
                if provider_name == "groq":
                    args.extend(["--groq-small-model", model.model])
                    args.extend(["--groq-large-model", model.model])
                else:
                    args.extend(["--model", model.model])
        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        max_steps = extra.get("max_steps")
        if isinstance(max_steps, int) and max_steps > 0:
            args.extend(["--max-steps", str(max_steps)])
        sample = extra.get("sample")
        if sample is True:
            args.append("--sample")
        mock = extra.get("mock")
        provider_name = (model.provider or "").strip().lower()
        if mock is True or provider_name == "mock":
            args.append("--mock")
        return args

    def _mind2web_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="mind2web-results*.json")

    def _visualwebbench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            "-m",
            "benchmarks.visualwebbench",
            "--output",
            str(output_dir),
        ]
        agent = extra.get("agent")
        provider_name = (model.provider or "").strip().lower()
        if agent == "eliza" or provider_name in {
            "cerebras",
            "openai",
            "groq",
            "openrouter",
            "vllm",
            "eliza",
        }:
            args.extend(["--provider", "eliza"])
            if model.model:
                args.extend(["--model", model.model])
        else:
            args.append("--dry-run")

        if model.temperature is not None:
            args.extend(["--temperature", str(model.temperature)])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        task_types = extra.get("task_types")
        if isinstance(task_types, list) and all(isinstance(x, str) for x in task_types):
            args.extend(["--task-types", ",".join(cast(list[str], task_types))])
        elif isinstance(task_types, str) and task_types.strip():
            args.extend(["--task-types", task_types.strip()])
        fixture_path = extra.get("fixture_path")
        if isinstance(fixture_path, str) and fixture_path.strip():
            args.extend(["--fixture", "--fixture-path", fixture_path.strip()])
        elif extra.get("hf") is True:
            args.append("--hf")
        else:
            args.append("--fixture")
        hf_repo = extra.get("hf_repo")
        if isinstance(hf_repo, str) and hf_repo.strip():
            args.extend(["--hf-repo", hf_repo.strip()])
        split = extra.get("split")
        if isinstance(split, str) and split.strip():
            args.extend(["--split", split.strip()])
        if extra.get("no_traces") is True:
            args.append("--no-traces")
        return args

    def _visualwebbench_result(output_dir: Path) -> Path:
        return output_dir / "visualwebbench-results.json"

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
        ``ENVIRONMENT_CONFIG``, ``USE_EXTERNAL_SURFPOOL``, and ``OUTPUT_DIR``.
        """
        args = [
            python, "-m", "benchmarks.solana.eliza_explorer", "--output-dir", str(output_dir),
        ]
        # All knobs flow through env vars read by ``eliza_explorer.main``.
        _ = model
        _ = extra
        return args

    def _solana_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="eliza_*_metrics.json")

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

        Defaults to the eliza TypeScript bridge. Set ``extra.agent`` to
        ``deterministic`` or ``python`` for the local deterministic smoke path.
        Always runs in ``--demo`` mode unless the caller
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
        if agent in {"deterministic", "python"}:
            args.extend(["--mode", "deterministic"])
        else:
            args.extend(["--mode", "eliza"])

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
        """Build command for Solana Gauntlet benchmark with Eliza bridge agent."""
        agent = extra.get("agent")
        if agent == "python":
            agent_path = repo("benchmarks/gauntlet/agents/eliza_agent.py")
        else:
            agent_path = repo("benchmarks/gauntlet/agents/eliza_bridge_agent.py")

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
        max_scenarios = extra.get("max_scenarios")
        if not isinstance(max_scenarios, int):
            max_scenarios = extra.get("max_tasks")
        if isinstance(max_scenarios, int) and max_scenarios > 0:
            args.extend(["--max-scenarios", str(max_scenarios)])
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
            # Default to execution: real file/exec validation, not keyword matching.
            args.extend(["--mode", "execution"])
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
        if isinstance(agent, str) and agent.strip().lower() in {"hermes", "openclaw"}:
            raise ValueError("ConfigBench only supports the Eliza handler today")
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
        agent = extra.get("agent")
        if isinstance(agent, str) and agent.strip().lower() in {"hermes", "openclaw"}:
            raise ValueError("VoiceBench only supports the Eliza TypeScript runtime today")
        profile_raw = extra.get("profile")
        provider_name = (model.provider or "").strip().lower()
        if isinstance(profile_raw, str) and profile_raw.strip():
            profile = profile_raw.strip().lower()
        elif provider_name == "mock":
            raise ValueError("voicebench: mock provider is not allowed")
        elif provider_name not in {"groq", "elevenlabs"}:
            raise ValueError(
                "voicebench: provider must be groq or elevenlabs for real runs"
            )
        elif not os.getenv("VOICEBENCH_AUDIO_PATH") and not (
            Path("benchmarks/voicebench/shared/audio/default.wav").exists()
            or Path("agent-town/public/assets/background.mp3").exists()
        ):
            raise ValueError(
                "voicebench: real audio is required; set VOICEBENCH_AUDIO_PATH"
            )
        else:
            profile = "groq"
        if profile not in {"groq", "elevenlabs"}:
            raise ValueError(
                f"voicebench: unsupported profile '{profile}' (expected groq or elevenlabs)"
            )
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
        smoke fixture when the full ``trenches-chat-dataset`` checkout is not
        present; callers can override via ``data_dir``. Defaults to the
        ``baseline`` system unless another system is requested via
        ``extra.system`` or ``model.provider``.
        """
        data_dir_raw = extra.get("data_dir")
        if isinstance(data_dir_raw, str) and data_dir_raw.strip():
            data_dir = data_dir_raw.strip()
        else:
            full_data_dir = repo_root / "benchmarks/social-alpha/trenches-chat-dataset/data"
            data_dir = "trenches-chat-dataset/data" if full_data_dir.exists() else "fixtures/smoke-data"
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
            if provider_lower in {"eliza", "eliza-bridge", "eliza-ts"}:
                system = "eliza-bridge"
            elif provider_lower in {"cerebras", "openai", "groq", "openrouter", "vllm"}:
                system = "full"
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

    def _trust_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        handler_raw = extra.get("handler")
        agent = str(extra.get("agent") or extra.get("harness") or "").strip().lower()
        provider_name = (model.provider or "").strip().lower()
        if isinstance(handler_raw, str) and handler_raw.strip():
            handler = handler_raw.strip()
        elif agent in {"eliza", "hermes", "openclaw"} or provider_name in {"cerebras", "openai", "groq", "openrouter", "vllm"}:
            handler = "eliza"
        else:
            handler = "oracle"
        args = [
            python,
            repo("benchmarks/trust/run_benchmark.py"),
            "--handler",
            handler,
            "--output",
            str(output_dir / "trust-results.json"),
        ]
        if handler in {"eliza", "llm"}:
            if model.provider:
                args.extend(["--model-provider", model.provider])
            if model.model:
                args.extend(["--model", model.model])
        categories = extra.get("categories")
        if isinstance(categories, list) and all(isinstance(x, str) for x in categories):
            args.extend(["--categories", *cast(list[str], categories)])
        difficulty = extra.get("difficulty")
        if isinstance(difficulty, list) and all(isinstance(x, str) for x in difficulty):
            args.extend(["--difficulty", *cast(list[str], difficulty)])
        tags = extra.get("tags")
        if isinstance(tags, list) and all(isinstance(x, str) for x in tags):
            args.extend(["--tags", *cast(list[str], tags)])
        threshold = extra.get("threshold")
        if isinstance(threshold, (int, float)):
            args.extend(["--threshold", str(float(threshold))])
        return args

    def _trust_result(output_dir: Path) -> Path:
        return output_dir / "trust-results.json"

    # WebShop - product-search/purchase benchmark with Eliza agent
    def _webshop_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        """Build command for WebShop benchmark.

        Defaults to the bundled sample task set and disables trajectory logging
        unless the caller opts in. Non-mock runs route through the Eliza
        TypeScript benchmark bridge; ``--mock`` bypasses it for smoke tests.
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
        else:
            args.append("--bridge")
            if model.provider and provider_lower not in {"eliza", "eliza-bridge", "eliza-ts"}:
                args.extend(["--model-provider", model.provider])
        if model.model:
            args.extend(["--model", model.model])
        provider_name = (model.provider or "").strip().lower()
        if extra.get("mock") is True or provider_name == "mock":
            args.append("--mock")
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

    # WooBench - mystical-reading conversation benchmark.
    def _woobench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = [
            python,
            "-m",
            "benchmarks.woobench",
            "--output",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])

        agent_raw = extra.get("agent")
        provider_lower = (model.provider or "").strip().lower()
        payment_mode = extra.get("payment") is True or extra.get("payments") is True
        if agent_raw == "dummy" or extra.get("mock") is True or provider_lower == "mock":
            args.extend(["--agent", "dummy-charge" if payment_mode else "dummy"])
        else:
            args.extend(["--agent", "eliza"])

        evaluator = extra.get("evaluator")
        if isinstance(evaluator, str) and evaluator in {"llm", "heuristic"}:
            args.extend(["--evaluator", evaluator])
        elif agent_raw == "dummy" or extra.get("mock") is True or provider_lower == "mock":
            args.extend(["--evaluator", "heuristic"])

        scenario = extra.get("scenario")
        if isinstance(scenario, str) and scenario.strip():
            args.extend(["--scenario", scenario.strip()])
        scenarios = extra.get("scenarios")
        if isinstance(scenarios, list):
            scenario_ids = [str(item).strip() for item in scenarios if str(item).strip()]
            if scenario_ids:
                args.extend(["--scenarios", ",".join(scenario_ids)])
        elif isinstance(scenarios, str) and scenarios.strip():
            args.extend(["--scenarios", scenarios.strip()])
        system = extra.get("system")
        if isinstance(system, str) and system.strip():
            args.extend(["--system", system.strip()])
        persona = extra.get("persona")
        if isinstance(persona, str) and persona.strip():
            args.extend(["--persona", persona.strip()])
        concurrency = extra.get("concurrency")
        if isinstance(concurrency, int) and concurrency > 0:
            args.extend(["--concurrency", str(concurrency)])
        payment_mock_url = extra.get("payment_mock_url")
        if isinstance(payment_mock_url, str) and payment_mock_url.strip():
            args.extend(["--payment-mock-url", payment_mock_url.strip()])
        return args

    def _woobench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="woobench_*.json")

    # scambench
    def _scambench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        provider = (model.provider or "").strip().lower() or "vllm"
        args = [
            python,
            "-m",
            "benchmarks.scambench.cli",
            "--provider",
            provider,
            "--out",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        base_url = extra.get("base_url") or extra.get("vllm_base_url")
        if isinstance(base_url, str) and base_url.strip():
            args.extend(["--base-url", base_url.strip()])
        api_key_env = extra.get("api_key_env")
        if isinstance(api_key_env, str) and api_key_env.strip():
            args.extend(["--api-key-env", api_key_env.strip()])
        datasets = extra.get("dataset")
        if isinstance(datasets, list):
            for d in datasets:
                if isinstance(d, str) and d.strip():
                    args.extend(["--dataset", d.strip()])
        elif isinstance(datasets, str) and datasets.strip():
            args.extend(["--dataset", datasets.strip()])
        max_examples = extra.get("max_examples")
        if isinstance(max_examples, int) and max_examples > 0:
            args.extend(["--max-examples", str(max_examples)])
        max_new_tokens = extra.get("max_new_tokens")
        if isinstance(max_new_tokens, int) and max_new_tokens > 0:
            args.extend(["--max-new-tokens", str(max_new_tokens)])
        temperature = extra.get("temperature")
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
            args.extend(["--temperature", str(float(temperature))])
        return args

    def _scambench_result(output_dir: Path) -> Path:
        return output_dir / "scambench-results.json"

    # abliteration-robustness
    def _abliteration_robustness_cmd(
        output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]
    ) -> list[str]:
        provider = (model.provider or "").strip().lower() or "vllm"
        args = [
            python,
            "-m",
            "benchmarks.abliteration-robustness.cli",
            "--provider",
            provider,
            "--out",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        base_url = extra.get("base_url")
        if not base_url and provider == "vllm":
            base_url = extra.get("vllm_base_url") or "http://127.0.0.1:8001/v1"
        if isinstance(base_url, str) and base_url.strip():
            args.extend(["--base-url", base_url.strip()])
        api_key_env = extra.get("api_key_env")
        if isinstance(api_key_env, str) and api_key_env.strip():
            args.extend(["--api-key-env", api_key_env.strip()])
        dataset = extra.get("dataset")
        if isinstance(dataset, str) and dataset.strip():
            args.extend(["--dataset", dataset.strip()])
        dataset_path = extra.get("dataset_path")
        if isinstance(dataset_path, str) and dataset_path.strip():
            args.extend(["--dataset-path", dataset_path.strip()])
        max_examples = extra.get("max_examples")
        if isinstance(max_examples, int) and max_examples > 0:
            args.extend(["--max-examples", str(max_examples)])
        max_new_tokens = extra.get("max_new_tokens")
        if isinstance(max_new_tokens, int) and max_new_tokens > 0:
            args.extend(["--max-new-tokens", str(max_new_tokens)])
        temperature = extra.get("temperature")
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool) and temperature >= 0:
            args.extend(["--temperature", str(float(temperature))])
        tool_choice = extra.get("tool_choice")
        if isinstance(tool_choice, str) and tool_choice in {"auto", "required", "none"}:
            args.extend(["--tool-choice", tool_choice])
        else:
            args.extend(["--tool-choice", "none"])
        return args

    def _abliteration_robustness_result(output_dir: Path) -> Path:
        return output_dir / "abliteration-robustness-results.json"

    # action-calling
    def _action_calling_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        provider = (model.provider or "").strip().lower() or "vllm"
        agent = str(extra.get("agent") or extra.get("harness") or "").strip().lower()
        if agent in {"eliza", "hermes", "openclaw"}:
            provider = "eliza"
        args = [
            python,
            "-m",
            "benchmarks.action-calling.cli",
            "--provider",
            provider,
            "--out",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        base_url = extra.get("base_url")
        if isinstance(base_url, str) and base_url.strip():
            args.extend(["--base-url", base_url.strip()])
        api_key_env = extra.get("api_key_env")
        if isinstance(api_key_env, str) and api_key_env.strip():
            args.extend(["--api-key-env", api_key_env.strip()])
        test_file = extra.get("test_file")
        if isinstance(test_file, str) and test_file.strip():
            args.extend(["--test-file", test_file.strip()])
        max_examples = extra.get("max_examples")
        if isinstance(max_examples, int) and max_examples > 0:
            args.extend(["--max-examples", str(max_examples)])
        else:
            args.extend(["--max-examples", "100"])
        max_new_tokens = extra.get("max_new_tokens")
        if isinstance(max_new_tokens, int) and max_new_tokens > 0:
            args.extend(["--max-new-tokens", str(max_new_tokens)])
        temperature = extra.get("temperature")
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool) and temperature >= 0:
            args.extend(["--temperature", str(float(temperature))])
        tool_choice = extra.get("tool_choice")
        if isinstance(tool_choice, str) and tool_choice in {"auto", "required"}:
            args.extend(["--tool-choice", tool_choice])
        return args

    def _action_calling_result(output_dir: Path) -> Path:
        return output_dir / "action-calling-results.json"

    # ----- standard public benchmarks (MMLU / HumanEval / GSM8K / MT-Bench) -----

    def _standard_bench_base_args(
        module: str,
        output_dir: Path,
        model: ModelSpec,
        extra: Mapping[str, JSONValue],
    ) -> list[str]:
        """Shared CLI arg builder for ``benchmarks.standard.<name>`` runners.

        Forwards ``--model-endpoint`` / ``--provider`` / ``--model`` /
        ``--api-key-env`` / ``--mock`` / ``--limit`` from ``ModelSpec`` +
        ``extra`` to the standardized adapter CLI.
        """

        args: list[str] = [
            python,
            "-m",
            module,
            "--output",
            str(output_dir),
        ]
        if model.model:
            args.extend(["--model", model.model])
        endpoint = extra.get("model_endpoint") or extra.get("base_url")
        provider_name = (model.provider or "").strip().lower()
        if isinstance(endpoint, str) and endpoint.strip():
            args.extend(["--model-endpoint", endpoint.strip()])
        elif provider_name and provider_name != "mock":
            args.extend(["--provider", provider_name])
        api_key_env = extra.get("api_key_env")
        if isinstance(api_key_env, str) and api_key_env.strip():
            args.extend(["--api-key-env", api_key_env.strip()])
        limit = extra.get("limit")
        if isinstance(limit, int) and limit > 0:
            args.extend(["--limit", str(limit)])
        if extra.get("mock") is True or provider_name == "mock":
            args.append("--mock")
        return args

    def _mmlu_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = _standard_bench_base_args("benchmarks.standard.mmlu", output_dir, model, extra)
        max_tokens = extra.get("max_tokens")
        if isinstance(max_tokens, int) and max_tokens > 0:
            args.extend(["--max-tokens", str(max_tokens)])
        return args

    def _mmlu_result(output_dir: Path) -> Path:
        return output_dir / "mmlu-results.json"

    def _humaneval_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = _standard_bench_base_args("benchmarks.standard.humaneval", output_dir, model, extra)
        max_tokens = extra.get("max_tokens")
        if isinstance(max_tokens, int) and max_tokens > 0:
            args.extend(["--max-tokens", str(max_tokens)])
        timeout_s = extra.get("timeout_s")
        if isinstance(timeout_s, (int, float)) and not isinstance(timeout_s, bool) and timeout_s > 0:
            args.extend(["--timeout-s", str(float(timeout_s))])
        return args

    def _humaneval_result(output_dir: Path) -> Path:
        return output_dir / "humaneval-results.json"

    def _gsm8k_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = _standard_bench_base_args("benchmarks.standard.gsm8k", output_dir, model, extra)
        max_tokens = extra.get("max_tokens")
        if isinstance(max_tokens, int) and max_tokens > 0:
            args.extend(["--max-tokens", str(max_tokens)])
        return args

    def _gsm8k_result(output_dir: Path) -> Path:
        return output_dir / "gsm8k-results.json"

    def _mt_bench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        args = _standard_bench_base_args("benchmarks.standard.mt_bench", output_dir, model, extra)
        judge_endpoint = extra.get("judge_endpoint")
        if isinstance(judge_endpoint, str) and judge_endpoint.strip():
            args.extend(["--judge-endpoint", judge_endpoint.strip()])
        judge_provider = extra.get("judge_provider")
        if isinstance(judge_provider, str) and judge_provider.strip():
            args.extend(["--judge-provider", judge_provider.strip()])
        judge_model = extra.get("judge_model")
        if isinstance(judge_model, str) and judge_model.strip():
            args.extend(["--judge-model", judge_model.strip()])
        judge_api_key_env = extra.get("judge_api_key_env")
        if isinstance(judge_api_key_env, str) and judge_api_key_env.strip():
            args.extend(["--judge-api-key-env", judge_api_key_env.strip()])
        max_tokens = extra.get("max_tokens")
        if isinstance(max_tokens, int) and max_tokens > 0:
            args.extend(["--max-tokens", str(max_tokens)])
        judge_max_tokens = extra.get("judge_max_tokens")
        if isinstance(judge_max_tokens, int) and judge_max_tokens > 0:
            args.extend(["--judge-max-tokens", str(judge_max_tokens)])
        return args

    def _mt_bench_result(output_dir: Path) -> Path:
        return output_dir / "mt-bench-results.json"

    def _trajectory_replay_cmd(
        output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]
    ) -> list[str]:
        """Build the trajectory-replay CLI invocation.

        Required ``extra`` keys:

        * ``traj_set`` (str): directory of trajectory JSON files.
        * ``baseline`` (str): model id whose recorded outputs are ground truth.

        Optional knobs that map straight onto the adapter flags:
        ``reward_threshold`` (float, default 0.5),
        ``exact_action_sequence`` (bool, default True; set False for set match),
        ``action_weight`` (float, default 0.5),
        ``final_state_weight`` (float, default 0.5),
        ``max_tokens`` (int, default 768).
        """

        args = _standard_bench_base_args(
            "benchmarks.standard.trajectory_replay", output_dir, model, extra
        )
        traj_set = extra.get("traj_set")
        if not isinstance(traj_set, str) or not traj_set.strip():
            raise ValueError(
                "trajectory_replay requires extra.traj_set (directory of trajectory JSON files)"
            )
        args.extend(["--traj-set", traj_set.strip()])
        baseline = extra.get("baseline")
        if not isinstance(baseline, str) or not baseline.strip():
            raise ValueError(
                "trajectory_replay requires extra.baseline (baseline model id)"
            )
        args.extend(["--baseline", baseline.strip()])
        reward_threshold = extra.get("reward_threshold")
        if (
            isinstance(reward_threshold, (int, float))
            and not isinstance(reward_threshold, bool)
        ):
            args.extend(["--reward-threshold", str(float(reward_threshold))])
        exact_action_sequence = extra.get("exact_action_sequence")
        if exact_action_sequence is False:
            args.append("--no-exact-action-sequence")
        elif exact_action_sequence is True:
            args.append("--exact-action-sequence")
        action_weight = extra.get("action_weight")
        if (
            isinstance(action_weight, (int, float))
            and not isinstance(action_weight, bool)
        ):
            args.extend(["--action-weight", str(float(action_weight))])
        final_state_weight = extra.get("final_state_weight")
        if (
            isinstance(final_state_weight, (int, float))
            and not isinstance(final_state_weight, bool)
        ):
            args.extend(["--final-state-weight", str(float(final_state_weight))])
        max_tokens = extra.get("max_tokens")
        if isinstance(max_tokens, int) and max_tokens > 0:
            args.extend(["--max-tokens", str(max_tokens)])
        return args

    def _trajectory_replay_result(output_dir: Path) -> Path:
        return output_dir / "trajectory-replay-results.json"

    # lifeops-bench
    def _lifeops_bench_cmd(
        output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]
    ) -> list[str]:
        """Build the LifeOpsBench CLI invocation.

        ``model.model`` selects the agent backend: ``perfect`` / ``wrong``
        for hermetic oracle runs; ``hermes`` / ``cerebras-direct`` /
        ``eliza`` for adapter-backed runs that need an API key. Default
        (no model specified) is ``perfect`` for cheap smoke runs.
        """
        agent_raw = extra.get("agent") or extra.get("harness")
        if isinstance(agent_raw, str) and agent_raw.strip():
            agent = agent_raw.strip()
        elif model.model in {"perfect", "wrong", "hermes", "openclaw", "cerebras-direct", "eliza"}:
            agent = str(model.model)
        elif (model.provider or "").strip().lower() in {"cerebras", "openai", "groq", "openrouter", "vllm", "eliza"}:
            agent = "eliza"
        else:
            agent = "perfect"
        args = [
            python,
            "-m",
            "eliza_lifeops_bench",
            "--agent",
            agent,
            "--output-dir",
            str(output_dir),
        ]
        domain = extra.get("domain")
        if isinstance(domain, str) and domain.strip():
            args.extend(["--domain", domain.strip()])
        mode = extra.get("mode")
        if isinstance(mode, str) and mode.strip():
            args.extend(["--mode", mode.strip()])
        suite = extra.get("suite")
        if isinstance(suite, str) and suite in {"smoke", "core", "full"}:
            args.extend(["--suite", suite])
        scenario = extra.get("scenario")
        if isinstance(scenario, str) and scenario.strip():
            args.extend(["--scenario", scenario.strip()])
        limit = extra.get("limit")
        if isinstance(limit, int) and limit > 0:
            args.extend(["--limit", str(limit)])
        seeds = extra.get("seeds")
        if isinstance(seeds, int) and seeds > 0:
            args.extend(["--seeds", str(seeds)])
        concurrency = extra.get("concurrency")
        if isinstance(concurrency, int) and concurrency > 0:
            args.extend(["--concurrency", str(concurrency)])
        max_cost_usd = extra.get("max_cost_usd")
        if isinstance(max_cost_usd, (int, float)) and not isinstance(max_cost_usd, bool):
            args.extend(["--max-cost-usd", str(float(max_cost_usd))])
        per_scenario_timeout_s = extra.get("per_scenario_timeout_s")
        if isinstance(per_scenario_timeout_s, int) and per_scenario_timeout_s > 0:
            args.extend(["--per-scenario-timeout-s", str(per_scenario_timeout_s)])
        evaluator_model = extra.get("evaluator_model")
        if isinstance(evaluator_model, str) and evaluator_model.strip():
            args.extend(["--evaluator-model", evaluator_model.strip()])
        judge_model = extra.get("judge_model")
        if isinstance(judge_model, str) and judge_model.strip():
            args.extend(["--judge-model", judge_model.strip()])
        return args

    def _lifeops_bench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="lifeops_*.json")

    # MMAU - multi-task audio understanding, MCQ exact-match scorer.
    def _mmau_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        agent = str(extra.get("agent") or extra.get("harness") or "eliza").strip().lower()
        if agent not in {"mock", "eliza", "hermes", "openclaw"}:
            agent = "mock" if (model.provider or "").strip().lower() == "mock" else "eliza"
        args = [
            python,
            "-m",
            "benchmarks.mmau",
            "--agent",
            agent,
            "--output",
            str(output_dir),
        ]
        if extra.get("mock") is True or (model.provider or "").strip().lower() == "mock":
            args.append("--mock")
        if model.provider:
            args.extend(["--provider", model.provider])
        if model.model:
            args.extend(["--model", model.model])
        split = extra.get("split")
        if isinstance(split, str) and split in {"test-mini", "test"}:
            args.extend(["--split", split])
        categories = extra.get("category") or extra.get("categories")
        if isinstance(categories, str) and categories.strip():
            args.extend(["--category", categories.strip()])
        elif isinstance(categories, list) and categories:
            args.extend(["--category", ",".join(str(c) for c in categories if str(c).strip())])
        limit = extra.get("limit")
        if not isinstance(limit, int):
            limit = extra.get("max_samples")
        if isinstance(limit, int) and limit > 0:
            args.extend(["--limit", str(limit)])
        fixture_path = extra.get("fixture_path")
        if isinstance(fixture_path, str) and fixture_path.strip():
            args.extend(["--fixture-path", fixture_path.strip()])
        if extra.get("hf") is True:
            args.append("--hf")
        stt_model = extra.get("stt_model")
        if isinstance(stt_model, str) and stt_model.strip():
            args.extend(["--stt-model", stt_model.strip()])
        timeout = extra.get("timeout")
        if isinstance(timeout, int) and timeout > 0:
            args.extend(["--timeout", str(timeout)])
        if extra.get("no_traces") is True:
            args.append("--no-traces")
        return args

    def _mmau_result(output_dir: Path) -> Path:
        return output_dir / "mmau-results.json"

    # VoiceBench-quality - response quality counterpart to the TS latency bench.
    def _voicebench_quality_cmd(
        output_dir: Path,
        model: ModelSpec,
        extra: Mapping[str, JSONValue],
    ) -> list[str]:
        agent = str(extra.get("agent") or extra.get("harness") or "eliza").strip().lower()
        if agent not in {"echo", "eliza", "hermes", "openclaw"}:
            agent = "echo" if (model.provider or "").strip().lower() == "mock" else "eliza"
        args = [
            python,
            "-m",
            "elizaos_voicebench",
            "--agent",
            agent,
            "--output",
            str(output_dir),
        ]
        suite = extra.get("suite")
        if isinstance(suite, str) and suite.strip():
            args.extend(["--suite", suite.strip()])
        limit = extra.get("limit")
        if isinstance(limit, int) and limit > 0:
            args.extend(["--limit", str(limit)])
        if extra.get("mock") is True or (model.provider or "").strip().lower() == "mock":
            args.append("--mock")
        elif extra.get("fixtures") is True or extra.get("fixture") is True:
            args.append("--fixtures")
        judge_model = extra.get("judge_model")
        if isinstance(judge_model, str) and judge_model.strip():
            args.extend(["--judge-model", judge_model.strip()])
        stt_provider = extra.get("stt_provider")
        if isinstance(stt_provider, str) and stt_provider.strip():
            args.extend(["--stt-provider", stt_provider.strip()])
        return args

    def _voicebench_quality_result(output_dir: Path) -> Path:
        return output_dir / "voicebench-quality-results.json"

    # VoiceAgentBench - voice-in, tool-call-out task suites.
    def _voiceagentbench_cmd(
        output_dir: Path,
        model: ModelSpec,
        extra: Mapping[str, JSONValue],
    ) -> list[str]:
        agent = str(extra.get("agent") or extra.get("harness") or "eliza").strip().lower()
        if agent not in {"mock", "eliza", "hermes", "openclaw"}:
            agent = "mock" if (model.provider or "").strip().lower() == "mock" else "eliza"
        args = [
            python,
            "-m",
            "elizaos_voiceagentbench",
            "--agent",
            agent,
            "--output",
            str(output_dir),
        ]
        suite = extra.get("suite")
        if isinstance(suite, str) and suite.strip():
            args.extend(["--suite", suite.strip()])
        limit = extra.get("limit")
        if isinstance(limit, int) and limit > 0:
            args.extend(["--limit", str(limit)])
        seeds = extra.get("seeds")
        if isinstance(seeds, int) and seeds > 0:
            args.extend(["--seeds", str(seeds)])
        if extra.get("mock") is True or extra.get("fixtures") is True or (model.provider or "").strip().lower() == "mock":
            args.append("--mock")
        if extra.get("no_judge") is True:
            args.append("--no-judge")
        data_path = extra.get("data_path")
        if isinstance(data_path, str) and data_path.strip():
            args.extend(["--data-path", data_path.strip()])
        judge_model = extra.get("judge_model")
        if isinstance(judge_model, str) and judge_model.strip():
            args.extend(["--judge-model", judge_model.strip()])
        return args

    def _voiceagentbench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="voiceagentbench_*.json")

    # --- Hermes-native envs (tblite / terminalbench_2 / yc_bench / hermes_swe_env) ---
    # The four envs share one subprocess shim and one score extractor; only the
    # short env-id arg and the result-glob differ between them.

    hermes_run_env_cli = repo("benchmarks/hermes-adapter/run_env_cli.py")

    def _hermes_env_cmd(
        env_arg: str,
        output_dir: Path,
        model: ModelSpec,
        extra: Mapping[str, JSONValue],
    ) -> list[str]:
        args = [
            python,
            hermes_run_env_cli,
            "--env",
            env_arg,
            "--output",
            str(output_dir),
            "--model",
            (model.model or "gpt-oss-120b"),
        ]
        if model.provider:
            args.extend(["--provider", model.provider])
        base_url = extra.get("base_url")
        if isinstance(base_url, str) and base_url.strip():
            args.extend(["--base-url", base_url.strip()])
        max_tasks = extra.get("max_tasks")
        if isinstance(max_tasks, int) and max_tasks > 0:
            args.extend(["--max-tasks", str(max_tasks)])
        task_filter = extra.get("task_filter")
        if isinstance(task_filter, str) and task_filter.strip():
            args.extend(["--task-filter", task_filter.strip()])
        repo_path = extra.get("repo_path")
        if isinstance(repo_path, str) and repo_path.strip():
            args.extend(["--repo-path", repo_path.strip()])
        timeout_s = extra.get("timeout_seconds")
        if isinstance(timeout_s, (int, float)) and not isinstance(timeout_s, bool) and timeout_s > 0:
            args.extend(["--timeout-seconds", str(float(timeout_s))])
        if extra.get("force") is True:
            args.append("--force")
        return args

    def _hermes_tblite_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        return _hermes_env_cmd("tblite", output_dir, model, extra)

    def _hermes_terminalbench_2_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        return _hermes_env_cmd("terminalbench_2", output_dir, model, extra)

    def _hermes_yc_bench_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        return _hermes_env_cmd("yc_bench", output_dir, model, extra)

    def _hermes_swe_env_cmd(output_dir: Path, model: ModelSpec, extra: Mapping[str, JSONValue]) -> list[str]:
        return _hermes_env_cmd("hermes_swe_env", output_dir, model, extra)

    def _hermes_tblite_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="hermes_tblite_*.json")

    def _hermes_terminalbench_2_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="hermes_terminalbench_2_*.json")

    def _hermes_yc_bench_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="hermes_yc_bench_*.json")

    def _hermes_swe_env_result(output_dir: Path) -> Path:
        return find_latest_file(output_dir, glob_pattern="hermes_hermes_swe_env_*.json")

    def _score_from_hermes_env_json(data: JSONValue) -> ScoreExtraction:
        root = expect_dict(data, ctx="hermes_env:root")
        score_raw = get_required(root, "score", ctx="hermes_env:root")
        score = expect_float(score_raw, ctx="hermes_env:score")
        higher_raw = get_optional(root, "higher_is_better")
        higher = bool(higher_raw) if isinstance(higher_raw, bool) else True
        metrics_raw = get_optional(root, "metrics")
        metrics_dict: dict[str, JSONValue] = {}
        if isinstance(metrics_raw, dict):
            metrics_dict.update(metrics_raw)
        env_id_public = get_optional(root, "env_id_public") or get_optional(root, "env_id")
        if env_id_public is not None:
            metrics_dict["env_id"] = env_id_public
        duration = get_optional(root, "duration_s")
        if duration is not None:
            metrics_dict["duration_s"] = duration
        return ScoreExtraction(
            score=score,
            unit="ratio",
            higher_is_better=higher,
            metrics=metrics_dict,
        )

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
                env_vars=(),
                paths=(),
                notes=(
                    "Can run sample dry-runs without credentials; bridge/full runs "
                    "require dataset/runtime setup and typically a provider API key."
                ),
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
                env_vars=(),
                paths=(),
                notes="Sample/mock runs need no credentials. Full GAIA/provider runs require dataset and provider key setup.",
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
                env_vars=(),
                paths=(),
                notes="Uses the GAIA runner with orchestrator profile defaults; safe sample/mock runs avoid gated HF access and provider keys.",
            ),
            build_command=_gaia_orchestrated_cmd,
            locate_result=_gaia_orchestrated_result,
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
                env_vars=(),
                paths=(),
                notes="Uses sample tasks by default; mock/sample runs need no credentials. --hf or real providers need their dataset/key setup.",
            ),
            build_command=_mind2web_cmd,
            locate_result=_mind2web_result,
            extract_score=_score_from_mind2web_json,
        ),
        BenchmarkDefinition(
            id="visualwebbench",
            display_name="VisualWebBench",
            description="Multimodal webpage understanding and grounding benchmark",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes="Uses bundled JSONL fixture and dry-run mode by default. --hf streams from Hugging Face when datasets is installed.",
            ),
            build_command=_visualwebbench_cmd,
            locate_result=_visualwebbench_result,
            extract_score=_score_from_visualwebbench_json,
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
                env_vars=(),
                paths=(),
                notes=(
                    "Requires VM provider: Docker (with KVM), VMware, or VirtualBox. "
                    "Uses the Eliza TypeScript benchmark bridge; dry_run smoke requires no provider key. "
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
                    "Defaults to --mode eliza (eliza TS benchmark server) with --demo "
                    "and --network testnet, so no funds are at risk. "
                    "Set agent=deterministic for the local offline smoke path. "
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
                env_vars=(),
                paths=("benchmarks/voicebench/run.sh", "benchmarks/voicebench/typescript/src/bench.ts"),
                notes=(
                    "Bun runtime via run.sh. Profiles: mock (no credentials), groq (needs GROQ_API_KEY), "
                    "elevenlabs (needs GROQ_API_KEY and ELEVENLABS_API_KEY). Audio fixture resolved from "
                    "VOICEBENCH_AUDIO_PATH or repo defaults. "
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
                paths=("benchmarks/social-alpha/fixtures/smoke-data",),
                notes=(
                    "Defaults to the rule-based BaselineSystem (no LLM). Set system=eliza|full|smart|oracle "
                    "via extra to swap implementations; eliza/full additionally need provider keys. "
                    "Uses the bundled smoke fixture when the full dataset is absent. "
                    "Score: composite Trust Marketplace Score (0..1)."
                ),
            ),
            build_command=_social_alpha_cmd,
            locate_result=_social_alpha_result,
            extract_score=_score_from_social_alpha_json,
        ),
        BenchmarkDefinition(
            id="trust",
            display_name="Trust",
            description="Agent trust/security detection benchmark",
            cwd_rel="benchmarks/trust",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/trust/elizaos_trust_bench",),
                notes=(
                    "Defaults to the oracle handler for deterministic no-key smoke runs. "
                    "Set handler=random for a baseline or handler=eliza/handler=eliza-bridge "
                    "for agent-backed runs; those paths require their runtime/provider setup."
                ),
            ),
            build_command=_trust_cmd,
            locate_result=_trust_result,
            extract_score=_score_from_trust_json,
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
        BenchmarkDefinition(
            id="woobench",
            display_name="WooBench",
            description="Mystical reading conversation and revenue benchmark",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/woobench",),
                notes=(
                    "Default run uses the eliza TS benchmark bridge plus the LLM evaluator. "
                    "Set mock=true or agent=dummy with evaluator=heuristic for a deterministic "
                    "no-credential smoke run. Score is overall_score normalized from 0..100 to 0..1."
                ),
            ),
            build_command=_woobench_cmd,
            locate_result=_woobench_result,
            extract_score=_score_from_woobench_json,
        ),
        BenchmarkDefinition(
            id="scambench",
            display_name="ScamBench",
            description="Adversarial scam-detection benchmark (refusal vs helpfulness)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(
                    "../../training/data/normalized/scambench.jsonl",
                    "../../training/data/synthesized/scambench/scambench.jsonl",
                ),
                notes=(
                    "Reads the normalized + Claude-teacher-labeled scambench dataset. "
                    "Score is the equally-weighted mean of refusal-correctness on scam prompts "
                    "and helpfulness on legit prompts. Higher better."
                ),
            ),
            build_command=_scambench_cmd,
            locate_result=_scambench_result,
            extract_score=_score_from_scambench_json,
        ),
        BenchmarkDefinition(
            id="abliteration-robustness",
            display_name="Abliteration Robustness",
            description="Over-refusal benchmark for abliterated model variants on benign prompts",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes=(
                    "Loads the harmless prompt set used by training/scripts/training/abliterate.py "
                    "(default HF dataset mlabonne/harmless_alpaca). Score = 1 - refusal_rate. "
                    "Pair with the abliterated variant to assert it still helps on benign requests."
                ),
            ),
            build_command=_abliteration_robustness_cmd,
            locate_result=_abliteration_robustness_result,
            extract_score=_score_from_abliteration_robustness_json,
        ),
        BenchmarkDefinition(
            id="action-calling",
            display_name="Action Calling",
            description="Native function/tool calling against planner-style records",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("training/data/native/records/hermes-fc-v1.jsonl",),
                notes=(
                    "Samples native planner records and sends OpenAI-compatible tools to the provider. "
                    "Asserts real tool-call emission, tool-name match, args JSON parse, required-arg presence, "
                    "and expected argument-value preservation. Score = geometric mean of the five sub-rates."
                ),
            ),
            build_command=_action_calling_cmd,
            locate_result=_action_calling_result,
            extract_score=_score_from_action_calling_json,
        ),
        BenchmarkDefinition(
            id="lifeops_bench",
            display_name="LifeOpsBench",
            description="Multi-turn life-assistant tool-use benchmark (calendar/mail/messages/contacts/reminders/finance/travel/health/sleep/focus)",
            cwd_rel="packages/benchmarks/lifeops-bench",
            requirements=BenchmarkRequirements(
                env_vars=("CEREBRAS_API_KEY", "ANTHROPIC_API_KEY"),
                paths=(
                    "packages/benchmarks/lifeops-bench/eliza_lifeops_bench",
                    "packages/benchmarks/lifeops-bench/data/snapshots",
                ),
                notes=(
                    "model.model selects the agent backend: 'perfect'/'wrong' for hermetic oracle runs (no env vars needed); "
                    "'hermes'/'cerebras-direct'/'eliza' for live adapters. "
                    "CEREBRAS_API_KEY is required when LIVE scenarios are scheduled (simulated user uses gpt-oss-120b). "
                    "ANTHROPIC_API_KEY is required for the LIVE judge (claude-opus-4-7). "
                    "Cost cap defaults to $10; override via extra.max_cost_usd. "
                    "Score: pass@1 across all (scenario, seed) pairs. Higher is better."
                ),
            ),
            build_command=_lifeops_bench_cmd,
            locate_result=_lifeops_bench_result,
            extract_score=_score_from_lifeops_bench_json,
        ),
        BenchmarkDefinition(
            id="mmau",
            display_name="MMAU",
            description="Massive Multi-task Audio Understanding benchmark (speech/sound/music MCQ exact match)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/mmau/fixtures/smoke.jsonl",),
                notes=(
                    "Defaults to the bundled fixture so smoke runs can exercise "
                    "Eliza/Hermes/OpenClaw adapters without HF downloads. Full "
                    "audio runs require hf=true plus GROQ_API_KEY for cascaded STT."
                ),
            ),
            build_command=_mmau_cmd,
            locate_result=_mmau_result,
            extract_score=_score_from_mmau_json,
        ),
        BenchmarkDefinition(
            id="voicebench_quality",
            display_name="VoiceBench Quality",
            description="VoiceBench response-quality benchmark over spoken instruction suites",
            cwd_rel="benchmarks/voicebench-quality",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/voicebench-quality/elizaos_voicebench",),
                notes=(
                    "Separate from the TypeScript latency benchmark. Defaults to "
                    "fixture data on openbookqa so runs can exercise the selected "
                    "adapter. Full audio runs require datasets/HF plus GROQ_API_KEY; "
                    "open-ended suites use a Cerebras judge."
                ),
            ),
            build_command=_voicebench_quality_cmd,
            locate_result=_voicebench_quality_result,
            extract_score=_score_from_voicebench_quality_json,
        ),
        BenchmarkDefinition(
            id="voiceagentbench",
            display_name="VoiceAgentBench",
            description="Voice-in tool-call benchmark with single, parallel, sequential, multi-turn, safety, and multilingual suites",
            cwd_rel="benchmarks/voiceagentbench",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("benchmarks/voiceagentbench/fixtures/mock_tasks.jsonl",),
                notes=(
                    "Defaults to bundled fixtures with passthrough STT and no judge "
                    "for smoke loops while still invoking the selected agent. Full "
                    "audio/coherence runs may need GROQ_API_KEY and CEREBRAS_API_KEY."
                ),
            ),
            build_command=_voiceagentbench_cmd,
            locate_result=_voiceagentbench_result,
            extract_score=_score_from_voiceagentbench_json,
        ),
        # ----- standard public LLM benchmarks (W1-B1, gap C6) -----
        BenchmarkDefinition(
            id="mmlu",
            display_name="MMLU",
            description="Massive Multitask Language Understanding (cais/mmlu, 4-way multiple choice over 57 subjects)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes=(
                    "Talks to any OpenAI-compatible chat-completion endpoint via "
                    "--model-endpoint or extra.model_endpoint. Mock provider uses "
                    "a bundled fixture (no network, no HF datasets install). Real "
                    "runs require `datasets` and pull cais/mmlu lazily."
                ),
            ),
            build_command=_mmlu_cmd,
            locate_result=_mmlu_result,
            extract_score=_score_from_mmlu_json,
        ),
        BenchmarkDefinition(
            id="humaneval",
            display_name="HumanEval",
            description="OpenAI HumanEval pass@1 over openai_humaneval (164 Python coding problems)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes=(
                    "Talks to any OpenAI-compatible chat-completion endpoint. "
                    "Each completion is exec'd in a sandboxed subprocess with a "
                    "per-test timeout. Mock provider uses a bundled fixture. "
                    "Use extra.timeout_s to override the default 10s test timeout."
                ),
            ),
            build_command=_humaneval_cmd,
            locate_result=_humaneval_result,
            extract_score=_score_from_humaneval_json,
        ),
        BenchmarkDefinition(
            id="gsm8k",
            display_name="GSM8K",
            description="Grade-school math word problems (openai/gsm8k) with strict #### integer parsing",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes=(
                    "Talks to any OpenAI-compatible chat-completion endpoint. "
                    "Prompts for chain-of-thought ending in '#### <integer>'. "
                    "Mock provider uses a bundled fixture (no network)."
                ),
            ),
            build_command=_gsm8k_cmd,
            locate_result=_gsm8k_result,
            extract_score=_score_from_gsm8k_json,
        ),
        BenchmarkDefinition(
            id="mt_bench",
            display_name="MT-Bench",
            description="Multi-turn open-ended LLM benchmark judged 1-10 by a strong model (LMSYS-style)",
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=(),
                notes=(
                    "Candidate model and judge model both talk to OpenAI-compatible "
                    "endpoints. Use extra.judge_endpoint + extra.judge_model + "
                    "extra.judge_api_key_env to point the judge at a separate "
                    "strong model (gpt-4o, claude-opus, eliza-1-70b, etc). "
                    "Score = mean 1-10 judge rating divided by 10."
                ),
            ),
            build_command=_mt_bench_cmd,
            locate_result=_mt_bench_result,
            extract_score=_score_from_mt_bench_json,
        ),
        BenchmarkDefinition(
            id="trajectory_replay",
            display_name="Trajectory Replay",
            description=(
                "Regression benchmark that replays curated eliza_native_v1 "
                "trajectories from ~/.eliza/trajectories against a candidate "
                "endpoint and scores action-sequence + final-state match via "
                "eliza_reward_fn (closes M5 follow-up)."
            ),
            cwd_rel=".",
            requirements=BenchmarkRequirements(
                env_vars=(),
                paths=("packages/training/scripts/eliza_reward_fn.py",),
                notes=(
                    "Required extras: traj_set (directory of trajectory JSON "
                    "files) and baseline (baseline model id whose recorded "
                    "outputs are the ground truth). Optional knobs: "
                    "reward_threshold (default 0.5), exact_action_sequence "
                    "(default True), action_weight + final_state_weight "
                    "(default 0.5/0.5), max_tokens. Score is the mean per-"
                    "trajectory aggregate in [0, 1]; higher is better."
                ),
            ),
            build_command=_trajectory_replay_cmd,
            locate_result=_trajectory_replay_result,
            extract_score=_score_from_trajectory_replay_json,
        ),
        BenchmarkDefinition(
            id="hermes_tblite",
            display_name="Hermes TBlite",
            description=(
                "Hermes-agent's TBlite environment (100 calibrated terminal tasks). "
                "Fastest of the four hermes-native envs — preferred for smoke loops."
            ),
            cwd_rel="benchmarks/hermes-adapter",
            requirements=BenchmarkRequirements(
                env_vars=("CEREBRAS_API_KEY",),
                paths=("benchmarks/hermes-adapter",),
                notes=(
                    "Runs hermes-agent's tblite_env evaluate flow via run_env_cli.py. "
                    "Defaults are smoke-friendly (max_tasks=5). Override via extra: "
                    "max_tasks, task_filter, base_url, repo_path, force, timeout_seconds."
                ),
            ),
            build_command=_hermes_tblite_cmd,
            locate_result=_hermes_tblite_result,
            extract_score=_score_from_hermes_env_json,
        ),
        BenchmarkDefinition(
            id="hermes_terminalbench_2",
            display_name="Hermes TerminalBench 2",
            description="Hermes-agent's terminalbench_2 environment (89 terminal tasks).",
            cwd_rel="benchmarks/hermes-adapter",
            requirements=BenchmarkRequirements(
                env_vars=("CEREBRAS_API_KEY",),
                paths=("benchmarks/hermes-adapter",),
                notes=(
                    "Runs hermes-agent's terminalbench_2 env via run_env_cli.py. "
                    "Same extra-config knobs as hermes_tblite."
                ),
            ),
            build_command=_hermes_terminalbench_2_cmd,
            locate_result=_hermes_terminalbench_2_result,
            extract_score=_score_from_hermes_env_json,
        ),
        BenchmarkDefinition(
            id="hermes_yc_bench",
            display_name="Hermes YC-Bench",
            description="Hermes-agent's yc_bench environment (long-horizon strategic tasks).",
            cwd_rel="benchmarks/hermes-adapter",
            requirements=BenchmarkRequirements(
                env_vars=("CEREBRAS_API_KEY",),
                paths=("benchmarks/hermes-adapter",),
                notes=(
                    "Runs hermes-agent's yc_bench env via run_env_cli.py. "
                    "Long-horizon — set max_tasks low for smoke runs."
                ),
            ),
            build_command=_hermes_yc_bench_cmd,
            locate_result=_hermes_yc_bench_result,
            extract_score=_score_from_hermes_env_json,
        ),
        BenchmarkDefinition(
            id="hermes_swe_env",
            display_name="Hermes SWE Env",
            description="Hermes-agent's SWE-bench-style hermes_swe_env environment.",
            cwd_rel="benchmarks/hermes-adapter",
            requirements=BenchmarkRequirements(
                env_vars=("CEREBRAS_API_KEY",),
                paths=("benchmarks/hermes-adapter",),
                notes=(
                    "Runs hermes-agent's hermes_swe_env evaluate flow via run_env_cli.py. "
                    "SWE-bench style; expect long per-task runtime."
                ),
            ),
            build_command=_hermes_swe_env_cmd,
            locate_result=_hermes_swe_env_result,
            extract_score=_score_from_hermes_env_json,
        ),
    ]


def load_benchmark_result_json(path: Path) -> JSONValue:
    return load_json_file(path)
