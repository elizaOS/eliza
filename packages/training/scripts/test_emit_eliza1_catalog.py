"""Tests for the Eliza-1 catalog emitter tier matrix."""

from __future__ import annotations

import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[1]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))
if str(_TRAINING_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT / "scripts"))

from scripts import emit_eliza1_catalog as emit  # noqa: E402
from scripts.manifest.eliza1_manifest import ELIZA_1_TIERS  # noqa: E402


def test_known_base_models_match_active_eliza1_tiers() -> None:
    expected = {f"elizaos/eliza-1/bundles/{tier}" for tier in ELIZA_1_TIERS}
    assert set(emit.ACTIVE_BUNDLE_REPOS) == expected
    assert set(emit.KNOWN_BASE_MODELS) == expected
    assert "elizaos/eliza-1/bundles/0_8b" not in emit.KNOWN_BASE_MODELS
    assert all(
        "tokenizer_family" not in meta for meta in emit.KNOWN_BASE_MODELS.values()
    )


def test_27b_256k_catalog_defaults_match_gemma_cutover() -> None:
    entry = emit.build_catalog_entry(
        {
            "base_model": "elizaos/eliza-1/bundles/27b-256k",
            "target_repo": "elizaos/eliza-1/bundles/27b-256k",
            "gguf": {"filename": "text/eliza-1-27b-256k.gguf"},
            "tokenizer": {"family": "gemma4"},
            "runtime": {"args": []},
        }
    )

    assert entry.id == "eliza-1-27b-256k"
    assert entry.context_length == 262144
    assert entry.min_ram_gb == 48
    assert entry.tokenizer_family == "gemma4"
    assert entry.cache_type_k == "q8_0"
    assert entry.cache_type_v == "q8_0"


def test_catalog_tokenizer_family_comes_from_manifest() -> None:
    entry = emit.build_catalog_entry(
        {
            "base_model": "elizaos/eliza-1/bundles/9b",
            "target_repo": "elizaos/eliza-1/bundles/9b",
            "gguf": {"filename": "text/eliza-1-9b-128k.gguf"},
            "tokenizer": {"family": "qwen35"},
            "runtime": {"args": []},
        }
    )

    assert entry.id == "eliza-1-9b"
    assert entry.tokenizer_family == "qwen35"


def test_catalog_requires_manifest_tokenizer_family() -> None:
    try:
        emit.build_catalog_entry(
            {
                "base_model": "elizaos/eliza-1/bundles/2b",
                "target_repo": "elizaos/eliza-1/bundles/2b",
                "gguf": {"filename": "text/eliza-1-2b-128k.gguf"},
                "runtime": {"args": []},
            }
        )
    except SystemExit as exc:
        assert "manifest.tokenizer must be an object" in str(exc)
    else:
        raise AssertionError("build_catalog_entry accepted a manifest without tokenizer")
