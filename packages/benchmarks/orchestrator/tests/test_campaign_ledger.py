"""Locks exhaustive-campaign workload arithmetic without launching paid model calls."""

from __future__ import annotations

import json

from benchmarks.orchestrator import campaign_ledger as ledger
from benchmarks.orchestrator import full_campaign as campaign


def _by_id() -> dict[str, ledger.CampaignLedgerEntry]:
    return {entry.entry_id: entry for entry in ledger.validate_campaign_ledger()}


def test_ledger_exactly_covers_every_manifest_entry_and_disposition() -> None:
    entries = ledger.validate_campaign_ledger()
    adapters = {
        entry.entry_id: entry
        for entry in entries
        if entry.kind is ledger.CampaignEntryKind.ADAPTER
    }
    direct = {
        entry.entry_id: entry
        for entry in entries
        if entry.kind is ledger.CampaignEntryKind.DIRECT
    }

    assert len(entries) == 73
    assert len(adapters) == 58
    assert len(direct) == 15
    assert set(adapters) == {
        entry.benchmark_id for entry in campaign.ADAPTER_CAMPAIGN_ENTRIES
    }
    assert set(direct) == {entry.entry_id for entry in campaign.DIRECT_CAMPAIGN_ENTRIES}
    for manifest_entry in campaign.ADAPTER_CAMPAIGN_ENTRIES:
        assert (
            adapters[manifest_entry.benchmark_id].disposition
            is manifest_entry.disposition
        )
    for manifest_entry in campaign.DIRECT_CAMPAIGN_ENTRIES:
        assert direct[manifest_entry.entry_id].disposition is manifest_entry.disposition


def test_automatic_cohort_has_exact_per_harness_and_three_harness_totals() -> None:
    report = ledger.campaign_ledger_report()
    automatic = report["automatic_cohort"]

    assert automatic["entry_count"] == 25
    assert automatic["harness_multiplier"] == 3
    assert automatic["counts"] == {
        "base_tasks": {
            "known_per_execution_subtotal": 33_981,
            "unknown_entries": [],
            "exact_per_execution_total": 33_981,
            "known_harness_total_subtotal": 101_943,
            "exact_harness_total": 101_943,
        },
        "expanded_scenarios": {
            "known_per_execution_subtotal": 213_801,
            "unknown_entries": [],
            "exact_per_execution_total": 213_801,
            "known_harness_total_subtotal": 641_403,
            "exact_harness_total": 641_403,
        },
        "result_cells": {
            "known_per_execution_subtotal": 308_639,
            "unknown_entries": [],
            "exact_per_execution_total": 308_639,
            "known_harness_total_subtotal": 925_917,
            "exact_harness_total": 925_917,
        },
    }
    assert automatic["model_calls"]["fixed_per_execution_known_subtotal"] == 130_157
    assert automatic["model_calls"]["fixed_harness_known_subtotal"] == 390_471
    assert automatic["model_calls"]["data_dependent_entries"] == [
        "orchestrator_lifecycle",
        "action-calling",
        "bfcl",
        "mt_bench",
        "realm",
        "rlm_bench",
        "clawbench",
        "woobench",
        "webshop",
        "vending_bench",
        "tau_bench",
        "openclaw_bench",
        "mind2web",
        "app-eval",
        "eliza_1",
    ]


