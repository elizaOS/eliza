import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "rl"))

from gemma_capacity import (
    BF16_BITS,
    build_capacity_report,
    estimate_apollo_optimizer_state_bytes,
    estimate_full_training_memory,
    estimate_kv_cache_bytes,
    estimate_lora_memory,
    parse_context_length,
    resolve_model_spec,
    slugify_model_name,
)


def test_resolve_model_spec_accepts_alias_and_model_id():
    alias = resolve_model_spec("9b")
    direct = resolve_model_spec("google/gemma-4-12B")

    assert alias is not None
    assert direct is not None
    assert alias.key == "gemma4_12b"
    assert direct.key == alias.key


def test_slugify_model_name_prefers_canonical_gemma_slug():
    assert slugify_model_name("google/gemma-4-31B") == "gemma4-31b"
    assert slugify_model_name("9B") == "gemma4-12b"
    assert slugify_model_name("27b-256k") == "gemma4-31b"


def test_resolve_model_spec_accepts_active_27b_256k_tier_alias():
    variant = resolve_model_spec("27b-256k")
    public_name = resolve_model_spec("eliza-1-27b-256k")

    assert variant is not None
    assert public_name is not None
    assert variant.key == "gemma4_31b"
    assert public_name.key == variant.key


def test_parse_context_length_supports_k_suffix():
    assert parse_context_length("128k") == 131072
    assert parse_context_length("4096") == 4096


def test_apollo_memory_is_lower_than_adamw_for_12b():
    spec = resolve_model_spec("9b")
    assert spec is not None

    adamw = estimate_full_training_memory(
        spec,
        optimizer="adamw",
        sequence_length=8192,
        micro_batch_size=1,
        checkpointed=True,
        apollo_rank=64,
    )
    apollo = estimate_full_training_memory(
        spec,
        optimizer="apollo",
        sequence_length=8192,
        micro_batch_size=1,
        checkpointed=True,
        apollo_rank=64,
    )

    assert apollo["optimizer_gib"] < adamw["optimizer_gib"]
    assert apollo["total_gib"] < adamw["total_gib"]


def test_lora_memory_is_lower_than_full_adamw_for_12b():
    spec = resolve_model_spec("9b")
    assert spec is not None

    adamw = estimate_full_training_memory(
        spec,
        optimizer="adamw",
        sequence_length=8192,
        micro_batch_size=1,
        checkpointed=True,
        apollo_rank=64,
    )
    lora = estimate_lora_memory(
        spec,
        sequence_length=8192,
        micro_batch_size=1,
        checkpointed=True,
        lora_rank=64,
    )

    assert lora["lora_params"] > 0
    assert lora["total_gib"] < adamw["total_gib"]


def test_gemma_kv_cache_uses_full_context_and_sliding_window_components():
    spec = resolve_model_spec("12b")
    assert spec is not None

    kv_128k = estimate_kv_cache_bytes(
        spec,
        context_tokens=131072,
        batch_size=1,
        kv_bits=BF16_BITS,
    )
    kv_256k = estimate_kv_cache_bytes(
        spec,
        context_tokens=262144,
        batch_size=1,
        kv_bits=BF16_BITS,
    )
    kv_q4 = estimate_kv_cache_bytes(
        spec,
        context_tokens=131072,
        batch_size=1,
        kv_bits=4.0,
    )

    assert kv_256k > kv_128k
    assert round(kv_256k / kv_128k, 5) < 2.0
    assert kv_q4 < kv_128k


def test_capacity_report_includes_gemma_kv_metadata():
    spec = resolve_model_spec("e2b")
    assert spec is not None

    report = build_capacity_report(
        spec,
        contexts=[131072],
        training_sequence_length=8192,
        micro_batch_size=1,
        apollo_rank=64,
        lora_rank=64,
        kv_bits=16.0,
    )

    assert report["model"]["model_id"] == "google/gemma-4-E2B"
    assert report["context_memory"][0]["sliding_window"] == 512
    assert report["context_memory"][0]["effective_sliding_kv_layers"] == 8
    assert "Gemma KV estimates" in report["notes"]["kv"]


def test_apollo_optimizer_estimate_is_positive_for_cloud_tier():
    spec = resolve_model_spec("27b")
    assert spec is not None

    assert spec.key == "gemma4_31b"
    assert estimate_apollo_optimizer_state_bytes(spec, 512) > 0
