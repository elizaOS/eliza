from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Literal

BYTES_PER_GIB = 1024**3
BF16_BITS = 16.0
FP32_BITS = 32.0
NF4_BITS = 4.0
DEFAULT_ACTIVATION_MULTIPLIER_CHECKPOINTED = 6.0
DEFAULT_ACTIVATION_MULTIPLIER_UNCHECKPOINTED = 12.0
DEFAULT_GEMMA_VOCAB_SIZE = 262_144


def _gib(num_bytes: float) -> float:
    return round(num_bytes / BYTES_PER_GIB, 3)


def _bits_to_bytes(bits: float) -> float:
    return bits / 8.0


@dataclass(frozen=True)
class NebiusVmShape:
    gpu: Literal["h100", "h200"]
    platform: str
    preset: str
    gpu_memory_gib: int


@dataclass(frozen=True)
class GemmaModelSpec:
    key: str
    slug: str
    display_name: str
    model_id: str
    eliza_tier: str
    total_params: int
    hidden_size: int
    num_hidden_layers: int
    full_attention_layers: int
    sliding_attention_layers: int
    sliding_window: int
    num_attention_heads: int
    num_key_value_heads: int
    num_global_key_value_heads: int | None
    num_kv_shared_layers: int
    head_dim: int
    global_head_dim: int
    max_context_tokens: int
    train_mem_gb_budget: float
    default_apollo_rank: int
    intermediate_size: int | None = None
    vocab_size: int = DEFAULT_GEMMA_VOCAB_SIZE
    text_only_ready: bool = True
    notes: str = ""

    @property
    def effective_sliding_kv_layers(self) -> int:
        return max(0, self.sliding_attention_layers - self.num_kv_shared_layers)

    @property
    def effective_kv_layers(self) -> int:
        return self.full_attention_layers + self.effective_sliding_kv_layers


GEMMA_MODEL_SPECS: tuple[GemmaModelSpec, ...] = (
    GemmaModelSpec(
        key="gemma4_e2b",
        slug="gemma4-e2b",
        display_name="Gemma 4 E2B",
        model_id="google/gemma-4-E2B",
        eliza_tier="eliza-1-2b",
        total_params=2_300_000_000,
        hidden_size=1536,
        intermediate_size=6144,
        num_hidden_layers=35,
        full_attention_layers=7,
        sliding_attention_layers=28,
        sliding_window=512,
        num_attention_heads=8,
        num_key_value_heads=1,
        num_global_key_value_heads=None,
        num_kv_shared_layers=20,
        head_dim=256,
        global_head_dim=512,
        max_context_tokens=131_072,
        train_mem_gb_budget=15.5,
        default_apollo_rank=1,
        notes=(
            "Entry local tier. HF config: 35 layers, 7 full-attention layers, "
            "512-token sliding window, shared KV."
        ),
    ),
    GemmaModelSpec(
        key="gemma4_e4b",
        slug="gemma4-e4b",
        display_name="Gemma 4 E4B",
        model_id="google/gemma-4-E4B",
        eliza_tier="eliza-1-4b",
        total_params=4_500_000_000,
        hidden_size=2560,
        intermediate_size=10240,
        num_hidden_layers=42,
        full_attention_layers=7,
        sliding_attention_layers=35,
        sliding_window=512,
        num_attention_heads=8,
        num_key_value_heads=2,
        num_global_key_value_heads=None,
        num_kv_shared_layers=18,
        head_dim=256,
        global_head_dim=512,
        max_context_tokens=131_072,
        train_mem_gb_budget=28.0,
        default_apollo_rank=1,
        notes=(
            "Local tier. HF config: 42 layers, 7 full-attention layers, "
            "512-token sliding window, shared KV."
        ),
    ),
    GemmaModelSpec(
        key="gemma4_12b",
        slug="gemma4-12b",
        display_name="Gemma 4 12B",
        model_id="google/gemma-4-12B",
        eliza_tier="eliza-1-9b",
        total_params=12_000_000_000,
        hidden_size=3840,
        intermediate_size=15360,
        num_hidden_layers=48,
        full_attention_layers=8,
        sliding_attention_layers=40,
        sliding_window=1024,
        num_attention_heads=16,
        num_key_value_heads=8,
        num_global_key_value_heads=1,
        num_kv_shared_layers=0,
        head_dim=256,
        global_head_dim=512,
        max_context_tokens=262_144,
        train_mem_gb_budget=80.0,
        default_apollo_rank=512,
        notes=(
            "Workstation tier. HF config: unified dense model with 256k context "
            "and 1024-token sliding window."
        ),
    ),
    GemmaModelSpec(
        key="gemma4_31b",
        slug="gemma4-31b",
        display_name="Gemma 4 31B",
        model_id="google/gemma-4-31B",
        eliza_tier="eliza-1-27b",
        total_params=31_000_000_000,
        hidden_size=5376,
        intermediate_size=21504,
        num_hidden_layers=60,
        full_attention_layers=10,
        sliding_attention_layers=50,
        sliding_window=1024,
        num_attention_heads=32,
        num_key_value_heads=16,
        num_global_key_value_heads=4,
        num_kv_shared_layers=0,
        head_dim=256,
        global_head_dim=512,
        max_context_tokens=262_144,
        train_mem_gb_budget=210.0,
        default_apollo_rank=512,
        notes=(
            "Cloud tier for the eliza-1-27b release family. HF config: "
            "60 layers, 10 full-attention layers."
        ),
    ),
)


