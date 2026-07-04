from __future__ import annotations

from typing import cast

try:
    from benchmarks.bench_cli_types import (
        JSONValue,
        ScoreExtraction,
        expect_dict,
        expect_float,
        expect_list,
        get_optional,
        get_required,
    )
except ImportError:
    from bench_cli_types import (  # type: ignore[no-redef]
        JSONValue,
        ScoreExtraction,
        expect_dict,
        expect_float,
        expect_list,
        get_optional,
        get_required,
    )


def _score_from_bfcl_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="bfcl:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="bfcl:root"), ctx="bfcl:metrics")
    metadata_raw = get_optional(root, "metadata")
    metadata = metadata_raw if isinstance(metadata_raw, dict) else {}
    overall = expect_float(get_required(metrics, "overall_score", ctx="bfcl:metrics"), ctx="bfcl:overall_score")
    total_tests = get_optional(metrics, "total_tests") or 0
    error_analysis = get_optional(metrics, "error_analysis")
    if total_tests == 0:
        no_ground_truth = 0
        if isinstance(error_analysis, dict):
            raw_no_gt = error_analysis.get("no_ground_truth")
            if isinstance(raw_no_gt, (int, float)):
                no_ground_truth = int(raw_no_gt)
        if no_ground_truth:
            raise ValueError(
                "bfcl: sample produced no evaluable ground-truth tests "
                f"(no_ground_truth={no_ground_truth})"
            )
        raise ValueError("bfcl: zero-task score is not publishable")

    sample_ids_raw = metadata.get("sample_ids")
    sample_ids = (
        [str(item) for item in sample_ids_raw]
        if isinstance(sample_ids_raw, list)
        else []
    )
    sample_seed = metadata.get("sample_seed")
    sample_size = metadata.get("sample_size")
    extracted_metrics: dict[str, JSONValue] = {
        "overall_score": overall,
        "ast_accuracy": get_optional(metrics, "ast_accuracy") or 0,
        "exec_accuracy": get_optional(metrics, "exec_accuracy") or 0,
        "relevance_accuracy": get_optional(metrics, "relevance_accuracy") or 0,
        "total_tests": total_tests,
        "error_analysis": error_analysis or {},
    }
    if sample_ids:
        extracted_metrics["sample_ids"] = sample_ids
    if isinstance(sample_seed, (int, float)):
        extracted_metrics["sample_seed"] = sample_seed
    if isinstance(sample_size, (int, float)):
        extracted_metrics["sample_size"] = sample_size
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics=extracted_metrics,
    )


def _score_from_realm_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="realm:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="realm:root"), ctx="realm:metrics")
    metadata = get_optional(root, "metadata")
    metadata_dict = metadata if isinstance(metadata, dict) else {}
    config = metadata_dict.get("config")
    config_dict = config if isinstance(config, dict) else {}
    use_sample_tasks = bool(config_dict.get("use_sample_tasks"))
    if use_sample_tasks:
        raise ValueError("realm: sample-task run is not publishable as a real harness score")
    overall = expect_float(
        get_required(metrics, "overall_success_rate", ctx="realm:metrics"),
        ctx="realm:overall_success_rate",
    )
    total_tasks = get_optional(metrics, "total_tasks") or 0
    if total_tasks == 0:
        raise ValueError("realm: zero-task score is not publishable")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "total_tasks": total_tasks,
            "passed_tasks": get_optional(metrics, "passed_tasks") or 0,
            "avg_plan_quality": get_optional(metrics, "avg_plan_quality") or 0,
            "avg_efficiency": get_optional(metrics, "avg_efficiency") or 0,
            "use_sample_tasks": use_sample_tasks,
        },
    )


def _score_from_mint_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="mint:root")

    def get_config(config_key: str) -> tuple[float, int, int] | None:
        cr_raw = get_optional(root, config_key)
        if cr_raw is None:
            return None
        cr = expect_dict(cr_raw, ctx=f"mint:{config_key}")
        metrics = expect_dict(get_required(cr, "metrics", ctx=f"mint:{config_key}"), ctx=f"mint:{config_key}.metrics")
        rate = expect_float(
            get_required(metrics, "overall_success_rate", ctx=f"mint:{config_key}.metrics"),
            ctx=f"mint:{config_key}.overall_success_rate",
        )
        total_tasks = int(get_optional(metrics, "total_tasks") or 0)
        passed_tasks = int(get_optional(metrics, "passed_tasks") or 0)
        return rate, total_tasks, passed_tasks

    candidates: list[tuple[str, float, int, int]] = []
    for config_key, label in (
        ("baseline_results", "baseline"),
        ("feedback_only_results", "feedback"),
        ("full_results", "full"),
    ):
        config = get_config(config_key)
        if config is not None:
            rate, total_tasks, passed_tasks = config
            if total_tasks > 0:
                candidates.append((label, rate, total_tasks, passed_tasks))

    if not candidates:
        raise ValueError("mint: zero-task score is not publishable")
    best_configuration, chosen, total_tasks, passed_tasks = max(
        candidates, key=lambda item: item[1]
    )

    return ScoreExtraction(
        score=chosen,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": chosen,
            "best_configuration": best_configuration,
            "total_tasks": total_tasks,
            "passed_tasks": passed_tasks,
        },
    )


