"""Streaming corpus cleanup for training data.

Applies five cross-cutting transforms identified in PER_SOURCE_TOON_AUDIT.md:

  1. Strip wrapper tokens / tags (<|endoftext|>, <answer>...</answer>,
     <think>...</think>, and <tool_call>...</tool_call> when it appears
     INSIDE a TOON `text` field that already has structured siblings).
  2. Drop redundant raw <tool_call> XML in text when actions/tool_calls are
     already structured at the top level.
  3. Relocate buried system prompts (carnice-glm5-hermes, phi3-mcp, hermes-3)
     from currentMessage.content to metadata.system_prompt (and, for
     hermes-3, the BEGINCONTEXT body to memoryEntries[0]).
  4. Relocate tool results in currentMessage.content (response:,
     FUNCTION RESPONSE:, ### Ran Playwright code, <tool_response>) into
     memoryEntries with role: "tool", and promote the prior user turn to
     currentMessage.
  5. light-multilight persona lift: extract persona+setting from a
     stage-direction thought and lift it to metadata.system_prompt; reset
     the thought so the trivial-thought re-synth pass picks it up.

Round-trip safety: every modification to expectedResponse decodes the
result with ToonDecoder before commit. Failures are reverted and counted.

Inputs:  data/final/train.jsonl
Outputs: data/final/train_cleaned.jsonl
         data/final/manifest_cleaned.json
"""

from __future__ import annotations

import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.lib.toon import ToonDecoder, ToonEncoder  # noqa: E402

INPUT_PATH = ROOT / "data" / "final" / "train.jsonl"
OUTPUT_PATH = ROOT / "data" / "final" / "train_cleaned.jsonl"
MANIFEST_PATH = ROOT / "data" / "final" / "manifest_cleaned.json"


# ---------------------------------------------------------------------------
# Transform 1 + 2: wrapper-token stripping and redundant tool_call removal
# ---------------------------------------------------------------------------

ENDOFTEXT_RE = re.compile(r"\s*<\|endoftext\|>\s*$")
ANSWER_TAG_RE = re.compile(r"</?answer>", re.IGNORECASE)
THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
TOOL_CALL_BLOCK_RE = re.compile(r"<tool_call>.*?</tool_call>", re.DOTALL)


def _strip_wrappers(s: str) -> tuple[str, bool]:
    """Strip endoftext/answer/think wrappers. Returns (new, changed)."""
    if not isinstance(s, str) or not s:
        return s, False
    original = s
    # endoftext: trailing literal token (also strip mid-string occurrences
    # since glaive sometimes embeds it inside multi-line text)
    s = s.replace("<|endoftext|>", "")
    s = s.rstrip()
    # <answer>...</answer>: keep contents, strip tags
    s = ANSWER_TAG_RE.sub("", s)
    # <think>...</think>: strip block entirely (Hermes leak in user-facing text)
    s = THINK_BLOCK_RE.sub("", s)
    return s, s != original


def _walk_strip_wrappers(obj: Any) -> tuple[Any, bool]:
    """Walk a decoded TOON object, stripping wrappers from every string value.

    Returns (new_obj, any_changed).
    """
    changed = False
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str):
                new_v, c = _strip_wrappers(v)
                if c:
                    obj[k] = new_v
                    changed = True
            elif isinstance(v, (dict, list)):
                _, c = _walk_strip_wrappers(v)
                if c:
                    changed = True
        return obj, changed
    if isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                new_v, c = _strip_wrappers(v)
                if c:
                    obj[i] = new_v
                    changed = True
            elif isinstance(v, (dict, list)):
                _, c = _walk_strip_wrappers(v)
                if c:
                    changed = True
        return obj, changed
    return obj, False


def _drop_redundant_tool_call_text(obj: Any) -> bool:
    """If top-level dict has structured actions/tool_calls AND its top-level
    `text` (or any nested provider entry's `text`) contains a <tool_call>
    block, blank that text. Returns True if modified.
    """
    if not isinstance(obj, dict):
        return False
    has_structured = False
    actions = obj.get("actions")
    if isinstance(actions, list) and any(isinstance(a, (dict, str)) for a in actions):
        # Filter out the trivial case where actions is just ["REPLY"] — that's
        # a reply-only marker, not a tool call. We still want to scrub text
        # there, but the heuristic for THIS transform is "tool call duplicated
        # as XML" so we only treat structured action entries (dicts) as
        # triggering.
        if any(isinstance(a, dict) for a in actions):
            has_structured = True
    tool_calls = obj.get("tool_calls")
    if isinstance(tool_calls, list) and any(isinstance(tc, dict) for tc in tool_calls):
        has_structured = True
    if not has_structured:
        return False

    changed = False
    text_v = obj.get("text")
    if isinstance(text_v, str) and "<tool_call>" in text_v:
        obj["text"] = ""
        changed = True
    # Also scan providers[].text in case a future shape nests it.
    providers = obj.get("providers")
    if isinstance(providers, list):
        for p in providers:
            if isinstance(p, dict) and isinstance(p.get("text"), str) and "<tool_call>" in p["text"]:
                p["text"] = ""
                changed = True
    return changed


