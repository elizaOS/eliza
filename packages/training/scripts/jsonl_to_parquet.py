"""Convert packed final/{train,val,test}.jsonl to HuggingFace-ready parquet.

The packed corpus at ``data/final/<split>.jsonl`` is the canonical flat
``ElizaRecord`` shape (see ``training/SCHEMA.md``). HuggingFace prefers
parquet for large datasets, so this script streams each split into chunked
``data/final/parquet/<split>/<NNN>-<chunk>.parquet`` files, ~1 GiB each.

The output schema is deliberately simpler than the raw JSON:

* Top-level ``roomName`` / ``agentId`` / ``expectedResponse`` stay as strings.
* ``availableActions`` is ``list<string>``.
* ``memoryEntries`` is ``list<struct<role,speaker,content,channel>>``.
* ``currentMessage`` is ``struct<role,speaker,content,channel>``.
* ``metadata`` is **flattened**: the required canonical keys
  (``task_type``, ``source_dataset``, ``license``, ``split``,
  ``system_prompt``) become typed top-level columns, and any remaining
  source-specific extras (``toolSpecs``, ``expected_tool_calls``,
  ``response_shape``, ``node_count``, ``thinking``, ...) are JSON-encoded
  into a single ``metadata_extra`` string column.

Why flatten? The raw ``metadata`` dict is heterogeneous — ``node_count``
is sometimes ``int`` and sometimes ``str`` across sources, and parquet
demands a single type per column. Stringifying the long tail under a
typed ``metadata_extra`` column keeps the schema portable while leaving
all the original information addressable via ``json.loads(row[
"metadata_extra"])``.

Idempotent: re-running with an existing output dir wipes and re-writes.
The script does NOT mutate ``data/final/*.jsonl``.

Usage::

    uv run python scripts/jsonl_to_parquet.py                # convert all 3 splits
    uv run python scripts/jsonl_to_parquet.py --split train  # one split only
    uv run python scripts/jsonl_to_parquet.py --target-mib 512  # smaller chunks
    uv run python scripts/jsonl_to_parquet.py --dry-run      # report only
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from pathlib import Path
from typing import Any, Iterator

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
FINAL = ROOT / "data" / "final"
PARQUET_OUT = FINAL / "parquet"

# Splits we publish. Note: HF dataset configs accept any name, but using
# the canonical ``train`` / ``validation`` / ``test`` names lets
# ``datasets.load_dataset(...)`` auto-resolve them.
SPLITS = {
    "train": "train.jsonl",
    "validation": "val.jsonl",
    "test": "test.jsonl",
}

# Required canonical metadata keys flattened to top-level columns.
META_REQUIRED = ("task_type", "source_dataset", "license", "split")
# Optional but commonly present, also flattened.
META_FLATTENED = ("system_prompt",)
# Everything else in ``metadata`` rides under this stringified column.
META_EXTRA_KEY = "metadata_extra"

# Memory / current-message struct fields. Every record we sampled has all
# four; we still default-fill missing fields to "" so the struct stays
# schema-uniform.
TURN_FIELDS = ("role", "speaker", "content", "channel")

# Default chunk size targets ~1 GiB on disk (post-zstd compression a
# JSONL → parquet ratio of ~3-5x is typical for this corpus).
DEFAULT_TARGET_MIB = 1024
DEFAULT_BATCH_ROWS = 4096

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("jsonl_to_parquet")


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

TURN_STRUCT = pa.struct([
    pa.field("role", pa.string(), nullable=False),
    pa.field("speaker", pa.string(), nullable=False),
    pa.field("content", pa.string(), nullable=False),
    pa.field("channel", pa.string(), nullable=False),
])


def output_schema() -> pa.Schema:
    return pa.schema([
        pa.field("roomName", pa.string(), nullable=False),
        pa.field("agentId", pa.string(), nullable=False),
        pa.field("memoryEntries", pa.list_(TURN_STRUCT), nullable=False),
        pa.field("currentMessage", TURN_STRUCT, nullable=False),
        pa.field("expectedResponse", pa.string(), nullable=False),
        pa.field("availableActions", pa.list_(pa.string()), nullable=False),
        pa.field("task_type", pa.string(), nullable=False),
        pa.field("source_dataset", pa.string(), nullable=False),
        pa.field("license", pa.string(), nullable=False),
        pa.field("split", pa.string(), nullable=False),
        pa.field("system_prompt", pa.string(), nullable=True),
        pa.field("metadata_extra", pa.string(), nullable=False),
    ])


# ---------------------------------------------------------------------------
# Record normalization
# ---------------------------------------------------------------------------

def _coerce_turn(turn: Any) -> dict[str, str]:
    """Force a memory/current-message turn into the canonical struct."""
    if not isinstance(turn, dict):
        return {f: "" for f in TURN_FIELDS}
    out: dict[str, str] = {}
    for f in TURN_FIELDS:
        v = turn.get(f, "")
        if v is None:
            v = ""
        out[f] = str(v) if not isinstance(v, str) else v
    return out


def _coerce_actions(actions: Any) -> list[str]:
    if not isinstance(actions, list):
        return []
    out: list[str] = []
    for a in actions:
        if a is None:
            continue
        out.append(a if isinstance(a, str) else str(a))
    return out


def normalize_record(rec: dict[str, Any]) -> dict[str, Any]:
    """Coerce one JSON record into the parquet schema-shaped dict.

    Raises ``ValueError`` if a required field is missing — the caller
    decides whether to drop or surface the error.
    """
    if not isinstance(rec, dict):
        raise ValueError("record is not a dict")
    md_raw = rec.get("metadata") or {}
    if not isinstance(md_raw, dict):
        raise ValueError("metadata is not a dict")

    for k in META_REQUIRED:
        v = md_raw.get(k)
        if not isinstance(v, str) or not v:
            raise ValueError(f"missing required metadata.{k}")

    # Carve out flattened metadata.
    flattened: dict[str, Any] = {k: md_raw[k] for k in META_REQUIRED}
    sys_prompt = md_raw.get("system_prompt")
    flattened["system_prompt"] = sys_prompt if isinstance(sys_prompt, str) else None

    # Everything else gets JSON-stringified into metadata_extra. We keep
    # the structure intact so consumers can ``json.loads`` it.
    extras = {
        k: v
        for k, v in md_raw.items()
        if k not in META_REQUIRED and k not in META_FLATTENED
    }
    metadata_extra = json.dumps(extras, ensure_ascii=False, separators=(",", ":"))

    room = rec.get("roomName")
    agent = rec.get("agentId")
    if not isinstance(room, str) or not room:
        raise ValueError("missing roomName")
    if not isinstance(agent, str) or not agent:
        raise ValueError("missing agentId")

    expected = rec.get("expectedResponse")
    if not isinstance(expected, str) or not expected:
        raise ValueError("missing expectedResponse")

    cur_raw = rec.get("currentMessage")
    if not isinstance(cur_raw, dict):
        raise ValueError("missing currentMessage")

    mem_raw = rec.get("memoryEntries") or []
    if not isinstance(mem_raw, list):
        raise ValueError("memoryEntries is not a list")

    return {
        "roomName": room,
        "agentId": agent,
        "memoryEntries": [_coerce_turn(t) for t in mem_raw],
        "currentMessage": _coerce_turn(cur_raw),
        "expectedResponse": expected,
        "availableActions": _coerce_actions(rec.get("availableActions")),
        "task_type": flattened["task_type"],
        "source_dataset": flattened["source_dataset"],
        "license": flattened["license"],
        "split": flattened["split"],
        "system_prompt": flattened["system_prompt"],
        "metadata_extra": metadata_extra,
    }


# ---------------------------------------------------------------------------
# Streaming writer
# ---------------------------------------------------------------------------

def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("rb") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def _drain_batch(buf: list[dict[str, Any]], schema: pa.Schema) -> pa.RecordBatch:
    columns = {name: [] for name in schema.names}
    for row in buf:
        for name in schema.names:
            columns[name].append(row[name])
    return pa.RecordBatch.from_pydict(columns, schema=schema)


def convert_split(
    *,
    split_name: str,
    src_path: Path,
    out_dir: Path,
    target_bytes: int,
    batch_rows: int,
    compression: str,
) -> dict[str, Any]:
    if not src_path.exists():
        raise FileNotFoundError(f"missing source jsonl: {src_path}")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    schema = output_schema()
    chunk_idx = 0
    written_total = 0
    written_chunk = 0
    skipped = 0
    errors: list[str] = []

    writer: pq.ParquetWriter | None = None
    chunk_path: Path | None = None

    def open_writer() -> pq.ParquetWriter:
        nonlocal chunk_idx, chunk_path
        chunk_path = out_dir / f"{split_name}-{chunk_idx:04d}.parquet"
        log.info("[%s] opening chunk %s", split_name, chunk_path.name)
        return pq.ParquetWriter(
            chunk_path,
            schema,
            compression=compression,
        )

    buf: list[dict[str, Any]] = []

    def flush(force: bool = False) -> None:
        nonlocal writer, written_chunk, written_total, chunk_idx
        if not buf:
            return
        if writer is None:
            writer = open_writer()
            written_chunk = 0
        batch = _drain_batch(buf, schema)
        writer.write_batch(batch)
        written_chunk += batch.num_rows
        written_total += batch.num_rows
        buf.clear()
        # Roll the chunk if we exceeded the byte target.
        if force or (
            chunk_path and chunk_path.exists() and chunk_path.stat().st_size >= target_bytes
        ):
            writer.close()
            log.info(
                "[%s] closed %s (%d rows, %.1f MiB)",
                split_name,
                chunk_path.name,
                written_chunk,
                chunk_path.stat().st_size / (1024 * 1024),
            )
            writer = None
            chunk_idx += 1

    for rec in iter_jsonl(src_path):
        try:
            row = normalize_record(rec)
        except ValueError as e:
            skipped += 1
            if len(errors) < 5:
                errors.append(str(e))
            continue
        buf.append(row)
        if len(buf) >= batch_rows:
            flush(force=False)

    flush(force=True)
    if writer is not None:
        writer.close()

    return {
        "split": split_name,
        "rows_written": written_total,
        "rows_skipped": skipped,
        "errors_sample": errors,
        "chunks": sorted(p.name for p in out_dir.glob("*.parquet")),
        "out_dir": str(out_dir.relative_to(ROOT)),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--split",
        choices=list(SPLITS.keys()),
        default=None,
        help="convert just this split (default: all three)",
    )
    ap.add_argument(
        "--target-mib",
        type=int,
        default=DEFAULT_TARGET_MIB,
        help=f"target chunk size in MiB (default {DEFAULT_TARGET_MIB})",
    )
    ap.add_argument(
        "--batch-rows",
        type=int,
        default=DEFAULT_BATCH_ROWS,
        help=f"row batch size for parquet writes (default {DEFAULT_BATCH_ROWS})",
    )
    ap.add_argument(
        "--compression",
        default="zstd",
        choices=["zstd", "snappy", "gzip"],
        help="parquet compression codec (default zstd)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="print plan without writing parquet",
    )
    args = ap.parse_args()

    target_bytes = args.target_mib * 1024 * 1024
    splits_to_run = [args.split] if args.split else list(SPLITS.keys())

    plan = []
    for split in splits_to_run:
        src = FINAL / SPLITS[split]
        out_dir = PARQUET_OUT / split
        plan.append((split, src, out_dir))

    log.info("plan:")
    for split, src, out_dir in plan:
        size = src.stat().st_size if src.exists() else 0
        log.info(
            "  [%s] %s (%.1f MiB) -> %s",
            split,
            src.relative_to(ROOT),
            size / (1024 * 1024),
            out_dir.relative_to(ROOT),
        )

    if args.dry_run:
        log.info("dry-run: not writing parquet")
        return 0

    PARQUET_OUT.mkdir(parents=True, exist_ok=True)
    summary = []
    for split, src, out_dir in plan:
        result = convert_split(
            split_name=split,
            src_path=src,
            out_dir=out_dir,
            target_bytes=target_bytes,
            batch_rows=args.batch_rows,
            compression=args.compression,
        )
        summary.append(result)
        log.info(
            "[%s] done: %d rows, %d skipped, %d chunks",
            split,
            result["rows_written"],
            result["rows_skipped"],
            len(result["chunks"]),
        )

    summary_path = PARQUET_OUT / "_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    log.info("wrote %s", summary_path.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
