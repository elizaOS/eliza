"""Post-training quantization + abliteration for Eliza-1/Gemma checkpoints.

Members:
    polarquant_apply        — weight-side Gaussian quantization (data-free).
    turboquant_apply        — runtime KV-cache compressor (turbokv pure-PyTorch).
    fused_turboquant_apply  — same scheme, Triton kernels.
    qjl_apply               — runtime K-side 1-bit JL sketch.
    abliteration_apply      — orthogonal refusal-direction ablation.
"""


__all__ = ["PROFILES", "QuantProfile"]


def __getattr__(name: str):
    if name == "PROFILES":
        from .gguf_profile import PROFILES
        return PROFILES
    if name == "QuantProfile":
        from .gguf_k_quant import QuantProfile
        return QuantProfile
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
