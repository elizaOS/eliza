"""Conformance tests for the shared Eliza-1 staging graph and filesystem kernel."""

from __future__ import annotations

from pathlib import Path

from scripts.manifest.eliza1_staging_kernel import (
    StagingProfile,
    ensure_release_dirs,
    stage_file,
    validate_checksum_manifest,
    write_checksum_manifest,
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


def test_checksum_validation_rejects_deleted_tampered_and_duplicate_entries(tmp_path: Path) -> None:
    artifact = tmp_path / "model.gguf"
    artifact.write_bytes(b"complete weights")
    manifest = write_checksum_manifest(tmp_path)
    original = manifest.read_text()
    artifact.unlink()
    assert validate_checksum_manifest(tmp_path), "deleted recorded artifact must fail"
    artifact.write_bytes(b"tampered weights")
    assert validate_checksum_manifest(tmp_path), "changed artifact must fail"
    artifact.write_bytes(b"complete weights")
    manifest.write_text(original + original)
    assert validate_checksum_manifest(tmp_path), "duplicate records must fail"
    manifest.write_text(original + "0" * 64 + "  model.gguf\n")
    assert validate_checksum_manifest(tmp_path), "conflicting records must fail"
    manifest.write_text(original)
    assert validate_checksum_manifest(tmp_path) == ()


def test_checksum_inventory_rejects_external_paths_without_hashing_them(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "model.gguf").write_bytes(b"weights")
    manifest = write_checksum_manifest(bundle)
    external = tmp_path / "external"
    external.mkdir()
    manifest.write_text(manifest.read_text() + "0" * 64 + "  ../external\n")
    assert validate_checksum_manifest(bundle), "recorded external directory must be rejected, not opened"


def test_checksum_validation_rejects_an_external_artifact_symlink(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "model.gguf").write_bytes(b"weights")
    write_checksum_manifest(bundle)
    external = tmp_path / "outside.gguf"
    external.write_bytes(b"outside weights")
    (bundle / "outside.gguf").symlink_to(external)
    external.chmod(0)
    try:
        assert validate_checksum_manifest(bundle), "outside artifact must fail without being read"
    finally:
        external.chmod(0o600)
