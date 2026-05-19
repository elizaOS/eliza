#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV_BIN = ROOT / ".venv/bin"
TOOLS = ROOT / "benchmarks/tools"
FIO_RESULT_DIR = ROOT / "benchmarks/results/fio"


def main() -> int:
    if not VENV_BIN.is_dir():
        raise SystemExit("missing .venv/bin; run make venv first")
    for tool in ("coremark", "stream_c.exe", "bw_mem", "lat_mem_rd", "benchmark_model"):
        src = TOOLS / tool
        dst = VENV_BIN / tool
        if not src.is_file():
            raise SystemExit(f"missing benchmark tool source: {src}")
        src.chmod(src.stat().st_mode | 0o755)
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        os.symlink(src, dst)
        print(f"installed {dst.relative_to(ROOT)} -> {src.relative_to(ROOT)}")
    FIO_RESULT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"prepared {FIO_RESULT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