def test_webshop_and_mind2web_publication_cardinalities_are_not_conflated() -> None:
    by_id = _by_id()
    webshop = by_id["webshop"]
    mind2web = by_id["mind2web"]

    assert (webshop.base_tasks, webshop.expanded_scenarios, webshop.result_cells) == (
        500,
        5_500,
        5_500,
    )
    assert webshop.model_call_cardinality is ledger.ModelCallCardinality.DATA_DEPENDENT
    assert (webshop.model_calls_minimum, webshop.model_calls_maximum) == (
        5_500,
        110_000,
    )

    assert (mind2web.base_tasks, mind2web.expanded_scenarios) == (1_341, 14_751)
    assert mind2web.result_cells == 103_158
    assert mind2web.model_call_cardinality is ledger.ModelCallCardinality.DATA_DEPENDENT
    assert (mind2web.model_calls_minimum, mind2web.model_calls_maximum) == (
        0,
        97_669,
    )
    assert mind2web.dimension_map == {
        "expanded_no_positive_steps": 5_489,
        "expanded_positive_steps": 97_669,
        "official_no_positive_steps": 499,
        "official_positive_steps": 8_879,
        "official_steps": 9_378,
        "test_domain_tasks": 912,
        "test_task_tasks": 252,
        "test_website_tasks": 177,
        "variants_per_base": 11,
    }
    assert 97_669 + 5_489 == 103_158

    serialized = {
        entry["entry_id"]: entry for entry in ledger.campaign_ledger_report()["entries"]
    }
    assert serialized["mind2web"]["three_harness_model_calls"] == {
        "exact": None,
        "minimum": 0,
        "maximum": 293_007,
    }
    assert serialized["webshop"]["three_harness_model_calls"] == {
        "exact": None,
        "minimum": 16_500,
        "maximum": 330_000,
    }


def test_lifecycle_separates_bridge_dispatches_from_native_model_calls() -> None:
    lifecycle = _by_id()["orchestrator_lifecycle"]
    serialized = lifecycle.to_dict()

    assert lifecycle.dimension_map == {
        "base_user_turns": 14,
        "bridge_dispatches": 154,
        "expanded_user_turns": 154,
        "runner_response_retries": 0,
    }
    assert serialized["model_calls_per_execution"] == {
        "cardinality": "data-dependent",
        "exact": None,
        "minimum": 154,
        "maximum": None,
    }
    assert serialized["three_harness_model_calls"] == {
        "exact": None,
        "minimum": 462,
        "maximum": None,
    }
    by_harness = serialized["model_calls_by_harness"]
    assert set(by_harness) == {"eliza", "hermes", "openclaw"}
    assert {name: row["minimum"] for name, row in by_harness.items()} == {
        "eliza": 154,
        "hermes": 154,
        "openclaw": 154,
    }
    assert {name: row["maximum"] for name, row in by_harness.items()} == {
        "eliza": None,
        "hermes": None,
        "openclaw": None,
    }
    assert {
        name: row["reference_one_tool_calls"] for name, row in by_harness.items()
    } == {"eliza": 3, "hermes": 2, "openclaw": 2}


def test_action_calling_separates_scored_turns_from_native_model_calls() -> None:
    action_calling = _by_id()["action-calling"]
    serialized = action_calling.to_dict()

    assert action_calling.dimension_map == {
        "base_cases": 63,
        "outer_scored_turns": 693,
        "variants_per_base": 11,
    }
    assert serialized["model_calls_per_execution"] == {
        "cardinality": "data-dependent",
        "exact": None,
        "minimum": 693,
        "maximum": None,
    }
    assert serialized["three_harness_model_calls"] == {
        "exact": None,
        "minimum": 2_079,
        "maximum": None,
    }
    by_harness = serialized["model_calls_by_harness"]
    assert set(by_harness) == {"eliza", "hermes", "openclaw"}
    assert {name: row["minimum"] for name, row in by_harness.items()} == {
        "eliza": 693,
        "hermes": 693,
        "openclaw": 693,
    }
    assert {name: row["maximum"] for name, row in by_harness.items()} == {
        "eliza": None,
        "hermes": None,
        "openclaw": None,
    }
    assert {
        name: row["reference_one_tool_calls"] for name, row in by_harness.items()
    } == {"eliza": 1, "hermes": 1, "openclaw": 2}


