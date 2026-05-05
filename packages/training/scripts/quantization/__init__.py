"""Post-training quantization + abliteration for Qwen checkpoints.

Members:
    polarquant_apply        — weight-side Gaussian quantization (data-free).
    turboquant_apply        — runtime KV-cache compressor (turbokv pure-PyTorch).
    fused_turboquant_apply  — same scheme, Triton kernels.
    qjl_apply               — runtime K-side 1-bit JL sketch.
    abliteration_apply      — orthogonal refusal-direction ablation.
"""
