"""Dump the eliza-1 model registry as JSON for cross-language drift checks.

Imports ``model_registry`` (which has no torch/transformers deps) and writes
the canonical fields the TypeScript runtime resolver mirrors. Keyed by the
``eliza_short_name`` so the consumer doesn't need to know our internal
``qwenX.Y-Nb`` keys.

Usage (from training/):
    uv run python scripts/dump_registry_json.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "training"))

import model_registry  # noqa: E402  (after sys.path tweak)


def main() -> int:
    out: dict[str, dict[str, object]] = {}
    for entry in model_registry.REGISTRY.values():
        if not entry.eliza_short_name:
            continue
        repo = entry.eliza_repo_id
        out[entry.eliza_short_name] = {
            "eliza_short_name": entry.eliza_short_name,
            "eliza_repo_id": repo,
            "gguf_repo_id": f"{repo}-gguf" if repo else "",
            "base_hf_id": entry.hf_id,
            "tier": entry.tier.value,
            "inference_max_context": entry.infer_max_in + entry.infer_max_out,
        }
    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
