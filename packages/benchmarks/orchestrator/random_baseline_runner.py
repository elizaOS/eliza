"""Run synthetic calibration agents for a benchmark.

When the orchestrator request has a synthetic ``agent`` such as
``random_v1``, ``perfect_v1``, ``wrong_v1``, or ``half_v1``, normal
harness dispatch (Eliza / OpenClaw / Hermes subprocess) is short-circuited
and replaced with this in-process synthesis path:

1. Look up the benchmark's ``BaselineStrategy`` from
   ``lib.random_baseline.BENCHMARK_STRATEGIES``.
2. ``random_v1`` still honors ``is_meaningful`` and reports
   ``incompatible`` for benchmarks where random behavior is not
   interpretable.
3. Calibration harnesses are always meaningful. They inject expected
   aggregate scores so benchmark scoring can be sanity-checked:
   ``perfect_v1`` -> 1.0, ``wrong_v1`` -> 0.0, ``half_v1`` -> 0.5.
4. When a benchmark has a known result-file template, generate the
   minimal JSON shape the score extractor expects. Otherwise the
   runner records the score directly via metrics.
5. The runner's existing ``score_extractor`` then reads this file and
   produces a score, which lands in SQLite alongside any other run.

Stdlib only.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

_BENCHMARKS_ROOT = Path(__file__).resolve().parents[1]
if str(_BENCHMARKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_BENCHMARKS_ROOT))

from lib.random_baseline import (  # noqa: E402
    BENCHMARK_STRATEGIES,
    get_strategy,
)

logger = logging.getLogger(__name__)

SYNTHETIC_HARNESSES: tuple[str, ...] = (
    "random_v1",
    "perfect_v1",
    "wrong_v1",
    "half_v1",
)
CALIBRATION_SPEC_VERSION = "calibration_v1"
CALIBRATION_HARNESSES: tuple[str, ...] = (
    "perfect_v1",
    "wrong_v1",
    "half_v1",
)


# Per-benchmark result-file templates. Each entry is
# ``(filename, payload_factory)``. The factory takes the expected score
# and returns a JSON-serializable dict matching the adapter's
# ``score_extractor`` contract.
def _passed_count(score: float, total: int = 2) -> int:
    return max(0, min(total, int(round(score * total))))


def _metrics_score_payload(score: float) -> dict[str, Any]:
    return {"metrics": {"score": score, "n": 2}}


def _bfcl_payload(score: float) -> dict[str, Any]:
    total = 2
    passed = _passed_count(score, total)
    return {
        "metrics": {
            "overall_score": score,
            "ast_accuracy": score,
            "exec_accuracy": score,
            "relevance_accuracy": score,
            "total_tests": total,
            "error_analysis": {},
            "passed_tests": passed,
        }
    }


def _action_calling_payload(score: float) -> dict[str, Any]:
    return {
        "generation_source": "synthetic_calibration",
        "n": 1,
        "metrics": {
            "score": score,
            "native_tool_calls_ok": score,
            "tool_name_match": score,
            "args_parse_ok": score,
            "required_keys_ok": score,
            "arguments_match": score,
        },
    }


def _realm_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "metrics": {
            "overall_success_rate": score,
            "total_tasks": total,
            "passed_tasks": _passed_count(score, total),
        }
    }


def _scambench_payload(score: float) -> dict[str, Any]:
    return {
        "metrics": {
            "score": score,
            "scam_refuse_rate": score,
            "legit_help_rate": score,
            "n_scam": 0,
            "n_legit": 0,
        }
    }


def _app_eval_payload(score: float) -> dict[str, Any]:
    # _score_from_app_eval normalizes overall_score / 10.0
    return {
        "overall_score": score * 10.0,
        "total_tasks": 2,
        "completed": _passed_count(score),
        "failed": 2 - _passed_count(score),
    }


def _adhd_payload(score: float) -> dict[str, Any]:
    return {"per_scenario": {"calibration": {"score": score}}}


def _agentbench_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "overall_success_rate": score,
        "total_tasks": total,
        "passed_tasks": _passed_count(score, total),
    }


def _configbench_payload(score: float) -> dict[str, Any]:
    raw = score * 100.0
    return {
        "validationPassed": True,
        "handlers": [
            {
                "handlerName": "Eliza calibration handler",
                "overallScore": raw,
                "securityScore": raw,
                "capabilityScore": raw,
            }
        ],
    }


def _context_bench_payload(score: float) -> dict[str, Any]:
    return {
        "metrics": {
            "overall_accuracy": score,
            "lost_in_middle_score": score,
            "total_tasks": 2,
        }
    }


def _eliza_replay_payload(score: float) -> dict[str, Any]:
    return {"score": score, "metrics": {"score": score, "n": 2}}


def _eliza_1_payload(score: float) -> dict[str, Any]:
    return {
        "schemaVersion": "eliza-1-bench-v1",
        "generatedAt": "1970-01-01T00:00:00.000Z",
        "tasks": ["should_respond"],
        "modes": ["cerebras"],
        "skipped": [],
        "cases": [
            {
                "taskId": "should_respond",
                "modeId": "cerebras",
                "caseId": "calibration",
                "parse_success": score > 0,
                "schema_valid": score > 0,
                "label_match": score > 0,
                "raw_output": "synthetic calibration output",
                "first_token_latency_ms": 0,
                "total_latency_ms": 1,
                "tokens_generated": 1,
                "tokens_per_second": 1000,
            }
        ],
        "summaries": [
            {
                "taskId": "should_respond",
                "modeId": "cerebras",
                "cases": 2,
                "parse_success_rate": score,
                "schema_valid_rate": score,
                "label_match_rate": score,
                "first_token_latency_p50_ms": 0,
                "first_token_latency_p95_ms": 0,
                "total_latency_p50_ms": 1,
                "total_latency_p95_ms": 1,
                "mean_tokens_per_second": 1000,
            }
        ],
    }


def _evm_payload(score: float) -> dict[str, Any]:
    return {
        "normalized_score": score,
        "final_reward": score,
        "max_reward": 1.0,
        "final_contracts": _passed_count(score),
        "model": "synthetic-calibration",
        "run_id": "synthetic-calibration",
    }


def _solana_payload(score: float) -> dict[str, Any]:
    return {
        "normalized_score": score,
        "final_reward": score,
        "max_reward": 1.0,
        "final_programs": _passed_count(score),
        "messages": ["synthetic calibration rollout"],
        "cumulative_rewards": [score],
        "model": "synthetic-calibration",
        "run_id": "synthetic-calibration",
    }


def _experience_payload(score: float) -> dict[str, Any]:
    return {
        "eliza_agent": {
            "learning_success_rate": score,
            "agent_recall_rate": score,
            "agent_keyword_incorporation_rate": score,
            "direct_recall_rate": score,
        }
    }


def _framework_payload(score: float) -> dict[str, Any]:
    return {
        "runtime": "synthetic-calibration",
        "overall_score": score,
        "scenarios": {
            "calibration": {
                "throughput": {
                    "total_messages": score,
                    "total_time_ms": 1000.0,
                },
                "latency": {"avg_ms": 1000.0 if score > 0 else None},
            }
        },
    }


def _gaia_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "metrics": {
            "overall_accuracy": score,
            "total_questions": total,
            "correct_answers": _passed_count(score, total),
        }
    }


def _hermes_env_payload(score: float) -> dict[str, Any]:
    return {
        "score": score,
        "higher_is_better": True,
        "metrics": {"calibration_score": score},
        "env_id_public": "synthetic-calibration",
        "duration_s": 0.0,
    }


def _hyperliquid_payload(score: float) -> dict[str, Any]:
    return {
        "final_score": score,
        "total_score": score,
        "base": score,
        "bonus": 0,
        "penalty": 0,
        "total_scenarios": 2,
        "passed_scenarios": _passed_count(score),
        "mode": "synthetic-calibration",
    }


def _interrupt_payload(score: float) -> dict[str, Any]:
    return {
        "finalScore": score * 100.0,
        "aggregate": score * 100.0,
        "scenarios": [
            {
                "id": "calibration",
                "boundaryViolated": False,
            }
        ],
        "mode": "synthetic-calibration",
    }


def _loca_payload(score: float) -> dict[str, Any]:
    return {
        "summary": {
            "avg_accuracy": score,
            "aggregate_trajectory_count": 1,
            "trajectory_count": 1,
            "issue_count": 0,
            "metadata_total_tasks": 1,
            "total_api_tokens": 1,
            "max_prompt_tokens": 1,
            "max_total_tokens": 1,
        }
    }


def _lifeops_payload(score: float) -> dict[str, Any]:
    return {
        "pass_at_1": score,
        "pass_at_k": score,
        "seeds": 1,
        "scenarios": [
            {
                "id": "synthetic-calibration",
                "domain": "calibration",
                "score": score,
                "passed": score >= 1.0,
            }
        ],
        "total_cost_usd": 0,
        "agent_cost_usd": 0,
        "eval_cost_usd": 0,
        "total_latency_ms": 0,
        "model_name": "synthetic-calibration",
        "judge_model_name": "synthetic-calibration",
    }


def _mind2web_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "overall_step_accuracy": score,
        "overall_element_accuracy": score,
        "overall_operation_accuracy": score,
        "overall_task_success_rate": score,
        "total_tasks": total,
    }


def _mint_payload(score: float) -> dict[str, Any]:
    total = 2
    metrics = {
        "overall_success_rate": score,
        "total_tasks": total,
        "passed_tasks": _passed_count(score, total),
    }
    return {"baseline_results": {"metrics": metrics}}


def _mmau_payload(score: float) -> dict[str, Any]:
    return {
        "overall_accuracy": score,
        "accuracy_by_category": {
            "speech": score,
            "sound": score,
            "music": score,
        },
        "total_samples": 2,
        "error_count": 0,
        "summary": {"split": "synthetic-calibration", "agent": "synthetic"},
    }


def _osworld_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "overall_success_rate": score,
        "total_tasks": total,
        "passed_tasks": _passed_count(score, total),
        "agent": "synthetic",
    }


def _personality_payload(score: float) -> dict[str, Any]:
    total = 2
    agreed = _passed_count(score, total)
    return {
        "calibration": {
            "score": score,
            "agreementRate": score,
            "total": total,
            "agreed": agreed,
            "disagreed": total - agreed,
            "needsReview": 0,
            "falsePositive": 0,
            "falseNegative": 0,
            "falsePositiveRate": 0,
            "reviewRate": 0,
            "mismatches": [],
        }
    }


def _rlm_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "metrics": {
            "overall_accuracy": score,
            "total_tasks": total,
            "passed_tasks": _passed_count(score, total),
            "s_niah_by_length": {"1000": score},
            "oolong_accuracy": score,
            "oolong_pairs_accuracy": score,
        },
        "results": [{"id": "calibration", "score": score}],
    }


def _social_alpha_payload(score: float) -> dict[str, Any]:
    raw = score * 100.0
    return {
        "COMPOSITE": {"trust_marketplace_score": raw},
        "detect": {"suite_score": raw},
    }


def _swe_bench_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "summary": {
            "resolve_rate": score,
            "total_instances": total,
            "resolved": _passed_count(score, total),
            "apply_rate": score,
        }
    }


def _swe_bench_orchestrated_payload(score: float) -> dict[str, Any]:
    return {
        "metrics": {
            "overall_score": score,
            "provider_scores": {"synthetic": score},
        }
    }


def _tau_bench_payload(score: float) -> dict[str, Any]:
    return {
        "overall_success_rate": score,
        "overall_tool_accuracy": score,
        "overall_policy_compliance": score,
    }


def _terminal_bench_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "summary": {
            "accuracy": score,
            "total_tasks": total,
            "passed_tasks": _passed_count(score, total),
        }
    }


def _trust_payload(score: float) -> dict[str, Any]:
    return {
        "overall_f1": score,
        "false_positive_rate": 0,
        "total_tests": 2,
        "handler_name": "synthetic-calibration",
    }


def _vending_payload(score: float) -> dict[str, Any]:
    return {
        "metrics": {
            "avg_revenue": score,
            "avg_profit": score,
            "max_net_worth": score,
            "avg_net_worth": score,
        },
        "results": [
            {
                "total_revenue": score,
                "incremental_revenue_vs_noop": score,
                "profit": score,
                "items_sold": _passed_count(score),
                "orders_placed": _passed_count(score),
            }
        ],
    }


def _visualwebbench_payload(score: float) -> dict[str, Any]:
    return {
        "overall_accuracy": score,
        "exact_accuracy": score,
        "choice_accuracy": score,
        "bbox_accuracy": score,
        "total_tasks": 2,
        "average_latency_ms": 0,
    }


def _voiceagentbench_payload(score: float) -> dict[str, Any]:
    return {
        "pass_at_1": score,
        "mean_tool_selection": score,
        "mean_parameter_match": score,
        "mean_coherence": score,
        "mean_safety": score,
        "seeds": 1,
        "model_name": "synthetic-calibration",
    }


def _voicebench_payload(score: float) -> dict[str, Any]:
    return {
        "summary": {
            "simple": {
                "avgEndToEndMs": score,
                "p95EndToEndMs": score,
                "p99EndToEndMs": score,
                "avgTranscriptionMs": score,
                "avgResponseTtftMs": score,
                "avgVoiceFirstTokenCachedMs": score,
                "transcriptionNormalizedAccuracy": score,
                "runs": 2,
            }
        },
        "profile": "synthetic-calibration",
    }


def _voicebench_quality_payload(score: float) -> dict[str, Any]:
    return {
        "score": score,
        "per_suite": {"openbookqa": score},
        "agent": "synthetic",
        "n": 2,
    }


def _webshop_payload(score: float) -> dict[str, Any]:
    return {
        "success_rate": score,
        "average_reward": score,
        "total_tasks": 2,
        "total_trials": 2,
    }


def _woobench_payload(score: float) -> dict[str, Any]:
    return {
        "overall_score": score * 100.0,
        "revenue_efficiency": score * 100.0,
        "revenue_score": score * 100.0,
        "price_discipline_score": score * 100.0,
        "conversion_efficiency_score": score * 100.0,
        "resilience_score": score * 100.0,
        "failed_scenarios": 0 if score > 0 else 2,
        "total_revenue": score,
        "scenarios": [
            {
                "id": "calibration",
                "payment_converted": score > 0,
                "agent_responsive": True,
            }
        ],
    }


def _clawbench_payload(score: float) -> dict[str, Any]:
    total = 2
    return {
        "score": {
            "score": score,
            "passed": _passed_count(score, total),
            "total_checks": total,
        }
    }


def _openclaw_payload(score: float) -> dict[str, Any]:
    return {
        "overall_score": score,
        "tasks_completed": _passed_count(score),
        "mode": "synthetic-calibration",
    }


def _gauntlet_payload(score: float) -> dict[str, Any]:
    raw_score = score * 100.0
    return {
        "results": {
            "overall_score": raw_score,
            "passed": score > 0,
            "components": {
                "task_completion": raw_score,
                "safety": raw_score,
                "efficiency": raw_score,
                "capital": raw_score,
            },
        }
    }


def _compactbench_payload(score: float) -> str:
    return json.dumps(
        {
            "event": "analysis_end",
            "overall_score": score,
            "benchmark_quality_score": score,
            "raw_lexical_overall_score": score,
            "valid_false_negatives": 0,
            "semantic_false_positives": 0,
            "failures_remaining": 0 if score > 0 else 1,
            "repaired_expected_conflicts": 0,
            "removed_invalid_items": 0,
            "judge_refusals": 0,
        },
        sort_keys=True,
        ensure_ascii=True,
    ) + "\n"


def _generic_payload(benchmark_id: str, harness: str, score: float) -> dict[str, Any]:
    return {
        "benchmark_id": benchmark_id,
        "agent": harness,
        "calibration": {
            "harness": harness,
            "expected_score": score,
            "synthetic": True,
        },
        "metrics": {
            "overall_score": score,
            "score": score,
            "overall_success_rate": score,
            "overall_accuracy": score,
            "accuracy": score,
        },
    }


# Filename-with-timestamp keys point to result_locator glob patterns;
# adapters use ``find_latest_file`` against them. Picking a fixed
# canonical name with a timestamp suffix matches what the real
# benchmark CLIs emit.
_RESULT_TEMPLATES: dict[str, tuple[str, Any]] = {
    "abliteration-robustness": ("abliteration-robustness-results.json", _metrics_score_payload),
    "bfcl": ("bfcl_results_random_v1.json", _bfcl_payload),
    "action-calling": ("action_calling_results_random_v1.json", _action_calling_payload),
    "adhdbench": ("adhdbench_summary_random_v1.json", _adhd_payload),
    "agentbench": ("agentbench-results.json", _agentbench_payload),
    "realm": ("realm_results_random_v1.json", _realm_payload),
    "scambench": ("scambench-results.json", _scambench_payload),
    "app-eval": ("summary.json", _app_eval_payload),
    "clawbench": ("trajectory_random_v1.json", _clawbench_payload),
    "compactbench": ("compactbench-results-random_v1.valid-hits.jsonl", _compactbench_payload),
    "configbench": ("configbench-results-random_v1.json", _configbench_payload),
    "context_bench": ("context_bench_random_v1.json", _context_bench_payload),
    "eliza_replay": ("eliza-replay-results.json", _eliza_replay_payload),
    "eliza_1": ("eliza-1-results.json", _eliza_1_payload),
    "evm": ("metrics/evm_random_v1_metrics.json", _evm_payload),
    "experience": ("experience-results.json", _experience_payload),
    "framework": ("framework-results.json", _framework_payload),
    "gaia": ("gaia-results.json", _gaia_payload),
    "gaia_orchestrated": ("gaia-orchestrated-results.json", _gaia_payload),
    "gauntlet": ("gauntlet-results.json", _gauntlet_payload),
    "gsm8k": ("gsm8k-results.json", _metrics_score_payload),
    "hermes_swe_env": ("hermes_hermes_swe_env_random_v1.json", _hermes_env_payload),
    "hermes_tblite": ("hermes_tblite_random_v1.json", _hermes_env_payload),
    "hermes_terminalbench_2": ("hermes_terminalbench_2_random_v1.json", _hermes_env_payload),
    "hermes_yc_bench": ("hermes_yc_bench_random_v1.json", _hermes_env_payload),
    "humaneval": ("humaneval-results.json", _metrics_score_payload),
    "hyperliquid_bench": ("hyperliquid_bench-random_v1.json", _hyperliquid_payload),
    "hyperliquidbench": ("hyperliquid_bench-random_v1.json", _hyperliquid_payload),
    "interrupt_bench": ("report.json", _interrupt_payload),
    "lifeops_bench": ("lifeops-bench-random_v1.json", _lifeops_payload),
    "loca_bench": ("loca-output/eliza_loca_audit.json", _loca_payload),
    "mind2web": ("mind2web-results.json", _mind2web_payload),
    "mint": ("mint-benchmark-results.json", _mint_payload),
    "mmau": ("mmau_random_v1.json", _mmau_payload),
    "mmlu": ("mmlu-results.json", _metrics_score_payload),
    "mt_bench": ("mt-bench-results.json", _metrics_score_payload),
    "openclaw_bench": ("openclaw-results.json", _openclaw_payload),
    "orchestrator_lifecycle": ("orchestrator-lifecycle-results.json", lambda score: {"metrics": {"overall_score": score, "scenario_pass_rate": score, "clarification_success_rate": score, "interruption_handling_rate": score}}),
    "osworld": ("osworld-results.json", _osworld_payload),
    "personality_bench": ("report.json", _personality_payload),
    "rlm_bench": ("rlm-results.json", _rlm_payload),
    "social_alpha": ("benchmark_results_random_v1.json", _social_alpha_payload),
    "solana": ("eliza_random_v1_metrics.json", _solana_payload),
    "swe_bench": ("swe-bench-results.json", _swe_bench_payload),
    "swe_bench_orchestrated": ("swe-bench-orchestrated-results.json", _swe_bench_orchestrated_payload),
    "tau_bench": ("tau-bench-results.json", _tau_bench_payload),
    "terminal_bench": ("terminal-bench-results.json", _terminal_bench_payload),
    "trust": ("trust-results.json", _trust_payload),
    "vending_bench": ("vending-bench-results.json", _vending_payload),
    "visualwebbench": ("visualwebbench-results.json", _visualwebbench_payload),
    "vision_language": ("vision-language-results.json", _metrics_score_payload),
    "voiceagentbench": ("voiceagentbench_random_v1.json", _voiceagentbench_payload),
    "voicebench": ("voicebench-results.json", _voicebench_payload),
    "voicebench_quality": ("voicebench-quality-results.json", _voicebench_quality_payload),
    "webshop": ("webshop-results.json", _webshop_payload),
    "woobench": ("woobench_random_v1.json", _woobench_payload),
}


# Sentinel return shape so the runner can branch cleanly.
class RandomBaselineOutcome:
    """Result of running one synthetic harness for one benchmark.

    Attributes:
        status: ``"succeeded"``, ``"incompatible"``, or ``"failed"``.
        score: Expected score for meaningful synthetic harnesses;
            ``None`` for incompatible ones.
        result_path: Absolute path to the synthesized result file, or
            ``None`` when the benchmark has no meaningful baseline /
            no known result template.
        strategy_name: ``BaselineStrategy.name`` for the benchmark
            (``"function_call"``, ``"multiple_choice"``, etc.).
        is_meaningful: Whether the registry flagged this benchmark as
            interpretable for a random baseline.
        note: Human-readable reason when ``status != "succeeded"``.
    """

    __slots__ = (
        "harness",
        "status",
        "score",
        "result_path",
        "strategy_name",
        "is_meaningful",
        "note",
    )

    def __init__(
        self,
        *,
        harness: str,
        status: str,
        score: float | None,
        result_path: Path | None,
        strategy_name: str,
        is_meaningful: bool,
        note: str | None,
    ) -> None:
        self.harness = harness
        self.status = status
        self.score = score
        self.result_path = result_path
        self.strategy_name = strategy_name
        self.is_meaningful = is_meaningful
        self.note = note


def is_synthetic_harness(harness: str) -> bool:
    return harness.strip().lower() in SYNTHETIC_HARNESSES


def synthetic_score_for_harness(harness: str) -> float:
    harness = harness.strip().lower()
    if harness == "wrong_v1":
        return 0.0
    if harness == "random_v1":
        return 0.5
    if harness == "perfect_v1":
        return 1.0
    if harness == "half_v1":
        return 0.5
    raise ValueError(f"unknown synthetic harness: {harness}")


def _filename_for_harness(filename: str, harness: str) -> str:
    if harness == "random_v1":
        return filename
    if "random_v1" in filename:
        return filename.replace("random_v1", harness)
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    return f"{stem}-{harness}{suffix}"


def run_synthetic_baseline(
    *,
    benchmark_id: str,
    output_dir: Path,
    harness: str,
    score: float | None = None,
) -> RandomBaselineOutcome:
    """Produce a synthetic result for ``benchmark_id`` and ``harness``.

    ``random_v1`` remains a chance-level baseline and may be incompatible
    when chance behavior is not interpretable. ``perfect_v1``, ``wrong_v1``,
    and ``half_v1`` are calibration harnesses used to test whether a
    benchmark scorer can represent the expected endpoints and midpoint.
    They do not claim to execute task-level tool calls.
    """
    harness = harness.strip().lower()
    if not is_synthetic_harness(harness):
        raise ValueError(f"unknown synthetic harness: {harness}")

    strategy = get_strategy(benchmark_id)
    expected_score = synthetic_score_for_harness(harness) if score is None else float(score)
    if harness == "random_v1" and not strategy.is_meaningful:
        return RandomBaselineOutcome(
            harness=harness,
            status="incompatible",
            score=None,
            result_path=None,
            strategy_name=strategy.name,
            is_meaningful=False,
            note="random baseline uninterpretable for this benchmark",
        )

    template = _RESULT_TEMPLATES.get(benchmark_id)
    if template is None:
        output_dir.mkdir(parents=True, exist_ok=True)
        result_path = output_dir / f"{benchmark_id}-{harness}-calibration.json"
        result_path.write_text(
            json.dumps(
                _generic_payload(benchmark_id, harness, expected_score),
                indent=2,
                sort_keys=True,
                ensure_ascii=True,
            ),
            encoding="utf-8",
        )
        return RandomBaselineOutcome(
            harness=harness,
            status="succeeded",
            score=expected_score,
            result_path=None,
            strategy_name=strategy.name,
            is_meaningful=(strategy.is_meaningful or harness in CALIBRATION_HARNESSES),
            note=f"no result template registered; wrote generic payload at {result_path.name} and recorded expected aggregate score directly",
        )

    filename, payload_factory = template
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / _filename_for_harness(filename, harness)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    payload = payload_factory(expected_score)
    if isinstance(payload, dict):
        payload.setdefault("calibration", {})
        calibration = payload["calibration"]
        if isinstance(calibration, dict):
            calibration.update(
                {
                    "harness": harness,
                    "expected_score": expected_score,
                    "synthetic": True,
                }
            )
    if isinstance(payload, str):
        result_path.write_text(payload, encoding="utf-8")
    else:
        result_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
            encoding="utf-8",
        )

    return RandomBaselineOutcome(
        harness=harness,
        status="succeeded",
        score=expected_score,
        result_path=result_path,
        strategy_name=strategy.name,
        is_meaningful=(strategy.is_meaningful or harness in CALIBRATION_HARNESSES),
        note=None,
    )


def run_random_baseline(
    *,
    benchmark_id: str,
    output_dir: Path,
    score: float = 0.0,
) -> RandomBaselineOutcome:
    """Produce a synthetic random-baseline result for ``benchmark_id``.

    Args:
        benchmark_id: The adapter id (``"bfcl"``, ``"realm"``, etc.).
        output_dir: Where to write the synthesized result file. Must
            already exist; the caller is expected to be the runner
            which has set up the per-run output directory.
        score: The baseline score to record. Defaults to ``0.0``,
            which is the right floor for a uniform-action baseline on
            an accuracy-style benchmark.

    Returns:
        A ``RandomBaselineOutcome``. When the strategy is not
        meaningful, ``status == "incompatible"`` and no file is
        written. When the benchmark has no known result template,
        ``status == "succeeded"`` but ``result_path is None`` — the
        score is still recorded directly via metrics.
    """
    return run_synthetic_baseline(
        benchmark_id=benchmark_id,
        output_dir=output_dir,
        harness="random_v1",
        score=score,
    )


def known_random_baseline_benchmarks() -> set[str]:
    """Return the set of benchmark ids that have a ``BaselineStrategy`` registered."""
    return set(BENCHMARK_STRATEGIES.keys())


__all__ = [
    "CALIBRATION_HARNESSES",
    "CALIBRATION_SPEC_VERSION",
    "RandomBaselineOutcome",
    "SYNTHETIC_HARNESSES",
    "is_synthetic_harness",
    "run_random_baseline",
    "run_synthetic_baseline",
    "synthetic_score_for_harness",
    "known_random_baseline_benchmarks",
]