MODEL_BY_KEY = {spec.key: spec for spec in GEMMA_MODEL_SPECS}
MODEL_BY_ID = {spec.model_id.lower(): spec for spec in GEMMA_MODEL_SPECS}
MODEL_ALIASES = {
    "2b": "gemma4_e2b",
    "e2b": "gemma4_e2b",
    "gemma4-e2b": "gemma4_e2b",
    "eliza-1-2b": "gemma4_e2b",
    "google/gemma-4-e2b": "gemma4_e2b",
    "4b": "gemma4_e4b",
    "e4b": "gemma4_e4b",
    "gemma4-e4b": "gemma4_e4b",
    "eliza-1-4b": "gemma4_e4b",
    "google/gemma-4-e4b": "gemma4_e4b",
    "9b": "gemma4_12b",
    "12b": "gemma4_12b",
    "gemma4-12b": "gemma4_12b",
    "eliza-1-9b": "gemma4_12b",
    "google/gemma-4-12b": "gemma4_12b",
    "27b": "gemma4_31b",
    "27b-256k": "gemma4_31b",
    "31b": "gemma4_31b",
    "gemma4-31b": "gemma4_31b",
    "eliza-1-27b": "gemma4_31b",
    "eliza-1-27b-256k": "gemma4_31b",
    "google/gemma-4-31b": "gemma4_31b",
}


NEBIUS_VM_SHAPES = {
    "h100": NebiusVmShape(
        gpu="h100",
        platform="gpu-h100-sxm",
        preset="1gpu-16vcpu-200gb",
        gpu_memory_gib=80,
    ),
    "h200": NebiusVmShape(
        gpu="h200",
        platform="gpu-h200-sxm",
        preset="1gpu-16vcpu-200gb",
        gpu_memory_gib=141,
    ),
}


def normalize_model_lookup_key(value: str) -> str:
    return value.strip().lower().replace("_", "-")


def slugify_model_name(model_name: str) -> str:
    normalized = normalize_model_lookup_key(model_name)
    if normalized in MODEL_ALIASES:
        return MODEL_BY_KEY[MODEL_ALIASES[normalized]].slug
    spec = MODEL_BY_ID.get(normalized)
    if spec:
        return spec.slug
    normalized = normalized.replace("/", "-")
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    normalized = re.sub(r"-{2,}", "-", normalized)
    return normalized


def resolve_model_spec(value: str) -> GemmaModelSpec | None:
    normalized = normalize_model_lookup_key(value)
    if normalized in MODEL_ALIASES:
        return MODEL_BY_KEY[MODEL_ALIASES[normalized]]
    return MODEL_BY_ID.get(normalized)


def parse_context_length(value: str) -> int:
    cleaned = value.strip().lower().replace("_", "")
    if cleaned.endswith("k"):
        base = float(cleaned[:-1])
        return int(base * 1024)
    return int(cleaned)


