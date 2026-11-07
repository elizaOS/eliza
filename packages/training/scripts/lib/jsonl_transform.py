"""Atomic, explicit-input runner for legacy corpus transformations."""

import argparse
import json
import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

Transform = Callable[[dict[str, Any], int, dict[str, int]], dict[str, Any]]


def transform_jsonl(
    source: Path, destination: Path, transform: Transform
) -> dict[str, int]:
    """Commit only a completely valid transformed corpus, including in-place runs."""
    stats = {"total": 0, "records_changed": 0}
    temporary: Path | None = None
    try:
        with source.open(encoding="utf-8") as incoming:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp",
                delete=False,
            ) as outgoing:
                temporary = Path(outgoing.name)
                for index, line in enumerate(incoming):
                    try:
                        record = json.loads(line)
                        if not isinstance(record, dict):
                            raise ValueError("expected a JSON object")
                        # Recorded model boundaries must never undergo synthetic text edits.
                        if record.get("format") == "eliza_native_v1":
                            raise ValueError(
                                "native recorded boundaries cannot be rewritten"
                            )
                        result = transform(record, index, stats)
                        if not isinstance(result, dict):
                            raise ValueError("transform must return a JSON object")
                        outgoing.write(json.dumps(result, ensure_ascii=False) + "\n")
                        stats["total"] += 1
                    except (ValueError, TypeError) as exc:
                        raise ValueError(f"{source}:{index + 1}: {exc}") from exc
                outgoing.flush()
                os.fsync(outgoing.fileno())
        if destination.exists():
            temporary.chmod(destination.stat().st_mode & 0o777)
        os.replace(temporary, destination)
        return stats
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def transform_cli(transform: Transform) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--output", type=Path)
    output.add_argument("--in-place", action="store_true")
    args = parser.parse_args()
    destination = args.input if args.in_place else args.output
    if not args.in_place and destination.resolve() == args.input.resolve():
        parser.error("use --in-place to replace the input")
    print(json.dumps(transform_jsonl(args.input, destination, transform), indent=2))
    return 0
