"""Trajectory ingest for LifeOpsBench.

Reads real elizaOS trajectories from disk and (mandatorily) runs them
through the same privacy filter that ``app-training/src/core/privacy-filter.ts``
applies to nightly exports — credential redaction, geo redaction — so
downstream LifeOpsBench evaluation never observes PII or secrets.

The redaction patterns are a Python port of the canonical TS patterns;
the source of truth lives in
``plugins/app-training/src/core/privacy-filter.ts``. Keep them in sync
when patterns are added or tightened upstream.
"""

from .privacy import (
    DEFAULT_CREDENTIAL_PATTERNS,
    DEFAULT_GEO_PATTERNS,
    FilterStats,
    apply_privacy_filter,
    redact_credentials,
    redact_geo,
)
from .trajectories import (
    UnredactedCredentialError,
    load_trajectories_from_disk,
)

__all__ = [
    "DEFAULT_CREDENTIAL_PATTERNS",
    "DEFAULT_GEO_PATTERNS",
    "FilterStats",
    "UnredactedCredentialError",
    "apply_privacy_filter",
    "load_trajectories_from_disk",
    "redact_credentials",
    "redact_geo",
]