def estimate_embedding_params(spec: GemmaModelSpec) -> int:
    vocab_params = spec.vocab_size * spec.hidden_size
    return vocab_params * 2


def estimate_core_linear_params(spec: GemmaModelSpec) -> int:
    h = spec.hidden_size
    layers = spec.num_hidden_layers
    attention_params = layers * (4 * h * h)
    dense_i = spec.intermediate_size or 0
    mlp_params = layers * (3 * h * dense_i)
    return attention_params + mlp_params + estimate_embedding_params(spec)


def model_overhead_factor(spec: GemmaModelSpec) -> float:
    estimated = estimate_core_linear_params(spec)
    if estimated <= 0:
        return 1.0
    return spec.total_params / estimated


def estimate_lora_trainable_params(spec: GemmaModelSpec, rank: int) -> int:
    h = spec.hidden_size
    layers = spec.num_hidden_layers
    attention = layers * (4 * rank * (h + h))
    dense_i = spec.intermediate_size or 0
    mlp = layers * (3 * rank * (h + dense_i))
    raw = attention + mlp
    return math.ceil(raw * model_overhead_factor(spec))


def estimate_apollo_optimizer_state_bytes(spec: GemmaModelSpec, rank: int) -> float:
    h = spec.hidden_size
    layers = spec.num_hidden_layers
    attention = layers * (4 * 8 * rank * (h + h))
    dense_i = spec.intermediate_size or 0
    mlp = layers * (3 * 8 * rank * (h + dense_i))
    raw_bytes = attention + mlp
    return raw_bytes * model_overhead_factor(spec)


def estimate_adamw_state_bytes(trainable_params: int, *, include_master_weights: bool) -> float:
    optimizer_state = trainable_params * _bits_to_bytes(FP32_BITS * 2)
    if include_master_weights:
        optimizer_state += trainable_params * _bits_to_bytes(FP32_BITS)
    return optimizer_state


def estimate_training_activation_bytes(
    spec: GemmaModelSpec,
    *,
    sequence_length: int,
    micro_batch_size: int,
    checkpointed: bool,
    activation_bits: float = BF16_BITS,
) -> float:
    multiplier = (
        DEFAULT_ACTIVATION_MULTIPLIER_CHECKPOINTED
        if checkpointed
        else DEFAULT_ACTIVATION_MULTIPLIER_UNCHECKPOINTED
    )
    return (
        micro_batch_size
        * sequence_length
        * spec.hidden_size
        * spec.num_hidden_layers
        * _bits_to_bytes(activation_bits)
        * multiplier
    )


def estimate_kv_cache_bytes(
    spec: GemmaModelSpec,
    *,
    context_tokens: int,
    batch_size: int,
    kv_bits: float = BF16_BITS,
) -> float:
    full_heads = spec.num_global_key_value_heads or spec.num_key_value_heads
    full_bytes = (
        batch_size
        * context_tokens
        * spec.full_attention_layers
        * full_heads
        * spec.global_head_dim
        * 2
        * _bits_to_bytes(kv_bits)
    )
    sliding_tokens = min(context_tokens, spec.sliding_window)
    sliding_bytes = (
        batch_size
        * sliding_tokens
        * spec.effective_sliding_kv_layers
        * spec.num_key_value_heads
        * spec.head_dim
        * 2
        * _bits_to_bytes(kv_bits)
    )
    return full_bytes + sliding_bytes


