"""GPU memory calculator for the Eliza training + inference stack.

Models the memory optimizations we run in combination:

  - **APOLLO / APOLLO-Mini** (training)        — projected optimizer state
  - **PolarQuant** (inference)                  — weights ~0.5 bytes/param (4-bit)
  - **TurboQuant** (training & inference)       — V cache ~0.5 bytes/elem (4-bit)
  - **QJL** (inference, optionally training)    — K cache ~0.0625 bytes/elem (1-bit)
  - **Liger fused chunked CE** (training)       — fp32 logits transient ÷ chunks

Formula references:

  Weights        : params * dtype_bytes
  Gradients      : params * dtype_bytes  (same as weights, bf16)
  Optimizer state:
    APOLLO       : unprojected_params * 8 + 2D_weights * (rank/feat_in) * 8
    APOLLO-Mini  : unprojected_params * 8 + 2D_weights * 8 / feat_in   (rank=1)
  Activations    : O(B * S * H * L)  with full caching;
                   O(B * sqrt(S) * H * L) with gradient checkpointing.
  Logits transient: B * S * V * 4   (fp32 for HF loss); ÷ chunk_count with Liger.
  KV cache (full attn only):
    bf16 K/V     : 2 * heads_kv * head_dim * S * full_attn_layers * 2  bytes
    QJL K (1-bit): heads_kv * head_dim * S * full_attn_layers * 0.125  bytes
                   + projection_seed (negligible)
    TurboQuant V (4-bit): heads_kv * head_dim * S * full_attn_layers * 0.5 bytes

The calculator emits one line per memory bucket so an operator can see which
component dominates at a given seq_len. Consumed by:
  - `model_registry.py`           — back-fills `infer_mem_gb_*` fields
  - `train_local.py`              — instrumentation hard-ceiling check
  - `inference/serve_local.py`    — pre-flight
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Literal


GB = 1024 ** 3


class TrainOpt(str, Enum):
    # APOLLO is the canonical optimizer for all eliza-1 sizes.
    APOLLO = "apollo"
    APOLLO_MINI = "apollo_mini"


class WeightQuant(str, Enum):
    BF16 = "bf16"
    FP8 = "fp8"
    POLARQUANT_Q4 = "polarquant_q4"
    GGUF_Q4_K_M = "gguf_q4_k_m"


class KvKQuant(str, Enum):
    BF16 = "bf16"
    QJL_1BIT = "qjl_1bit"


class KvVQuant(str, Enum):
    BF16 = "bf16"
    TURBOQUANT_Q4 = "turboquant_q4"
    TURBOQUANT_Q3 = "turboquant_q3"


@dataclass(frozen=True)
class ModelShape:
    """Architectural facts the calculator needs."""
    name: str
    params_total: int
    """Total parameter count (MoE: full param count, NOT active)."""

    params_active: int = 0
    """Active params per token. For dense models: equals params_total.
    For MoE: the value advertised in the name (e.g. 3B for 35B-A3B)."""

    hidden_size: int = 0
    intermediate_size: int = 0
    num_layers: int = 0
    full_attn_layers: int = 0
    """KV-bearing full-attention layers (rest are linear-attention)."""

    kv_heads: int = 0
    kv_head_dim: int = 0
    vocab_size: int = 248_320
    """Qwen3.5/3.6 vocab (HF config.json `vocab_size`; verified against
    Qwen/Qwen3.5-{2B,9B} and Qwen/Qwen3.6-27B model cards)."""

    embedding_params: int = 0
    """Token embedding + lm_head — these stay in APOLLO's unprojected group.
    Set to 0 to skip the special-cased accounting."""

    twod_weight_params: int = 0
    """Sum of 2-D weight matrices (q/k/v/o/up/gate/down). These are what
    APOLLO low-rank-projects. Default: heuristic ≈ 0.85 * params_total."""

    def __post_init__(self):
        if self.params_active == 0:
            object.__setattr__(self, "params_active", self.params_total)
        if self.embedding_params == 0:
            object.__setattr__(
                self, "embedding_params",
                2 * self.hidden_size * self.vocab_size,
            )
        if self.twod_weight_params == 0:
            twod = self.params_total - self.embedding_params
            object.__setattr__(self, "twod_weight_params", max(0, twod))


@dataclass(frozen=True)
class TrainConfig:
    seq_len: int
    micro_batch: int = 1
    train_dtype: Literal["bf16", "fp8"] = "bf16"
    optimizer: TrainOpt = TrainOpt.APOLLO_MINI
    apollo_rank: int = 256
    use_liger: bool = True
    """Liger fused chunked CE divides the fp32 logits transient by chunk count."""
    liger_chunk_count: int = 8
    use_grad_checkpointing: bool = True
    use_flash_attn: bool = True
    """FA-2/3 reduces attention activations from O(S^2) to O(S) per layer."""
    fsdp_world_size: int = 1
    """If >1, weights+grads+opt-state shard across this many devices."""
    cpu_offload_optimizer: bool = False


@dataclass(frozen=True)
class InferConfig:
    seq_in: int
    seq_out: int
    weight_quant: WeightQuant = WeightQuant.BF16
    kv_k_quant: KvKQuant = KvKQuant.BF16
    kv_v_quant: KvVQuant = KvVQuant.BF16
    micro_batch: int = 1


@dataclass
class MemoryBreakdown:
    weights_gb: float = 0.0
    gradients_gb: float = 0.0
    optimizer_state_gb: float = 0.0
    activations_gb: float = 0.0
    logits_transient_gb: float = 0.0
    kv_cache_gb: float = 0.0
    misc_gb: float = 1.0
    """Buffers, workspace, framework overhead. Conservative 1 GB default."""

    @property
    def total_gb(self) -> float:
        return (self.weights_gb + self.gradients_gb + self.optimizer_state_gb
                + self.activations_gb + self.logits_transient_gb
                + self.kv_cache_gb + self.misc_gb)

    def lines(self) -> list[tuple[str, float]]:
        return [
            ("weights", self.weights_gb),
            ("gradients", self.gradients_gb),
            ("optimizer state", self.optimizer_state_gb),
            ("activations", self.activations_gb),
            ("logits transient", self.logits_transient_gb),
            ("kv cache", self.kv_cache_gb),
            ("misc / buffers", self.misc_gb),
        ]


# ─────────────────── helpers ───────────────────


def _weight_bytes_per_param(quant: WeightQuant) -> float:
    return {
        WeightQuant.BF16: 2.0,
        WeightQuant.FP8: 1.0,
        WeightQuant.POLARQUANT_Q4: 0.5,
        WeightQuant.GGUF_Q4_K_M: 0.55,  # ~4.5 bits/param effective
    }[quant]


def _kv_k_bytes_per_elem(quant: KvKQuant) -> float:
    """Bytes per K element (one value of head_dim within a KV head).

    QJL note: the marketing-headline 16× compression assumes zero overhead,
    but the actual stored payload is `(projection_dim / 8) + 2` bytes per
    head per token — packed sign sketch + bf16 norm — vs `head_dim * 2`
    bytes for the bf16 baseline. At the canonical `projection_dim=256` and
    `head_dim=128` (Qwen3 / Llama-3 / Qwen3.5 small models) the realized
    ratio is `head_dim*2 / (proj_dim/8 + 2) = 256/34 = 7.53×`, validated by
    the QJL agent's calibration probe on real K activations from
    Qwen/Qwen3-0.8B. We use 0.272 bytes/elem (= 2/7.53) here so the
    published budgets reflect reality, not the marketing number.
    """
    return {KvKQuant.BF16: 2.0, KvKQuant.QJL_1BIT: 2.0 / 7.53}[quant]


def _kv_v_bytes_per_elem(quant: KvVQuant) -> float:
    return {
        KvVQuant.BF16: 2.0,
        KvVQuant.TURBOQUANT_Q4: 0.5,
        KvVQuant.TURBOQUANT_Q3: 0.375,
    }[quant]


def kv_cache_bytes(shape: ModelShape, *, seq_total: int, batch: int = 1,
                   k_quant: KvKQuant = KvKQuant.BF16,
                   v_quant: KvVQuant = KvVQuant.BF16) -> int:
    """KV cache bytes at the given context length. Only full-attn layers
    contribute; linear-attention (Gated DeltaNet) layers carry constant SSM
    state independent of seq_len."""
    elems_per_token_per_layer = shape.kv_heads * shape.kv_head_dim
    total_elems = elems_per_token_per_layer * shape.full_attn_layers * seq_total * batch
    return int(total_elems * (_kv_k_bytes_per_elem(k_quant)
                              + _kv_v_bytes_per_elem(v_quant)))


def optimizer_state_bytes(shape: ModelShape, *, opt: TrainOpt,
                          rank: int = 256) -> int:
    """Bytes occupied by optimizer moment buffers."""
    embed = shape.embedding_params
    twod = shape.twod_weight_params
    other = shape.params_total - embed - twod
    # Embeddings + biases + norms stay in APOLLO's unprojected group.
    unprojected_params = embed + max(0, other)
    full_state = unprojected_params * 8
    if opt == TrainOpt.APOLLO:
        # 2-D weight grads project to rank-r before m/v storage.
        # Approximate per-tensor ratio: rank / mean(in_features). For Qwen
        # the projection MLPs/attention are roughly rank/H. Use rank/2048 as
        # a representative value for 2B and scale up for larger hidden sizes.
        ratio = rank / max(shape.hidden_size, 2048)
        twod_state = int(twod * 8 * ratio)
    elif opt == TrainOpt.APOLLO_MINI:
        # Rank-1 tensor scaling — state shrinks to roughly 2 fp32 scalars
        # per 2-D tensor, but the per-tensor scaling vector adds back some
        # constant. Empirically ~3% of full-state moments on 2-D weights.
        twod_state = int(twod * 8 * 0.03)
    else:
        raise ValueError(opt)
    return full_state + twod_state


def activations_bytes(shape: ModelShape, *, batch: int, seq_len: int,
                      use_grad_checkpointing: bool, use_flash_attn: bool,
                      train_dtype: str = "bf16") -> int:
    """Approximate activation memory.

    Without checkpointing: B * S * H * L * dtype_bytes (per-layer hidden
    states) + B * S^2 * head_count * L * dtype_bytes (per-layer attn scores).

    With FA-2/3: attention term drops to O(B * S * H).
    With grad checkpointing: hidden-state term drops by sqrt(L) — we keep
    only checkpoint boundaries.

    Constants are conservative — we deliberately overestimate so the budget
    check fails loud when reality is higher than expected.
    """
    dtype_bytes = 2 if train_dtype == "bf16" else 1
    H = shape.hidden_size
    L = shape.num_layers
    S = seq_len
    B = batch

    if use_grad_checkpointing:
        # With activation checkpointing we save only every ~sqrt(L) boundary;
        # everything in between is recomputed during backward.
        layer_factor = max(1, int(L ** 0.5))
    else:
        layer_factor = L

    hidden_bytes = B * S * H * layer_factor * dtype_bytes * 2  # *2 for residual stream
    if use_flash_attn:
        # FA-2/3 only materializes attention output (B*S*H per layer); the
        # quadratic score matrix is fused away. Checkpointing reduces this
        # by the same sqrt(L) factor.
        attn_bytes = B * S * H * layer_factor * dtype_bytes
    else:
        # Quadratic in S — this is the usual OOM path. Checkpointing helps
        # but not enough to save you when you forget to enable FlashAttention.
        attn_bytes = B * S * S * shape.kv_heads * layer_factor * dtype_bytes
    return hidden_bytes + attn_bytes


def logits_bytes(shape: ModelShape, *, batch: int, seq_len: int,
                 use_liger: bool, chunk_count: int) -> int:
    """fp32 logits transient on the loss path. Liger chunks the vocab dim."""
    full = batch * seq_len * shape.vocab_size * 4
    if use_liger:
        return full // max(chunk_count, 1)
    return full


# ─────────────────── public entry points ───────────────────


def estimate_train(shape: ModelShape, cfg: TrainConfig) -> MemoryBreakdown:
    # bf16 master weights are mandatory for stable optimizer updates. "fp8"
    # training (Transformer Engine, MX-FP8) keeps the bf16 masters AND a
    # transient fp8 weight cache used during fwd matmul, so the headline
    # weight footprint is 1.5x bf16, not 0.5x. Gradients stay bf16 either
    # way — the gradient all-reduce uses bf16, regardless of param dtype.
    if cfg.train_dtype == "fp8":
        weight_bytes_per_param = 3.0      # bf16 master + fp8 cache
    else:
        weight_bytes_per_param = 2.0
    weights = shape.params_total * weight_bytes_per_param
    grads = shape.params_total * 2.0      # bf16 grads always

    opt_bytes = optimizer_state_bytes(shape, opt=cfg.optimizer,
                                      rank=cfg.apollo_rank)

    if cfg.fsdp_world_size > 1:
        weights /= cfg.fsdp_world_size
        grads /= cfg.fsdp_world_size
        opt_bytes /= cfg.fsdp_world_size
    if cfg.cpu_offload_optimizer:
        opt_bytes = 0  # lives on CPU

    act = activations_bytes(
        shape, batch=cfg.micro_batch, seq_len=cfg.seq_len,
        use_grad_checkpointing=cfg.use_grad_checkpointing,
        use_flash_attn=cfg.use_flash_attn,
        train_dtype=cfg.train_dtype,
    )
    logits = logits_bytes(
        shape, batch=cfg.micro_batch, seq_len=cfg.seq_len,
        use_liger=cfg.use_liger, chunk_count=cfg.liger_chunk_count,
    )
    # KV cache during forward (training) — bf16, no value compression
    # because we'd lose the gradient. K and V both bf16.
    kv = kv_cache_bytes(
        shape, seq_total=cfg.seq_len, batch=cfg.micro_batch,
        k_quant=KvKQuant.BF16, v_quant=KvVQuant.BF16,
    )

    return MemoryBreakdown(
        weights_gb=weights / GB,
        gradients_gb=grads / GB,
        optimizer_state_gb=opt_bytes / GB,
        activations_gb=act / GB,
        logits_transient_gb=logits / GB,
        kv_cache_gb=kv / GB,
        misc_gb=2.0,  # CUDA workspace, NCCL, framework
    )


def estimate_infer(shape: ModelShape, cfg: InferConfig) -> MemoryBreakdown:
    bpp = _weight_bytes_per_param(cfg.weight_quant)
    weights = shape.params_total * bpp
    seq_total = cfg.seq_in + cfg.seq_out
    kv = kv_cache_bytes(
        shape, seq_total=seq_total, batch=cfg.micro_batch,
        k_quant=cfg.kv_k_quant, v_quant=cfg.kv_v_quant,
    )
    # Inference has no grads / opt state.
    # Activation transient at decode is small (one token at a time).
    act = shape.hidden_size * 2 * shape.num_layers  # one token per layer

    return MemoryBreakdown(
        weights_gb=weights / GB,
        gradients_gb=0.0,
        optimizer_state_gb=0.0,
        activations_gb=act / GB,
        logits_transient_gb=0.0,
        kv_cache_gb=kv / GB,
        misc_gb=0.5,
    )


# ─────────────────── shape catalog ───────────────────

# Architectural facts pulled directly from the Qwen3.5 / Qwen3.6 HF
# `config.json` (`text_config` block — these are multimodal image-text
# checkpoints whose LM-side hyperparameters live nested). The eliza-1
# series ships three sizes: 2B (local), 9B (workstation), 27B (cloud).
# Hybrid 3:1 linear:full attention pattern is the same across all three.
SHAPES: dict[str, ModelShape] = {
    # qwen3.5-0.8b is the smoke-only base (`smoke_full_stack.sh`); not part of
    # the eliza-1 production lineup but the preflight checker resolves it
    # when an operator provisions with `REGISTRY_KEY=qwen3.5-0.8b`. Numbers
    # from Qwen/Qwen3-0.8B config.json (vanilla full-attention transformer,
    # no hybrid GDN — full_attn_layers == num_layers).
    "qwen3.5-0.8b": ModelShape(
        name="qwen3.5-0.8b", params_total=596_049_920,
        hidden_size=1024, intermediate_size=3072, num_layers=28,
        full_attn_layers=28, kv_heads=8, kv_head_dim=128,
    ),
    "qwen3.5-2b": ModelShape(
        name="qwen3.5-2b", params_total=2_274_069_824,
        hidden_size=2048, intermediate_size=6144, num_layers=24,
        full_attn_layers=6, kv_heads=2, kv_head_dim=256,
    ),
    "qwen3.5-9b": ModelShape(
        name="qwen3.5-9b", params_total=9_000_000_000,
        hidden_size=4096, intermediate_size=12288, num_layers=32,
        full_attn_layers=8, kv_heads=4, kv_head_dim=256,
    ),
    "qwen3.6-27b": ModelShape(
        name="qwen3.6-27b", params_total=27_000_000_000,
        hidden_size=5120, intermediate_size=17408, num_layers=64,
        full_attn_layers=16, kv_heads=4, kv_head_dim=256,
    ),
}


def print_train_table(shape_name: str = "qwen3.6-27b") -> None:
    """Compare APOLLO variants across seq_len for the named shape."""
    s = SHAPES[shape_name]
    print(f"\n=== TRAINING memory — {shape_name} ===")
    cols = ("seq_len", "optimizer", "weights", "grads", "opt", "act", "logits", "kv", "TOTAL")
    print(("{:<8}  " + "{:<12}  " + "{:>8}  " * 7).format(*cols))
    for seq in (4096, 8192, 16384, 32768, 65536, 131072, 147456):
        for opt in (TrainOpt.APOLLO_MINI, TrainOpt.APOLLO):
            cfg = TrainConfig(seq_len=seq, optimizer=opt, use_liger=True)
            b = estimate_train(s, cfg)
            print(("{:<8}  " + "{:<12}  " + "{:>7.1f}G  " * 7).format(
                seq, opt.value, b.weights_gb, b.gradients_gb,
                b.optimizer_state_gb, b.activations_gb,
                b.logits_transient_gb, b.kv_cache_gb, b.total_gb,
            ))
        print()


def print_infer_table(shape_name: str = "qwen3.6-27b") -> None:
    """Sweep seq + quantization combos for inference."""
    s = SHAPES[shape_name]
    print(f"\n=== INFERENCE memory — {shape_name} ===")
    cols = ("ctx", "weights", "kv-K", "kv-V", "weights GB", "kv GB", "TOTAL")
    print(("{:<8}  " + "{:<14}  " * 3 + "{:>10}  " + "{:>8}  " + "{:>9}").format(*cols))
    for ctx in (32_768, 65_536, 131_072, 147_456, 262_144, 524_288, 1_048_576):
        for w_q, k_q, v_q in [
            (WeightQuant.BF16,           KvKQuant.BF16,     KvVQuant.BF16),
            (WeightQuant.POLARQUANT_Q4,  KvKQuant.BF16,     KvVQuant.BF16),
            (WeightQuant.POLARQUANT_Q4,  KvKQuant.BF16,     KvVQuant.TURBOQUANT_Q4),
            (WeightQuant.POLARQUANT_Q4,  KvKQuant.QJL_1BIT, KvVQuant.TURBOQUANT_Q4),
        ]:
            cfg = InferConfig(seq_in=ctx, seq_out=0,
                              weight_quant=w_q, kv_k_quant=k_q, kv_v_quant=v_q)
            b = estimate_infer(s, cfg)
            print(("{:<8}  " + "{:<14}  " * 3 + "{:>9.1f}G  " + "{:>7.1f}G  " + "{:>8.1f}G").format(
                ctx, w_q.value, k_q.value, v_q.value,
                b.weights_gb, b.kv_cache_gb, b.total_gb,
            ))
        print()


def fits(breakdown: MemoryBreakdown, *, gpu_gb: float, headroom_pct: float = 10.0) -> bool:
    """Does this configuration fit on a `gpu_gb` device with the given headroom?"""
    ceiling = gpu_gb * (1.0 - headroom_pct / 100.0)
    return breakdown.total_gb <= ceiling


# ─────────────────── target hardware catalog ───────────────────


# Per-GPU capacities. Multi-GPU clusters are expressed as `(hw_key, world_size)`
# pairs in CLUSTER_TARGETS so the fit checks compare per-GPU memory (which is
# what `estimate_train` returns when fsdp_world_size > 1) against per-GPU
# capacity — not against bogus cluster-aggregate capacity, which would
# understate per-GPU pressure roughly proportional to world_size.
HARDWARE: dict[str, float] = {
    # Local / consumer
    "rtx-5080-laptop":        16.0,
    "rtx-5090":               32.0,
    "rtx-pro-4000-blackwell": 24.0,
    "rtx-pro-5000-blackwell-48": 48.0,   # GDDR7, 1.34 TB/s, 300W
    "rtx-pro-5000-blackwell-72": 72.0,
    "rtx-pro-6000-blackwell": 96.0,      # 4th-gen Tensor, sm_120, GDDR7
    # Datacenter
    "a100-40":                40.0,
    "a100-80":                80.0,
    "h100-80":                80.0,
    "h200-141":              141.0,
    "b200-180":              180.0,
}


# Cluster target = (per-GPU hw key, FSDP world size). The label is what
# print_train_target_matrix prints in the column header.
CLUSTER_TARGETS: list[tuple[str, str, int]] = [
    ("h200-2x",         "h200-141",               2),
    ("h200-4x",         "h200-141",               4),
    ("h200-8x",         "h200-141",               8),
    ("h100-2x",         "h100-80",                2),
    ("h100-4x",         "h100-80",                4),
    ("blkw6000-2x",     "rtx-pro-6000-blackwell", 2),
    ("blkw6000-4x",     "rtx-pro-6000-blackwell", 4),
    ("blkw6000-8x",     "rtx-pro-6000-blackwell", 8),
]


def fits_on(breakdown: MemoryBreakdown, *, hw: str,
            headroom_pct: float = 10.0) -> tuple[bool, float]:
    """Per-GPU fit check: returns (fits, utilization_pct) against
    HARDWARE[hw] (per-GPU capacity). Pass the `breakdown` produced by
    `estimate_train` with `fsdp_world_size` matching the cluster — its
    `total_gb` is per-GPU once world_size>1.
    """
    cap = HARDWARE[hw]
    ceiling = cap * (1.0 - headroom_pct / 100.0)
    return breakdown.total_gb <= ceiling, 100.0 * breakdown.total_gb / cap


def print_train_target_matrix(shape_name: str = "qwen3.6-27b") -> None:
    """For each (seq_len, cluster) tuple, print per-GPU fit (the metric that
    actually decides whether the run OOMs). Both the per-GPU and the world-
    aggregate numbers are shown so it's clear what's sharded vs replicated.
    """
    s = SHAPES[shape_name]
    print(f"\n=== TRAINING fit matrix — {shape_name} (APOLLO-Mini, Liger, FA, ckpt) ===")
    print("  per-GPU GB (used / cap), comparing per-GPU memory against per-GPU capacity")
    header = "  ".join([f"{'seq_len':<8}"] + [f"{label:<22}" for label, _, _ in CLUSTER_TARGETS])
    print(header)
    for seq in (8192, 16384, 32768, 65536, 131072, 147456):
        cells = [f"{seq:<8}"]
        for _label, hw, world in CLUSTER_TARGETS:
            cfg = TrainConfig(
                seq_len=seq, optimizer=TrainOpt.APOLLO_MINI,
                fsdp_world_size=world, use_liger=True,
                use_grad_checkpointing=True, use_flash_attn=True,
            )
            b = estimate_train(s, cfg)
            ok, util = fits_on(b, hw=hw, headroom_pct=15.0)
            badge = "✓" if ok else "✗"
            cells.append(f"{badge} {b.total_gb:>5.0f}/{HARDWARE[hw]:.0f}GB ({util:>3.0f}%)".ljust(22))
        print("  ".join(cells))
    print()


def print_infer_target_matrix(shape_name: str = "qwen3.6-27b") -> None:
    """For each (context, hardware) tuple with full quant stack, print fit."""
    s = SHAPES[shape_name]
    targets = ["rtx-pro-5000-blackwell-48", "rtx-5090", "rtx-pro-6000-blackwell",
               "h100-80", "h200-141"]
    quant = (WeightQuant.POLARQUANT_Q4, KvKQuant.QJL_1BIT, KvVQuant.TURBOQUANT_Q4)
    print(f"\n=== INFERENCE fit — {shape_name} + PolarQuant + QJL-1bit + TurboQuant-4bit ===")
    header = "  ".join([f"{'context':<10}"] + [f"{h:<32}" for h in targets])
    print(header)
    for ctx in (32_768, 65_536, 131_072, 147_456, 262_144, 524_288, 1_048_576):
        cells = [f"{ctx:<10}"]
        cfg = InferConfig(seq_in=ctx, seq_out=0,
                          weight_quant=quant[0], kv_k_quant=quant[1],
                          kv_v_quant=quant[2])
        b = estimate_infer(s, cfg)
        for hw in targets:
            ok, util = fits_on(b, hw=hw, headroom_pct=10.0)
            badge = "✓" if ok else "✗"
            cells.append(f"{badge} {b.total_gb:>5.1f}/{HARDWARE[hw]:.0f}GB ({util:>3.0f}%)".ljust(32))
        print("  ".join(cells))
    print()


def max_context_for(
    shape_name: str, *, hw: str, headroom_pct: float = 10.0,
    weight_quant: WeightQuant = WeightQuant.POLARQUANT_Q4,
    kv_k_quant: KvKQuant = KvKQuant.QJL_1BIT,
    kv_v_quant: KvVQuant = KvVQuant.TURBOQUANT_Q4,
    architectural_max: int = 1_048_576,
) -> tuple[int, MemoryBreakdown]:
    """Largest input context that fits on `hw` with the given quant stack.

    Closed-form solution rather than binary search:
        cap_bytes        = HARDWARE[hw] * GB * (1 - headroom)
        weight_bytes     = params * bpp(weight_quant)
        misc_bytes       = 0.5 GB
        kv_bytes_per_tok = full_attn_layers * kv_heads * kv_head_dim
                          * (k_bpe + v_bpe)
        max_seq          = (cap_bytes - weight_bytes - misc_bytes)
                          / kv_bytes_per_tok
    Capped at the model's architectural ceiling (1M default).
    """
    s = SHAPES[shape_name]
    cap_bytes = HARDWARE[hw] * GB * (1.0 - headroom_pct / 100.0)
    weight_bytes = s.params_total * _weight_bytes_per_param(weight_quant)
    misc_bytes = 0.5 * GB
    kv_bpt = (s.full_attn_layers * s.kv_heads * s.kv_head_dim
              * (_kv_k_bytes_per_elem(kv_k_quant)
                 + _kv_v_bytes_per_elem(kv_v_quant)))
    if kv_bpt <= 0:
        max_seq = architectural_max
    else:
        max_seq = int(max(0, cap_bytes - weight_bytes - misc_bytes) // kv_bpt)
    max_seq = min(max_seq, architectural_max)
    cfg = InferConfig(seq_in=max_seq, seq_out=0,
                      weight_quant=weight_quant,
                      kv_k_quant=kv_k_quant, kv_v_quant=kv_v_quant)
    return max_seq, estimate_infer(s, cfg)


# ─────────────────── wall-time estimator ───────────────────


# Per-GPU peak bf16 throughput in TFLOPs/s (dense matmul, NVIDIA datasheets).
# These are MARKETING peaks — sustained MFU during long-seq FSDP training is
# typically 25-40%, so apply `mfu_pct` when computing wall time.
GPU_BF16_PEAK_TFLOPS: dict[str, float] = {
    "h200-141":              989.0,    # H200 SXM, dense bf16, no sparsity
    "h100-80":               989.0,    # H100 SXM (same gen)
    "a100-80":               312.0,
    "rtx-pro-6000-blackwell": 360.0,   # RTX Pro 6000 Blackwell, sm_120, dense
    "rtx-pro-5000-blackwell-48": 240.0,
    "rtx-pro-5000-blackwell-72": 240.0,
    "rtx-5090":              165.0,    # GB202, sm_120 consumer
    "b200-180":             2250.0,    # B200 SXM
}


def estimate_train_seconds(
    shape_name: str, *, hw: str, world_size: int, n_tokens: int,
    mfu_pct: float = 30.0, use_fp8: bool = False,
) -> tuple[float, dict[str, float]]:
    """Wall-clock seconds to train through `n_tokens` on `world_size × hw`.

    FLOPs/token = 6 × params_active (equals params_total for dense models;
    smaller for MoE where only top-k experts fire per token). Attention
    compute is ~10-20% extra at our seq_lens, folded into the MFU discount.

    FP8 path scales peak throughput by 1.7× on H100/H200/B200 (Meta/MS
    published numbers); on sm_120 / sm_80 we leave it at bf16 peak.
    """
    s = SHAPES[shape_name]
    flops_per_token = 6.0 * s.params_active
    total_flops = n_tokens * flops_per_token

    peak_tflops = GPU_BF16_PEAK_TFLOPS.get(hw)
    if peak_tflops is None:
        raise KeyError(f"no peak throughput entry for {hw!r}")
    fp8_boost = 1.7 if (use_fp8 and hw in ("h100-80", "h200-141", "b200-180")) else 1.0
    realized_tflops_per_gpu = peak_tflops * fp8_boost * (mfu_pct / 100.0)
    realized_total_tflops = realized_tflops_per_gpu * world_size

    wall_seconds = total_flops / (realized_total_tflops * 1e12)
    return wall_seconds, {
        "total_eflops": total_flops / 1e18,
        "realized_pflops_per_s": realized_total_tflops / 1e3,
        "wall_hours": wall_seconds / 3600,
    }


def print_train_time_matrix(
    shape_names: tuple[str, ...] = ("qwen3.5-9b", "qwen3.6-27b"),
    n_tokens: int = 1_000_000_000,
    mfu_pct: float = 30.0,
) -> None:
    """Per-(model, cluster) wall-time + cost estimate for `n_tokens` of training.

    Hourly prices are vast.ai on-demand snapshot — call them indicative; the
    vast.ai launcher reports live offers at run time.
    """
    HOURLY: dict[str, float] = {
        "h200-141":              3.20,   # 2× → $6.40/hr
        "h100-80":               2.40,
        "rtx-pro-6000-blackwell": 1.80,
        "rtx-pro-5000-blackwell-72": 1.20,
    }
    clusters = [
        ("2× H200 SXM",                  "h200-141",                2),
        ("4× H200 SXM",                  "h200-141",                4),
        ("2× H100 SXM",                  "h100-80",                 2),
        ("2× RTX 6000 Blackwell (96 GB)", "rtx-pro-6000-blackwell", 2),
        ("4× RTX 6000 Blackwell (96 GB)", "rtx-pro-6000-blackwell", 4),
    ]
    print(f"\n=== Wall time + cost — {n_tokens/1e9:.2f}B tokens (MFU={mfu_pct:.0f}%) ===")
    for name in shape_names:
        s = SHAPES[name]
        compute = s.params_active
        print(f"\n  {name} ({compute/1e9:.0f}B compute params/token, "
              f"6× = {6*compute/1e9:.0f} GFLOPs/token):")
        print(f"    {'cluster':<32} {'wall':>12} {'cost':>10} {'fp8 wall':>10} {'fp8 cost':>10}")
        for label, hw, world in clusters:
            sec, _ = estimate_train_seconds(name, hw=hw, world_size=world,
                                             n_tokens=n_tokens, mfu_pct=mfu_pct)
            sec_fp8, _ = estimate_train_seconds(name, hw=hw, world_size=world,
                                                 n_tokens=n_tokens, mfu_pct=mfu_pct,
                                                 use_fp8=True)
            cost = (sec / 3600) * world * HOURLY.get(hw, 0)
            cost_fp8 = (sec_fp8 / 3600) * world * HOURLY.get(hw, 0)
            print(f"    {label:<32} {sec/3600:>10.1f}h "
                  f"${cost:>8.0f} {sec_fp8/3600:>8.1f}h ${cost_fp8:>8.0f}")


def print_max_context_matrix(shape_names: tuple[str, ...] = ("qwen3.5-9b", "qwen3.6-27b")) -> None:
    """For each (model, hardware) tuple, the largest context that fits with
    the full quant stack."""
    targets = [
        ("rtx-5090",                  "RTX 5090 (32 GB)"),
        ("rtx-pro-5000-blackwell-48", "RTX Pro 5000 Blackwell (48 GB)"),
        ("rtx-pro-5000-blackwell-72", "RTX Pro 5000 Blackwell (72 GB)"),
        ("rtx-pro-6000-blackwell",    "RTX Pro 6000 Blackwell (96 GB)"),
        ("h100-80",                   "H100 (80 GB)"),
        ("h200-141",                  "H200 (141 GB)"),
    ]
    print("\n=== Max input context with PolarQuant-Q4 + QJL-1bit + TurboQuant-Q4 ===")
    for name in shape_names:
        s = SHAPES[name]
        print(f"\n  {name} (params_total={s.params_total/1e9:.1f}B, "
              f"full_attn_layers={s.full_attn_layers}, "
              f"kv_head_dim={s.kv_head_dim}):")
        print(f"    {'hardware':<32} {'max ctx':>14}  {'used / cap':<22}  notes")
        for hw, label in targets:
            max_seq, b = max_context_for(name, hw=hw)
            cap = HARDWARE[hw]
            util = 100 * b.total_gb / cap
            note = ""
            if max_seq >= 1_048_576:
                note = "≥1M (capped at architectural max)"
            elif max_seq < 32_768:
                note = "BELOW 32k — too small"
            print(f"    {label:<32} {max_seq:>14,}  "
                  f"{b.total_gb:>5.1f} / {cap:.0f} GB ({util:>3.0f}%)  {note}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--shape", default="qwen3.6-27b",
                    choices=sorted(SHAPES))
    ap.add_argument("--mode", default="all",
                    choices=("train", "infer", "fit", "time", "all"))
    ap.add_argument("--n-tokens", type=float, default=1e9,
                    help="Token budget for time/cost estimate (default 1B).")
    ap.add_argument("--mfu", type=float, default=30.0,
                    help="Realized MFU percentage for time estimate.")
    args = ap.parse_args()
    if args.mode in ("train", "all"):
        print_train_table(args.shape)
    if args.mode in ("infer", "all"):
        print_infer_table(args.shape)
    if args.mode in ("fit", "all"):
        print_train_target_matrix(args.shape)
        print_infer_target_matrix(args.shape)
    if args.mode in ("time", "all"):
        print_train_time_matrix(n_tokens=int(args.n_tokens), mfu_pct=args.mfu)
    if args.mode == "all":
        print_max_context_matrix()
