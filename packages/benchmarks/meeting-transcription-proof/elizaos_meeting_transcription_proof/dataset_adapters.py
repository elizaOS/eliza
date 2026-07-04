from __future__ import annotations

from copy import deepcopy
from typing import Any

ADAPTER_SCHEMA = "elizaos.meeting_dataset_adapter.v1"
MEETING_ARTIFACT_SCHEMA = "elizaos.meeting_artifact.v1"

REQUIRED_ADAPTER_FIELDS = {
    "id",
    "source_url",
    "license_access",
    "selected_split",
    "row_selection",
    "required_hashes",
    "output_schema",
    "scenario_runner",
    "score_json",
    "training_eval_separation",
}

REQUIRED_SCORE_METRICS = {
    "query_answer_correctness",
    "quote_grounding",
    "action_item_extraction",
    "agenda_topic_coverage",
    "summary_faithfulness",
}

ADAPTERS: tuple[dict[str, Any], ...] = (
    {
        "id": "qmsum_p0_smoke",
        "source_url": "https://github.com/Yale-LILY/QMSum",
        "license_access": {
            "repo_license": "MIT",
            "raw_data_policy": "downloaded-eval",
            "notes": (
                "QMSum publishes query-summary meeting data in data/ALL and "
                "domain folders; adapter must download at run time and record "
                "the exact source revision before scoring."
            ),
        },
        "selected_split": {
            "dataset": "QMSum",
            "split": "data/ALL/test",
            "source_domains": ["Academic", "Product", "Committee"],
        },
        "row_selection": {
            "strategy": "first_n_after_download",
            "row_count": 10,
            "row_id_fields": ["meeting_id", "query_id"],
            "content_hash_fields": [
                "meeting_transcripts",
                "general_query_list",
                "specific_query_list",
                "topic_list",
            ],
            "raw_rows_committed": False,
        },
        "required_hashes": [
            "source_revision",
            "row_id",
            "transcript_sha256",
            "reference_answer_sha256",
            "adapter_config_sha256",
        ],
        "output_schema": MEETING_ARTIFACT_SCHEMA,
        "scenario_runner": {
            "kind": "meeting_artifact_eval",
            "scenario_id_prefix": "qmsum-p0",
            "input_fields": ["transcript", "query", "reference_answer", "relevant_text_span"],
            "expected_artifact_fields": [
                "summary",
                "answers",
                "quotes",
                "action_items",
                "topics",
            ],
        },
        "score_json": {
            "metrics": sorted(REQUIRED_SCORE_METRICS),
            "requires_judge_model": True,
            "requires_manual_review": True,
            "publishable_requires_real_provider": True,
        },
        "training_eval_separation": {
            "eval_only": True,
            "training_allowed": False,
            "note": "Benchmark rows must not enter training or fine-tuning without explicit approval.",
        },
    },
    {
        "id": "meetingbank_p0_smoke",
        "source_url": "https://meetingbank.github.io/",
        "license_access": {
            "repo_license": "dataset-specific",
            "raw_data_policy": "downloaded-eval",
            "notes": (
                "MeetingBank provides city-council transcripts, agenda/minutes, "
                "audio, and videos through Hugging Face, Zenodo, and archive.org; "
                "adapter must record source URLs and content hashes per selected row."
            ),
        },
        "selected_split": {
            "dataset": "MeetingBank",
            "split": "test",
            "source_domains": ["city_council"],
        },
        "row_selection": {
            "strategy": "first_n_after_download",
            "row_count": 5,
            "row_id_fields": ["meeting_id", "segment_id"],
            "content_hash_fields": ["transcript", "summary", "agenda", "minutes"],
            "raw_rows_committed": False,
        },
        "required_hashes": [
            "source_revision",
            "row_id",
            "transcript_sha256",
            "reference_summary_sha256",
            "agenda_sha256",
            "adapter_config_sha256",
        ],
        "output_schema": MEETING_ARTIFACT_SCHEMA,
        "scenario_runner": {
            "kind": "meeting_artifact_eval",
            "scenario_id_prefix": "meetingbank-p0",
            "input_fields": ["transcript", "agenda", "reference_minutes", "reference_summary"],
            "expected_artifact_fields": [
                "summary",
                "quotes",
                "action_items",
                "topics",
                "decisions",
            ],
        },
        "score_json": {
            "metrics": sorted(REQUIRED_SCORE_METRICS),
            "requires_judge_model": True,
            "requires_manual_review": True,
            "publishable_requires_real_provider": True,
        },
        "training_eval_separation": {
            "eval_only": True,
            "training_allowed": False,
            "note": "City-council benchmark rows stay eval-only unless product/legal approve training use.",
        },
    },
)


