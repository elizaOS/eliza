"""Qwen3.5 model registry for the eliza training pipeline.

Single source of truth for which Qwen variant trains where, with what
optimizer + quantization combination, and what its memory budget looks like.

Two kinds of entries live here:

1. REAL, buildable entries on published Qwen dense base models. These map
   onto the size-first ``eliza-1-*`` tier ids used by the runtime model
   catalog (``packages/shared/src/local-inference/catalog.ts`` —
   ``ELIZA_1_TIER_IDS`` / ``MODEL_CATALOG``):

     - ``qwen3.5-0.8b`` → ``Qwen/Qwen3.5-0.8B`` → ``eliza-1-0_8b``  (local tier; full-param SFT on one consumer GPU)
     - ``qwen3.5-2b``   → ``Qwen/Qwen3.5-2B``   → ``eliza-1-2b``    (local tier; full-param SFT on a 16 GB GPU)
     - ``qwen3.5-4b``   → ``Qwen/Qwen3.5-4B``   → ``eliza-1-4b``    (local/workstation tier; full-param SFT on a 48 GB train GPU, optimized for 24 GB inference)
2. Lookup is intentionally strict: active keys must name Qwen3.5 or an
   Eliza-1 tier id. Do not accept Qwen3 dense aliases.

The numbers below are observed-or-projected memory budgets for full-parameter
SFT with APOLLO at the listed sequence length. They are *budgets* — the
actual training script logs real memory through ``instrumentation.py`` and
will fail loud if reality exceeds the budget by more than 10%.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Tier(str, Enum):
    LOCAL = "local"
    WORKSTATION = "workstation"
    CLOUD = "cloud"


@dataclass(frozen=True)
class ModelEntry:
    hf_id: str
    short_name: str
    params_billion: float
    tier: Tier

    # ─── training budgets ───
    seq_len: int
    """Default training sequence length. Bounded by the fp32 logits transient
    (B*S*V*4 bytes; Qwen vocab=248k makes this dominant). With Liger kernel
    fused chunked CE we can roughly 4× this on the same VRAM budget.

    This is a *default* — `scripts/train_local.py` and `scripts/run_pipeline.py`
    both accept ``--max-seq-len <int>`` to override per run. CLI flags always
    win over registry values (see ``train_local.py`` arg-merge near
    ``args.max_seq_len == ap.get_default("max_seq_len")``). Defaults are
    intentionally conservative so the registry's memory budget leaves real
    headroom on local and cloud devices; bump via ``--max-seq-len`` only after
    validating capacity with ``scripts/training/memory_calc.py``."""

    optimizer: str
    """One of: apollo, apollo_mini."""

    optimizer_rank: int
    """APOLLO low-rank dim."""

    micro_batch: int
    grad_accum: int

    train_mem_gb_budget: float
    """Predicted peak GPU memory for training, world-aggregate across the FSDP
    cluster (sum of per-rank peaks). Per-GPU budget = budget / world_size +
    per-rank activations + per-rank logits + per-rank kv. The training script
    logs both per-rank and aggregate via instrumentation.py and fails loud
    when per-rank memory exceeds the cluster's per-GPU capacity."""

    train_dtype: str
    """bf16, fp16, or fp8. fp8 implies fp8 training (TE / torchao)."""

    use_liger: bool = True
    """Apply Liger fused chunked CE + RMSNorm/SwiGLU/RoPE kernels at training
    time. Enabled by default — required for the listed seq_len budgets."""

    # ─── eliza-1 series naming ───
    eliza_short_name: str = ""
    """Short name for the fine-tuned eliza release, e.g. ``eliza-1-2b``.
    Used by ``scripts/push_model_to_hf.py`` and the Vast template's
    ``MODEL_ALIAS`` once the fine-tune lands. Empty for any base entry that
    we don't intend to publish."""

    eliza_repo_id: str = ""
    """HuggingFace model repo for Eliza-1 artifacts.

    Runtime bundles publish into one repo, ``elizaos/eliza-1``, under
    ``bundles/<tier>/``. Do not create per-tier or per-quant model repos; the
    app catalog and optimizer matrix assume one canonical repo.
    """

    abliteration_repo_id: str = ""
    """Optional repo id for post-abliteration variants.

    Empty by default: Eliza-1 v1 intentionally ships one safety-tuned model
    repo only.
    """

    # ─── inference budgets (PolarQuant weights + TurboQuant 4-bit KV) ───
    infer_max_in: int = 131072
    """Maximum *input* prompt token budget for inference. 128k is our
    standard target across the local/workstation/cloud tiers; the model's
    native 256k context allows pushing higher when the KV-cache budget
    permits."""

    infer_max_out: int = 16384
    """Maximum *output* generation length budget for inference. 16k covers
    long agent traces + reasoning chains."""

    infer_kv_layers: int = 0
    """Number of full-attention (KV-bearing) layers. The rest are
    Gated-DeltaNet linear-attention layers with constant SSM state. Set
    automatically below per the published 3:1 ratio for Qwen3.5."""

    infer_kv_heads: int = 4
    """KV head count (GQA) for full-attention layers."""

    infer_kv_head_dim: int = 128
    """Head dimension for the KV cache."""

    infer_mem_gb_bf16_fullkv: float = 0.0
    """Total inference VRAM (weights + bf16 KV cache) at infer_max_in +
    infer_max_out tokens, no quantization. Computed in __post_init__."""

    infer_mem_gb_quantized: float = 0.0
    """Total inference VRAM with PolarQuant 4-bit weights + TurboQuant
    4-bit KV cache at the same context length."""

    quantization_after: tuple[str, ...] = ()
    """Post-training quant flavors to produce: polarquant, turboquant, awq, gguf-q4_k_m, etc."""

    unverified_base: bool = False
    """True for entries whose ``hf_id`` does not resolve to a published
    HuggingFace checkpoint as of 2026-05. Kept in the registry only because
    other scripts/tests reference the key. ``train_local.py`` /
    ``run_pipeline.py`` refuse to run with an unverified entry unless the
    caller passes an explicit ``--model`` override (or sets
    ``ELIZA_ALLOW_UNVERIFIED_BASE=1``)."""

    notes: str = ""
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def total_context(self) -> int:
        return self.infer_max_in + self.infer_max_out

    @property
    def can_train_locally(self) -> bool:
        return self.tier == Tier.LOCAL

    @property
    def can_inference_locally(self) -> bool:
        # Local-installable inference rule of thumb: PolarQuant + TurboQuant
        # should keep installable bundles inside a 32 GB ceiling where possible.
        return self.infer_mem_gb_quantized <= 32.0

    @property
    def public_name(self) -> str:
        """User-facing model name.

        Published entries use the Eliza-1 release name. Smoke/internal
        entries keep their registry short name because they are not exposed
        as installable models.
        """
        return self.eliza_short_name or self.short_name


