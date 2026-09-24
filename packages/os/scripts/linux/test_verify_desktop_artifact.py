#!/usr/bin/env python3
"""Host-portable negative tests for the signed desktop artifact boundary."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


SCRIPT = Path(__file__).with_name("verify-desktop-artifact.py")
SPEC = importlib.util.spec_from_file_location("verify_desktop_artifact", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

# RFC 8032 section 7.1, test vector 1: Ed25519 signature of the empty message.
PUBLIC_KEY = bytes.fromhex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
)
SIGNATURE = bytes.fromhex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)
SPKI = bytes.fromhex("302a300506032b6570032100") + PUBLIC_KEY
PEM = (
    b"-----BEGIN PUBLIC KEY-----\n"
    + base64.encodebytes(SPKI)
    + b"-----END PUBLIC KEY-----\n"
)
PIN = hashlib.sha256(SPKI).hexdigest()


class ArtifactVerificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.archive = self.root / "desktop.tar.zst"
        self.signature = self.root / "desktop.tar.zst.sig"
        self.manifest_signature = self.root / "desktop-artifact-manifest.json.sig"
        self.key = self.root / "desktop-signing-public.pem"
        self.manifest = self.root / "desktop-artifact-manifest.json"
        self.private_key = Ed25519PrivateKey.generate()
        public_key = self.private_key.public_key()
        spki = public_key.public_bytes(
            MODULE.serialization.Encoding.DER,
            MODULE.serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self.pin = hashlib.sha256(spki).hexdigest()
        self.archive.write_bytes(b"")
        self.signature.write_bytes(self.private_key.sign(b""))
        self.key.write_bytes(
            public_key.public_bytes(
                MODULE.serialization.Encoding.PEM,
                MODULE.serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        self.manifest.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
                    "version": "0.1.0-beta.1",
                    "architecture": "x86_64",
                    "shell": "gtk-webkit",
                    "archive": self.archive.name,
                    "signature": self.signature.name,
                    "manifestSignature": self.manifest_signature.name,
                    "sha256": hashlib.sha256(b"").hexdigest(),
                    "entrypoints": MODULE.ENTRYPOINTS,
                    "capabilities": {name: True for name in MODULE.CAPABILITIES},
                }
            ),
            encoding="utf-8",
        )
        self.sign_manifest()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def sign_manifest(self, base64_encoding: bool = False) -> None:
        signature = self.private_key.sign(self.manifest.read_bytes())
        self.manifest_signature.write_bytes(
            base64.b64encode(signature) if base64_encoding else signature
        )

    def verify(self, pin=None) -> None:
        MODULE.verify(self.manifest, "x86_64", self.key, pin or self.pin)

    def make_signed_tar(
        self,
        unsafe: bool = False,
        desktop_machine: int = 62,
        agent_machine: int | None = None,
        doctor_machine: int | None = None,
        invalid_role: str | None = None,
    ) -> tuple[object, str]:
        private_key = Ed25519PrivateKey.generate()
        self.archive = self.root / "desktop.tar.zst"
        with tarfile.open(self.archive, "w") as archive:
            if unsafe:
                member = tarfile.TarInfo("../escape")
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
            native_machines = {
                MODULE.ENTRYPOINTS["desktop"]: desktop_machine,
                MODULE.ENTRYPOINTS["agent"]: agent_machine,
                MODULE.ENTRYPOINTS["doctor"]: doctor_machine,
            }
            for relative in MODULE.ENTRYPOINTS.values():
                member = tarfile.TarInfo(relative)
                machine = native_machines[relative]
                if invalid_role and relative == MODULE.ENTRYPOINTS[invalid_role]:
                    content = b"not-a-script-or-native-elf\n"
                elif machine is not None:
                    content = (
                        b"\x7fELF\x02\x01\x01"
                        + b"\x00" * 11
                        + machine.to_bytes(2, "little")
                    )
                else:
                    content = b"#!/bin/sh\nexit 0\n"
                member.size = len(content)
                member.mode = 0o755
                archive.addfile(member, io.BytesIO(content))
        signature = private_key.sign(self.archive.read_bytes())
        public_key = private_key.public_key()
        spki = public_key.public_bytes(
            MODULE.serialization.Encoding.DER,
            MODULE.serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self.key.write_bytes(
            public_key.public_bytes(
                MODULE.serialization.Encoding.PEM,
                MODULE.serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        self.signature.write_bytes(signature)
        data = json.loads(self.manifest.read_text())
        data["archive"] = self.archive.name
        data["sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.manifest.write_text(json.dumps(data))
        self.private_key = private_key
        self.sign_manifest()
        return public_key, hashlib.sha256(spki).hexdigest()

    def test_signed_fixture_verifies_manifest_and_exact_archive_bytes(self) -> None:
        self.verify()

    def test_rfc8032_archive_signature_vector(self) -> None:
        key = MODULE.serialization.load_pem_public_key(PEM)
        MODULE._verify_archive_signature(key, SIGNATURE, self.archive)

    def test_tampered_archive_is_rejected(self) -> None:
        self.archive.write_bytes(b"tampered")
        with self.assertRaisesRegex(MODULE.VerificationError, "digest does not match"):
            self.verify()

    def test_tampered_signature_is_rejected(self) -> None:
        signature = self.signature.read_bytes()
        self.signature.write_bytes(bytes([signature[0] ^ 1]) + signature[1:])
        with self.assertRaisesRegex(MODULE.VerificationError, "signature is invalid"):
            self.verify()

    def test_canonical_base64_signature_verifies(self) -> None:
        self.signature.write_bytes(base64.b64encode(self.signature.read_bytes()))
        self.verify()

    def test_noncanonical_base64_signature_is_rejected(self) -> None:
        self.signature.write_bytes(
            base64.b64encode(self.signature.read_bytes()) + b"\n"
        )
        with self.assertRaisesRegex(MODULE.VerificationError, "canonical base64"):
            self.verify()

    def test_canonical_base64_manifest_signature_verifies(self) -> None:
        self.sign_manifest(base64_encoding=True)
        self.verify()

    def test_modified_manifest_bytes_are_rejected_before_metadata(self) -> None:
        data = json.loads(self.manifest.read_text())
        data["architecture"] = "arm64"
        self.manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(MODULE.VerificationError, "manifest signature is invalid"):
            self.verify()

    def test_tampered_manifest_signature_is_rejected(self) -> None:
        signature = self.manifest_signature.read_bytes()
        self.manifest_signature.write_bytes(
            bytes([signature[0] ^ 1]) + signature[1:]
        )
        with self.assertRaisesRegex(MODULE.VerificationError, "manifest signature is invalid"):
            self.verify()

    def test_symlinked_manifest_signature_is_rejected(self) -> None:
        target = self.root / "manifest-signature-target"
        self.manifest_signature.replace(target)
        self.manifest_signature.symlink_to(target)
        with self.assertRaisesRegex(MODULE.VerificationError, "manifest signature.*symlink"):
            self.verify()

    def test_missing_manifest_signature_is_rejected(self) -> None:
        self.manifest_signature.unlink()
        with self.assertRaisesRegex(MODULE.VerificationError, "manifest signature is absent"):
            self.verify()

    def test_manifest_signature_filename_contract_is_fixed(self) -> None:
        data = json.loads(self.manifest.read_text())
        data["manifestSignature"] = "alternate.sig"
        self.manifest.write_text(json.dumps(data))
        self.sign_manifest()
        with self.assertRaisesRegex(MODULE.VerificationError, "must name desktop-artifact"):
            self.verify()

    def test_unknown_manifest_field_is_rejected(self) -> None:
        data = json.loads(self.manifest.read_text())
        data["unexpected"] = True
        self.manifest.write_text(json.dumps(data))
        self.sign_manifest()
        with self.assertRaisesRegex(MODULE.VerificationError, "fields do not match"):
            self.verify()

    def test_wrong_archive_suffix_is_rejected(self) -> None:
        data = json.loads(self.manifest.read_text())
        data["archive"] = "desktop.tar"
        self.manifest.write_text(json.dumps(data))
        self.sign_manifest()
        with self.assertRaisesRegex(MODULE.VerificationError, "tar.zst contract"):
            self.verify()

    def test_wrong_external_key_pin_is_rejected(self) -> None:
        with self.assertRaisesRegex(MODULE.VerificationError, "does not match the pinned"):
            self.verify("0" * 64)

    def test_missing_external_key_is_rejected(self) -> None:
        self.key.unlink()
        with self.assertRaisesRegex(MODULE.VerificationError, "public key is unavailable"):
            self.verify()

    def test_symlinked_archive_is_rejected(self) -> None:
        target = self.root / "target"
        target.write_bytes(b"")
        self.archive.unlink()
        self.archive.symlink_to(target)
        with self.assertRaisesRegex(MODULE.VerificationError, "symlink"):
            self.verify()

    def test_symlinked_manifest_is_rejected(self) -> None:
        real_manifest = self.root / "real-manifest.json"
        self.manifest.replace(real_manifest)
        self.manifest.symlink_to(real_manifest)
        with self.assertRaisesRegex(MODULE.VerificationError, "manifest.*symlink"):
            self.verify()

    def test_extra_capability_is_rejected(self) -> None:
        data = json.loads(self.manifest.read_text())
        data["capabilities"]["unreviewed"] = True
        self.manifest.write_text(json.dumps(data))
        self.sign_manifest()
        with self.assertRaisesRegex(MODULE.VerificationError, "capability fields"):
            self.verify()

    def test_verified_archive_is_the_installed_payload(self) -> None:
        public_key, pin = self.make_signed_tar()
        archive, _, signature, digest = MODULE.verify(
            self.manifest, "x86_64", self.key, pin
        )
        uncompressed_archive = self.root / "desktop.tar"
        uncompressed_archive.write_bytes(archive.read_bytes())
        destination = self.root / "installed"
        MODULE.extract_verified_archive(
            uncompressed_archive,
            destination,
            public_key,
            signature,
            digest,
            "x86_64",
        )
        for relative in MODULE.ENTRYPOINTS.values():
            self.assertTrue((destination / relative).is_file())

    def test_signed_path_traversal_archive_is_rejected(self) -> None:
        public_key, pin = self.make_signed_tar(unsafe=True)
        archive, _, signature, digest = MODULE.verify(
            self.manifest, "x86_64", self.key, pin
        )
        uncompressed_archive = self.root / "desktop.tar"
        uncompressed_archive.write_bytes(archive.read_bytes())
        with self.assertRaisesRegex(MODULE.VerificationError, "unsafe archive member"):
            MODULE.extract_verified_archive(
                uncompressed_archive,
                self.root / "installed",
                public_key,
                signature,
                digest,
                "x86_64",
            )
        self.assertFalse((self.root.parent / "escape").exists())

    def test_signed_wrong_architecture_payload_is_rejected(self) -> None:
        public_key, pin = self.make_signed_tar(desktop_machine=183)
        archive, _, signature, digest = MODULE.verify(
            self.manifest, "x86_64", self.key, pin
        )
        uncompressed_archive = self.root / "desktop.tar"
        uncompressed_archive.write_bytes(archive.read_bytes())
        with self.assertRaisesRegex(MODULE.VerificationError, "architecture does not match"):
            MODULE.extract_verified_archive(
                uncompressed_archive,
                self.root / "installed",
                public_key,
                signature,
                digest,
                "x86_64",
            )

    def test_signed_native_entrypoints_for_image_architecture_are_installed(self) -> None:
        public_key, pin = self.make_signed_tar(agent_machine=62, doctor_machine=62)
        archive, _, signature, digest = MODULE.verify(
            self.manifest, "x86_64", self.key, pin
        )
        uncompressed_archive = self.root / "desktop.tar"
        uncompressed_archive.write_bytes(archive.read_bytes())
        destination = self.root / "installed"
        MODULE.extract_verified_archive(
            uncompressed_archive,
            destination,
            public_key,
            signature,
            digest,
            "x86_64",
        )
        for relative in MODULE.ENTRYPOINTS.values():
            self.assertTrue((destination / relative).is_file())

    def test_signed_wrong_architecture_native_helper_is_rejected(self) -> None:
        for role in ("agent", "doctor"):
            with self.subTest(role=role):
                machine_arguments = {f"{role}_machine": 183}
                public_key, pin = self.make_signed_tar(**machine_arguments)
                archive, _, signature, digest = MODULE.verify(
                    self.manifest, "x86_64", self.key, pin
                )
                uncompressed_archive = self.root / f"desktop-{role}.tar"
                uncompressed_archive.write_bytes(archive.read_bytes())
                destination = self.root / f"installed-{role}"
                with self.assertRaisesRegex(
                    MODULE.VerificationError,
                    rf"{role} architecture does not match",
                ):
                    MODULE.extract_verified_archive(
                        uncompressed_archive,
                        destination,
                        public_key,
                        signature,
                        digest,
                        "x86_64",
                    )
                self.assertFalse(destination.exists())

    def test_signed_non_script_non_elf_helper_is_rejected(self) -> None:
        public_key, pin = self.make_signed_tar(invalid_role="agent")
        archive, _, signature, digest = MODULE.verify(
            self.manifest, "x86_64", self.key, pin
        )
        uncompressed_archive = self.root / "desktop-invalid-helper.tar"
        uncompressed_archive.write_bytes(archive.read_bytes())
        destination = self.root / "installed-invalid-helper"
        with self.assertRaisesRegex(
            MODULE.VerificationError,
            r"agent must be a script or a native ELF",
        ):
            MODULE.extract_verified_archive(
                uncompressed_archive,
                destination,
                public_key,
                signature,
                digest,
                "x86_64",
            )
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
