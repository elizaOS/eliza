#!/usr/bin/env python3
"""Generate a quarantined E1 logic-synthesis recipe corpus for AI-EDA experiments."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/logic_synthesis_recipes"
CLAIM_BOUNDARY = "logic_synthesis_recipe_corpus_only_no_training_inference_ppa_or_release_claim"


TARGET_MODULES = [
    {
        "id": "e1-dma",
        "top": "e1_dma",
        "rtl": ["rtl/dma/e1_dma.sv"],
        "reason": "standalone DMA control/data-path block with non-trivial muxing",
    },
    {
        "id": "e1-npu",
        "top": "e1_npu",
        "rtl": ["rtl/npu/e1_npu.sv"],
        "reason": "standalone NPU datapath/control block used by AI workload experiments",
    },
]

RECIPES = [
    {
        "id": "yosys-proc-opt-baseline",
        "family": "yosys",
        "description": "Minimal generic RTL elaboration and optimization baseline.",
        "passes": ["proc", "opt", "stat"],
        "requires_external_assets": [],
    },
    {
        "id": "yosys-clean-area-prep",
        "family": "yosys",
        "description": "Generic area-oriented cleanup without technology mapping.",
        "passes": ["proc", "flatten", "opt", "wreduce", "opt_clean", "stat"],
        "requires_external_assets": [],
    },
    {
        "id": "yosys-abc-generic-gates",
        "family": "yosys_abc",
        "description": "Technology-independent ABC mapping to generic gates for recipe plumbing.",
        "passes": ["proc", "opt", "techmap", "abc -g gates", "opt_clean", "stat"],
        "requires_external_assets": [],
    },
    {
        "id": "yosys-abc-fast-generic-gates",
        "family": "yosys_abc",
        "description": "Fast generic ABC mapping used as a low-cost local baseline.",
        "passes": ["proc", "opt", "techmap", "abc -fast -g gates", "opt_clean", "stat"],
        "requires_external_assets": [],
    },
    {
        "id": "openabc-d-imitation-placeholder",
        "family": "openabc_d",
        "description": "Placeholder for OpenABC-D supervised recipe ranking after asset fetch.",
        "passes": [],
        "requires_external_assets": ["openabc-d"],
        "blocked_until": [
            "external asset openabc-d fetched and hash-pinned",
            "license and train/test leakage review complete",
            "OpenABC-D recipe features converted into internal records",
        ],
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    corpus: dict[str, Any] = {
        "schema": "eliza.ai_eda.logic_synthesis_recipe_corpus.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "policy": {
            "source_modification_forbidden": True,
            "technology_mapped_qor_requires_liberty_sdc_and_equivalence": True,
            "accepted_recipe_requires_before_after_equivalence": True,
            "openabc_d_records_blocked_until_external_asset_review": True,
        },
        "target_modules": TARGET_MODULES,
        "recipes": RECIPES,
    }
    corpus_path = out_dir / "recipe_corpus.json"
    corpus_path.write_text(json.dumps(corpus, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.logic_synthesis_recipe_corpus {corpus_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
