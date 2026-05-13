"""Benchmark registry package.

Splits the original monolithic registry.py into:
  registry/scores.py   — score extraction functions (_score_from_*)
  registry/commands.py — get_benchmark_registry() + load_benchmark_result_json()

All public names are re-exported here so existing imports continue to work:
  from benchmarks.registry import get_benchmark_registry
  from benchmarks.registry import load_benchmark_result_json
  from benchmarks.registry import _score_from_solana_json   # etc.

Standalone-mode callers (e.g. orchestrator scripts that do
``from registry import X`` with benchmarks/ on sys.path) also work because
Python resolves ``registry`` to this package when benchmarks/ is on the path.
"""

from __future__ import annotations

from .commands import (
    get_benchmark_registry,
    load_benchmark_result_json,
)

from .scores import (
    _score_from_abliteration_robustness_json,
    _score_from_action_calling_json,
    _score_from_agentbench_json,
    _score_from_bfcl_json,
    _score_from_clawbench_json,
    _score_from_configbench_json,
    _score_from_contextbench_json,
    _score_from_eliza_format_json,
    _score_from_gaia_json,
    _score_from_gauntlet_json,
    _score_from_gsm8k_json,
    _score_from_hermes_env_json,
    _score_from_humaneval_json,
    _score_from_hyperliquid_bench_json,
    _score_from_lifeops_bench_json,
    _score_from_mind2web_json,
    _score_from_mint_json,
    _score_from_mmau_json,
    _score_from_mmlu_json,
    _score_from_mt_bench_json,
    _score_from_openclaw_bench_json,
    _score_from_orchestrator_lifecycle_json,
    _score_from_osworld_json,
    _score_from_realm_json,
    _score_from_rlmbench_json,
    _score_from_scambench_json,
    _score_from_social_alpha_json,
    _score_from_solana_json,
    _score_from_swebench_json,
    _score_from_swebench_orchestrated_json,
    _score_from_taubench_json,
    _score_from_terminalbench_json,
    _score_from_trajectory_replay_json,
    _score_from_trust_json,
    _score_from_vendingbench_json,
    _score_from_visualwebbench_json,
    _score_from_voiceagentbench_json,
    _score_from_voicebench_json,
    _score_from_voicebench_quality_json,
    _score_from_webshop_json,
    _score_from_woobench_json,
    _standard_benchmark_metrics,
)

__all__ = [
    "get_benchmark_registry",
    "load_benchmark_result_json",
    "_score_from_abliteration_robustness_json",
    "_score_from_action_calling_json",
    "_score_from_agentbench_json",
    "_score_from_bfcl_json",
    "_score_from_clawbench_json",
    "_score_from_configbench_json",
    "_score_from_contextbench_json",
    "_score_from_eliza_format_json",
    "_score_from_gaia_json",
    "_score_from_gauntlet_json",
    "_score_from_gsm8k_json",
    "_score_from_hermes_env_json",
    "_score_from_humaneval_json",
    "_score_from_hyperliquid_bench_json",
    "_score_from_lifeops_bench_json",
    "_score_from_mind2web_json",
    "_score_from_mint_json",
    "_score_from_mmau_json",
    "_score_from_mmlu_json",
    "_score_from_mt_bench_json",
    "_score_from_openclaw_bench_json",
    "_score_from_orchestrator_lifecycle_json",
    "_score_from_osworld_json",
    "_score_from_realm_json",
    "_score_from_rlmbench_json",
    "_score_from_scambench_json",
    "_score_from_social_alpha_json",
    "_score_from_solana_json",
    "_score_from_swebench_json",
    "_score_from_swebench_orchestrated_json",
    "_score_from_taubench_json",
    "_score_from_terminalbench_json",
    "_score_from_trajectory_replay_json",
    "_score_from_trust_json",
    "_score_from_vendingbench_json",
    "_score_from_visualwebbench_json",
    "_score_from_voiceagentbench_json",
    "_score_from_voicebench_json",
    "_score_from_voicebench_quality_json",
    "_score_from_webshop_json",
    "_score_from_woobench_json",
    "_standard_benchmark_metrics",
]