def transform_clean_expected_response(
    rec: dict[str, Any],
    encoder: ToonEncoder,
    decoder: ToonDecoder,
    stats: dict[str, Any],
) -> dict[str, Any]:
    """Apply transforms 1 and 2 to rec['expectedResponse'].

    Skip the decode/encode round-trip when no wrapper patterns are present.
    On any encode/decode failure, revert and bump decode_revert.
    """
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec

    # Cheap pre-check: if no wrapper substrings appear, skip TOON round-trip.
    has_wrapper = (
        "<|endoftext|>" in er
        or "<answer>" in er
        or "</answer>" in er
        or "<think>" in er
        or "<tool_call>" in er
    )
    if not has_wrapper:
        return rec

    try:
        decoded = decoder.decode(er)
    except Exception:
        stats["decode_revert"] += 1
        stats["decode_revert_reasons"]["initial_decode_failed"] += 1
        return rec

    # Transform 2 first (so transform 1 isn't asked to scrub a now-blanked
    # text field) — though they don't actually conflict.
    redundant_dropped = _drop_redundant_tool_call_text(decoded)
    _, wrappers_changed = _walk_strip_wrappers(decoded)

    if not (redundant_dropped or wrappers_changed):
        return rec

    try:
        new_er = encoder.encode(decoded)
        # Verify round-trip: decoder must accept the new text.
        decoder.decode(new_er)
    except Exception:
        stats["decode_revert"] += 1
        stats["decode_revert_reasons"]["roundtrip_failed"] += 1
        return rec

    rec["expectedResponse"] = new_er
    if wrappers_changed:
        stats["wrapper_tokens_stripped"] += 1
    if redundant_dropped:
        stats["redundant_xml_dropped"] += 1
    return rec


# ---------------------------------------------------------------------------
# Transform 3: relocate buried system prompts
# ---------------------------------------------------------------------------

CARNICE_HEADER_PREFIX = (
    "You are operating inside an isolated disposable workspace that is "
    "already set as the current working directory."
)
PHI3_HEADER_PREFIX = (
    "Analyze the user input and determine if a tool call is needed."
)


def _ensure_metadata(rec: dict[str, Any]) -> dict[str, Any]:
    md = rec.get("metadata")
    if not isinstance(md, dict):
        md = {}
        rec["metadata"] = md
    return md


