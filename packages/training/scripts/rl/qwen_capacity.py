from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Literal

BYTES_PER_GIB = 1024**3
BF16_BITS = 16.0
FP32_BITS = 32.0
NF4_BITS = 4.0
DEFAULT_FULL_ATTENTION_PERIOD = 4
DEFAULT_ACTIVATION_MULTIPLIER_CHECKPOINTED = 6.0
DEFAULT_ACTIVATION_MULTIPLIER_UNCHECKPOINTED = 12.0


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
class QwenModelSpec:
    key: str
    slug: str
    display_name: str
    model_id: str
    total_params: int
    active_params: int
    hidden_size: int
    num_hidden_layers: int
    num_attention_heads: int
    num_key_value_heads: int
    head_dim: int
    max_context_tokens: int
    intermediate_size: int | None = None
    moe_intermediate_size: int | None = None
    shared_expert_intermediate_size: int | None = None
    num_experts: int | None = None
    num_experts_per_tok: int | None = None
    full_attention_period: int = DEFAULT_FULL_ATTENTION_PERIOD
    text_only_ready: bool = False
    notes: str = ""

    @property
    def is_moe(self) -> bool:
        return self.active_params < self.total_params

    @property
    def full_attention_layers(self) -> int:
        return max(1, self.num_hidden_layers // self.full_attention_period)

    @property
    def linear_attention_layers(self) -> int:
        return max(0, self.num_hidden_layers - self.full_attention_layers)

    @property
    def dense_ratio(self) -> float:
        return self.active_params / self.total_params


QWEN_MODEL_SPECS: tuple[QwenModelSpec, ...] = (
    QwenModelSpec(
        key="qwen35_4b",
        slug="qwen35-4b",
        display_name="Qwen 3.5 4B",
        model_id="Qwen/Qwen3.5-4B",
        total_params=4_000_000_000,
        active_params=4_000_000_000,
        hidden_size=2560,
        intermediate_size=9216,
        num_hidden_layers=32,
        num_attention_heads=16,
        num_key_value_heads=4,
        head_dim=256,
        max_context_tokens=262_144,
        text_only_ready=False,
        notes="Official checkpoint is Qwen 3.5 multimodal/hybrid; text-only fallback should be verified separately.",
    ),
    QwenModelSpec(
        key="qwen35_9b",
        slug="qwen35-9b",
        display_name="Qwen 3.5 9B",
        model_id="Qwen/Qwen3.5-9B",
        total_params=9_000_000_000,
        active_params=9_000_000_000,
        hidden_size=4096,
        intermediate_size=12288,
        num_hidden_layers=32,
        num_attention_heads=16,
        num_key_value_heads=4,
        head_dim=256,
        max_context_tokens=262_144,
        text_only_ready=False,
        notes="Official checkpoint is Qwen 3.5 multimodal/hybrid; text-only fallback should be verified separately.",
    ),
    QwenModelSpec(
        key="qwen35_27b",
        slug="qwen35-27b",
        display_name="Qwen 3.5 27B",
        model_id="Qwen/Qwen3.5-27B",
        total_params=27_000_000_000,
        active_params=27_000_000_000,
        hidden_size=5120,
        intermediate_size=17408,
        num_hidden_layers=64,
        num_attention_heads=24,
        num_key_value_heads=4,
        head_dim=256,
        max_context_tokens=262_144,
        text_only_ready=False,
        notes="Large dense Qwen 3.5 medium checkpoint.",
    ),
    QwenModelSpec(
        key="qwen35_35b_a3b",
        slug="qwen35-35b-a3b",
        display_name="Qwen 3.5 35B-A3B",
        model_id="Qwen/Qwen3.5-35B-A3B",
        total_params=35_000_000_000,
        active_params=3_000_000_000,
        hidden_size=2048,
        num_hidden_layers=40,
        num_attention_heads=16,
        num_key_value_heads=2,
        head_dim=256,
        max_context_tokens=262_144,
        moe_intermediate_size=512,
        shared_expert_intermediate_size=512,
        num_experts=256,
        num_experts_per_tok=8,
        text_only_ready=False,
        notes="Sparse MoE checkpoint; active-parameter and total-parameter planning differ materially.",
    ),
    QwenModelSpec(
        key="qwen35_122b_a10b",
        slug="qwen35-122b-a10b",
        display_name="Qwen 3.5 122B-A10B",
        model_id="Qwen/Qwen3.5-122B-A10B",
        total_params=122_000_000_000,
        active_params=10_000_000_000,
        hidden_size=3072,
        num_hidden_layers=48,
        num_attention_heads=32,
        num_key_value_heads=2,
        head_dim=256,
        max_context_tokens=262_144,
        moe_intermediate_size=1024,
        shared_expert_intermediate_size=1024,
        num_experts=256,
        num_experts_per_tok=8,
        text_only_ready=False,
        notes="Sparse MoE checkpoint; 122B planning should be treated as cluster-first.",
    ),
)


MODEL_BY_KEY = {spec.key: spec for spec in QWEN_MODEL_SPECS}
MODEL_BY_ID = {spec.model_id.lower(): spec for spec in QWEN_MODEL_SPECS}
MODEL_ALIASES = {
    "4b": "qwen35_4b",
    "9b": "qwen35_9b",
    "27b": "qwen35_27b",
    "35b": "qwen35_35b_a3b",
    "35b-a3b": "qwen35_35b_a3b",
    "122b": "qwen35_122b_a10b",
    "122b-a10b": "qwen35_122b_a10b",
    "qwen35-4b": "qwen35_4b",
    "qwen35-9b": "qwen35_9b",
    "qwen35-27b": "qwen35_27b",
    "qwen35-35b-a3b": "qwen35_35b_a3b",
    "qwen35-122b-a10b": "qwen35_122b_a10b",
    "qwen/qwen3.5-4b": "qwen35_4b",
    "qwen/qwen3.5-9b": "qwen35_9b",
    "qwen/qwen3.5-27b": "qwen35_27b",
    "qwen/qwen3.5-35b-a3b": "qwen35_35b_a3b",
    "qwen/qwen3.5-122b-a10b": "qwen35_122b_a10b",
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


def resolve_model_spec(value: str) -> QwenModelSpec | None:
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


def estimate_embedding_params(spec: QwenModelSpec) -> int:
    vocab_params = 248_320 * spec.hidden_size
    if spec.is_moe:
        return vocab_params
    return vocab_params * 2


def estimate_core_linear_params(spec: QwenModelSpec) -> int:
    h = spec.hidden_size
    layers = spec.num_hidden_layers
    attention_params = layers * (4 * h * h)
    if spec.is_moe:
        moe_i = spec.moe_intermediate_size or 0
        shared_i = spec.shared_expert_intermediate_size or 0
        experts = spec.num_experts or 0
        expert_params = layers * experts * (3 * h * moe_i)
        shared_params = layers * (3 * h * shared_i)
        router_params = layers * (h * experts)
        return (
            attention_params
            + expert_params
            + shared_params
            + router_params
            + estimate_embedding_params(spec)
        )
    dense_i = spec.intermediate_size or 0
    mlp_params = layers * (3 * h * dense_i)
    return attention_params + mlp_params + estimate_embedding_params(spec)


def model_overhead_factor(spec: QwenModelSpec) -> float:
    estimated = estimate_core_linear_params(spec)
    if estimated <= 0:
        return 1.0
    return spec.total_params / estimated


def estimate_lora_trainable_params(spec: QwenModelSpec, rank: int) -> int:
    h = spec.hidden_size
    layers = spec.num_hidden_layers
    attention = layers * (4 * rank * (h + h))
    if spec.is_moe:
        experts = spec.num_experts or 0
        moe_i = spec.moe_intermediate_size or 0
        shared_i = spec.shared_expert_intermediate_size or 0
        expert = layers * experts * (3 * rank * (h + moe_i))
        shared = layers * (3 * rank * (h + shared_i))
        router = layers * rank * (h + experts)
        raw = attention + expert + shared + router
    else:
        dense_i = spec.intermediate_size or 0
        mlp = layers * (3 * rank * (h + dense_i))
        raw = attention + mlp
    return math.ceil(raw * model_overhead_factor(spec))


def estimate_apollo_optimizer_state_bytes(spec: QwenModelSpec, rank: int) -> float:
    h = spec.hidden_size
    layers = spec.num_hidden_layers
    attention = layers * (4 * 8 * rank * (h + h))
    if spec.is_moe:
        experts = spec.num_experts or 0
        moe_i = spec.moe_intermediate_size or 0
        shared_i = spec.shared_expert_intermediate_size or 0
        expert = layers * experts * (3 * 8 * rank * (h + moe_i))
        shared = layers * (3 * 8 * rank * (h + shared_i))
        router = layers * (8 * rank * (h + experts))
        raw_bytes = attention + expert + shared + router
    else:
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
    spec: QwenModelSpec,
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
    spec: QwenModelSpec,
    *,
    context_tokens: int,
    batch_size: int,
    kv_bits: float = BF16_BITS,
) -> float:
    return (
        batch_size
        * context_tokens
        * spec.full_attention_layers
        * spec.num_key_value_heads
        * spec.head_dim
        * 2
        * _bits_to_bytes(kv_bits)
    )


def estimate_full_training_memory(
    spec: QwenModelSpec,
    *,
    optimizer: Literal["adamw", "apollo"],
    sequence_length: int,
    micro_batch_size: int,
    checkpointed: bool,
    sparse_policy: Literal["total", "active"],
    apollo_rank: int,
    weight_bits: float = BF16_BITS,
    gradient_bits: float = BF16_BITS,
) -> dict[str, float]:
    trainable_params = (
        spec.total_params if sparse_policy == "total" or not spec.is_moe else spec.active_params
    )
    scaling = trainable_params / spec.total_params
    weights_bytes = spec.total_params * _bits_to_bytes(weight_bits)
    gradients_bytes = trainable_params * _bits_to_bytes(gradient_bits)
    master_weights_bytes = trainable_params * _bits_to_bytes(FP32_BITS)
    if optimizer == "adamw":
        optimizer_bytes = estimate_adamw_state_bytes(
            trainable_params,
            include_master_weights=False,
        )
    else:
        optimizer_bytes = estimate_apollo_optimizer_state_bytes(spec, apollo_rank) * scaling
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
    spec: QwenModelSpec,
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
    spec: QwenModelSpec,
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
    spec: QwenModelSpec,
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
    spec: QwenModelSpec,
    *,
    policy: Literal["total", "active"],
) -> dict[str, int]:
    effective_params = (
        spec.total_params if policy == "total" or not spec.is_moe else spec.active_params
    )
    tokens = effective_params * 20
    flops_per_token = 6 * effective_params
    total_flops = flops_per_token * tokens
    return {
        "effective_params": effective_params,
        "tokens": tokens,
        "flops_per_token": flops_per_token,
        "total_training_flops": total_flops,
    }


