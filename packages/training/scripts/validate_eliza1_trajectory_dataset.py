#!/usr/bin/env python3
"""Validate Eliza-1 trajectory SFT JSONL files.

This validator is intentionally stdlib-only. It enforces the local schema
contract, HuggingFace-friendly shape consistency, success/failure split
separation, canonical action aliases, and optional action-manifest membership.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
TRAINING_ROOT = SCRIPT_DIR.parent
DEFAULT_ALIAS_PATH = TRAINING_ROOT / "config" / "eliza1_action_aliases.json"

sys.path.insert(0, str(SCRIPT_DIR))
from prepare_eliza1_trajectory_dataset import (  # noqa: E402
    NATIVE_BOUNDARIES,
    NATIVE_FORMAT,
    SCHEMA_VERSION,
    ActionAliases,
    load_action_manifest,
)
from format_for_training import format_record  # noqa: E402

LOG = logging.getLogger("validate-eliza1-trajectories")

VALIDATION_SCHEMA = "eliza.eliza1_trajectory_validation_report.v1"
VALID_SPLITS = {"train", "val", "test", "repair_eval"}
VALID_ROLES = {"system", "user", "assistant", "tool"}
VALID_RATINGS = {"gold", "silver", "bronze", "repair"}
SUCCESS_SPLITS = {"train", "val", "test"}
FILE_SPLITS = {
    "train.jsonl": "train",
    "val.jsonl": "val",
    "test.jsonl": "test",
    "repair_eval.jsonl": "repair_eval",
}
REQUIRED_TOP_LEVEL = {
    "schema",
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
REQUIRED_TARGET = {"modelFamily", "baseModel", "sftFormat", "chatTemplate"}
REQUIRED_QUALITY = {"success", "score", "weight", "rating", "requiresRepair", "reasons"}
REQUIRED_SOURCE = {
    "kind",
    "dataset",
    "path",
    "rowIndex",
    "sourceId",
    "trajectoryId",
    "scenarioId",
    "turnIndex",
    "format",
}


def iter_validation_files(paths: Iterable[str]) -> Iterable[Path]:
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in {".jsonl", ".ndjson"}:
                    yield child
        else:
            yield path


def _expand_top_level(value: Any) -> Iterable[Any]:
    if isinstance(value, list):
        yield from value
        return
    if isinstance(value, dict):
        for key in ("rows", "records", "examples", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                yield from nested
                return
    yield value


def iter_records(path: Path, max_records: int | None = None) -> Iterable[tuple[int, dict[str, Any] | None, str | None]]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return
    if text[0] in "[{":
        try:
            parsed = json.loads(text)
            for idx, item in enumerate(_expand_top_level(parsed), start=1):
                if max_records is not None and idx > max_records:
                    return
                if isinstance(item, dict):
                    yield idx, item, None
                else:
                    yield idx, None, f"top-level item is {type(item).__name__}, expected object"
            return
        except json.JSONDecodeError:
            pass

    count = 0
    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        count += 1
        if max_records is not None and count > max_records:
            return
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            yield line_no, None, f"json_parse_error: {exc}"
            continue
        if not isinstance(parsed, dict):
            yield line_no, None, f"line is {type(parsed).__name__}, expected object"
            continue
        yield line_no, parsed, None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_keyset(
    obj: Any,
    required: set[str],
    *,
    path: str,
    allow_extra: bool,
) -> list[tuple[str, str]]:
    if not isinstance(obj, dict):
        return [(f"{path}_not_object", f"{path} must be an object")]
    keys = set(obj)
    errs: list[tuple[str, str]] = []
    missing = sorted(required - keys)
    if missing:
        errs.append((f"{path}_missing_keys", f"{path} missing keys: {missing}"))
    extra = sorted(keys - required)
    if extra and not allow_extra:
        errs.append((f"{path}_unknown_keys", f"{path} has unknown keys: {extra}"))
    return errs


def _validate_action_name(
    name: Any,
    *,
    aliases: ActionAliases,
    allowed_actions: set[str] | None,
    path: str,
) -> list[tuple[str, str]]:
    if not isinstance(name, str) or not name.strip():
        return [("action_name_empty", f"{path} must be a non-empty string")]
    canonical = aliases.canonicalize(name)
    errs: list[tuple[str, str]] = []
    if canonical != name:
        errs.append(
            (
                "noncanonical_action_alias",
                f"{path}={name!r} should be canonicalized to {canonical!r}",
            )
        )
    if allowed_actions is not None and canonical not in allowed_actions:
        errs.append(
            (
                "action_not_in_manifest",
                f"{path}={name!r} canonical={canonical!r} not found in action manifest",
            )
        )
    return errs


def _native_tool_call_name(raw: dict[str, Any]) -> Any:
    fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
    return raw.get("toolName") or raw.get("name") or raw.get("tool_name") or fn.get("name")


def _native_tool_call_arguments(raw: dict[str, Any]) -> Any:
    fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
    for key in ("input", "args", "arguments", "parameters"):
        if key in raw:
            return raw[key]
    return fn.get("arguments")


def _iter_native_request_tool_names(tools: Any) -> Iterable[tuple[str, Any]]:
    if isinstance(tools, dict):
        for key, spec in tools.items():
            if isinstance(spec, dict):
                fn = spec.get("function") if isinstance(spec.get("function"), dict) else spec
                yield str(key), fn.get("name") if isinstance(fn, dict) else key
            else:
                yield str(key), key
        return
    if isinstance(tools, list):
        for idx, item in enumerate(tools):
            if not isinstance(item, dict):
                yield f"request.tools[{idx}]", None
                continue
            fn = item.get("function") if isinstance(item.get("function"), dict) else item
            yield f"request.tools[{idx}].function.name", fn.get("name") if isinstance(fn, dict) else None


def _iter_native_response_tool_calls(response: Any) -> Iterable[tuple[str, dict[str, Any]]]:
    if not isinstance(response, dict):
        return
    calls = response.get("toolCalls")
    if isinstance(calls, list):
        for idx, call in enumerate(calls):
            if isinstance(call, dict):
                yield f"response.toolCalls[{idx}]", call


def _split_from_path(path: Path) -> str | None:
    return FILE_SPLITS.get(path.name)


def _validate_tool_call(
    call: Any,
    *,
    aliases: ActionAliases,
    allowed_actions: set[str] | None,
    path: str,
) -> list[tuple[str, str]]:
    if not isinstance(call, dict):
        return [("tool_call_not_object", f"{path} must be an object")]
    errs: list[tuple[str, str]] = []
    if call.get("type") != "function":
        errs.append(("tool_call_type_invalid", f"{path}.type must be 'function'"))
    fn = call.get("function")
    if not isinstance(fn, dict):
        errs.append(("tool_call_function_missing", f"{path}.function must be an object"))
        return errs
    errs.extend(
        _validate_action_name(
            fn.get("name"),
            aliases=aliases,
            allowed_actions=allowed_actions,
            path=f"{path}.function.name",
        )
    )
    if not isinstance(fn.get("arguments"), dict):
        errs.append(("tool_call_arguments_not_object", f"{path}.function.arguments must be an object"))
    return errs


def validate_record(
    record: dict[str, Any],
    *,
    aliases: ActionAliases,
    allowed_actions: set[str] | None,
    file_split: str | None = None,
) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    errs.extend(_check_keyset(record, REQUIRED_TOP_LEVEL, path="record", allow_extra=False))
    if record.get("schema") != SCHEMA_VERSION:
        errs.append(("schema_mismatch", f"schema must be {SCHEMA_VERSION!r}"))
    if not isinstance(record.get("id"), str) or len(record.get("id", "")) < 12:
        errs.append(("id_invalid", "id must be a stable string with length >= 12"))
    split = record.get("split")
    if split not in VALID_SPLITS:
        errs.append(("split_invalid", f"split must be one of {sorted(VALID_SPLITS)}"))
    if file_split is not None and split in VALID_SPLITS and split != file_split:
        errs.append(("split_file_mismatch", f"record split {split!r} is in {file_split!r} file"))
    if not isinstance(record.get("task"), str) or not record.get("task", "").strip():
        errs.append(("task_invalid", "task must be a non-empty string"))

    target = record.get("target")
    errs.extend(_check_keyset(target, REQUIRED_TARGET, path="target", allow_extra=False))
    if isinstance(target, dict):
        if target.get("modelFamily") != "qwen":
            errs.append(("target_model_family_invalid", "target.modelFamily must be qwen"))
        if target.get("sftFormat") != "messages":
            errs.append(("target_sft_format_invalid", "target.sftFormat must be messages"))
        if target.get("chatTemplate") != "chatml":
            errs.append(("target_chat_template_invalid", "target.chatTemplate must be chatml"))

    messages = record.get("messages")
    if not isinstance(messages, list) or not messages:
        errs.append(("messages_empty", "messages must be a non-empty array"))
    else:
        for idx, msg in enumerate(messages):
            if not isinstance(msg, dict):
                errs.append(("message_not_object", f"messages[{idx}] must be an object"))
                continue
            role = msg.get("role")
            if role not in VALID_ROLES:
                errs.append(("message_role_invalid", f"messages[{idx}].role={role!r} invalid"))
            if not isinstance(msg.get("content"), str):
                errs.append(("message_content_not_string", f"messages[{idx}].content must be a string"))
            raw_calls = msg.get("tool_calls")
            if raw_calls is not None:
                if not isinstance(raw_calls, list):
                    errs.append(("message_tool_calls_not_array", f"messages[{idx}].tool_calls must be an array"))
                else:
                    for call_idx, call in enumerate(raw_calls):
                        errs.extend(
                            _validate_tool_call(
                                call,
                                aliases=aliases,
                                allowed_actions=allowed_actions,
                                path=f"messages[{idx}].tool_calls[{call_idx}]",
                            )
                        )
        last = messages[-1]
        if isinstance(last, dict):
            if last.get("role") != "assistant":
                errs.append(("last_message_not_assistant", "last message must be assistant"))
            if not (last.get("content") or last.get("tool_calls")):
                errs.append(("assistant_empty", "assistant message must have content or tool_calls"))

    tools = record.get("tools")
    if not isinstance(tools, list):
        errs.append(("tools_not_array", "tools must be an array"))
    else:
        for idx, tool in enumerate(tools):
            if not isinstance(tool, dict):
                errs.append(("tool_not_object", f"tools[{idx}] must be an object"))
                continue
            if tool.get("type") != "function":
                errs.append(("tool_type_invalid", f"tools[{idx}].type must be function"))
            fn = tool.get("function")
            if not isinstance(fn, dict):
                errs.append(("tool_function_missing", f"tools[{idx}].function must be an object"))
                continue
            errs.extend(
                _validate_action_name(
                    fn.get("name"),
                    aliases=aliases,
                    allowed_actions=allowed_actions,
                    path=f"tools[{idx}].function.name",
                )
            )
            if not isinstance(fn.get("description"), str):
                errs.append(("tool_description_not_string", f"tools[{idx}].function.description must be a string"))
            if not isinstance(fn.get("parameters"), dict):
                errs.append(("tool_parameters_not_object", f"tools[{idx}].function.parameters must be an object"))

    actions = record.get("actions")
    if not isinstance(actions, list):
        errs.append(("actions_not_array", "actions must be an array"))
    else:
        for idx, action in enumerate(actions):
            if not isinstance(action, dict):
                errs.append(("action_not_object", f"actions[{idx}] must be an object"))
                continue
            if set(action) != {"name", "originalName", "arguments"}:
                errs.append(("action_shape_invalid", f"actions[{idx}] must have name/originalName/arguments only"))
            errs.extend(
                _validate_action_name(
                    action.get("name"),
                    aliases=aliases,
                    allowed_actions=allowed_actions,
                    path=f"actions[{idx}].name",
                )
            )
            if not isinstance(action.get("originalName"), str) or not action.get("originalName", "").strip():
                errs.append(("action_original_name_invalid", f"actions[{idx}].originalName must be non-empty"))
            if not isinstance(action.get("arguments"), dict):
                errs.append(("action_arguments_not_object", f"actions[{idx}].arguments must be an object"))

    quality = record.get("quality")
    errs.extend(_check_keyset(quality, REQUIRED_QUALITY, path="quality", allow_extra=False))
    if isinstance(quality, dict):
        success = quality.get("success")
        requires_repair = quality.get("requiresRepair")
        if not isinstance(success, bool):
            errs.append(("quality_success_not_bool", "quality.success must be boolean"))
        if not _is_number(quality.get("score")) or not 0 <= float(quality.get("score")) <= 1:
            errs.append(("quality_score_invalid", "quality.score must be a number in [0, 1]"))
        if not _is_number(quality.get("weight")) or float(quality.get("weight")) < 0:
            errs.append(("quality_weight_invalid", "quality.weight must be a non-negative number"))
        if quality.get("rating") not in VALID_RATINGS:
            errs.append(("quality_rating_invalid", f"quality.rating must be one of {sorted(VALID_RATINGS)}"))
        if not isinstance(requires_repair, bool):
            errs.append(("quality_requires_repair_not_bool", "quality.requiresRepair must be boolean"))
        if isinstance(success, bool) and isinstance(requires_repair, bool) and success == requires_repair:
            errs.append(("quality_repair_conflict", "quality.requiresRepair must be the inverse of quality.success"))
        if not isinstance(quality.get("reasons"), list) or not all(
            isinstance(item, str) for item in quality.get("reasons", [])
        ):
            errs.append(("quality_reasons_invalid", "quality.reasons must be an array of strings"))
        if success is True and split not in SUCCESS_SPLITS:
            errs.append(("successful_record_in_repair_eval", "successful records must be train/val/test"))
        if success is False and split != "repair_eval":
            errs.append(("failed_record_in_success_split", "failed records must be in repair_eval"))

    source = record.get("source")
    errs.extend(_check_keyset(source, REQUIRED_SOURCE, path="source", allow_extra=False))
    if isinstance(source, dict):
        if source.get("kind") not in {"eliza_native_v1", "lifeops_bench_result"}:
            errs.append(("source_kind_invalid", "source.kind invalid"))
        if not isinstance(source.get("dataset"), str):
            errs.append(("source_dataset_not_string", "source.dataset must be a string"))
        if not isinstance(source.get("path"), str):
            errs.append(("source_path_not_string", "source.path must be a string"))
        if not isinstance(source.get("rowIndex"), int) or source.get("rowIndex") < 0:
            errs.append(("source_row_index_invalid", "source.rowIndex must be a non-negative integer"))
        turn_index = source.get("turnIndex")
        if turn_index is not None and (not isinstance(turn_index, int) or turn_index < 0):
            errs.append(("source_turn_index_invalid", "source.turnIndex must be null or a non-negative integer"))

    if not isinstance(record.get("metadata"), dict):
        errs.append(("metadata_not_object", "metadata must be an object"))
    return errs


def validate_native_record(
    record: dict[str, Any],
    *,
    aliases: ActionAliases,
    allowed_actions: set[str] | None,
    file_split: str | None = None,
) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    if record.get("format") != NATIVE_FORMAT:
        errs.append(("native_format_invalid", f"format must be {NATIVE_FORMAT!r}"))
    if record.get("boundary") not in NATIVE_BOUNDARIES:
        errs.append(("native_boundary_invalid", f"boundary must be one of {sorted(NATIVE_BOUNDARIES)}"))

    request = record.get("request")
    response = record.get("response")
    metadata = record.get("metadata")
    if not isinstance(request, dict):
        errs.append(("native_request_not_object", "request must be an object"))
        request = {}
    if not isinstance(response, dict):
        errs.append(("native_response_not_object", "response must be an object"))
        response = {}
    if not isinstance(metadata, dict):
        errs.append(("native_metadata_not_object", "metadata must be an object"))
        metadata = {}

    split = metadata.get("split") if isinstance(metadata, dict) else None
    if file_split is not None and isinstance(split, str) and split != file_split:
        errs.append(("split_file_mismatch", f"metadata.split {split!r} is in {file_split!r} file"))

    quality = metadata.get("quality") if isinstance(metadata, dict) else None
    if isinstance(quality, dict):
        success = quality.get("success")
        if success is True and split == "repair_eval":
            errs.append(("successful_record_in_repair_eval", "successful records must be train/val/test"))
        if success is False and split in SUCCESS_SPLITS:
            errs.append(("failed_record_in_success_split", "failed records must be in repair_eval"))
        if success is False and file_split in SUCCESS_SPLITS:
            errs.append(("failed_record_in_success_split", "failed records must not be in train/val/test files"))

    try:
        formatted = format_record(record)
    except Exception as exc:  # pragma: no cover - defensive; format_record should be pure
        formatted = None
        errs.append(("format_for_training_error", f"format_record raised {type(exc).__name__}: {exc}"))
    if formatted is None:
        errs.append(("not_train_local_compatible", "format_for_training.format_record returned None"))
    elif not any(msg.get("role") == "user" for msg in formatted.get("messages", [])):
        errs.append(("native_missing_user_message", "formatted messages must contain a user turn"))

    declared_actions: set[str] = set()
    for path, name in _iter_native_request_tool_names(request.get("tools")):
        action_path = path if path.endswith(".function.name") else f"request.tools.{path}"
        errs.extend(
            _validate_action_name(
                name,
                aliases=aliases,
                allowed_actions=allowed_actions,
                path=action_path,
            )
        )
        if isinstance(name, str) and name.strip():
            declared_actions.add(aliases.canonicalize(name))

    for path, call in _iter_native_response_tool_calls(response):
        name = _native_tool_call_name(call)
        errs.extend(
            _validate_action_name(
                name,
                aliases=aliases,
                allowed_actions=allowed_actions,
                path=f"{path}.toolName",
            )
        )
        args = _native_tool_call_arguments(call)
        if isinstance(args, str):
            stripped = args.strip()
            if stripped:
                try:
                    decoded = json.loads(stripped)
                except json.JSONDecodeError:
                    decoded = None
                if not isinstance(decoded, dict):
                    errs.append(("native_tool_call_arguments_not_object", f"{path} arguments must decode to an object"))
        elif args is not None and not isinstance(args, dict):
            errs.append(("native_tool_call_arguments_not_object", f"{path} arguments must be an object"))
        if isinstance(name, str) and name.strip():
            canonical = aliases.canonicalize(name)
            if not declared_actions or canonical not in declared_actions:
                errs.append(
                    (
                        "tool_call_not_declared",
                        f"{path}.toolName={name!r} canonical={canonical!r} not found in request.tools",
                    )
                )
    return errs


@dataclass
class ShapeTracker:
    top: tuple[str, ...] | None = None
    target: tuple[str, ...] | None = None
    quality: tuple[str, ...] | None = None
    source: tuple[str, ...] | None = None

    def check(self, rec: dict[str, Any]) -> list[tuple[str, str]]:
        errs: list[tuple[str, str]] = []
        for attr, value in (
            ("top", rec),
            ("target", rec.get("target")),
            ("quality", rec.get("quality")),
            ("source", rec.get("source")),
        ):
            if not isinstance(value, dict):
                continue
            keys = tuple(sorted(value.keys()))
            expected = getattr(self, attr)
            if expected is None:
                setattr(self, attr, keys)
            elif keys != expected:
                errs.append(
                    (
                        "shape_drift",
                        f"{attr} keys {list(keys)} do not match first record keys {list(expected)}",
                    )
                )
        return errs


def _source_kind_for(record: dict[str, Any]) -> str:
    if record.get("format") == NATIVE_FORMAT:
        return NATIVE_FORMAT
    source = record.get("source") if isinstance(record.get("source"), dict) else {}
    return str(source.get("kind") or "__none__")


def _id_namespace_for(record: dict[str, Any]) -> str:
    if record.get("format") == NATIVE_FORMAT:
        return NATIVE_FORMAT
    if record.get("schema") == SCHEMA_VERSION:
        return SCHEMA_VERSION
    return _source_kind_for(record)


def _record_action_names(record: dict[str, Any], aliases: ActionAliases) -> Iterable[str]:
    if record.get("format") == NATIVE_FORMAT:
        response = record.get("response")
        for _path, call in _iter_native_response_tool_calls(response):
            name = _native_tool_call_name(call)
            if isinstance(name, str) and name.strip():
                yield aliases.canonicalize(name)
        return
    actions = record.get("actions")
    if isinstance(actions, list):
        for action in actions:
            if isinstance(action, dict) and isinstance(action.get("name"), str):
                yield aliases.canonicalize(action["name"])


def run(args: argparse.Namespace) -> dict[str, Any]:
    aliases = ActionAliases.load(Path(args.action_aliases))
    allowed_actions: set[str] | None = None
    if args.action_manifest:
        allowed_actions = set(load_action_manifest(Path(args.action_manifest), aliases))

    total = 0
    valid = 0
    seen_ids: set[str] = set()
    shape = ShapeTracker()
    errors_by_code: Counter[str] = Counter()
    errors_by_file: dict[str, Counter[str]] = defaultdict(Counter)
    errors_by_source_kind: dict[str, Counter[str]] = defaultdict(Counter)
    action_counts: Counter[str] = Counter()
    first_failures: list[dict[str, Any]] = []

    for path in iter_validation_files(args.input):
        file_split = _split_from_path(path)
        if not path.exists():
            errors_by_code["input_not_found"] += 1
            errors_by_file[str(path)]["input_not_found"] += 1
            first_failures.append(
                {
                    "path": str(path),
                    "line": 0,
                    "record_id": None,
                    "error": "input_not_found",
                    "fix_hint": "input path does not exist",
                }
            )
            continue
        LOG.info("validating %s", path)
        for line_no, record, parse_error in iter_records(path, args.max_records):
            total += 1
            if parse_error is not None or record is None:
                errs = [("json_parse_error", parse_error or "record is not an object")]
                source_kind = "__parse__"
                record_id = f"line:{line_no}"
            else:
                errs = []
                metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
                raw_record_id = str(
                    record.get("id")
                    or metadata.get("trajectory_record_id")
                    or metadata.get("source_id")
                    or f"line:{line_no}"
                )
                record_id = f"{_id_namespace_for(record)}:{raw_record_id}"
                if record_id in seen_ids:
                    errs.append(("duplicate_id", f"id {record_id!r} appears more than once"))
                else:
                    seen_ids.add(record_id)
                if record.get("format") == NATIVE_FORMAT:
                    errs.extend(
                        validate_native_record(
                            record,
                            aliases=aliases,
                            allowed_actions=allowed_actions,
                            file_split=file_split,
                        )
                    )
                else:
                    errs.extend(shape.check(record))
                    errs.extend(
                        validate_record(
                            record,
                            aliases=aliases,
                            allowed_actions=allowed_actions,
                            file_split=file_split,
                        )
                    )
                source_kind = _source_kind_for(record)
                for action_name in _record_action_names(record, aliases):
                    action_counts[action_name] += 1

            if not errs:
                valid += 1
                continue
            for code, hint in errs:
                errors_by_code[code] += 1
                errors_by_file[str(path)][code] += 1
                errors_by_source_kind[source_kind][code] += 1
                if len(first_failures) < 50:
                    first_failures.append(
                        {
                            "path": str(path),
                            "line": line_no,
                            "record_id": record_id,
                            "source_kind": source_kind,
                            "error": code,
                            "fix_hint": hint,
                        }
                    )

    if total == 0:
        errors_by_code["empty_input"] += 1
        first_failures.append(
            {
                "path": ",".join(args.input),
                "line": 0,
                "record_id": None,
                "error": "empty_input",
                "fix_hint": "no JSONL records found",
            }
        )

    return {
        "schema": VALIDATION_SCHEMA,
        "recordSchema": SCHEMA_VERSION,
        "totalRecords": total,
        "validRecords": valid,
        "invalidRecords": total - valid + (1 if total == 0 else 0),
        "errorsByCode": dict(sorted(errors_by_code.items())),
        "errorsByFile": {k: dict(sorted(v.items())) for k, v in sorted(errors_by_file.items())},
        "errorsBySourceKind": {
            k: dict(sorted(v.items())) for k, v in sorted(errors_by_source_kind.items())
        },
        "actionCounts": dict(sorted(action_counts.items())),
        "actionManifest": {
            "path": str(Path(args.action_manifest)) if args.action_manifest else None,
            "actionCount": len(allowed_actions or set()),
        },
        "firstFailures": first_failures,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", required=True, help="JSONL file or directory. Repeatable.")
    parser.add_argument("--report", required=True)
    parser.add_argument("--action-aliases", default=str(DEFAULT_ALIAS_PATH))
    parser.add_argument("--action-manifest", default="")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--max-records", type=int, default=0)
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.max_records = args.max_records or None
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    report = run(args)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"[validate_eliza1_trajectory_dataset] total={report['totalRecords']} "
        f"valid={report['validRecords']} invalid={report['invalidRecords']} "
        f"report={report_path}",
        file=sys.stderr,
    )
    return 1 if args.strict and report["invalidRecords"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
