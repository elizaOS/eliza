"""Shared fail-closed contracts for benchmark result publication.

The registry scorer, orchestrator database repair, latest-snapshot publisher,
and post-publication validator all consume these constants so a workload cannot
be accepted under four subtly different definitions of "complete".
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from typing import Any


ACTION_CALLING_FULL_BASE_CASE_COUNT = 63
ACTION_CALLING_FULL_SCENARIO_COUNT = 693
ACTION_CALLING_DATASET_ROW_COUNT = 11_578
ACTION_CALLING_DATASET_SHA256 = (
    "78dd3bc0b8cc98e0637231ae96dee7a63dbe1b5ae3e1b4fd7d862733ff5e162b"
)
ACTION_CALLING_CONTRACT_VERSION = "structured-output-tool-v2"
ACTION_CALLING_BASE_CASE_MANIFEST_SHA256 = (
    "d9eb9ddc74f23838960a81cc78e782ebd3127e849ee7048e748a13dacf58a58b"
)
ACTION_CALLING_EVALUATED_CASE_MANIFEST_SHA256 = (
    "147423d1dfc422cfab96670d1248b890344d56784e8940de05351620517609a9"
)
ACTION_CALLING_EVALUATED_CASE_ID_MANIFEST_SHA256 = (
    "51788d8fa8207b067597b845e9c5e83db9ab0de1f4d235d98a146b47a577441f"
)
ACTION_CALLING_SCHEMA_SOURCE_COUNTS = {
    "direct_json_schema": 45,
    "inferred_from_answer_shape": 4,
    "wrapped_json_schema": 14,
}


def action_calling_report_contract_reason(report: Mapping[str, Any]) -> str | None:
    """Validate the pinned corpus, recovery contract, and full expansion."""

    if report.get("provider") == "mock":
        return "action_calling_mock_provider"
    if report.get("generation_source") == "mock_expected_tool_calls":
        return "action_calling_mock_generation_source"
    generation_sources = report.get("generation_sources")
    if (
        isinstance(generation_sources, list)
        and "mock_expected_tool_calls" in generation_sources
    ):
        return "action_calling_mock_generation_source"
    if report.get("tool_choice") != "auto":
        return "action_calling_workload_contract_mismatch:tool_choice"
    if report.get("n") != ACTION_CALLING_FULL_SCENARIO_COUNT:
        return "action_calling_workload_contract_mismatch:n"
    provenance = report.get("dataset_provenance")
    if not isinstance(provenance, Mapping):
        return "action_calling_missing_dataset_provenance"
    expected = {
        "sha256": ACTION_CALLING_DATASET_SHA256,
        "row_count": ACTION_CALLING_DATASET_ROW_COUNT,
        "contract_version": ACTION_CALLING_CONTRACT_VERSION,
        "recovered_opaque_tasks_contract_count": ACTION_CALLING_FULL_BASE_CASE_COUNT,
        "recovered_schema_sources": ACTION_CALLING_SCHEMA_SOURCE_COUNTS,
        "base_case_manifest_sha256": ACTION_CALLING_BASE_CASE_MANIFEST_SHA256,
        "evaluated_case_manifest_sha256": ACTION_CALLING_EVALUATED_CASE_MANIFEST_SHA256,
        "evaluated_case_id_manifest_sha256": (
            ACTION_CALLING_EVALUATED_CASE_ID_MANIFEST_SHA256
        ),
        "loaded_base_case_count": ACTION_CALLING_FULL_BASE_CASE_COUNT,
        "evaluated_case_count": ACTION_CALLING_FULL_SCENARIO_COUNT,
        "scenario_expansion": True,
    }
    for field, expected_value in expected.items():
        if provenance.get(field) != expected_value:
            return f"action_calling_workload_contract_mismatch:{field}"
    return None


WEBSHOP_FULL_SCENARIO_COUNT = 5_500
WEBSHOP_FULL_MAX_TURNS_PER_SCENARIO = 20
WEBSHOP_FULL_SCENARIO_ID_MANIFEST_SHA256 = (
    "c6fea51b703d626abd557d6f143f1b4184a8d21e95c1c8e936ecaa0c2f9723cb"
)

WEBSHOP_FULL_REPORT_CONTRACT: dict[str, object] = {
    "mode": "eliza-bridge",
    "sample": False,
    "split": "test",
    "profile": "full",
    "dataset_source": "upstream-files",
    "hf_requested": True,
    "use_hf": False,
    "catalog_product_count": 1_181_430,
    "published_goal_count": 12_087,
    "include_edge_scenarios": True,
    "base_task_count": 500,
    "edge_scenario_count": 5_000,
    "scenario_count": WEBSHOP_FULL_SCENARIO_COUNT,
    "scenario_id_manifest_count": WEBSHOP_FULL_SCENARIO_COUNT,
    "scenario_id_manifest_sha256": WEBSHOP_FULL_SCENARIO_ID_MANIFEST_SHA256,
    "search_backend": "pyserini-lucene",
    # Anserini omits the 60 products whose submitted search-text projection is empty.
    "search_index_document_count": 1_181_370,
    "search_index_submitted_document_count": 1_181_430,
    "search_index_empty_projection_count": 60,
    "search_index_source_sha256": "2ef591d65df3af89e972ab72468eb82cbf124d876552d9f3678667edd620a6c8",
    "pyserini_version": "2.1.0",
    "anserini_version": "2.1.1",
    "spacy_version": "3.8.7",
    "spacy_model_name": "en_core_web_sm",
    "spacy_model_version": "3.8.0",
    "thefuzz_version": "0.22.1",
    "num_trials": 1,
    "max_turns_per_task": WEBSHOP_FULL_MAX_TURNS_PER_SCENARIO,
    "items_source_id": "1A2whVgOO0euk5O13n2iYDM0bQRkkRduB",
    "attributes_source_id": "1s2j6NgHljiZzQNL3veZaAiyW_qDEgBNi",
    "human_goals_source_id": "14Kb5SPBk_jfdLZ_CDBNitW98QLDlKR5O",
    "items_file_size": 5_479_720_229,
    "attributes_file_size": 186_295_270,
    "human_goals_file_size": 5_137_548,
    "items_sha256": "2ef591d65df3af89e972ab72468eb82cbf124d876552d9f3678667edd620a6c8",
    "attributes_sha256": "1d36af476bdb8f82a5da62bd8acdabe54cd8de2fa84010d37da5c4890feb447e",
    "human_goals_sha256": "cf78667548a71786e1d9049c24b802e48e1084ad4bb021cae56ce1f6d96954a3",
}


ORCHESTRATOR_LIFECYCLE_FULL_BASE_SCENARIO_COUNT = 12
ORCHESTRATOR_LIFECYCLE_FULL_EDGE_SCENARIO_COUNT = 120
ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_COUNT = 132
ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_COUNT = 154
ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_MANIFEST_SHA256 = (
    "f551305b92d3aa7e686d157dd7242ee4b0646190888c729bf4ed6cc50d1f0aa4"
)
ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_ID_MANIFEST_SHA256 = (
    "eece10cc4c10bd1cf8372892104ce3ce64befdcdd29a97e7d764dbf00df914fd"
)
ORCHESTRATOR_LIFECYCLE_FULL_CORPUS_SHA256 = (
    "ff39cb6d4774f7f00555b3696c3520202b0c31326887b9da1cef5a2d6b9291b8"
)
ORCHESTRATOR_LIFECYCLE_MEASUREMENT_SCOPE = "lifecycle_intent_capture_only"
ORCHESTRATOR_LIFECYCLE_SIDE_EFFECTS_EXECUTED = False
ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_COUNT = 1
ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_NAMES = ("TASKS",)
ORCHESTRATOR_LIFECYCLE_TOOL_CONTRACT_SHA256 = (
    "7ed7f8a5a7b28074518d298d8a4f1f735b78b72750a5b2edea2f6095a918c502"
)
ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256 = (
    "21a9634f076e39bf3f4f4c193ef5807e6c5d5fe1497f42ba32dccd2c36751d09"
)


def canonical_identifier_manifest_sha256(identifiers: Iterable[str]) -> str:
    """Hash the sorted unique identifiers with no trailing newline."""

    return hashlib.sha256(
        "\n".join(sorted(set(identifiers))).encode("utf-8")
    ).hexdigest()


def canonical_json_sha256(value: Any) -> str:
    """Hash JSON after stable key ordering and whitespace removal."""

    encoded = json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def webshop_report_contract_reason(metrics: Mapping[str, Any]) -> str | None:
    """Validate corpus, search, dependency, and scenario provenance fields."""

    for field, expected in WEBSHOP_FULL_REPORT_CONTRACT.items():
        if metrics.get(field) != expected:
            return f"webshop_workload_contract_mismatch:{field}"
    java_version = metrics.get("java_version")
    if (
        not isinstance(java_version, str)
        or re.search(r"(?<!\d)21(?:\.\d+)*(?!\d)", java_version) is None
    ):
        return "webshop_workload_contract_mismatch:java_version"
    return None


def webshop_workload_quarantine_reason(metrics: Mapping[str, Any]) -> str | None:
    """Return why a scored WebShop row lacks the exact executable workload.

    Aggregate counts alone are insufficient: a duplicated scenario can replace
    a missing one while leaving 5,500 rows. The report-side manifest is pinned
    to the reviewed corpus, and native per-turn telemetry must independently
    reconstruct the same identifier set.
    """

    report_reason = webshop_report_contract_reason(metrics)
    if report_reason is not None:
        return report_reason

    total_tasks = metrics.get("total_tasks")
    total_trials = metrics.get("total_trials")
    if total_tasks != WEBSHOP_FULL_SCENARIO_COUNT:
        return "webshop_workload_contract_mismatch:total_tasks"
    if total_trials != WEBSHOP_FULL_SCENARIO_COUNT:
        return "webshop_workload_contract_mismatch:total_trials"

    runtime = metrics.get("runtime_provenance")
    if not isinstance(runtime, Mapping):
        return "webshop_missing_model_call_provenance"

    telemetry_records = runtime.get("telemetry_records")
    task_id_records = runtime.get("task_id_records")
    missing_task_id_records = runtime.get("missing_task_id_records")
    task_id_manifest_count = runtime.get("task_id_manifest_count")
    task_id_manifest_sha256 = runtime.get("task_id_manifest_sha256")

    if not isinstance(telemetry_records, int):
        return "webshop_incomplete_model_call_coverage"
    if telemetry_records < WEBSHOP_FULL_SCENARIO_COUNT:
        return "webshop_incomplete_model_call_coverage"
    if (
        telemetry_records
        > WEBSHOP_FULL_SCENARIO_COUNT * WEBSHOP_FULL_MAX_TURNS_PER_SCENARIO
    ):
        return "webshop_model_call_count_exceeds_turn_budget"
    if task_id_records != telemetry_records or missing_task_id_records != 0:
        return "webshop_untagged_model_calls"
    if task_id_manifest_count != WEBSHOP_FULL_SCENARIO_COUNT:
        return "webshop_incomplete_scenario_model_call_coverage"
    if task_id_manifest_sha256 != WEBSHOP_FULL_SCENARIO_ID_MANIFEST_SHA256:
        return "webshop_scenario_model_call_manifest_mismatch"
    return None