def _compute_inference_mem(
    *, params_billion: float, kv_layers: int, kv_heads: int,
    kv_head_dim: int, total_ctx: int,
) -> tuple[float, float]:
    """Compute (bf16_total_gb, full-quant-stack_total_gb) for an entry.

    bf16 = full-precision weights + bf16 K/V cache.
    Full quant stack = PolarQuant 4-bit weights + QJL 1-bit K (realized
        7.53× from per-token norm overhead, not the marketing 16×) +
        TurboQuant 4-bit V.
    """
    weight_bytes_bf16 = params_billion * 1e9 * 2.0
    weight_bytes_q4 = params_billion * 1e9 * 0.5
    bf16_per_elem = 2.0
    qjl_per_elem = 2.0 / 7.53        # measured K-side ratio, proj_dim=256
    tq4_per_elem = 0.5               # TurboQuant 4-bit V

    elems_per_token = kv_heads * kv_head_dim * kv_layers
    kv_bytes_bf16 = elems_per_token * total_ctx * (bf16_per_elem + bf16_per_elem)
    kv_bytes_q4   = elems_per_token * total_ctx * (qjl_per_elem + tq4_per_elem)
    return (
        (weight_bytes_bf16 + kv_bytes_bf16) / 1024**3,
        (weight_bytes_q4 + kv_bytes_q4) / 1024**3,
    )


def _entry(**kw) -> ModelEntry:
    """Build a ModelEntry and back-fill the computed inference budgets."""
    bf16, q4 = _compute_inference_mem(
        params_billion=kw["params_billion"],
        kv_layers=kw["infer_kv_layers"],
        kv_heads=kw["infer_kv_heads"],
        kv_head_dim=kw["infer_kv_head_dim"],
        total_ctx=kw["infer_max_in"] + kw["infer_max_out"],
    )
    kw["infer_mem_gb_bf16_fullkv"] = round(bf16, 2)
    kw["infer_mem_gb_quantized"] = round(q4, 2)
    return ModelEntry(**kw)


# Layer counts / head shapes come from the HF `text_config` of each base
# model. Qwen3.5 uses a 3:1 linear-attention/full-attention hidden layout,
# so `infer_kv_layers` is one quarter of total layers.
#   total layers   q_heads  kv_heads  head_dim   vocab     full-attn  (HF base id)
#   24             8         2         256        248320    6          Qwen/Qwen3.5-0.8B
#   24             8         2         256        248320    6          Qwen/Qwen3.5-2B
#   32             16        4         256        248320    8          Qwen/Qwen3.5-4B