def test_agentbench_records_complete_count_resolution_and_runtime_blocker() -> None:
    agentbench = _by_id()["agentbench"]

    assert (agentbench.base_tasks, agentbench.expanded_scenarios) == (
        1_264,
        13_904,
    )
    assert agentbench.dimension_map == {
        "full_execution_environments": 0,
        "official_environments": 8,
        "resolved_base_tasks": 1_264,
        "resolved_expanded_scenarios": 13_904,
        "variants_per_base": 11,
    }
    assert agentbench.coverage_issue is not None
    assert "exits unsupported before model work" in agentbench.coverage_issue
    assert "partial full run" in agentbench.coverage_issue


def test_unknown_comparative_counts_remain_explicit_not_fabricated_totals() -> None:
    report = ledger.campaign_ledger_report()
    target = report["comparative_target"]
    expected_unknown = [
        "mint",
        "voicebench_quality",
        "voiceagentbench",
    ]

    assert target["entry_count"] == 42
    for metric in ("base_tasks", "expanded_scenarios", "result_cells"):
        assert target["counts"][metric]["unknown_entries"] == expected_unknown
        assert target["counts"][metric]["exact_per_execution_total"] is None
        assert target["counts"][metric]["exact_harness_total"] is None
    assert target["counts"]["base_tasks"]["known_per_execution_subtotal"] == 50_083
    assert (
        target["counts"]["expanded_scenarios"]["known_per_execution_subtotal"]
        == 387_213
    )
    assert target["counts"]["result_cells"]["known_per_execution_subtotal"] == 482_051
    assert target["model_calls"]["fixed_per_execution_known_subtotal"] == 229_354
    assert target["model_calls"]["fixed_harness_known_subtotal"] == 688_062
    assert target["coverage_issue_entries"] == []


def test_visualwebbench_cardinality_and_meeting_classification_are_pinned() -> None:
    by_id = _by_id()
    visual = by_id["visualwebbench"]
    assert (visual.base_tasks, visual.expanded_scenarios, visual.result_cells) == (
        1_536,
        16_896,
        16_896,
    )
    assert visual.model_call_cardinality is ledger.ModelCallCardinality.FIXED
    assert visual.model_calls_exact == 16_896
    assert visual.dimension_map == {
        "action_ground": 103,
        "action_prediction": 281,
        "element_ground": 413,
        "element_ocr": 245,
        "heading_ocr": 46,
        "variants_per_base": 11,
        "web_caption": 134,
        "webqa": 314,
    }

    for entry_id in (
        "meeting_transcription_proof",
        "meeting_voice",
        "meeting_voice_real",
        "meeting_voice_stress",
        "meeting_voice_av",
    ):
        meeting = by_id[entry_id]
        assert meeting.disposition is campaign.CampaignDisposition.NON_AGENT
        assert meeting.comparative_harness_count == 0
        assert (
            meeting.model_call_cardinality is ledger.ModelCallCardinality.NOT_APPLICABLE
        )


def test_direct_and_non_agent_work_do_not_inflate_three_harness_totals() -> None:
    by_id = _by_id()
    non_comparative = ledger.campaign_ledger_report()["non_comparative"]

    assert by_id["searchbench"].comparative_harness_count == 0
    assert by_id["recall_bench"].comparative_harness_count == 0
    assert by_id["experience"].comparative_harness_count == 0
    assert by_id["action-calling"].comparative_harness_count == 3
    assert by_id["realm"].comparative_harness_count == 3
    assert by_id["lifeops_quality"].dimension_map["total_ticks"] == 2_306
    assert non_comparative["harness_multiplier"] == 0
    assert all(
        counts["known_harness_total_subtotal"] == 0
        for counts in non_comparative["counts"].values()
    )


def test_cli_json_is_a_validated_side_effect_free_report(capsys) -> None:
    assert ledger.main(["--compact"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["campaign_profile"] == campaign.FULL_CAMPAIGN_PROFILE
    assert payload["canonical_harnesses"] == ["eliza", "hermes", "openclaw"]
    assert payload["manifest"] == {
        "entries": 73,
        "adapter_entries": 58,
        "direct_entries": 15,
    }
    assert len(payload["entries"]) == 73
