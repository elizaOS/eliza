#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_wafer_model import repair_rom_artifact  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out-json", type=Path, required=True)
    parser.add_argument("--out-hex", type=Path, required=True)
    return parser.parse_args()


def resolve(path: Path) -> Path:
    return path if path.is_absolute() else ROOT / path


def main() -> int:
    args = parse_args()
    manifest = json.loads(resolve(args.manifest).read_text(encoding="utf-8"))
    rom = repair_rom_artifact(manifest)
    out_json = resolve(args.out_json)
    out_hex = resolve(args.out_hex)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_hex.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(rom, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    out_hex.write_text("\n".join(rom["words"]) + "\n", encoding="utf-8")
    print(json.dumps(rom, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
