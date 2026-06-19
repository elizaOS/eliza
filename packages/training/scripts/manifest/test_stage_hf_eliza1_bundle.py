"""Tests for guarded one-tier HF bundle staging."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.stage_hf_eliza1_bundle import plan_tier_files, total_size  # noqa: E402


@dataclass
class Sibling:
    rfilename: str
    size: int


def test_plan_tier_files_selects_only_one_bundle() -> None:
    files = plan_tier_files(
        [
            Sibling("bundles/0_8b/eliza-1.manifest.json", 100),
            Sibling("bundles/0_8b/text/eliza-1-0_8b-128k.gguf", 200),
            Sibling("bundles/2b/eliza-1.manifest.json", 300),
            Sibling("README.md", 400),
        ],
        "0_8b",
    )

    assert [item.remote_path for item in files] == [
        "bundles/0_8b/eliza-1.manifest.json",
        "bundles/0_8b/text/eliza-1-0_8b-128k.gguf",
    ]
    assert [item.local_rel for item in files] == [
        "eliza-1-0_8b.bundle/eliza-1.manifest.json",
        "eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf",
    ]
    assert total_size(files) == 300


def test_plan_tier_files_sorts_paths() -> None:
    files = plan_tier_files(
        [
            Sibling("bundles/4b/text/z.gguf", 2),
            Sibling("bundles/4b/README.md", 1),
        ],
        "4b",
    )

    assert [item.remote_path for item in files] == [
        "bundles/4b/README.md",
        "bundles/4b/text/z.gguf",
    ]
