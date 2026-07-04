"""VoiceCodeBench exact-token ASR gate contract and metric helpers.

The gate is intentionally pure Python and data-free: it defines the
runtime-download metadata for the public VoiceCodeBench test split and scores
provider transcripts against row-level structured entities. Raw audio stays
outside git; publishable reports must record real provider/model metadata.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

DATASET_SOURCE_URL = "https://huggingface.co/datasets/besimple-ai/voice-code-bench"
DATASET_LICENSE = "mit"
DATASET_SPLIT = "test"
DATASET_ROWS = 300

ENTITY_TYPES = {
    "account_or_record_number",
    "acronym_or_initialism",
    "cli_flag",
    "code_symbol",
    "command",
    "currency_amount",
    "date",
    "domain_term",
    "email_address",
    "environment_variable",
    "file_path",
    "ip_address",
    "measurement",
    "percentage",
    "person_or_team_name",
    "phone_extension",
    "phone_number",
    "plain_number",
    "port_number",
    "postal_address",
    "product_code",
    "reference_id",
    "spelled_sequence",
    "time",
    "url",
    "version",
}


@dataclass(frozen=True)
class VoiceCodeBenchEntity:
    id: str
    type: str
    canonical: str


@dataclass(frozen=True)
class VoiceCodeBenchRow:
    audio_id: str
    domain: str
    scenario: str
    difficulty: str
    reference: str
    entities: tuple[VoiceCodeBenchEntity, ...]


def gate_contract() -> dict[str, Any]:
    return {
        "schema": "elizaos.voice_code_bench_gate.v1",
        "source_url": DATASET_SOURCE_URL,
        "license": DATASET_LICENSE,
        "split": DATASET_SPLIT,
        "row_count": DATASET_ROWS,
        "raw_audio_committed": False,
        "cache_policy": "download_or_cache_outside_git",
        "required_hashes": [
            "dataset_revision",
            "row_id",
            "audio_sha256",
            "reference_sha256",
            "entities_sha256",
            "adapter_config_sha256",
        ],
        "provider_metadata_required": [
            "asr_provider",
            "asr_model",
            "artifact_revision",
            "sample_rate_hz",
            "run_started_at",
        ],
        "metrics": ["ctem", "tsr", "wer", "cer"],
        "entity_types": sorted(ENTITY_TYPES),
        "training_eval_separation": {
            "eval_only": True,
            "training_allowed": False,
            "note": "VoiceCodeBench rows must not be used for training without explicit approval.",
        },
        "publishable_requires_real_asr": True,
    }


_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def normalize_for_error_rate(text: str) -> str:
    return " ".join(_TOKEN_RE.findall(text.lower()))


def normalize_entity(text: str) -> str:
    return _NON_ALNUM_RE.sub("", text.lower())


def entity_matches_hypothesis(entity: str, hypothesis: str) -> bool:
    entity_normalized = normalize_entity(entity)
    if not entity_normalized:
        return False
    hypothesis_tokens = _TOKEN_RE.findall(hypothesis.lower())
    for start in range(len(hypothesis_tokens)):
        joined = ""
        for token in hypothesis_tokens[start:]:
            joined += token
            if joined == entity_normalized:
                return True
            if len(joined) >= len(entity_normalized):
                break
    return False


def word_error_rate(reference: str, hypothesis: str) -> float:
    return _edit_rate(
        normalize_for_error_rate(reference).split(),
        normalize_for_error_rate(hypothesis).split(),
    )


def character_error_rate(reference: str, hypothesis: str) -> float:
    return _edit_rate(
        list(normalize_entity(reference)),
        list(normalize_entity(hypothesis)),
    )


def score_voice_code_bench_rows(
    rows: Iterable[VoiceCodeBenchRow],
    hypotheses: dict[str, str],
) -> dict[str, Any]:
    row_scores: list[dict[str, Any]] = []
    total_entities = 0
    matched_entities = 0
    task_successes = 0
    row_count = 0
    wer_sum = 0.0
    cer_sum = 0.0

    for row in rows:
        row_count += 1
        hypothesis = hypotheses.get(row.audio_id, "")
        entity_results: list[dict[str, Any]] = []
        row_matched = 0
        for entity in row.entities:
            total_entities += 1
            entity_match = entity_matches_hypothesis(entity.canonical, hypothesis)
            if entity_match:
                matched_entities += 1
                row_matched += 1
            entity_results.append(
                {
                    "id": entity.id,
                    "type": entity.type,
                    "canonical": entity.canonical,
                    "matched": entity_match,
                }
            )
        row_success = row.entities and row_matched == len(row.entities)
        if row_success:
            task_successes += 1
        row_wer = word_error_rate(row.reference, hypothesis)
        row_cer = character_error_rate(row.reference, hypothesis)
        wer_sum += row_wer
        cer_sum += row_cer
        row_scores.append(
            {
                "audio_id": row.audio_id,
                "domain": row.domain,
                "scenario": row.scenario,
                "difficulty": row.difficulty,
                "ctem": row_matched / len(row.entities) if row.entities else 0.0,
                "tsr": 1.0 if row_success else 0.0,
                "wer": row_wer,
                "cer": row_cer,
                "entities": entity_results,
            }
        )

    return {
        "publishable": False,
        "row_count": row_count,
        "metrics": {
            "ctem": matched_entities / total_entities if total_entities else 0.0,
            "tsr": task_successes / row_count if row_count else 0.0,
            "wer": wer_sum / row_count if row_count else 0.0,
            "cer": cer_sum / row_count if row_count else 0.0,
        },
        "rows": row_scores,
    }


def validate_publishable_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("publishable") is not True:
        errors.append("publishable must be true for real score reports")
    if report.get("source_url") != DATASET_SOURCE_URL:
        errors.append("source_url must match VoiceCodeBench")
    if report.get("split") != DATASET_SPLIT:
        errors.append("split must be test")
    if report.get("row_count") != DATASET_ROWS:
        errors.append("row_count must be 300 for full publishable run")
    provider = report.get("provider_metadata")
    if not isinstance(provider, dict):
        errors.append("provider_metadata is required")
    else:
        for key in ("asr_provider", "asr_model", "artifact_revision", "run_started_at"):
            value = provider.get(key)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"provider_metadata.{key} is required")
        sample_rate = provider.get("sample_rate_hz")
        if (
            isinstance(sample_rate, bool)
            or not isinstance(sample_rate, int)
            or sample_rate <= 0
        ):
            errors.append("provider_metadata.sample_rate_hz is required")
    hashes = report.get("hashes")
    if not isinstance(hashes, dict):
        errors.append("hashes are required")
    else:
        for key in gate_contract()["required_hashes"]:
            value = hashes.get(key)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"hashes.{key} is required")
    metrics = report.get("metrics")
    if not isinstance(metrics, dict):
        errors.append("metrics are required")
    else:
        for key in gate_contract()["metrics"]:
            value = metrics.get(key)
            if isinstance(value, bool) or not isinstance(value, int | float):
                errors.append(f"metrics.{key} must be numeric")
    return errors


def _edit_rate(reference: list[str], hypothesis: list[str]) -> float:
    if not reference:
        return 0.0 if not hypothesis else 1.0
    previous = list(range(len(hypothesis) + 1))
    for i, ref_item in enumerate(reference, start=1):
        current = [i]
        for j, hyp_item in enumerate(hypothesis, start=1):
            substitution = previous[j - 1] + (0 if ref_item == hyp_item else 1)
            insertion = current[j - 1] + 1
            deletion = previous[j] + 1
            current.append(min(substitution, insertion, deletion))
        previous = current
    return previous[-1] / len(reference)
