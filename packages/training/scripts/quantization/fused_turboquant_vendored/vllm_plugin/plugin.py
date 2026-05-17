"""
vLLM plugin registration for fused-turboquant attention backend.

Registers via vLLM's entry point system — enable with:
    vllm serve <model> --attention-backend FUSED_TURBOQUANT

Supports both vLLM v0 (vllm.attention.backends.registry) and
v1 (vllm.v1.attention.backends.registry) API paths.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def register_backend() -> None:
    """vLLM plugin entry point — called automatically when fused-turboquant is installed.

    Registers the FUSED_TURBOQUANT attention backend so it can be selected via
    --attention-backend FUSED_TURBOQUANT or AttentionConfig(backend="FUSED_TURBOQUANT").
    """
    try:
        from quantization.fused_turboquant_vendored.vllm_plugin.backend import FusedTurboQuantBackend
    except Exception as e:
        logger.warning("Failed to import FusedTurboQuantBackend: %s", e)
        return

    registry = _get_registry()
    if registry is None:
        logger.warning(
            "vLLM attention backend registry not found. "
            "fused-turboquant plugin requires vLLM >= 0.8. "
            "The FUSED_TURBOQUANT backend will not be available."
        )
        return

    try:
        registry.register("FUSED_TURBOQUANT", FusedTurboQuantBackend)
        logger.info(
            "fused-turboquant: registered FUSED_TURBOQUANT attention backend with vLLM"
        )
    except Exception as e:
        logger.warning("Failed to register FUSED_TURBOQUANT backend: %s", e)


def _get_registry():
    """Try to import the AttentionBackendRegistry from vLLM v1 then v0."""
    try:
        from vllm.v1.attention.backends.registry import AttentionBackendRegistry
        return AttentionBackendRegistry
    except ImportError:
        pass

    try:
        from vllm.attention.backends.registry import AttentionBackendRegistry
        return AttentionBackendRegistry
    except ImportError:
        pass

    return None
