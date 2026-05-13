"""Qwen3.5 model registry for the eliza training pipeline.

Single source of truth for which Qwen variant trains where, with what
optimizer + quantization combination, and what its memory budget looks like.

The eliza-1 line trains exclusively against the Qwen3.5 / Qwen3.6 family.
The legacy Qwen3 base models (``Qwen/Qwen3-0.6B`` / ``Qwen/Qwen3-1.7B`` /
``Qwen/Qwen3-4B``) were dropped on 2026-05-12 per operator directive — the
Qwen3 dense bases do not work with the eliza-1 dflash spec-decode path
(the dflash kernels are validated against the Qwen3.5 architecture +
248320 tokenizer; a Qwen3 base has the wrong vocab and the wrong attention
shape for the fused QJL/Polar paths). The HuggingFace tier repos
    ``elizaos/eliza-1-{0_6b,1_7b,4b}`` remain public (existing downloads still
    work) but their model cards are marked DEPRECATED and no new SFT runs
    target them. New raw and fine-tuned bundles publish into the single
    ``elizaos/eliza-1`` repo under ``bundles/<tier>/``.

The active entries map onto the size-first ``eliza-1-*`` tier ids used
by the runtime model catalog (``packages/shared/src/local-inference/catalog.ts``
— ``ELIZA_1_TIER_IDS`` / ``MODEL_CATALOG``):

  - ``qwen3.5-0.8b`` → ``Qwen/Qwen3.5-0.8B-Base`` → ``eliza-1-0_8b``  (local tier; new "smallest" tier; full-param SFT on one consumer GPU; trains from the Base pretrain checkpoint, not the instruct release)
  - ``qwen3.5-2b``   → ``Qwen/Qwen3.5-2B-Base``   → ``eliza-1-2b``    (mid local tier; full-param SFT on a 16-24 GB GPU)
  - ``qwen3.5-4b``   → ``Qwen/Qwen3.5-4B-Base``   → ``eliza-1-4b``    (local/workstation tier; full-param SFT on a 24-28 GB GPU)
  - ``qwen3.5-9b``   → ``Qwen/Qwen3.5-9B-Base``   → ``eliza-1-9b``    (workstation tier; 80 GB-class GPU)
  - ``qwen3.5-27b``  → ``Qwen/Qwen3.5-27B``       → ``eliza-1-27b``   (cloud tier; single H200 SXM)
  - ``qwen3.6-27b``  → ``Qwen/Qwen3.6-27B``       → ``eliza-1-27b``   (legacy 27B context variants; gpu-h200x2)

All bases are published on the Hub. The 9b/27b tiers need workstation /
cloud-class GPUs (or FSDP). Every Qwen3.5/3.6 target's DFlash
speculative-decode drafter is distilled from ``Qwen/Qwen3.5-0.8B-Base``
(the Qwen3.5 tokenizer — vocab 248320 — must match the target). See
``DFLASH_DRAFTER_BASE`` below and ``scripts/distill_dflash_drafter.py``.

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
    ``args.max_seq_len == ap.get_default("max_seq_len")``). The 27B default
    is intentionally conservative (64k) so the registry's memory budget
    leaves real headroom on a 2× H200 / 2× B200 cluster; bump it via
    ``--max-seq-len`` for long-context runs when you've validated capacity
    with ``scripts/training/memory_calc.py --shape qwen3.6-27b``."""

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
    """HuggingFace repo id under which the fine-tuned model is published,
    e.g. ``elizaos/eliza-1``. Size tiers live under ``bundles/<tier>/`` and
    quantized GGUF variants live alongside the tier's manifest."""

    abliteration_repo_id: str = ""
    """HuggingFace repo id for the post-abliteration ("uncensored") release,
    Empty means: do not publish an abliterated variant for this entry. The
    active release policy uses one model repo (``elizaos/eliza-1``), so older
    per-size uncensored repos are intentionally not configured here."""

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
    automatically below per the published 3:1 ratio for Qwen3.5/3.6."""

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
    """Post-training flavors to produce.

    APOLLO is important for this pipeline because it keeps optimizer memory
    small on commodity GPUs. Do not swap this registry to AdamW/Muon-style
    training recipes; the release flow expects APOLLO plus GGUF q4/q6/q8
    outputs and the Eliza-specific runtime optimization sidecars.
    """

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
        # 16 GB local GPU rule of thumb: PolarQuant + TurboQuant keeps every
        # tier up to (and including) 27B inside 32 GB at 144k context.
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


# Layer counts / head shapes come straight from the HF `config.json` of each
# base model. All entries are Qwen3.5/3.6 hybrid linear-attn VLMs
# (`model_type: qwen3_5`, `full_attention_interval=4` → 3:1 linear:full), so
# the KV-bearing layer count is total_layers // 4.
#   total layers   q_heads  kv_heads  head_dim   vocab    (HF base id)
#   24 (6 full)    8         2         256        248320   Qwen/Qwen3.5-0.8B → eliza-1-0_8b   (qwen3_5, hidden 1024, max_pos 262144)
#   24 (6 full)    8         2         256        248320   Qwen/Qwen3.5-2B   → eliza-1-2b     (qwen3_5, hidden 2048, max_pos 262144)
#
# DFlash speculative-decode drafter base, per eliza tier id. The drafter
# must share the target's tokenizer/vocab: every Qwen3.5/3.6 target drafts
# from the Qwen3.5-0.8B-Base pretrain checkpoint — published, vocab 248320 —
# and the *shipped* drafter GGUF is that base distilled down to ~0.6B params
# (a smaller Qwen3.5-arch student; `scripts/distill_dflash_drafter.py` is the
# distiller, run on a cloud GPU; the artifact is not produced here). The
# all active tiers ship a DFlash companion so the app can exercise the same
# optimized runtime path end to end. Mirrors `DEFAULT_STUDENT_BASE` in
# `scripts/distill_dflash_drafter.py` — keep the two in sync.
DFLASH_DRAFTER_BASE: dict[str, str] = {
    # Qwen3.5/3.6 targets — drafter base is Qwen3.5-0.8B-Base; distill-target: ~0.6B Qwen3.5-arch.
    "eliza-1-0_8b": "Qwen/Qwen3.5-0.8B-Base",
    "eliza-1-2b": "Qwen/Qwen3.5-0.8B-Base",
    "eliza-1-4b": "Qwen/Qwen3.5-0.8B-Base",
    "eliza-1-9b": "Qwen/Qwen3.5-0.8B-Base",
    "eliza-1-27b": "Qwen/Qwen3.5-0.8B-Base",
    # eliza-1-0_8b: no drafter (smallest tier).
}

REGISTRY: dict[str, ModelEntry] = {
    # ─────────────────────────── REAL ENTRIES ───────────────────────────
    # Buildable Qwen3.5 / Qwen3.6 dense base models, mapped onto the size-first
    # eliza-1 tier ids in packages/shared/src/local-inference/catalog.ts.
    # Full-parameter SFT with APOLLO + Liger; the small-tier budgets target a
    # single consumer GPU (0.8B/2B: 12-16 GB; 4B: 24-28 GB on an H100-class
    # slice).
    #
    # The Qwen3.5 / Qwen3.6 bases all carry the 248320 tokenizer; the HF
    # causal-LM loss upcasts logits to fp32 (B*S*V*4 bytes), so Liger fused
    # chunked CE is what keeps the listed seq_len inside the budget (the
    # 248k vocab makes this transient ~1.6× heavier than the older 152k
    # Qwen3 vocab; the seq_len defaults reflect that). Inference budgets
    # here are modest local-tier windows; the runtime catalog ships
    # 32k context for these tiers and applies its own KV quantization.
    #
    # The legacy Qwen3 bases (Qwen/Qwen3-0.6B / Qwen/Qwen3-1.7B /
    # Qwen/Qwen3-4B) were dropped on 2026-05-12 — those models do not work
    # with the eliza-1 dflash spec-decode path (the dflash kernels are
    # validated against the Qwen3.5 architecture). The HuggingFace tier
    # repos (elizaos/eliza-1-{0_6b,1_7b,4b}) remain public for existing
    # downloads; the cards are marked DEPRECATED.
    #
    # New "smallest" tier on the Qwen3.5 backbone. Shares the 248k Qwen3.5
    # tokenizer with the 2b/4b/9b/27b targets — which is also why it is the
    # DFlash drafter base for those tiers (see DFLASH_DRAFTER_BASE above).
    # Hybrid linear-attn VLM (`qwen3_5`, `full_attention_interval=4` → 6 of
    # 24 layers are full-attention / KV-bearing). Geometry from
    # Qwen/Qwen3.5-0.8B `config.json`. SFT trains from the *Base* pretrain
    # checkpoint (`Qwen/Qwen3.5-0.8B-Base`), not the instruct release —
    # same architecture/tokenizer, no chat-SFT pre-baked in.
    "qwen3.5-0.8b": _entry(
        hf_id="Qwen/Qwen3.5-0.8B", short_name="qwen3.5-0.8b",
        eliza_short_name="eliza-1-0_8b", eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=0.8, tier=Tier.LOCAL,
        seq_len=4096, optimizer="apollo_mini", optimizer_rank=1,
        micro_batch=1, grad_accum=8, train_mem_gb_budget=12.0,
        train_dtype="bf16",
        infer_max_in=28672, infer_max_out=4096,
        infer_kv_layers=6, infer_kv_heads=2, infer_kv_head_dim=256,
        quantization_after=(
            "polarquant",
            "turboquant",
            "qjl",
            "gguf-q4_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="New smallest published eliza-1 tier, on the Qwen3.5-0.8B "
              "backbone (replaces eliza-1-0_6b as the small default). "
              "Full-param APOLLO SFT fits a 16 GB consumer GPU; runs the "
              "whole train→quant→bench stack end-to-end in well under an "
              "hour. Runtime catalog id: eliza-1-0_8b (32k context). Shares "
              "the 248k Qwen3.5 tokenizer with the 2b/9b/27b targets — also "
              "the DFlash drafter base for those tiers (the -Base pretrain "
              "checkpoint, distilled to ~0.6B — see DFLASH_DRAFTER_BASE).",
    ),
    # ──────────────────── LARGER-TIER BASE CHECKPOINTS ────────────────────
    # The eliza-1 line's mid/workstation/cloud tiers train against the
    # next-gen Qwen3.5/3.6 dense checkpoints. All three are published on the
    # Hub (verified via HfApi().model_info — millions of downloads each).
    # Referenced by scripts (train_vast.sh, train_nebius.sh, push_*), docs,
    # and tests.
    "qwen3.5-2b": _entry(
        hf_id="Qwen/Qwen3.5-2B-Base", short_name="qwen3.5-2b",
        eliza_short_name="eliza-1-2b", eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=2.27, tier=Tier.LOCAL,
        seq_len=8192, optimizer="apollo_mini", optimizer_rank=1,
        micro_batch=1, grad_accum=16, train_mem_gb_budget=15.5,
        train_dtype="bf16",
        infer_max_in=131072, infer_max_out=16384,
        infer_kv_layers=6, infer_kv_heads=2, infer_kv_head_dim=256,
        quantization_after=(
            "polarquant",
            "turboquant",
            "qjl",
            "gguf-q4_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Mid local tier (eliza-1-2b). Trains from Qwen/Qwen3.5-2B-Base "
              "(pretrain checkpoint, not the instruct release). qwen3-1.7b "
              "(eliza-1-1_7b) is the lighter Qwen3 alternative for 16 GB GPUs.",
    ),
    "qwen3.5-4b": _entry(
        hf_id="Qwen/Qwen3.5-4B-Base", short_name="qwen3.5-4b",
        eliza_short_name="eliza-1-4b", eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=4.0, tier=Tier.LOCAL,
        seq_len=8192, optimizer="apollo_mini", optimizer_rank=1,
        micro_batch=1, grad_accum=16, train_mem_gb_budget=28.0,
        train_dtype="bf16",
        infer_max_in=131072, infer_max_out=16384,
        infer_kv_layers=7, infer_kv_heads=2, infer_kv_head_dim=256,
        quantization_after=(
            "polarquant",
            "turboquant",
            "qjl",
            "gguf-q4_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Local/workstation tier (eliza-1-4b) on the Qwen3.5-4B-Base "
              "backbone. Full-param APOLLO SFT fits a single H200 easily. "
              "Replaces the legacy qwen3-4b for the Qwen3.5 fused-model line "
              "(shares the 248k tokenizer + dflash drafter base).",
    ),
    "qwen3.5-9b": _entry(
        hf_id="Qwen/Qwen3.5-9B", short_name="qwen3.5-9b",
        eliza_short_name="eliza-1-9b", eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=9.0, tier=Tier.WORKSTATION,
        seq_len=16384, optimizer="apollo", optimizer_rank=512,
        micro_batch=2, grad_accum=8, train_mem_gb_budget=80.0,
        train_dtype="bf16",
        infer_max_in=131072, infer_max_out=16384,
        infer_kv_layers=8, infer_kv_heads=4, infer_kv_head_dim=256,
        quantization_after=(
            "polarquant",
            "turboquant",
            "qjl",
            "gguf-q4_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Workstation/cloud tier. Full-param APOLLO SFT uses Vast/FSDP "
              "and the 9B Qwen3.5 checkpoint.",
    ),
    "qwen3.5-27b": _entry(
        hf_id="Qwen/Qwen3.5-27B", short_name="qwen3.5-27b",
        eliza_short_name="eliza-1-27b", eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=27.0, tier=Tier.CLOUD,
        seq_len=32768, optimizer="apollo_mini", optimizer_rank=1,
        micro_batch=1, grad_accum=16, train_mem_gb_budget=130.0,
        train_dtype="bf16",
        infer_max_in=131072, infer_max_out=16384,
        infer_kv_layers=16, infer_kv_heads=4, infer_kv_head_dim=256,
        quantization_after=(
            "polarquant",
            "turboquant",
            "qjl",
            "gguf-q4_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Cloud tier (eliza-1-27b). Trains from Qwen/Qwen3.5-27B (no "
              "-Base variant published; the 27B release IS the base pretrain "
              "checkpoint). With apollo_mini (rank-1 fp32 moments, "
              "negligible memory) + grad-checkpointed bf16 + Liger fused CE "
              "at micro_batch=1 seq=32k, the working-set sums to ~115-130 GB "
              "and FITS A SINGLE 141 GB H200 SXM. Run with FSDP_WORLD_SIZE=1 "
              "on gpu-h200x1; only fall back to gpu-h200x2 (8× H200, "
              "expensive) if the live run blows the per-GPU budget.",
        extra={"nebius_machine": "H200-1x", "fsdp_world_size": "1"},
    ),
    # The legacy Qwen3.6-27B entry — kept addressable for any caller that
    # still passes that key, but the canonical 27B is qwen3.5-27b above.
    # Both map to eliza-1-27b in the runtime catalog.
    "qwen3.6-27b": _entry(
        hf_id="Qwen/Qwen3.6-27B", short_name="qwen3.6-27b",
        eliza_short_name="eliza-1-27b", eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=27.0, tier=Tier.CLOUD,
        seq_len=65536, optimizer="apollo_mini", optimizer_rank=512,
        micro_batch=1, grad_accum=8, train_mem_gb_budget=190.0,
        train_dtype="bf16",
        infer_max_in=131072, infer_max_out=16384,
        infer_kv_layers=16, infer_kv_heads=4, infer_kv_head_dim=256,
        quantization_after=(
            "polarquant",
            "turboquant",
            "qjl",
            "gguf-q4_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="LEGACY 27B entry on the Qwen3.6 backbone. Prefer qwen3.5-27b "
              "for the eliza-1 fused-model line — dflash kernels are "
              "validated against Qwen3.5, not Qwen3.6. Kept here so older "
              "tier_to_registry_key callers keep resolving.",
        extra={"vast_gpu_target": "h200-2x", "fsdp_world_size": "2"},
    ),
}


def get(name: str) -> ModelEntry:
    raw = name.strip()
    lowered = raw.lower()
    key = lowered.replace("/", "-").replace("_", "-")
    aliases = {
        "qwen3-4b": "qwen3.5-4b",
        "qwen-qwen3-4b": "qwen3.5-4b",
        "qwen/qwen3-4b": "qwen3.5-4b",
    }
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
