"""Public manifest builder and validator for the native inference release contract."""

from .eliza1_manifest import (
    ELIZA_1_BACKENDS,
    ELIZA_1_HF_REPO,
    ELIZA_1_KERNELS,
    ELIZA_1_MANIFEST_SCHEMA_URL,
    ELIZA_1_MANIFEST_SCHEMA_VERSION,
    ELIZA_1_TIERS,
    REQUIRED_KERNELS_BY_TIER,
    SUPPORTED_BACKENDS_BY_TIER,
    VOICE_BACKENDS_BY_TIER,
    VOICE_QUANT_BY_TIER,
    Eliza1ManifestError,
    build_manifest,
    required_voice_artifacts_for_tier,
    validate_manifest,
    write_manifest,
)

__all__ = [
    "ELIZA_1_BACKENDS",
    "ELIZA_1_HF_REPO",
    "ELIZA_1_KERNELS",
    "ELIZA_1_MANIFEST_SCHEMA_URL",
    "ELIZA_1_MANIFEST_SCHEMA_VERSION",
    "ELIZA_1_TIERS",
    "REQUIRED_KERNELS_BY_TIER",
    "SUPPORTED_BACKENDS_BY_TIER",
    "VOICE_BACKENDS_BY_TIER",
    "VOICE_QUANT_BY_TIER",
    "Eliza1ManifestError",
    "build_manifest",
    "required_voice_artifacts_for_tier",
    "validate_manifest",
    "write_manifest",
]
