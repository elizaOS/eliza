#!/usr/bin/env python3
"""Drop memoryEntries with empty content.

Audit shows 588,952 entries (11.83%) have empty content — mostly placeholder
assistant turns where the assistant took an action with no text reply.
These entries serialize as ~50 tokens of metadata each (role, speaker,
channel, empty content) but add zero signal.

Drop them entirely. Keeps the rest of the entry list intact.

Requires explicit input and output paths; use --in-place to replace the input.
"""
from __future__ import annotations

from eliza_training.lib.jsonl_transform import transform_cli

import sys



def transform_record(rec: dict, stats: dict) -> dict:
    me = rec.get("memoryEntries")
    if not isinstance(me, list):
        return rec
    new_me = []
    dropped_here = 0
    for entry in me:
        if not isinstance(entry, dict):
            new_me.append(entry)
            continue
        content = entry.get("content", "")
        if isinstance(content, str) and not content.strip():
            dropped_here += 1
            continue
        new_me.append(entry)
    if dropped_here:
        rec["memoryEntries"] = new_me
        stats["entries_dropped"] = stats.get("entries_dropped", 0) + dropped_here
        stats["records_changed"] = stats.get("records_changed", 0) + 1
    return rec


def main() -> int:
    return transform_cli(lambda rec, _index, stats: transform_record(rec, stats))


if __name__ == "__main__":
    sys.exit(main())
