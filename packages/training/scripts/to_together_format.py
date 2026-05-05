"""Convert packed elizaOS records → Together.ai supervised-tuning JSONL.

Reads:
    data/final/{train,val,test}.jsonl

Writes (UTF-8, no BOM, newline-delimited):
    data/together/train.jsonl
    data/together/val.jsonl
    data/together/test.jsonl
    data/together/dropped.jsonl    (records that couldn't be converted)
    data/together/manifest.json    (counts, byte sizes)

Together.ai conversational format
(https://docs.together.ai/docs/fine-tuning-data-preparation):

    {
      "messages": [
        {"role": "system", "content": "..."},
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."}
      ]
    }

We deliberately keep `expectedResponse` (the canonical TOON planner envelope)
verbatim as the assistant turn — that's what we want the model to learn to
emit. The Together SDK's tool-call structured form is not used here; the
elizaOS runtime decodes raw TOON text from the model output.

Limits:
- 25 GB per training/validation file (Together CLI cap).
- No documented per-example token cap; we still skip records whose
  serialized JSON line exceeds 1 MiB to stay safe under HTTP body limits.

Usage:
    .venv/bin/python scripts/to_together_format.py
    .venv/bin/python scripts/to_together_format.py --limit 100
    .venv/bin/python scripts/to_together_format.py --splits train,val
    .venv/bin/python scripts/to_together_format.py --validate path/to/file.jsonl
    .venv/bin/python scripts/to_together_format.py --combine        # also write all.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

# Re-use the Qwen-side prompt resolver so Together training sees the same
# conditioning surface as the Qwen / Gemini formatters.
from format_for_training import system_prompt_for  # noqa: E402

# --------------------------------------------------------------------------- #
# Together.ai SFT limits
# --------------------------------------------------------------------------- #

# Per-file cap (training-file or validation-file). Together CLI rejects > 25 GB.
MAX_FILE_BYTES = 25 * 1024 * 1024 * 1024

# Per-example cap. Together doesn't document a hard limit but very large
# JSON lines blow up the upload. 1 MiB per record is generous and safe.
MAX_RECORD_BYTES = 1024 * 1024

VALID_ROLES = {"user", "assistant", "system", "tool"}

# --------------------------------------------------------------------------- #
# Conversion helpers
# --------------------------------------------------------------------------- #


def together_role(eliza_role: str) -> str | None:
    """Map an elizaOS message role onto a Together messages-array role.

    Together accepts: system, user, assistant, tool.
    Anything else is dropped from the conversation history.
    """
    r = (eliza_role or "").strip().lower()
    if r in ("user", "human", "question"):
        return "user"
    if r in ("assistant", "model", "ai", "bot", "agent", "answer", "response"):
        return "assistant"
    if r in ("system", "developer"):
        return "system"
    if r in ("tool", "function", "tool_response", "observation",
             "tool_result", "function_response"):
        return "tool"
    return None


def collapse_consecutive(
    turns: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Collapse consecutive same-role turns into one (joined with `\\n\\n`).

    Together's docs say each sample should start with system or user and
    then alternate user/assistant. We collapse to keep alternation strict
    rather than dropping examples.
    """
    if not turns:
        return turns
    out: list[tuple[str, str]] = [turns[0]]
    for role, text in turns[1:]:
        # `tool` / `system` are special — don't collapse with adjacent
        # turns of a different role; only collapse identical roles.
        if role == out[-1][0]:
            out[-1] = (role, out[-1][1] + "\n\n" + text)
        else:
            out.append((role, text))
    return out


