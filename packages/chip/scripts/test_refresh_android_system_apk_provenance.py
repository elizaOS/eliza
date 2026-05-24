#!/usr/bin/env python3
"""Tests for refresh_android_system_apk_provenance.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_system_apk_payload as payload_gate  # noqa: E402
import refresh_android_system_apk_provenance as refresh  # noqa: E402


class RefreshAndroidSystemApkProvenanceTests(unittest.TestCase):
    def test_refresh_replaces_stale_name_and_host_local_repo_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = Path(tmpdir) / "Eliza.apk"
            with zipfile.ZipFile(apk, "w") as zf:
                zf.writestr("AndroidManifest.xml", "x")
                zf.writestr(
                    payload_gate.PROVENANCE_ENTRY,
                    json.dumps(
                        {
                            "schema": payload_gate.AOSP_PROVENANCE_SCHEMA,
                            "claim_boundary": payload_gate.AOSP_PROVENANCE_CLAIM_BOUNDARY,
                            "apk_name": "Milady.apk",
                            "repo_root": "/home/shaw/milady",
                            "android_package": "ai.elizaos.app",
                        }
                    ),
                )

            with mock.patch.object(refresh, "current_git_revision", return_value="abc123"):
                provenance = refresh.refresh_apk(apk)

            self.assertEqual(provenance["apk_name"], "Eliza.apk")
            self.assertEqual(provenance["repo_root"], ".")
            self.assertEqual(provenance["repo_root_provenance"], "relative_to_git_checkout")
            with zipfile.ZipFile(apk) as zf:
                entries = [
                    info.filename
                    for info in zf.infolist()
                    if info.filename == payload_gate.PROVENANCE_ENTRY
                ]
                refreshed = json.loads(zf.read(payload_gate.PROVENANCE_ENTRY))
            self.assertEqual(entries, [payload_gate.PROVENANCE_ENTRY])
            self.assertEqual(refreshed["apk_name"], "Eliza.apk")
            self.assertEqual(refreshed["repo_root"], ".")


if __name__ == "__main__":
    unittest.main()
