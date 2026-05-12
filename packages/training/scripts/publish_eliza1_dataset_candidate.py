#!/usr/bin/env python3
"""Stage and optionally push an Eliza-1 dataset candidate.

Dry-run is the default. A real local write requires ``--write``. A real
HuggingFace push additionally requires ``--push --allow-hf-push``.

The script only stages candidate-scoped files:

  data/candidates/eliza1/<candidate-id>/README.md
  data/candidates/eliza1/<candidate-id>/manifest.json
  data/candidates/eliza1/<candidate-id>/data/{train,validation,test}.jsonl

It refuses mixed JSONL schemas across split files, refuses auxiliary repair
records in trainable split files, and refuses user-export writes/pushes unless
privacy review is explicitly attested by ``--privacy-reviewed`` or an upstream
``--source-manifest``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CANDIDATE_ROOT = ROOT / "data" / "candidates" / "eliza1"
DEFAULT_REPO_ID = "elizaos/eliza-1-training-candidates"
SCHEMA_VERSION = "eliza1.dataset_candidate.v1"
ELIZA1_TRAJECTORY_RECORD_SCHEMA = "eliza.eliza1_trajectory_record.v1"
PRIVACY_ATTESTATION_SCHEMA = "eliza.privacy_filter_attestation.v1"
PRIVACY_ATTESTATION_VERSION = 1
PUBLIC_ELIZA1_DATASET = "elizaos/eliza-1-training"
PUBLIC_ELIZA1_CONFIG = "default"
PUBLIC_ELIZA1_COLUMNS = (
    "roomName",
    "agentId",
    "memoryEntries",
    "currentMessage",
    "expectedResponse",
    "availableActions",
    "metadata",
)

SPLIT_TARGETS = {
    "train": Path("data/train.jsonl"),
    "validation": Path("data/validation.jsonl"),
    "test": Path("data/test.jsonl"),
}

ALLOWED_LOCAL_RELATIVE = {
    Path("README.md"),
    Path("manifest.json"),
    *SPLIT_TARGETS.values(),
}

ALLOWED_SOURCE_KINDS = {"public", "synthetic", "user_export"}
CANDIDATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,78}[a-z0-9]$")
TRAINABLE_SPLIT_ALIASES = {
    "train": {"train"},
    "validation": {"validation", "val"},
    "test": {"test"},
}
REPAIR_SPLIT_LABELS = {"repair", "repair_eval"}
TRAIN_LOCAL_READY_SCHEMAS = {
    "eliza_native_v1",
    ELIZA1_TRAJECTORY_RECORD_SCHEMA,
    "chat_messages_v1",
    "eliza_record_v1",
}


class CandidateError(RuntimeError):
    """Raised when a candidate violates a safety or schema rule."""


@dataclass(frozen=True)
class SplitStats:
    split: str
    source: Path
    target: Path
    path_in_repo: str
    rows: int
    bytes: int
    sha256: str
    schema: str
    real_user_export: bool


@dataclass(frozen=True)
class CandidatePlan:
    candidate_id: str
    candidate_dir: Path
    repo_id: str
    source_kind: str
    privacy_reviewed: bool
    split_stats: tuple[SplitStats, ...]
    manifest: dict[str, Any]
    readme: str

    @property
    def dataset_schema(self) -> str:
        return str(self.manifest["datasetSchema"])


@dataclass(frozen=True)
class SourceManifestInfo:
    path: Path
    sha256: str
    schema: str | None
    version: Any
    source_kind: str | None
    privacy_reviewed: bool
    real_user_export: bool
    privacy_summary: dict[str, Any]


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _validate_candidate_id(candidate_id: str) -> str:
    normalized = candidate_id.strip().lower()
    if not CANDIDATE_ID_RE.match(normalized):
        raise CandidateError(
            "candidate id must be 3-80 chars of lowercase letters, digits, '.', '_', or '-'"
        )
    if ".." in normalized or "/" in normalized or "\\" in normalized:
        raise CandidateError("candidate id cannot contain path traversal")
    return normalized


def _ensure_under(path: Path, root: Path) -> None:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise CandidateError(f"refusing path outside candidate root: {path}") from exc


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "reviewed", "approved"}
    return False


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _safe_ref(value: str) -> str:
    return f"sha256:{_hash_text(value)[:16]}"


def _candidate_source_manifest(paths: Iterable[Path]) -> Path | None:
    parents = {path.resolve().parent for path in paths}
    if len(parents) != 1:
        return None
    parent = next(iter(parents))
    for candidate in (parent / "manifest.json", parent.parent / "manifest.json"):
        if candidate.exists():
            return candidate
    return None


def _manifest_source_kind(manifest: dict[str, Any]) -> str | None:
    candidates: list[Any] = [
        manifest.get("sourceKind"),
        manifest.get("source_kind"),
        _as_dict(manifest.get("source")).get("kind"),
        _as_dict(manifest.get("dataset")).get("sourceKind"),
        _as_dict(manifest.get("gate")).get("sourceKind"),
        _as_dict(manifest.get("privacy")).get("sourceKind"),
    ]
    sources = manifest.get("sources")
    if isinstance(sources, list):
        candidates.extend(
            _as_dict(source).get("sourceKind") or _as_dict(source).get("kind")
            for source in sources
        )

    normalized = {
        str(value).strip().lower()
        for value in candidates
        if isinstance(value, str) and value.strip()
    }
    if "user_export" in normalized:
        return "user_export"
    known = sorted(kind for kind in normalized if kind in ALLOWED_SOURCE_KINDS)
    return known[0] if known else None


def _privacy_attestation_reviewed(manifest: dict[str, Any]) -> bool:
    if manifest.get("schema") != PRIVACY_ATTESTATION_SCHEMA:
        return False
    if manifest.get("version") != PRIVACY_ATTESTATION_VERSION:
        return False

    gate = _as_dict(manifest.get("gate"))
    artifacts = _as_dict(manifest.get("artifacts"))
    ledger = _as_dict(artifacts.get("ledger_jsonl"))
    residual = _as_dict(gate.get("residual_findings"))
    residual_count = _int_or_none(
        residual.get("count")
        if residual.get("count") is not None
        else gate.get("residual_findings_count")
        if gate.get("residual_findings_count") is not None
        else manifest.get("residual_findings_count")
    )
    input_count = _int_or_none(manifest.get("input_count"))
    output_count = _int_or_none(manifest.get("output_count"))
    gate_input_count = _int_or_none(gate.get("input_count"))
    gate_output_count = _int_or_none(gate.get("output_count"))
    invalid_json = _int_or_none(gate.get("invalid_json") or 0)
    backend_failures = _int_or_none(gate.get("backend_failures") or 0)
    backend_skipped = _int_or_none(
        gate.get("backend_skipped_too_long")
        if gate.get("backend_skipped_too_long") is not None
        else manifest.get("backend_skipped_too_long")
        if manifest.get("backend_skipped_too_long") is not None
        else 0
    )

    return all(
        (
            _truthy(manifest.get("passed")),
            _truthy(manifest.get("strict")),
            _truthy(gate.get("passed")),
            _truthy(gate.get("strict")),
            residual_count == 0,
            input_count is not None,
            output_count is not None,
            input_count == output_count,
            gate_input_count is not None,
            gate_output_count is not None,
            gate_input_count == gate_output_count,
            invalid_json == 0,
            backend_failures == 0,
            backend_skipped == 0,
            ledger.get("raw_sensitive_values") is False,
        )
    )


def _manifest_privacy_reviewed(manifest: dict[str, Any]) -> bool:
    if manifest.get("schema") == PRIVACY_ATTESTATION_SCHEMA:
        return _privacy_attestation_reviewed(manifest)

    gate = _as_dict(manifest.get("gate"))
    residual = _as_dict(gate.get("residual_findings"))
    residual_count = residual.get("count") or gate.get("residual_findings_count") or 0
    try:
        residual_count_int = int(residual_count)
    except (TypeError, ValueError):
        residual_count_int = -1
    if (
        manifest.get("schema") == "eliza.privacy_filter_attestation.v1"
        and _truthy(manifest.get("passed"))
        and _truthy(gate.get("passed"))
        and _truthy(gate.get("strict"))
        and residual_count_int == 0
    ):
        return True
    privacy = _as_dict(manifest.get("privacy"))
    review = _as_dict(privacy.get("review"))
    return any(
        _truthy(value)
        for value in (
            manifest.get("privacyReviewed"),
            manifest.get("privacy_reviewed"),
            privacy.get("reviewed"),
            privacy.get("approved"),
            review.get("approved"),
            review.get("reviewed"),
        )
    )


def _manifest_privacy_summary(
    manifest: dict[str, Any],
    *,
    privacy_reviewed: bool,
) -> dict[str, Any]:
    privacy = _as_dict(manifest.get("privacy"))
    gate = _as_dict(manifest.get("gate"))
    residual = _as_dict(gate.get("residual_findings"))
    residual_count = residual.get("count") or gate.get("residual_findings_count")
    summary: dict[str, Any] = {"reviewed": bool(privacy_reviewed)}

    for source_key, output_key in (
        ("strict", "strict"),
        ("redactions", "redactions"),
        ("credentialHits", "credentialHits"),
        ("credential_hits", "credentialHits"),
        ("ledgerSha256", "ledgerSha256"),
        ("ledger_sha256", "ledgerSha256"),
        ("statsSha256", "statsSha256"),
        ("stats_sha256", "statsSha256"),
    ):
        value = privacy.get(source_key)
        if value is not None:
            summary[output_key] = value

    if gate:
        summary["gatePassed"] = _truthy(gate.get("passed"))
        if gate.get("strict") is not None and "strict" not in summary:
            summary["strict"] = _truthy(gate.get("strict"))
    if residual_count is not None:
        summary["residualFindingsCount"] = residual_count

    if manifest.get("schema") == PRIVACY_ATTESTATION_SCHEMA:
        summary["attestationSchema"] = PRIVACY_ATTESTATION_SCHEMA
        summary["attestationVersion"] = manifest.get("version")
        for source_key, output_key in (
            ("input_count", "inputCount"),
            ("output_count", "outputCount"),
            ("redaction_count", "redactionCount"),
            ("backend_skipped_too_long", "backendSkippedTooLong"),
        ):
            value = manifest.get(source_key)
            if value is not None:
                summary[output_key] = value
        artifacts = _as_dict(manifest.get("artifacts"))
        artifact_summary: dict[str, Any] = {}
        for name in ("redacted_jsonl", "ledger_jsonl", "stats_json"):
            artifact = _as_dict(artifacts.get(name))
            if artifact:
                artifact_summary[name] = {
                    key: artifact[key]
                    for key in ("sha256", "rows", "entries", "raw_sensitive_values")
                    if key in artifact
                }
        if artifact_summary:
            summary["artifacts"] = artifact_summary

    return summary


def _manifest_real_user_export(manifest: dict[str, Any], source_kind: str | None) -> bool:
    privacy = _as_dict(manifest.get("privacy"))
    source = _as_dict(manifest.get("source"))
    sources = manifest.get("sources")
    source_marks_user_export = False
    if isinstance(sources, list):
        source_marks_user_export = any(
            _manifest_source_kind({"sources": [source]}) == "user_export"
            or _truthy(_as_dict(source).get("realUserExport"))
            or _truthy(_as_dict(source).get("real_user_export"))
            for source in sources
        )
    return any(
        (
            source_kind == "user_export",
            _truthy(manifest.get("realUserExport")),
            _truthy(manifest.get("real_user_export")),
            _truthy(privacy.get("realUserExport")),
            _truthy(privacy.get("real_user_export")),
            _truthy(source.get("realUserExport")),
            _truthy(source.get("real_user_export")),
            source_marks_user_export,
        )
    )


def _record_real_user_export(record: dict[str, Any]) -> bool:
    containers = [
        record,
        _as_dict(record.get("source")),
        _as_dict(record.get("metadata")),
        _as_dict(_as_dict(record.get("metadata")).get("source")),
        _as_dict(record.get("privacy")),
    ]
    for container in containers:
        source_kind = _manifest_source_kind(container)
        if source_kind == "user_export":
            return True
        if _manifest_real_user_export(container, source_kind):
            return True
    return False


def load_source_manifest(path: Path) -> SourceManifestInfo:
    if not path.exists():
        raise CandidateError(f"source manifest does not exist: {path}")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CandidateError(f"{path}: invalid source manifest JSON: {exc.msg}") from exc
    if not isinstance(manifest, dict):
        raise CandidateError(f"{path}: source manifest must be a JSON object")

    source_kind = _manifest_source_kind(manifest)
    privacy_reviewed = _manifest_privacy_reviewed(manifest)
    real_user_export = _manifest_real_user_export(manifest, source_kind)
    if real_user_export:
        source_kind = "user_export"
    return SourceManifestInfo(
        path=path.resolve(),
        sha256=_sha256_file(path),
        schema=manifest.get("schema") if isinstance(manifest.get("schema"), str) else None,
        version=manifest.get("version"),
        source_kind=source_kind,
        privacy_reviewed=privacy_reviewed,
        real_user_export=real_user_export,
        privacy_summary=_manifest_privacy_summary(
            manifest,
            privacy_reviewed=privacy_reviewed,
        ),
    )


def _detect_schema(record: dict[str, Any]) -> str:
    if (
        record.get("format") == "eliza_native_v1"
        and isinstance(record.get("request"), dict)
        and isinstance(record.get("response"), dict)
    ):
        return "eliza_native_v1"

    if record.get("schema") == ELIZA1_TRAJECTORY_RECORD_SCHEMA:
        required = {
            "id",
            "split",
            "task",
            "target",
            "messages",
            "tools",
            "actions",
            "quality",
            "source",
            "metadata",
        }
        if required <= set(record):
            return ELIZA1_TRAJECTORY_RECORD_SCHEMA

    eliza_fields = {
        "roomName",
        "agentId",
        "memoryEntries",
        "currentMessage",
        "expectedResponse",
        "availableActions",
        "metadata",
    }
    if eliza_fields <= set(record):
        return "eliza_record_v1"

    messages = record.get("messages")
    if isinstance(messages, list) and messages and all(
        isinstance(msg, dict)
        and isinstance(msg.get("role"), str)
        and "content" in msg
        for msg in messages
    ):
        return "chat_messages_v1"

    return "unknown"


def _record_split_labels(record: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    split = record.get("split")
    if isinstance(split, str) and split.strip():
        labels.append(split.strip().lower())
    metadata = _as_dict(record.get("metadata"))
    metadata_split = metadata.get("split")
    if isinstance(metadata_split, str) and metadata_split.strip():
        labels.append(metadata_split.strip().lower())
    return labels


def _split_label_for_record(record: dict[str, Any], schema: str) -> str | None:
    if schema == ELIZA1_TRAJECTORY_RECORD_SCHEMA:
        split = record.get("split")
        return split.strip().lower() if isinstance(split, str) else None

    if schema in {"eliza_native_v1", "chat_messages_v1"}:
        metadata = _as_dict(record.get("metadata"))
        split = metadata.get("split") or record.get("split")
        return split.strip().lower() if isinstance(split, str) else None

    return None


def _quality_block(record: dict[str, Any]) -> dict[str, Any]:
    quality = record.get("quality")
    if isinstance(quality, dict):
        return quality
    metadata_quality = _as_dict(record.get("metadata")).get("quality")
    return metadata_quality if isinstance(metadata_quality, dict) else {}


def _reject_auxiliary_or_failed_record(
    *,
    split: str,
    source: Path,
    line_no: int,
    record: dict[str, Any],
    quality: dict[str, Any] | None = None,
) -> None:
    labels = _record_split_labels(record)
    quality = quality if quality is not None else _quality_block(record)
    if (
        any(label in REPAIR_SPLIT_LABELS for label in labels)
        or quality.get("success") is False
        or quality.get("requiresRepair") is True
        or quality.get("rating") == "repair"
    ):
        raise CandidateError(
            f"{source}:{line_no}: auxiliary trajectory/repair record cannot be "
            f"staged as trainable {split} split"
        )


def _validate_public_eliza_record_shape(
    *,
    source: Path,
    line_no: int,
    record: dict[str, Any],
) -> None:
    for field in ("roomName", "agentId", "expectedResponse"):
        if not isinstance(record.get(field), str) or not record[field].strip():
            raise CandidateError(f"{source}:{line_no}: ElizaRecord {field} is empty")

    memory_entries = record.get("memoryEntries")
    if not isinstance(memory_entries, list):
        raise CandidateError(f"{source}:{line_no}: ElizaRecord memoryEntries must be a list")
    for idx, entry in enumerate(memory_entries):
        if not isinstance(entry, dict):
            raise CandidateError(
                f"{source}:{line_no}: ElizaRecord memoryEntries[{idx}] must be an object"
            )
        content = entry.get("content")
        if content is not None and not isinstance(content, str):
            raise CandidateError(
                f"{source}:{line_no}: ElizaRecord memoryEntries[{idx}].content "
                "must be a string"
            )

    current_message = _as_dict(record.get("currentMessage"))
    if not isinstance(current_message.get("content"), str) or not current_message[
        "content"
    ].strip():
        raise CandidateError(f"{source}:{line_no}: ElizaRecord currentMessage.content is empty")

    available_actions = record.get("availableActions")
    if not isinstance(available_actions, list) or not all(
        isinstance(action, str) for action in available_actions
    ):
        raise CandidateError(
            f"{source}:{line_no}: ElizaRecord availableActions must be a list of strings"
        )

    metadata = record.get("metadata")
    if not isinstance(metadata, dict):
        raise CandidateError(f"{source}:{line_no}: ElizaRecord metadata must be an object")
    if not isinstance(metadata.get("task_type"), str) or not metadata["task_type"].strip():
        raise CandidateError(f"{source}:{line_no}: ElizaRecord metadata.task_type is empty")
    if not isinstance(metadata.get("source_dataset"), str) or not metadata[
        "source_dataset"
    ].strip():
        raise CandidateError(f"{source}:{line_no}: ElizaRecord metadata.source_dataset is empty")


def _validate_chat_messages_shape(
    *,
    source: Path,
    line_no: int,
    record: dict[str, Any],
) -> None:
    messages = record.get("messages")
    if not isinstance(messages, list) or not messages:
        raise CandidateError(f"{source}:{line_no}: messages must be a non-empty list")
    has_user = False
    for idx, message in enumerate(messages):
        if not isinstance(message, dict):
            raise CandidateError(f"{source}:{line_no}: messages[{idx}] must be an object")
        role = message.get("role")
        if role == "user":
            has_user = True
        if not isinstance(role, str) or not role.strip():
            raise CandidateError(f"{source}:{line_no}: messages[{idx}].role is empty")
        if "content" in message and not isinstance(message.get("content"), str):
            raise CandidateError(f"{source}:{line_no}: messages[{idx}].content must be a string")
    if not has_user:
        raise CandidateError(f"{source}:{line_no}: messages must include a user turn")
    last = messages[-1]
    if last.get("role") != "assistant":
        raise CandidateError(f"{source}:{line_no}: final message must be assistant")
    if not last.get("content") and not last.get("tool_calls"):
        raise CandidateError(
            f"{source}:{line_no}: final assistant message must have content or tool_calls"
        )


def _validate_trainable_record(
    *,
    split: str,
    source: Path,
    line_no: int,
    record: dict[str, Any],
    schema: str,
) -> None:
    actual_split = _split_label_for_record(record, schema)
    expected = TRAINABLE_SPLIT_ALIASES[split]

    if schema == ELIZA1_TRAJECTORY_RECORD_SCHEMA:
        quality = _as_dict(record.get("quality"))
        _reject_auxiliary_or_failed_record(
            split=split,
            source=source,
            line_no=line_no,
            record=record,
            quality=quality,
        )
        if quality.get("success") is not True:
            raise CandidateError(f"{source}:{line_no}: quality.success must be true")
        if quality.get("requiresRepair") is not False:
            raise CandidateError(f"{source}:{line_no}: quality.requiresRepair must be false")
        if actual_split not in expected:
            raise CandidateError(
                f"{source}:{line_no}: record split {actual_split!r} does not match "
                f"{split} split; expected one of {sorted(expected)}"
            )
        target = _as_dict(record.get("target"))
        if target.get("sftFormat") != "messages":
            raise CandidateError(f"{source}:{line_no}: target.sftFormat must be messages")
        return

    if schema == "eliza_native_v1":
        _reject_auxiliary_or_failed_record(
            split=split,
            source=source,
            line_no=line_no,
            record=record,
        )
        if actual_split and actual_split not in expected:
            raise CandidateError(
                f"{source}:{line_no}: record split {actual_split!r} does not match "
                f"{split} split; expected one of {sorted(expected)}"
            )
        return

    if schema == "chat_messages_v1":
        _validate_chat_messages_shape(source=source, line_no=line_no, record=record)
        _reject_auxiliary_or_failed_record(
            split=split,
            source=source,
            line_no=line_no,
            record=record,
        )
        if actual_split and actual_split not in expected:
            raise CandidateError(
                f"{source}:{line_no}: record split {actual_split!r} does not match "
                f"{split} split; expected one of {sorted(expected)}"
            )
        return

    if schema == "eliza_record_v1":
        _validate_public_eliza_record_shape(
            source=source,
            line_no=line_no,
            record=record,
        )
        _reject_auxiliary_or_failed_record(
            split=split,
            source=source,
            line_no=line_no,
            record=record,
        )


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def _iter_jsonl(path: Path) -> Iterable[tuple[int, dict[str, Any]]]:
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CandidateError(f"{path}:{line_no}: invalid JSON: {exc.msg}") from exc
            if not isinstance(value, dict):
                raise CandidateError(f"{path}:{line_no}: record must be a JSON object")
            yield line_no, value


def inspect_split(split: str, source: Path, candidate_dir: Path) -> SplitStats:
    source = source.resolve()
    if not source.exists():
        raise CandidateError(f"missing {split} split: {source}")
    if source.suffix != ".jsonl":
        raise CandidateError(f"{split} split must be .jsonl: {source}")

    schemas: set[str] = set()
    rows = 0
    real_user_export = False
    for line_no, record in _iter_jsonl(source):
        schema = _detect_schema(record)
        if schema == "unknown":
            raise CandidateError(f"{source}:{line_no}: unknown dataset schema")
        _validate_trainable_record(
            split=split,
            source=source,
            line_no=line_no,
            record=record,
            schema=schema,
        )
        schemas.add(schema)
        real_user_export = real_user_export or _record_real_user_export(record)
        rows += 1
        if len(schemas) > 1:
            raise CandidateError(f"{source}: mixed schemas inside one split: {sorted(schemas)}")
    if rows == 0:
        raise CandidateError(f"{source}: split has no records")
    if len(schemas) != 1:
        raise CandidateError(f"{source}: expected exactly one schema")

    target_rel = SPLIT_TARGETS[split]
    target = candidate_dir / target_rel
    path_in_repo = f"candidates/{candidate_dir.name}/{target_rel.as_posix()}"
    return SplitStats(
        split=split,
        source=source,
        target=target,
        path_in_repo=path_in_repo,
        rows=rows,
        bytes=source.stat().st_size,
        sha256=_sha256_file(source),
        schema=next(iter(schemas)),
        real_user_export=real_user_export,
    )


def _schema_contract(dataset_schema: str) -> dict[str, Any]:
    train_local_ready = dataset_schema in TRAIN_LOCAL_READY_SCHEMAS
    return {
        "trainingReadySchema": dataset_schema if train_local_ready else None,
        "trainLocalReady": train_local_ready,
        "publicDatasetCompatibility": {
            "repoId": PUBLIC_ELIZA1_DATASET,
            "config": PUBLIC_ELIZA1_CONFIG,
            "schema": "eliza_record_v1",
            "columns": list(PUBLIC_ELIZA1_COLUMNS),
            "compatible": dataset_schema == "eliza_record_v1",
        },
        "devProvidersPinned": False,
        "providerPolicy": (
            "Provider/model fields may remain as audit metadata in rows, "
            "but they are not part of the dataset contract."
        ),
        "opus47": "prepared_not_run",
        "vast": "canonical",
        "nebius": "deprecated_fallback",
    }


def build_plan(
    *,
    candidate_id: str,
    train: Path,
    validation: Path,
    test: Path,
    source_kind: str,
    privacy_reviewed: bool,
    source_manifest: Path | None = None,
    repo_id: str = DEFAULT_REPO_ID,
    candidate_root: Path | None = None,
    generated_at: str | None = None,
) -> CandidatePlan:
    candidate_id = _validate_candidate_id(candidate_id)
    if source_kind not in ALLOWED_SOURCE_KINDS:
        raise CandidateError(f"source_kind must be one of {sorted(ALLOWED_SOURCE_KINDS)}")

    candidate_root = candidate_root or DEFAULT_CANDIDATE_ROOT
    candidate_dir = (candidate_root / candidate_id).resolve()
    _ensure_under(candidate_dir, candidate_root)

    split_sources = (train, validation, test)
    source_manifest_info: SourceManifestInfo | None = None
    source_manifest_review_applies = False
    resolved_source_manifest = source_manifest or _candidate_source_manifest(split_sources)
    if resolved_source_manifest is not None:
        source_manifest_info = load_source_manifest(resolved_source_manifest)
        if source_manifest_info.real_user_export and source_kind != "user_export":
            raise CandidateError(
                "source manifest marks this data as user_export; use "
                "--source-kind user_export"
            )
        if source_kind == "user_export" or source_manifest_info.real_user_export:
            source_manifest_review_applies = source_manifest_info.privacy_reviewed and (
                source_manifest_info.source_kind in {None, "user_export"}
                or source_manifest_info.real_user_export
            )
            privacy_reviewed = privacy_reviewed or source_manifest_review_applies

    split_stats = (
        inspect_split("train", train, candidate_dir),
        inspect_split("validation", validation, candidate_dir),
        inspect_split("test", test, candidate_dir),
    )
    splits_mark_real_user_export = any(stat.real_user_export for stat in split_stats)
    if splits_mark_real_user_export and source_kind != "user_export":
        raise CandidateError(
            "split records mark this data as user_export; use --source-kind user_export"
        )
    schemas = {stat.schema for stat in split_stats}
    if len(schemas) != 1:
        by_split = {stat.split: stat.schema for stat in split_stats}
        raise CandidateError(f"refusing mixed split schemas: {by_split}")

    dataset_schema = next(iter(schemas))
    generated_at = generated_at or _utc_now()
    path_prefix = f"candidates/{candidate_id}"
    real_user_export = (
        source_kind == "user_export"
        or splits_mark_real_user_export
        or bool(source_manifest_info and source_manifest_info.real_user_export)
    )

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": candidate_id,
        "generatedAt": generated_at,
        "datasetSchema": dataset_schema,
        "sourceKind": source_kind,
        "privacy": {
            "reviewed": bool(privacy_reviewed),
            "realUserExport": real_user_export,
            "attestationSource": (
                "source_manifest"
                if source_manifest_info and source_manifest_review_applies
                else "cli_flag"
                if privacy_reviewed
                else None
            ),
            "note": (
                "Human privacy review attested before write/push."
                if privacy_reviewed
                else "Dry-run or non-user candidate; no privacy attestation recorded."
            ),
        },
        "hf": {
            "repoId": repo_id,
            "pathPrefix": path_prefix,
            "candidateOnly": True,
        },
        "contract": _schema_contract(dataset_schema),
        "splits": {
            stat.split: {
                "path": SPLIT_TARGETS[stat.split].as_posix(),
                "rows": stat.rows,
                "bytes": stat.bytes,
                "sha256": stat.sha256,
                "sourceFileName": stat.source.name,
                "realUserExport": stat.real_user_export,
            }
            for stat in split_stats
        },
    }
    if source_manifest_info is not None:
        manifest["sourceManifest"] = {
            "path": source_manifest_info.path.name,
            "pathRef": _safe_ref(str(source_manifest_info.path)),
            "sha256": source_manifest_info.sha256,
            "schema": source_manifest_info.schema,
            "version": source_manifest_info.version,
            "sourceKind": source_manifest_info.source_kind,
            "privacyReviewed": source_manifest_info.privacy_reviewed,
            "realUserExport": source_manifest_info.real_user_export,
            "privacy": source_manifest_info.privacy_summary,
        }

    readme = _render_readme(manifest)
    return CandidatePlan(
        candidate_id=candidate_id,
        candidate_dir=candidate_dir,
        repo_id=repo_id,
        source_kind=source_kind,
        privacy_reviewed=privacy_reviewed,
        split_stats=split_stats,
        manifest=manifest,
        readme=readme,
    )


def _render_readme(manifest: dict[str, Any]) -> str:
    split_lines = []
    for split, info in manifest["splits"].items():
        split_lines.append(
            f"| {split} | `{info['path']}` | {info['rows']} | `{info['sha256']}` |"
        )
    splits = "\n".join(split_lines)
    contract = manifest["contract"]
    if contract["publicDatasetCompatibility"]["compatible"]:
        training_note = (
            f"This candidate matches the public `{PUBLIC_ELIZA1_DATASET}` flat "
            "`ElizaRecord` columns and is train-local compatible through the "
            "legacy flat-record formatter."
        )
    elif contract["trainLocalReady"]:
        training_note = (
            "This candidate is train-local ready for the current Qwen path as "
            f"`{contract['trainingReadySchema']}`."
        )
    else:
        training_note = (
            "This candidate is not directly train-local ready for the current "
            "Qwen path; convert it to `eliza_native_v1` before training."
        )
    return (
        "---\n"
        "license: other\n"
        "task_categories:\n"
        "  - text-generation\n"
        "language:\n"
        "  - en\n"
        "tags:\n"
        "  - eliza\n"
        "  - eliza-1\n"
        "  - candidate\n"
        "---\n"
        "\n"
        f"# Eliza-1 dataset candidate: {manifest['candidateId']}\n"
        "\n"
        "This is a staged dataset candidate, not a released training corpus.\n"
        "\n"
        f"- Schema: `{manifest['datasetSchema']}`\n"
        f"- Source kind: `{manifest['sourceKind']}`\n"
        f"- Privacy reviewed: `{str(manifest['privacy']['reviewed']).lower()}`\n"
        f"- Train-local ready: `{str(contract['trainLocalReady']).lower()}`\n"
        "- Dev providers pinned: `false`\n"
        "- Opus 4.7 status: `prepared_not_run`\n"
        "- Cloud training: Vast canonical; Nebius deprecated fallback only.\n"
        "\n"
        "## Splits\n"
        "\n"
        "| Split | Path | Rows | SHA-256 |\n"
        "| --- | --- | ---: | --- |\n"
        f"{splits}\n"
        "\n"
        "## Contract\n"
        "\n"
        f"{training_note}\n"
        "\n"
        "Provider/model fields may exist as row-level audit metadata, but provider\n"
        "names, token accounting, latency, cost, and provider-specific metadata are\n"
        "not contract fields.\n"
    )


def _candidate_write_paths(plan: CandidatePlan) -> dict[Path, bytes | Path]:
    return {
        plan.candidate_dir / "README.md": plan.readme.encode("utf-8"),
        plan.candidate_dir / "manifest.json": json.dumps(
            plan.manifest, indent=2, sort_keys=True
        ).encode("utf-8")
        + b"\n",
        **{stat.target: stat.source for stat in plan.split_stats},
    }


def validate_write_allowed(plan: CandidatePlan) -> None:
    if plan.source_kind == "user_export" and not plan.privacy_reviewed:
        raise CandidateError(
            "refusing to write user-export candidate without --privacy-reviewed"
        )
    for target in _candidate_write_paths(plan):
        _ensure_under(target, plan.candidate_dir)
        rel = target.relative_to(plan.candidate_dir)
        if rel not in ALLOWED_LOCAL_RELATIVE:
            raise CandidateError(f"refusing non-candidate write path: {rel}")


def write_candidate(plan: CandidatePlan) -> None:
    validate_write_allowed(plan)
    for target, payload in _candidate_write_paths(plan).items():
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(payload, Path):
            if payload.resolve() == target.resolve():
                continue
            shutil.copyfile(payload, target)
        else:
            target.write_bytes(payload)


def _validate_push_paths(plan: CandidatePlan) -> list[tuple[Path, str]]:
    prefix = f"candidates/{plan.candidate_id}/"
    uploads = [
        (plan.candidate_dir / "README.md", f"{prefix}README.md"),
        (plan.candidate_dir / "manifest.json", f"{prefix}manifest.json"),
    ]
    uploads.extend((stat.target, stat.path_in_repo) for stat in plan.split_stats)
    for local, path_in_repo in uploads:
        if not local.exists():
            raise CandidateError(f"missing staged file for push: {local}")
        if not path_in_repo.startswith(prefix):
            raise CandidateError(f"refusing non-candidate repo path: {path_in_repo}")
    return uploads


def validate_push_allowed(
    plan: CandidatePlan,
    *,
    allow_hf_push: bool,
    allow_user_export_push: bool,
) -> None:
    if not allow_hf_push:
        raise CandidateError("refusing HF push without --allow-hf-push")
    if plan.source_kind == "user_export" and not allow_user_export_push:
        raise CandidateError(
            "refusing to push user-export candidate without --allow-user-export-push"
        )
    if plan.source_kind == "user_export" and not plan.privacy_reviewed:
        raise CandidateError(
            "refusing to push user-export candidate without --privacy-reviewed"
        )
    if not hf_token():
        raise CandidateError("HF_TOKEN or HUGGINGFACE_HUB_TOKEN is required for push")


def push_candidate(
    plan: CandidatePlan,
    *,
    allow_hf_push: bool,
    allow_user_export_push: bool,
    public: bool,
) -> int:
    validate_push_allowed(
        plan,
        allow_hf_push=allow_hf_push,
        allow_user_export_push=allow_user_export_push,
    )

    uploads = _validate_push_paths(plan)

    from huggingface_hub import CommitOperationAdd, HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())
    try:
        api.repo_info(plan.repo_id, repo_type="dataset")
    except RepositoryNotFoundError:
        api.create_repo(
            repo_id=plan.repo_id,
            repo_type="dataset",
            private=not public,
            exist_ok=False,
        )

    operations = [
        CommitOperationAdd(path_in_repo=path_in_repo, path_or_fileobj=str(local))
        for local, path_in_repo in uploads
    ]
    api.create_commit(
        repo_id=plan.repo_id,
        repo_type="dataset",
        operations=operations,
        commit_message=f"Stage eliza-1 dataset candidate {plan.candidate_id}",
    )
    return 0


def print_plan(plan: CandidatePlan) -> None:
    print(f"candidate: {plan.candidate_id}")
    print(f"schema: {plan.dataset_schema}")
    print(f"source_kind: {plan.source_kind}")
    print(f"privacy_reviewed: {str(plan.privacy_reviewed).lower()}")
    print(f"local_dir: {plan.candidate_dir}")
    print(f"hf_repo: {plan.repo_id}")
    print(f"hf_prefix: candidates/{plan.candidate_id}/")
    for stat in plan.split_stats:
        print(
            f"{stat.split}: {stat.rows} rows, {stat.bytes} bytes, "
            f"{stat.source} -> {stat.target.relative_to(plan.candidate_dir)}"
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--candidate-id", required=True)
    ap.add_argument("--train", required=True, type=Path)
    ap.add_argument("--validation", required=True, type=Path)
    ap.add_argument("--test", required=True, type=Path)
    ap.add_argument(
        "--source-manifest",
        type=Path,
        default=None,
        help=(
            "Optional upstream split/source manifest. If it marks the data as "
            "user_export, privacy review must be attested by the manifest or "
            "--privacy-reviewed."
        ),
    )
    ap.add_argument(
        "--source-kind",
        choices=sorted(ALLOWED_SOURCE_KINDS),
        default="user_export",
        help="Default is user_export so privacy review is required before writes.",
    )
    ap.add_argument("--privacy-reviewed", action="store_true")
    ap.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    ap.add_argument("--write", action="store_true", help="write the local candidate files")
    ap.add_argument("--push", action="store_true", help="push the staged candidate to HF")
    ap.add_argument("--allow-hf-push", action="store_true")
    ap.add_argument("--allow-user-export-push", action="store_true")
    ap.add_argument("--public", action="store_true", help="create HF repo public if missing")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        plan = build_plan(
            candidate_id=args.candidate_id,
            train=args.train,
            validation=args.validation,
            test=args.test,
            source_kind=args.source_kind,
            privacy_reviewed=args.privacy_reviewed,
            source_manifest=args.source_manifest,
            repo_id=args.repo_id,
        )
        print_plan(plan)
        if not args.write and not args.push:
            print("dry-run: no files written and no HF calls made")
            return 0
        if args.push and not args.write:
            raise CandidateError("--push requires --write so the staged files are auditable")
        if args.push:
            validate_push_allowed(
                plan,
                allow_hf_push=args.allow_hf_push,
                allow_user_export_push=args.allow_user_export_push,
            )
        if args.write:
            write_candidate(plan)
            print(f"wrote candidate files under {plan.candidate_dir}")
        if args.push:
            return push_candidate(
                plan,
                allow_hf_push=args.allow_hf_push,
                allow_user_export_push=args.allow_user_export_push,
                public=args.public,
            )
        return 0
    except CandidateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
