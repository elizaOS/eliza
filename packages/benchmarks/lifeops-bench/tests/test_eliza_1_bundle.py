"""Wave 3-B: reader + pre-release predicate for eliza-1 GGUF bundles.

Python mirror of ``packages/benchmarks/lib/src/__tests__/eliza-1-bundle.test.ts``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from eliza_lifeops_bench.eliza_1_bundle import (
    ElizaOneBundleFinal,
    ElizaOneBundleManifest,
    bundle_is_pre_release,
    read_eliza_one_bundle,
)


def _write_bundle(
    tmp_path: Path,
    overrides: dict[str, Any] | None = None,
    *,
    omit: tuple[str, ...] = (),
    include_drafters: bool = True,
) -> tuple[Path, Path, Path]:
    bundle_dir = tmp_path / "eliza-1-0.6b.bundle"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    weights = bundle_dir / "weights.gguf"
    drafter = bundle_dir / "drafter.gguf"
    weights.write_text("stub-gguf-bytes")
    drafter.write_text("stub-drafter-bytes")
    manifest: dict[str, Any] = {
        "bundleId": "eliza-1-0.6b",
        "modelSize": "0.6b",
        "releaseState": "local-standin",
        "publishEligible": False,
        "final": {"weights": False},
        "weightsPath": "weights.gguf",
        "sha256": "0" * 64,
    }
    if include_drafters:
        manifest["draftersPath"] = "drafter.gguf"
    if overrides:
        manifest.update(overrides)
    for key in omit:
        manifest.pop(key, None)
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest))
    return bundle_dir, weights, drafter


def test_read_local_standin_bundle(tmp_path: Path) -> None:
    bundle, weights, drafter = _write_bundle(tmp_path)
    m = read_eliza_one_bundle(str(bundle))
    assert m.bundle_id == "eliza-1-0.6b"
    assert m.model_size == "0.6b"
    assert m.release_state == "local-standin"
    assert m.publish_eligible is False
    assert m.final.weights is False
    assert m.weights_path == str(weights)
    assert m.drafters_path == str(drafter)
    assert m.sha256 == "0" * 64


def test_drafters_path_is_optional(tmp_path: Path) -> None:
    bundle, _, _ = _write_bundle(tmp_path, include_drafters=False)
    m = read_eliza_one_bundle(str(bundle))
    assert m.drafters_path is None


def test_invalid_model_size_raises(tmp_path: Path) -> None:
    bundle, _, _ = _write_bundle(tmp_path, {"modelSize": "13b"})
    with pytest.raises(ValueError, match="modelSize"):
        read_eliza_one_bundle(str(bundle))


def test_invalid_release_state_raises(tmp_path: Path) -> None:
    bundle, _, _ = _write_bundle(tmp_path, {"releaseState": "bogus"})
    with pytest.raises(ValueError, match="releaseState"):
        read_eliza_one_bundle(str(bundle))


def test_missing_publish_eligible_raises(tmp_path: Path) -> None:
    bundle, _, _ = _write_bundle(tmp_path, omit=("publishEligible",))
    with pytest.raises(ValueError, match="publishEligible"):
        read_eliza_one_bundle(str(bundle))


def test_missing_final_weights_raises(tmp_path: Path) -> None:
    bundle, _, _ = _write_bundle(tmp_path, {"final": {}})
    with pytest.raises(ValueError, match="final.weights"):
        read_eliza_one_bundle(str(bundle))


def test_missing_weights_file_raises(tmp_path: Path) -> None:
    bundle, _, _ = _write_bundle(tmp_path, {"weightsPath": "missing.gguf"})
    with pytest.raises(FileNotFoundError, match="weights file does not exist"):
        read_eliza_one_bundle(str(bundle))


def test_missing_bundle_directory_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="does not exist"):
        read_eliza_one_bundle(str(tmp_path / "missing.bundle"))


def _manifest(
    *,
    release_state: str = "local-standin",
    publish_eligible: bool = False,
    final_weights: bool = False,
) -> ElizaOneBundleManifest:
    return ElizaOneBundleManifest(
        bundle_id="eliza-1-0.6b",
        model_size="0.6b",  # type: ignore[arg-type]
        release_state=release_state,  # type: ignore[arg-type]
        publish_eligible=publish_eligible,
        final=ElizaOneBundleFinal(weights=final_weights),
        weights_path="/tmp/weights.gguf",
        sha256="abc",
    )


def test_local_standin_is_pre_release() -> None:
    assert bundle_is_pre_release(_manifest()) is True


def test_candidate_is_pre_release() -> None:
    assert (
        bundle_is_pre_release(
            _manifest(
                release_state="candidate",
                publish_eligible=False,
                final_weights=False,
            )
        )
        is True
    )


def test_final_without_publish_eligible_is_pre_release() -> None:
    assert (
        bundle_is_pre_release(
            _manifest(
                release_state="final",
                publish_eligible=False,
                final_weights=True,
            )
        )
        is True
    )


def test_final_without_final_weights_is_pre_release() -> None:
    assert (
        bundle_is_pre_release(
            _manifest(
                release_state="final",
                publish_eligible=True,
                final_weights=False,
            )
        )
        is True
    )


def test_fully_green_manifest_is_release() -> None:
    assert (
        bundle_is_pre_release(
            _manifest(
                release_state="final",
                publish_eligible=True,
                final_weights=True,
            )
        )
        is False
    )