def _score_from_agentbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="agentbench:root")
    overall = expect_float(
        get_required(root, "overall_success_rate", ctx="agentbench:root"),
        ctx="agentbench:overall_success_rate",
    )
    total = expect_float(
        get_required(root, "total_tasks", ctx="agentbench:root"),
        ctx="agentbench:total_tasks",
    )
    if total <= 0:
        raise ValueError("agentbench: zero-task score is not publishable")
    passed = root.get("passed_tasks")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "total_tasks": total,
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
    total_tasks = expect_float(
        get_required(metrics, "total_tasks", ctx="context_bench:metrics"),
        ctx="context_bench:total_tasks",
    )
    if total_tasks <= 0:
        raise ValueError("context_bench: zero-task score is not publishable")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "lost_in_middle_score": metrics.get("lost_in_middle_score") or 0,
            "total_tasks": total_tasks,
        },
    )


def _score_from_recall_json(data: JSONValue) -> ScoreExtraction:
    """recall-bench (#9956): headline score is hybrid Recall@5 over the real
    @elizaos/core document-recall path; surface the per-mode gap + fail-open drop.
    """
    root = expect_dict(data, ctx="recall:root")
    metrics = expect_dict(
        get_required(root, "metrics", ctx="recall:root"), ctx="recall:metrics"
    )
    recall = get_optional(metrics, "overall_recall_at_5")
    if not isinstance(recall, (int, float)):
        # Honesty contract: a null (unmeasured) headline is not publishable.
        raise ValueError("recall: overall_recall_at_5 is null/unmeasured")
    overall = float(recall)
    fail_open = expect_dict(
        get_required(root, "failOpen", ctx="recall:root"), ctx="recall:failOpen"
    )
    corpus = expect_dict(
        get_required(root, "corpus", ctx="recall:root"), ctx="recall:corpus"
    )
    documents = expect_float(
        get_required(corpus, "documents", ctx="recall:corpus"), ctx="recall:documents"
    )
    if documents <= 0:
        raise ValueError("recall: empty corpus score is not publishable")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_recall_at_5": overall,
            "overall_ndcg_at_5": metrics.get("overall_ndcg_at_5"),
            "overall_p95_latency_ms": metrics.get("overall_p95_latency_ms"),
            "fail_open_recall_drop": fail_open.get("recallDrop"),
            "fail_open_observable": fail_open.get("observable"),
            "corpus_documents": documents,
        },
    )


def _score_from_terminalbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="terminal_bench:root")
    summary = expect_dict(get_required(root, "summary", ctx="terminal_bench:root"), ctx="terminal_bench:summary")
    acc = expect_float(
        get_required(summary, "accuracy", ctx="terminal_bench:summary"),
        ctx="terminal_bench:accuracy",
    )
    total_tasks = expect_float(
        get_required(summary, "total_tasks", ctx="terminal_bench:summary"),
        ctx="terminal_bench:total_tasks",
    )
    if total_tasks <= 0:
        raise ValueError("terminal_bench: zero-task score is not publishable")
    results = root.get("results")
    if isinstance(results, list) and results:
        docker_unavailable = [
            item
            for item in results
            if isinstance(item, dict)
            and "Docker daemon is not reachable" in str(item.get("error_message") or "")
        ]
        if len(docker_unavailable) == len(results):
            raise ValueError(
                "terminal_bench: Docker-unavailable task failures are not publishable scores"
            )
    return ScoreExtraction(
        score=acc,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "accuracy": acc,
            "total_tasks": total_tasks,
            "passed_tasks": summary.get("passed_tasks") or 0,
        },
    )


def _score_from_taubench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="tau_bench:root")
    domain_results = root.get("domain_results")
    if isinstance(domain_results, dict):
        errors: list[str] = []
        for domain, rows in domain_results.items():
            if not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                error = row.get("error")
                if isinstance(error, str) and error.strip():
                    task_id = row.get("task_id", "?")
                    trial = row.get("trial", "?")
                    errors.append(f"{domain}#{task_id}/trial={trial}: {error.strip()}")
        if errors:
            raise ValueError("tau_bench: task errors: " + "; ".join(errors[:3]))
    if "overall_success_rate" in root:
        overall = expect_float(
            get_required(root, "overall_success_rate", ctx="tau_bench:root"),
            ctx="tau_bench:overall_success_rate",
        )
    else:
        pass_k = root.get("pass_k")
        pass_k_dict = expect_dict(pass_k, ctx="tau_bench:pass_k") if isinstance(pass_k, dict) else {}
        raw = pass_k_dict.get("1", pass_k_dict.get("pass@1", root.get("avg_reward")))
        if isinstance(raw, dict):
            raw = raw.get("pass_hat_k", raw.get("pass@1", raw.get("score")))
        overall = expect_float(raw, ctx="tau_bench:pass@1")
    num_tasks = expect_float(
        get_required(root, "num_tasks", ctx="tau_bench:root")
        if "num_tasks" in root
        else get_required(root, "total_tasks", ctx="tau_bench:root"),
        ctx="tau_bench:num_tasks",
    )
    if num_tasks <= 0:
        raise ValueError("tau_bench: zero-task score is not publishable")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "overall_tool_accuracy": root.get("overall_tool_accuracy") or 0,
            "overall_policy_compliance": root.get("overall_policy_compliance") or 0,
            "avg_reward": root.get("avg_reward") or 0,
            "num_tasks": num_tasks,
        },
    )


