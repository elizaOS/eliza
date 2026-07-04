from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

LANES = {"mocked_plumbing", "real_product"}
REQUIRED_SURFACES = {"zoom", "google_meet", "on_device", "cloud_agent", "hybrid_local_cloud"}
REQUIRED_CAPTURE_MODES = {"bot", "bot_free"}
REQUIRED_CAPTURE_PATHS = {
    "zoom_bot",
    "zoom_bot_free",
    "google_meet_bot",
    "google_meet_bot_free",
    "on_device_capture",
    "cloud_agent_capture",
    "hybrid_local_cloud",
}
REQUIRED_CAPTURE_PATH_FIELDS = {
    "id",
    "surface",
    "capture_mode",
    "participant_metadata",
    "consent_disclosure",
    "media_streams",
    "evidence",
}
REQUIRED_EVIDENCE = {
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
REQUIRED_SPEAKER_OPERATIONS = {
    "known_speaker_enrollment",
    "known_speaker_recognition",
    "unknown_speaker_creation",
    "speaker_name_correction",
    "duplicate_speaker_merge",
    "incorrect_speaker_split",
    "voice_profile_deletion",
    "post_deletion_non_recognition",
    "multi_speaker_single_stream_attribution",
    "shared_room_uncertainty",
}
REQUIRED_SPEAKER_OPERATION_FIELDS = {
    "id",
    "surface",
    "evidence",
    "metrics",
    "privacy_control",
    "confidence_policy",
}
REQUIRED_AUDIO_VISUAL_CASES = {
    "ava_active_speaker",
    "misp_2025_meeting",
    "easycom_license_permitting",
    "synthetic_room_feed_smoke",
    "off_screen_speaker",
    "visual_acoustic_disagreement",
    "audio_video_association",
}
REQUIRED_AUDIO_VISUAL_FIELDS = {
    "id",
    "dataset",
    "coverage",
    "tasks",
    "metrics",
    "evidence",
    "identity_policy",
}
REQUIRED_AUDIO_VISUAL_COVERAGE = {
    "video_frames",
    "face_tracks",
    "audio_streams",
    "transcripts",
    "speaker_ids",
    "source_metadata",
    "active_speaker_labels",
    "person_count_labels",
    "off_screen_speaker_labels",
    "audio_video_association_labels",
    "room_feed_labels",
}
REQUIRED_AUDIO_VISUAL_TASKS = {
    "face_count",
    "active_speaker",
    "off_screen_speaker",
    "audio_video_association",
    "room_feed",
    "visual_acoustic_disagreement",
}
REQUIRED_AUDIO_VISUAL_METRICS = {
    "face_count_accuracy",
    "active_speaker_f1",
    "active_speaker_map",
    "audio_video_association_accuracy",
    "off_screen_speaker_detection_accuracy",
    "room_feed_heuristic_precision",
    "room_feed_heuristic_recall",
    "visual_acoustic_disagreement_rate",
}
ALLOWED_AUDIO_VISUAL_IDENTITY_SOURCES = {
    "voice_profile",
    "user_correction",
    "calendar_participant",
    "platform_roster",
    "none",
}
REQUIRED_GENERATED_ARTIFACT_SCORE_IDS = {
    "summary_factuality",
    "action_item_owner_date",
    "decision_extraction",
    "open_question_extraction",
    "memory_entity_correctness",
    "hallucination_rate",
    "omission_rate",
    "source_grounding",
}
REQUIRED_GENERATED_ARTIFACT_SCORE_FIELDS = {
    "id",
    "judge_mode",
    "observed_score",
    "threshold",
    "higher_is_better",
    "passed",
    "proof",
}
GENERATED_ARTIFACT_JUDGE_MODES = {"deterministic", "live_model", "manual"}
REQUIRED_BASELINE_COMPARISONS = {
    "eliza_current_baseline",
    "otter_product_baseline",
    "granola_product_baseline",
    "zoom_native_notes_baseline",
    "google_meet_gemini_notes_baseline",
    "whisperx_pyannote_open_source_baseline",
    "nemo_sortformer_open_source_baseline",
}
REQUIRED_BASELINE_COMPARISON_FIELDS = {
    "id",
    "system",
    "comparison_type",
    "run_status",
    "capture_mode",
    "privacy_mode",
    "conditions",
    "metrics",
    "eliza_artifact",
    "baseline_artifact",
    "manual_review_status",
    "evidence",
    "failure_policy",
}
BASELINE_COMPARISON_TYPES = {
    "external_product",
    "open_source",
    "internal_baseline",
}
BASELINE_RUN_STATUSES = {"run", "imported", "not_run"}
BASELINE_REVIEW_STATUSES = {"reviewed", "not_applicable"}
REQUIRED_BASELINE_CONDITIONS = {
    "speech_over_music",
    "speech_over_noise",
    "speech_over_babble",
    "overlapped_speech",
    "far_field_reverberant_room",
    "multiple_people_single_stream",
    "shared_room_microphone",
}
REQUIRED_BASELINE_METRICS = {
    "wer",
    "cer",
    "der",
    "jer",
    "cpwer",
    "wder",
    "speaker_name_accuracy",
    "action_item_f1",
    "decision_f1",
    "unsupported_claim_rate",
    "latency_ms",
    "privacy_capture_mode",
}
REQUIRED_SPEAKER_NAME_PROVENANCE_CASES = {
    "platform_roster_name",
    "calendar_attendee_name",
    "self_introduction_name",
    "user_correction_name",
    "voice_profile_match_name",
    "recurring_speaker_memory",
    "same_first_name_ambiguity",
    "borrowed_device_guardrail",
}
REQUIRED_SPEAKER_NAME_PROVENANCE_FIELDS = {
    "id",
    "source",
    "surface",
    "evidence",
    "signals",
    "confidence",
    "conflict_policy",
    "confidence_policy",
    "privacy_policy",
    "expected_resolution",
}
REQUIRED_SPEAKER_NAME_SOURCES = {
    "platform_roster",
    "calendar_attendee",
    "self_introduction",
    "user_correction",
    "voice_profile",
    "speaker_memory",
}
REQUIRED_SPEAKER_NAME_SIGNALS = {
    "platform_label",
    "calendar_attendee",
    "self_introduction",
    "user_correction",
    "voice_profile_match",
    "recurring_meeting_memory",
    "same_first_name_ambiguity",
    "borrowed_device_guardrail",
}
REQUIRED_SPEAKER_NAME_RESOLUTIONS = {
    "apply_name",
    "withhold_name",
    "request_confirmation",
    "prefer_user_correction",
    "preserve_unknown",
}
CONFIRMED_SPEAKER_NAME_RESOLUTIONS = {"apply_name", "prefer_user_correction"}
FORBIDDEN_SPEAKER_NAME_POLICY_TERMS = {
    "age",
    "disability",
    "ethnicity",
    "gender",
    "nationality",
    "race",
    "religion",
    "sexual orientation",
}
REQUIRED_SCENARIOS = {
    "clean_single_speaker",
    "zoom_bot",
    "zoom_bot_free",
    "google_meet_bot",
    "google_meet_bot_free",
    "on_device_capture",
    "cloud_agent_capture",
    "hybrid_local_cloud",
    "multiple_people_single_stream",
    "shared_room_microphone",
    "speech_over_music",
    "speech_over_noise",
    "speech_over_babble",
    "overlapped_speech",
    "far_field_room",
    "known_speaker_recognition",
    "unknown_speaker_creation",
    "speaker_name_correction",
    "voice_profile_deletion",
    "transcript_sharing_export_delete",
}
REQUIRED_SCENARIO_FIELDS = {"id", "surface", "capture_mode", "evidence"}
REQUIRED_DATASET_CONDITIONS = {
    "speech_over_music",
    "speech_over_noise",
    "speech_over_babble",
    "overlapped_speech",
    "far_field_reverberant_room",
    "multiple_people_single_stream",
    "shared_room_microphone",
    "audiovisual_meeting",
}
REQUIRED_DATASET_ANNOTATIONS = {
    "transcript",
    "diarization",
    "speaker_identity",
    "active_speaker_video",
    "noise_music_babble_labels",
}
REQUIRED_DATASET_FIELDS = {
    "id",
    "source_url",
    "license",
    "version",
    "checksum",
    "conditions",
    "splits",
    "sample_count",
    "duration_seconds",
    "annotation_types",
    "target_metrics",
    "evidence",
}
REQUIRED_QUALITY_METRICS = {
    "transcript_quality",
    "diarization_quality",
    "speaker_identity_quality",
    "consent_retention_quality",
}
REQUIRED_DETAILED_METRICS = {
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
    *REQUIRED_AUDIO_VISUAL_METRICS,
    "summary_factuality",
    "action_item_owner_date",
    "decision_extraction",
    "open_question_extraction",
    "memory_entity_correctness",
    "hallucination_rate",
    "omission_rate",
    "source_grounding",
}
RATIO_METRICS = {
    *REQUIRED_QUALITY_METRICS,
    "wer",
    "cer",
    "speaker_attributed_wer",
    "der",
    "jer",
    "overlap_aware_wer",
    "active_speaker_accuracy",
    "voice_profile_false_accept_rate",
    "voice_profile_false_reject_rate",
    "notes_factuality",
    "action_item_extraction",
    *REQUIRED_AUDIO_VISUAL_METRICS,
    "summary_factuality",
    "action_item_owner_date",
    "decision_extraction",
    "open_question_extraction",
    "memory_entity_correctness",
    "hallucination_rate",
    "omission_rate",
    "source_grounding",
}
LATENCY_METRICS = {"end_of_turn_latency_ms", "barge_in_latency_ms", "p95_end_to_end_latency_ms"}
KNOWN_METRICS = REQUIRED_QUALITY_METRICS | REQUIRED_DETAILED_METRICS


def _package_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: manifest root must be an object")
    return data


def _as_set(value: Any, *, field: str) -> set[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{field} must be a string array")
    return {item for item in value if item}


def _require_number(metrics: dict[str, Any], key: str) -> float:
    value = metrics.get(key)
    return _require_ratio_value(f"metrics.{key}", value)


def _require_ratio_value(field: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{field} must be numeric")
    number = float(value)
    if number < 0 or number > 1:
        raise ValueError(f"{field} must be in [0, 1]")
    return number


def _require_non_negative_number(metrics: dict[str, Any], key: str) -> float:
    value = metrics.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"metrics.{key} must be numeric")
    number = float(value)
    if number < 0:
        raise ValueError(f"metrics.{key} must be non-negative")
    return number


def _validate_metrics(metrics: Any, *, lane: str) -> dict[str, float]:
    if not isinstance(metrics, dict):
        raise ValueError("metrics must be an object")
    missing_quality = REQUIRED_QUALITY_METRICS - set(metrics)
    if missing_quality:
        raise ValueError(f"missing quality metrics: {sorted(missing_quality)}")
    if lane == "real_product":
        missing_detailed = REQUIRED_DETAILED_METRICS - set(metrics)
        if missing_detailed:
            raise ValueError(f"missing detailed metrics: {sorted(missing_detailed)}")

    metric_values: dict[str, float] = {}
    optional_detailed_metrics = REQUIRED_DETAILED_METRICS & set(metrics)
    required_for_lane = REQUIRED_QUALITY_METRICS | (
        REQUIRED_DETAILED_METRICS if lane == "real_product" else optional_detailed_metrics
    )
    for key in sorted(required_for_lane):
        if key in LATENCY_METRICS:
            metric_values[key] = _require_non_negative_number(metrics, key)
        elif key in RATIO_METRICS:
            metric_values[key] = _require_number(metrics, key)
        else:
            raise ValueError(f"metrics.{key} has no validator")
    return metric_values


def _validate_evidence_files(manifest: dict[str, Any], manifest_path: Path) -> dict[str, str]:
    evidence = manifest.get("evidence")
    if not isinstance(evidence, dict):
        raise ValueError("evidence must be an object")
    missing_types = REQUIRED_EVIDENCE - set(evidence)
    if missing_types:
        raise ValueError(f"missing evidence types: {sorted(missing_types)}")

    resolved: dict[str, str] = {}
    for evidence_type in sorted(REQUIRED_EVIDENCE):
        raw_path = evidence.get(evidence_type)
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError(f"evidence.{evidence_type} must be a non-empty path")
        path = Path(raw_path)
        if not path.is_absolute():
            path = manifest_path.parent / path
        if not path.is_file():
            raise ValueError(f"evidence.{evidence_type} does not exist: {path}")
        resolved[evidence_type] = str(path.resolve())
    return resolved


def _validate_scenarios(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    scenarios = manifest.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError("scenarios must be a non-empty array")

    scenario_ids: set[str] = set()
    referenced_evidence: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, scenario in enumerate(scenarios):
        if not isinstance(scenario, dict):
            raise ValueError(f"scenarios[{index}] must be an object")
        missing_fields = REQUIRED_SCENARIO_FIELDS - set(scenario)
        if missing_fields:
            raise ValueError(f"scenarios[{index}] missing fields: {sorted(missing_fields)}")
        scenario_id = scenario.get("id")
        if not isinstance(scenario_id, str) or not scenario_id.strip():
            raise ValueError(f"scenarios[{index}].id must be a non-empty string")
        scenario_ids.add(scenario_id)

        surface = scenario.get("surface")
        if not isinstance(surface, str) or not surface.strip():
            raise ValueError(f"scenarios[{index}].surface must be a non-empty string")
        capture_mode = scenario.get("capture_mode")
        if not isinstance(capture_mode, str) or not capture_mode.strip():
            raise ValueError(f"scenarios[{index}].capture_mode must be a non-empty string")
        evidence = scenario.get("evidence")
        if not isinstance(evidence, list) or not all(isinstance(item, str) and item for item in evidence):
            raise ValueError(f"scenarios[{index}].evidence must be a non-empty string array")
        evidence_types = set(evidence)
        unknown_evidence = evidence_types - REQUIRED_EVIDENCE
        if unknown_evidence:
            raise ValueError(f"scenarios[{index}] references unknown evidence: {sorted(unknown_evidence)}")
        referenced_evidence.update(evidence_types)
        normalized.append(
            {
                "id": scenario_id,
                "surface": surface,
                "capture_mode": capture_mode,
                "evidence": sorted(evidence_types),
            }
        )

    missing_scenarios = REQUIRED_SCENARIOS - scenario_ids
    if missing_scenarios:
        raise ValueError(f"missing scenarios: {sorted(missing_scenarios)}")
    missing_evidence_references = REQUIRED_EVIDENCE - referenced_evidence
    if missing_evidence_references:
        raise ValueError(f"scenarios do not reference evidence: {sorted(missing_evidence_references)}")
    return sorted(normalized, key=lambda scenario: scenario["id"]), referenced_evidence


def _validate_dataset_sources(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    dataset_sources = manifest.get("dataset_sources")
    if not isinstance(dataset_sources, list) or not dataset_sources:
        raise ValueError("dataset_sources must be a non-empty array")

    covered_conditions: set[str] = set()
    covered_annotations: set[str] = set()
    referenced_evidence: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, dataset in enumerate(dataset_sources):
        if not isinstance(dataset, dict):
            raise ValueError(f"dataset_sources[{index}] must be an object")
        missing_fields = REQUIRED_DATASET_FIELDS - set(dataset)
        if missing_fields:
            raise ValueError(f"dataset_sources[{index}] missing fields: {sorted(missing_fields)}")
        dataset_id = dataset.get("id")
        if not isinstance(dataset_id, str) or not dataset_id.strip():
            raise ValueError(f"dataset_sources[{index}].id must be a non-empty string")
        source_url = dataset.get("source_url")
        if not isinstance(source_url, str) or not source_url.strip():
            raise ValueError(f"dataset_sources[{index}].source_url must be a non-empty string")
        license_name = dataset.get("license")
        if not isinstance(license_name, str) or not license_name.strip():
            raise ValueError(f"dataset_sources[{index}].license must be a non-empty string")
        version = dataset.get("version")
        if not isinstance(version, str) or not version.strip():
            raise ValueError(f"dataset_sources[{index}].version must be a non-empty string")
        checksum = dataset.get("checksum")
        if not isinstance(checksum, str) or not checksum.strip():
            raise ValueError(f"dataset_sources[{index}].checksum must be a non-empty string")
        conditions = _as_set(dataset.get("conditions"), field=f"dataset_sources[{index}].conditions")
        splits = _as_set(dataset.get("splits"), field=f"dataset_sources[{index}].splits")
        if not splits:
            raise ValueError(f"dataset_sources[{index}].splits must be non-empty")
        sample_count = dataset.get("sample_count")
        if isinstance(sample_count, bool) or not isinstance(sample_count, int) or sample_count <= 0:
            raise ValueError(f"dataset_sources[{index}].sample_count must be a positive integer")
        duration_seconds = dataset.get("duration_seconds")
        if (
            isinstance(duration_seconds, bool)
            or not isinstance(duration_seconds, int | float)
            or float(duration_seconds) <= 0
        ):
            raise ValueError(f"dataset_sources[{index}].duration_seconds must be a positive number")
        annotation_types = _as_set(
            dataset.get("annotation_types"), field=f"dataset_sources[{index}].annotation_types"
        )
        if not annotation_types:
            raise ValueError(f"dataset_sources[{index}].annotation_types must be non-empty")
        target_metrics = _as_set(dataset.get("target_metrics"), field=f"dataset_sources[{index}].target_metrics")
        if not target_metrics:
            raise ValueError(f"dataset_sources[{index}].target_metrics must be non-empty")
        unknown_target_metrics = target_metrics - KNOWN_METRICS
        if unknown_target_metrics:
            raise ValueError(
                f"dataset_sources[{index}] references unknown target metrics: {sorted(unknown_target_metrics)}"
            )
        evidence = _as_set(dataset.get("evidence"), field=f"dataset_sources[{index}].evidence")
        unknown_evidence = evidence - REQUIRED_EVIDENCE
        if unknown_evidence:
            raise ValueError(f"dataset_sources[{index}] references unknown evidence: {sorted(unknown_evidence)}")
        covered_conditions.update(conditions)
        covered_annotations.update(annotation_types)
        referenced_evidence.update(evidence)
        normalized.append(
            {
                "id": dataset_id,
                "source_url": source_url,
                "license": license_name,
                "version": version,
                "checksum": checksum,
                "conditions": sorted(conditions),
                "splits": sorted(splits),
                "sample_count": sample_count,
                "duration_seconds": float(duration_seconds),
                "annotation_types": sorted(annotation_types),
                "target_metrics": sorted(target_metrics),
                "evidence": sorted(evidence),
            }
        )

    missing_conditions = REQUIRED_DATASET_CONDITIONS - covered_conditions
    if missing_conditions:
        raise ValueError(f"dataset_sources missing conditions: {sorted(missing_conditions)}")
    missing_annotations = REQUIRED_DATASET_ANNOTATIONS - covered_annotations
    if missing_annotations:
        raise ValueError(f"dataset_sources missing annotation types: {sorted(missing_annotations)}")
    return sorted(normalized, key=lambda dataset: dataset["id"]), referenced_evidence


def _validate_capture_paths(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    capture_paths = manifest.get("capture_paths")
    if not isinstance(capture_paths, list) or not capture_paths:
        raise ValueError("capture_paths must be a non-empty array")

    path_ids: set[str] = set()
    referenced_evidence: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, capture_path in enumerate(capture_paths):
        if not isinstance(capture_path, dict):
            raise ValueError(f"capture_paths[{index}] must be an object")
        missing_fields = REQUIRED_CAPTURE_PATH_FIELDS - set(capture_path)
        if missing_fields:
            raise ValueError(f"capture_paths[{index}] missing fields: {sorted(missing_fields)}")
        path_id = capture_path.get("id")
        if not isinstance(path_id, str) or not path_id.strip():
            raise ValueError(f"capture_paths[{index}].id must be a non-empty string")
        path_ids.add(path_id)
        surface = capture_path.get("surface")
        if not isinstance(surface, str) or not surface.strip():
            raise ValueError(f"capture_paths[{index}].surface must be a non-empty string")
        capture_mode = capture_path.get("capture_mode")
        if not isinstance(capture_mode, str) or capture_mode not in REQUIRED_CAPTURE_MODES:
            raise ValueError(f"capture_paths[{index}].capture_mode must be one of {sorted(REQUIRED_CAPTURE_MODES)}")
        participant_metadata = capture_path.get("participant_metadata")
        if not isinstance(participant_metadata, str) or not participant_metadata.strip():
            raise ValueError(f"capture_paths[{index}].participant_metadata must be a non-empty string")
        consent_disclosure = capture_path.get("consent_disclosure")
        if not isinstance(consent_disclosure, str) or not consent_disclosure.strip():
            raise ValueError(f"capture_paths[{index}].consent_disclosure must be a non-empty string")
        media_streams = _as_set(capture_path.get("media_streams"), field=f"capture_paths[{index}].media_streams")
        evidence = _as_set(capture_path.get("evidence"), field=f"capture_paths[{index}].evidence")
        unknown_evidence = evidence - REQUIRED_EVIDENCE
        if unknown_evidence:
            raise ValueError(f"capture_paths[{index}] references unknown evidence: {sorted(unknown_evidence)}")
        referenced_evidence.update(evidence)
        normalized.append(
            {
                "id": path_id,
                "surface": surface,
                "capture_mode": capture_mode,
                "participant_metadata": participant_metadata,
                "consent_disclosure": consent_disclosure,
                "media_streams": sorted(media_streams),
                "evidence": sorted(evidence),
            }
        )

    missing_paths = REQUIRED_CAPTURE_PATHS - path_ids
    if missing_paths:
        raise ValueError(f"missing capture paths: {sorted(missing_paths)}")
    return sorted(normalized, key=lambda capture_path: capture_path["id"]), referenced_evidence


def _validate_speaker_operations(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    speaker_operations = manifest.get("speaker_operations")
    if not isinstance(speaker_operations, list) or not speaker_operations:
        raise ValueError("speaker_operations must be a non-empty array")

    operation_ids: set[str] = set()
    referenced_evidence: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, operation in enumerate(speaker_operations):
        if not isinstance(operation, dict):
            raise ValueError(f"speaker_operations[{index}] must be an object")
        missing_fields = REQUIRED_SPEAKER_OPERATION_FIELDS - set(operation)
        if missing_fields:
            raise ValueError(f"speaker_operations[{index}] missing fields: {sorted(missing_fields)}")
        operation_id = operation.get("id")
        if not isinstance(operation_id, str) or not operation_id.strip():
            raise ValueError(f"speaker_operations[{index}].id must be a non-empty string")
        operation_ids.add(operation_id)
        surface = operation.get("surface")
        if not isinstance(surface, str) or not surface.strip():
            raise ValueError(f"speaker_operations[{index}].surface must be a non-empty string")
        evidence = _as_set(operation.get("evidence"), field=f"speaker_operations[{index}].evidence")
        unknown_evidence = evidence - REQUIRED_EVIDENCE
        if unknown_evidence:
            raise ValueError(f"speaker_operations[{index}] references unknown evidence: {sorted(unknown_evidence)}")
        metrics = _as_set(operation.get("metrics"), field=f"speaker_operations[{index}].metrics")
        unknown_metrics = metrics - KNOWN_METRICS
        if unknown_metrics:
            raise ValueError(f"speaker_operations[{index}] references unknown metrics: {sorted(unknown_metrics)}")
        privacy_control = operation.get("privacy_control")
        if not isinstance(privacy_control, str) or not privacy_control.strip():
            raise ValueError(f"speaker_operations[{index}].privacy_control must be a non-empty string")
        confidence_policy = operation.get("confidence_policy")
        if not isinstance(confidence_policy, str) or not confidence_policy.strip():
            raise ValueError(f"speaker_operations[{index}].confidence_policy must be a non-empty string")
        referenced_evidence.update(evidence)
        normalized.append(
            {
                "id": operation_id,
                "surface": surface,
                "evidence": sorted(evidence),
                "metrics": sorted(metrics),
                "privacy_control": privacy_control,
                "confidence_policy": confidence_policy,
            }
        )

    missing_operations = REQUIRED_SPEAKER_OPERATIONS - operation_ids
    if missing_operations:
        raise ValueError(f"missing speaker operations: {sorted(missing_operations)}")
    return sorted(normalized, key=lambda operation: operation["id"]), referenced_evidence


def _reject_sensitive_name_policy(field: str, value: str) -> None:
    lowered = value.lower()
    for term in sorted(FORBIDDEN_SPEAKER_NAME_POLICY_TERMS):
        if term in lowered:
            raise ValueError(f"{field} must not use sensitive attributes for speaker naming: {term}")


def _validate_speaker_name_provenance(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    speaker_names = manifest.get("speaker_name_provenance")
    if not isinstance(speaker_names, list) or not speaker_names:
        raise ValueError("speaker_name_provenance must be a non-empty array")

    case_ids: set[str] = set()
    covered_sources: set[str] = set()
    covered_signals: set[str] = set()
    covered_resolutions: set[str] = set()
    referenced_evidence: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, speaker_name in enumerate(speaker_names):
        if not isinstance(speaker_name, dict):
            raise ValueError(f"speaker_name_provenance[{index}] must be an object")
        missing_fields = REQUIRED_SPEAKER_NAME_PROVENANCE_FIELDS - set(speaker_name)
        if missing_fields:
            raise ValueError(f"speaker_name_provenance[{index}] missing fields: {sorted(missing_fields)}")
        case_id = speaker_name.get("id")
        if not isinstance(case_id, str) or not case_id.strip():
            raise ValueError(f"speaker_name_provenance[{index}].id must be a non-empty string")
        case_ids.add(case_id)
        source = speaker_name.get("source")
        if not isinstance(source, str) or source not in REQUIRED_SPEAKER_NAME_SOURCES:
            raise ValueError(
                f"speaker_name_provenance[{index}].source must be one of {sorted(REQUIRED_SPEAKER_NAME_SOURCES)}"
            )
        covered_sources.add(source)
        surface = speaker_name.get("surface")
        if not isinstance(surface, str) or not surface.strip():
            raise ValueError(f"speaker_name_provenance[{index}].surface must be a non-empty string")
        evidence = _as_set(speaker_name.get("evidence"), field=f"speaker_name_provenance[{index}].evidence")
        unknown_evidence = evidence - REQUIRED_EVIDENCE
        if unknown_evidence:
            raise ValueError(
                f"speaker_name_provenance[{index}] references unknown evidence: {sorted(unknown_evidence)}"
            )
        signals = _as_set(speaker_name.get("signals"), field=f"speaker_name_provenance[{index}].signals")
        unknown_signals = signals - REQUIRED_SPEAKER_NAME_SIGNALS
        if unknown_signals:
            raise ValueError(
                f"speaker_name_provenance[{index}] references unknown signals: {sorted(unknown_signals)}"
            )
        confidence = _require_ratio_value(
            f"speaker_name_provenance[{index}].confidence",
            speaker_name.get("confidence"),
        )
        conflict_policy = speaker_name.get("conflict_policy")
        if not isinstance(conflict_policy, str) or not conflict_policy.strip():
            raise ValueError(f"speaker_name_provenance[{index}].conflict_policy must be a non-empty string")
        confidence_policy = speaker_name.get("confidence_policy")
        if not isinstance(confidence_policy, str) or not confidence_policy.strip():
            raise ValueError(f"speaker_name_provenance[{index}].confidence_policy must be a non-empty string")
        privacy_policy = speaker_name.get("privacy_policy")
        if not isinstance(privacy_policy, str) or not privacy_policy.strip():
            raise ValueError(f"speaker_name_provenance[{index}].privacy_policy must be a non-empty string")
        _reject_sensitive_name_policy(f"speaker_name_provenance[{index}].conflict_policy", conflict_policy)
        _reject_sensitive_name_policy(f"speaker_name_provenance[{index}].confidence_policy", confidence_policy)
        expected_resolution = speaker_name.get("expected_resolution")
        if not isinstance(expected_resolution, str) or expected_resolution not in REQUIRED_SPEAKER_NAME_RESOLUTIONS:
            raise ValueError(
                "speaker_name_provenance"
                f"[{index}].expected_resolution must be one of {sorted(REQUIRED_SPEAKER_NAME_RESOLUTIONS)}"
            )
        if confidence < 0.85 and expected_resolution in CONFIRMED_SPEAKER_NAME_RESOLUTIONS:
            raise ValueError(
                "speaker_name_provenance"
                f"[{index}] low-confidence inferred names cannot use confirmed resolution {expected_resolution}"
            )

        covered_signals.update(signals)
        covered_resolutions.add(expected_resolution)
        referenced_evidence.update(evidence)
        normalized.append(
            {
                "id": case_id,
                "source": source,
                "surface": surface,
                "evidence": sorted(evidence),
                "signals": sorted(signals),
                "confidence": confidence,
                "conflict_policy": conflict_policy,
                "confidence_policy": confidence_policy,
                "privacy_policy": privacy_policy,
                "expected_resolution": expected_resolution,
            }
        )

    missing_cases = REQUIRED_SPEAKER_NAME_PROVENANCE_CASES - case_ids
    if missing_cases:
        raise ValueError(f"speaker_name_provenance missing cases: {sorted(missing_cases)}")
    missing_sources = REQUIRED_SPEAKER_NAME_SOURCES - covered_sources
    if missing_sources:
        raise ValueError(f"speaker_name_provenance missing sources: {sorted(missing_sources)}")
    missing_signals = REQUIRED_SPEAKER_NAME_SIGNALS - covered_signals
    if missing_signals:
        raise ValueError(f"speaker_name_provenance missing signals: {sorted(missing_signals)}")
    missing_resolutions = REQUIRED_SPEAKER_NAME_RESOLUTIONS - covered_resolutions
    if missing_resolutions:
        raise ValueError(f"speaker_name_provenance missing expected resolutions: {sorted(missing_resolutions)}")
    return sorted(normalized, key=lambda speaker_name: speaker_name["id"]), referenced_evidence


def _validate_audio_visual_cases(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    cases = manifest.get("audio_visual_cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("audio_visual_cases must be a non-empty array")

    case_ids: set[str] = set()
    covered_fields: set[str] = set()
    covered_tasks: set[str] = set()
    covered_metrics: set[str] = set()
    referenced_evidence: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            raise ValueError(f"audio_visual_cases[{index}] must be an object")
        missing_fields = REQUIRED_AUDIO_VISUAL_FIELDS - set(case)
        if missing_fields:
            raise ValueError(f"audio_visual_cases[{index}] missing fields: {sorted(missing_fields)}")
        case_id = case.get("id")
        if not isinstance(case_id, str) or not case_id.strip():
            raise ValueError(f"audio_visual_cases[{index}].id must be a non-empty string")
        case_ids.add(case_id)
        dataset = case.get("dataset")
        if not isinstance(dataset, str) or not dataset.strip():
            raise ValueError(f"audio_visual_cases[{index}].dataset must be a non-empty string")
        coverage = _as_set(case.get("coverage"), field=f"audio_visual_cases[{index}].coverage")
        unknown_coverage = coverage - REQUIRED_AUDIO_VISUAL_COVERAGE
        if unknown_coverage:
            raise ValueError(f"audio_visual_cases[{index}] references unknown coverage: {sorted(unknown_coverage)}")
        tasks = _as_set(case.get("tasks"), field=f"audio_visual_cases[{index}].tasks")
        unknown_tasks = tasks - REQUIRED_AUDIO_VISUAL_TASKS
        if unknown_tasks:
            raise ValueError(f"audio_visual_cases[{index}] references unknown tasks: {sorted(unknown_tasks)}")
        metrics = _as_set(case.get("metrics"), field=f"audio_visual_cases[{index}].metrics")
        unknown_metrics = metrics - REQUIRED_AUDIO_VISUAL_METRICS
        if unknown_metrics:
            raise ValueError(f"audio_visual_cases[{index}] references unknown metrics: {sorted(unknown_metrics)}")
        evidence = _as_set(case.get("evidence"), field=f"audio_visual_cases[{index}].evidence")
        unknown_evidence = evidence - REQUIRED_EVIDENCE
        if unknown_evidence:
            raise ValueError(f"audio_visual_cases[{index}] references unknown evidence: {sorted(unknown_evidence)}")

        identity_policy = case.get("identity_policy")
        if not isinstance(identity_policy, dict):
            raise ValueError(f"audio_visual_cases[{index}].identity_policy must be an object")
        face_binding = identity_policy.get("face_identity_binding")
        if face_binding != "forbidden_without_explicit_opt_in":
            raise ValueError(
                f"audio_visual_cases[{index}].identity_policy.face_identity_binding "
                "must be forbidden_without_explicit_opt_in"
            )
        sensitive_policy = identity_policy.get("sensitive_attribute_policy")
        if sensitive_policy != "forbidden":
            raise ValueError(
                f"audio_visual_cases[{index}].identity_policy.sensitive_attribute_policy must be forbidden"
            )
        identity_sources = _as_set(
            identity_policy.get("allowed_identity_sources"),
            field=f"audio_visual_cases[{index}].identity_policy.allowed_identity_sources",
        )
        unknown_sources = identity_sources - ALLOWED_AUDIO_VISUAL_IDENTITY_SOURCES
        if unknown_sources:
            raise ValueError(
                f"audio_visual_cases[{index}] references unknown identity sources: {sorted(unknown_sources)}"
            )
        covered_fields.update(coverage)
        covered_tasks.update(tasks)
        covered_metrics.update(metrics)
        referenced_evidence.update(evidence)
        normalized.append(
            {
                "id": case_id,
                "dataset": dataset,
                "coverage": sorted(coverage),
                "tasks": sorted(tasks),
                "metrics": sorted(metrics),
                "evidence": sorted(evidence),
                "identity_policy": {
                    "face_identity_binding": face_binding,
                    "sensitive_attribute_policy": sensitive_policy,
                    "allowed_identity_sources": sorted(identity_sources),
                },
            }
        )

    missing_cases = REQUIRED_AUDIO_VISUAL_CASES - case_ids
    if missing_cases:
        raise ValueError(f"missing audio visual cases: {sorted(missing_cases)}")
    missing_coverage = REQUIRED_AUDIO_VISUAL_COVERAGE - covered_fields
    if missing_coverage:
        raise ValueError(f"audio_visual_cases missing coverage: {sorted(missing_coverage)}")
    missing_tasks = REQUIRED_AUDIO_VISUAL_TASKS - covered_tasks
    if missing_tasks:
        raise ValueError(f"audio_visual_cases missing tasks: {sorted(missing_tasks)}")
    missing_metrics = REQUIRED_AUDIO_VISUAL_METRICS - covered_metrics
    if missing_metrics:
        raise ValueError(f"audio_visual_cases missing metrics: {sorted(missing_metrics)}")
    return sorted(normalized, key=lambda case: case["id"]), referenced_evidence


def _validate_generated_artifact_scores(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    rows = manifest.get("generated_artifact_scores")
    if not isinstance(rows, list) or not rows:
        raise ValueError("generated_artifact_scores must be a non-empty array")

    score_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"generated_artifact_scores[{index}] must be an object")
        missing_fields = REQUIRED_GENERATED_ARTIFACT_SCORE_FIELDS - set(row)
        if missing_fields:
            raise ValueError(f"generated_artifact_scores[{index}] missing fields: {sorted(missing_fields)}")
        score_id = row.get("id")
        if not isinstance(score_id, str) or not score_id.strip():
            raise ValueError(f"generated_artifact_scores[{index}].id must be a non-empty string")
        if score_id not in REQUIRED_GENERATED_ARTIFACT_SCORE_IDS:
            raise ValueError(f"generated_artifact_scores[{index}].id is unknown: {score_id}")
        score_ids.add(score_id)
        judge_mode = row.get("judge_mode")
        if judge_mode not in GENERATED_ARTIFACT_JUDGE_MODES:
            raise ValueError(
                f"generated_artifact_scores[{index}].judge_mode must be one of {sorted(GENERATED_ARTIFACT_JUDGE_MODES)}"
            )
        observed_score = row.get("observed_score")
        threshold = row.get("threshold")
        if isinstance(observed_score, bool) or not isinstance(observed_score, int | float):
            raise ValueError(f"generated_artifact_scores[{index}].observed_score must be numeric")
        if isinstance(threshold, bool) or not isinstance(threshold, int | float):
            raise ValueError(f"generated_artifact_scores[{index}].threshold must be numeric")
        observed = float(observed_score)
        threshold_value = float(threshold)
        if not 0 <= observed <= 1:
            raise ValueError(f"generated_artifact_scores[{index}].observed_score must be in [0, 1]")
        if not 0 <= threshold_value <= 1:
            raise ValueError(f"generated_artifact_scores[{index}].threshold must be in [0, 1]")
        higher_is_better = row.get("higher_is_better")
        if not isinstance(higher_is_better, bool):
            raise ValueError(f"generated_artifact_scores[{index}].higher_is_better must be boolean")
        passed = row.get("passed")
        if not isinstance(passed, bool):
            raise ValueError(f"generated_artifact_scores[{index}].passed must be boolean")
        expected_pass = observed >= threshold_value if higher_is_better else observed <= threshold_value
        if passed != expected_pass:
            raise ValueError(
                f"generated_artifact_scores[{index}].passed does not match threshold direction"
            )
        proof = row.get("proof")
        if not isinstance(proof, dict):
            raise ValueError(f"generated_artifact_scores[{index}].proof must be an object")
        required_proof = {
            "deterministic": {"score_report"},
            "live_model": {"model_trajectory_jsonl", "raw_prompt", "model_output", "judge_output"},
            "manual": {"manual_review"},
        }[judge_mode]
        missing_proof = required_proof - set(proof)
        if missing_proof:
            raise ValueError(f"generated_artifact_scores[{index}] missing proof: {sorted(missing_proof)}")
        normalized.append(
            {
                "id": score_id,
                "judge_mode": judge_mode,
                "observed_score": observed,
                "threshold": threshold_value,
                "higher_is_better": higher_is_better,
                "passed": passed,
                "proof": {key: proof[key] for key in sorted(proof)},
            }
        )

    missing_scores = REQUIRED_GENERATED_ARTIFACT_SCORE_IDS - score_ids
    if missing_scores:
        raise ValueError(f"missing generated artifact scores: {sorted(missing_scores)}")
    return sorted(normalized, key=lambda row: row["id"])


def _validate_baseline_comparisons(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
    baseline_comparisons = manifest.get("baseline_comparisons")
    if not isinstance(baseline_comparisons, list) or not baseline_comparisons:
        raise ValueError("baseline_comparisons must be a non-empty array")

    comparison_ids: set[str] = set()
    comparison_types: set[str] = set()
    covered_conditions: set[str] = set()
    covered_metrics: set[str] = set()
    referenced_evidence: set[str] = set()
    has_open_source_run = False
    has_internal_baseline = False
    normalized: list[dict[str, Any]] = []

    for index, comparison in enumerate(baseline_comparisons):
        if not isinstance(comparison, dict):
            raise ValueError(f"baseline_comparisons[{index}] must be an object")
        missing_fields = REQUIRED_BASELINE_COMPARISON_FIELDS - set(comparison)
        if missing_fields:
            raise ValueError(f"baseline_comparisons[{index}] missing fields: {sorted(missing_fields)}")
        comparison_id = comparison.get("id")
        if not isinstance(comparison_id, str) or not comparison_id.strip():
            raise ValueError(f"baseline_comparisons[{index}].id must be a non-empty string")
        comparison_ids.add(comparison_id)
        system = comparison.get("system")
        if not isinstance(system, str) or not system.strip():
            raise ValueError(f"baseline_comparisons[{index}].system must be a non-empty string")
        comparison_type = comparison.get("comparison_type")
        if not isinstance(comparison_type, str) or comparison_type not in BASELINE_COMPARISON_TYPES:
            raise ValueError(
                f"baseline_comparisons[{index}].comparison_type must be one of {sorted(BASELINE_COMPARISON_TYPES)}"
            )
        comparison_types.add(comparison_type)
        run_status = comparison.get("run_status")
        if not isinstance(run_status, str) or run_status not in BASELINE_RUN_STATUSES:
            raise ValueError(
                f"baseline_comparisons[{index}].run_status must be one of {sorted(BASELINE_RUN_STATUSES)}"
            )
        not_run_reason = comparison.get("not_run_reason")
        if run_status == "not_run" and (
            not isinstance(not_run_reason, str) or not not_run_reason.strip()
        ):
            raise ValueError(f"baseline_comparisons[{index}].not_run_reason must explain skipped systems")
        capture_mode = comparison.get("capture_mode")
        if not isinstance(capture_mode, str) or not capture_mode.strip():
            raise ValueError(f"baseline_comparisons[{index}].capture_mode must be a non-empty string")
        privacy_mode = comparison.get("privacy_mode")
        if not isinstance(privacy_mode, str) or not privacy_mode.strip():
            raise ValueError(f"baseline_comparisons[{index}].privacy_mode must be a non-empty string")
        conditions = _as_set(comparison.get("conditions"), field=f"baseline_comparisons[{index}].conditions")
        metrics = _as_set(comparison.get("metrics"), field=f"baseline_comparisons[{index}].metrics")
        unknown_metrics = metrics - REQUIRED_BASELINE_METRICS
        if unknown_metrics:
            raise ValueError(f"baseline_comparisons[{index}] references unknown metrics: {sorted(unknown_metrics)}")
        eliza_artifact = comparison.get("eliza_artifact")
        if not isinstance(eliza_artifact, str) or not eliza_artifact.strip():
            raise ValueError(f"baseline_comparisons[{index}].eliza_artifact must be a non-empty string")
        baseline_artifact = comparison.get("baseline_artifact")
        if not isinstance(baseline_artifact, str) or not baseline_artifact.strip():
            raise ValueError(f"baseline_comparisons[{index}].baseline_artifact must be a non-empty string")
        manual_review_status = comparison.get("manual_review_status")
        if not isinstance(manual_review_status, str) or manual_review_status not in BASELINE_REVIEW_STATUSES:
            raise ValueError(
                f"baseline_comparisons[{index}].manual_review_status must be one of {sorted(BASELINE_REVIEW_STATUSES)}"
            )
        evidence = _as_set(comparison.get("evidence"), field=f"baseline_comparisons[{index}].evidence")
        unknown_evidence = evidence - REQUIRED_EVIDENCE
        if unknown_evidence:
            raise ValueError(f"baseline_comparisons[{index}] references unknown evidence: {sorted(unknown_evidence)}")
        failure_policy = comparison.get("failure_policy")
        if not isinstance(failure_policy, str) or not failure_policy.strip():
            raise ValueError(f"baseline_comparisons[{index}].failure_policy must be a non-empty string")

        covered_conditions.update(conditions)
        covered_metrics.update(metrics)
        referenced_evidence.update(evidence)
        if comparison_type == "open_source" and run_status in {"run", "imported"}:
            has_open_source_run = True
        if comparison_id == "eliza_current_baseline" and comparison_type == "internal_baseline":
            has_internal_baseline = True
        normalized.append(
            {
                "id": comparison_id,
                "system": system,
                "comparison_type": comparison_type,
                "run_status": run_status,
                "not_run_reason": not_run_reason if isinstance(not_run_reason, str) else "",
                "capture_mode": capture_mode,
                "privacy_mode": privacy_mode,
                "conditions": sorted(conditions),
                "metrics": sorted(metrics),
                "eliza_artifact": eliza_artifact,
                "baseline_artifact": baseline_artifact,
                "manual_review_status": manual_review_status,
                "evidence": sorted(evidence),
                "failure_policy": failure_policy,
            }
        )

    missing_comparisons = REQUIRED_BASELINE_COMPARISONS - comparison_ids
    if missing_comparisons:
        raise ValueError(f"missing baseline comparisons: {sorted(missing_comparisons)}")
    missing_types = BASELINE_COMPARISON_TYPES - comparison_types
    if missing_types:
        raise ValueError(f"baseline_comparisons missing types: {sorted(missing_types)}")
    missing_conditions = REQUIRED_BASELINE_CONDITIONS - covered_conditions
    if missing_conditions:
        raise ValueError(f"baseline_comparisons missing conditions: {sorted(missing_conditions)}")
    missing_metrics = REQUIRED_BASELINE_METRICS - covered_metrics
    if missing_metrics:
        raise ValueError(f"baseline_comparisons missing metrics: {sorted(missing_metrics)}")
    if not has_open_source_run:
        raise ValueError("baseline_comparisons must include at least one open-source run or import")
    if not has_internal_baseline:
        raise ValueError("baseline_comparisons must include the current Eliza internal baseline")
    return sorted(normalized, key=lambda comparison: comparison["id"]), referenced_evidence


def validate_manifest(manifest: dict[str, Any], *, lane: str, manifest_path: Path) -> dict[str, Any]:
    if lane not in LANES:
        raise ValueError(f"lane must be one of {sorted(LANES)}")

    surfaces = _as_set(manifest.get("surfaces"), field="surfaces")
    missing_surfaces = REQUIRED_SURFACES - surfaces
    if missing_surfaces:
        raise ValueError(f"missing surfaces: {sorted(missing_surfaces)}")

    capture_modes = _as_set(manifest.get("capture_modes"), field="capture_modes")
    missing_modes = REQUIRED_CAPTURE_MODES - capture_modes
    if missing_modes:
        raise ValueError(f"missing capture modes: {sorted(missing_modes)}")

    transcript_schema = manifest.get("transcript_schema")
    if not isinstance(transcript_schema, dict):
        raise ValueError("transcript_schema must be an object")
    required_schema_fields = {
        "meeting_id",
        "source",
        "consent",
        "segments",
        "speakers",
        "artifacts",
        "retention_policy",
    }
    schema_fields = _as_set(transcript_schema.get("required_fields"), field="transcript_schema.required_fields")
    missing_schema = required_schema_fields - schema_fields
    if missing_schema:
        raise ValueError(f"missing transcript schema fields: {sorted(missing_schema)}")

    adapters = manifest.get("adapters")
    if not isinstance(adapters, list) or not adapters:
        raise ValueError("adapters must be a non-empty array")
    adapter_ids: set[str] = set()
    for index, adapter in enumerate(adapters):
        if not isinstance(adapter, dict):
            raise ValueError(f"adapters[{index}] must be an object")
        adapter_id = adapter.get("id")
        if not isinstance(adapter_id, str) or not adapter_id:
            raise ValueError(f"adapters[{index}].id must be a non-empty string")
        adapter_ids.add(adapter_id)
        adapter_modes = _as_set(adapter.get("capture_modes"), field=f"adapters[{index}].capture_modes")
        if not adapter_modes <= capture_modes:
            raise ValueError(f"adapters[{index}] declares capture modes outside manifest")
    if {"zoom", "google_meet"} - adapter_ids:
        raise ValueError("zoom and google_meet adapters are required")

    stressors = _as_set(manifest.get("stressors"), field="stressors")
    required_stressors = {"music", "noise", "babble", "overlap", "far_field"}
    missing_stressors = required_stressors - stressors
    if missing_stressors:
        raise ValueError(f"missing stressors: {sorted(missing_stressors)}")
    scenarios, scenario_evidence_types = _validate_scenarios(manifest)
    dataset_sources, dataset_evidence_types = _validate_dataset_sources(manifest)
    capture_paths, capture_evidence_types = _validate_capture_paths(manifest)
    speaker_operations, speaker_operation_evidence_types = _validate_speaker_operations(manifest)
    speaker_name_provenance, speaker_name_evidence_types = _validate_speaker_name_provenance(manifest)
    audio_visual_cases, audio_visual_evidence_types = _validate_audio_visual_cases(manifest)
    generated_artifact_scores = _validate_generated_artifact_scores(manifest)
    baseline_comparisons, baseline_evidence_types = _validate_baseline_comparisons(manifest)

    metric_values = _validate_metrics(manifest.get("metrics"), lane=lane)

    evidence_files: dict[str, str] = {}
    provider_mode = str(manifest.get("provider_mode") or "").strip().lower()
    if lane == "mocked_plumbing":
        if provider_mode != "mock":
            raise ValueError("mocked_plumbing lane requires provider_mode=mock")
    else:
        if provider_mode in {"", "mock", "fixture", "oracle"}:
            raise ValueError("real_product lane requires a non-mock provider_mode")
        evidence_files = _validate_evidence_files(manifest, manifest_path)
        missing_real_evidence = scenario_evidence_types - set(evidence_files)
        if missing_real_evidence:
            raise ValueError(f"scenario evidence files missing: {sorted(missing_real_evidence)}")
        missing_dataset_evidence = dataset_evidence_types - set(evidence_files)
        if missing_dataset_evidence:
            raise ValueError(f"dataset evidence files missing: {sorted(missing_dataset_evidence)}")
        missing_capture_evidence = capture_evidence_types - set(evidence_files)
        if missing_capture_evidence:
            raise ValueError(f"capture evidence files missing: {sorted(missing_capture_evidence)}")
        missing_speaker_operation_evidence = speaker_operation_evidence_types - set(evidence_files)
        if missing_speaker_operation_evidence:
            raise ValueError(f"speaker operation evidence files missing: {sorted(missing_speaker_operation_evidence)}")
        missing_speaker_name_evidence = speaker_name_evidence_types - set(evidence_files)
        if missing_speaker_name_evidence:
            raise ValueError(f"speaker name evidence files missing: {sorted(missing_speaker_name_evidence)}")
        missing_audio_visual_evidence = audio_visual_evidence_types - set(evidence_files)
        if missing_audio_visual_evidence:
            raise ValueError(f"audio visual evidence files missing: {sorted(missing_audio_visual_evidence)}")
        missing_baseline_evidence = baseline_evidence_types - set(evidence_files)
        if missing_baseline_evidence:
            raise ValueError(f"baseline comparison evidence files missing: {sorted(missing_baseline_evidence)}")

    return {
        "surfaces": sorted(surfaces),
        "capture_modes": sorted(capture_modes),
        "adapter_ids": sorted(adapter_ids),
        "stressors": sorted(stressors),
        "scenarios": scenarios,
        "dataset_sources": dataset_sources,
        "capture_paths": capture_paths,
        "speaker_operations": speaker_operations,
        "speaker_name_provenance": speaker_name_provenance,
        "audio_visual_cases": audio_visual_cases,
        "generated_artifact_scores": generated_artifact_scores,
        "baseline_comparisons": baseline_comparisons,
        "metrics": metric_values,
        "evidence_files": evidence_files,
        "provider_mode": provider_mode,
    }


def build_report(*, lane: str, manifest_path: Path) -> dict[str, Any]:
    manifest = _load_json(manifest_path)
    validation = validate_manifest(manifest, lane=lane, manifest_path=manifest_path)
    metrics = validation["metrics"]
    if lane == "mocked_plumbing":
        score = 1.0
        publishable = False
    else:
        score = min(metrics[key] for key in REQUIRED_QUALITY_METRICS)
        publishable = True
    return {
        "kind": "meeting_transcription_proof_report",
        "version": 1,
        "issue": 12486,
        "lane": lane,
        "publishable": publishable,
        "score": score,
        "generated_at_unix": int(time.time()),
        "manifest_path": str(manifest_path.resolve()),
        **validation,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", choices=sorted(LANES), default="mocked_plumbing")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    manifest_path = args.manifest
    if manifest_path is None:
        manifest_path = _package_root() / "fixtures" / "mock-meeting-manifest.json"
    report = build_report(lane=args.lane, manifest_path=manifest_path)

    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.output / "meeting-transcription-proof-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(str(report_path))
    return 0
