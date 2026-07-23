"""Machine-checkable workload ledger for the exhaustive benchmark campaign.

Counts describe one manifest-entry execution: one selected harness for adapter
rows and one invocation for direct rows. The ledger keeps authored tasks,
expanded scenarios, scored result cells, and Claude-subscription calls separate
so dataset expansion and agent-loop variability cannot be mistaken for cost.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Iterable, Mapping, Sequence

from .full_campaign import (
    ADAPTER_CAMPAIGN_ENTRIES,
    CANONICAL_CAMPAIGN_HARNESSES,
    DIRECT_CAMPAIGN_ENTRIES,
    FULL_CAMPAIGN_PROFILE,
    CampaignDisposition,
)


class CampaignEntryKind(StrEnum):
    """Identifies whether the manifest launches an adapter or a direct command."""

    ADAPTER = "adapter"
    DIRECT = "direct"


class ModelCallCardinality(StrEnum):
    """States how precisely subscription-backed model calls can be predicted."""

    FIXED = "fixed"
    DATA_DEPENDENT = "data-dependent"
    UNKNOWN = "unknown"
    NOT_APPLICABLE = "not-applicable"


@dataclass(frozen=True)
class HarnessModelCallBounds:
    """Harness-specific logical request bounds for one manifest execution."""

    minimum: int | None
    maximum: int | None
    reference_one_tool_calls: int | None
    basis: str

    def to_dict(self) -> dict[str, object]:
        return {
            "minimum": self.minimum,
            "maximum": self.maximum,
            "reference_one_tool_calls": self.reference_one_tool_calls,
            "basis": self.basis,
        }


@dataclass(frozen=True)
class CampaignLedgerEntry:
    """Work and call cardinality for one exhaustive-campaign manifest entry.

    ``base_tasks`` counts authored or pinned dataset items. ``expanded_scenarios``
    counts selected episodes after campaign edge expansion but before repetitions,
    configuration axes, or step-level scoring. ``result_cells`` counts the
    independently scored rows ultimately expected from a successful execution.
    """

    entry_id: str
    kind: CampaignEntryKind
    disposition: CampaignDisposition
    base_tasks: int | None
    expanded_scenarios: int | None
    result_cells: int | None
    model_call_cardinality: ModelCallCardinality
    model_calls_exact: int | None = None
    model_calls_minimum: int | None = None
    model_calls_maximum: int | None = None
    harness_model_calls: tuple[tuple[str, HarnessModelCallBounds], ...] = ()
    dimensions: tuple[tuple[str, int], ...] = ()
    count_basis: str = ""
    coverage_issue: str | None = None

    @property
    def comparative_harness_count(self) -> int:
        """Return the number of native harness executions represented by the row."""

        if self.kind is CampaignEntryKind.ADAPTER and self.disposition in {
            CampaignDisposition.COHORT,
            CampaignDisposition.MANUAL,
        }:
            return len(CANONICAL_CAMPAIGN_HARNESSES)
        return 0

    @property
    def dimension_map(self) -> dict[str, int]:
        """Expose immutable stored dimensions as a serialization-friendly mapping."""

        return dict(self.dimensions)

    def to_dict(self) -> dict[str, object]:
        """Serialize the row with explicit per-execution and comparison totals."""

        harnesses = self.comparative_harness_count

        def comparative_total(value: int | None) -> int | None:
            return value * harnesses if value is not None and harnesses else None

        return {
            "entry_id": self.entry_id,
            "kind": self.kind.value,
            "disposition": self.disposition.value,
            "counts_per_execution": {
                "base_tasks": self.base_tasks,
                "expanded_scenarios": self.expanded_scenarios,
                "result_cells": self.result_cells,
            },
            "comparative_harness_count": harnesses,
            "three_harness_counts": {
                "base_tasks": comparative_total(self.base_tasks),
                "expanded_scenarios": comparative_total(self.expanded_scenarios),
                "result_cells": comparative_total(self.result_cells),
            },
            "model_calls_per_execution": {
                "cardinality": self.model_call_cardinality.value,
                "exact": self.model_calls_exact,
                "minimum": self.model_calls_minimum,
                "maximum": self.model_calls_maximum,
            },
            "three_harness_model_calls": {
                "exact": comparative_total(self.model_calls_exact),
                "minimum": comparative_total(self.model_calls_minimum),
                "maximum": comparative_total(self.model_calls_maximum),
            },
            "model_calls_by_harness": {
                harness: bounds.to_dict()
                for harness, bounds in self.harness_model_calls
            },
            "dimensions": self.dimension_map,
            "count_basis": self.count_basis,
            "coverage_issue": self.coverage_issue,
        }


def _dimensions(values: Mapping[str, int] | None) -> tuple[tuple[str, int], ...]:
    return tuple(sorted((values or {}).items()))


def _adapter(
    entry_id: str,
    disposition: CampaignDisposition,
    base_tasks: int | None,
    expanded_scenarios: int | None,
    result_cells: int | None,
    calls: ModelCallCardinality,
    *,
    exact: int | None = None,
    minimum: int | None = None,
    maximum: int | None = None,
    harness_model_calls: Mapping[str, HarnessModelCallBounds] | None = None,
    dimensions: Mapping[str, int] | None = None,
    basis: str,
    coverage_issue: str | None = None,
) -> CampaignLedgerEntry:
    return CampaignLedgerEntry(
        entry_id=entry_id,
        kind=CampaignEntryKind.ADAPTER,
        disposition=disposition,
        base_tasks=base_tasks,
        expanded_scenarios=expanded_scenarios,
        result_cells=result_cells,
        model_call_cardinality=calls,
        model_calls_exact=exact,
        model_calls_minimum=minimum,
        model_calls_maximum=maximum,
        harness_model_calls=tuple(sorted((harness_model_calls or {}).items())),
        dimensions=_dimensions(dimensions),
        count_basis=basis,
        coverage_issue=coverage_issue,
    )


def _direct(
    entry_id: str,
    disposition: CampaignDisposition,
    base_tasks: int | None,
    expanded_scenarios: int | None,
    result_cells: int | None,
    calls: ModelCallCardinality,
    *,
    exact: int | None = None,
    minimum: int | None = None,
    maximum: int | None = None,
    dimensions: Mapping[str, int] | None = None,
    basis: str,
) -> CampaignLedgerEntry:
    return CampaignLedgerEntry(
        entry_id=entry_id,
        kind=CampaignEntryKind.DIRECT,
        disposition=disposition,
        base_tasks=base_tasks,
        expanded_scenarios=expanded_scenarios,
        result_cells=result_cells,
        model_call_cardinality=calls,
        model_calls_exact=exact,
        model_calls_minimum=minimum,
        model_calls_maximum=maximum,
        dimensions=_dimensions(dimensions),
        count_basis=basis,
    )


_C = CampaignDisposition
_M = ModelCallCardinality


CAMPAIGN_LEDGER: tuple[CampaignLedgerEntry, ...] = (
    _adapter(
        "orchestrator_lifecycle",
        _C.COHORT,
        12,
        132,
        132,
        _M.DATA_DEPENDENT,
        minimum=154,
        harness_model_calls={
            "eliza": HarnessModelCallBounds(
                minimum=154,
                maximum=None,
                reference_one_tool_calls=3,
                basis=(
                    "Each bridge dispatch starts with RESPONSE_HANDLER; the reference "
                    "one-tool path then plans and evaluates. Stage-1 shape retries, "
                    "planner continuations, and evaluator gating make the total variable."
                ),
            ),
            "hermes": HarnessModelCallBounds(
                minimum=154,
                maximum=None,
                reference_one_tool_calls=2,
                basis=(
                    "The native AIAgent loop uses one request for a no-tool reply and "
                    "normally a tool request plus terminal reply. It caps native "
                    "iterations at four, but lower transport retries are not pinned."
                ),
            ),
            "openclaw": HarnessModelCallBounds(
                minimum=154,
                maximum=None,
                reference_one_tool_calls=2,
                basis=(
                    "The embedded loop uses one request for a no-tool reply and normally "
                    "a tool request plus terminal reply. The benchmark config has a "
                    "wall-clock timeout but no request-count ceiling."
                ),
            ),
        },
        dimensions={
            "base_user_turns": 14,
            "bridge_dispatches": 154,
            "expanded_user_turns": 154,
            "runner_response_retries": 0,
        },
        basis=(
            "Twelve lifecycle cases expand to eleven variants and 154 user turns. "
            "Each turn is dispatched exactly once; native model-loop requests remain "
            "harness- and response-dependent, so no common maximum is asserted."
        ),
    ),
    _adapter(
        "action-calling",
        _C.COHORT,
        63,
        693,
        693,
        _M.DATA_DEPENDENT,
        minimum=693,
        harness_model_calls={
            "eliza": HarnessModelCallBounds(
                minimum=693,
                maximum=None,
                reference_one_tool_calls=1,
                basis=(
                    "Each scored outer turn makes one AgentRuntime.useModel request. "
                    "Provider retries remain transport-dependent."
                ),
            ),
            "hermes": HarnessModelCallBounds(
                minimum=693,
                maximum=None,
                reference_one_tool_calls=1,
                basis=(
                    "Each scored outer turn enters the native AIAgent loop once; the "
                    "capture boundary interrupts after the scored tool execution. "
                    "Provider retries remain transport-dependent."
                ),
            ),
            "openclaw": HarnessModelCallBounds(
                minimum=693,
                maximum=None,
                reference_one_tool_calls=2,
                basis=(
                    "Each scored outer turn enters the embedded loop once. A normal "
                    "one-tool path requests the tool call and a terminal reply, while "
                    "native continuations and provider retries are not count-pinned."
                ),
            ),
        },
        dimensions={
            "base_cases": 63,
            "outer_scored_turns": 693,
            "variants_per_base": 11,
        },
        basis=(
            "The pinned 63-example corpus expands to eleven prompt variants and "
            "exactly 693 scored outer turns. Native model-loop requests differ by "
            "runtime and response, so only the outer dispatch count is exact."
        ),
    ),
    _adapter(
        "bfcl",
        _C.COHORT,
        4_441,
        48_851,
        48_851,
        _M.DATA_DEPENDENT,
        minimum=48_851,
        dimensions={"pinned_scoring_cases": 4_441, "variants_per_base": 11},
        basis="BFCL v3 pins 4,441 scoring cases; edge expansion is exact, but multi-turn call counts are not enumerated by the checked-in corpus contract.",
    ),
    _adapter(
        "gsm8k",
        _C.COHORT,
        1_319,
        1_319,
        1_319,
        _M.FIXED,
        exact=1_319,
        basis="The official GSM8K test split has 1,319 examples and the runner issues one completion per example.",
    ),
    _adapter(
        "mmlu",
        _C.COHORT,
        14_042,
        14_042,
        14_042,
        _M.FIXED,
        exact=14_042,
        basis="The complete MMLU test corpus has 14,042 questions and the runner issues one completion per question.",
    ),
    _adapter(
        "humaneval",
        _C.COHORT,
        164,
        164,
        164,
        _M.FIXED,
        exact=164,
        basis="HumanEval contains 164 problems and the runner requests one candidate per problem.",
    ),
    _adapter(
        "mt_bench",
        _C.COHORT,
        80,
        80,
        160,
        _M.DATA_DEPENDENT,
        minimum=320,
        maximum=480,
        dimensions={"candidate_turns": 160, "judge_cells": 160},
        basis="Eighty questions each produce and judge two turns; each judge cell may retry once.",
    ),
    _adapter(
        "abliteration-robustness",
        _C.COHORT,
        6_265,
        68_915,
        68_915,
        _M.FIXED,
        exact=68_915,
        basis="The pinned 6,265-row test split expands to eleven prompt variants with one completion each.",
    ),
    _adapter(
        "scambench",
        _C.COHORT,
        3_734,
        41_074,
        41_074,
        _M.FIXED,
        exact=41_074,
        basis="The complete 3,734-row test split expands to eleven prompt variants with one completion each.",
    ),
    _adapter(
        "context_bench",
        _C.COHORT,
        270,
        270,
        270,
        _M.FIXED,
        exact=270,
        basis="The full context-length and needle-position matrix contains 270 cells and one request per cell.",
    ),
    _adapter(
        "realm",
        _C.COHORT,
        1_110,
        12_210,
        12_210,
        _M.DATA_DEPENDENT,
        minimum=12_210,
        maximum=24_420,
        dimensions={"variants_per_base": 11, "max_planning_calls": 2},
        basis="The vendored P1-P11 corpus contains 1,110 instances and expands each to eleven variants; each task plans once and disruption-bearing tasks may replan once.",
    ),
    _adapter(
        "mint",
        _C.MANUAL,
        None,
        None,
        None,
        _M.DATA_DEPENDENT,
        basis="The provisioned tool/feedback corpus and ablation selection determine task and multi-turn call counts.",
    ),
    _adapter(
        "rlm_bench",
        _C.COHORT,
        81,
        891,
        891,
        _M.DATA_DEPENDENT,
        dimensions={
            "context_lengths": 3,
            "s_niah": 45,
            "s_niah_multi": 18,
            "oolong": 9,
            "oolong_pairs": 9,
            "variants_per_base": 11,
        },
        basis="Three context lengths times the configured S-NIAH and OOLONG generators yield 81 tasks and 891 variants; recursive agent work is response-dependent.",
    ),
    _adapter(
        "clawbench",
        _C.COHORT,
        5,
        55,
        55,
        _M.DATA_DEPENDENT,
        minimum=55,
        maximum=660,
        dimensions={"max_agent_turns": 12, "variants_per_base": 11},
        basis="Five workflows expand to eleven variants and permit one through twelve agent turns each.",
    ),
    _adapter(
        "woobench",
        _C.COHORT,
        18,
        198,
        198,
        _M.DATA_DEPENDENT,
        dimensions={"variants_per_base": 11},
        basis="Eighteen workflows expand to eleven variants; agent turns, retries, and LLM evaluator calls depend on trajectories.",
    ),
    _adapter(
        "webshop",
        _C.COHORT,
        500,
        5_500,
        5_500,
        _M.DATA_DEPENDENT,
        minimum=5_500,
        maximum=110_000,
        dimensions={
            "official_instructions": 500,
            "variants_per_base": 11,
            "max_agent_turns": 20,
        },
        basis="The full-profile contract pins 500 official instructions and exactly 5,500 expanded scenarios; each episode allows up to 20 turns.",
    ),
    _adapter(
        "vending_bench",
        _C.COHORT,
        5,
        55,
        55,
        _M.DATA_DEPENDENT,
        minimum=55,
        maximum=110_000,
        dimensions={"runs": 5, "variants_per_base": 11, "max_messages_per_run": 2_000},
        basis="Five seeded year-long runs expand to 55 episodes with a 2,000-message ceiling per episode.",
    ),
    _adapter(
        "tau_bench",
        _C.COHORT,
        165,
        1_815,
        7_260,
        _M.DATA_DEPENDENT,
        dimensions={"trials_per_scenario": 4, "variants_per_base": 11},
        basis="Both domains contain 165 tasks; eleven prompt variants and four trials produce 7,260 result cells, while agent and simulated-user turns vary.",
    ),
    _adapter(
        "trust",
        _C.COHORT,
        165,
        1_815,
        1_815,
        _M.FIXED,
        exact=1_815,
        basis="The 165-case trust corpus expands to eleven variants and sends one request for every variant.",
    ),
    _adapter(
        "agentbench",
        _C.UNSUPPORTED,
        1_264,
        13_904,
        13_904,
        _M.DATA_DEPENDENT,
        dimensions={
            "official_environments": 8,
            "resolved_base_tasks": 1_264,
            "resolved_expanded_scenarios": 13_904,
            "full_execution_environments": 0,
            "variants_per_base": 11,
        },
        basis="Pinned, hash-verified upstream metadata totals 1,264 tasks across eight environments and --count-scenarios resolves all 13,904 expanded scenarios.",
        coverage_issue="Full execution intentionally exits unsupported before model work because Avalon, ALFWorld, WebShop, and Mind2Web lack native runtime parity; there is no publishable partial full run.",
    ),
    _adapter(
        "lifeops_bench",
        _C.MANUAL,
        1_434,
        15_774,
        15_774,
        _M.DATA_DEPENDENT,
        dimensions={"variants_per_base": 11, "campaign_seeds": 1},
        basis="The scenario registry currently reports 1,434 authored scenarios and ten robustness variants per base; live simulator, judge, and agent turns vary.",
    ),
    _adapter(
        "multitask_bench",
        _C.MANUAL,
        10,
        30,
        30,
        _M.DATA_DEPENDENT,
        dimensions={"canonical_scenarios": 10, "lanes": 3},
        basis="The same fixed ten-scenario LifeOps sample runs in N=1, N=5, and N=10 lanes; agent-loop calls depend on each trajectory.",
    ),
    _adapter(
        "openclaw_bench",
        _C.COHORT,
        5,
        55,
        55,
        _M.DATA_DEPENDENT,
        minimum=55,
        maximum=825,
        dimensions={"max_agent_steps": 15, "variants_per_base": 11},
        basis="Five execution cases expand to eleven variants with one through fifteen agent steps each.",
    ),
    _adapter(
        "mind2web",
        _C.COHORT,
        1_341,
        14_751,
        103_158,
        _M.DATA_DEPENDENT,
        minimum=0,
        maximum=97_669,
        dimensions={
            "test_task_tasks": 252,
            "test_website_tasks": 177,
            "test_domain_tasks": 912,
            "official_steps": 9_378,
            "official_positive_steps": 8_879,
            "official_no_positive_steps": 499,
            "expanded_positive_steps": 97_669,
            "expanded_no_positive_steps": 5_489,
            "variants_per_base": 11,
        },
        basis="All three official splits total 1,341 tasks and 9,378 scored steps; no-positive steps and positive steps missed by the pinned top-K ranker skip the model, so 97,669 is a ceiling rather than a fabricated exact call count.",
    ),
    _adapter(
        "adhdbench",
        _C.COHORT,
        45,
        45,
        420,
        _M.FIXED,
        exact=1_260,
        dimensions={
            "basic_scenarios": 39,
            "full_scenarios": 45,
            "scale_points": 5,
            "basic_user_turns": 105,
            "full_user_turns": 147,
        },
        basis="Full mode runs 39 basic and 45 full cells across five scale points; their 105 and 147 user turns produce 1,260 requests.",
    ),
    _adapter(
        "app-eval",
        _C.COHORT,
        20,
        20,
        20,
        _M.DATA_DEPENDENT,
        minimum=20,
        maximum=210,
        dimensions={"research_tasks": 10, "coding_tasks": 10, "coding_max_turns": 20},
        basis="Ten research tasks use one call each and ten coding tasks allow one through twenty turns.",
    ),
    _adapter(
        "configbench",
        _C.COHORT,
        62,
        682,
        682,
        _M.FIXED,
        exact=1_177,
        dimensions={"expanded_user_turns": 1_177, "variants_per_base": 11},
        basis="Sixty-two configuration scenarios expand to 682 episodes containing exactly 1,177 user turns.",
    ),
    _adapter(
        "eliza_1",
        _C.COHORT,
        59,
        59,
        590,
        _M.DATA_DEPENDENT,
        minimum=590,
        maximum=1_180,
        dimensions={"repetitions": 10},
        basis="The complete 59-case should-respond corpus runs ten repetitions and retries an empty response once.",
    ),
    _adapter(
        "experience",
        _C.UNSUPPORTED,
        120,
        120,
        120,
        _M.FIXED,
        exact=120,
        dimensions={
            "background_experiences": 1_000,
            "learning_cycles": 20,
            "retrieval_queries": 100,
        },
        basis="The Eliza-only profile performs 20 learning cycles and 100 retrieval queries over 1,000 generated background experiences.",
    ),
    _adapter(
        "framework",
        _C.UNSUPPORTED,
        21,
        21,
        21,
        _M.DATA_DEPENDENT,
        dimensions={"named_profiles": 21, "generated_limit": 10_000, "iterations": 1},
        basis="The manifest names 21 runtime-overhead profiles; message volume varies by profile and is not a comparable three-harness call count.",
    ),
    _adapter(
        "interrupt_bench",
        _C.COHORT,
        10,
        110,
        110,
        _M.FIXED,
        exact=121,
        dimensions={"stage_one_calls": 121, "variants_per_base": 11},
        basis="Ten interruption cases expand to 110 episodes; the staged protocol makes 121 first-stage model requests.",
    ),
    _adapter(
        "personality_bench",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The scorer consumes an externally selected set of prerecorded trajectories and never invokes the selected harness.",
    ),
    _adapter(
        "three_agent_dialogue",
        _C.NON_AGENT,
        1,
        1,
        1,
        _M.NOT_APPLICABLE,
        basis="One canonical dialogue instantiates three Eliza agents internally and ignores the comparison harness.",
    ),
    _adapter(
        "eliza_replay",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="External recorded captures determine replay count and no selected harness executes.",
    ),
    _adapter(
        "trajectory_replay",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="External trajectory inputs determine replay count and no native comparison harness executes.",
    ),
    _adapter(
        "recall_bench",
        _C.NON_AGENT,
        10_000,
        10_000,
        10_000,
        _M.NOT_APPLICABLE,
        basis="The direct KPI lane deterministically indexes and searches 10,000 messages without a selected agent.",
    ),
    _adapter(
        "social_alpha",
        _C.MANUAL,
        None,
        None,
        None,
        _M.DATA_DEPENDENT,
        basis="The external Trenches data_dir determines corpus size and multi-turn conversation lengths.",
    ),
    _adapter(
        "solana",
        _C.MANUAL,
        1,
        1,
        1,
        _M.DATA_DEPENDENT,
        minimum=1,
        maximum=50,
        dimensions={"max_messages": 50},
        basis="The selected basic Surfpool environment is one episode without edge expansion and permits up to 50 agent messages.",
    ),
    _adapter(
        "gauntlet",
        _C.MANUAL,
        96,
        1_056,
        1_056,
        _M.DATA_DEPENDENT,
        minimum=231,
        maximum=1_056,
        dimensions={
            "level_zero_base_tasks": 21,
            "level_zero_expanded": 231,
            "variants_per_base": 11,
        },
        basis="Ninety-six tasks expand to 1,056 variants, but higher levels execute only after prior levels pass; each executed task sends once.",
    ),
    _adapter(
        "hyperliquid_bench",
        _C.MANUAL,
        1,
        11,
        11,
        _M.FIXED,
        exact=33,
        dimensions={"iterations_per_scenario": 3, "variants_per_base": 11},
        basis="The default real-backend case expands to eleven variants and the evaluator performs three agent iterations for each.",
    ),
    _adapter(
        "terminal_bench",
        _C.MANUAL,
        241,
        2_651,
        2_651,
        _M.DATA_DEPENDENT,
        minimum=2_651,
        maximum=53_020,
        dimensions={"max_iterations": 20, "variants_per_base": 11},
        basis="The full 241-task corpus expands to 2,651 episodes with one through twenty terminal-agent iterations.",
    ),
    _adapter(
        "swe_bench",
        _C.MANUAL,
        2_294,
        25_234,
        25_234,
        _M.DATA_DEPENDENT,
        minimum=25_234,
        maximum=75_702,
        dimensions={"max_requests_per_scenario": 3, "variants_per_base": 11},
        basis="The pinned full split has 2,294 tasks; each expanded task permits an initial request, a retry, and one repair request.",
    ),
    _adapter(
        "swe_bench_orchestrated",
        _C.MANUAL,
        2_294,
        25_234,
        25_234,
        _M.DATA_DEPENDENT,
        minimum=25_234,
        maximum=75_702,
        dimensions={"max_requests_per_scenario": 3, "variants_per_base": 11},
        basis="The orchestrated matrix covers the same pinned 2,294-task split and one selected harness, with up to three requests per expanded task.",
    ),
    _adapter(
        "osworld",
        _C.MANUAL,
        369,
        4_059,
        4_059,
        _M.DATA_DEPENDENT,
        minimum=4_059,
        maximum=60_885,
        dimensions={"max_steps": 15, "variants_per_base": 11},
        basis="All 369 OSWorld tasks expand to 4,059 episodes with one through fifteen visual-agent steps.",
    ),
    _adapter(
        "hermes_tblite",
        _C.MANUAL,
        100,
        100,
        100,
        _M.DATA_DEPENDENT,
        basis="The complete TBLite suite contains 100 tasks; native terminal-agent turn counts depend on execution.",
    ),
    _adapter(
        "hermes_terminalbench_2",
        _C.MANUAL,
        89,
        89,
        89,
        _M.DATA_DEPENDENT,
        basis="The complete TerminalBench 2 suite contains 89 tasks; native agent turns depend on execution.",
    ),
    _adapter(
        "hermes_yc_bench",
        _C.MANUAL,
        9,
        9,
        9,
        _M.DATA_DEPENDENT,
        basis="The environment runner's complete YC-Bench sample contract resolves to nine long-horizon tasks.",
    ),
    _adapter(
        "hermes_swe_env",
        _C.MANUAL,
        164,
        164,
        164,
        _M.FIXED,
        exact=164,
        basis="The pinned HumanEvalPack Python split has 164 tasks and the environment client sends once per task.",
    ),
    _adapter(
        "mmau",
        _C.MANUAL,
        9_000,
        99_000,
        99_000,
        _M.FIXED,
        exact=99_000,
        dimensions={"official_test_examples": 9_000, "variants_per_base": 11},
        basis="The official test split has 9,000 audio examples; eleven variants each issue one selected-harness answer request.",
    ),
    _adapter(
        "voicebench_quality",
        _C.MANUAL,
        None,
        None,
        None,
        _M.DATA_DEPENDENT,
        dimensions={"external_suites": 8},
        basis="Eight externally staged suites determine sample count; agent, STT, and quality-judge call counts depend on the samples and responses.",
    ),
    _adapter(
        "voiceagentbench",
        _C.MANUAL,
        None,
        None,
        None,
        _M.DATA_DEPENDENT,
        basis="Externally staged audio suites determine task count and cascaded STT, agent, and coherence-judge calls.",
    ),
    _adapter(
        "voicebench",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The fixed in-process voice profile does not publish a manifest-level case count and never selects a comparison harness.",
    ),
    _adapter(
        "vision_language",
        _C.UNSUPPORTED,
        14_490,
        159_390,
        159_390,
        _M.FIXED,
        exact=159_390,
        dimensions={
            "textvqa": 5_000,
            "docvqa": 5_349,
            "chartqa": 2_500,
            "screenspot": 1_272,
            "osworld": 369,
            "variants_per_base": 11,
        },
        basis="The five manifest phases total 14,490 samples; each of eleven variants makes one image-runtime request.",
    ),
    _adapter(
        "visualwebbench",
        _C.UNSUPPORTED,
        1_536,
        16_896,
        16_896,
        _M.FIXED,
        exact=16_896,
        dimensions={
            "action_ground": 103,
            "action_prediction": 281,
            "element_ground": 413,
            "element_ocr": 245,
            "heading_ocr": 46,
            "web_caption": 134,
            "webqa": 314,
            "variants_per_base": 11,
        },
        basis="The seven public Hugging Face configurations total 1,536 rows at revision 9dace8acebf210929bd47256d7ded44439377946; eleven variants produce one scored request each, although the current registry forces Eliza and its ten edge variants do not alter the image.",
    ),
    _adapter(
        "meeting_transcription_proof",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The command ignores harness and model selection and validates one externally supplied real-product evidence manifest.",
    ),
    _adapter(
        "meeting_voice",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The command ignores harness and model selection and validates one externally supplied real-product evidence manifest.",
    ),
    _adapter(
        "meeting_voice_real",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The command ignores harness and model selection and validates one externally supplied real-product evidence manifest.",
    ),
    _adapter(
        "meeting_voice_stress",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The command ignores harness and model selection and validates one externally supplied real-product evidence manifest.",
    ),
    _adapter(
        "meeting_voice_av",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The command ignores harness and model selection and validates one externally supplied real-product evidence manifest.",
    ),
    _direct(
        "agentbench_matrix",
        _C.MANUAL,
        None,
        None,
        None,
        _M.UNKNOWN,
        basis="The dedicated workbench's selection and configuration determine tasks and code-agent turns; it is not a tri-harness adapter.",
    ),
    _direct(
        "entity_voice_bench",
        _C.UNINTEGRATED,
        1,
        1,
        1,
        _M.FIXED,
        exact=1,
        basis="The manifest command supplies one text input to the direct real-LLM extraction lane.",
    ),
    _direct(
        "lifeops_quality",
        _C.NON_AGENT,
        78,
        78,
        78,
        _M.NOT_APPLICABLE,
        dimensions={
            "triage_items": 56,
            "timeliness_tasks": 22,
            "timeliness_windows": 2,
            "ticks_per_window": 1_153,
            "total_ticks": 2_306,
        },
        basis="The deterministic gates score 56 triage items and 22 scheduled tasks; 2,306 scheduler ticks are execution work, not additional scenarios.",
    ),
    _direct(
        "meeting_corpus_importers",
        _C.INFRASTRUCTURE,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="Importer contract tests are infrastructure support rather than a scored workload.",
    ),
    _direct(
        "searchbench",
        _C.NON_AGENT,
        10_000,
        10_000,
        10_000,
        _M.NOT_APPLICABLE,
        basis="The direct PGlite KPI operates on 10,000 messages without an agent or subscription model.",
    ),
    _direct(
        "voice_rtt",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="Live provider matrices and configured recordings determine cells; no Eliza/Hermes/OpenClaw harness participates.",
    ),
    _direct(
        "loadperf",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="App-load, web-vitals, and state-sync matrices are direct performance KPIs with configuration-dependent cells.",
    ),
    _direct(
        "memperf",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="Local-inference memory and eviction matrices are configuration-dependent and do not select a comparison harness.",
    ),
    _direct(
        "mobile_resource",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The available device/platform evidence determines KPI cells and no comparison harness executes.",
    ),
    _direct(
        "view_bundle_size",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="Discovered plugin bundles determine deterministic size-gate cells at execution time.",
    ),
    _direct(
        "voice_pipeline",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="Native voice backends available to the CI matrix determine cells; no comparison harness is selected.",
    ),
    _direct(
        "voice_emotion",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The staged MELD suite and intrinsic matrix determine cells; this is not a selected-harness model lane.",
    ),
    _direct(
        "voice_speaker_validation",
        _C.NON_AGENT,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The pytest validation matrix is infrastructure and domain lifecycle coverage rather than a comparison-harness workload.",
    ),
    _direct(
        "nl2repo",
        _C.UNINTEGRATED,
        104,
        104,
        104,
        _M.DATA_DEPENDENT,
        basis="The pinned Docker code-agent corpus contains 104 tasks without campaign expansion; agent turns vary by task.",
    ),
    _direct(
        "claude_subscription_gateway",
        _C.INFRASTRUCTURE,
        None,
        None,
        None,
        _M.NOT_APPLICABLE,
        basis="The gateway is shared transport and quota infrastructure, never a scored benchmark.",
    ),
)


class CampaignLedgerError(RuntimeError):
    """Raised when the checked-in workload ledger and campaign manifest diverge."""


def _entry_map() -> dict[str, CampaignLedgerEntry]:
    return {entry.entry_id: entry for entry in CAMPAIGN_LEDGER}


def _known_subtotal(
    entries: Sequence[CampaignLedgerEntry], attribute: str
) -> tuple[int, list[str]]:
    values: list[int] = []
    unknown: list[str] = []
    for entry in entries:
        value = getattr(entry, attribute)
        if value is None:
            unknown.append(entry.entry_id)
        else:
            values.append(value)
    return sum(values), unknown


def _summary_block(
    entries: Sequence[CampaignLedgerEntry], *, harness_multiplier: int
) -> dict[str, object]:
    counts: dict[str, object] = {}
    for label, attribute in (
        ("base_tasks", "base_tasks"),
        ("expanded_scenarios", "expanded_scenarios"),
        ("result_cells", "result_cells"),
    ):
        subtotal, unknown = _known_subtotal(entries, attribute)
        counts[label] = {
            "known_per_execution_subtotal": subtotal,
            "unknown_entries": unknown,
            "exact_per_execution_total": None if unknown else subtotal,
            "known_harness_total_subtotal": subtotal * harness_multiplier,
            "exact_harness_total": None if unknown else subtotal * harness_multiplier,
        }

    fixed = [
        entry
        for entry in entries
        if entry.model_call_cardinality is ModelCallCardinality.FIXED
    ]
    fixed_calls = sum(entry.model_calls_exact or 0 for entry in fixed)
    return {
        "entry_count": len(entries),
        "harness_multiplier": harness_multiplier,
        "counts": counts,
        "model_calls": {
            "fixed_entries": [entry.entry_id for entry in fixed],
            "fixed_per_execution_known_subtotal": fixed_calls,
            "fixed_harness_known_subtotal": fixed_calls * harness_multiplier,
            "data_dependent_entries": [
                entry.entry_id
                for entry in entries
                if entry.model_call_cardinality is ModelCallCardinality.DATA_DEPENDENT
            ],
            "unknown_entries": [
                entry.entry_id
                for entry in entries
                if entry.model_call_cardinality is ModelCallCardinality.UNKNOWN
            ],
            "not_applicable_entries": [
                entry.entry_id
                for entry in entries
                if entry.model_call_cardinality is ModelCallCardinality.NOT_APPLICABLE
            ],
        },
        "coverage_issue_entries": [
            entry.entry_id for entry in entries if entry.coverage_issue is not None
        ],
    }


def validate_campaign_ledger() -> tuple[CampaignLedgerEntry, ...]:
    """Fail closed when a workload is missing, duplicated, or internally invalid."""

    ids = [entry.entry_id for entry in CAMPAIGN_LEDGER]
    if len(ids) != len(set(ids)):
        duplicates = sorted({entry_id for entry_id in ids if ids.count(entry_id) > 1})
        raise CampaignLedgerError(f"duplicate ledger entries: {duplicates}")

    manifest_adapters = {
        entry.benchmark_id: entry for entry in ADAPTER_CAMPAIGN_ENTRIES
    }
    manifest_direct = {entry.entry_id: entry for entry in DIRECT_CAMPAIGN_ENTRIES}
    ledger_adapters = {
        entry.entry_id: entry
        for entry in CAMPAIGN_LEDGER
        if entry.kind is CampaignEntryKind.ADAPTER
    }
    ledger_direct = {
        entry.entry_id: entry
        for entry in CAMPAIGN_LEDGER
        if entry.kind is CampaignEntryKind.DIRECT
    }
    if ledger_adapters.keys() != manifest_adapters.keys():
        raise CampaignLedgerError(
            "adapter ledger mismatch: "
            f"missing={sorted(manifest_adapters.keys() - ledger_adapters.keys())}, "
            f"extra={sorted(ledger_adapters.keys() - manifest_adapters.keys())}"
        )
    if ledger_direct.keys() != manifest_direct.keys():
        raise CampaignLedgerError(
            "direct ledger mismatch: "
            f"missing={sorted(manifest_direct.keys() - ledger_direct.keys())}, "
            f"extra={sorted(ledger_direct.keys() - manifest_direct.keys())}"
        )

    for entry in CAMPAIGN_LEDGER:
        manifest_entry = (
            manifest_adapters[entry.entry_id]
            if entry.kind is CampaignEntryKind.ADAPTER
            else manifest_direct[entry.entry_id]
        )
        if entry.disposition is not manifest_entry.disposition:
            raise CampaignLedgerError(
                f"{entry.entry_id}: ledger disposition {entry.disposition.value!r} "
                f"does not match manifest {manifest_entry.disposition.value!r}"
            )
        if not entry.count_basis.strip():
            raise CampaignLedgerError(f"{entry.entry_id}: count_basis is required")
        for name in ("base_tasks", "expanded_scenarios", "result_cells"):
            value = getattr(entry, name)
            if value is not None and value < 0:
                raise CampaignLedgerError(
                    f"{entry.entry_id}: {name} cannot be negative"
                )
        if (
            entry.base_tasks is not None
            and entry.expanded_scenarios is not None
            and entry.expanded_scenarios < entry.base_tasks
        ):
            raise CampaignLedgerError(
                f"{entry.entry_id}: expanded scenarios cannot be fewer than base tasks"
            )
        if (
            entry.expanded_scenarios is not None
            and entry.result_cells is not None
            and entry.result_cells < entry.expanded_scenarios
        ):
            raise CampaignLedgerError(
                f"{entry.entry_id}: result cells cannot be fewer than expanded scenarios"
            )
        for name, value in entry.dimensions:
            if not name or value < 0:
                raise CampaignLedgerError(
                    f"{entry.entry_id}: invalid dimension {name!r}={value}"
                )
        if entry.model_call_cardinality is ModelCallCardinality.FIXED:
            if entry.model_calls_exact is None or entry.model_calls_exact < 0:
                raise CampaignLedgerError(
                    f"{entry.entry_id}: fixed calls require a non-negative exact count"
                )
            if (
                entry.model_calls_minimum is not None
                or entry.model_calls_maximum is not None
            ):
                raise CampaignLedgerError(
                    f"{entry.entry_id}: fixed calls cannot also carry bounds"
                )
        elif entry.model_calls_exact is not None:
            raise CampaignLedgerError(
                f"{entry.entry_id}: only fixed calls may carry an exact count"
            )
        if (
            entry.model_calls_minimum is not None
            and entry.model_calls_maximum is not None
            and entry.model_calls_minimum > entry.model_calls_maximum
        ):
            raise CampaignLedgerError(
                f"{entry.entry_id}: minimum calls exceed maximum calls"
            )
        harness_call_names = [name for name, _ in entry.harness_model_calls]
        if len(harness_call_names) != len(set(harness_call_names)):
            raise CampaignLedgerError(
                f"{entry.entry_id}: duplicate harness model-call bounds"
            )
        if entry.harness_model_calls and set(harness_call_names) != set(
            CANONICAL_CAMPAIGN_HARNESSES
        ):
            raise CampaignLedgerError(
                f"{entry.entry_id}: harness model-call bounds must cover the "
                "canonical comparison cohort"
            )
        for harness, bounds in entry.harness_model_calls:
            if not bounds.basis.strip():
                raise CampaignLedgerError(
                    f"{entry.entry_id}/{harness}: model-call basis is required"
                )
            for name, value in (
                ("minimum", bounds.minimum),
                ("maximum", bounds.maximum),
                ("reference_one_tool_calls", bounds.reference_one_tool_calls),
            ):
                if value is not None and value < 0:
                    raise CampaignLedgerError(
                        f"{entry.entry_id}/{harness}: {name} cannot be negative"
                    )
            if (
                bounds.minimum is not None
                and bounds.maximum is not None
                and bounds.minimum > bounds.maximum
            ):
                raise CampaignLedgerError(
                    f"{entry.entry_id}/{harness}: minimum calls exceed maximum calls"
                )
        if entry.disposition is CampaignDisposition.COHORT and None in {
            entry.base_tasks,
            entry.expanded_scenarios,
            entry.result_cells,
        }:
            raise CampaignLedgerError(
                f"{entry.entry_id}: automatic cohort counts must be exact"
            )

    by_id = _entry_map()
    webshop = by_id["webshop"]
    if (webshop.base_tasks, webshop.expanded_scenarios, webshop.result_cells) != (
        500,
        5_500,
        5_500,
    ):
        raise CampaignLedgerError("WebShop full-profile cardinality drifted")

    mind2web = by_id["mind2web"]
    if (
        mind2web.base_tasks,
        mind2web.expanded_scenarios,
        mind2web.result_cells,
        mind2web.model_calls_minimum,
        mind2web.model_calls_maximum,
    ) != (1_341, 14_751, 103_158, 0, 97_669):
        raise CampaignLedgerError("Mind2Web official split/step cardinality drifted")
    mind_dimensions = mind2web.dimension_map
    if (
        mind_dimensions["official_positive_steps"]
        + mind_dimensions["official_no_positive_steps"]
        != mind_dimensions["official_steps"]
    ):
        raise CampaignLedgerError("Mind2Web positive/no-positive steps do not sum")

    cohort_entries = [
        entry
        for entry in CAMPAIGN_LEDGER
        if entry.kind is CampaignEntryKind.ADAPTER
        and entry.disposition is CampaignDisposition.COHORT
    ]
    actual = tuple(
        sum(getattr(entry, attribute) or 0 for entry in cohort_entries)
        for attribute in ("base_tasks", "expanded_scenarios", "result_cells")
    )
    expected = (33_981, 213_801, 308_639)
    if actual != expected:
        raise CampaignLedgerError(
            f"automatic cohort cardinality drifted: expected={expected}, actual={actual}"
        )

    return CAMPAIGN_LEDGER


def campaign_ledger_report() -> dict[str, object]:
    """Return the validated ledger and exact-known/unknown campaign summaries."""

    entries = validate_campaign_ledger()
    automatic = [
        entry
        for entry in entries
        if entry.kind is CampaignEntryKind.ADAPTER
        and entry.disposition is CampaignDisposition.COHORT
    ]
    comparative = [
        entry
        for entry in entries
        if entry.kind is CampaignEntryKind.ADAPTER
        and entry.disposition
        in {CampaignDisposition.COHORT, CampaignDisposition.MANUAL}
    ]
    non_comparative = [entry for entry in entries if entry not in comparative]
    harness_count = len(CANONICAL_CAMPAIGN_HARNESSES)
    return {
        "schema_version": 1,
        "campaign_profile": FULL_CAMPAIGN_PROFILE,
        "canonical_harnesses": list(CANONICAL_CAMPAIGN_HARNESSES),
        "count_semantics": {
            "base_tasks": "Authored or pinned dataset items before campaign expansion.",
            "expanded_scenarios": "Selected task or episode trajectories after edge expansion but before repetitions, configuration axes, or step scoring.",
            "result_cells": "Independently scored output rows after repetitions, configuration axes, trials, or step-level scoring.",
            "model_calls": "Logical Claude-subscription-backed requests; dataset, ranker, or response-dependent execution remains data-dependent.",
            "unknown_policy": "Known subtotals exclude unknown rows and are never labeled as complete totals.",
        },
        "manifest": {
            "entries": len(entries),
            "adapter_entries": sum(
                entry.kind is CampaignEntryKind.ADAPTER for entry in entries
            ),
            "direct_entries": sum(
                entry.kind is CampaignEntryKind.DIRECT for entry in entries
            ),
        },
        "automatic_cohort": _summary_block(automatic, harness_multiplier=harness_count),
        "comparative_target": _summary_block(
            comparative, harness_multiplier=harness_count
        ),
        "non_comparative": _summary_block(non_comparative, harness_multiplier=0),
        "entries": [entry.to_dict() for entry in entries],
    }


def main(argv: Iterable[str] | None = None) -> int:
    """Print the validated ledger without launching a benchmark or model call."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Emit compact rather than indented JSON.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)
    indent = None if args.compact else 2
    print(json.dumps(campaign_ledger_report(), indent=indent, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