def _score_from_vendingbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="vending_bench:root")
    metrics = expect_dict(get_required(root, "metrics", ctx="vending_bench:root"), ctx="vending_bench:metrics")
    metadata = expect_dict(root.get("metadata") or {}, ctx="vending_bench:metadata")
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
    successful_runs = to_float(metadata.get("successful_runs"))
    total_runs = to_float(metadata.get("total_runs"))
    errored_runs = [
        item
        for item in results
        if isinstance(item, dict) and isinstance(item.get("error"), str) and item.get("error")
    ]
    if total_runs > 0 and successful_runs <= 0:
        raise ValueError("vending_bench: zero successful runs is not publishable")
    if results and len(errored_runs) == len([item for item in results if isinstance(item, dict)]):
        raise ValueError("vending_bench: all runs failed")
    total_revenue = 0.0
    total_incremental_revenue = 0.0
    total_profit = 0.0
    total_items_sold = 0.0
    total_orders = 0.0
    for item in results:
        if not isinstance(item, dict):
            continue
        total_revenue += to_float(item.get("total_revenue"))
        total_incremental_revenue += to_float(
            item.get("incremental_revenue", item.get("incremental_revenue_vs_noop"))
        )
        total_profit += to_float(item.get("profit"))
        total_items_sold += to_float(item.get("items_sold"))
        total_orders += to_float(item.get("orders_placed"))

    run_count = len([item for item in results if isinstance(item, dict)])
    avg_revenue = (total_revenue / run_count) if run_count else to_float(metrics.get("avg_revenue"))
    avg_incremental_revenue = (
        (total_incremental_revenue / run_count)
        if run_count
        else to_float(metrics.get("avg_incremental_revenue"))
    )
    avg_profit = (total_profit / run_count) if run_count else to_float(metrics.get("avg_profit"))
    avg_net_worth = to_float(metrics.get("avg_net_worth"))
    max_net_worth = to_float(metrics.get("max_net_worth"))
    return ScoreExtraction(
        score=avg_net_worth,
        unit="usd_avg_net_worth",
        higher_is_better=True,
        metrics={
            "primary_score_note": "Average final net worth. Incremental revenue over the no-op starter-inventory baseline is retained as a diagnostic metric.",
            "avg_incremental_revenue": avg_incremental_revenue,
            "total_incremental_revenue": total_incremental_revenue,
            "avg_revenue": avg_revenue,
            "total_revenue": total_revenue,
            "avg_profit": avg_profit,
            "max_net_worth": max_net_worth,
            "avg_net_worth": avg_net_worth,
            "successful_runs": successful_runs,
            "total_runs": total_runs,
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
    total_instances = expect_float(
        get_required(summary, "total_instances", ctx="swe_bench:summary"),
        ctx="swe_bench:total_instances",
    )
    if total_instances <= 0:
        raise ValueError("swe_bench: zero-instance score is not publishable")
    return ScoreExtraction(
        score=rr,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "resolve_rate": rr,
            "total_instances": total_instances,
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
    total_tasks = expect_float(
        get_required(root, "total_tasks", ctx="mind2web:root"),
        ctx="mind2web:total_tasks",
    )
    if total_tasks <= 0:
        raise ValueError("mind2web: zero-task score is not publishable")
    return ScoreExtraction(
        score=step_acc,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_step_accuracy": step_acc,
            "overall_element_accuracy": get_optional(root, "overall_element_accuracy") or 0,
            "overall_operation_accuracy": get_optional(root, "overall_operation_accuracy") or 0,
            "overall_task_success_rate": get_optional(root, "overall_task_success_rate") or 0,
            "total_tasks": total_tasks,
        },
    )


def _score_from_visualwebbench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="visualwebbench:root")
    overall = expect_float(
        get_required(root, "overall_accuracy", ctx="visualwebbench:root"),
        ctx="visualwebbench:overall_accuracy",
    )
    total_tasks = expect_float(
        get_required(root, "total_tasks", ctx="visualwebbench:root"),
        ctx="visualwebbench:total_tasks",
    )
    if total_tasks <= 0:
        raise ValueError("visualwebbench: zero-task score is not publishable")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "exact_accuracy": get_optional(root, "exact_accuracy") or 0,
            "choice_accuracy": get_optional(root, "choice_accuracy") or 0,
            "bbox_accuracy": get_optional(root, "bbox_accuracy") or 0,
            "total_tasks": total_tasks,
            "average_latency_ms": get_optional(root, "average_latency_ms") or 0,
        },
    )


