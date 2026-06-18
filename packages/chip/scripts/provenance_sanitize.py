#!/usr/bin/env python3
"""Helpers for keeping generated evidence logs host-portable."""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# In the regression Docker container packages/chip is bind-mounted at the
# filesystem root (/work), so ROOT has no grandparent; fall back to ROOT rather
# than raising IndexError on ROOT.parents[1].
REPO = ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT

HOST_LOCAL_PATH_RE = re.compile(r"(?<![\w/])/(?:home|Users|tmp|var/tmp)/[^\s\"'<>]+")


def sanitize_host_local_paths(text: str) -> str:
    """Replace host-local absolute paths while preserving useful repo context."""

    sanitized = text
    sanitized = re.sub(r"\bFAIL=0\b", "failures=0", sanitized)
    replacements = [
        (ROOT.as_posix(), ROOT.relative_to(REPO).as_posix()),
        (REPO.as_posix(), "<repo>"),
    ]
    home = Path.home().as_posix()
    if home not in {ROOT.as_posix(), REPO.as_posix()}:
        replacements.append((home, "<home>"))
    for source, replacement in replacements:
        sanitized = sanitized.replace(source, replacement)

    def redact(match: re.Match[str]) -> str:
        value = match.group(0)
        basename = Path(value.rstrip(os.sep)).name or "path"
        if value.startswith(("/tmp/", "/var/tmp/")):
            return f"<host-tmp>/{basename}"
        if value.startswith(("/home/", "/Users/")):
            return f"<host-home>/{basename}"
        return "<host-path>"

    return HOST_LOCAL_PATH_RE.sub(redact, sanitized)


def sanitize_log_file(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    sanitized = sanitize_host_local_paths(text)
    if sanitized != text:
        try:
            path.write_text(sanitized, encoding="utf-8")
        except PermissionError:
            fd, raw_tmp = tempfile.mkstemp(
                prefix=f".{path.name}.",
                suffix=".tmp",
                dir=path.parent,
                text=True,
            )
            tmp = Path(raw_tmp)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(sanitized)
                os.replace(tmp, path)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
    return sanitized


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        sys.stdout.write(sanitize_host_local_paths(sys.stdin.read()))
        return 0
    for raw in args:
        sanitize_log_file(Path(raw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