def recommend_nebius_vm_shape(
    spec: QwenModelSpec,
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
        sparse_policy="active" if spec.is_moe else "total",
        apollo_rank=apollo_rank,
    )
    if estimate["total_gib"] <= shape.gpu_memory_gib * 0.92:
        return shape
    return None


def build_capacity_report(
    spec: QwenModelSpec,
    *,
    contexts: list[int],
    training_sequence_length: int,
    micro_batch_size: int,
    apollo_rank: int,
    lora_rank: int,
    turboquant_bits: float,
) -> dict[str, Any]:
    adamw_total = estimate_full_training_memory(
        spec,
        optimizer="adamw",
        sequence_length=training_sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=True,
        sparse_policy="total",
        apollo_rank=apollo_rank,
    )
    apollo_total = estimate_full_training_memory(
        spec,
        optimizer="apollo",
        sequence_length=training_sequence_length,
        micro_batch_size=micro_batch_size,
        checkpointed=True,
        sparse_policy="total",
        apollo_rank=apollo_rank,
    )
    apollo_active = None
    if spec.is_moe:
        apollo_active = estimate_full_training_memory(
            spec,
            optimizer="apollo",
            sequence_length=training_sequence_length,
            micro_batch_size=micro_batch_size,
            checkpointed=True,
            sparse_policy="active",
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
        kv_turbo = estimate_kv_cache_bytes(
            spec,
            context_tokens=context,
            batch_size=1,
            kv_bits=turboquant_bits,
        )
        context_reports.append(
            {
                "context_tokens": context,
                "full_attention_layers": spec.full_attention_layers,
                "kv_cache_bf16_gib": _gib(kv_bf16),
                "kv_cache_turboquant_gib": _gib(kv_turbo),
                "turboquant_bits": turboquant_bits,
                "compression_ratio_vs_bf16": round(kv_bf16 / kv_turbo, 3) if kv_turbo else None,
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
            "turboquant": "TurboQuant figures estimate inference-side KV-cache compression and are available in the Transformers generation path; they are not a trainer-side optimization.",
        },
        "chinchilla_total": estimate_chinchilla_budget(spec, policy="total"),
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
    if apollo_active is not None:
        report["chinchilla_active"] = estimate_chinchilla_budget(spec, policy="active")
        report["training_memory"]["apollo_active_gib"] = apollo_active
        report["single_gpu_fit"]["h100_apollo_active"] = apollo_active["total_gib"] <= 80.0 * 0.92
        report["single_gpu_fit"]["h200_apollo_active"] = apollo_active["total_gib"] <= 141.0 * 0.92
    return report