def _score_from_vision_language_json(data: JSONValue) -> ScoreExtraction:
    """Extract Vision-Language Bench scores from real runtime reports."""
    root = expect_dict(data, ctx="vision_language:root")
    if root.get("smoke") is True:
        raise ValueError("vision_language: smoke report is not publishable as a real harness score")
    tier = str(get_required(root, "tier", ctx="vision_language:root")).strip().lower()
    runtime_id = str(get_required(root, "runtime_id", ctx="vision_language:root")).strip().lower()
    if tier == "stub" or not runtime_id or runtime_id == "stub" or runtime_id.endswith("-stub"):
        raise ValueError("vision_language: stub runtime report is not publishable as a real harness score")
    sample_count = expect_float(
        get_required(root, "sample_count", ctx="vision_language:root"),
        ctx="vision_language:sample_count",
    )
    if sample_count <= 0:
        raise ValueError("vision_language: zero-sample report is not publishable")
    error_count = expect_float(root.get("error_count") or 0, ctx="vision_language:error_count")
    if error_count >= sample_count:
        raise ValueError("vision_language: all samples errored")
    score = expect_float(
        get_required(root, "score", ctx="vision_language:root"),
        ctx="vision_language:score",
    )
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "tier": root.get("tier") or "",
            "runtime_id": root.get("runtime_id") or "",
            "benchmark": root.get("benchmark") or "",
            "sample_count": sample_count,
            "error_count": error_count,
            "baseline_score": root.get("baseline_score") if root.get("baseline_score") is not None else "",
            "delta": root.get("delta") if root.get("delta") is not None else "",
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
    total_tasks = expect_float(
        get_required(metrics, "total_tasks", ctx="rlm_bench:metrics"),
        ctx="rlm_bench:total_tasks",
    )
    if total_tasks <= 0:
        raise ValueError("rlm_bench: zero-task score is not publishable")
    results_raw = root.get("results")
    if isinstance(results_raw, list) and results_raw:
        if all(isinstance(item, dict) and item.get("error") for item in results_raw):
            raise ValueError("rlm_bench: all tasks failed with runtime errors")

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
            "total_tasks": total_tasks,
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
    messages = root.get("messages")
    cumulative_rewards = root.get("cumulative_rewards")
    if (
        (
            (
                isinstance(messages, list)
                and not messages
                and isinstance(cumulative_rewards, list)
                and not cumulative_rewards
            )
            or (messages is None and cumulative_rewards is None)
        )
        and (final_programs in (None, 0, 0.0))
        and final_reward == 0.0
    ):
        raise ValueError("solana: empty rollout artifact is not publishable")
    normalized_raw = get_optional(root, "normalized_score")
    max_reward_raw = get_optional(root, "max_reward")
    max_reward = 0.0
    if isinstance(max_reward_raw, (int, float)):
        max_reward = float(max_reward_raw)
    else:
        try:
            from benchmarks.solana.skill_templates import (
                get_total_expected_deterministic_reward,
            )

            max_reward = float(get_total_expected_deterministic_reward())
        except Exception:
            max_reward = final_reward if final_reward > 0 else 1.0
    if isinstance(normalized_raw, (int, float)):
        normalized_score = float(normalized_raw)
    else:
        normalized_score = final_reward / max_reward if max_reward > 0 else 0.0
    normalized_score = max(0.0, min(1.0, normalized_score))
    return ScoreExtraction(
        score=normalized_score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "normalized_score": normalized_score,
            "final_reward": final_reward,
            "max_reward": max_reward,
            "raw_unit": "unique_instructions",
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
    total_tasks = expect_float(
        get_required(root, "total_tasks", ctx="osworld:root"),
        ctx="osworld:total_tasks",
    )
    if total_tasks <= 0:
        raise ValueError("osworld: zero-task score is not publishable")
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_success_rate": overall,
            "total_tasks": total_tasks,
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


def _score_from_voicebench_quality_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from VoiceBench-quality results.

    VoiceBench-quality reports a per-suite score in ``[0, 1]`` plus an
    unweighted mean across the suites that ran (mirroring upstream's
    reporting convention). Higher is better.
    """
    root = expect_dict(data, ctx="voicebench_quality:root")
    agent = str(root.get("agent") or "").strip().lower()
    judge_model = str(root.get("judge_model") or "").strip().lower()
    stt_provider = str(root.get("stt_provider") or "").strip().lower()
    is_fixture_result = (
        root.get("mock") is True
        or root.get("fixtures") is True
        or agent == "echo"
        or judge_model == "fixture"
        or stt_provider == "fixture"
    )
    if is_fixture_result:
        raise ValueError(
            "voicebench_quality: mock or fixture result is not publishable as a real harness score"
        )
    score = expect_float(
        get_required(root, "score", ctx="voicebench_quality:root"),
        ctx="voicebench_quality:score",
    )
    per_suite_raw = root.get("per_suite") or {}
    per_suite: dict[str, float] = {}
    if isinstance(per_suite_raw, dict):
        for key, value in per_suite_raw.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                per_suite[str(key)] = float(value)
    metrics: dict[str, JSONValue] = {
        "agent": root.get("agent") or "",
        "judge_model": root.get("judge_model") or "",
        "stt_provider": root.get("stt_provider") or "",
        "mock": root.get("mock") or False,
        "n": root.get("n") or 0,
        "elapsed_s": root.get("elapsed_s") or 0,
    }
    for suite_key, suite_score in per_suite.items():
        metrics[f"suite.{suite_key}"] = suite_score
    return ScoreExtraction(
        score=score,
        unit="score",
        higher_is_better=True,
        metrics=metrics,
    )


def _score_from_mmau_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from MMAU results.

    MMAU is pure MCQ -- scoring is deterministic exact-match on the
    parsed answer letter. We report overall accuracy as the primary
    score and surface per-category accuracy (speech/sound/music) for
    context. Cascaded STT runs will typically lag on the sound and
    music splits; that is a property of the adapter, not the metric.
    """
    root = expect_dict(data, ctx="mmau:root")
    metrics_raw = root.get("metrics")
    if isinstance(metrics_raw, dict):
        root = {**root, **metrics_raw}
    overall = expect_float(
        get_required(root, "overall_accuracy", ctx="mmau:root"),
        ctx="mmau:overall_accuracy",
    )
    total_samples = expect_float(
        get_required(root, "total_samples", ctx="mmau:root"),
        ctx="mmau:total_samples",
    )
    if total_samples <= 0:
        raise ValueError("mmau: zero-sample score is not publishable")
    error_count = expect_float(root.get("error_count") or 0, ctx="mmau:error_count")
    if error_count >= total_samples:
        raise ValueError("mmau: all samples errored")
    by_cat_raw = root.get("accuracy_by_category")
    by_cat = by_cat_raw if isinstance(by_cat_raw, dict) else {}
    summary_raw = root.get("summary")
    summary = summary_raw if isinstance(summary_raw, dict) else {}
    return ScoreExtraction(
        score=overall,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_accuracy": overall,
            "speech_accuracy": by_cat.get("speech") or 0,
            "sound_accuracy": by_cat.get("sound") or 0,
            "music_accuracy": by_cat.get("music") or 0,
            "total_samples": total_samples,
            "error_count": error_count,
            "split": summary.get("split") or "",
            "agent": summary.get("agent") or "",
        },
    )