def transform_relocate_system_prompts(
    rec: dict[str, Any], src: str, stats: dict[str, Any]
) -> dict[str, Any]:
    cm = rec.get("currentMessage")
    if not isinstance(cm, dict):
        return rec
    content = cm.get("content")
    if not isinstance(content, str) or not content:
        return rec

    if src == "carnice-glm5-hermes" and content.startswith(CARNICE_HEADER_PREFIX):
        # Split on "Task:" — the system rules end at the blank line before
        # "Task:" (or "\nTask:" boundary).
        idx = content.find("\nTask:")
        if idx == -1:
            idx = content.find("Task:")
        if idx > 0:
            header = content[:idx].rstrip()
            body = content[idx:].lstrip()
            md = _ensure_metadata(rec)
            md["system_prompt"] = header
            cm["content"] = body
            stats["system_prompt_relocated"] += 1
            stats["system_prompt_relocated_by_source"][src] += 1
            return rec

    if src == "phi3-mcp" and content.startswith(PHI3_HEADER_PREFIX):
        # The boilerplate ends at the blank line separating it from the user
        # request.
        split_idx = content.find("\n\n")
        if split_idx > 0:
            header = content[:split_idx].rstrip()
            body = content[split_idx + 2 :].lstrip()
            if body:
                md = _ensure_metadata(rec)
                md["system_prompt"] = header
                cm["content"] = body
                stats["system_prompt_relocated"] += 1
                stats["system_prompt_relocated_by_source"][src] += 1
                return rec

    if src == "hermes-3" and content.startswith("BEGININPUT"):
        # Parse BEGININPUT / BEGINCONTEXT / ENDCONTEXT / [body] / ENDINPUT /
        # BEGININSTRUCTION / [instruction] / ENDINSTRUCTION
        ctx_match = re.search(
            r"BEGINCONTEXT\s*(.*?)\s*ENDCONTEXT\s*(.*?)\s*ENDINPUT",
            content,
            flags=re.DOTALL,
        )
        instr_match = re.search(
            r"BEGININSTRUCTION\s*(.*?)\s*(?:ENDINSTRUCTION|$)",
            content,
            flags=re.DOTALL,
        )
        if instr_match:
            instruction = instr_match.group(1).strip()
            context_text = ""
            if ctx_match:
                meta_lines = ctx_match.group(1).strip()
                ctx_body = ctx_match.group(2).strip()
                if meta_lines and ctx_body:
                    context_text = f"{meta_lines}\n\n{ctx_body}"
                else:
                    context_text = meta_lines or ctx_body
            if instruction:
                cm["content"] = instruction
                if context_text:
                    mems = rec.get("memoryEntries")
                    if not isinstance(mems, list):
                        mems = []
                        rec["memoryEntries"] = mems
                    mems.insert(
                        0,
                        {
                            "role": "system",
                            "speaker": "context",
                            "content": context_text,
                            "channel": cm.get("channel", "default"),
                        },
                    )
                stats["system_prompt_relocated"] += 1
                stats["system_prompt_relocated_by_source"][src] += 1
                return rec

    return rec


# ---------------------------------------------------------------------------
# Transform 4: relocate tool results
# ---------------------------------------------------------------------------

TOOL_RESULT_PREFIXES = (
    "response:",
    "FUNCTION RESPONSE:",
    "### Ran Playwright code",
    "<tool_response>",
)


def _looks_like_tool_result(content: str) -> bool:
    if not isinstance(content, str) or not content:
        return False
    return content.startswith(TOOL_RESULT_PREFIXES)


def transform_relocate_tool_results(
    rec: dict[str, Any], src: str, stats: dict[str, Any]
) -> dict[str, Any]:
    cm = rec.get("currentMessage")
    if not isinstance(cm, dict):
        return rec
    content = cm.get("content")
    if not _looks_like_tool_result(content):
        return rec

    mems = rec.get("memoryEntries")
    if not isinstance(mems, list):
        mems = []
        rec["memoryEntries"] = mems

    # Find the most recent prior user turn in memoryEntries.
    user_idx = None
    for i in range(len(mems) - 1, -1, -1):
        m = mems[i]
        if isinstance(m, dict) and m.get("role") == "user":
            user_idx = i
            break

    if user_idx is None:
        md = _ensure_metadata(rec)
        md["_needs_human_review"] = True
        stats["tool_result_relocation_skipped"] += 1
        stats["tool_result_relocation_skipped_by_source"][src] += 1
        return rec

    # 1. Push current message to end of memoryEntries as a tool turn.
    tool_turn = {
        "role": "tool",
        "speaker": cm.get("speaker", "tool"),
        "content": content,
        "channel": cm.get("channel", "default"),
    }
    mems.append(tool_turn)

    # 2. Promote the most recent prior user turn to currentMessage and
    # remove it from memoryEntries (so the conversation flow stays
    # consistent).
    user_turn = mems.pop(user_idx)
    rec["currentMessage"] = {
        "role": "user",
        "speaker": user_turn.get("speaker", "user"),
        "content": user_turn.get("content", ""),
        "channel": user_turn.get("channel", cm.get("channel", "default")),
    }

    stats["tool_result_relocated"] += 1
    stats["tool_result_relocated_by_source"][src] += 1
    return rec


# ---------------------------------------------------------------------------
# Transform 5: light-multilight persona lift
# ---------------------------------------------------------------------------

MULTILIGHT_THOUGHT_RE = re.compile(
    r"^As\s+(.+?),\s+I\s+respond\s+to\s+(.+?)\s+in\s+(.+?)\.\s*$"
)


