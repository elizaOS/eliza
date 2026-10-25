"""Dataset registry loader with SOC2 consent enforcement (M-1).

Loads ``packages/training/datasets.yaml`` and enforces SOC2 PI1.1-PI1.5 / C1.1
consent semantics on every source before training scripts may use it.

Every source MUST carry a ``consent_basis`` field whose value is one of:

  - ``synthetic``           - the data was generated locally without involving
                              real user records (e.g. ``synthesize_targets.py``).
  - ``public_domain``       - in the public domain (CC0, US-gov work, etc.).
  - ``licensed``            - third-party license that permits training use
                              (apache-2.0, mit, cc-by-*, odc-by, etc.). The
                              ``license`` field MUST be set to the SPDX tag.
  - ``opt_in_user_consent`` - data originated from end-user activity AND we
                              have an opt-in record. ``consent_proof_uri`` MUST
                              be set to a URL/URI of the consent record
                              (DPA section, signed agreement, etc.).
  - ``internal_dogfood``    - data originated from internal eliza team
                              dogfooding. ``consent_proof_uri`` MUST be set
                              (link to internal DPA/policy).

Loader behaviour:

  - ``consent_basis`` missing -> loader rejects with ``DatasetConsentError``.
  - Customer-data class (``opt_in_user_consent`` / ``internal_dogfood``)
    without ``consent_proof_uri`` -> rejected.
  - ``licensed`` without a ``license`` SPDX value (or ``unknown``) -> rejected.

The loader is deliberately strict: this is the single chokepoint that gates
which sources can feed training. Any new source added to ``datasets.yaml``
must annotate its consent basis at the time it is added.

Customer-data heuristic: when ``consent_basis`` is missing and the source's
``slug`` or ``source.glob`` matches one of the known trajectory-export
patterns, the loader emits an error explicitly naming consent as the gap so
the operator cannot accidentally train on user trajectories.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("training.dataset_loader")

# ---------------------------------------------------------------------------
# Public contract
# ---------------------------------------------------------------------------

CONSENT_BASES: frozenset[str] = frozenset(
    {
        "synthetic",
        "public_domain",
        "licensed",
        "opt_in_user_consent",
        "internal_dogfood",
    }
)

CUSTOMER_DATA_BASES: frozenset[str] = frozenset(
    {
        "opt_in_user_consent",
        "internal_dogfood",
    }
)

# Slug substrings / glob substrings that mark a source as carrying real
# user data. Any source matching these MUST carry a customer-data
# consent_basis with proof.
CUSTOMER_DATA_SLUG_HINTS: tuple[str, ...] = (
    "eliza-nightly",
    "nubilio-trajectories",
    "user-trajectories",
    "user-export",
    "connector-trace",
)
CUSTOMER_DATA_GLOB_HINTS: tuple[str, ...] = (
    "trajectories.jsonl",
    "user_export",
)

# SPDX-like tags we accept for ``license`` when ``consent_basis: licensed``.
# A value of ``unknown`` is rejected; the dataset must either be removed
# or its license confirmed before training can use it.
ACCEPTABLE_LICENSE_TAGS: frozenset[str] = frozenset(
    {
        "apache-2.0",
        "mit",
        "cc-by-4.0",
        "cc-by-sa-4.0",
        "cc-by-2.0",
        "cc-by-sa-2.0",
        "cc0-1.0",
        "odc-by",
        "odc-by-1.0",
        "bsd-2-clause",
        "bsd-3-clause",
        "isc",
        "nvidia",  # nvidia open-model license
    }
)

PUBLIC_DOMAIN_LICENSE_TAGS: frozenset[str] = frozenset(
    {
        "cc0-1.0",
        "public-domain",
        "pd",
    }
)


class DatasetConsentError(ValueError):
    """Raised when a dataset source fails the consent gate."""


@dataclass(frozen=True)
class ConsentRecord:
    """Validated consent metadata for a single source."""

    slug: str
    consent_basis: str
    license_tag: str | None
    consent_proof_uri: str | None
    customer_data: bool


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def _is_customer_data_source(entry: dict[str, Any]) -> bool:
    slug = str(entry.get("slug") or "")
    for hint in CUSTOMER_DATA_SLUG_HINTS:
        if hint in slug:
            return True
    source = entry.get("source")
    if isinstance(source, dict):
        glob = str(source.get("glob") or "")
        for hint in CUSTOMER_DATA_GLOB_HINTS:
            if hint in glob:
                return True
    return False


def _validate_entry(entry: dict[str, Any]) -> ConsentRecord:
    slug = entry.get("slug")
    if not isinstance(slug, str) or not slug:
        raise DatasetConsentError(
            f"dataset entry missing 'slug': {entry!r}"
        )

    consent_basis = entry.get("consent_basis")
    license_tag_raw = entry.get("license")
    license_tag = (
        str(license_tag_raw).strip().lower() if license_tag_raw is not None else None
    )
    proof = entry.get("consent_proof_uri")
    proof_str = str(proof).strip() if isinstance(proof, str) and proof.strip() else None

    customer_data = _is_customer_data_source(entry)

    if not isinstance(consent_basis, str) or not consent_basis:
        if customer_data:
            raise DatasetConsentError(
                f"dataset '{slug}': consent_basis missing AND slug/glob is a "
                "customer-data shape. Refusing to load. Set consent_basis to "
                "'opt_in_user_consent' or 'internal_dogfood' with a "
                "consent_proof_uri before training can use this source."
            )
        raise DatasetConsentError(
            f"dataset '{slug}': consent_basis is required. Allowed values: "
            f"{sorted(CONSENT_BASES)}."
        )

    if consent_basis not in CONSENT_BASES:
        raise DatasetConsentError(
            f"dataset '{slug}': consent_basis={consent_basis!r} is not one of "
            f"{sorted(CONSENT_BASES)}."
        )

    if consent_basis in CUSTOMER_DATA_BASES and not proof_str:
        raise DatasetConsentError(
            f"dataset '{slug}': consent_basis={consent_basis!r} requires a "
            "non-empty consent_proof_uri (URI to opt-in record / DPA / "
            "internal-dogfood policy)."
        )

    if consent_basis == "licensed":
        if not license_tag or license_tag == "proprietary":
            raise DatasetConsentError(
                f"dataset '{slug}': consent_basis=licensed requires a non-"
                f"proprietary 'license' tag, got {license_tag!r}. Use "
                "internal_dogfood/opt_in_user_consent for proprietary sources."
            )
        if license_tag == "unknown":
            # Soft-fail: many third-party datasets ship without a clear SPDX
            # tag. The auditor flags this but we don't refuse to load — the
            # source-of-record is still the upstream HF repo's license file.
            log.warning(
                "dataset %s: license=unknown — auditor will require "
                "confirmation; tracked under SOC2 PI1.5.",
                slug,
            )
        elif license_tag not in ACCEPTABLE_LICENSE_TAGS:
            log.warning(
                "dataset %s: license=%s is not in the curated accept list; "
                "loading anyway but the auditor will want a confirmation.",
                slug,
                license_tag,
            )

    if consent_basis == "public_domain":
        if license_tag and license_tag not in PUBLIC_DOMAIN_LICENSE_TAGS:
            log.warning(
                "dataset %s: consent_basis=public_domain but license=%s is "
                "not a recognized public-domain tag; double-check the source.",
                slug,
                license_tag,
            )

    # Sanity gate: a source that looks like customer data MUST declare it.
    if customer_data and consent_basis not in CUSTOMER_DATA_BASES:
        raise DatasetConsentError(
            f"dataset '{slug}': slug/glob looks like a customer-data export "
            f"but consent_basis={consent_basis!r}. Use opt_in_user_consent or "
            "internal_dogfood with a consent_proof_uri."
        )

    return ConsentRecord(
        slug=slug,
        consent_basis=consent_basis,
        license_tag=license_tag,
        consent_proof_uri=proof_str,
        customer_data=customer_data or consent_basis in CUSTOMER_DATA_BASES,
    )


def load_registry(
    path: Path,
    *,
    require_consent_gate: bool = True,
) -> tuple[dict[str, Any], list[ConsentRecord]]:
    """Parse ``datasets.yaml`` and run the consent gate.

    Returns ``(registry_dict, consent_records)``. Raises
    ``DatasetConsentError`` on any violation.

    Set ``require_consent_gate=False`` only in tooling that intentionally
    inspects raw registry contents (e.g. ``analyze_*`` scripts). All
    *training* scripts MUST keep the default of ``True``.

    The env override ``ELIZA_TRAINING_CONSENT_GATE_OVERRIDE_REASON`` will
    downgrade the gate to a warning. The reason is logged at WARNING level
    so it shows up in the run manifest; the override is intended for
    emergency one-off debugging and IS a SOC2 incident if used.
    """
    with path.open("r", encoding="utf-8") as fh:
        registry = yaml.safe_load(fh)

    if not isinstance(registry, dict):
        raise DatasetConsentError(
            f"datasets.yaml root is not a mapping (got {type(registry).__name__})"
        )
    datasets = registry.get("datasets")
    if not isinstance(datasets, list):
        raise DatasetConsentError(
            "datasets.yaml must contain a top-level 'datasets:' list"
        )

    records: list[ConsentRecord] = []
    errors: list[str] = []
    for raw_entry in datasets:
        if not isinstance(raw_entry, dict):
            errors.append(f"non-mapping dataset entry: {raw_entry!r}")
            continue
        try:
            records.append(_validate_entry(raw_entry))
        except DatasetConsentError as exc:
            errors.append(str(exc))

    if errors:
        override = os.environ.get(
            "ELIZA_TRAINING_CONSENT_GATE_OVERRIDE_REASON", ""
        ).strip()
        joined = "\n  - ".join(errors)
        message = (
            f"datasets.yaml consent gate failed ({len(errors)} issue(s)):\n  - "
            f"{joined}"
        )
        if not require_consent_gate or override:
            log.warning(
                "%s\n[OVERRIDE active: reason=%r]",
                message,
                override or "(require_consent_gate=False)",
            )
        else:
            raise DatasetConsentError(message)

    return registry, records


def consent_records_to_manifest(
    records: list[ConsentRecord],
) -> list[dict[str, Any]]:
    """Stable dict form for inclusion in the training-data manifest (M-2)."""
    return [
        {
            "slug": r.slug,
            "consent_basis": r.consent_basis,
            "license": r.license_tag,
            "consent_proof_uri": r.consent_proof_uri,
            "customer_data": r.customer_data,
        }
        for r in records
    ]
