"""Classify benchmark execution requirements, independently of hosted coverage.

Smoke suites expose a credential-free diagnostic path. Manual suites require
models, external datasets, hardware, or services. Root benchmarks.yml runs a
selected offline harness lane and permits an explicit live framework run; no
scheduled real-model coverage is claimed by this table.
"""

from __future__ import annotations

from pathlib import Path

CI_LANES: tuple[str, ...] = ("smoke", "manual")

# Benchmark id -> CI lane. MUST stay in 1:1 sync with the public benchmark ids
# (registry ids plus public orchestrator adapter ids; enforced by
# tests/test_ci_coverage.py).
CI_LANE_BY_BENCHMARK: dict[str, str] = {
    # Live-model suites require explicit operator execution.
    "bfcl": "manual",
    "action-calling": "manual",
    "agentbench": "manual",
    "tau_bench": "manual",
    "mint": "manual",
    "context_bench": "manual",
    "lifeops_bench": "manual",
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
    "mind2web": "smoke",
    "visualwebbench": "smoke",
    "vision_language": "smoke",
    "webshop": "smoke",
    "trajectory_replay": "smoke",
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
