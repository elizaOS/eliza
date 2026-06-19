import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "training"))

from qwen_capacity import (
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
    direct = resolve_model_spec("Qwen/Qwen3.5-9B")

    assert alias is not None
    assert direct is not None
    assert alias.key == "qwen35_9b"
    assert direct.key == alias.key


def test_slugify_model_name_prefers_canonical_qwen_slug():
    assert slugify_model_name("Qwen/Qwen3.5-122B-A10B") == "qwen35-122b-a10b"
    assert slugify_model_name("9B") == "qwen35-9b"


def test_parse_context_length_supports_k_suffix():
    assert parse_context_length("128k") == 131072
    assert parse_context_length("4096") == 4096


def test_apollo_memory_is_lower_than_adamw_for_9b():
    spec = resolve_model_spec("9b")
    assert spec is not None

    adamw = estimate_full_training_memory(
        spec,
        optimizer="adamw",
        sequence_length=8192,
        micro_batch_size=1,
        checkpointed=True,
        sparse_policy="total",
        apollo_rank=64,
    )
    apollo = estimate_full_training_memory(
        spec,
        optimizer="apollo",
        sequence_length=8192,
        micro_batch_size=1,
        checkpointed=True,
        sparse_policy="total",
        apollo_rank=64,
    )

    assert apollo["optimizer_gib"] < adamw["optimizer_gib"]
    assert apollo["total_gib"] < adamw["total_gib"]


def test_lora_memory_is_lower_than_full_adamw_for_9b():
    spec = resolve_model_spec("9b")
    assert spec is not None

    adamw = estimate_full_training_memory(
        spec,
        optimizer="adamw",
        sequence_length=8192,
        micro_batch_size=1,
        checkpointed=True,
        sparse_policy="total",
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


def test_kv_cache_scales_linearly_with_context_and_turboquant_bits():
    spec = resolve_model_spec("4b")
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
    kv_turbo = estimate_kv_cache_bytes(
        spec,
        context_tokens=131072,
        batch_size=1,
        kv_bits=4.0,
    )

    assert round(kv_256k / kv_128k, 5) == 2.0
    assert kv_turbo < kv_128k


def test_capacity_report_includes_sparse_active_budget_for_moe():
    spec = resolve_model_spec("122b")
    assert spec is not None

    report = build_capacity_report(
        spec,
        contexts=[131072],
        training_sequence_length=8192,
        micro_batch_size=1,
        apollo_rank=64,
        lora_rank=64,
        turboquant_bits=4.0,
    )

    assert "chinchilla_active" in report
    assert report["chinchilla_total"]["tokens"] > report["chinchilla_active"]["tokens"]
    assert "apollo_active_gib" in report["training_memory"]
    assert "inference-side KV-cache compression" in report["notes"]["turboquant"]


def test_apollo_optimizer_estimate_is_positive_for_sparse_model():
    spec = resolve_model_spec("35b-a3b")
    assert spec is not None

    assert estimate_apollo_optimizer_state_bytes(spec, 64) > 0
