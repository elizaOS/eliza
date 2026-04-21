#!/usr/bin/env python3
"""Rewrite elizaos.* imports after moving packages under elizaos.features."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REPLACEMENTS: list[tuple[str, str]] = [
    ("elizaos.advanced_capabilities", "elizaos.features.advanced_capabilities"),
    ("elizaos.advanced_memory", "elizaos.features.advanced_memory"),
    ("elizaos.advanced_planning", "elizaos.features.advanced_planning"),
    ("elizaos.basic_capabilities", "elizaos.features.basic_capabilities"),
    ("elizaos.core_capabilities", "elizaos.features.core_capabilities"),
]


def main() -> None:
    count = 0
    for path in ROOT.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        new = text
        for old, newp in REPLACEMENTS:
            new = new.replace(old, newp)
        if new != text:
            path.write_text(new, encoding="utf-8")
            count += 1
            print(path.relative_to(ROOT))
    print(f"Updated {count} files.")


if __name__ == "__main__":
    main()
