"""Gemma 4 model registry for the eliza training pipeline.

Single source of truth for which Gemma 4 variant trains where, with what
optimizer + quantization combination, and what its memory budget looks like.

The eliza-1 line trains against the Gemma 4 dense bases for every active tier
(2B/4B/9B/27B). The prior Qwen3.5/3.6 backbones were dropped — eliza-1 v1 is
the un-fine-tuned Gemma 4 base.

Gemma 4 architecture (relevant to memory + KV budgets):

  - DENSE transformer. No Gated-DeltaNet / SSM / linear attention, and no
    3:1 hybrid linear:full ratio — every layer is a real attention layer.
  - Attention alternates local sliding-window (SWA, window 512/1024) with
    periodic global full-attention (pattern: 4× SWA then 1× global). Most
    layers are windowed SWA, so their KV is bounded by the window, not the
    full context.
  - MQA: a single KV head (`n_head_kv=1`) shared across query heads.
  - Dual RoPE + dual head dims: 512 for global layers, 256 for SWA layers.
  - Shared KV cache: a block of upper layers reuse a lower layer's KV
    (E2B shares 20 layers), so only ~15 of 35 layers carry their own KV.
  - Per-Layer Embeddings (PLE): a per-layer embedding table (dim 256 on E2B)
    that is pinned to CPU on GPU backends.
  - Tokenizer: Gemma 4 SentencePiece-BPE, vocab_size=262144,
    `tokenizer.ggml.model = "gemma4"`. Chat turns use
    ``<start_of_turn>role\\n … <end_of_turn>`` with ``<bos>`` / ``<eos>``.

The active entries map onto the size-first ``eliza-1-*`` tier ids used
by the runtime model catalog (``packages/shared/src/local-inference/catalog.ts``
— ``ELIZA_1_TIER_IDS`` / ``MODEL_CATALOG``). The registry keys are the Gemma 4
base names; the user-facing ``eliza_short_name`` stays size-first:

  - ``gemma4-e2b`` → ``google/gemma-4-E2B`` → ``eliza-1-2b``   (mobile/entry; E2B ~2.3B effective, 4.65B with PLE+embeddings; 128k ctx)
  - ``gemma4-e4b`` → ``google/gemma-4-E4B`` → ``eliza-1-4b``   (local; E4B ~4.5B effective; 128k ctx)
  - ``gemma4-12b`` → ``google/gemma-4-12B`` → ``eliza-1-9b``   (workstation; 12B unified dense, encoder-free; 256k ctx)
  - ``gemma4-31b`` → ``google/gemma-4-31B`` → ``eliza-1-27b``  (cloud; 31B dense; 256k ctx; gpu-h200x2)

The 0.8B tier was retired — it no longer exists in the runtime catalog and
has no Gemma 4 base.

All active bases are published on the Hub. The 9b/27b tiers need workstation /
cloud-class GPUs (or FSDP). MTP speculative decode now uses Gemma 4's official
*separate* drafter models (a distinct GGUF), not a same-file NextN head. See
``MTP_DRAFTER_BASE`` below.

The numbers below are observed-or-projected memory budgets for full-parameter
SFT with APOLLO at the listed sequence length. They are *budgets* — the
actual training script logs real memory through ``instrumentation.py`` and
will fail loud if reality exceeds the budget by more than 10%.

The ``infer_mem_gb_*`` inference budgets here are APPROXIMATE for Gemma 4:
the simple per-token KV formula (heads × head_dim × kv_layers × ctx) assumes
every KV-bearing layer holds the full context at the global head_dim (512).
On Gemma most KV-bearing layers are windowed SWA (bounded, head_dim 256), so
the simple formula OVERESTIMATES KV memory. These numbers are marked
approximate-pending a Gemma-aware (windowed-SWA + dual-head-dim) KV model.
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
    (B*S*V*4 bytes; Gemma 4 vocab=262144 makes this dominant). With Liger
    kernel fused chunked CE we can roughly 4× this on the same VRAM budget.

    This is a *default* — `scripts/train_local.py` and `scripts/run_pipeline.py`
    both accept ``--max-seq-len <int>`` to override per run. CLI flags always
    win over registry values (see ``train_local.py`` arg-merge near
    ``args.max_seq_len == ap.get_default("max_seq_len")``). The 27B default
    is intentionally conservative (64k) so the registry's memory budget
    leaves real headroom on a 2× H200 / 2× B200 cluster; bump it via
    ``--max-seq-len`` for long-context runs when you've validated capacity
    with ``scripts/training/memory_calc.py --shape gemma4-31b``."""

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
    standard target on the entry/local tiers; the 9b/27b Gemma 4 bases run a
    256k native context, so those tiers push higher when the KV-cache budget
    permits."""

    infer_max_out: int = 16384
    """Maximum *output* generation length budget for inference. 16k covers
    long agent traces + reasoning chains."""

    infer_kv_layers: int = 0
    """Number of KV-bearing layers — global full-attention layers plus the
    SWA layers that carry their own (non-shared) KV. Gemma 4 shares a block
    of upper layers' KV with a lower layer, so this is well below the total
    layer count (E2B: ~15 of 35). NOTE: this simple count treats every
    KV-bearing layer as full-context at the global head_dim, but most are
    windowed SWA, so the derived memory OVERESTIMATES — see the module
    docstring. Verify per-tier against config.json."""

    infer_kv_heads: int = 1
    """KV head count. Gemma 4 uses MQA — a single KV head shared across the
    query heads."""

    infer_kv_head_dim: int = 512
    """Head dimension for the KV cache. Gemma 4 has DUAL head dims: 512 on the
    global full-attention layers, 256 on the windowed SWA layers. We use the
    global 512 here, which inflates the SWA contribution — another reason the
    derived KV memory is approximate-pending a Gemma-aware KV model."""

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

    TurboQuant weight-quant + the GGUF flavors apply to Gemma 4. The KV
    compressors (QJL / PolarQuant) are LOW ROI on Gemma — its KV is already
    minimal (MQA + windowed SWA + shared KV) — so they are not part of the
    required set for these entries.
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
    *,
    params_billion: float,
    kv_layers: int,
    kv_heads: int,
    kv_head_dim: int,
    total_ctx: int,
) -> tuple[float, float]:
    """Compute (bf16_total_gb, full-quant-stack_total_gb) for an entry.

    bf16 = full-precision weights + bf16 K/V cache.
    Full quant stack = PolarQuant 4-bit weights + QJL 1-bit K (realized
        7.53× from per-token norm overhead, not the marketing 16×) +
        TurboQuant 4-bit V.

    On Gemma 4 the KV compressors are low ROI (already-minimal MQA + windowed
    SWA + shared KV), and this formula treats every KV-bearing layer as
    full-context at the global head_dim, so both columns OVERESTIMATE Gemma
    KV memory. Treat the resulting ``infer_mem_gb_*`` fields as approximate
    until a Gemma-aware (windowed-SWA + dual-head-dim) KV model lands.
    """
    weight_bytes_bf16 = params_billion * 1e9 * 2.0
    weight_bytes_q4 = params_billion * 1e9 * 0.5
    bf16_per_elem = 2.0
    qjl_per_elem = 2.0 / 7.53  # measured K-side ratio, proj_dim=256
    tq4_per_elem = 0.5  # TurboQuant 4-bit V

    elems_per_token = kv_heads * kv_head_dim * kv_layers
    kv_bytes_bf16 = elems_per_token * total_ctx * (bf16_per_elem + bf16_per_elem)
    kv_bytes_q4 = elems_per_token * total_ctx * (qjl_per_elem + tq4_per_elem)
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
# base model. Active entries are Gemma 4 DENSE transformers with alternating
# local SWA + periodic global full-attention (pattern: 4× SWA then 1× global),
# MQA (n_head_kv=1), dual head dims (512 global / 256 SWA), and a shared-KV
# block. The KV-bearing layer count is (global layers) + (non-shared SWA
# layers), well below the total layer count.
#   total layers   q_heads  kv_heads  head_dim(global/swa)  vocab    (HF base id)
#   35 (7 global)  8        1 (MQA)   512 / 256             262144   google/gemma-4-E2B → eliza-1-2b  (sliding_window=512, shared_kv_layers=20 → ~15 KV-bearing)
#
# MTP speculative-decode drafter, per eliza tier id. Google ships the OFFICIAL
# MTP head with the `-it-assistant` checkpoint of each Gemma 4 size — a distinct
# `gemma4-assistant`-arch model (4-block NextN drafter: `nextn.pre_projection` +
# `nextn.post_projection`), NOT a same-file NextN head and NOT a distilled
# student. Convert it to GGUF with upstream `convert_hf_to_gguf.py` (arch
# `gemma4-assistant`) and load it via `-md <drafter>.gguf --spec-type draft-mtp`.
# NO H200 / distillation is required — the trained weights already exist.
# Validated 2026-06-23: the E2B drafter (GGUF `amaranus/Gemma-4-E2B-it-qat-
# assistant-MTP-Q8_0`) gives a 1.29x decode speedup against the eliza-1-2b
# target on Apple M4 Max Metal (see
# plugins/plugin-local-inference/docs/gemma4-assistant-fork-port-plan.md).
MTP_DRAFTER_BASE: dict[str, str] = {
    # Official Gemma 4 assistant MTP heads (gemma4-assistant arch), per target
    # tier. Ready GGUF conversions: amaranus/Gemma-4-{E2B,E4B}-it-qat-assistant-
    # MTP-Q8_0-GGUF, {cortexist,Janvitos}/gemma-4-12B-it-assistant-MTP-GGUF.
    "eliza-1-2b": "google/gemma-4-E2B-it-assistant",
    "eliza-1-4b": "google/gemma-4-E4B-it-assistant",
    "eliza-1-9b": "google/gemma-4-12B-it-assistant",
    "eliza-1-27b": "google/gemma-4-31B-it-assistant",
}

REGISTRY: dict[str, ModelEntry] = {
    # ─────────────────────────── REAL ENTRIES ───────────────────────────
    # Buildable Gemma 4 dense base models, mapped onto the size-first
    # eliza-1 tier ids in packages/shared/src/local-inference/catalog.ts.
    # Full-parameter SFT with APOLLO + Liger; the entry/local-tier budgets
    # target a single consumer GPU, the 9b/27b tiers use workstation/cloud
    # GPUs (or FSDP).
    #
    # All Gemma 4 bases carry the 262144 SentencePiece-BPE tokenizer; the HF
    # causal-LM loss upcasts logits to fp32 (B*S*V*4 bytes), so Liger fused
    # chunked CE is what keeps the listed seq_len inside the budget (the 262k
    # vocab makes this transient the dominant long-seq term). Inference
    # budgets here are approximate — Gemma's windowed-SWA + shared-KV + MQA
    # KV is much smaller than the simple per-token formula implies (see the
    # module docstring); the runtime catalog applies its own KV handling.
    #
    # The 0.8B tier was retired (no Gemma 4 base, dropped from the catalog).
    #
    # params_billion uses EFFECTIVE sizes for budget realism (E2B ~2.3B,
    # E4B ~4.5B); E2B's with-PLE/embeddings footprint is ~4.65B (noted below).
    "gemma4-e2b": _entry(
        hf_id="google/gemma-4-E2B",
        short_name="gemma4-e2b",
        eliza_short_name="eliza-1-2b",
        eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=2.3,
        tier=Tier.LOCAL,
        seq_len=8192,
        optimizer="apollo_mini",
        optimizer_rank=1,
        micro_batch=1,
        grad_accum=16,
        train_mem_gb_budget=15.5,
        train_dtype="bf16",
        infer_max_in=131072,
        infer_max_out=16384,
        # ~15 KV-bearing of 35 layers (7 global + non-shared SWA; 20 shared).
        # Verify against google/gemma-4-E2B config.json.
        infer_kv_layers=15,
        infer_kv_heads=1,
        infer_kv_head_dim=512,
        quantization_after=(
            "turboquant",
            "gguf-q3_k_m",
            "gguf-q4_k_m",
            "gguf-q5_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Mobile/entry tier (eliza-1-2b) on google/gemma-4-E2B (E2B; "
        "~2.3B effective, ~4.65B with Per-Layer-Embeddings + token "
        "embeddings). Dense transformer, alternating SWA + global attention, "
        "MQA, 128k ctx. KV compressors (QJL/PolarQuant) are low-ROI on "
        "Gemma's already-minimal KV.",
    ),
    "gemma4-e4b": _entry(
        hf_id="google/gemma-4-E4B",
        short_name="gemma4-e4b",
        eliza_short_name="eliza-1-4b",
        eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=4.5,
        tier=Tier.LOCAL,
        seq_len=8192,
        optimizer="apollo_mini",
        optimizer_rank=1,
        micro_batch=1,
        grad_accum=16,
        train_mem_gb_budget=28.0,
        train_dtype="bf16",
        infer_max_in=131072,
        infer_max_out=16384,
        # Proportionate to E2B's ~15/35; verify against gemma-4-E4B config.json.
        infer_kv_layers=18,
        infer_kv_heads=1,
        infer_kv_head_dim=512,
        quantization_after=(
            "turboquant",
            "gguf-q3_k_m",
            "gguf-q4_k_m",
            "gguf-q5_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Local tier (eliza-1-4b) on google/gemma-4-E4B (E4B; ~4.5B "
        "effective). Full-param APOLLO SFT fits a single H200 easily. Dense "
        "Gemma 4 (SWA + global, MQA, PLE), 128k ctx.",
    ),
    "gemma4-12b": _entry(
        hf_id="google/gemma-4-12B",
        short_name="gemma4-12b",
        eliza_short_name="eliza-1-9b",
        eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=12.0,
        tier=Tier.WORKSTATION,
        seq_len=16384,
        optimizer="apollo",
        optimizer_rank=512,
        micro_batch=2,
        grad_accum=8,
        train_mem_gb_budget=80.0,
        train_dtype="bf16",
        # gemma4_unified (dense 12B/31B) has no validated Liger kernel path —
        # its fused RMSNorm/RoPE/CE assume the Gemma2/3 layout and NaN the
        # forward (all-NaN 12B checkpoint incident). Registry is the single
        # source of truth; train_local.py's arch-string check is the backstop.
        use_liger=False,
        infer_max_in=262144,
        infer_max_out=16384,
        # Proportionate KV-bearing count; verify against gemma-4-12B config.json.
        infer_kv_layers=20,
        infer_kv_heads=1,
        infer_kv_head_dim=512,
        quantization_after=(
            "turboquant",
            "gguf-q3_k_m",
            "gguf-q4_k_m",
            "gguf-q5_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Workstation tier (eliza-1-9b) on google/gemma-4-12B (12B "
        "unified dense, encoder-free; 256k ctx). Full-param APOLLO SFT uses "
        "Vast/FSDP.",
    ),
    "gemma4-31b": _entry(
        hf_id="google/gemma-4-31B",
        short_name="gemma4-31b",
        eliza_short_name="eliza-1-27b",
        eliza_repo_id="elizaos/eliza-1",
        abliteration_repo_id="",
        params_billion=31.0,
        tier=Tier.CLOUD,
        seq_len=65536,
        optimizer="apollo_mini",
        optimizer_rank=512,
        micro_batch=1,
        grad_accum=8,
        train_mem_gb_budget=210.0,
        train_dtype="bf16",
        # See gemma4-12b: gemma4_unified has no validated Liger path; keep it
        # off in the registry so the 31B tier is protected independent of the
        # train_local.py arch check.
        use_liger=False,
        infer_max_in=262144,
        infer_max_out=16384,
        # Proportionate KV-bearing count; verify against gemma-4-31B config.json.
        infer_kv_layers=28,
        infer_kv_heads=1,
        infer_kv_head_dim=512,
        quantization_after=(
            "turboquant",
            "gguf-q3_k_m",
            "gguf-q4_k_m",
            "gguf-q5_k_m",
            "gguf-q6_k",
            "gguf-q8_0",
        ),
        notes="Canonical cloud tier for eliza-1-27b on google/gemma-4-31B "
        "(31B dense; 256k ctx). Use this for the 27B release family.",
        extra={"vast_gpu_target": "h200-2x", "fsdp_world_size": "2"},
    ),
}


ELIZA_1_27B_VARIANT_ALIASES: dict[str, str] = {
    "27b": "gemma4-31b",
    "27b-256k": "gemma4-31b",
    "eliza-1-27b-256k": "gemma4-31b",
}

# Map the size-first eliza-1 tier ids (and common Gemma 4 base spellings) onto
# the canonical registry keys, so ad hoc scripts can resolve a tier without
# inventing unsupported keys.
GEMMA4_TIER_ALIASES: dict[str, str] = {
    "eliza-1-2b": "gemma4-e2b",
    "eliza-1-4b": "gemma4-e4b",
    "eliza-1-9b": "gemma4-12b",
    "eliza-1-27b": "gemma4-31b",
    "gemma-4-e2b": "gemma4-e2b",
    "gemma-4-e4b": "gemma4-e4b",
    "gemma-4-12b": "gemma4-12b",
    "gemma-4-31b": "gemma4-31b",
    "google-gemma-4-e2b": "gemma4-e2b",
    "google-gemma-4-e4b": "gemma4-e4b",
    "google-gemma-4-12b": "gemma4-12b",
    "google-gemma-4-31b": "gemma4-31b",
}


def get(name: str) -> ModelEntry:
    raw = name.strip()
    lowered = raw.lower()
    key = lowered.replace("/", "-").replace("_", "-")
    aliases = {
        "google/gemma-4-e2b": "gemma4-e2b",
        "google/gemma-4-e4b": "gemma4-e4b",
        "google/gemma-4-12b": "gemma4-12b",
        "google/gemma-4-31b": "gemma4-31b",
        **GEMMA4_TIER_ALIASES,
        **ELIZA_1_27B_VARIANT_ALIASES,
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


def by_tier(tier: Tier, include_legacy: bool = False) -> list[ModelEntry]:
    return [
        e
        for e in REGISTRY.values()
        if e.tier == tier and (include_legacy or e.extra.get("legacy") != "true")
    ]


def summary_table() -> str:
    cols = (
        "name",
        "params B",
        "tier",
        "train seq",
        "train mem",
        "infer ctx (in+out)",
        "infer bf16",
        "infer Q4+TQ",
        "optimizer",
    )
    rows = [cols]
    for e in REGISTRY.values():
        if e.extra.get("legacy") == "true":
            continue
        rows.append(
            (
                e.public_name,
                f"{e.params_billion:.1f}",
                e.tier.value,
                f"{e.seq_len}",
                f"{e.train_mem_gb_budget:.0f}GB",
                f"{e.infer_max_in}+{e.infer_max_out}",
                f"{e.infer_mem_gb_bf16_fullkv:.1f}GB",
                f"{e.infer_mem_gb_quantized:.1f}GB",
                f"{e.optimizer}@r{e.optimizer_rank}",
            )
        )
    widths = [max(len(r[i]) for r in rows) for i in range(len(cols))]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    return "\n".join(fmt.format(*r) for r in rows)


if __name__ == "__main__":
    print(summary_table())