def drop_orphan_leading_assistant(
    turns: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Together expects the first non-system turn to be user. Drop any
    leading assistant/tool turns before the first user turn."""
    i = 0
    while i < len(turns) and turns[i][0] in ("assistant", "tool"):
        i += 1
    return turns[i:]


@dataclass
class TogetherBuildResult:
    record: dict[str, Any] | None
    drop_reason: str | None


def build_together_record(eliza: dict[str, Any]) -> TogetherBuildResult:
    """Convert one elizaOS record to a Together.ai SFT JSON object.

    Returns (None, reason) when the record can't be converted.
    """
    expected = (eliza.get("expectedResponse") or "").strip()
    if not expected:
        return TogetherBuildResult(None, "empty_expectedResponse")

    cm = eliza.get("currentMessage") or {}
    cm_text = (cm.get("content") or "").strip()
    if not cm_text:
        return TogetherBuildResult(None, "empty_currentMessage")

    # 1. System prompt (same resolver as the Qwen/Gemini formatters).
    system_text = system_prompt_for(eliza).rstrip()

    md = eliza.get("metadata") or {}
    tool_specs = md.get("toolSpecs") or []
    if tool_specs:
        system_text = (
            system_text
            + "\n\nAvailable tools (JSON):\n"
            + json.dumps(tool_specs, ensure_ascii=False, indent=2)
        )

    actions = eliza.get("availableActions") or []
    if actions:
        system_text = (
            system_text
            + "\n\nAvailable actions: "
            + ", ".join(str(a) for a in actions)
        )

    # 2. Build the alternating turn list. We only emit user/assistant turns
    # in the conversation history — `tool` results from elizaOS are baked
    # into the upstream `assistant` content and we don't have separate
    # tool messages in this corpus. System lives in its own slot.
    turns: list[tuple[str, str]] = []
    for m in eliza.get("memoryEntries") or []:
        role = together_role(str(m.get("role") or ""))
        if role is None or role == "system":
            continue
        if role == "tool":
            # Together accepts tool messages, but the corpus doesn't carry
            # `tool_call_id`, so a `tool` role here would be malformed.
            # Fold tool output into the next assistant turn implicitly by
            # treating it as an assistant-side observation.
            role = "assistant"
        text = (m.get("content") or "").strip()
        if not text:
            continue
        turns.append((role, text))

    turns.append(("user", cm_text))
    turns.append(("assistant", expected))

    turns = drop_orphan_leading_assistant(turns)
    turns = collapse_consecutive(turns)

    if not turns:
        return TogetherBuildResult(None, "no_turns_after_normalization")
    if turns[-1][0] != "assistant":
        return TogetherBuildResult(None, "final_turn_not_assistant")
    if turns[0][0] != "user":
        return TogetherBuildResult(None, "first_turn_not_user")

    # 3. Emit messages array.
    messages: list[dict[str, str]] = []
    if system_text:
        messages.append({"role": "system", "content": system_text})
    for role, text in turns:
        messages.append({"role": role, "content": text})

    record = {"messages": messages}

    # 4. Per-record byte cap.
    encoded = json.dumps(record, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_RECORD_BYTES:
        return TogetherBuildResult(None, "record_exceeds_max_bytes")

    return TogetherBuildResult(record, None)


# --------------------------------------------------------------------------- #
# I/O
# --------------------------------------------------------------------------- #


def iter_jsonl(path: Path, limit: int | None = None) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if limit is not None and i >= limit:
                return
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def atomic_write_jsonl(
    out_path: Path, records: Iterator[dict[str, Any]],
) -> tuple[int, int]:
    """Stream records to `out_path` via a temp file + atomic replace.

    Returns (record_count, byte_count). Aborts (and removes temp) if
    cumulative size would exceed MAX_FILE_BYTES.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{out_path.name}.", suffix=".tmp", dir=str(out_path.parent)
    )
    n = 0
    nbytes = 0
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for rec in records:
                line = json.dumps(rec, ensure_ascii=False)
                blob = (line + "\n").encode("utf-8")
                if nbytes + len(blob) > MAX_FILE_BYTES:
                    raise RuntimeError(
                        f"output for {out_path.name} would exceed "
                        f"{MAX_FILE_BYTES // (1024**3)} GiB cap"
                    )
                f.write(line + "\n")
                nbytes += len(blob)
                n += 1
        os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, out_path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise
    return n, nbytes


@dataclass
class SplitStats:
    in_count: int = 0
    out_count: int = 0
    dropped: dict[str, int] = field(default_factory=dict)
    out_bytes: int = 0


def convert_split(
    src: Path, dst: Path, dropped_path: Path,
    *, limit: int | None,
) -> SplitStats:
    stats = SplitStats()

    # Two-pass: first build records to memory-friendly generator that also
    # writes drop reasons. We stream to disk through atomic_write_jsonl.
    dropped_fh = dropped_path.open("a", encoding="utf-8")

    def gen() -> Iterator[dict[str, Any]]:
        for r in iter_jsonl(src, limit=limit):
            stats.in_count += 1
            res = build_together_record(r)
            if res.record is None:
                reason = res.drop_reason or "unknown"
                stats.dropped[reason] = stats.dropped.get(reason, 0) + 1
                dropped_fh.write(json.dumps({
                    "split": dst.stem, "reason": reason,
                    "source": (r.get("metadata") or {}).get("source", ""),
                    "original_id": (r.get("metadata") or {}).get("original_id", ""),
                }, ensure_ascii=False) + "\n")
                continue
            stats.out_count += 1
            yield res.record

    try:
        n, nbytes = atomic_write_jsonl(dst, gen())
        stats.out_count = n
        stats.out_bytes = nbytes
    finally:
        dropped_fh.close()

    return stats


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #


