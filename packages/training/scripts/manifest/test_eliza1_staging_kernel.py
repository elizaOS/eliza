"""Conformance tests for the shared Eliza-1 staging graph and filesystem kernel."""

from __future__ import annotations

from pathlib import Path

from scripts.manifest.eliza1_staging_kernel import (
    StagingProfile,
    ensure_release_dirs,
    profile_graph,
    stage_file,
    validate_checksum_manifest,
    write_checksum_manifest,
)
from scripts.manifest.stage_local_eliza1_bundle import LOCAL_STAGING_PROFILE
from scripts.manifest.stage_real_eliza1_bundle import REAL_STAGING_PROFILE


def test_profiles_share_the_common_graph_and_pin_intentional_policy() -> None:
    local = set(profile_graph(LOCAL_STAGING_PROFILE, "2b"))
    real = set(profile_graph(REAL_STAGING_PROFILE, "2b"))
    assert local - real == {"source"}
    assert real - local == set()
    assert "vision" in real
    assert "embedding" not in real
    assert profile_graph(REAL_STAGING_PROFILE, "27b-256k") == tuple(
        path for path in REAL_STAGING_PROFILE.release_dirs if path != "embedding"
    )


def test_profile_graph_drives_directory_creation(tmp_path: Path) -> None:
    profile = StagingProfile(
        name="test",
        release_dirs=("always", "selected", "excluded"),
        conditional_dirs={
            "selected": frozenset({"2b"}),
            "excluded": frozenset({"4b"}),
        },
    )
    ensure_release_dirs(tmp_path, profile, "2b")
    assert sorted(path.name for path in tmp_path.iterdir()) == ["always", "selected"]


def test_shared_stage_and_checksum_kernel_is_replay_safe(tmp_path: Path) -> None:
    source = tmp_path / "source.gguf"
    source.write_bytes(b"weights")
    destination = tmp_path / "bundle" / "text" / "model.gguf"
    first = stage_file(
        role="text",
        source=source,
        destination=destination,
        provenance="test",
        force=False,
    )
    second = stage_file(
        role="text",
        source=source,
        destination=destination,
        provenance="test",
        force=False,
    )
    assert first.sha256 == second.sha256
    assert second.method == "existing"
    write_checksum_manifest(tmp_path / "bundle")
    assert validate_checksum_manifest(tmp_path / "bundle") == ()
