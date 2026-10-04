#!/usr/bin/env python3
"""Final deslop pass for reply records with unquoted native JSON `text:` values.

Earlier deslop transforms used a regex that only matched
    text: "quoted value"
This missed ~80,433 reply records where the text value is unquoted:
    text: And what did this ghost look like?

This pass walks all reply records, finds unquoted text values, and applies
the same casual + task deslop rules to them.

Requires explicit input and output paths; use --in-place to replace the input.
"""
from __future__ import annotations

from eliza_training.lib.jsonl_transform import transform_cli

import json
import re
import sys


from eliza_training.transform_casual_reply_shorten import (  # noqa: E402
    shorten_casual,
    is_casual,
)
from eliza_training.transform_task_reply_deslop import deslop_task_text  # noqa: E402

# Unquoted native JSON text: value extends to end of line (or next \n).
UNQUOTED_TEXT_RE = re.compile(
    r'(^|\n)(text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def update_text_field(payload: str, *, idx: int, casual: bool, stats: dict) -> str:
    def _replace(match: re.Match) -> str:
        prefix, key, value = match.groups()
        original_value = value
        # apply casual or task deslop
        if casual:
            new_value = shorten_casual(value, idx=idx, stats=stats)
        else:
            new_value = deslop_task_text(value, stats=stats)
        if new_value == original_value:
            return match.group(0)
        # if new value contains characters that need quoting, quote it
        if any(c in new_value for c in '"\n\\'):
            return f'{prefix}{key}{json.dumps(new_value, ensure_ascii=False)}'
        return f"{prefix}{key}{new_value}"

    return UNQUOTED_TEXT_RE.sub(_replace, payload)


def transform_record(rec: dict, idx: int, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type", "")
    if tt != "reply":
        return rec
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    casual = is_casual(rec)
    new_er = update_text_field(er, idx=idx, casual=casual, stats=stats)
    if new_er != er:
        rec["expectedResponse"] = new_er
        stats["records_changed"] = stats.get("records_changed", 0) + 1
    return rec


def main() -> int:
    return transform_cli(transform_record)


if __name__ == "__main__":
    sys.exit(main())
