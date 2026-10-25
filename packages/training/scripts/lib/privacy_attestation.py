"""Shared acceptance policy for recorded privacy attestations."""

from typing import Any

PRIVACY_ATTESTATION_SCHEMA = "eliza.privacy_filter_attestation.v1"
PRIVACY_ATTESTATION_VERSION = 1


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def privacy_attestation_candidates(record: dict[str, Any]) -> list[dict[str, Any]]:
    metadata = _as_dict(record.get("metadata"))
    candidates: list[dict[str, Any]] = []
    for value in (
        record.get("privacyAttestation"),
        record.get("privacy_attestation"),
        metadata.get("privacy_attestation"),
        metadata.get("privacyAttestation"),
        metadata.get("privacy"),
        record.get("privacy"),
    ):
        if isinstance(value, dict):
            candidates.append(value)
    return candidates


def has_privacy_attestation(record: dict[str, Any]) -> bool:
    for attestation in privacy_attestation_candidates(record):
        privacy = _as_dict(attestation.get("privacy"))
        if (
            attestation.get("schema") == PRIVACY_ATTESTATION_SCHEMA
            and attestation.get("version") == PRIVACY_ATTESTATION_VERSION
            and attestation.get("passed") is True
            and (
                attestation.get("reviewed") is True
                or attestation.get("redacted") is True
                or privacy.get("reviewed") is True
            )
        ):
            return True
    return False