def estimate_full_training_memory(
    spec: GemmaModelSpec,
    *,
    optimizer: Literal["adamw", "apollo"],
    sequence_length: int,
    micro_batch_size: int,
    checkpointed: bool,
    apollo_rank: int,
    weight_bits: float = BF16_BITS,
    gradient_bits: float = BF16_BITS,
) -> dict[str, float]:
    trainable_params = spec.total_params
    weights_bytes = spec.total_params * _bits_to_bytes(weight_bits)
    gradients_bytes = trainable_params * _bits_to_bytes(gradient_bits)
    master_weights_bytes = trainable_params * _bits_to_bytes(FP32_BITS)
    if optimizer == "adamw":
        optimizer_bytes = estimate_adamw_state_bytes(
            trainable_params,
            include_master_weights=False,
        )
    else:
        optimizer_bytes = estimate_apollo_optimizer_state_bytes(spec, apollo_rank)
    activation_bytes = estimate_training_activation_bytes(
        spec,
        sequence_length=sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=checkpointed,
    )
    total = (
        weights_bytes + gradients_bytes + master_weights_bytes + optimizer_bytes + activation_bytes
    )
    return {
        "weights_gib": _gib(weights_bytes),
        "gradients_gib": _gib(gradients_bytes),
        "master_weights_gib": _gib(master_weights_bytes),
        "optimizer_gib": _gib(optimizer_bytes),
        "activations_gib": _gib(activation_bytes),
        "total_gib": _gib(total),
    }


def estimate_adapter_memory(
    spec: GemmaModelSpec,
    *,
    sequence_length: int,
    micro_batch_size: int,
    checkpointed: bool,
    lora_rank: int,
    base_weight_bits: float,
) -> dict[str, float]:
    lora_params = estimate_lora_trainable_params(spec, lora_rank)
    weights_bytes = spec.total_params * _bits_to_bytes(base_weight_bits)
    lora_weights_bytes = lora_params * _bits_to_bytes(BF16_BITS)
    gradients_bytes = lora_params * _bits_to_bytes(BF16_BITS)
    master_weights_bytes = lora_params * _bits_to_bytes(FP32_BITS)
    optimizer_bytes = estimate_adamw_state_bytes(
        lora_params,
        include_master_weights=False,
    )
    activation_bytes = estimate_training_activation_bytes(
        spec,
        sequence_length=sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=checkpointed,
    )
    total = (
        weights_bytes
        + lora_weights_bytes
        + gradients_bytes
        + master_weights_bytes
        + optimizer_bytes
        + activation_bytes
    )
    return {
        "base_weights_gib": _gib(weights_bytes),
        "base_weight_bits": base_weight_bits,
        "lora_trainable_gib": _gib(lora_weights_bytes),
        "gradients_gib": _gib(gradients_bytes),
        "master_weights_gib": _gib(master_weights_bytes),
        "optimizer_gib": _gib(optimizer_bytes),
        "activations_gib": _gib(activation_bytes),
        "total_gib": _gib(total),
        "lora_params": lora_params,
    }


def estimate_lora_memory(
    spec: GemmaModelSpec,
    *,
    sequence_length: int,
    micro_batch_size: int,
    checkpointed: bool,
    lora_rank: int,
    base_weight_bits: float = BF16_BITS,
) -> dict[str, float]:
    return estimate_adapter_memory(
        spec,
        sequence_length=sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=checkpointed,
        lora_rank=lora_rank,
        base_weight_bits=base_weight_bits,
    )


def estimate_qlora_memory(
    spec: GemmaModelSpec,
    *,
    sequence_length: int,
    micro_batch_size: int,
    checkpointed: bool,
    lora_rank: int,
    quantized_weight_bits: float = NF4_BITS,
) -> dict[str, float]:
    estimate = estimate_adapter_memory(
        spec,
        sequence_length=sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=checkpointed,
        lora_rank=lora_rank,
        base_weight_bits=quantized_weight_bits,
    )
    estimate["quantized_base_weights_gib"] = estimate.pop("base_weights_gib")
    return estimate


def estimate_chinchilla_budget(
    spec: GemmaModelSpec,
) -> dict[str, int]:
    tokens = spec.total_params * 20
    flops_per_token = 6 * spec.total_params
    total_flops = flops_per_token * tokens
    return {
        "effective_params": spec.total_params,
        "tokens": tokens,
        "flops_per_token": flops_per_token,
        "total_training_flops": total_flops,
    }


def recommend_nebius_vm_shape(
    spec: GemmaModelSpec,
    *,
    gpu: Literal["h100", "h200"],
    sequence_length: int = 8192,
    micro_batch_size: int = 1,
    apollo_rank: int = 64,
) -> NebiusVmShape | None:
    shape = NEBIUS_VM_SHAPES[gpu]
    estimate = estimate_full_training_memory(
        spec,
        optimizer="apollo",
        sequence_length=sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=True,
        apollo_rank=apollo_rank,
    )
    if estimate["total_gib"] <= shape.gpu_memory_gib * 0.92:
        return shape
    return None