_MEETING_PROOF_REQUIRED_EVIDENCE = {
    "audio",
    "video",
    "backend_logs",
    "frontend_logs",
    "screenshots",
    "metrics",
    "model_trajectories",
    "transcript_artifact",
    "speaker_profile_artifact",
    "consent_record",
    "retention_artifact",
}

_MEETING_PROOF_REQUIRED_SECTIONS = (
    "scenarios",
    "dataset_sources",
    "capture_paths",
    "speaker_operations",
)

_MEETING_PROOF_REQUIRED_REAL_METRICS = {
    "wer",
    "cer",
    "speaker_attributed_wer",
    "der",
    "jer",
    "overlap_aware_wer",
    "active_speaker_accuracy",
    "voice_profile_false_accept_rate",
    "voice_profile_false_reject_rate",
    "end_of_turn_latency_ms",
    "barge_in_latency_ms",
    "p95_end_to_end_latency_ms",
    "notes_factuality",
    "action_item_extraction",
}

_MEETING_PROOF_REQUIRED_AV_METRICS = {
    "face_count_accuracy",
    "active_speaker_f1",
    "active_speaker_map",
    "audio_video_association_accuracy",
    "off_screen_speaker_detection_accuracy",
    "room_feed_heuristic_precision",
    "room_feed_heuristic_recall",
    "visual_acoustic_disagreement_rate",
}


def _score_from_meeting_transcription_proof_json(data: JSONValue) -> ScoreExtraction:
    """Extract the #12486 meeting transcription proof score.

    The mocked lane is intentionally accepted as a separate smoke/plumbing
    result but marked in metrics as non-publishable. Real product reports must
    carry the publishable flag and evidence-file inventory generated by the CLI.
    """
    root = expect_dict(data, ctx="meeting_transcription_proof:root")
    kind = str(root.get("kind") or "")
    if kind != "meeting_transcription_proof_report":
        raise ValueError("meeting_transcription_proof: unexpected report kind")
    lane = str(get_required(root, "lane", ctx="meeting_transcription_proof:root"))
    if lane not in {"mocked_plumbing", "real_product"}:
        raise ValueError("meeting_transcription_proof: invalid lane")
    score = expect_float(
        get_required(root, "score", ctx="meeting_transcription_proof:root"),
        ctx="meeting_transcription_proof:score",
    )
    metrics = expect_dict(
        get_required(root, "metrics", ctx="meeting_transcription_proof:root"),
        ctx="meeting_transcription_proof:metrics",
    )
    evidence_files = root.get("evidence_files")
    evidence_count = len(evidence_files) if isinstance(evidence_files, dict) else 0
    speaker_name_provenance = root.get("speaker_name_provenance")
    speaker_name_provenance_count = (
        len(speaker_name_provenance) if isinstance(speaker_name_provenance, list) else 0
    )
    audio_visual_cases = root.get("audio_visual_cases")
    audio_visual_case_count = len(audio_visual_cases) if isinstance(audio_visual_cases, list) else 0
    publishable = root.get("publishable") is True
    if lane == "real_product":
        if not publishable:
            raise ValueError("meeting_transcription_proof: real lane must be publishable")
        if not isinstance(evidence_files, dict):
            raise ValueError("meeting_transcription_proof: real lane requires evidence file map")
        missing_evidence = _MEETING_PROOF_REQUIRED_EVIDENCE - set(evidence_files)
        if missing_evidence:
            raise ValueError(
                "meeting_transcription_proof: real lane requires named evidence files "
                f"{sorted(missing_evidence)}"
            )
        for section in _MEETING_PROOF_REQUIRED_SECTIONS:
            rows = expect_list(
                get_required(root, section, ctx="meeting_transcription_proof:root"),
                ctx=f"meeting_transcription_proof:{section}",
            )
            if not rows:
                raise ValueError(f"meeting_transcription_proof: real lane requires non-empty {section}")
        missing_metrics = _MEETING_PROOF_REQUIRED_REAL_METRICS - set(metrics)
        if missing_metrics:
            raise ValueError(
                "meeting_transcription_proof: real lane requires detailed metrics "
                f"{sorted(missing_metrics)}"
            )
        # #12498: the named-evidence gate above (#12502) subsumes the old count
        # check; the speaker-name provenance requirement is additive on top of it.
        if speaker_name_provenance_count < 8:
            raise ValueError("meeting_transcription_proof: real lane requires speaker name provenance")
        if audio_visual_case_count < 7:
            raise ValueError("meeting_transcription_proof: real lane requires audio_visual_cases")
        missing_av_metrics = _MEETING_PROOF_REQUIRED_AV_METRICS - set(metrics)
        if missing_av_metrics:
            raise ValueError(
                "meeting_transcription_proof: real lane requires audio-visual metrics "
                f"{sorted(missing_av_metrics)}"
            )
    elif publishable:
        raise ValueError("meeting_transcription_proof: mocked lane cannot be publishable")

    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "lane": lane,
            "publishable": publishable,
            "evidence_file_count": evidence_count,
            "speaker_name_provenance_count": speaker_name_provenance_count,
            "audio_visual_case_count": audio_visual_case_count,
            "transcript_quality": metrics.get("transcript_quality") or 0,
            "diarization_quality": metrics.get("diarization_quality") or 0,
            "speaker_identity_quality": metrics.get("speaker_identity_quality") or 0,
            "consent_retention_quality": metrics.get("consent_retention_quality") or 0,
            "face_count_accuracy": metrics.get("face_count_accuracy") or 0,
            "active_speaker_f1": metrics.get("active_speaker_f1") or 0,
            "active_speaker_map": metrics.get("active_speaker_map") or 0,
            "audio_video_association_accuracy": metrics.get("audio_video_association_accuracy") or 0,
            "off_screen_speaker_detection_accuracy": metrics.get("off_screen_speaker_detection_accuracy") or 0,
            "room_feed_heuristic_precision": metrics.get("room_feed_heuristic_precision") or 0,
            "room_feed_heuristic_recall": metrics.get("room_feed_heuristic_recall") or 0,
            "visual_acoustic_disagreement_rate": metrics.get("visual_acoustic_disagreement_rate") or 0,
            "provider_mode": root.get("provider_mode") or "",
        },
    )