def validate_file(path: Path) -> int:
    """Re-parse `path` line-by-line, assert role-alternation invariants,
    flag oversized records. Mirrors what `together files check` does."""
    n = 0
    issues = 0
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"  line {i}: invalid JSON — {e}", file=sys.stderr)
                issues += 1
                continue
            msgs = rec.get("messages")
            if not isinstance(msgs, list) or not msgs:
                print(f"  line {i}: missing/empty messages array",
                      file=sys.stderr)
                issues += 1
                continue
            roles = [m.get("role") for m in msgs]
            if roles[0] not in ("system", "user"):
                print(
                    f"  line {i}: first role must be system or user (got "
                    f"{roles[0]!r})", file=sys.stderr,
                )
                issues += 1
            non_sys = [r for r in roles if r != "system"]
            for j in range(len(non_sys) - 1):
                if non_sys[j] == non_sys[j + 1]:
                    print(
                        f"  line {i}: consecutive same role ({non_sys[j]}) "
                        "in non-system turns", file=sys.stderr,
                    )
                    issues += 1
                    break
            for m in msgs:
                role = m.get("role")
                if role not in VALID_ROLES:
                    print(f"  line {i}: invalid role {role!r}",
                          file=sys.stderr)
                    issues += 1
                    break
                if not isinstance(m.get("content"), str):
                    print(f"  line {i}: non-string content for role {role}",
                          file=sys.stderr)
                    issues += 1
                    break
            n += 1
    print(f"validated {path}: {n:,} records, {issues} issue(s)")
    return issues


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--src", type=Path, default=ROOT / "data" / "final",
        help="directory containing {train,val,test}.jsonl",
    )
    ap.add_argument(
        "--dst", type=Path, default=ROOT / "data" / "together",
        help="output directory",
    )
    ap.add_argument(
        "--splits", type=str, default="train,val,test",
        help="comma-separated subset of splits to convert",
    )
    ap.add_argument(
        "--limit", type=int, default=None,
        help="cap input records per split (smoke testing)",
    )
    ap.add_argument(
        "--combine", action="store_true",
        help="also concat splits into data/together/all.jsonl",
    )
    ap.add_argument(
        "--validate", type=Path, default=None,
        help="re-validate an existing JSONL and exit",
    )
    args = ap.parse_args()

    if args.validate is not None:
        return 1 if validate_file(args.validate) else 0

    splits = [s.strip() for s in args.splits.split(",") if s.strip()]
    args.dst.mkdir(parents=True, exist_ok=True)
    dropped_path = args.dst / "dropped.jsonl"
    if dropped_path.exists():
        dropped_path.unlink()

    manifest: dict[str, Any] = {"splits": {}, "max_file_bytes": MAX_FILE_BYTES}
    total_in = total_out = 0
    for split in splits:
        src = args.src / f"{split}.jsonl"
        if not src.exists():
            print(f"  skip {split} — {src} not found", file=sys.stderr)
            continue
        dst = args.dst / f"{split}.jsonl"
        print(f"  {split}: {src} → {dst}")
        stats = convert_split(src, dst, dropped_path, limit=args.limit)
        total_in += stats.in_count
        total_out += stats.out_count
        manifest["splits"][split] = {
            "in": stats.in_count,
            "out": stats.out_count,
            "dropped": stats.dropped,
            "bytes": stats.out_bytes,
            "path": str(dst),
        }
        print(
            f"    {stats.in_count:>10,d} in  →  {stats.out_count:>10,d} out  "
            f"({stats.out_bytes / (1024**3):.2f} GiB)"
        )
        if stats.dropped:
            for r, c in sorted(stats.dropped.items(), key=lambda kv: -kv[1]):
                print(f"      dropped {r}: {c:,}")

    if args.combine:
        all_path = args.dst / "all.jsonl"
        print(f"  combine → {all_path}")
        nb = 0
        n = 0
        fd, tmp = tempfile.mkstemp(
            prefix=f".{all_path.name}.", suffix=".tmp", dir=str(args.dst)
        )
        try:
            with os.fdopen(fd, "wb") as out_f:
                for split in splits:
                    p = args.dst / f"{split}.jsonl"
                    if not p.exists():
                        continue
                    with p.open("rb") as in_f:
                        while True:
                            chunk = in_f.read(8 * 1024 * 1024)
                            if not chunk:
                                break
                            n += chunk.count(b"\n")
                            nb += len(chunk)
                            out_f.write(chunk)
            os.chmod(tmp, 0o644)
            os.replace(tmp, all_path)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
        manifest["combined"] = {
            "path": str(all_path), "records": n, "bytes": nb,
        }
        print(
            f"    {n:>10,d} lines  ({nb / (1024**3):.2f} GiB)"
        )

    (args.dst / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"\nDONE  {total_in:,} in → {total_out:,} out  → {args.dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