def build_capacity_report(
    spec: GemmaModelSpec,
    *,
    contexts: list[int],
    training_sequence_length: int,
    micro_batch_size: int,
    apollo_rank: int,
    lora_rank: int,
    kv_bits: float,
) -> dict[str, Any]:
    adamw_total = estimate_full_training_memory(
        spec,
        optimizer="adamw",
        sequence_length=training_sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=True,
        apollo_rank=apollo_rank,
    )
    apollo_total = estimate_full_training_memory(
        spec,
        optimizer="apollo",
        sequence_length=training_sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=True,
        apollo_rank=apollo_rank,
    )

    lora_bf16 = estimate_lora_memory(
        spec,
        sequence_length=training_sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=True,
        lora_rank=lora_rank,
    )
    qlora = estimate_qlora_memory(
        spec,
        sequence_length=training_sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=True,
        lora_rank=lora_rank,
    )

    context_reports = []
    for context in contexts:
        kv_bf16 = estimate_kv_cache_bytes(
            spec,
            context_tokens=context,
            batch_size=1,
            kv_bits=BF16_BITS,
        )
        kv_planned = estimate_kv_cache_bytes(
            spec,
            context_tokens=context,
            batch_size=1,
            kv_bits=kv_bits,
        )
        context_reports.append(
            {
                "context_tokens": context,
                "full_attention_layers": spec.full_attention_layers,
                "sliding_attention_layers": spec.sliding_attention_layers,
                "effective_sliding_kv_layers": spec.effective_sliding_kv_layers,
                "sliding_window": spec.sliding_window,
                "kv_cache_bf16_gib": _gib(kv_bf16),
                "kv_cache_planned_gib": _gib(kv_planned),
                "kv_bits": kv_bits,
                "compression_ratio_vs_bf16": round(kv_bf16 / kv_planned, 3)
                if kv_planned
                else None,
            }
        )

    h100_fit = (
        recommend_nebius_vm_shape(
            spec,
            gpu="h100",
            sequence_length=training_sequence_length,
            micro_batch_size=micro_batch_size,
            apollo_rank=apollo_rank,
        )
        is not None
    )
    h200_fit = (
        recommend_nebius_vm_shape(
            spec,
            gpu="h200",
            sequence_length=training_sequence_length,
            micro_batch_size=micro_batch_size,
            apollo_rank=apollo_rank,
        )
        is not None
    )

    report = {
        "model": asdict(spec),
        "notes": {
            "apollo": "APOLLO figures estimate trainer optimizer-state memory for CUDA full-parameter fine-tuning.",
            "kv": (
                "Gemma KV estimates include full-attention context plus the "
                "sliding-window cache. GGUF weight quantization and MTP drafting "
                "are release artifacts; QJL/Polar/TurboQuant sidecars are not "
                "required Gemma release gates."
            ),
        },
        "chinchilla_total": estimate_chinchilla_budget(spec),
        "training_memory": {
            "adamw_total_gib": adamw_total,
            "apollo_total_gib": apollo_total,
            "lora_bf16_gib": lora_bf16,
            "qlora_nf4_gib": qlora,
        },
        "context_memory": context_reports,
        "single_gpu_fit": {
            "h100_apollo_total": apollo_total["total_gib"] <= 80.0 * 0.92,
            "h200_apollo_total": apollo_total["total_gib"] <= 141.0 * 0.92,
            "h100_lora_bf16": lora_bf16["total_gib"] <= 80.0 * 0.92,
            "h200_lora_bf16": lora_bf16["total_gib"] <= 141.0 * 0.92,
            "h100_qlora_nf4": qlora["total_gib"] <= 80.0 * 0.92,
            "h200_qlora_nf4": qlora["total_gib"] <= 141.0 * 0.92,
            "recommended_nebius_vm": "h100" if h100_fit else ("h200" if h200_fit else None),
        },
    }
    return report
