"""CI-lane coverage classification for every public benchmark (#9475, #10193).

The de-larp audit found that nearly every registered benchmark had zero
scheduled real-model runs — the orchestrator was invoked by exactly one
workflow. To keep the suite honest going forward, every registered benchmark
and every public orchestrator adapter is explicitly classified into a CI lane
here, and ``tests/test_ci_coverage.py`` asserts the classification stays
complete: adding a benchmark to the registry or exposing a new adapter without
giving it a lane (or an explicit manual-only marker) fails CI.

The registry and adapter counts are derived by ``registry_benchmark_ids`` /
``public_benchmark_ids`` and every public id carries a lane below. Do not
hardcode a benchmark count in prose; the test gate owns the live count.

Lanes
-----
``scheduled``
    Runs on a schedule against a REAL model. Either the core orchestrator subset
    in ``.github/workflows/benchmark-orchestrator-scheduled.yml`` or a benchmark
    with its own dedicated scheduled/live lane.
``smoke``
    Has a no-key smoke / mock / sample path that can run cheaply in CI without
    provider credentials (the benchmark's ``AGENTS.md`` documents it). Not a
    real-model lane on its own, but it is exercisable in CI.
``manual``
    Explicit manual-only marker: live-gated, hardware/Docker/sandbox-backed, or
    otherwise too expensive/credential-bound for an unattended CI lane. These are
    run on demand (``workflow_dispatch`` / operator runbook), never silently.
"""

from __future__ import annotations

from pathlib import Path

CI_LANES: tuple[str, ...] = ("scheduled", "smoke", "manual")

# The core real-model subset wired into the scheduled orchestrator workflow.
SCHEDULED_ORCHESTRATOR_SUBSET: frozenset[str] = frozenset(
    {"bfcl", "action-calling", "agentbench", "tau_bench", "mint", "context_bench"}
)

# Benchmark id -> CI lane. MUST stay in 1:1 sync with the public benchmark ids
# (registry ids plus public orchestrator adapter ids; enforced by
# tests/test_ci_coverage.py).
CI_LANE_BY_BENCHMARK: dict[str, str] = {
    # ── scheduled real-model lanes ───────────────────────────────────────────
    # Core orchestrator subset (benchmark-orchestrator-scheduled.yml).
    "bfcl": "scheduled",
    "action-calling": "scheduled",
    "agentbench": "scheduled",
    "tau_bench": "scheduled",
    "mint": "scheduled",
    "context_bench": "scheduled",
    # Own dedicated scheduled / live lanes.
    "hyperliquid_bench": "scheduled",  # hyperliquid-bench-live.yml
    "lifeops_bench": "scheduled",  # lifeops-bench-python.yml
    # ── smoke (no-key mock/sample path exercisable in CI) ────────────────────
    "abliteration-robustness": "smoke",
    "clawbench": "smoke",
    "configbench": "smoke",
    "gsm8k": "smoke",
    "humaneval": "smoke",
    "mmlu": "smoke",
    "mt_bench": "smoke",
    "openclaw_bench": "smoke",
    "orchestrator_lifecycle": "smoke",
    "multitask_bench": "smoke",  # hermetic perfect/wrong oracle lanes; live eliza/hermes/openclaw are key-gated
    "realm": "smoke",
    "recall_bench": "smoke",
    "rlm_bench": "smoke",
    "scambench": "smoke",
    "mind2web": "smoke",
    "visualwebbench": "smoke",
    "vision_language": "smoke",
    "webshop": "smoke",
    "woobench": "smoke",
    "trajectory_replay": "smoke",
    "social_alpha": "smoke",
    "trust": "smoke",
    # Public orchestrator adapters that are not registry entries.
    "adhdbench": "smoke",
    "app-eval": "smoke",
    "eliza_1": "smoke",
    "eliza_replay": "smoke",
    "experience": "smoke",
    "framework": "smoke",
    "interrupt_bench": "smoke",
    "personality_bench": "smoke",
    "three_agent_dialogue": "smoke",
    # ── manual-only (live-gated / hardware / Docker / sandbox / audio) ────────
    "osworld": "manual",  # Docker desktop backend
    "solana": "manual",  # surfpool backend
    "gauntlet": "manual",  # surfpool backend
    "terminal_bench": "manual",  # Docker backend
    "swe_bench": "manual",  # Docker backend
    "swe_bench_orchestrated": "manual",  # Docker backend
    "vending_bench": "manual",  # long-horizon
    "mmau": "manual",  # real audio dataset
    "voicebench": "manual",  # real audio assets
    "voicebench_quality": "manual",  # real audio inputs
    "voiceagentbench": "manual",  # real audio dataset
    "meeting_voice": "smoke",  # no-key mocked plumbing alias; not product proof
    "meeting_voice_real": "manual",  # real media/log/model evidence manifest
    "meeting_voice_stress": "manual",  # acoustic stress real evidence manifest
    "meeting_voice_av": "manual",  # audio-visual real evidence manifest
    "meeting_transcription_proof": "smoke",  # mocked plumbing lane in CI; real lane is evidence-gated
    "hermes_swe_env": "manual",  # hermes sandbox backend
    "hermes_tblite": "manual",  # hermes sandbox backend
    "hermes_terminalbench_2": "manual",  # hermes sandbox backend
    "hermes_yc_bench": "manual",  # hermes sandbox backend
}


def ci_lane_for(benchmark_id: str) -> str:
    """Return the CI lane for a registered benchmark id.

    Raises ``KeyError`` if the benchmark has no classification — the test gate
    keeps this exhaustive, so an unclassified id is a real omission.
    """
    return CI_LANE_BY_BENCHMARK[benchmark_id]


def classified_benchmark_ids() -> frozenset[str]:
    """All benchmark ids that carry a CI-lane classification."""
    return frozenset(CI_LANE_BY_BENCHMARK)


def registry_benchmark_ids(workspace_root: Path) -> frozenset[str]:
    """The canonical registered benchmark ids (registry/commands.py)."""
    from benchmarks.registry import get_benchmark_registry

    return frozenset(entry.id for entry in get_benchmark_registry(workspace_root))


def public_benchmark_ids(workspace_root: Path) -> frozenset[str]:
    """Registered ids plus public orchestrator adapter ids."""
    from benchmarks.orchestrator.adapters import discover_adapters

    adapter_ids = frozenset(discover_adapters(workspace_root).adapters)
    return registry_benchmark_ids(workspace_root) | adapter_ids
