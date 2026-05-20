#!/usr/bin/env python3
"""Expand a CVA6 -F-style file list into space-separated lists for cocotb.

Reads `core/Flist.cva6` (or any other CVA6-style flist), substitutes
`${CVA6_REPO_DIR}`, `${HPDCACHE_DIR}`, and `${TARGET_CFG}` against the
environment, recursively follows nested `-F path/to/sub.Flist` directives,
and writes:

  --files-out : one absolute path per line, suitable for `cat >> sources`
  --incdir-out : one `+incdir+ABS_PATH` line per include directory

This is invoked by `verify/cocotb/integration/Makefile.cva6` to assemble
the CVA6 v5.3.0 source list for verilator without committing the
expanded list into the repo (it changes with each CVA6 bump).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _expand(token: str, env: dict[str, str]) -> str:
    out = token
    for var, value in env.items():
        out = out.replace("${" + var + "}", value)
    return out


def _read_flist(path: Path, env: dict[str, str], files: list[str], incdirs: list[str]) -> None:
    with path.open(encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            if line.startswith("+incdir+"):
                incdirs.append(_expand(line[len("+incdir+") :], env))
                continue
            if line.startswith("-F"):
                sub_path = Path(_expand(line.split(None, 1)[1], env))
                _read_flist(sub_path, env, files, incdirs)
                continue
            files.append(_expand(line, env))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flist", required=True, help="path to the top-level CVA6 flist")
    parser.add_argument("--files-out", required=True, help="output: space-separated file list")
    parser.add_argument(
        "--incdir-out", required=True, help="output: one +incdir+ABS line per directory"
    )
    args = parser.parse_args()

    env_vars = ("CVA6_REPO_DIR", "HPDCACHE_DIR", "TARGET_CFG")
    env: dict[str, str] = {}
    for var in env_vars:
        if var not in os.environ:
            sys.stderr.write(f"expand_cva6_flist: required env var {var} is not set\n")
            return 1
        env[var] = os.environ[var]

    files: list[str] = []
    incdirs: list[str] = []
    _read_flist(Path(args.flist), env, files, incdirs)

    seen: set[str] = set()
    uniq_files: list[str] = []
    for path in files:
        if path not in seen:
            seen.add(path)
            uniq_files.append(path)

    missing = [path for path in uniq_files if not os.path.isfile(path)]
    if missing:
        sys.stderr.write("expand_cva6_flist: missing files:\n")
        for path in missing:
            sys.stderr.write(f"  {path}\n")
        return 1

    Path(args.files_out).write_text(" ".join(uniq_files) + "\n", encoding="utf-8")
    Path(args.incdir_out).write_text(
        "\n".join(f"+incdir+{path}" for path in incdirs) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
