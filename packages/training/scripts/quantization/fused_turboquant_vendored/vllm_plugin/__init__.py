"""
vLLM plugin for fused-turboquant attention backend.

Provides the FUSED_TURBOQUANT attention backend that stores KV cache
in compressed packed uint8 format, achieving 3.8-7.1x memory reduction.

Usage:
    vllm serve Qwen/Qwen3-8B --attention-backend FUSED_TURBOQUANT

Configuration (environment variables):
    TURBOQUANT_BITS=4           Quantization bits (2, 3, or 4)
    TURBOQUANT_COMPRESS_V=1     Compress values (1=yes, 0=K-only)
"""

from quantization.fused_turboquant_vendored.vllm_plugin.plugin import register_backend

__all__ = ["register_backend"]
