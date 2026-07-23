"""Declares and schedules the exhaustive three-harness full benchmark campaign.

The normal adapter defaults are deliberately small smoke slices. This module
owns a separate, fail-closed profile whose entries cover every discovered
adapter exactly once and whose phases replace (rather than merge) those smoke
defaults. Non-agent, externally staged, and currently non-comparable workloads
remain visible in the manifest so an "all benchmarks" campaign cannot silently
turn into "all convenient adapters".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Mapping

from benchmarks.campaign_profile import FULL_CAMPAIGN_PROFILE
from benchmarks.registry import get_benchmark_registry

from .adapters import discover_adapters
from .cohort import (
    BenchmarkCohortResult,
    BenchmarkCohortStatus,
    CampaignStoragePreflightError,
    run_benchmark_cohorts,
)
from .types import RunRequest


FULL_CAMPAIGN_REASONING_EFFORT = "medium"
FULL_CAMPAIGN_QUEUE_AWARE_HARNESS_TIMEOUT_SECONDS = 1_800
FULL_CAMPAIGN_SILENT_TIMEOUT_SECONDS = 3_600
CANONICAL_CAMPAIGN_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")
DEFAULT_MAX_QUOTA_WAIT_SECONDS = 6 * 60 * 60
DEFAULT_QUOTA_POLL_SECONDS = 30.0
QUOTA_PAUSED_EXIT_CODE = 75
STORAGE_PREFLIGHT_EXIT_CODE = 73


class CampaignDisposition(StrEnum):
    """States how an exhaustive campaign must account for a workload."""

    COHORT = "cohort"
    MANUAL = "manual"
    UNSUPPORTED = "unsupported"
    NON_AGENT = "non-agent"
    UNINTEGRATED = "unintegrated"
    INFRASTRUCTURE = "infrastructure"


@dataclass(frozen=True)
class FullCampaignPhase:
    """One full-dataset invocation for an adapter.

    A benchmark may need multiple phases when its CLI exposes mutually
    exclusive datasets (for example the five vision-language suites).
    ``model_config_keys`` fills model-dependent judge fields at execution time.
    """

    name: str
    extra_config: Mapping[str, Any]
    model_config_keys: tuple[str, ...] = ()
    required_overrides: tuple[str, ...] = ()


@dataclass(frozen=True)
class AdapterCampaignEntry:
    benchmark_id: str
    directory: str
    registered: bool
    disposition: CampaignDisposition
    phases: tuple[FullCampaignPhase, ...]
    reason: str


@dataclass(frozen=True)
class DirectCampaignEntry:
    entry_id: str
    directory: str
    disposition: CampaignDisposition
    command: tuple[str, ...] | None
    reason: str


@dataclass(frozen=True)
class FullCampaignManifest:
    adapters: tuple[AdapterCampaignEntry, ...]
    direct: tuple[DirectCampaignEntry, ...]


@dataclass(frozen=True)
class FullCampaignRun:
    cohorts: tuple[BenchmarkCohortResult, ...]
    completed_phases: tuple[str, ...]
    unscheduled_entries: tuple[tuple[str, CampaignDisposition, str], ...]
    paused_cohort: BenchmarkCohortResult | None = None


class FullCampaignManifestError(RuntimeError):
    """Raised when discovery and the checked-in exhaustive manifest diverge."""


class FullCampaignSelectionError(RuntimeError):
    """Raised before quota is spent on an unsafe or incomplete selection."""


def _phase(
    name: str = "full",
    extra: Mapping[str, Any] | None = None,
    *,
    model_keys: tuple[str, ...] = (),
    required_overrides: tuple[str, ...] = (),
) -> tuple[FullCampaignPhase, ...]:
    return (
        FullCampaignPhase(
            name=name,
            extra_config=dict(extra or {}),
            model_config_keys=model_keys,
            required_overrides=required_overrides,
        ),
    )


def _entry(
    benchmark_id: str,
    directory: str,
    *,
    registered: bool = True,
    disposition: CampaignDisposition = CampaignDisposition.COHORT,
    phases: tuple[FullCampaignPhase, ...] | None = None,
    reason: str = "Full dataset is available through the tri-harness adapter.",
) -> AdapterCampaignEntry:
    return AdapterCampaignEntry(
        benchmark_id=benchmark_id,
        directory=directory,
        registered=registered,
        disposition=disposition,
        phases=phases if phases is not None else _phase(),
        reason=reason,
    )


_FRAMEWORK_SCENARIOS = ",".join(
    (
        "single-message",
        "conversation-10",
        "conversation-100",
        "burst-100",
        "burst-1000",
        "with-should-respond",
        "with-should-respond-no-name",
        "with-actions",
        "provider-scaling-10",
        "provider-scaling-50",
        "provider-scaling-100",
        "history-scaling-100",
        "history-scaling-1000",
        "history-scaling-10000",
        "concurrent-10",
        "concurrent-50",
        "db-write-throughput",
        "db-read-throughput",
        "startup-cold",
        "multi-step",
        "minimal-bootstrap",
    )
)

_CLAWBENCH_BASE_SCENARIOS = (
    "inbox_triage",
    "morning_brief",
    "team_standup",
    "inbox_to_action",
    "client_escalation",
)
_CLAWBENCH_EDGE_VARIANTS = (
    "polite",
    "urgent",
    "mobile",
    "followup",
    "quoted",
    "context",
    "brief",
    "noisy",
    "boundary",
    "handoff",
)
_CLAWBENCH_FULL_SCENARIOS = _CLAWBENCH_BASE_SCENARIOS + tuple(
    f"{scenario}--edge-{variant}"
    for scenario in _CLAWBENCH_BASE_SCENARIOS
    for variant in _CLAWBENCH_EDGE_VARIANTS
)


def _clawbench_phases() -> tuple[FullCampaignPhase, ...]:
    return tuple(
        FullCampaignPhase(name=scenario, extra_config={"scenario": scenario})
        for scenario in _CLAWBENCH_FULL_SCENARIOS
    )


def _mind2web_phases() -> tuple[FullCampaignPhase, ...]:
    counts = {"test_task": 252, "test_website": 177, "test_domain": 912}
    return tuple(
        FullCampaignPhase(
            name=split,
            extra_config={
                "hf": True,
                "split": split,
                "trials": 1,
                "max_steps": 1000,
                "timeout": 3_600_000,
                "ranker": "real",
                "ranker_top_k": 50,
                "ranker_model": "osunlp/MindAct_CandidateGeneration_deberta-v3-base",
                "ranker_revision": "92d3ddcb079b1749015d72293c82d640b0b9a1da",
                "expected_tasks": count,
                "expected_scenarios": count * 11,
                "expand_scenarios": True,
            },
        )
        for split, count in counts.items()
    )


# Order is intentional: cheap transport canaries first, public reference suites
# next, then increasingly stateful/tool-heavy workloads, and finally manually
# provisioned environments. Each adapter ID occurs once; multi-suite adapters
# use phases rather than duplicate entries.
ADAPTER_CAMPAIGN_ENTRIES: tuple[AdapterCampaignEntry, ...] = (
    _entry(
        "orchestrator_lifecycle",
        "orchestrator_lifecycle",
        phases=_phase(extra={"strict": True, "mode": "bridge"}),
    ),
    _entry(
        "action-calling",
        "action-calling",
        phases=_phase(
            extra={
                "expected_examples": 63,
                "max_new_tokens": 512,
                "expand_scenarios": True,
            }
        ),
    ),
    _entry("bfcl", "bfcl", phases=_phase(extra={"expand_scenarios": True})),
    _entry("gsm8k", "standard", phases=_phase(extra={"max_tokens": 2048})),
    _entry("mmlu", "standard", phases=_phase(extra={"max_tokens": 2048})),
    _entry(
        "humaneval",
        "standard",
        phases=_phase(extra={"max_tokens": 2048, "timeout_s": 10}),
    ),
    _entry(
        "mt_bench",
        "standard",
        phases=_phase(
            extra={"max_tokens": 1024, "judge_max_tokens": 1024, "temperature": 0.0},
            model_keys=("judge_model",),
        ),
    ),
    _entry(
        "abliteration-robustness",
        "abliteration-robustness",
        phases=_phase(
            extra={
                "dataset_revision": "02c6a92cfcf11bb0c387334f8146d149d65b587f",
                "split": "test",
                "expected_examples": 6265,
                "max_new_tokens": 512,
                "expand_scenarios": True,
            }
        ),
    ),
    _entry(
        "scambench",
        "scambench",
        phases=_phase(
            extra={
                "split": "test",
                "expected_examples": 3734,
                "max_new_tokens": 512,
                "expand_scenarios": True,
            }
        ),
    ),
    _entry("context_bench", "context-bench"),
    _entry(
        "realm",
        "realm",
        phases=_phase(
            extra={
                "full_dataset": True,
                "timeout": 60000,
                "expand_scenarios": True,
            },
        ),
        reason="Runs all 1,110 vendored upstream instances and their ten edge variants.",
    ),
    _entry(
        "mint",
        "mint",
        disposition=CampaignDisposition.MANUAL,
        reason="Full MINT includes tool/feedback ablations and sandboxed code tasks; provision its runtime before dispatch.",
    ),
    _entry(
        "rlm_bench",
        "rlm-bench",
        phases=_phase(extra={"mode": "eliza", "expand_scenarios": True}),
        reason="Runs the complete generated S-NIAH and OOLONG matrix through each native harness bridge.",
    ),
    _entry("clawbench", "clawbench", phases=_clawbench_phases()),
    _entry(
        "woobench",
        "woobench",
        phases=_phase(
            extra={
                "evaluator": "llm",
                "concurrency": 1,
                "expand_scenarios": True,
            }
        ),
    ),
    _entry(
        "webshop",
        "webshop",
        phases=_phase(
            extra={
                "profile": "full",
                "hf": True,
                "trajectories": True,
                "expand_scenarios": True,
            }
        ),
    ),
    _entry(
        "vending_bench",
        "vending-bench",
        phases=_phase(
            extra={
                "runs": 5,
                "days": 365,
                "max_actions_per_day": 25,
                "max_messages_per_run": 2000,
                "context_window_tokens": 30000,
                "seed": 42,
                "starter_inventory": False,
                "expected_scenarios": 55,
                "expand_scenarios": True,
                "no_leaderboard": True,
            }
        ),
        reason=(
            "Runs the five-seed, 2,000-message local long-horizon reimplementation; "
            "results are explicitly not compared with Andon Labs' private simulator."
        ),
    ),
    _entry(
        "tau_bench",
        "tau-bench",
        phases=_phase(extra={"domain": "both", "expand_scenarios": True}),
    ),
    _entry(
        "trust",
        "trust",
        phases=_phase(extra={"expand_scenarios": True}),
    ),
    _entry(
        "agentbench",
        "agentbench",
        disposition=CampaignDisposition.UNSUPPORTED,
        phases=_phase(extra={"env": ["all"], "expand_scenarios": True}),
        reason=(
            "Full execution exits unsupported before model work because four upstream "
            "environments lack native runtime parity; a partial subset cannot publish "
            "as the complete three-harness benchmark."
        ),
    ),
    _entry(
        "lifeops_bench",
        "lifeops-bench",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(extra={"suite": "full", "seeds": 1, "concurrency": 2}),
        reason="The full suite includes LIVE simulated-user/judge lanes that need separately provisioned evaluator credentials.",
    ),
    _entry(
        "multitask_bench",
        "multitask-bench",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(extra={"lanes": "1,5,10"}),
        reason="The full interference matrix requires the LifeOps simulator model and the N=1/5/10 runtime lanes.",
    ),
    _entry(
        "openclaw_bench",
        "openclaw-benchmark",
        phases=_phase(extra={"mode": "execution", "all": True}),
    ),
    _entry(
        "mind2web",
        "mind2web",
        phases=_mind2web_phases(),
        reason=(
            "Runs all three pinned official test splits through the real MindAct ranker and "
            "native harness bridge without annotated-next-action leakage."
        ),
    ),
    _entry(
        "adhdbench",
        "adhdbench",
        registered=False,
        phases=_phase(extra={"mode": "full"}),
    ),
    _entry("app-eval", "app-eval", registered=False),
    _entry("configbench", "configbench"),
    _entry(
        "eliza_1",
        "eliza-1",
        registered=False,
        phases=_phase(extra={"task": "should_respond", "n": 10}),
        reason="The cross-harness adapter covers the complete 59-case should_respond corpus with ten repetitions; local-only decode-mode tasks remain outside this comparison.",
    ),
    _entry(
        "experience",
        "experience",
        registered=False,
        disposition=CampaignDisposition.UNSUPPORTED,
        phases=_phase(
            extra={
                "mode": "eliza-bridge",
                "experiences": 1000,
                "queries": 100,
                "learning_cycles": 20,
                "seed": 42,
            }
        ),
        reason=(
            "The bridge implements only the Eliza runtime and marks its schema-v2 "
            "result publishable_three_harness=false; Hermes/OpenClaw do not yet have "
            "equivalent native experience-memory services."
        ),
    ),
    _entry(
        "framework",
        "framework",
        registered=False,
        disposition=CampaignDisposition.UNSUPPORTED,
        phases=_phase(
            extra={
                "mode": "harness",
                "scenarios": _FRAMEWORK_SCENARIOS,
                "iterations": 1,
                "generated_limit": 10000,
            }
        ),
        reason=(
            "This is an elizaOS runtime-overhead benchmark, not a fair agent-capability "
            "comparison. Its cross-harness runner ignores warmup, iterations, concurrency, "
            "provider/history prepopulation, DB-only operations and counts, multi-step "
            "execution, minimal bootstrap, and shouldRespond semantics, while fabricating "
            "zero pipeline/resource values and a passing empty-DB score."
        ),
    ),
    _entry("interrupt_bench", "interrupt-bench", registered=False),
    _entry(
        "personality_bench",
        "personality-bench",
        registered=False,
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="The adapter grades the same prerecorded calibration trajectories and only relabels them with the selected harness name.",
    ),
    _entry(
        "three_agent_dialogue",
        "three-agent-dialogue",
        registered=False,
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="The workload always instantiates Alice/Bob/Cleo Eliza agents and ignores the selected comparison harness.",
    ),
    _entry(
        "eliza_replay",
        "eliza-adapter",
        registered=False,
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="Offline replay scoring consumes recorded captures and does not execute any selected harness.",
    ),
    _entry(
        "trajectory_replay",
        "standard",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="Endpoint replay is a regression lane, not a native Eliza/Hermes/OpenClaw agent loop.",
    ),
    _entry(
        "recall_bench",
        "recall-bench",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="RecallBench uses deterministic in-bench embeddings and the selected harness never affects its score; run the direct 10k KPI lane.",
    ),
    _entry(
        "social_alpha",
        "social-alpha",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(
            extra={"system": "eliza-bridge"},
            required_overrides=("data_dir",),
        ),
        reason="The full Trenches chat corpus is external; the bundled fallback is only a smoke fixture.",
    ),
    _entry(
        "solana",
        "solana",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(
            extra={
                "environment_config": "voyager/environments/basic_env.json",
            }
        ),
        reason="A full run requires a reachable Surfpool ledger and deployed/clone-backed program state.",
    ),
    _entry(
        "gauntlet",
        "gauntlet",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(extra={"clone_mainnet": True, "expand_scenarios": True}),
        reason="All 96 scenarios require a real Surfpool backend with clone support.",
    ),
    _entry(
        "hyperliquid_bench",
        "HyperliquidBench",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(extra={"no_demo": True, "expand_scenarios": True}),
        reason="Comparable execution requires the Rust evaluator, a live/testnet backend, and HL_PRIVATE_KEY; demo mode is forbidden.",
    ),
    _entry(
        "terminal_bench",
        "terminal-bench",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(extra={"network_mode": "bridge", "expand_scenarios": True}),
        reason="The full upstream corpus requires a working Docker daemon and task images.",
    ),
    _entry(
        "swe_bench",
        "swe_bench",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(extra={"variant": "full", "expand_scenarios": True}),
        reason="The full SWE-bench dataset and official Docker evaluation images must be provisioned.",
    ),
    _entry(
        "swe_bench_orchestrated",
        "swe_bench",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(
            extra={
                "variant": "full",
                "execution_mode": "orchestrated",
                "matrix": True,
                "strict_capabilities": True,
                "expand_scenarios": True,
            }
        ),
        reason="The orchestrated full matrix requires Docker plus a reachable orchestrator service and capability contract.",
    ),
    _entry(
        "osworld",
        "OSWorld",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(
            extra={
                "provider_name": "docker",
                "observation_type": "screenshot",
                "max_steps": 15,
                "max_tasks": 369,
                "headless": True,
                "vm_ready_timeout_seconds": 21600,
                "expand_scenarios": True,
            }
        ),
        reason="All 369 tasks require the real OSWorld VM image and a KVM/VM-capable backend.",
    ),
    _entry(
        "hermes_tblite",
        "hermes-adapter",
        disposition=CampaignDisposition.MANUAL,
        reason="All 100 TBlite tasks require a Hermes sandbox backend (Modal or Docker).",
    ),
    _entry(
        "hermes_terminalbench_2",
        "hermes-adapter",
        disposition=CampaignDisposition.MANUAL,
        reason="All 89 TerminalBench 2 tasks require a Hermes sandbox backend.",
    ),
    _entry(
        "hermes_yc_bench",
        "hermes-adapter",
        disposition=CampaignDisposition.MANUAL,
        reason="The complete long-horizon YC-Bench environment requires a Hermes sandbox backend.",
    ),
    _entry(
        "hermes_swe_env",
        "hermes-adapter",
        disposition=CampaignDisposition.MANUAL,
        reason="The complete SWE-style Hermes environment requires its sandbox and evaluation images.",
    ),
    _entry(
        "mmau",
        "mmau-audio",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(extra={"hf": True, "split": "test", "expand_scenarios": True}),
        reason="The 9k upstream audio split and real STT/audio path must be staged; bundled MCQs are smoke-only.",
    ),
    _entry(
        "voicebench_quality",
        "voicebench-quality",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(
            extra={
                "suite": "all",
                "stt_provider": "faster-whisper",
                "expand_scenarios": True,
            }
        ),
        reason="All eight suites require upstream audio, a real STT backend, and the separately provisioned quality judge.",
    ),
    _entry(
        "voiceagentbench",
        "voiceagentbench",
        disposition=CampaignDisposition.MANUAL,
        phases=_phase(
            extra={
                "suite": "all",
                "seeds": 1,
                "stt_provider": "faster-whisper",
                "expand_scenarios": True,
            }
        ),
        reason="All task suites require upstream audio plus real cascaded STT and coherence judging.",
    ),
    _entry(
        "voicebench",
        "voicebench",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="VoiceBench measures a fixed in-process voice pipeline profile and never selects Eliza/Hermes/OpenClaw.",
    ),
    _entry(
        "vision_language",
        "vision-language",
        disposition=CampaignDisposition.UNSUPPORTED,
        phases=(
            FullCampaignPhase(
                "textvqa",
                {
                    "sub_benchmark": "textvqa",
                    "samples": 5000,
                    "expand_scenarios": True,
                },
            ),
            FullCampaignPhase(
                "docvqa",
                {
                    "sub_benchmark": "docvqa",
                    "samples": 5349,
                    "expand_scenarios": True,
                },
            ),
            FullCampaignPhase(
                "chartqa",
                {
                    "sub_benchmark": "chartqa",
                    "samples": 2500,
                    "expand_scenarios": True,
                },
            ),
            FullCampaignPhase(
                "screenspot",
                {
                    "sub_benchmark": "screenspot",
                    "samples": 1272,
                    "expand_scenarios": True,
                },
            ),
            FullCampaignPhase(
                "osworld",
                {
                    "sub_benchmark": "osworld",
                    "samples": 369,
                    "expand_scenarios": True,
                },
            ),
        ),
        reason=(
            "The image runtime has no native OpenClaw multimodal path and uses "
            "different Eliza/Hermes execution stacks; staging data cannot make the "
            "three harnesses comparable."
        ),
    ),
    _entry(
        "visualwebbench",
        "visualwebbench",
        disposition=CampaignDisposition.UNSUPPORTED,
        phases=_phase(
            extra={
                "model_provider": "eliza",
                "hf": True,
                "expand_scenarios": True,
            }
        ),
        reason=(
            "The registry forces Eliza for Hermes and OpenClaw, and its ten edge "
            "variants append hypothetical text without changing the image; those "
            "rows are not a native or equivalent three-harness comparison."
        ),
    ),
    _entry(
        "meeting_transcription_proof",
        "meeting-transcription-proof",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="The command ignores the selected harness and model and validates the same externally supplied real-product evidence, so it is not a tri-harness agent workload.",
    ),
    _entry(
        "meeting_voice",
        "meeting-transcription-proof",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="The command ignores the selected harness and model and validates the same externally supplied real-product evidence, so it is not a tri-harness agent workload.",
    ),
    _entry(
        "meeting_voice_real",
        "meeting-transcription-proof",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="The command ignores the selected harness and model and validates the same externally supplied real-product evidence, so it is not a tri-harness agent workload.",
    ),
    _entry(
        "meeting_voice_stress",
        "meeting-transcription-proof",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="The command ignores the selected harness and model and validates the same externally supplied real-product evidence, so it is not a tri-harness agent workload.",
    ),
    _entry(
        "meeting_voice_av",
        "meeting-transcription-proof",
        disposition=CampaignDisposition.NON_AGENT,
        phases=(),
        reason="The command ignores the selected harness and model and validates the same externally supplied real-product evidence, so it is not a tri-harness agent workload.",
    ),
)


DIRECT_CAMPAIGN_ENTRIES: tuple[DirectCampaignEntry, ...] = (
    DirectCampaignEntry(
        "agentbench_matrix",
        "agentbench_matrix",
        CampaignDisposition.MANUAL,
        ("python", "-m", "benchmarks.orchestrator.code_agent_matrix"),
        "Code-agent matrix workbench; imported by its dedicated orchestrator and not a cohort adapter.",
    ),
    DirectCampaignEntry(
        "entity_voice_bench",
        "entity-voice-bench",
        CampaignDisposition.UNINTEGRATED,
        (
            "bun",
            "--conditions=eliza-source",
            "packages/benchmarks/entity-voice-bench/run.ts",
            "--lane",
            "llm",
            "--input",
            "text",
        ),
        "Real LLM entity extraction benchmark exists but has no normalized adapter/scorer for all three harnesses.",
    ),
    DirectCampaignEntry(
        "lifeops_quality",
        "lifeops-quality",
        CampaignDisposition.NON_AGENT,
        ("bun", "run", "--cwd", "packages/benchmarks/lifeops-quality", "bench"),
        "Deterministic classifier/scheduler regression gate; no selected agent participates.",
    ),
    DirectCampaignEntry(
        "meeting_corpus_importers",
        "meeting-corpus-importers",
        CampaignDisposition.INFRASTRUCTURE,
        (
            "python",
            "-m",
            "pytest",
            "packages/benchmarks/meeting-corpus-importers/tests",
            "-q",
        ),
        "License/cache importer contract supporting meeting evidence, not a scored agent workload.",
    ),
    DirectCampaignEntry(
        "searchbench",
        "searchbench",
        CampaignDisposition.NON_AGENT,
        ("node", "packages/benchmarks/searchbench/run-all.mjs", "--json"),
        "Real 10k-message PGlite search KPI; independent of the selected agent.",
    ),
    DirectCampaignEntry(
        "voice_rtt",
        "voice-rtt",
        CampaignDisposition.NON_AGENT,
        ("bun", "run", "--cwd", "packages/benchmarks/voice-rtt", "bench:live"),
        "Provider voice-latency workbench; it does not instantiate any comparison harness.",
    ),
    DirectCampaignEntry(
        "loadperf",
        "loadperf",
        CampaignDisposition.NON_AGENT,
        ("node", "packages/benchmarks/loadperf/run-all.mjs"),
        "App load, web-vitals, and state-sync KPIs.",
    ),
    DirectCampaignEntry(
        "memperf",
        "memperf",
        CampaignDisposition.NON_AGENT,
        ("node", "packages/benchmarks/memperf/run-all.mjs"),
        "Local-inference memory and eviction KPI matrix.",
    ),
    DirectCampaignEntry(
        "mobile_resource",
        "mobile-resource",
        CampaignDisposition.NON_AGENT,
        (
            "node",
            "packages/benchmarks/mobile-resource/run-workbench.mjs",
            "--fail-on-missing",
        ),
        "On-device battery, RSS, thermal, TTFT, and throughput workbench.",
    ),
    DirectCampaignEntry(
        "view_bundle_size",
        "view-bundle-size",
        CampaignDisposition.NON_AGENT,
        ("node", "packages/benchmarks/view-bundle-size/run-all.mjs"),
        "Deterministic plugin view-bundle size gate.",
    ),
    DirectCampaignEntry(
        "voice_pipeline",
        "voice",
        CampaignDisposition.NON_AGENT,
        ("bun", "packages/benchmarks/voice/voice-real-ci-matrix.mjs"),
        "Native fused voice pipeline verification; no comparison harness selector.",
    ),
    DirectCampaignEntry(
        "voice_emotion",
        "voice-emotion",
        CampaignDisposition.NON_AGENT,
        ("voice-emotion-bench", "intrinsic", "--suite", "meld"),
        "Acoustic/text emotion classifier and TTS fidelity workbench.",
    ),
    DirectCampaignEntry(
        "voice_speaker_validation",
        "voice-speaker-validation",
        CampaignDisposition.NON_AGENT,
        (
            "python",
            "-m",
            "pytest",
            "packages/benchmarks/voice-speaker-validation/tests",
            "-v",
        ),
        "Diarization, speaker-ID, entity, and voice-profile lifecycle validation.",
    ),
    DirectCampaignEntry(
        "nl2repo",
        "nl2repo",
        CampaignDisposition.UNINTEGRATED,
        ("python", "packages/benchmarks/nl2repo/adapter_matrix.py"),
        "The 104-task Docker code-agent benchmark has no orchestrator cohort adapter.",
    ),
    DirectCampaignEntry(
        "claude_subscription_gateway",
        "claude-subscription-gateway",
        CampaignDisposition.INFRASTRUCTURE,
        None,
        "Shared subscription transport and fair queue; never a scored benchmark.",
    ),
)


FULL_CAMPAIGN_MANIFEST = FullCampaignManifest(
    adapters=ADAPTER_CAMPAIGN_ENTRIES,
    direct=DIRECT_CAMPAIGN_ENTRIES,
)


_FORBIDDEN_FULL_FLAGS = frozenset(
    {
        "mock",
        "smoke",
        "sample",
        "use_sample_tasks",
        "quick",
        "dry_run",
        "no_docker",
        "no_exec",
        "no_ablation",
        "fixture",
        "fixtures",
        "stub",
        "demo",
    }
)
_REQUEST_DATASET_KEYS = frozenset(
    {
        "limit",
        "max_tasks",
        "max_examples",
        "max_instances",
        "max_scenarios",
        "max_per_category",
        "sample",
        "samples",
        "task_ids",
        "categories",
        "scenario",
        "scenarios",
        "suite",
        "profile",
        "tier",
        "domain",
        "mode",
    }
)
_ALLOWED_REQUEST_EXTRA_KEYS = frozenset(
    {
        "claude_subscription_gateway_url",
        "reasoning_effort",
        "openclaw_timeout_s",
        "hermes_timeout_s",
        "eliza_bench_http_timeout_s",
        "hl_bench_command_timeout_s",
        "campaign_silent_timeout_s",
        "campaign_storage_min_free_bytes",
        "campaign_storage_expected_headroom_bytes",
        "campaign_storage_check_interval_s",
    }
)
_HARNESS_HTTP_TIMEOUT_KEYS = (
    "eliza_bench_http_timeout_s",
    "hermes_timeout_s",
    "openclaw_timeout_s",
)


def _full_config_error(extra: Mapping[str, Any]) -> str | None:
    for key in _FORBIDDEN_FULL_FLAGS:
        value = extra.get(key)
        if value not in (None, False, "", 0):
            return f"{key}={value!r} is smoke/sample/mock-only"
    if str(extra.get("suite") or "").strip().lower() == "smoke":
        return "suite=smoke is not a full dataset"
    if str(extra.get("profile") or "").strip().lower() == "small":
        return "profile=small is not a full dataset"
    if str(extra.get("tier") or "").strip().lower() == "smoke":
        return "tier=smoke is not a full dataset"
    if str(extra.get("lane") or "").strip().lower() == "mocked_plumbing":
        return "lane=mocked_plumbing is not real product evidence"
    if str(extra.get("mode") or "").strip().lower() in {
        "mock",
        "stub",
        "conceptual",
        "simulate",
        "scripted",
        "heuristic",
    }:
        return f"mode={extra.get('mode')} is not a full real run"
    return None


def _normalize_queue_aware_timeouts(extra: dict[str, Any]) -> None:
    """Pin equal request ceilings while three harnesses share one serial queue."""

    supplied: list[float] = []
    for key in _HARNESS_HTTP_TIMEOUT_KEYS:
        value = extra.get(key)
        if value is None:
            continue
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            or float(value) <= 0
        ):
            raise FullCampaignSelectionError(
                f"{key} must be a finite positive number"
            )
        supplied.append(float(value))
    if len(set(supplied)) > 1:
        raise FullCampaignSelectionError(
            "Full-campaign harness HTTP timeouts must be equal because Eliza, "
            "Hermes, and OpenClaw share one serial subscription queue"
        )
    harness_timeout = (
        supplied[0]
        if supplied
        else float(FULL_CAMPAIGN_QUEUE_AWARE_HARNESS_TIMEOUT_SECONDS)
    )
    for key in _HARNESS_HTTP_TIMEOUT_KEYS:
        extra[key] = harness_timeout

    silent_timeout = extra.get(
        "campaign_silent_timeout_s",
        FULL_CAMPAIGN_SILENT_TIMEOUT_SECONDS,
    )
    if (
        not isinstance(silent_timeout, (int, float))
        or isinstance(silent_timeout, bool)
        or not math.isfinite(float(silent_timeout))
        or float(silent_timeout) <= harness_timeout
    ):
        raise FullCampaignSelectionError(
            "campaign_silent_timeout_s must be finite and greater than the "
            "shared harness HTTP timeout"
        )
    extra["campaign_silent_timeout_s"] = float(silent_timeout)


def validate_full_campaign_manifest(workspace_root: Path) -> FullCampaignManifest:
    """Prove that the checked-in campaign still covers current discovery."""

    discovery = discover_adapters(workspace_root)
    registry_ids = {entry.id for entry in get_benchmark_registry(workspace_root)}
    manifest_ids = [entry.benchmark_id for entry in ADAPTER_CAMPAIGN_ENTRIES]
    duplicates = sorted({item for item in manifest_ids if manifest_ids.count(item) > 1})
    if duplicates:
        raise FullCampaignManifestError(
            "Duplicate adapter campaign entries: " + ", ".join(duplicates)
        )

    discovered_ids = set(discovery.adapters)
    declared_ids = set(manifest_ids)
    if discovered_ids != declared_ids:
        missing = sorted(discovered_ids - declared_ids)
        stale = sorted(declared_ids - discovered_ids)
        raise FullCampaignManifestError(
            f"Adapter coverage drift: missing={missing}, stale={stale}"
        )

    declared_registry_ids = {
        entry.benchmark_id for entry in ADAPTER_CAMPAIGN_ENTRIES if entry.registered
    }
    if registry_ids != declared_registry_ids:
        missing = sorted(registry_ids - declared_registry_ids)
        stale = sorted(declared_registry_ids - registry_ids)
        raise FullCampaignManifestError(
            f"Registry coverage drift: missing={missing}, stale={stale}"
        )

    direct_directories = [entry.directory for entry in DIRECT_CAMPAIGN_ENTRIES]
    direct_duplicates = sorted(
        {item for item in direct_directories if direct_directories.count(item) > 1}
    )
    if direct_duplicates:
        raise FullCampaignManifestError(
            "Duplicate direct campaign directories: " + ", ".join(direct_duplicates)
        )
    benchmarks_root = workspace_root / "benchmarks"
    missing_direct_directories = sorted(
        entry.directory
        for entry in DIRECT_CAMPAIGN_ENTRIES
        if not (benchmarks_root / entry.directory).is_dir()
    )
    if missing_direct_directories:
        raise FullCampaignManifestError(
            "Direct campaign workload directories missing from disk: "
            + ", ".join(missing_direct_directories)
        )

    covered_adapter_directories = {
        adapter.directory for adapter in discovery.adapters.values()
    }
    uncovered_directories = set(discovery.all_directories) - covered_adapter_directories
    undeclared_gaps = uncovered_directories - set(direct_directories)
    if undeclared_gaps:
        raise FullCampaignManifestError(
            "Benchmark directories without an adapter or direct disposition: "
            + ", ".join(sorted(undeclared_gaps))
        )

    for entry in ADAPTER_CAMPAIGN_ENTRIES:
        adapter = discovery.adapters[entry.benchmark_id]
        if adapter.directory != entry.directory:
            raise FullCampaignManifestError(
                f"Directory drift for {entry.benchmark_id}: "
                f"manifest={entry.directory}, discovery={adapter.directory}"
            )
        if (
            entry.disposition
            in {CampaignDisposition.COHORT, CampaignDisposition.MANUAL}
            and not entry.phases
        ):
            raise FullCampaignManifestError(
                f"Runnable entry {entry.benchmark_id} has no full phase"
            )
        for phase in entry.phases:
            problem = _full_config_error(phase.extra_config)
            if problem:
                raise FullCampaignManifestError(
                    f"{entry.benchmark_id}/{phase.name}: {problem}"
                )

    return FULL_CAMPAIGN_MANIFEST


def _phase_request(
    *,
    request: RunRequest,
    entry: AdapterCampaignEntry,
    phase: FullCampaignPhase,
    overrides: Mapping[str, Any],
) -> RunRequest:
    if "per_benchmark" in request.extra_config:
        raise FullCampaignSelectionError(
            "per_benchmark request extras are forbidden in a full campaign; "
            "the manifest owns every benchmark's dataset shape"
        )
    unexpected_request_keys = sorted(
        set(request.extra_config) - _ALLOWED_REQUEST_EXTRA_KEYS
    )
    forbidden_request_keys = sorted(set(request.extra_config) & _REQUEST_DATASET_KEYS)
    if forbidden_request_keys:
        raise FullCampaignSelectionError(
            "Dataset-shaping request extras are forbidden in a full campaign; "
            "the manifest owns them: " + ", ".join(forbidden_request_keys)
        )
    if unexpected_request_keys:
        raise FullCampaignSelectionError(
            "Only campaign transport/timeout extras are accepted; undeclared "
            "request keys: " + ", ".join(unexpected_request_keys)
        )
    forbidden_override_keys = sorted(set(overrides) & _REQUEST_DATASET_KEYS)
    if forbidden_override_keys:
        raise FullCampaignSelectionError(
            f"{entry.benchmark_id}/{phase.name} manual overrides may not change "
            "dataset shape: " + ", ".join(forbidden_override_keys)
        )

    extra = dict(request.extra_config)
    extra.update(phase.extra_config)
    extra.update(overrides)
    requested_effort = extra.get("reasoning_effort")
    if requested_effort is not None and (
        not isinstance(requested_effort, str)
        or requested_effort.strip().lower() != FULL_CAMPAIGN_REASONING_EFFORT
    ):
        raise FullCampaignSelectionError(
            "The full comparison campaign fixes reasoning_effort=medium for "
            "every harness and phase"
        )
    extra["reasoning_effort"] = FULL_CAMPAIGN_REASONING_EFFORT
    _normalize_queue_aware_timeouts(extra)
    for key in phase.model_config_keys:
        extra[key] = request.model
    extra["campaign_profile"] = FULL_CAMPAIGN_PROFILE
    extra["campaign_phase"] = phase.name
    corpus_contract = {
        "schema_version": 1,
        "benchmark_id": entry.benchmark_id,
        "benchmark_directory": entry.directory,
        "phase": phase.name,
        "dataset_config": {
            key: value
            for key, value in extra.items()
            if key not in _ALLOWED_REQUEST_EXTRA_KEYS
            and key not in {"campaign_profile", "reasoning_effort"}
        },
    }
    extra["campaign_corpus_sha256"] = hashlib.sha256(
        json.dumps(
            corpus_contract,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()
    # The runner consumes and removes this before it constructs an effective
    # request. Without it, tiny adapter smoke defaults survive by merge.
    extra["_replace_adapter_defaults"] = True

    missing = [
        key
        for key in phase.required_overrides
        if key not in overrides
        or overrides[key] is None
        or overrides[key] == ""
        or overrides[key] == ()
        or overrides[key] == []
    ]
    if missing:
        raise FullCampaignSelectionError(
            f"{entry.benchmark_id}/{phase.name} requires manual override(s): "
            + ", ".join(missing)
        )
    problem = _full_config_error(extra)
    if problem:
        raise FullCampaignSelectionError(
            f"{entry.benchmark_id}/{phase.name}: {problem}"
        )
    return replace(
        request,
        benchmarks=(entry.benchmark_id,),
        extra_config=extra,
    )


def _wait_for_known_quota_retry(
    *,
    retry_at: str | None,
    max_wait_seconds: float,
    poll_seconds: float,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    sleep: Callable[[float], None] = time.sleep,
    heartbeat: Callable[[Mapping[str, object]], None] | None = None,
) -> bool:
    """Interruptibly wait for one known reset without a busy loop."""

    if retry_at is None:
        return False
    if not math.isfinite(max_wait_seconds) or max_wait_seconds < 0:
        raise ValueError("max_wait_seconds must be finite and non-negative")
    if not math.isfinite(poll_seconds) or poll_seconds <= 0:
        raise ValueError("poll_seconds must be finite and positive")
    try:
        target = datetime.fromisoformat(retry_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("Quota retry_at is not valid ISO-8601") from error
    if target.tzinfo is None:
        raise RuntimeError("Quota retry_at must include a timezone")
    target = target.astimezone(UTC)
    initial_remaining = max(0.0, (target - now().astimezone(UTC)).total_seconds())
    if initial_remaining > max_wait_seconds:
        return False
    while True:
        remaining = (target - now().astimezone(UTC)).total_seconds()
        if remaining <= 0:
            return True
        delay = min(float(poll_seconds), remaining)
        if heartbeat is not None:
            heartbeat(
                {
                    "status": "paused",
                    "retry_at": target.isoformat(),
                    "remaining_seconds": round(remaining, 3),
                }
            )
        sleep(delay)


def run_full_campaign(
    *,
    workspace_root: Path,
    request: RunRequest,
    benchmark_ids: tuple[str, ...] | None = None,
    harnesses: tuple[str, ...] = CANONICAL_CAMPAIGN_HARNESSES,
    allow_manual: bool = False,
    manual_overrides: Mapping[str, Mapping[str, Any]] | None = None,
    stop_after_failed_cohort: bool = True,
    wait_on_quota: bool = False,
    max_quota_wait_seconds: float = DEFAULT_MAX_QUOTA_WAIT_SECONDS,
    quota_poll_seconds: float = DEFAULT_QUOTA_POLL_SECONDS,
    quota_now: Callable[[], datetime] = lambda: datetime.now(UTC),
    quota_sleep: Callable[[float], None] = time.sleep,
    quota_heartbeat: Callable[[Mapping[str, object]], None] | None = None,
) -> FullCampaignRun:
    """Run full phases serially while each phase runs its harnesses together.

    By default only entries classified ``cohort`` are scheduled. Manual
    entries require both explicit selection and ``allow_manual=True``;
    unsupported and non-agent entries are never coerced into fake comparison
    rows. The return value lists every unscheduled entry and its reason.
    """

    validate_full_campaign_manifest(workspace_root)
    if request.provider.strip().lower() != "claude-subscription":
        raise FullCampaignSelectionError(
            "The full campaign requires provider=claude-subscription"
        )
    if not request.model.strip():
        raise FullCampaignSelectionError("The full campaign requires a model")
    normalized_harnesses = tuple(
        dict.fromkeys(value.strip().lower() for value in harnesses if value.strip())
    )
    if normalized_harnesses != CANONICAL_CAMPAIGN_HARNESSES:
        raise FullCampaignSelectionError(
            "The full comparison campaign requires harness order "
            + ",".join(CANONICAL_CAMPAIGN_HARNESSES)
        )

    by_id = {entry.benchmark_id: entry for entry in ADAPTER_CAMPAIGN_ENTRIES}
    selected_ids = (
        tuple(
            entry.benchmark_id
            for entry in ADAPTER_CAMPAIGN_ENTRIES
            if entry.disposition == CampaignDisposition.COHORT
        )
        if benchmark_ids is None
        else tuple(benchmark_ids)
    )
    if len(selected_ids) != len(set(selected_ids)):
        raise FullCampaignSelectionError("benchmark_ids contains duplicates")
    unknown = sorted(set(selected_ids) - set(by_id))
    if unknown:
        raise FullCampaignSelectionError(
            "Unknown campaign benchmark IDs: " + ", ".join(unknown)
        )

    discovery = discover_adapters(workspace_root)
    for benchmark_id in selected_ids:
        entry = by_id[benchmark_id]
        if entry.disposition == CampaignDisposition.MANUAL and not allow_manual:
            raise FullCampaignSelectionError(
                f"{benchmark_id} is manual: {entry.reason}"
            )
        if entry.disposition not in {
            CampaignDisposition.COHORT,
            CampaignDisposition.MANUAL,
        }:
            raise FullCampaignSelectionError(
                f"{benchmark_id} cannot publish a three-harness cohort "
                f"({entry.disposition.value}): {entry.reason}"
            )
        compatible = set(discovery.adapters[benchmark_id].agent_compatibility)
        missing_harnesses = [
            harness for harness in normalized_harnesses if harness not in compatible
        ]
        if missing_harnesses:
            raise FullCampaignSelectionError(
                f"{benchmark_id} is not currently runnable by: "
                + ", ".join(missing_harnesses)
            )

    overrides_by_id = dict(manual_overrides or {})
    unknown_override_ids = sorted(set(overrides_by_id) - set(selected_ids))
    if unknown_override_ids:
        raise FullCampaignSelectionError(
            "Manual overrides supplied for unselected benchmarks: "
            + ", ".join(unknown_override_ids)
        )
    for benchmark_id, supplied in overrides_by_id.items():
        allowed = {
            key
            for phase in by_id[benchmark_id].phases
            for key in phase.required_overrides
        }
        unexpected = sorted(set(supplied) - allowed)
        if unexpected:
            raise FullCampaignSelectionError(
                f"{benchmark_id} manual overrides contain undeclared keys: "
                + ", ".join(unexpected)
            )
    cohorts: list[BenchmarkCohortResult] = []
    completed_phases: list[str] = []
    campaign_failed = False
    paused_cohort: BenchmarkCohortResult | None = None
    for benchmark_id in selected_ids:
        entry = by_id[benchmark_id]
        benchmark_overrides = overrides_by_id.get(benchmark_id, {})
        for phase in entry.phases:
            phase_request = _phase_request(
                request=request,
                entry=entry,
                phase=phase,
                overrides=benchmark_overrides,
            )
            while True:
                phase_results = run_benchmark_cohorts(
                    workspace_root=workspace_root,
                    request=phase_request,
                    harnesses=normalized_harnesses,
                    stop_after_failed_cohort=stop_after_failed_cohort,
                )
                if len(phase_results) != 1:
                    raise RuntimeError(
                        f"Expected one cohort for {benchmark_id}/{phase.name}, got {len(phase_results)}"
                    )
                cohort = phase_results[0]
                cohort_status = getattr(
                    cohort,
                    "status",
                    BenchmarkCohortStatus.SUCCEEDED,
                )
                if cohort_status not in {
                    BenchmarkCohortStatus.PAUSED,
                    BenchmarkCohortStatus.PAUSED_UNKNOWN,
                }:
                    break
                can_resume = (
                    wait_on_quota
                    and cohort_status == BenchmarkCohortStatus.PAUSED
                    and _wait_for_known_quota_retry(
                        retry_at=cohort.pause_retry_at,
                        max_wait_seconds=max_quota_wait_seconds,
                        poll_seconds=quota_poll_seconds,
                        now=quota_now,
                        sleep=quota_sleep,
                        heartbeat=quota_heartbeat,
                    )
                )
                if not can_resume:
                    paused_cohort = cohort
                    break
                phase_request = replace(
                    phase_request,
                    resume=True,
                    force=False,
                    rerun_failed=False,
                )
            if paused_cohort is not None:
                cohorts.append(paused_cohort)
                break
            if cohort.unsupported_harnesses:
                raise RuntimeError(
                    f"{benchmark_id}/{phase.name} unexpectedly omitted harnesses: "
                    + ", ".join(cohort.unsupported_harnesses)
                )
            cohorts.append(cohort)
            completed_phases.append(f"{benchmark_id}/{phase.name}")
            campaign_failed = any(
                outcome.status == "failed" for outcome in cohort.outcomes
            )
            if campaign_failed and stop_after_failed_cohort:
                break
        if campaign_failed and stop_after_failed_cohort:
            break
        if paused_cohort is not None:
            break

    selected_set = set(selected_ids)
    unscheduled = tuple(
        (entry.benchmark_id, entry.disposition, entry.reason)
        for entry in ADAPTER_CAMPAIGN_ENTRIES
        if entry.benchmark_id not in selected_set
    ) + tuple(
        (entry.entry_id, entry.disposition, entry.reason)
        for entry in DIRECT_CAMPAIGN_ENTRIES
    )
    return FullCampaignRun(
        cohorts=tuple(cohorts),
        completed_phases=tuple(completed_phases),
        unscheduled_entries=unscheduled,
        paused_cohort=paused_cohort,
    )


def _json_mapping(raw: str, *, flag: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        # error-policy:J3 malformed CLI JSON becomes an explicit selection error.
        raise FullCampaignSelectionError(f"{flag} must be valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise FullCampaignSelectionError(f"{flag} must decode to a JSON object")
    return value


def main(argv: list[str] | None = None) -> int:
    """Run the checked-in full campaign profile from an operator shell."""

    parser = argparse.ArgumentParser(
        description=(
            "Run full benchmark phases serially, with Eliza, Hermes, and "
            "OpenClaw together in each cohort."
        )
    )
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--benchmarks",
        nargs="+",
        help="Explicit canary/manual benchmark IDs; omit for every automatic cohort entry.",
    )
    parser.add_argument("--extra-json", default="{}")
    parser.add_argument("--manual-overrides-json", default="{}")
    parser.add_argument("--allow-manual", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--rerun-failed", action="store_true")
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument("--wait-on-quota", action="store_true")
    parser.add_argument(
        "--max-quota-wait-seconds",
        type=float,
        default=DEFAULT_MAX_QUOTA_WAIT_SECONDS,
    )
    parser.add_argument(
        "--quota-poll-seconds",
        type=float,
        default=DEFAULT_QUOTA_POLL_SECONDS,
    )
    args = parser.parse_args(argv)

    try:
        extra = _json_mapping(args.extra_json, flag="--extra-json")
        raw_overrides = _json_mapping(
            args.manual_overrides_json,
            flag="--manual-overrides-json",
        )
        manual_overrides: dict[str, dict[str, Any]] = {}
        for benchmark_id, value in raw_overrides.items():
            if not isinstance(value, dict):
                raise FullCampaignSelectionError(
                    "--manual-overrides-json values must be JSON objects"
                )
            manual_overrides[benchmark_id] = dict(value)
        result = run_full_campaign(
            workspace_root=Path(__file__).resolve().parents[2],
            request=RunRequest(
                benchmarks=(),
                agent="eliza",
                provider="claude-subscription",
                model=args.model,
                extra_config=extra,
                resume=bool(args.resume),
                rerun_failed=bool(args.rerun_failed),
                force=bool(args.force),
            ),
            benchmark_ids=tuple(args.benchmarks) if args.benchmarks else None,
            allow_manual=bool(args.allow_manual),
            manual_overrides=manual_overrides,
            stop_after_failed_cohort=not bool(args.keep_going),
            wait_on_quota=bool(args.wait_on_quota),
            max_quota_wait_seconds=float(args.max_quota_wait_seconds),
            quota_poll_seconds=float(args.quota_poll_seconds),
            quota_heartbeat=lambda payload: print(
                json.dumps(payload, sort_keys=True),
                file=sys.stderr,
                flush=True,
            ),
        )
    except CampaignStoragePreflightError as exc:
        print(
            json.dumps(
                {
                    "campaign_profile": FULL_CAMPAIGN_PROFILE,
                    "status": "storage_blocked",
                    "storage_preflight": {
                        "checked_at": exc.preflight.checked_at,
                        "path": exc.preflight.path,
                        "free_bytes": exc.preflight.free_bytes,
                        "min_free_bytes": exc.preflight.min_free_bytes,
                        "expected_headroom_bytes": exc.preflight.expected_headroom_bytes,
                        "required_bytes": exc.preflight.required_bytes,
                    },
                },
                indent=2,
            )
        )
        return STORAGE_PREFLIGHT_EXIT_CODE
    except KeyboardInterrupt:
        print(
            json.dumps(
                {
                    "campaign_profile": FULL_CAMPAIGN_PROFILE,
                    "status": "interrupted",
                }
            )
        )
        return 130
    except (FullCampaignManifestError, FullCampaignSelectionError) as exc:
        # error-policy:J1 argparse is the CLI boundary for campaign failures.
        parser.error(str(exc))

    failed = sum(
        1
        for cohort in result.cohorts
        if any(outcome.status == "failed" for outcome in cohort.outcomes)
    )
    paused = result.paused_cohort
    print(
        json.dumps(
            {
                "campaign_profile": FULL_CAMPAIGN_PROFILE,
                "completed_phases": list(result.completed_phases),
                "cohorts": len(result.cohorts),
                "reused_cohorts": sum(
                    1 for cohort in result.cohorts if cohort.reused
                ),
                "failed_cohorts": failed,
                "status": (
                    paused.status.value if paused is not None else "completed"
                ),
                "paused": (
                    {
                        "benchmark_id": paused.benchmark_id,
                        "run_group_id": paused.run_group_id,
                        "retry_at": paused.pause_retry_at,
                        "reason": paused.pause_reason,
                    }
                    if paused is not None
                    else None
                ),
                "unscheduled": [
                    {
                        "id": entry_id,
                        "disposition": disposition.value,
                        "reason": reason,
                    }
                    for entry_id, disposition, reason in result.unscheduled_entries
                ],
            },
            indent=2,
        )
    )
    if paused is not None:
        return QUOTA_PAUSED_EXIT_CODE
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
