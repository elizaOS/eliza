"""Write complete synthetic dataset records using the generators' compact JSONL format."""

import json
from collections.abc import Iterable, Mapping
from pathlib import Path


def write_jsonl(records: Iterable[Mapping[str, object]], path: Path) -> int:
    """Preserve record order and Unicode; return the number of rows written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as output:
        for record in records:
            output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    return count
