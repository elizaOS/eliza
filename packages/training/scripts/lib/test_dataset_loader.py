"""Tests for the SOC2 consent gate in dataset_loader (M-1)."""

from __future__ import annotations

import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.dataset_loader import (  # noqa: E402
    DatasetConsentError,
    consent_records_to_manifest,
    load_registry,
)


def _write(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "datasets.yaml"
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return p


def test_loader_rejects_missing_consent_basis(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        datasets:
          - slug: bare-dataset
            repo_id: example/repo
            normalizer: hermes_fc
            license: apache-2.0
        """,
    )
    with pytest.raises(DatasetConsentError) as exc:
        load_registry(p)
    assert "consent_basis is required" in str(exc.value)


def test_loader_rejects_customer_data_without_proof(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        datasets:
          - slug: eliza-nightly-foo
            source:
              type: local_path
              root: ~/.eliza/training/datasets
              glob: '*/foo_trajectories.jsonl'
              task: foo
            normalizer: eliza_native_passthrough
            license: proprietary
            consent_basis: opt_in_user_consent
        """,
    )
    with pytest.raises(DatasetConsentError) as exc:
        load_registry(p)
    assert "consent_proof_uri" in str(exc.value)


def test_loader_rejects_customer_data_marked_synthetic(tmp_path: Path) -> None:
    """A source whose slug looks like a user export cannot be downgraded."""
    p = _write(
        tmp_path,
        """
        datasets:
          - slug: eliza-nightly-foo
            source:
              type: local_path
              root: ~/.eliza/training/datasets
              glob: '*/foo_trajectories.jsonl'
              task: foo
            normalizer: eliza_native_passthrough
            license: proprietary
            consent_basis: synthetic
        """,
    )
    with pytest.raises(DatasetConsentError) as exc:
        load_registry(p)
    assert "customer-data" in str(exc.value).lower()


def test_loader_accepts_valid_mix(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        datasets:
          - slug: public-thing
            repo_id: example/public
            normalizer: hermes_fc
            license: apache-2.0
            consent_basis: licensed
          - slug: nubilio-trajectories
            local_path: local-corpora/nubilio-trajectories/x
            normalizer: nubilio_trajectories
            license: proprietary
            consent_basis: internal_dogfood
            consent_proof_uri: https://example.com/dpa
          - slug: synth-targets
            local_path: local-corpora/synth/x
            normalizer: hermes_fc
            license: mit
            consent_basis: synthetic
        """,
    )
    registry, records = load_registry(p)
    assert len(records) == 3
    manifest = consent_records_to_manifest(records)
    bases = {m["consent_basis"] for m in manifest}
    assert bases == {"licensed", "internal_dogfood", "synthetic"}
    cust = [m for m in manifest if m["customer_data"]]
    assert len(cust) == 1
    assert cust[0]["slug"] == "nubilio-trajectories"


def test_loader_rejects_licensed_proprietary(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        datasets:
          - slug: leaky
            repo_id: somewhere/private
            normalizer: hermes_fc
            license: proprietary
            consent_basis: licensed
        """,
    )
    with pytest.raises(DatasetConsentError):
        load_registry(p)


def test_loader_accepts_real_repo_datasets_yaml() -> None:
    repo_yaml = (
        Path(__file__).resolve().parents[2] / "datasets.yaml"
    )
    if not repo_yaml.exists():
        pytest.skip("datasets.yaml not present in this checkout")
    registry, records = load_registry(repo_yaml)
    assert isinstance(registry.get("datasets"), list)
    assert len(records) >= 1
    # At least the nightly trajectory sources must be tagged as customer data.
    cust = [r for r in records if r.customer_data]
    assert any(r.slug.startswith("eliza-nightly-") for r in cust), (
        "nightly trajectory exports must be flagged as customer-data"
    )
