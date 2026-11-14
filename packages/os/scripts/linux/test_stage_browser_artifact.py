#!/usr/bin/env python3
"""Portable integrity staging tests; synthetic ELF fixtures do not qualify a browser."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("browser_stage", HERE / "stage-browser-artifact.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BrowserStagingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.payload = self.root / "opt/elizaos/browser"
        self.payload.mkdir(parents=True)
        self.receipt = self.root / "verified.json"
        self.source = "1" * 40
        self.receipt.write_text(json.dumps({"schemaVersion": 1, "sourceCommit": self.source, "architecture": "x86_64", "archiveSha256": "2" * 64}))
        self.receipt.chmod(0o600)
        self.data = {"schemaVersion": 1, "architecture": "x86_64", "sourceCommit": self.source, "node": {"version": "24.15.0", "sourceArchive": "https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz", "sourceArchiveSha256": "3" * 64}, "chromium": {"revision": "4" * 40, "version": "156.0.8072.0"}, "extensionId": MODULE.EXTENSION_ID, "files": {}}
        elf = b"\x7fELF\x02\x01\x01" + b"\x00" * 11 + (62).to_bytes(2, "little")
        for name in MODULE.REQUIRED - {MODULE.OVERLAY}:
            executable = name in {"node/bin/node", "chromium/chrome"}
            self.write(name, elf if executable else b"reviewed fixture bytes\n", "0755" if executable else "0644")
        self.overlay = {"chromiumRevision": "4" * 40, "extensionId": MODULE.EXTENSION_ID, "platform": "linux", "unrestrictedAllowlistBypass": False, "releaseBrowserBuildValidated": False, "patchSha256": self.data["files"][MODULE.PATCH]["sha256"], "resources": {name: {key: self.data["files"][f"component/{name}"][key] for key in ("sha256", "bytes")} for name in MODULE.RESOURCES}, "inputs": {"chrome/input.cc": "5" * 64}, "outputs": {"chrome/output.cc": "6" * 64}}
        self.save_overlay()
        self.save()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, content, mode="0644"):
        path = self.payload / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(int(mode, 8))
        self.data["files"][name] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content), "mode": mode}

    def save_overlay(self):
        self.write(MODULE.OVERLAY, json.dumps(self.overlay).encode())

    def save(self):
        (self.payload / MODULE.MANIFEST).write_text(json.dumps(self.data))

    def stage(self, mode="release"):
        return MODULE.stage(self.root, "x86_64", mode, self.receipt)

    def test_valid_integrity_staging_preserves_user_preferences_and_pins_native_origin(self):
        preference = self.root / "home/person/.config/mimeapps.list"
        preference.parent.mkdir(parents=True)
        preference.write_text("existing user preference")
        status = self.stage()
        self.assertEqual(status["status"], "integrity-staged")
        self.assertFalse(status["releaseQualified"])
        host = json.loads((self.root / "etc/chromium/native-messaging-hosts/ai.elizaos.browser.json").read_text())
        self.assertEqual(host["allowed_origins"], [f"chrome-extension://{MODULE.EXTENSION_ID}/"])
        wrapper = (self.root / "usr/libexec/elizaos-browser-native-host").read_text()
        self.assertIn('/opt/elizaos/browser/node/bin/node /opt/elizaos/browser/native-host.mjs "$@"', wrapper)
        self.assertEqual(preference.read_text(), "existing user preference")
        self.assertNotIn("--", (self.root / "usr/bin/chromium").read_text())
        self.assertEqual(self.stage(), status)

    def test_tampered_or_missing_payload_never_installs_registration(self):
        for action in (lambda p: p.write_bytes(b"changed"), lambda p: p.unlink()):
            with self.subTest(action=action):
                path = self.payload / "native-host.mjs"
                original = path.read_bytes()
                action(path)
                with self.assertRaises(MODULE.StagingError):
                    self.stage()
                self.assertFalse((self.root / "usr/bin/chromium").exists())
                path.write_bytes(original)

    def test_wrong_architecture_elf_fails_even_with_updated_file_hash(self):
        path = self.payload / "node/bin/node"
        data = path.read_bytes()[:18] + (183).to_bytes(2, "little")
        self.write("node/bin/node", data, "0755")
        self.save()
        with self.assertRaisesRegex(MODULE.StagingError, "architecture mismatch"):
            self.stage()

    def test_inner_source_cannot_override_authenticated_outer_source(self):
        self.data["sourceCommit"] = "7" * 40
        self.save()
        with self.assertRaisesRegex(MODULE.StagingError, "authenticated desktop source"):
            self.stage()

    def test_symlinks_hardlinks_and_unlisted_files_fail(self):
        target = self.payload / "native-host.mjs"
        saved = target.read_bytes()
        outside = self.root / "outside"
        outside.write_bytes(saved)
        target.unlink()
        target.symlink_to(outside)
        with self.assertRaisesRegex(MODULE.StagingError, "symlink"):
            self.stage()
        target.unlink()
        os.link(outside, target)
        with self.assertRaisesRegex(MODULE.StagingError, "hardlink"):
            self.stage()
        target.unlink()
        target.write_bytes(saved)
        (self.payload / "unlisted").write_text("extra")
        with self.assertRaisesRegex(MODULE.StagingError, "inventory"):
            self.stage()

    def test_partial_inputs_fail_in_development_and_fixture_too(self):
        (self.payload / MODULE.MANIFEST).unlink()
        for mode in ("development", "fixture", "release"):
            with self.subTest(mode=mode), self.assertRaises(MODULE.StagingError):
                self.stage(mode)

    def test_absence_is_explicit_and_release_fails(self):
        import shutil
        shutil.rmtree(self.payload)
        with self.assertRaisesRegex(MODULE.StagingError, "release browser payload is missing"):
            self.stage()
        result = self.stage("fixture")
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["releaseQualified"])
        self.assertFalse((self.root / "usr/bin/chromium").exists())

    def test_unverified_payload_is_rejected_in_every_mode(self):
        for mode in ("release", "fixture", "development"):
            with self.subTest(mode=mode), self.assertRaisesRegex(MODULE.StagingError, "authenticated desktop metadata"):
                MODULE.stage(self.root, "x86_64", mode, None)

    def test_component_hash_identity_or_bypass_mismatch_fails(self):
        for field, value in (("extensionId", "a" * 32), ("unrestrictedAllowlistBypass", True), ("patchSha256", "0" * 64)):
            with self.subTest(field=field):
                original = self.overlay[field]
                self.overlay[field] = value
                self.save_overlay()
                self.save()
                with self.assertRaises(MODULE.StagingError):
                    self.stage()
                self.overlay[field] = original

    def test_permissions_and_destination_links_fail(self):
        (self.payload / "native-host.mjs").chmod(0o666)
        with self.assertRaisesRegex(MODULE.StagingError, "writable"):
            self.stage()
        (self.payload / "native-host.mjs").chmod(0o644)
        (self.root / "usr").symlink_to(self.root / "outside")
        with self.assertRaisesRegex(MODULE.StagingError, "linked"):
            self.stage()
        self.assertFalse((self.root / "outside").exists())

    def test_unrelated_system_browser_is_not_overwritten(self):
        path = self.root / "usr/bin/chromium"
        path.parent.mkdir(parents=True)
        path.write_text("distro browser")
        with self.assertRaisesRegex(MODULE.StagingError, "unrelated system"):
            self.stage()
        self.assertEqual(path.read_text(), "distro browser")
        self.assertFalse((self.root / "etc/chromium").exists())

    def test_pinned_node_version_cannot_change(self):
        self.data["node"]["version"] = "24.0.0"
        self.save()
        with self.assertRaisesRegex(MODULE.StagingError, "Node version"):
            self.stage()

    def test_bitwarden_policy_is_exact_and_user_disableable(self):
        self.stage()
        policy = json.loads((self.root / MODULE.BITWARDEN_POLICY_PATH).read_text())
        self.assertEqual(policy, {"ExtensionSettings": {
            "nngceckbapebfimnlniiiahkandclblb": {
                "installation_mode": "normal_installed",
                "update_url": "https://clients2.google.com/service/update2/crx",
            }
        }})
        self.assertFalse((self.root / "home").exists())

    def test_overlapping_managed_or_recommended_policy_is_never_overwritten(self):
        for level in ("managed", "recommended"):
            with self.subTest(level=level):
                path = self.root / f"etc/chromium/policies/{level}/other.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                original = json.dumps({"ExtensionSettings": {"*": {"installation_mode": "blocked"}}})
                path.write_text(original)
                with self.assertRaisesRegex(MODULE.StagingError, "overlapping"):
                    self.stage()
                self.assertEqual(path.read_text(), original)
                self.assertFalse((self.root / "usr/bin/chromium").exists())
                path.unlink()

    def test_registration_without_payload_is_partial_in_development(self):
        import shutil
        shutil.rmtree(self.payload)
        path = self.root / MODULE.BITWARDEN_POLICY_PATH
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(MODULE.BITWARDEN_POLICY))
        with self.assertRaisesRegex(MODULE.StagingError, "partial"):
            self.stage("development")

    def test_non_searchable_directories_and_setid_modes_are_rejected(self):
        for directory in (self.payload, self.payload / "node"):
            for mode in (0o700, 0o775, 0o1755):
                with self.subTest(directory=directory, mode=mode):
                    directory.chmod(mode)
                    with self.assertRaises(MODULE.StagingError):
                        self.stage()
                    directory.chmod(0o755)
        self.data["files"]["chromium/chrome"]["mode"] = "4755"
        (self.payload / "chromium/chrome").chmod(0o4755)
        self.save()
        with self.assertRaisesRegex(MODULE.StagingError, "mode mismatch"):
            self.stage()

    def test_private_receipt_is_required(self):
        self.receipt.chmod(0o644)
        with self.assertRaisesRegex(MODULE.StagingError, "private regular"):
            self.stage()

    def test_late_registration_collision_prevents_all_writes(self):
        path = self.root / "usr/share/elizaos/browser-staging-status.json"
        path.parent.mkdir(parents=True)
        path.write_text("unrelated")
        with self.assertRaisesRegex(MODULE.StagingError, "unrelated system"):
            self.stage()
        self.assertFalse((self.root / "usr/bin/chromium").exists())

    def test_policy_collision_without_json_suffix_is_rejected(self):
        path = self.root / "etc/chromium/policies/managed/99-managed-policy"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"ExtensionSettings": {"*": {"installation_mode": "blocked"}}}))
        with self.assertRaisesRegex(MODULE.StagingError, "overlapping"):
            self.stage()
        self.assertFalse((self.root / "usr/bin/chromium").exists())

    def test_unsupported_policy_json_syntax_fails_closed(self):
        path = self.root / "etc/chromium/policies/managed/commented-policy"
        path.parent.mkdir(parents=True)
        path.write_text('{// Chromium accepts comments\n"ExtensionSettings": {},}')
        with self.assertRaisesRegex(MODULE.StagingError, "invalid JSON"):
            self.stage()
        self.assertFalse((self.root / "usr/bin/chromium").exists())


if __name__ == "__main__":
    unittest.main()
