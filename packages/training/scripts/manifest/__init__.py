"""Eliza-1 manifest generator + validator.

Mirrors the TypeScript module at
``eliza/packages/app-core/src/services/local-inference/manifest/`` so that
the publish pipeline (training side) and the runtime (app-core side) speak
the same contract. The schema lives in
``packages/inference/AGENTS.md`` §6 and the publishing flow in
``packages/training/AGENTS.md`` §6.
"""

from .eliza1_manifest import (
    ELIZA_1_BACKENDS,
    ELIZA_1_KERNELS,
    ELIZA_1_MANIFEST_SCHEMA_URL,
    ELIZA_1_MANIFEST_SCHEMA_VERSION,
    ELIZA_1_TIERS,
    REQUIRED_KERNELS_BY_TIER,
    SUPPORTED_BACKENDS_BY_TIER,
    VOICE_QUANT_BY_TIER,
    Eliza1ManifestError,
    build_manifest,
    required_voice_artifacts_for_tier,
    validate_manifest,
    write_manifest,
)

__all__ = [
    "ELIZA_1_BACKENDS",
    "ELIZA_1_KERNELS",
    "ELIZA_1_MANIFEST_SCHEMA_URL",
    "ELIZA_1_MANIFEST_SCHEMA_VERSION",
    "ELIZA_1_TIERS",
    "REQUIRED_KERNELS_BY_TIER",
    "SUPPORTED_BACKENDS_BY_TIER",
    "VOICE_QUANT_BY_TIER",
    "Eliza1ManifestError",
    "build_manifest",
    "required_voice_artifacts_for_tier",
    "validate_manifest",
    "write_manifest",
]