REGISTRY: dict[str, ModelEntry] = {
    # ─────────────────────────── REAL ENTRIES ───────────────────────────
    # Buildable Qwen dense base models, mapped onto the size-first
    # eliza-1 tier ids in packages/shared/src/local-inference/catalog.ts.
    # Full-parameter SFT with APOLLO + Liger; the listed budgets target a
    # single consumer GPU (0.8B/2B: 16 GB; 4B: 24 GB).
    #
    # Qwen3.5 vocab is ~248k tokens — the HF causal-LM loss upcasts logits to
    # fp32 (B*S*V*4 bytes), so Liger fused chunked CE is what keeps the
    # listed seq_len inside the budget. Inference budgets here are modest
    # local-tier windows; the runtime catalog ships 32k context for these
    # tiers and applies its own KV quantization.
    "qwen3.5-0.8b": _entry(
        hf_id="Qwen/Qwen3.5-0.8B", short_name="qwen3.5-0.8b",
        eliza_short_name="eliza-1-0_8b", eliza_repo_id="elizaos/eliza-1",
        params_billion=0.8, tier=Tier.LOCAL,
        seq_len=4096, optimizer="apollo_mini", optimizer_rank=128,
        micro_batch=1, grad_accum=8, train_mem_gb_budget=10.0,
        train_dtype="bf16",
        infer_max_in=28672, infer_max_out=4096,
        infer_kv_layers=6, infer_kv_heads=2, infer_kv_head_dim=256,
        # Names must match scripts/quantization/<name>_apply.py exactly —
        # run_pipeline.py / train_vast.sh invoke `${name}_apply.py` per name.
        # gguf-q4_k_m wraps llama.cpp's convert_hf_to_gguf.py + llama-quantize.
        quantization_after=("polarquant", "qjl", "fp8", "gguf-q4_k_m"),
        notes="Smallest published eliza-1 tier. Full-param APOLLO SFT fits a "
              "single 16 GB consumer GPU comfortably; runs the whole "
              "train→quant→bench stack end-to-end in well under an hour. "
              "Runtime catalog id: eliza-1-0_8b (32k context).",
    ),
    "qwen3.5-2b": _entry(
        hf_id="Qwen/Qwen3.5-2B", short_name="qwen3.5-2b",
        eliza_short_name="eliza-1-2b", eliza_repo_id="elizaos/eliza-1",
        params_billion=2.0, tier=Tier.LOCAL,
        seq_len=8192, optimizer="apollo_mini", optimizer_rank=256,
        micro_batch=1, grad_accum=16, train_mem_gb_budget=15.5,
        train_dtype="bf16",
        infer_max_in=131072, infer_max_out=16384,
        infer_kv_layers=6, infer_kv_heads=2, infer_kv_head_dim=256,
        quantization_after=("polarquant", "turboquant", "qjl", "fp8", "gguf-q4_k_m"),
        notes="Modern-phone default tier. Full-param APOLLO SFT at seq=8k "
              "with Liger targets a 16 GB consumer GPU; drop to seq=4k if "
              "peak reserved >15.5 GB. Runtime catalog id: eliza-1-2b.",
    ),
    "qwen3.5-4b": _entry(
        hf_id="Qwen/Qwen3.5-4B", short_name="qwen3.5-4b",
        eliza_short_name="eliza-1-4b", eliza_repo_id="elizaos/eliza-1",
        params_billion=4.0, tier=Tier.LOCAL,
        seq_len=4096, optimizer="apollo_mini", optimizer_rank=256,
        micro_batch=1, grad_accum=16, train_mem_gb_budget=34.0,
        train_dtype="bf16",
        infer_max_in=28672, infer_max_out=4096,
        infer_kv_layers=8, infer_kv_heads=4, infer_kv_head_dim=256,
        quantization_after=("polarquant", "qjl", "fp8", "gguf-q4_k_m"),
        notes="Mid local/workstation tier. Full-param APOLLO SFT needs a "
              "48 GB-class training GPU after optimizer state; inference still "
              "targets 24 GB devices after quantization. "
              "Runtime catalog id: eliza-1-4b.",
    ),
}


def get(name: str) -> ModelEntry:
    raw = name.strip()
    lowered = raw.lower()
    key = lowered.replace("/", "-").replace("_", "-")
    aliases: dict[str, str] = {}
    key = aliases.get(lowered, aliases.get(key, key))
    if key in REGISTRY:
        return REGISTRY[key]
    for entry in REGISTRY.values():
        if (
            entry.hf_id == raw
            or entry.hf_id.lower() == lowered
            or entry.short_name == raw
            or entry.eliza_short_name == raw
            or entry.eliza_short_name.lower() == key
        ):
            return entry
    raise KeyError(f"unknown model {name!r}; known: {sorted(REGISTRY)}")


def by_tier(tier: Tier) -> list[ModelEntry]:
    return [e for e in REGISTRY.values() if e.tier == tier]


def summary_table() -> str:
    cols = ("name", "params B", "tier", "train seq", "train mem",
            "infer ctx (in+out)", "infer bf16", "infer Q4+TQ", "optimizer")
    rows = [cols]
    for e in REGISTRY.values():
        rows.append((
            e.public_name,
            f"{e.params_billion:.1f}",
            e.tier.value,
            f"{e.seq_len}",
            f"{e.train_mem_gb_budget:.0f}GB",
            f"{e.infer_max_in}+{e.infer_max_out}",
            f"{e.infer_mem_gb_bf16_fullkv:.1f}GB",
            f"{e.infer_mem_gb_quantized:.1f}GB",
            f"{e.optimizer}@r{e.optimizer_rank}",
        ))
    widths = [max(len(r[i]) for r in rows) for i in range(len(cols))]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    return "\n".join(fmt.format(*r) for r in rows)


if __name__ == "__main__":
    print(summary_table())
