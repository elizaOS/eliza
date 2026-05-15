#!/usr/bin/env python3
"""Eliza-1 mmproj header verifier.

Validates each staged Qwen3.5 mmproj GGUF in
``packages/training/release-staging/mmproj/`` and reports:

  - file size matches the manifest entry,
  - SHA-256 matches the manifest entry,
  - GGUF header is parseable,
  - ``general.architecture == "clip"`` and ``general.type == "mmproj"``,
  - tensor count matches the F16 source (no tensors lost during quantize),
  - the projector-type / vision-projection keys are present.

A full forward-pass parity check against the F16 reference is out of
scope here: the projector is tied to its matching text-backbone vision-
token embedding space, and the new Eliza-1 text-tier bundles are not yet
materialized on local disk. Once they are, an mtmd-cli end-to-end smoke
can be added on top of this header check.

Usage:
    python3 mmproj_verify.py --staging-dir <path> [--manifest <path>]

Default ``staging-dir`` is
``packages/training/release-staging/mmproj/`` relative to the repo root.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

try:
    import gguf  # type: ignore[import-not-found]
except ImportError as exc:  # pragma: no cover - env-only path
    raise SystemExit(
        "gguf python package is required; install via "
        "`pip install gguf` or use the llama.cpp/gguf-py checkout"
    ) from exc

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_STAGING = REPO_ROOT / "packages/training/release-staging/mmproj"

REQUIRED_GENERAL_ARCH = b"clip"
REQUIRED_GENERAL_TYPE = b"mmproj"
REQUIRED_CLIP_KEYS = (
    "clip.has_vision_encoder",
    "clip.vision.projection_dim",
    "clip.vision.image_size",
    "clip.vision.patch_size",
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for blk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(blk)
    return h.hexdigest()


def field_bytes(reader: "gguf.GGUFReader", key: str) -> bytes | None:
    field = reader.fields.get(key)
    if field is None or not field.data:
        return None
    raw = field.parts[field.data[0]]
    try:
        return bytes(raw)
    except TypeError:
        return None


def verify_entry(entry: dict, staging_dir: Path) -> dict:
    output_path = staging_dir / Path(entry["outputPath"]).name
    f16_path = staging_dir / Path(entry["f16StagedPath"]).name
    result: dict = {
        "tier": entry["tier"],
        "outputPath": str(output_path),
        "checks": {},
        "ok": True,
        "errors": [],
    }

    if not output_path.exists():
        result["ok"] = False
        result["errors"].append(f"missing: {output_path}")
        return result

    size = output_path.stat().st_size
    result["checks"]["size"] = {
        "actual": size,
        "expected": entry["outputSizeBytes"],
        "match": size == entry["outputSizeBytes"],
    }
    if size != entry["outputSizeBytes"]:
        result["ok"] = False
        result["errors"].append("size mismatch")

    sha = sha256_file(output_path)
    result["checks"]["sha256"] = {
        "actual": sha,
        "expected": entry["outputSha256"],
        "match": sha == entry["outputSha256"],
    }
    if sha != entry["outputSha256"]:
        result["ok"] = False
        result["errors"].append("sha256 mismatch")

    quant_reader = gguf.GGUFReader(str(output_path))
    arch = field_bytes(quant_reader, "general.architecture")
    typ = field_bytes(quant_reader, "general.type")
    result["checks"]["general.architecture"] = {
        "actual": arch.decode("utf-8") if arch else None,
        "expected": REQUIRED_GENERAL_ARCH.decode("utf-8"),
        "match": arch == REQUIRED_GENERAL_ARCH,
    }
    result["checks"]["general.type"] = {
        "actual": typ.decode("utf-8") if typ else None,
        "expected": REQUIRED_GENERAL_TYPE.decode("utf-8"),
        "match": typ == REQUIRED_GENERAL_TYPE,
    }
    if arch != REQUIRED_GENERAL_ARCH:
        result["ok"] = False
        result["errors"].append("general.architecture != 'clip'")
    if typ != REQUIRED_GENERAL_TYPE:
        result["ok"] = False
        result["errors"].append("general.type != 'mmproj'")

    missing_clip = [k for k in REQUIRED_CLIP_KEYS if k not in quant_reader.fields]
    result["checks"]["clipKeys"] = {
        "required": list(REQUIRED_CLIP_KEYS),
        "missing": missing_clip,
        "match": not missing_clip,
    }
    if missing_clip:
        result["ok"] = False
        result["errors"].append(f"missing clip keys: {missing_clip}")

    if f16_path.exists():
        f16_reader = gguf.GGUFReader(str(f16_path))
        result["checks"]["tensorCount"] = {
            "f16": len(f16_reader.tensors),
            "quant": len(quant_reader.tensors),
            "match": len(f16_reader.tensors) == len(quant_reader.tensors),
        }
        if len(f16_reader.tensors) != len(quant_reader.tensors):
            result["ok"] = False
            result["errors"].append(
                f"tensor count drift: F16={len(f16_reader.tensors)} "
                f"vs Q={len(quant_reader.tensors)}"
            )
    else:
        result["checks"]["tensorCount"] = {"skipped": f"F16 reference missing: {f16_path}"}

    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--staging-dir",
        type=Path,
        default=DEFAULT_STAGING,
        help="Directory containing the staged mmproj-<tier>-<quant>.gguf files",
    )
    ap.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Path to staging-dir/manifest.json (defaults to <staging-dir>/manifest.json)",
    )
    args = ap.parse_args(argv if argv is not None else sys.argv[1:])

    manifest_path = args.manifest or args.staging_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"manifest not found: {manifest_path}", file=sys.stderr)
        return 2

    manifest = json.loads(manifest_path.read_text())
    results = [verify_entry(entry, args.staging_dir) for entry in manifest["entries"]]
    overall_ok = all(r["ok"] for r in results)
    print(json.dumps({"ok": overall_ok, "entries": results}, indent=2, sort_keys=True))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