def build_adapter_contract() -> dict[str, Any]:
    return {
        "schema": ADAPTER_SCHEMA,
        "adapters": deepcopy(list(ADAPTERS)),
        "raw_data_committed": False,
        "publishable_run_required": True,
    }


def validate_adapter_contract(contract: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if contract.get("schema") != ADAPTER_SCHEMA:
        errors.append(f"schema must be {ADAPTER_SCHEMA}")
    if contract.get("raw_data_committed") is not False:
        errors.append("raw_data_committed must be false")
    if contract.get("publishable_run_required") is not True:
        errors.append("publishable_run_required must be true")

    adapters = contract.get("adapters")
    if not isinstance(adapters, list) or not adapters:
        return [*errors, "adapters must be a non-empty array"]

    seen_ids: set[str] = set()
    for index, adapter in enumerate(adapters):
        if not isinstance(adapter, dict):
            errors.append(f"adapters[{index}] must be an object")
            continue
        missing = REQUIRED_ADAPTER_FIELDS - set(adapter)
        if missing:
            errors.append(f"adapters[{index}] missing fields: {sorted(missing)}")
        adapter_id = adapter.get("id")
        if not isinstance(adapter_id, str) or not adapter_id:
            errors.append(f"adapters[{index}].id must be non-empty")
        elif adapter_id in seen_ids:
            errors.append(f"duplicate adapter id: {adapter_id}")
        else:
            seen_ids.add(adapter_id)
        if adapter.get("output_schema") != MEETING_ARTIFACT_SCHEMA:
            errors.append(f"adapters[{index}].output_schema must be {MEETING_ARTIFACT_SCHEMA}")
        if adapter.get("license_access", {}).get("raw_data_policy") != "downloaded-eval":
            errors.append(f"adapters[{index}].license_access.raw_data_policy must be downloaded-eval")
        row_selection = adapter.get("row_selection", {})
        if row_selection.get("raw_rows_committed") is not False:
            errors.append(f"adapters[{index}].row_selection.raw_rows_committed must be false")
        row_count = row_selection.get("row_count")
        if isinstance(row_count, bool) or not isinstance(row_count, int) or row_count <= 0:
            errors.append(f"adapters[{index}].row_selection.row_count must be positive")
        required_hashes = adapter.get("required_hashes")
        if not isinstance(required_hashes, list) or "adapter_config_sha256" not in required_hashes:
            errors.append(f"adapters[{index}].required_hashes must include adapter_config_sha256")
        score_json = adapter.get("score_json", {})
        metrics = set(score_json.get("metrics", []))
        missing_metrics = REQUIRED_SCORE_METRICS - metrics
        if missing_metrics:
            errors.append(f"adapters[{index}].score_json missing metrics: {sorted(missing_metrics)}")
        if score_json.get("publishable_requires_real_provider") is not True:
            errors.append(f"adapters[{index}].score_json.publishable_requires_real_provider must be true")
        separation = adapter.get("training_eval_separation", {})
        if separation.get("eval_only") is not True or separation.get("training_allowed") is not False:
            errors.append(f"adapters[{index}].training_eval_separation must be eval-only")
    return errors