def _score_from_voicebench_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from VoiceBench results.

    VoiceBench reports latency and transcription quality. The primary
    benchmark score is the normalized transcription quality ratio so
    calibration harnesses have the same 0=wrong, 1=perfect direction as the
    rest of the matrix. Latency stays in metrics for performance comparison.
    """
    root = expect_dict(data, ctx="voicebench:root")
    profile = str(root.get("profile") or "").strip().lower()
    if profile == "mock":
        raise ValueError("voicebench: mock profile result is not publishable as a real harness score")
    if profile != "synthetic-calibration":
        runtime = str(root.get("runtime") or "").strip().lower()
        if runtime != "typescript":
            raise ValueError("voicebench: real score requires the TypeScript runtime artifact")
        if profile not in {"groq", "elevenlabs", "local-cerebras", "local-eliza1"}:
            raise ValueError(
                "voicebench: real score requires a groq, elevenlabs, "
                "local-cerebras, or local-eliza1 profile"
            )
        sample_count = expect_float(
            get_required(root, "sampleCount", ctx="voicebench:root"),
            ctx="voicebench:sampleCount",
        )
        if sample_count <= 0:
            raise ValueError("voicebench: zero-sample result is not publishable")
        results = expect_list(get_required(root, "results", ctx="voicebench:root"), ctx="voicebench:results")
        if not results:
            raise ValueError("voicebench: result records are required for a real harness score")
        dataset_name = str(root.get("datasetName") or "").strip().lower()
        if "mock" in dataset_name or "fixture" in dataset_name:
            raise ValueError("voicebench: mock/fixture dataset result is not publishable")
    summary = expect_dict(get_required(root, "summary", ctx="voicebench:root"), ctx="voicebench:summary")
    if not summary:
        raise ValueError("voicebench: empty summary block")
    mode_key = "simple" if "simple" in summary else next(iter(summary))
    mode_summary = expect_dict(summary[mode_key], ctx=f"voicebench:summary.{mode_key}")
    avg_e2e = expect_float(
        get_required(mode_summary, "avgEndToEndMs", ctx=f"voicebench:summary.{mode_key}"),
        ctx=f"voicebench:summary.{mode_key}.avgEndToEndMs",
    )
    runs = expect_float(mode_summary.get("runs") or 0, ctx=f"voicebench:summary.{mode_key}.runs")
    if runs <= 0:
        raise ValueError("voicebench: summary.runs must be positive")
    quality = expect_float(
        mode_summary.get("transcriptionNormalizedAccuracy", 0.0),
        ctx=f"voicebench:summary.{mode_key}.transcriptionNormalizedAccuracy",
    )
    return ScoreExtraction(
        score=quality,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "mode": mode_key,
            "avgEndToEndMs": avg_e2e,
            "p95EndToEndMs": mode_summary.get("p95EndToEndMs") or 0,
            "p99EndToEndMs": mode_summary.get("p99EndToEndMs") or 0,
            "avgTranscriptionMs": mode_summary.get("avgTranscriptionMs") or 0,
            "avgResponseTtftMs": mode_summary.get("avgResponseTtftMs") or 0,
            "avgVoiceFirstTokenCachedMs": mode_summary.get("avgVoiceFirstTokenCachedMs") or 0,
            "transcriptionNormalizedAccuracy": mode_summary.get("transcriptionNormalizedAccuracy") or 0,
            "runs": runs,
            "profile": root.get("profile") or "",
            "runtime": root.get("runtime") or "",
            "sampleCount": root.get("sampleCount") or 0,
            "datasetName": root.get("datasetName") or "",
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
    total_tasks = expect_float(
        get_required(root, "total_tasks", ctx="webshop:root"),
        ctx="webshop:total_tasks",
    )
    total_trials = expect_float(
        get_required(root, "total_trials", ctx="webshop:root"),
        ctx="webshop:total_trials",
    )
    if total_tasks <= 0 or total_trials <= 0:
        raise ValueError("webshop: zero-task score is not publishable")
    average_reward = expect_float(
        get_required(root, "average_reward", ctx="webshop:root"),
        ctx="webshop:average_reward",
    )
    success_rate = expect_float(
        get_required(root, "success_rate", ctx="webshop:root"),
        ctx="webshop:success_rate",
    )
    return ScoreExtraction(
        score=average_reward,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "success_rate": success_rate,
            "average_reward": average_reward,
            "average_turns": root.get("average_turns") or 0,
            "average_steps": root.get("average_steps") or 0,
            "average_duration_ms": root.get("average_duration_ms") or 0,
            "total_tasks": int(total_tasks),
            "total_trials": int(total_trials),
            "sample": bool(root.get("sample", False)),
            "split": root.get("split") or "",
            "profile": root.get("profile") or "",
            "use_hf": bool(root.get("use_hf", False)),
        },
    )


def _score_from_woobench_json(data: JSONValue) -> ScoreExtraction:
    """Extract normalized WooBench score from its aggregate result JSON."""
    root = expect_dict(data, ctx="woobench:root")
    overall = expect_float(
        get_required(root, "overall_score", ctx="woobench:root"),
        ctx="woobench:overall_score",
    )
    return ScoreExtraction(
        score=overall / 100.0,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "overall_score": overall,
            "revenue_efficiency": get_optional(root, "revenue_efficiency") or 0,
            "resilience_score": get_optional(root, "resilience_score") or 0,
            "failed_scenarios": get_optional(root, "failed_scenarios") or 0,
        },
    )


def _score_from_hyperliquid_bench_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from HyperliquidBench results.

    The benchmark writes one aggregated JSON per ``__main__`` invocation
    containing the average ``final_score`` across all scenarios plus the
    base/bonus/penalty totals from ``hl-evaluator``. Higher is better.
    """
    root = expect_dict(data, ctx="hyperliquid_bench:root")
    demo_mode = get_optional(root, "demo_mode")
    if demo_mode is None:
        demo_mode = True
    if demo_mode is True:
        raise ValueError(
            "hyperliquid_bench: demo-mode result is not publishable as a real harness score"
        )
    scenarios = get_optional(root, "scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError("hyperliquid_bench: missing scenario-level live execution evidence")
    failed = [
        item
        for item in scenarios
        if not (isinstance(item, dict) and item.get("success") is True)
    ]
    if failed:
        raise ValueError("hyperliquid_bench: failed scenarios are not publishable")
    unique_signatures: list[str] = []
    for item in scenarios:
        if not isinstance(item, dict):
            continue
        sigs = item.get("unique_signatures")
        if isinstance(sigs, list):
            unique_signatures.extend(str(sig) for sig in sigs if str(sig).strip())
    if not unique_signatures:
        raise ValueError(
            "hyperliquid_bench: no confirmed live action signatures were recorded"
        )
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
            "demo_mode": demo_mode,
            "canonical_entries": len(set(unique_signatures)),
        },
    )


