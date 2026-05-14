"""Hybrid linear-attention + full-attention KV cache for active Qwen3.5 models.

Background
----------

Qwen3.5 (``Qwen3_5ForCausalLM`` / ``Qwen3_5ForConditionalGeneration``,
likewise the ``-MoE`` text variants) interleaves two attention types on a 4-layer
period:

    layer 0..2   : Gated DeltaNet (``linear_attention``)
    layer 3      : standard self-attention (``full_attention``)
    layer 4..6   : Gated DeltaNet
    layer 7      : standard self-attention
    ...

Each layer type needs a different cache. Linear-attention layers carry an SSM-
style recurrent state plus a small conv state (no per-token KV). Full-attention
layers carry a standard ``(B, H, T, D)`` KV cache.

HuggingFace's ``Cache`` already supports this if you build it correctly: pass
``DynamicCache(config=model.config)`` and it pre-builds the right per-layer
mixin. The crash this module fixes is what happens when we wrap that cache
with a quantizer that does NOT pre-populate the layer list, e.g.
``fused_turboquant.hf.fused_cache.CompressedKVCache(DynamicCache)`` calls
``super().__init__()`` with no config, so the cache holds zero layers, and the
first time the Qwen3.5 model calls ``has_previous_state(layer_idx=0)`` (which
is a Gated DeltaNet layer), the parent ``Cache.has_previous_state`` walks the
empty layer list, finds no ``LinearAttentionCacheLayerMixin`` and either
returns False (lucky) or raises::

    ValueError: `has_previous_state` can only be called on LinearAttention
    layers, and the current Cache seem to only contain Attention layers.

``ElizaHybridCache`` solves this by being layer-type-aware from the start.
For each entry of ``model.config.get_text_config(decoder=True).layer_types``
we install:

    * ``"linear_attention"``  -> ``LinearAttentionLayer`` (SSM/conv state)
    * ``"full_attention"``    -> a backend-chosen layer:

        - ``bf16``               (``DynamicLayer``, default fallback)
        - ``fused_turboquant``   (delegates to ``CompressedKVCache``)
        - ``qjl_full``           (QJL on K + TurboQuant on V; needs the QJL
                                  CUDA extension to be built — falls back
                                  loudly if the kernel isn't available)

In the ``fused_turboquant`` and ``qjl_full`` modes we do NOT just hand the
model a CompressedKVCache: those classes hold a flat list of compressed K/V
slots indexed by ``layer_idx`` directly, so a Gated DeltaNet layer at
``layer_idx=0`` would write conv state into slot 0 of the compressed list
and then a full-attention layer at ``layer_idx=3`` would write a key tensor
into slot 3, with all the linear-attention slots in between left as
``None`` placeholders. That's broken in two ways: (1) the model still tries
to call ``update_conv_state(...)`` / ``update_recurrent_state(...)`` on
slot 0 and the quantizer's parent has no such methods, (2) the patched
fused-attention forward expects to read its own slot back as a packed-key
dict, not a conv state.

So the wiring is: ``ElizaHybridCache`` is the single object the model sees
as ``past_key_values``. Its ``self.layers`` is a heterogeneous list (per
``layer_types``). For ``fused_turboquant`` / ``qjl_full``, the cache also
holds a side ``CompressedKVCache`` that the patched fused-attention forward
closures reference by closure, and the corresponding entries of
``self.layers`` are ``DynamicLayer`` placeholders that just track sequence
length so HF's cache bookkeeping (``get_seq_length`` etc.) stays correct.

The model's own forward path calls ``self.layers[layer_idx].update(...)``
through ``Cache.update``. For full-attention layers under fused_turboquant
the caller is the patched fused forward, which calls
``cache.update(dummy_keys, dummy_values, layer_idx)`` where ``cache`` is
the side ``CompressedKVCache`` — but ``ElizaHybridCache`` IS that side
cache (we use composition by inheriting the ``store_compressed_*``,
``get_compressed_*``, ``decode_values`` methods directly). The
``DynamicLayer`` placeholder in ``self.layers[layer_idx]`` collects the
single-coord ``dummy_keys`` so that ``get_seq_length`` returns the right
number.

Multimodal models (``Qwen3_5ForConditionalGeneration``) wrap the text
decoder under ``model.language_model``. We don't load those here — the
factory raises with a clear pointer to ``AutoModelForImageTextToText``
when given one.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import torch
from transformers.cache_utils import (
    Cache,
    DynamicLayer,
    LinearAttentionCacheLayerMixin,
    LinearAttentionLayer,
)

log = logging.getLogger(__name__)


_KNOWN_HYBRID_MODEL_TYPES = {
    "qwen3_5",
    "qwen3_5_moe",
    "qwen3_5_text",
    "qwen3_5_moe_text",
    "qwen3_6",
    "qwen3_6_moe",
    "qwen3_6_text",
    "qwen3_6_moe_text",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def has_hybrid_layer_types(model) -> bool:
    """True iff ``model.config.layer_types`` mixes linear and full attention."""
    cfg = _resolve_text_config(model)
    layer_types = getattr(cfg, "layer_types", None)
    if not layer_types:
        return False
    types = set(layer_types)
    return "linear_attention" in types and (
        "full_attention" in types or "sliding_attention" in types
    )


def make_hybrid_cache(
    model,
    *,
    full_attn_backend: str = "bf16",
    bits: int = 4,
    compress_v: bool = True,
    qjl_value_bits: int = 4,
    verify_fused: bool = False,
) -> "ElizaHybridCache":
    """Build a hybrid cache matched to ``model.config.layer_types``.

    Parameters
    ----------
    model:
        A HF causal-LM model whose text decoder uses ``layer_types`` mixing
        ``linear_attention`` and ``full_attention``. Multimodal-wrapped
        models (e.g. ``Qwen3_5ForConditionalGeneration``) are rejected;
        load the text decoder via ``AutoModelForCausalLM`` instead.
    full_attn_backend:
        One of ``"bf16"``, ``"fused_turboquant"``, ``"qjl_full"``.
    bits:
        KV bit-width for ``fused_turboquant`` (3 or 4).
    compress_v:
        Whether to compress V as well (otherwise K-only) for fused_turboquant.
    qjl_value_bits:
        V-side bit-width for ``qjl_full`` (uses TurboQuant on V).
    verify_fused:
        Run fused-turboquant's smoke test after patching. Default False so
        callers can opt in.
    """
    arch_name = type(model).__name__
    if "ForConditionalGeneration" in arch_name:
        raise ValueError(
            f"{arch_name} is a multimodal model. ElizaHybridCache wraps the "
            "text decoder only. Load the text decoder with "
            "AutoModelForCausalLM (which resolves Qwen3_5Config -> "
            "Qwen3_5ForCausalLM), or extract the decoder manually via "
            "model.language_model and re-wrap that here."
        )
    text_cfg = _resolve_text_config(model)
    layer_types = list(getattr(text_cfg, "layer_types", []) or [])
    if not layer_types:
        raise ValueError(
            f"Model {arch_name} has no `layer_types` on its text config — "
            "this isn't a hybrid architecture. Use a plain DynamicCache."
        )

    cache = ElizaHybridCache(
        layer_types=layer_types,
        text_config=text_cfg,
        full_attn_backend=full_attn_backend,
        bits=bits,
        compress_v=compress_v,
        qjl_value_bits=qjl_value_bits,
    )
    if full_attn_backend == "fused_turboquant":
        cache.attach_fused_turboquant(model, verify=verify_fused)
    elif full_attn_backend == "qjl_full":
        cache.attach_qjl(model)
    elif full_attn_backend == "bf16":
        pass
    else:
        raise ValueError(
            f"unknown full_attn_backend {full_attn_backend!r}; expected one of "
            "'bf16', 'fused_turboquant', 'qjl_full'"
        )
    return cache


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_text_config(model_or_config):
    """Return the text/decoder config from a model or config."""
    cfg = getattr(model_or_config, "config", model_or_config)
    if hasattr(cfg, "get_text_config"):
        try:
            return cfg.get_text_config(decoder=True)
        except TypeError:
            return cfg.get_text_config()
    if hasattr(cfg, "text_config"):
        return cfg.text_config
    return cfg


# ---------------------------------------------------------------------------
# ElizaHybridCache
# ---------------------------------------------------------------------------


class ElizaHybridCache(Cache):
    """Hybrid cache for active Qwen3.5 style linear+full attention models.

    The cache holds one ``self.layers[i]`` per ``layer_types[i]``. Linear-
    attention slots get a ``LinearAttentionLayer`` (SSM + conv state).
    Full-attention slots get a backend-specific layer:

      * ``bf16``             -> ``DynamicLayer`` (vanilla)
      * ``fused_turboquant`` -> ``DynamicLayer`` placeholder; the real
                                compressed K/V live on this object's
                                ``_compressed_keys`` / ``_compressed_values``
                                lists, indexed by layer_idx, and the patched
                                attention forward closures call our
                                ``store_compressed_key`` / ``..._value`` /
                                ``get_compressed_*`` / ``decode_values``
                                methods directly.
      * ``qjl_full``         -> ``DynamicLayer`` placeholder; QJL+TurboQuant
                                state lives on side dicts. Requires the QJL
                                CUDA extension to be built; falls back loudly.

    The cache exposes the same ``store_compressed_*`` / ``get_compressed_*``
    / ``decode_values`` API as ``fused_turboquant.hf.fused_cache.CompressedKVCache``
    so the patched fused forward closures don't care which class instance
    they're talking to.
    """

    def __init__(
        self,
        *,
        layer_types: list[str],
        text_config,
        full_attn_backend: str = "bf16",
        bits: int = 4,
        compress_v: bool = True,
        qjl_value_bits: int = 4,
    ):
        # Pre-populate self.layers per layer_types so the model's calls to
        # has_previous_state(layer_idx) and update_conv_state(layer_idx) hit
        # the right layer-type instance from the very first forward.
        layers: list = []
        sliding_window = (
            getattr(text_config, "sliding_window", None)
            or getattr(text_config, "attention_chunk_size", None)
        )
        for lt in layer_types:
            if lt in ("linear_attention", "mamba", "conv", "moe"):
                layers.append(LinearAttentionLayer())
            elif lt in ("sliding_attention", "chunked_attention"):
                # Treat as full-attention for cache purposes; the model still
                # masks correctly. We don't currently quantize sliding layers.
                from transformers.cache_utils import DynamicSlidingWindowLayer
                layers.append(DynamicSlidingWindowLayer(sliding_window=sliding_window))
            else:
                # full_attention or anything else we don't recognize
                layers.append(DynamicLayer())

        super().__init__(layers=layers, offloading=False)

        self.layer_types = layer_types
        self.text_config = text_config
        self.full_attn_backend = full_attn_backend
        self.bits = bits
        self.compress_v = compress_v
        self.qjl_value_bits = qjl_value_bits

        # Side storage for the fused_turboquant / qjl_full backends. Indexed
        # by layer_idx (matches the patched forward's expectations); linear-
        # attention slots remain None forever.
        n = len(layer_types)
        self._compressed_keys: list[Optional[dict]] = [None] * n
        self._compressed_values: list[Optional[dict]] = [None] * n
        self._tq = None
        self._fused_originals: dict = {}
        self._qjl_state: dict = {}

    # -- factory hooks --------------------------------------------------------

    def attach_fused_turboquant(self, model, *, verify: bool = False) -> None:
        """Patch full-attention layers in `model` to use Triton-fused TQ kernels.

        Imports the vendored fused_turboquant lazily so the module loads
        without it. The vendored copy under
        ``scripts/quantization/fused_turboquant_vendored/`` patches the
        upstream ``make_fused_attention_forward`` to handle Qwen3.5
        gated attention (chunked q_proj + sigmoid(gate) post-multiply).
        """
        try:
            from quantization.fused_turboquant_vendored.core.quantizer import (
                TurboQuantMSE,
            )
            from quantization.fused_turboquant_vendored.hf.fused_cache import (
                _is_full_attention_layer,
                _resolve_compress_v,
                make_fused_attention_forward,
            )
        except ImportError as e:
            raise RuntimeError(
                "full_attn_backend='fused_turboquant' requires the vendored "
                "fused_turboquant package at "
                "scripts/quantization/fused_turboquant_vendored/. "
                f"Original error: {e}"
            ) from e

        cfg = self.text_config
        head_dim = getattr(cfg, "head_dim", None) or (
            cfg.hidden_size // cfg.num_attention_heads
        )
        if head_dim < 1 or (head_dim & (head_dim - 1)) != 0:
            raise ValueError(
                f"fused-turboquant requires power-of-2 head_dim; got {head_dim}. "
                "Hybrid Qwen3.5 models with head_dim=256 are fine; smaller "
                "non-power-of-2 dims are not supported by the RHT."
            )

        # Soft-warn for gated attention on architectures we haven't tested.
        # Qwen3.5 is explicitly supported by the vendored patch;
        # anything else with attn_output_gate=true falls back to the same
        # codepath but hasn't been smoke-tested by us.
        attn_output_gate = getattr(cfg, "attn_output_gate", False)
        arch_name = type(model).__name__
        _gated_known = (
            "Qwen3_5" in arch_name
            or arch_name.startswith("Qwen3_5")
        )
        if attn_output_gate and not _gated_known:
            log.warning(
                "fused_turboquant: model %s reports attn_output_gate=true but "
                "is not in the tested set (Qwen3.5/3.6). The vendored gated "
                "patch assumes the Qwen3.5 layout: q_proj outputs "
                "2*n_heads*head_dim chunked into (query, gate) with the gate "
                "multiplied as sigmoid(gate) on the flattened post-attention "
                "output. If your model uses a different gating convention, "
                "fall back to full_attn_backend='bf16'.",
                arch_name,
            )

        device = next(model.parameters()).device
        self._tq = TurboQuantMSE(head_dim=head_dim, bits=self.bits, device=str(device))

        # Walk the model and patch ONLY full-attention layers. Linear-attention
        # (Qwen3_5GatedDeltaNet) layers don't expose q_proj/k_proj/v_proj, so
        # _is_full_attention_layer naturally skips them. As an extra safety
        # check we also skip layers whose layer_idx maps to "linear_attention".
        eligible_layer_idx = {
            i for i, t in enumerate(self.layer_types) if t == "full_attention"
        }
        # The model lists Qwen3_5DecoderLayer modules under model.model.layers.
        # Each decoder layer that is full_attention has self_attn = Qwen3_5Attention.
        # We patch self_attn directly so the cache write uses the fused path.
        decoder_layers = self._resolve_decoder_layers(model)
        v_compressed = 0
        patched = 0
        for i, layer_module in enumerate(decoder_layers):
            if i not in eligible_layer_idx:
                continue
            attn = getattr(layer_module, "self_attn", None)
            if attn is None or not _is_full_attention_layer(attn, f"layer.{i}.self_attn"):
                continue
            layer_compress_v = _resolve_compress_v(
                self.compress_v, len(self._fused_originals), len(eligible_layer_idx),
            )
            if layer_compress_v:
                v_compressed += 1
            self._fused_originals[i] = attn.forward
            attn.forward = make_fused_attention_forward(
                attn, self, self._tq, i, config=cfg,
                compress_v=layer_compress_v,
            )
            patched += 1

        if patched == 0:
            raise RuntimeError(
                "fused_turboquant backend selected but no full_attention "
                "layers were patched. Check that the model exposes "
                "model.model.layers[i].self_attn with q_proj/k_proj/v_proj on "
                "full-attention layers."
            )
        log.info(
            "fused-turboquant: patched %d full-attention layers (%d-bit, "
            "compress_v=%d/%d)", patched, self.bits, v_compressed, patched,
        )

        if verify:
            from quantization.fused_turboquant_vendored.hf.fused_cache import (
                _smoke_test,
            )
            _smoke_test(model, self, self._fused_originals, cfg, head_dim)
            self.reset()

    def detach_fused_turboquant(self, model) -> None:
        """Restore patched attention forwards (mirror of attach_fused_turboquant)."""
        decoder_layers = self._resolve_decoder_layers(model)
        for i, original in self._fused_originals.items():
            if i < len(decoder_layers):
                attn = getattr(decoder_layers[i], "self_attn", None)
                if attn is not None:
                    attn.forward = original
        self._fused_originals = {}

    def attach_qjl(
        self,
        model,
        *,
        projection_dim_per_head: int = 256,
        projection_dim_per_head_initial: int = 512,
        initial_layers_count: int = 15,
        outlier_count_general: int = 8,
        outlier_count_initial_layers: int = 8,
        group_size: int = 32,
        buffer_size: int = 128,
        projection_seed: int = 42,
    ) -> None:
        """Attach QJL key compression on full-attention layers.

        K writes go through ``qjl_kernel.qjl_quant`` (1-bit JL sketch +
        bf16 norm + per-group outlier sketch). At decode time
        Q @ K^T scores are computed via ``qjl_score`` / ``qjl_gqa_score``.
        V-side compression is delegated to ``attach_fused_turboquant`` --
        if the vendored fused-turboquant package can patch the model the
        full QJL+TurboQuant stack is in effect, otherwise we fall back to
        bf16 V (with a warning) so the K-side win still applies.

        Per-layer K state is stored on
        ``self._qjl_state[layer_idx] = {"packed", "outlier_quant",
        "outlier_indices", "outlier_norms", "norms", "rand_prj", ...}``,
        analogous to how ``self._compressed_values`` holds the V-side
        TurboQuant payload.

        Raises ``RuntimeError`` with the apt-install commands if the
        vendored QJL CUDA extension is unbuilt -- the K-side score path
        has no CPU fallback (the pure-PyTorch helper covers compression
        only), so we refuse to silently downgrade.
        """
        import math
        import sys as _sys

        qjl_dir = str(
            Path(__file__).resolve().parent.parent
            / "quantization" / "qjl"
        )
        if qjl_dir not in _sys.path:
            _sys.path.insert(0, qjl_dir)
        try:
            import qjl_kernel as _qjl_kernel  # noqa: WPS433 - lazy by design
            _qjl_kernel._load_kernel("cuda_qjl_quant")
            _qjl_kernel._load_kernel("cuda_qjl_score")
            _qjl_kernel._load_kernel("cuda_qjl_gqa_score")
        except (ImportError, OSError) as e:
            raise RuntimeError(
                "full_attn_backend='qjl_full' requires the vendored QJL CUDA "
                "extension. Build it once with:\n"
                "  cd scripts/quantization/qjl && ./build.sh\n"
                "If the build fails with `nvcc not found` or `Python.h: No "
                "such file` install the prerequisites:\n"
                "  sudo apt install nvidia-cuda-toolkit python3.12-dev\n"
                "For RTX 50-series (sm_120) prefix the build with:\n"
                "  TORCH_CUDA_ARCH_LIST=\"12.0+PTX\" "
                "./build.sh\n"
                f"Original ImportError: {e}"
            ) from e

        # V-side TurboQuant first. If the V patch fails we leave V in
        # bf16 and continue with K-side QJL; the user is told both ways.
        v_compressed = False
        try:
            self.attach_fused_turboquant(model, verify=False)
            v_compressed = True
        except RuntimeError as e:
            log.warning(
                "qjl_full: V-side TurboQuant patch failed (%s); falling back "
                "to bf16 V. K-side QJL will still apply.", e,
            )
            # Detach any partially patched layers so the closure swap below
            # can take over cleanly.
            self.detach_fused_turboquant(model)
            self._fused_originals = {}

        cfg = self.text_config
        head_dim = getattr(cfg, "head_dim", None) or (
            cfg.hidden_size // cfg.num_attention_heads
        )
        head_dim = int(head_dim)
        n_heads = int(cfg.num_attention_heads)
        n_kv_heads = int(
            getattr(cfg, "num_key_value_heads", None) or cfg.num_attention_heads
        )
        n_kv_groups = n_heads // n_kv_heads

        # Build the per-layer JL projection matrices. Each full-attention
        # layer gets a deterministic (proj_dim, head_dim) matrix derived
        # from projection_seed. proj_dim is bigger for the first
        # initial_layers_count layers per the QJL paper.
        device = next(model.parameters()).device
        proj_dtype = next(model.parameters()).dtype
        full_layer_indices = [
            i for i, t in enumerate(self.layer_types) if t == "full_attention"
        ]
        projections: dict[int, torch.Tensor] = {}
        for layer_idx in full_layer_indices:
            proj_dim = (
                projection_dim_per_head_initial
                if layer_idx < initial_layers_count
                else projection_dim_per_head
            )
            gen = torch.Generator(device="cpu").manual_seed(
                projection_seed + int(layer_idx),
            )
            proj = torch.randn(
                proj_dim, head_dim, generator=gen, dtype=torch.float32,
            )
            projections[layer_idx] = proj.to(device=device, dtype=proj_dtype)

        # Patch the K-side via a forward closure on each full-attention
        # self_attn module. The closure mirrors the vendored fused_forward's
        # query/key projection + RoPE structure, then routes K through
        # qjl_quant and the score computation through qjl_gqa_score.
        decoder_layers = self._resolve_decoder_layers(model)
        eligible_layer_idx = set(full_layer_indices)
        scale = 1.0 / math.sqrt(head_dim)

        # Cache the existing fused-turboquant V originals so the QJL
        # closure can call them for V handling. We rebuild a per-layer
        # tuple of (originally_patched_fused_forward, k_proj, v_proj, ...)
        # so the QJL closure has everything it needs.
        for layer_idx, layer_module in enumerate(decoder_layers):
            if layer_idx not in eligible_layer_idx:
                continue
            attn = getattr(layer_module, "self_attn", None)
            if attn is None or not hasattr(attn, "k_proj"):
                continue

            self._patch_qjl_attention(
                attn=attn,
                layer_idx=layer_idx,
                cfg=cfg,
                head_dim=head_dim,
                n_heads=n_heads,
                n_kv_heads=n_kv_heads,
                n_kv_groups=n_kv_groups,
                scale=scale,
                projection=projections[layer_idx],
                outlier_count=(
                    outlier_count_initial_layers
                    if layer_idx < initial_layers_count
                    else outlier_count_general
                ),
                outlier_sketch_dim=(
                    128 if layer_idx < initial_layers_count else 256
                ),
                group_size=group_size,
                buffer_size=buffer_size,
                v_compressed=v_compressed,
                qjl_kernel_module=_qjl_kernel,
            )

        self._qjl_state["kernel_available"] = True
        self._qjl_state["v_backend"] = (
            "fused_turboquant" if v_compressed else "bf16"
        )
        self._qjl_state["projection_seed"] = projection_seed
        self._qjl_state["head_dim"] = head_dim
        self._qjl_state["projections"] = projections
        log.info(
            "qjl_full: patched %d full-attention layers (head_dim=%d, "
            "v_backend=%s, proj_dim_general=%d, proj_dim_initial=%d, "
            "group_size=%d)",
            len(full_layer_indices), head_dim,
            self._qjl_state["v_backend"],
            projection_dim_per_head, projection_dim_per_head_initial,
            group_size,
        )

    def _patch_qjl_attention(
        self,
        *,
        attn,
        layer_idx: int,
        cfg,
        head_dim: int,
        n_heads: int,
        n_kv_heads: int,
        n_kv_groups: int,
        scale: float,
        projection: torch.Tensor,
        outlier_count: int,
        outlier_sketch_dim: int,
        group_size: int,
        buffer_size: int,
        v_compressed: bool,
        qjl_kernel_module,
    ) -> None:
        """Replace ``attn.forward`` with a QJL-on-K + TurboQuant-on-V
        closure. Mirrors the structure of
        ``fused_turboquant.hf.fused_cache.make_fused_attention_forward``
        but routes K through QJL instead of the RHT Lloyd-Max path.
        """
        from quantization.fused_turboquant_vendored.hf.fused_cache import (
            _detect_attn_output_gate,
        )

        cache = self
        rand_prj = projection
        is_gated = _detect_attn_output_gate(attn, cfg)
        q_norm = getattr(attn, "q_norm", None)
        k_norm = getattr(attn, "k_norm", None)
        original_forward = attn.forward
        # Track the original so detach_qjl can put it back.
        self._fused_originals.setdefault(layer_idx, original_forward)

        def qjl_forward(
            hidden_states: torch.Tensor,
            position_embeddings: tuple | None = None,
            attention_mask: torch.Tensor | None = None,
            past_key_values=None,
            cache_position: torch.Tensor | None = None,
            **kwargs,
        ):
            from quantization.fused_turboquant_vendored.hf.fused_cache import (
                _apply_rotary_pos_emb,
                _repeat_kv,
            )

            bsz, q_len, _ = hidden_states.size()

            if is_gated:
                qg = attn.q_proj(hidden_states).view(
                    bsz, q_len, n_heads, head_dim * 2,
                )
                query_states, gate_states = torch.chunk(qg, 2, dim=-1)
                attn_gate = gate_states.reshape(bsz, q_len, n_heads * head_dim)
            else:
                query_states = attn.q_proj(hidden_states).view(
                    bsz, q_len, n_heads, head_dim,
                )
                attn_gate = None

            key_states = attn.k_proj(hidden_states)
            value_states = attn.v_proj(hidden_states)

            query_states = query_states.transpose(1, 2)
            key_states = key_states.view(
                bsz, q_len, n_kv_heads, head_dim,
            ).transpose(1, 2)
            value_states = value_states.view(
                bsz, q_len, n_kv_heads, head_dim,
            ).transpose(1, 2)

            if q_norm is not None:
                query_states = q_norm(query_states)
            if k_norm is not None:
                key_states = k_norm(key_states)

            if position_embeddings is not None:
                cos, sin = position_embeddings
                query_states, key_states = _apply_rotary_pos_emb(
                    query_states, key_states, cos, sin,
                )

            # K side: QJL-quantize (B, n_kv_heads, T, head_dim) -> grouped
            # 1-bit sketch + bf16 norms + per-group outlier sketch.
            cache._store_qjl_key(
                key_states=key_states,
                layer_idx=layer_idx,
                rand_prj=rand_prj,
                outlier_count=outlier_count,
                outlier_sketch_dim=outlier_sketch_dim,
                group_size=group_size,
                qjl_kernel_module=qjl_kernel_module,
            )

            # V side: either the fused-turboquant compressed store, or
            # vanilla bf16 retention (fallback).
            if v_compressed:
                cache.store_compressed_value(value_states, layer_idx)

            # Tiny update for the placeholder DynamicLayer so HF's seq-length
            # bookkeeping stays consistent.
            dummy_keys = key_states[:, :, :, :1]
            if v_compressed:
                dummy_values = value_states[:, :, :, :1]
                cache.update(dummy_keys, dummy_values, layer_idx)
                full_values = None
            else:
                _, full_values = cache.update(
                    dummy_keys, value_states, layer_idx,
                )

            if q_len == 1:
                # Decode step: score against compressed K via QJL kernels.
                qjl_entry = cache._qjl_state.get(layer_idx)
                if qjl_entry is None:
                    raise RuntimeError(
                        "qjl_forward decode step but no compressed K state "
                        f"for layer {layer_idx}; expected the prefill step "
                        "to have populated cache._qjl_state."
                    )
                # qjl_score / qjl_gqa_score expect:
                #   key_quant:           (B, n_kv, G, group_size, sketch/8)
                #   key_outlier_quant:   (B, n_kv, G, group_size, outlier/8)
                #   key_norm:            (B, n_kv, G, group_size)
                #   key_outlier_norm:    (B, n_kv, G, outlier_count)
                #   outlier_indices:     (B, n_kv, G, outlier_count)
                #   query_sketch:        (B, n_q, 1, sketch_dim) -- Q @ proj^T
                #   query_states:        (B, n_q, 1, head_dim)
                #   rand_prj:            (sketch_dim, head_dim)
                qf = query_states.to(rand_prj.dtype)
                query_sketch = torch.matmul(qf, rand_prj.transpose(0, 1))
                if n_kv_groups > 1:
                    scores = qjl_kernel_module.qjl_gqa_score(
                        qjl_entry["packed"],
                        qjl_entry["outlier_quant"].contiguous(),
                        qjl_entry["norms"],
                        qjl_entry["outlier_norms"],
                        qjl_entry["outlier_indices"],
                        query_sketch,
                        query_states,
                        rand_prj,
                    )
                else:
                    scores = qjl_kernel_module.qjl_score(
                        qjl_entry["packed"],
                        qjl_entry["outlier_quant"].contiguous(),
                        qjl_entry["norms"],
                        qjl_entry["outlier_norms"],
                        qjl_entry["outlier_indices"],
                        query_sketch,
                        query_states,
                        rand_prj,
                    )
                attn_weights = scores.transpose(-1, -2) * scale

                kv_len = attn_weights.shape[-1]
                if attention_mask is not None:
                    if attention_mask.dim() == 4:
                        attn_weights = (
                            attn_weights + attention_mask[:, :, :1, :kv_len]
                        )
                    elif attention_mask.dim() == 2:
                        attn_weights = (
                            attn_weights + attention_mask[:1, :kv_len]
                        )

                attn_weights = torch.nn.functional.softmax(
                    attn_weights, dim=-1, dtype=torch.float32,
                ).to(query_states.dtype)

                if v_compressed:
                    decoded_v = cache.decode_values(layer_idx).to(
                        query_states.dtype,
                    )
                    full_values_expanded = _repeat_kv(decoded_v, n_kv_groups)
                else:
                    full_values_expanded = _repeat_kv(full_values, n_kv_groups)
                attn_output = torch.matmul(attn_weights, full_values_expanded)
            else:
                # Prefill: SDPA on the full bf16 K/V (the QJL sketch is
                # already stored above for subsequent decode steps).
                full_keys_expanded = _repeat_kv(key_states, n_kv_groups)
                full_values_expanded = _repeat_kv(value_states, n_kv_groups)
                attn_output = (
                    torch.nn.functional.scaled_dot_product_attention(
                        query_states,
                        full_keys_expanded,
                        full_values_expanded,
                        is_causal=True,
                    )
                )

            attn_output = attn_output.transpose(1, 2).contiguous()
            attn_output = attn_output.reshape(bsz, q_len, -1)

            if attn_gate is not None:
                attn_output = attn_output * torch.sigmoid(attn_gate)

            o_proj = (
                getattr(attn, "o_proj", None)
                or getattr(attn, "out_proj", None)
            )
            if o_proj is not None:
                attn_output = o_proj(attn_output)
            return attn_output, None

        attn.forward = qjl_forward

    def _store_qjl_key(
        self,
        *,
        key_states: torch.Tensor,
        layer_idx: int,
        rand_prj: torch.Tensor,
        outlier_count: int,
        outlier_sketch_dim: int,
        group_size: int,
        qjl_kernel_module,
    ) -> None:
        """Group K along T, pick top-k outlier coords, JL-quantize the
        inliers, append to ``self._qjl_state[layer_idx]``.

        Mirrors upstream ``QJLKeyQuantizer.build_sketch`` /
        ``update_sketch``. The (B, n_kv, T, head_dim) input is split into
        (B, n_kv, num_groups, group_size, head_dim) chunks; any tail
        shorter than ``group_size`` is held back as a residual buffer for
        the next call. (For now we keep the implementation simple and
        compress whatever full groups fit; a residual buffer is a future
        optimization for very-tight stride boundaries.)
        """
        if key_states.dim() != 4:
            raise ValueError(
                f"_store_qjl_key expects (B, n_kv, T, head_dim); got "
                f"{tuple(key_states.shape)}"
            )
        B, n_kv, T, head_dim = key_states.shape
        if T < group_size:
            # Too short to compress this step; defer until the next write.
            # Stash the residual on the cache so the next call can pick it up.
            residual = self._qjl_state.setdefault(
                f"residual:{layer_idx}", None,
            )
            if residual is None:
                self._qjl_state[f"residual:{layer_idx}"] = key_states
            else:
                self._qjl_state[f"residual:{layer_idx}"] = torch.cat(
                    [residual, key_states], dim=2,
                )
            return

        residual = self._qjl_state.pop(f"residual:{layer_idx}", None)
        if residual is not None:
            key_states = torch.cat([residual, key_states], dim=2)
            T = key_states.shape[2]
        num_full_groups = T // group_size
        groupable = num_full_groups * group_size
        leftover = T - groupable
        if leftover > 0:
            self._qjl_state[f"residual:{layer_idx}"] = key_states[
                :, :, groupable:, :,
            ]
        grouped = key_states[:, :, :groupable, :].view(
            B, n_kv, num_full_groups, group_size, head_dim,
        ).contiguous()

        # Per-group L2 norm across the group axis -> top-k outlier coords.
        group_norms = grouped.float().norm(dim=-2)
        _, outlier_idx = group_norms.topk(outlier_count, dim=-1)
        outlier_idx_u8 = outlier_idx.to(torch.uint8).contiguous()

        key_quant, key_outlier_quant, key_outliers_norm = (
            qjl_kernel_module.qjl_quant(
                grouped, outlier_idx_u8, rand_prj, outlier_sketch_dim,
            )
        )
        # Per-token bf16 norm (the qjl_score path needs it to renormalize
        # the JL inner product back to the K direction).
        key_norms = grouped.float().norm(dim=-1)

        entry = {
            "packed": key_quant,
            "outlier_quant": key_outlier_quant,
            "outlier_indices": outlier_idx_u8,
            "outlier_norms": key_outliers_norm,
            "norms": key_norms,
            "rand_prj": rand_prj,
            "head_dim": head_dim,
            "n_kv_heads": n_kv,
            "group_size": group_size,
        }
        prev = self._qjl_state.get(layer_idx)
        if prev is None:
            self._qjl_state[layer_idx] = entry
            return
        self._qjl_state[layer_idx] = {
            "packed": torch.cat([prev["packed"], entry["packed"]], dim=2),
            "outlier_quant": torch.cat(
                [prev["outlier_quant"], entry["outlier_quant"]], dim=2,
            ),
            "outlier_indices": torch.cat(
                [prev["outlier_indices"], entry["outlier_indices"]], dim=2,
            ),
            "outlier_norms": torch.cat(
                [prev["outlier_norms"], entry["outlier_norms"]], dim=2,
            ),
            "norms": torch.cat([prev["norms"], entry["norms"]], dim=2),
            "rand_prj": rand_prj,
            "head_dim": head_dim,
            "n_kv_heads": n_kv,
            "group_size": group_size,
        }

    def decode_keys(self, layer_idx: int) -> torch.Tensor:
        """Reconstruct K from the QJL 1-bit sketch + per-token bf16 norms.

        Symmetric to ``decode_values``. The reconstruction is a least-
        squares inverse of the JL projection -- it preserves direction
        within the JL approximation guarantee but the per-coord values
        are noisy by construction. Use for parity tests / log-prob
        debugging, not as part of the live decode path (the live path
        uses ``qjl_score`` directly against the compressed sketch).
        """
        entry = self._qjl_state.get(layer_idx) if isinstance(
            self._qjl_state, dict
        ) else None
        if entry is None or not isinstance(entry, dict) or "packed" not in entry:
            raise RuntimeError(
                f"decode_keys({layer_idx}) called but no compressed key "
                "exists for this layer."
            )
        packed = entry["packed"]
        proj = entry["rand_prj"]
        norms = entry["norms"]
        B, H, G, GS, packed_dim = packed.shape
        sketch_dim = packed_dim * 8
        bit_idx = torch.arange(
            8, device=packed.device, dtype=torch.uint8,
        )
        unpacked = ((packed.unsqueeze(-1) >> bit_idx) & 1).to(torch.float32)
        signs = unpacked.view(B, H, G, GS, sketch_dim) * 2.0 - 1.0
        proj_f = proj.to(torch.float32)
        gram = proj_f @ proj_f.transpose(0, 1)
        proj_dagger = torch.linalg.solve(gram, proj_f)
        k_hat = signs @ proj_dagger.transpose(0, 1)
        k_hat_norms = k_hat.norm(dim=-1, keepdim=True).clamp_min(1e-8)
        k_hat = k_hat * (norms.unsqueeze(-1) / k_hat_norms)
        return k_hat.view(B, H, G * GS, proj.shape[1])

    # -- internal helpers -----------------------------------------------------

    def _resolve_decoder_layers(self, model):
        """Locate the decoder layer list on a (possibly multimodal) HF model."""
        # Standard text-only path: AutoModelForCausalLM(Qwen3.5-...) gives
        # Qwen3_5ForCausalLM with .model.layers
        candidate_paths = (
            ("model", "layers"),
            ("language_model", "model", "layers"),
            ("model", "model", "layers"),
            ("transformer", "layers"),
        )
        for path in candidate_paths:
            obj = model
            ok = True
            for attr in path:
                obj = getattr(obj, attr, None)
                if obj is None:
                    ok = False
                    break
            if ok and hasattr(obj, "__getitem__"):
                return obj
        raise RuntimeError(
            f"Could not locate decoder layers list on model of type "
            f"{type(model).__name__}. Tried: {candidate_paths}"
        )

    # -- compressed K/V API (matches CompressedKVCache duck-type) -------------
    #
    # The fused attention forward closures call these directly via the `cache`
    # closure variable. They MUST behave exactly like
    # fused_turboquant.hf.fused_cache.CompressedKVCache.

    def store_compressed_key(self, key_states: torch.Tensor, layer_idx: int):
        if self._tq is None:
            raise RuntimeError(
                "store_compressed_key called but no quantizer attached. "
                "Build the cache via make_hybrid_cache(..., "
                "full_attn_backend='fused_turboquant')."
            )
        compressed = self._tq.encode(key_states.float())
        packed_shape = list(key_states.shape[:-1]) + [compressed.indices.shape[-1]]
        packed_indices = compressed.indices.view(packed_shape)
        norms = compressed.norms.view(*key_states.shape[:-1])
        entry = {"packed_indices": packed_indices, "norms": norms}
        prev = self._compressed_keys[layer_idx]
        if prev is None:
            self._compressed_keys[layer_idx] = entry
        else:
            self._compressed_keys[layer_idx] = {
                "packed_indices": torch.cat(
                    [prev["packed_indices"], entry["packed_indices"]], dim=2,
                ),
                "norms": torch.cat([prev["norms"], entry["norms"]], dim=2),
            }

    def get_compressed_key(self, layer_idx: int) -> Optional[dict]:
        if 0 <= layer_idx < len(self._compressed_keys):
            return self._compressed_keys[layer_idx]
        return None

    def store_compressed_value(self, value_states: torch.Tensor, layer_idx: int):
        if self._tq is None:
            raise RuntimeError(
                "store_compressed_value called but no quantizer attached."
            )
        compressed = self._tq.encode(value_states.float())
        packed_shape = list(value_states.shape[:-1]) + [compressed.indices.shape[-1]]
        packed_indices = compressed.indices.view(packed_shape)
        norms = compressed.norms.view(*value_states.shape[:-1])
        entry = {"packed_indices": packed_indices, "norms": norms}
        prev = self._compressed_values[layer_idx]
        if prev is None:
            self._compressed_values[layer_idx] = entry
        else:
            self._compressed_values[layer_idx] = {
                "packed_indices": torch.cat(
                    [prev["packed_indices"], entry["packed_indices"]], dim=2,
                ),
                "norms": torch.cat([prev["norms"], entry["norms"]], dim=2),
            }

    def get_compressed_value(self, layer_idx: int) -> Optional[dict]:
        if 0 <= layer_idx < len(self._compressed_values):
            return self._compressed_values[layer_idx]
        return None

    def decode_values(self, layer_idx: int) -> torch.Tensor:
        from quantization.fused_turboquant_vendored.core.quantizer import (
            CompressedTensor,
        )
        entry = self._compressed_values[layer_idx]
        if entry is None or self._tq is None:
            raise RuntimeError(
                f"decode_values({layer_idx}) called but no compressed value "
                "exists for this layer."
            )
        ct = CompressedTensor(
            indices=entry["packed_indices"],
            norms=entry["norms"],
            original_dim=self._tq.head_dim,
            bits=self._tq.bits,
        )
        return self._tq.decode(ct)

    # -- Cache overrides ------------------------------------------------------

    def reset(self):
        """Clear all per-layer state but keep the layer-type scaffold intact."""
        for layer in self.layers:
            try:
                layer.reset()
            except Exception:
                # Some layers (DynamicLayer pre-init) don't need reset
                pass
        self._compressed_keys = [None] * len(self.layer_types)
        self._compressed_values = [None] * len(self.layer_types)

    def has_previous_state(self, layer_idx: int | None = None) -> bool:
        """Same semantics as Cache.has_previous_state but tolerant.

        The Qwen3.5 modeling code calls ``cache_params.has_previous_state(self.layer_idx)``
        from inside Qwen3_5GatedDeltaNet.forward. Our self.layers[layer_idx]
        for that call IS a LinearAttentionLayer, so the parent impl works.
        We override only to avoid the fragile fallback when called with no
        layer_idx.
        """
        if layer_idx is not None:
            if layer_idx >= len(self.layers):
                return False
            layer = self.layers[layer_idx]
            if isinstance(layer, LinearAttentionCacheLayerMixin):
                return layer.has_previous_state
            return False
        return super().has_previous_state(layer_idx)
