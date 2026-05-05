"""Audit normalized records against canonical elizaOS pipeline-stage schemas.

Reads every line under ``data/normalized/*.jsonl`` (skipping ``.errors.jsonl``),
TOON-decodes each ``expectedResponse`` via ``tools/toon_decode.mjs``, then
checks the decoded shape against the schema documented in
``previews/PIPELINE_SCHEMAS.md`` for the record's ``metadata.task_type``.

Outputs:

- ``previews/PIPELINE_AUDIT.md``  — per-task_type conformance summary.
- ``previews/pipeline_audit.json`` — raw audit data with mismatch reasons
                                    and example records.

Usage:

    uv run python scripts/audit_pipeline_shapes.py
    uv run python scripts/audit_pipeline_shapes.py --sample 5000
    uv run python scripts/audit_pipeline_shapes.py --only agent-trove
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from lib.toon import ToonDecoder

log = logging.getLogger("audit")


# ─────────────────────────── per-stage validators ────────────────────────────

# task_types whose canonical envelope is the planner (5-key) document.
PLANNER_TASK_TYPES = {
    "agent_trace",
    "tool_call",
    "mcp_tool_call",
    "shell_command",
    "n8n_workflow_generation",
    "scam_defense",
    "mcp_routing",
}

# task_types where the slim {thought, text} or planner envelope are both OK.
REPLY_OR_PLANNER_TASK_TYPES = {"reply"}

# task_types where the slim {thought, text} or {text} reply form is canonical.
REPLY_SLIM_TASK_TYPES = {"reasoning_cot"}

# task_types using the shouldRespond classifier schema.
SHOULD_RESPOND_TASK_TYPES = {
    "should_respond",
    "should_respond_with_context",
    "context_routing",
}

# task_types using the reflection schema.
REFLECTION_TASK_TYPES = {"reflection_evaluator", "reflection"}

PLANNER_KEYS = {"thought", "actions", "providers", "text", "simple"}
REPLY_KEYS = {"thought", "text"}
REPLY_KEYS_SLIM = {"text"}
SHOULD_RESPOND_REQUIRED = {
    "name",
    "reasoning",
    "action",
    "primaryContext",
    "secondaryContexts",
    "evidenceTurnIds",
}
SHOULD_RESPOND_OPTIONAL = {"speak_up", "hold_back"}
SHOULD_RESPOND_ACTIONS = {"RESPOND", "IGNORE", "STOP"}

# Modern (preferred) tool-call carrier inside planner.params.
ACCEPTED_PLANNER_PARAM_KEYS = {"workflow", "tool", "arguments", "command", "cwd",
                                "explanation", "params"}


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _is_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _is_list_or_csv_str(v: Any) -> bool:
    return isinstance(v, list) or isinstance(v, str)


def _action_is_valid(entry: Any) -> tuple[bool, str]:
    """Validate a single planner `actions[]` entry.

    Returns (ok, reason).
    """
    if isinstance(entry, str):
        return (entry.strip() != "", "" if entry.strip() else "empty_action_string")
    if not isinstance(entry, dict):
        return (False, f"action_not_string_or_dict({type(entry).__name__})")
    extra = set(entry.keys()) - {"name", "params"}
    if extra:
        return (False, f"action_extra_keys({sorted(extra)[0]})")
    name = entry.get("name")
    if not isinstance(name, str) or not name.strip():
        return (False, "action_missing_name")
    if name != name.upper():
        # Lowercase action names are common in the corpus (e.g. tool names like
        # `get_weather`). Runtime aliases handle this but it's flagged.
        return (False, "action_name_lowercase")
    return (True, "")


def validate_planner(decoded: Any) -> list[str]:
    """Validate a planner-envelope record. Returns a list of mismatch reasons.

    Empty list means fully conformant. We accept the legacy `{tool_calls: [...]}`
    shape with a separate reason code so we can split the audit between
    "structurally tool-call-like" and "true planner envelope".
    """
    reasons: list[str] = []
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]

    keys = set(decoded.keys())

    # Legacy tool_calls envelope: `{tool_calls: [{name, arguments}]}`.
    if keys == {"tool_calls"} or (keys == {"tool_calls", "thought"}):
        tc = decoded.get("tool_calls")
        if not isinstance(tc, list) or not tc:
            return ["legacy_tool_calls_empty_or_not_list"]
        for i, c in enumerate(tc):
            if not isinstance(c, dict):
                return [f"legacy_tool_calls_entry_not_dict[{i}]"]
            if not c.get("name"):
                return [f"legacy_tool_calls_missing_name[{i}]"]
        return ["legacy_tool_calls_envelope"]

    # Legacy shell_command envelope: `{command, [explanation, cwd]}`.
    if "command" in keys and keys.issubset({"command", "explanation", "cwd"}):
        if not isinstance(decoded.get("command"), str) or not decoded["command"]:
            return ["legacy_shell_missing_command"]
        return ["legacy_shell_envelope"]

    # Legacy scam-defense envelope: `{response, action, scamDefense, [reasoning]}`.
    if "scamDefense" in keys or (
        "response" in keys and "action" in keys and "scamDefense" in keys
    ):
        return ["legacy_scam_defense_envelope"]

    # Modern planner envelope.
    missing = PLANNER_KEYS - keys
    extra = keys - PLANNER_KEYS
    if missing:
        for m in sorted(missing):
            reasons.append(f"missing_{m}")
    if extra:
        # Allow common extras carried from upstream (params is occasionally
        # surfaced at top level).
        unknown_extra = sorted(e for e in extra if e not in {"params"})
        for e in unknown_extra:
            reasons.append(f"extra_top_level_key({e})")

    if "thought" in keys:
        v = decoded["thought"]
        if not isinstance(v, str):
            reasons.append(f"thought_wrong_type({type(v).__name__})")

    if "actions" in keys:
        actions = decoded["actions"]
        if isinstance(actions, str):
            # CSV form — accepted but flagged for migration.
            reasons.append("actions_is_csv_string")
        elif isinstance(actions, list):
            for i, entry in enumerate(actions):
                ok, reason = _action_is_valid(entry)
                if not ok:
                    reasons.append(f"action[{i}]:{reason}")
                    break
            if not actions:
                # Empty actions are legal per the prompt (no actions to run);
                # don't flag as mismatch.
                pass
        elif isinstance(actions, dict) and not actions:
            # Empty TOON `actions:` decodes to {}. Accept as empty list.
            pass
        else:
            reasons.append(f"actions_wrong_type({type(actions).__name__})")

    if "providers" in keys:
        providers = decoded["providers"]
        if isinstance(providers, str):
            reasons.append("providers_is_csv_string")
        elif isinstance(providers, list):
            for i, p in enumerate(providers):
                if not isinstance(p, str):
                    reasons.append(f"provider[{i}]_not_string({type(p).__name__})")
                    break
        elif isinstance(providers, dict) and not providers:
            # Empty TOON `providers:` decodes to {}. Accept.
            pass
        else:
            reasons.append(f"providers_wrong_type({type(providers).__name__})")

    if "text" in keys:
        v = decoded["text"]
        if not isinstance(v, str):
            reasons.append(f"text_wrong_type({type(v).__name__})")

    if "simple" in keys:
        v = decoded["simple"]
        if not isinstance(v, bool):
            reasons.append(f"simple_wrong_type({type(v).__name__})")

    return reasons


def validate_reply(decoded: Any) -> list[str]:
    """Validate a reply or reasoning_cot record.

    Accepts either the planner envelope (5-key) OR `{thought, text}` OR
    `{text}` slim form. Anything else is a mismatch.
    """
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    keys = set(decoded.keys())
    # Slim {text} or {thought, text} forms are the canonical reply shape.
    if keys == {"thought", "text"}:
        if not isinstance(decoded.get("thought"), str):
            return ["thought_wrong_type"]
        if not isinstance(decoded.get("text"), str):
            return ["text_wrong_type"]
        return []
    if keys == {"text"}:
        if not isinstance(decoded.get("text"), str):
            return ["text_wrong_type"]
        return []
    # Full planner envelope (5-key) is also accepted for reply.
    if keys == PLANNER_KEYS:
        return validate_planner(decoded)
    extras = sorted(keys - {"thought", "text"})
    if extras:
        return [f"reply_extra_top_level_key({extras[0]})"]
    return ["reply_unknown_shape"]


def validate_should_respond(decoded: Any) -> list[str]:
    """Validate a shouldRespond / shouldRespondWithContext record."""
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    keys = set(decoded.keys())
    missing = SHOULD_RESPOND_REQUIRED - keys
    extra = keys - SHOULD_RESPOND_REQUIRED - SHOULD_RESPOND_OPTIONAL
    reasons: list[str] = []
    for m in sorted(missing):
        reasons.append(f"missing_{m}")
    for e in sorted(extra):
        reasons.append(f"extra_top_level_key({e})")
    action = decoded.get("action")
    if action is not None:
        if not isinstance(action, str):
            reasons.append(f"action_wrong_type({type(action).__name__})")
        elif action.strip().upper() not in SHOULD_RESPOND_ACTIONS:
            reasons.append(f"action_not_in_enum({action})")
    for k in ("name", "reasoning", "primaryContext"):
        v = decoded.get(k)
        if v is not None and not isinstance(v, str):
            reasons.append(f"{k}_wrong_type({type(v).__name__})")
    for k in ("secondaryContexts", "evidenceTurnIds"):
        v = decoded.get(k)
        # Empty TOON values may decode to "" or {}; both are acceptable.
        if v is not None and not isinstance(v, (str, list, dict)):
            reasons.append(f"{k}_wrong_type({type(v).__name__})")
    return reasons


def validate_reflection(decoded: Any) -> list[str]:
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    reasons: list[str] = []
    for required in ("thought", "task_completed", "task_completion_reason"):
        if required not in decoded:
            reasons.append(f"missing_{required}")
    if "task_completed" in decoded and not isinstance(decoded["task_completed"], bool):
        reasons.append("task_completed_wrong_type")
    return reasons


# ─────────────────────────── audit driver ────────────────────────────────────

def _decode_or_none(decoder: ToonDecoder, text: str) -> tuple[Any | None, str | None]:
    try:
        return decoder.decode(text), None
    except (ValueError, RuntimeError) as e:
        return None, str(e)[:200]


def _classify(task_type: str, decoded: Any) -> list[str]:
    if task_type in SHOULD_RESPOND_TASK_TYPES:
        return validate_should_respond(decoded)
    if task_type in REFLECTION_TASK_TYPES:
        return validate_reflection(decoded)
    if task_type in REPLY_SLIM_TASK_TYPES or task_type in REPLY_OR_PLANNER_TASK_TYPES:
        return validate_reply(decoded)
    if task_type in PLANNER_TASK_TYPES:
        return validate_planner(decoded)
    # Anything else (synth task_types like `lifeops.*`, `plugin-*`, etc.) is
    # treated as planner-envelope by default.
    return validate_planner(decoded)


def iter_records(
    normalized_dir: Path, *, only: str | None, sample_per_file: int | None,
) -> Iterator[tuple[str, str, dict[str, Any]]]:
    """Yield (slug, raw_line, parsed_record) for every record under
    ``normalized_dir/*.jsonl`` (skipping ``*.errors.jsonl``)."""
    for p in sorted(normalized_dir.glob("*.jsonl")):
        if p.name.endswith(".errors.jsonl"):
            continue
        slug = p.stem
        if only and only != slug:
            continue
        with p.open() as f:
            for i, line in enumerate(f):
                if sample_per_file is not None and i >= sample_per_file:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                yield slug, line, rec


def audit(
    normalized_dir: Path, *, only: str | None, sample_per_file: int | None,
) -> dict[str, Any]:
    """Run the full audit and return a structured report."""
    decoder = ToonDecoder()

    # task_type → {"total": int, "ok": int, "reasons": Counter,
    #              "examples": {reason: [{slug, original_id, decoded_preview}]}}
    by_task: dict[str, dict[str, Any]] = collections.defaultdict(
        lambda: {
            "total": 0,
            "ok": 0,
            "decode_errors": 0,
            "reasons": collections.Counter(),
            "examples": collections.defaultdict(list),
        }
    )

    n_seen = 0
    for slug, _line, rec in iter_records(normalized_dir, only=only,
                                          sample_per_file=sample_per_file):
        n_seen += 1
        if n_seen % 50_000 == 0:
            log.info("audited %d records", n_seen)
        meta = rec.get("metadata") or {}
        task_type = str(meta.get("task_type") or "?")
        target = rec.get("expectedResponse")
        if not isinstance(target, str) or not target:
            by_task[task_type]["total"] += 1
            by_task[task_type]["reasons"]["missing_or_non_string_target"] += 1
            continue

        decoded, decode_err = _decode_or_none(decoder, target)
        bucket = by_task[task_type]
        bucket["total"] += 1
        if decode_err is not None:
            bucket["decode_errors"] += 1
            bucket["reasons"]["decode_error"] += 1
            if len(bucket["examples"]["decode_error"]) < 3:
                bucket["examples"]["decode_error"].append({
                    "slug": slug,
                    "original_id": str(meta.get("original_id", ""))[:120],
                    "preview": target[:200],
                    "error": decode_err,
                })
            continue

        reasons = _classify(task_type, decoded)
        if not reasons:
            bucket["ok"] += 1
            continue
        for r in reasons:
            bucket["reasons"][r] += 1
            if len(bucket["examples"][r]) < 3:
                bucket["examples"][r].append({
                    "slug": slug,
                    "original_id": str(meta.get("original_id", ""))[:120],
                    "preview": target[:300],
                    "decoded_keys": (
                        sorted(decoded.keys())[:10]
                        if isinstance(decoded, dict) else None
                    ),
                })

    decoder.close()

    # Build the structured report.
    report: dict[str, Any] = {
        "n_audited": n_seen,
        "by_task_type": {},
    }
    for tt, b in by_task.items():
        top_reasons = b["reasons"].most_common(8)
        report["by_task_type"][tt] = {
            "total": b["total"],
            "ok": b["ok"],
            "mismatch": b["total"] - b["ok"],
            "decode_errors": b["decode_errors"],
            "conformance_pct": (b["ok"] / b["total"] * 100.0) if b["total"] else 0.0,
            "top_reasons": [{"reason": r, "count": c} for r, c in top_reasons],
            "examples": {r: list(b["examples"][r]) for r, _ in top_reasons},
        }
    return report


def write_markdown(report: dict[str, Any], out_path: Path) -> None:
    lines: list[str] = []
    lines.append("# Pipeline-stage shape audit\n")
    lines.append(
        f"Total records audited: **{report['n_audited']:,}**\n"
    )
    lines.append("Conformance is measured against the canonical schemas in "
                 "[PIPELINE_SCHEMAS.md](./PIPELINE_SCHEMAS.md).\n")

    rows = sorted(
        report["by_task_type"].items(),
        key=lambda kv: -kv[1]["total"],
    )
    lines.append("## Summary by task_type\n")
    lines.append("| task_type | total | conformant | mismatch | decode_err | conformance% |")
    lines.append("|-----------|------:|-----------:|---------:|-----------:|-------------:|")
    for tt, b in rows:
        lines.append(
            f"| `{tt}` | {b['total']:,} | {b['ok']:,} | {b['mismatch']:,} | "
            f"{b['decode_errors']:,} | {b['conformance_pct']:.2f}% |"
        )
    lines.append("")

    for tt, b in rows:
        lines.append(f"## `{tt}` ({b['total']:,} records, "
                     f"{b['conformance_pct']:.2f}% conformant)\n")
        if not b["top_reasons"]:
            lines.append("No mismatches detected.\n")
            continue
        lines.append("Top mismatch reasons:\n")
        lines.append("| reason | count |")
        lines.append("|--------|------:|")
        for r in b["top_reasons"]:
            lines.append(f"| `{r['reason']}` | {r['count']:,} |")
        lines.append("")
        lines.append("Examples per reason (up to 3 each):\n")
        for r in b["top_reasons"]:
            reason = r["reason"]
            examples = b["examples"].get(reason, [])
            if not examples:
                continue
            lines.append(f"### `{reason}`\n")
            for ex in examples:
                lines.append(
                    f"- slug=`{ex['slug']}` id=`{ex.get('original_id','')}` "
                    f"keys=`{ex.get('decoded_keys')}`"
                )
                preview = ex["preview"].replace("\n", " ")[:240]
                lines.append(f"  - preview: `{preview}`")
            lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", default=str(ROOT / "data" / "normalized"))
    ap.add_argument("--out-md", default=str(ROOT / "previews" / "PIPELINE_AUDIT.md"))
    ap.add_argument("--out-json", default=str(ROOT / "previews" / "pipeline_audit.json"))
    ap.add_argument("--sample", type=int, default=None,
                    help="audit only the first N records per file (default: all)")
    ap.add_argument("--only", default=None,
                    help="audit only the named slug (e.g. agent-trove)")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    data_dir = Path(args.data_dir).resolve()
    out_md = Path(args.out_md).resolve()
    out_json = Path(args.out_json).resolve()
    out_md.parent.mkdir(parents=True, exist_ok=True)

    report = audit(data_dir, only=args.only, sample_per_file=args.sample)

    out_json.write_text(json.dumps(report, indent=2, ensure_ascii=False),
                        encoding="utf-8")
    write_markdown(report, out_md)
    log.info("wrote %s and %s", out_md, out_json)


if __name__ == "__main__":
    main()