def _score_from_gauntlet_json(data: JSONValue) -> ScoreExtraction:
    """Extract scores from Solana Gauntlet benchmark results.

    The Gauntlet is a tiered adversarial benchmark for evaluating AI agent
    safety on Solana.  Scores are out of 100 with component weights:
    Task Completion (30%), Safety (40%), Efficiency (20%), Capital (10%).
    """
    root = expect_dict(data, ctx="gauntlet:root")
    metadata = root.get("metadata")
    if isinstance(metadata, dict):
        execution = metadata.get("execution")
        if isinstance(execution, dict) and (
            execution.get("mock_mode") is True or execution.get("offline_mode") is True
        ):
            raise ValueError("gauntlet: mock/offline execution result is not publishable as a real harness score")
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
        score=overall / 100.0,
        unit="ratio",
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
    n_scam = expect_float(metrics.get("n_scam") or 0, ctx="scambench:metrics.n_scam")
    n_legit = expect_float(metrics.get("n_legit") or 0, ctx="scambench:metrics.n_legit")
    if n_scam + n_legit <= 0:
        raise ValueError("scambench: zero-example score is not publishable")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "scam_refuse_rate": metrics.get("scam_refuse_rate") or 0,
            "legit_help_rate": metrics.get("legit_help_rate") or 0,
            "n_scam": n_scam,
            "n_legit": n_legit,
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
    n = expect_float(
        get_required(metrics, "n", ctx="abliteration_robustness:metrics"),
        ctx="abliteration_robustness:metrics.n",
    )
    if n <= 0:
        raise ValueError("abliteration_robustness:metrics.n must be positive")
    return ScoreExtraction(
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score,
            "refusal_rate": metrics.get("refusal_rate") or 0,
            "n": n,
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
    scenarios = get_optional(root, "scenarios")
    if not isinstance(scenarios, list) or len(scenarios) == 0:
        raise ValueError("lifeops_bench:scenarios must contain at least one result")
    seeds = expect_float(
        get_required(root, "seeds", ctx="lifeops_bench:root"),
        ctx="lifeops_bench:seeds",
    )
    if seeds <= 0:
        raise ValueError("lifeops_bench:seeds must be positive")
    return ScoreExtraction(
        score=pass_at_1,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "pass_at_1": pass_at_1,
            "pass_at_k": get_optional(root, "pass_at_k") or 0,
            "seeds": seeds,
            "scenario_count": len(scenarios),
            "total_cost_usd": get_optional(root, "total_cost_usd") or 0,
            "agent_cost_usd": get_optional(root, "agent_cost_usd") or 0,
            "eval_cost_usd": get_optional(root, "eval_cost_usd") or 0,
            "total_latency_ms": get_optional(root, "total_latency_ms") or 0,
            "model_name": get_optional(root, "model_name") or "",
            "judge_model_name": get_optional(root, "judge_model_name") or "",
        },
    )


