#!/usr/bin/env python3
"""Verify a staged elizaOS desktop artifact and its external trust root."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePath

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
except ImportError as exc:  # pragma: no cover - exercised on dependency-broken hosts
    raise SystemExit(
        "python3-cryptography is required for Ed25519 artifact verification"
    ) from exc


ENTRYPOINTS = {
    "desktop": "bin/eliza-desktop",
    "agent": "bin/eliza-agent",
    "doctor": "bin/eliza-doctor",
}
CAPABILITIES = (
    "tray",
    "overlay",
    "wayland",
    "cloudAuth",
    "computerUse",
    "remoteControl",
)
SHA256_RE = re.compile(r"[0-9a-f]{64}")
SOURCE_COMMIT_RE = re.compile(r"[0-9a-f]{40}")
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?")
MANIFEST_FIELDS = {
    "schemaVersion",
    "sourceCommit",
    "version",
    "architecture",
    "shell",
    "archive",
    "sha256",
    "signature",
    "manifestSignature",
    "entrypoints",
    "capabilities",
}
ELF_MACHINE = {"x86_64": 62, "arm64": 183, "riscv64": 243}


class VerificationError(ValueError):
    """A fail-closed artifact contract violation."""


def _verify_entrypoint_architecture(
    entrypoint: Path,
    role: str,
    expected_architecture: str,
    *,
    require_elf: bool = False,
) -> None:
    """Reject native entrypoints that cannot execute on the target image."""
    with entrypoint.open("rb") as stream:
        header = stream.read(20)
    if header[:4] != b"\x7fELF":
        if require_elf:
            raise VerificationError(
                "desktop artifact native shell must be a little-endian 64-bit ELF"
            )
        if not header.startswith(b"#!") or b"\n" not in header:
            raise VerificationError(
                f"desktop artifact {role} must be a script or a native ELF"
            )
        return
    if len(header) < 20 or header[4] != 2 or header[5] != 1:
        if require_elf:
            raise VerificationError(
                "desktop artifact native shell must be a little-endian 64-bit ELF"
            )
        raise VerificationError(
            f"desktop artifact {role} must be a little-endian 64-bit ELF"
        )
    expected_machine = ELF_MACHINE.get(expected_architecture)
    actual_machine = int.from_bytes(header[18:20], "little")
    if expected_machine is None or actual_machine != expected_machine:
        if require_elf:
            raise VerificationError(
                "desktop artifact native shell architecture does not match image"
            )
        raise VerificationError(
            f"desktop artifact {role} architecture does not match image"
        )


def _plain_filename(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or PurePath(value).name != value:
        raise VerificationError(f"desktop artifact {field} name is invalid")
    return value


def _load_public_key(path: Path) -> tuple[Ed25519PublicKey, bytes]:
    if not path.is_file() or path.is_symlink():
        raise VerificationError("desktop signing public key is unavailable or is a symlink")
    try:
        encoded = path.read_bytes()
    except OSError as exc:
        raise VerificationError(f"desktop signing public key is unavailable: {exc}") from exc
    try:
        if encoded.lstrip().startswith(b"-----BEGIN"):
            key = serialization.load_pem_public_key(encoded)
        else:
            key = serialization.load_der_public_key(encoded)
    except (TypeError, ValueError) as exc:
        raise VerificationError("desktop signing public key is malformed") from exc
    if not isinstance(key, Ed25519PublicKey):
        raise VerificationError("desktop signing public key is not Ed25519")
    spki = key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return key, spki


def _verify_archive_signature(
    public_key: Ed25519PublicKey, signature: bytes, archive_path: Path
) -> None:
    if len(signature) != 64:
        raise VerificationError("desktop artifact Ed25519 signature must be 64 bytes")
    try:
        # cryptography 41 (shipped by Ubuntu 24.04) requires a concrete bytes
        # object here; newer releases also accept some buffer-protocol objects.
        # Ed25519 verification is one-shot in OpenSSL, so mmap cannot make this
        # operation streaming and only makes behavior version-dependent.
        public_key.verify(signature, archive_path.read_bytes())
    except InvalidSignature as exc:
        raise VerificationError("desktop artifact Ed25519 signature is invalid") from exc
    except OSError as exc:
        raise VerificationError(f"desktop artifact archive cannot be read: {exc}") from exc


def decode_signature(encoded: bytes) -> bytes:
    if len(encoded) == 64:
        return encoded
    try:
        text = encoded.decode("ascii")
        decoded = base64.b64decode(text, validate=True)
    except (UnicodeDecodeError, binascii.Error) as exc:
        raise VerificationError(
            "desktop artifact signature must be raw or canonical base64 Ed25519"
        ) from exc
    if base64.b64encode(decoded).decode("ascii") != text or len(decoded) != 64:
        raise VerificationError(
            "desktop artifact signature must be raw or canonical base64 Ed25519"
        )
    return decoded


def verify(
    manifest_path: Path,
    expected_architecture: str,
    public_key_path: Path,
    expected_spki_sha256: str,
) -> tuple[Path, Ed25519PublicKey, bytes, str]:
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise VerificationError("desktop artifact manifest is absent or is a symlink")
    if manifest_path.name != "desktop-artifact-manifest.json":
        raise VerificationError(
            "desktop artifact manifest must be named desktop-artifact-manifest.json"
        )
    if not SHA256_RE.fullmatch(expected_spki_sha256):
        raise VerificationError(
            "ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY_SPKI_SHA256 must be 64 lowercase hex characters"
        )
    public_key, public_spki = _load_public_key(public_key_path)
    actual_pin = hashlib.sha256(public_spki).hexdigest()
    if actual_pin != expected_spki_sha256:
        raise VerificationError("desktop signing public key does not match the pinned SPKI digest")

    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest_signature_path = manifest_path.with_name(
            "desktop-artifact-manifest.json.sig"
        )
        if not manifest_signature_path.is_file() or manifest_signature_path.is_symlink():
            raise VerificationError(
                "desktop artifact manifest signature is absent or is a symlink"
            )
        manifest_signature = decode_signature(manifest_signature_path.read_bytes())
        public_key.verify(manifest_signature, manifest_bytes)
    except InvalidSignature as exc:
        raise VerificationError("desktop artifact manifest signature is invalid") from exc
    except OSError as exc:
        raise VerificationError(f"desktop artifact manifest cannot be authenticated: {exc}") from exc

    try:
        data = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"desktop artifact manifest is unreadable: {exc}") from exc

    if not isinstance(data, dict) or set(data) != MANIFEST_FIELDS:
        raise VerificationError("desktop artifact manifest fields do not match schema v1")
    if data.get("schemaVersion") != 1:
        raise VerificationError("desktop artifact schemaVersion must be 1")
    if data.get("manifestSignature") != "desktop-artifact-manifest.json.sig":
        raise VerificationError(
            "desktop artifact manifestSignature must name desktop-artifact-manifest.json.sig"
        )
    if not isinstance(data.get("sourceCommit"), str) or not SOURCE_COMMIT_RE.fullmatch(
        data["sourceCommit"]
    ):
        raise VerificationError("desktop artifact sourceCommit is invalid")
    if not isinstance(data.get("version"), str) or not VERSION_RE.fullmatch(data["version"]):
        raise VerificationError("desktop artifact version is invalid")
    if data.get("architecture") != expected_architecture:
        raise VerificationError("desktop artifact architecture does not match image")
    if data.get("shell") != "gtk-webkit":
        raise VerificationError("desktop artifact shell must be gtk-webkit")
    if data.get("entrypoints") != ENTRYPOINTS:
        raise VerificationError(
            "desktop artifact entrypoints must be archive-relative bin/* paths"
        )
    capabilities = data.get("capabilities")
    if not isinstance(capabilities, dict) or set(capabilities) != set(CAPABILITIES):
        raise VerificationError("desktop artifact capability fields do not match schema v1")
    if not all(capabilities.get(name) is True for name in CAPABILITIES):
        raise VerificationError("desktop artifact capability contract is incomplete")

    expected_archive_digest = data.get("sha256", "")
    if not isinstance(expected_archive_digest, str) or not SHA256_RE.fullmatch(
        expected_archive_digest
    ):
        raise VerificationError("desktop artifact sha256 is invalid")

    archive_name = _plain_filename(data.get("archive"), "archive")
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.tar\.zst", archive_name):
        raise VerificationError("desktop artifact archive must use the .tar.zst contract")
    archive_path = manifest_path.parent / archive_name
    signature_name = _plain_filename(data.get("signature"), "detached signature")
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.sig", signature_name):
        raise VerificationError("desktop artifact archive signature filename is invalid")
    signature_path = manifest_path.parent / signature_name
    if not archive_path.is_file() or archive_path.is_symlink():
        raise VerificationError("desktop artifact archive is absent or is a symlink")
    if not signature_path.is_file() or signature_path.is_symlink():
        raise VerificationError("desktop artifact detached signature is absent or is a symlink")

    digest = hashlib.sha256()
    try:
        with archive_path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise VerificationError(f"desktop artifact archive cannot be read: {exc}") from exc
    if digest.hexdigest() != expected_archive_digest:
        raise VerificationError("desktop artifact archive digest does not match manifest")

    try:
        signature = decode_signature(signature_path.read_bytes())
    except OSError as exc:
        raise VerificationError(f"desktop artifact signature cannot be read: {exc}") from exc
    _verify_archive_signature(public_key, signature, archive_path)
    return archive_path, public_key, signature, expected_archive_digest


def extract_verified_archive(
    archive_path: Path,
    destination: Path,
    public_key: Ed25519PublicKey,
    signature: bytes,
    expected_digest: str,
    expected_architecture: str,
) -> None:
    """Safely stage a verified archive, reverify it, then install its payload."""
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise VerificationError("desktop artifact destination is not a regular directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = Path(
        tempfile.mkdtemp(prefix=".elizaos-desktop-", dir=destination.parent)
    )
    decompressor: subprocess.Popen[bytes] | None = None
    try:
        if not hasattr(tarfile, "data_filter"):
            raise VerificationError("Python tar data-filter support is required for extraction")
        if archive_path.name.endswith(".zst"):
            zstd = shutil.which("zstd")
            if not zstd:
                raise VerificationError("zstd is required to extract the signed desktop archive")
            decompressor = subprocess.Popen(
                [zstd, "--decompress", "--stdout", "--", str(archive_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            assert decompressor.stdout is not None
            archive = tarfile.open(fileobj=decompressor.stdout, mode="r|")
        else:
            archive = tarfile.open(archive_path, mode="r:*")
        seen: set[str] = set()
        try:
            for member in archive:
                if member.name in seen:
                    raise VerificationError(
                        f"desktop artifact contains duplicate member: {member.name}"
                    )
                seen.add(member.name)
                try:
                    archive.extract(member, temporary, filter="data")
                except tarfile.FilterError as exc:
                    raise VerificationError(
                        f"desktop artifact contains an unsafe archive member: {member.name}"
                    ) from exc
        finally:
            archive.close()
        if decompressor is not None:
            _, stderr = decompressor.communicate()
            if decompressor.returncode != 0:
                raise VerificationError(
                    "zstd failed while extracting desktop artifact: "
                    + stderr.decode("utf-8", errors="replace").strip()
                )

        for relative in ENTRYPOINTS.values():
            entrypoint = temporary / relative
            if (
                not entrypoint.is_file()
                or entrypoint.is_symlink()
                or not (entrypoint.stat().st_mode & 0o111)
            ):
                raise VerificationError(
                    f"desktop artifact entrypoint is missing, linked, or not executable: {relative}"
                )
        for role, relative in ENTRYPOINTS.items():
            _verify_entrypoint_architecture(
                temporary / relative,
                role,
                expected_architecture,
                require_elf=role == "desktop",
            )

        # Detect any source mutation between initial authentication and install.
        if sha256_file(archive_path) != expected_digest:
            raise VerificationError("desktop artifact archive changed during extraction")
        _verify_archive_signature(public_key, signature, archive_path)
        if destination.exists():
            shutil.rmtree(destination)
        temporary.replace(destination)
        temporary = None
    except (OSError, tarfile.TarError) as exc:
        raise VerificationError(f"desktop artifact extraction failed: {exc}") from exc
    finally:
        if decompressor is not None and decompressor.poll() is None:
            decompressor.kill()
            decompressor.wait()
        if temporary is not None:
            shutil.rmtree(temporary, ignore_errors=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify an elizaOS desktop artifact with a pinned Ed25519 key"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--architecture", required=True)
    parser.add_argument("--public-key", required=True, type=Path)
    parser.add_argument("--public-key-spki-sha256", required=True)
    parser.add_argument("--extract-to", type=Path)
    args = parser.parse_args()
    try:
        archive_path, public_key, signature, expected_digest = verify(
            args.manifest,
            args.architecture,
            args.public_key,
            args.public_key_spki_sha256,
        )
        if args.extract_to:
            extract_verified_archive(
                archive_path,
                args.extract_to,
                public_key,
                signature,
                expected_digest,
                args.architecture,
            )
    except VerificationError as exc:
        print(f"[desktop-artifact] verification failed: {exc}", file=sys.stderr)
        return 1
    print(
        "[desktop-artifact] verified exact manifest and archive bytes with Ed25519"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
