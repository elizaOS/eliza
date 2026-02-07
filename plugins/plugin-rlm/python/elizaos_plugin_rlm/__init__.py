"""
RLM (Recursive Language Model) plugin package for elizaOS.

This package provides integration with Recursive Language Models (RLMs),
enabling LLMs to process arbitrarily long contexts through recursive
self-calls in a REPL environment.

Features:
    - Async client for RLM inference
    - Full trajectory logging (Paper Section 4.1)
    - Cost tracking and dual-model config (Paper Section 3.2)
    - Integration with plugin-trajectory-logger

Example:
    >>> from elizaos_plugin_rlm import plugin, RLMClient
    >>> # Plugin is auto-loaded by elizaOS runtime
    >>> # Or use client directly:
    >>> client = RLMClient()
    >>> result = await client.infer("Process this very long text...")
    >>> 
    >>> # With trajectory integration:
    >>> from elizaos_plugin_rlm import RLMTrajectoryIntegration
    >>> from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService
    >>> logger = TrajectoryLoggerService()
    >>> integration = RLMTrajectoryIntegration(logger)
    >>> result = await integration.infer("Long context...")

Reference:
    - Paper: https://arxiv.org/abs/2512.24601
    - Implementation: https://github.com/alexzhang13/rlm
"""

from .client import (
    HAS_RLM,
    RLMClient,
    RLMConfig,
    RLMCost,
    RLMInferOptions,
    RLMResult,
    RLMTrajectory,
    RLMTrajectoryStep,
)
from .plugin import (
    handle_rlm_explicit,
    handle_text_generation,
    plugin,
    rlm_provider,
)
from .trajectory_integration import (
    RLMTrajectoryIntegration,
    convert_rlm_step_to_llm_call,
    convert_rlm_trajectory_to_provider_access,
    infer_with_logging,
)

__all__ = [
    # Plugin
    "plugin",
    "rlm_provider",
    # Handlers
    "handle_text_generation",
    "handle_rlm_explicit",
    # Client
    "RLMClient",
    "RLMConfig",
    "RLMResult",
    "RLMInferOptions",  # Per-request overrides (Paper Algorithm 1)
    # Trajectory types (Paper Section 4.1)
    "RLMTrajectory",
    "RLMTrajectoryStep",
    "RLMCost",
    # Trajectory integration
    "RLMTrajectoryIntegration",
    "convert_rlm_step_to_llm_call",
    "convert_rlm_trajectory_to_provider_access",
    "infer_with_logging",
    # Constants
    "HAS_RLM",
]

__version__ = "0.1.0"