def _score_from_voiceagentbench_json(data: JSONValue) -> ScoreExtraction:
    """Extract VoiceAgentBench score from its aggregate report JSON.

    The runner writes ``pass_at_1`` (headline), ``pass_at_k`` dict,
    per-suite pass@1, plus the four mean axis scores (tool selection,
    parameter match, coherence, safety). Higher is better; unit is ratio.
    """
    root = expect_dict(data, ctx="voiceagentbench:root")
    model_name = get_optional(root, "model_name") or ""
    if str(model_name).strip().lower() == "mock":
        raise ValueError("voiceagentbench: mock agent result is not publishable as a real harness score")
    stt_provider = str(get_optional(root, "stt_provider") or "").strip().lower()
    if stt_provider == "fixture":
        raise ValueError("voiceagentbench: fixture STT result is not publishable as a real harness score")
    pass_at_1 = expect_float(
        get_required(root, "pass_at_1", ctx="voiceagentbench:root"),
        ctx="voiceagentbench:pass_at_1",
    )
    return ScoreExtraction(
        score=pass_at_1,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "pass_at_1": pass_at_1,
            "mean_tool_selection": get_optional(root, "mean_tool_selection") or 0,
            "mean_parameter_match": get_optional(root, "mean_parameter_match") or 0,
            "mean_coherence": get_optional(root, "mean_coherence") or 0,
            "mean_safety": get_optional(root, "mean_safety") or 0,
            "seeds": get_optional(root, "seeds") or 0,
            "total_latency_ms": get_optional(root, "total_latency_ms") or 0,
            "model_name": get_optional(root, "model_name") or "",
            "judge_model_name": get_optional(root, "judge_model_name") or "",
            "stt_provider": stt_provider,
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
    n = expect_float(get_required(metrics, "n", ctx="mmlu:metrics"), ctx="mmlu:n")
    if n <= 0:
        raise ValueError("mmlu:n must be positive")
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
    n = expect_float(get_required(metrics, "n", ctx="humaneval:metrics"), ctx="humaneval:n")
    if n <= 0:
        raise ValueError("humaneval:n must be positive")
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
    n = expect_float(get_required(metrics, "n", ctx="gsm8k:metrics"), ctx="gsm8k:n")
    if n <= 0:
        raise ValueError("gsm8k:n must be positive")
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
    n = expect_float(get_required(metrics, "n", ctx="mt_bench:metrics"), ctx="mt_bench:n")
    if n <= 0:
        raise ValueError("mt_bench:n must be positive")
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
    n = expect_float(get_required(metrics, "n", ctx="trajectory_replay:metrics"), ctx="trajectory_replay:n")
    if n <= 0:
        raise ValueError("trajectory_replay:n must be positive")
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
    total_float = expect_float(total, ctx="clawbench:total")
    if total_float <= 0:
        raise ValueError("clawbench: zero-check score is not publishable")
    return ScoreExtraction(
        score=score_val,
        unit="ratio",
        higher_is_better=True,
        metrics={
            "score": score_val,
            "passed": passed,
            "total": total_float,
        },
    )


def _score_from_openclaw_bench_json(data: JSONValue) -> ScoreExtraction:
    root = expect_dict(data, ctx="openclaw:root")
    mode = str(get_optional(root, "mode") or "").strip().lower()
    scoring_type = str(get_optional(root, "scoring_type") or "").strip().lower()
    real_validation = get_optional(root, "real_validation")
    if mode == "conceptual" or scoring_type == "conceptual_understanding":
        raise ValueError("openclaw_bench: conceptual result is not publishable as a real harness score")
    if isinstance(real_validation, dict) and real_validation.get("conceptual_scoring") is True:
        raise ValueError("openclaw_bench: conceptual result is not publishable as a real harness score")
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
            "mode": mode or scoring_type or "",
            "harness": get_optional(root, "harness") or "",
            "real_validation": real_validation if isinstance(real_validation, dict) else {},
        },
    )


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
    metric_keys = {str(key) for key in metrics_dict}
    score_metric_keys = {
        "accuracy",
        "pass_rate",
        "avg_composite_score",
        "survival_rate",
        "mean_reward",
        "reward",
        "score",
    }
    if "placeholder" in metric_keys and not (metric_keys & score_metric_keys):
        raise ValueError("hermes_env: placeholder-only score is not publishable")

    def _metric_number(key: str) -> float | None:
        value = metrics_dict.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)

    # A score derived from rollouts that ALL failed to complete is not a real
    # measurement — like the placeholder-only gate above, publishing it would
    # larp a "0.0" the harness never actually measured. Reject when every sampled
    # rollout is incomplete so the run is rerun / manually reviewed instead.
    incomplete_rollouts = _metric_number("incomplete_rollouts")
    sampled = _metric_number("sample_rows")
    if sampled is None:
        sampled = _metric_number("total_tasks")
    if (
        incomplete_rollouts is not None
        and incomplete_rollouts > 0
        and sampled is not None
        and sampled > 0
        and incomplete_rollouts >= sampled
    ):
        raise ValueError(
            "hermes_env: all sampled rollouts are incomplete; a zero from "
            "incomplete rollouts is not a real measurement and is not publishable"
        )

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