def transform_multilight_lift(
    rec: dict[str, Any],
    encoder: ToonEncoder,
    decoder: ToonDecoder,
    stats: dict[str, Any],
) -> dict[str, Any]:
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    if "thought:" not in er or "As " not in er:
        return rec

    try:
        decoded = decoder.decode(er)
    except Exception:
        stats["decode_revert"] += 1
        stats["decode_revert_reasons"]["multilight_decode_failed"] += 1
        return rec

    if not isinstance(decoded, dict):
        return rec
    thought = decoded.get("thought")
    if not isinstance(thought, str):
        return rec
    m = MULTILIGHT_THOUGHT_RE.match(thought.strip())
    if not m:
        return rec

    role, other, location = (g.strip() for g in m.groups())
    md = _ensure_metadata(rec)
    md["system_prompt"] = (
        f"You are {role} in conversation with {other} in {location}."
    )
    decoded["thought"] = "Let me think before I respond."

    try:
        new_er = encoder.encode(decoded)
        decoder.decode(new_er)
    except Exception:
        stats["decode_revert"] += 1
        stats["decode_revert_reasons"]["multilight_roundtrip_failed"] += 1
        return rec

    rec["expectedResponse"] = new_er
    stats["multilight_lifted"] += 1
    return rec


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def clean_record(
    rec: dict[str, Any],
    encoder: ToonEncoder,
    decoder: ToonDecoder,
    stats: dict[str, Any],
) -> dict[str, Any]:
    src = ""
    md = rec.get("metadata")
    if isinstance(md, dict):
        src = str(md.get("source_dataset", "") or "")

    rec = transform_relocate_system_prompts(rec, src, stats)
    rec = transform_relocate_tool_results(rec, src, stats)
    if src == "light-multilight":
        rec = transform_multilight_lift(rec, encoder, decoder, stats)
    rec = transform_clean_expected_response(rec, encoder, decoder, stats)
    return rec


def main() -> int:
    if not INPUT_PATH.exists():
        raise SystemExit(f"missing input: {INPUT_PATH}")

    stats: dict[str, Any] = {
        "records_total": 0,
        "wrapper_tokens_stripped": 0,
        "redundant_xml_dropped": 0,
        "system_prompt_relocated": 0,
        "system_prompt_relocated_by_source": defaultdict(int),
        "tool_result_relocated": 0,
        "tool_result_relocated_by_source": defaultdict(int),
        "tool_result_relocation_skipped": 0,
        "tool_result_relocation_skipped_by_source": defaultdict(int),
        "multilight_lifted": 0,
        "decode_revert": 0,
        "decode_revert_reasons": defaultdict(int),
    }

    start = time.time()
    progress_every = 20_000

    encoder = ToonEncoder()
    decoder = ToonDecoder()
    try:
        with INPUT_PATH.open("r", encoding="utf-8") as fin, OUTPUT_PATH.open(
            "w", encoding="utf-8"
        ) as fout:
            for i, line in enumerate(fin, start=1):
                line = line.rstrip("\n")
                if not line:
                    continue
                rec = json.loads(line)
                rec = clean_record(rec, encoder, decoder, stats)
                fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                stats["records_total"] += 1
                if i % progress_every == 0:
                    elapsed = time.time() - start
                    rate = i / elapsed if elapsed else 0
                    eta_s = (1_500_000 - i) / rate if rate else 0
                    print(
                        f"[{i:>8}/{1_500_000}] {rate:>5.0f} rec/s "
                        f"eta={eta_s/60:.1f}min wrappers={stats['wrapper_tokens_stripped']} "
                        f"xml={stats['redundant_xml_dropped']} sysp={stats['system_prompt_relocated']} "
                        f"tool={stats['tool_result_relocated']} ml={stats['multilight_lifted']} "
                        f"revert={stats['decode_revert']}",
                        flush=True,
                    )
    finally:
        encoder.close()
        decoder.close()

    elapsed = time.time() - start
    stats["wall_clock_seconds"] = round(elapsed, 2)
    stats["wall_clock_minutes"] = round(elapsed / 60, 2)

    # Convert defaultdicts to regular dicts for JSON.
    def _flatten(o: Any) -> Any:
        if isinstance(o, defaultdict):
            return {k: _flatten(v) for k, v in o.items()}
        if isinstance(o, dict):
            return {k: _flatten(v) for k, v in o.items()}
        return o

    flat_stats = _flatten(stats)
    MANIFEST_PATH.write_text(json.dumps(flat_stats, indent=2) + "\n")

    print()
    print(json.dumps(flat_stats, indent=2))
    print(f"\nWrote {OUTPUT_PATH}")
    print(f"Manifest: {MANIFEST_PATH}")
    print(f"Wall clock: {elapsed/60:.2f} min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
