"""Write complete synthetic dataset records using the generators' compact JSONL format."""

import json
import os
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path


def write_jsonl(records: Iterable[Mapping[str, object]], path: Path) -> int:
    """Preserve record order and Unicode; return the number of rows written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as output:
            temporary = Path(output.name)
            for record in records:
                output.write(
                    json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
                )
                count += 1
            output.flush()
            os.fsync(output.fileno())
        if path.exists():
            temporary.chmod(path.stat().st_mode & 0o777)
        os.replace(temporary, path)
        return count
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
