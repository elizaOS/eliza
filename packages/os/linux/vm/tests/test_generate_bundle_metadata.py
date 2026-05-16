#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


VM_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = VM_ROOT / "scripts" / "generate-bundle-metadata.py"


def load_module():
    spec = importlib.util.spec_from_file_location("generate_bundle_metadata", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class GenerateBundleMetadataTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def test_manifest_generation_does_not_require_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["SOURCE_DATE_EPOCH"] = "0"
            try:
                self.module.main(["--output-dir", tmp, "--version", "test-version"])
            finally:
                os.environ.pop("SOURCE_DATE_EPOCH", None)

            manifest = json.loads((Path(tmp) / "manifest.json").read_text(encoding="utf-8"))
            package_metadata = json.loads((Path(tmp) / "package-metadata.json").read_text(encoding="utf-8"))

        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["version"], "test-version")
        self.assertEqual(manifest["generated_at"], "1970-01-01T00:00:00Z")
        self.assertEqual({artifact["name"] for artifact in manifest["artifacts"]}, {"qemu", "utm", "virtualbox"})
        self.assertTrue(all("exists" in artifact for artifact in manifest["artifacts"]))
        self.assertTrue(package_metadata["can_generate_without_images"])
        self.assertIn("quickstarts/qemu.md", package_metadata["metadata_files"])

    def test_require_images_fails_when_selected_artifact_is_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as raised:
                self.module.main(["--output-dir", tmp, "--target", "virtualbox", "--require-images"])

        self.assertIn("required VM image artifacts are missing", str(raised.exception))

    def test_target_filter_limits_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.module.main(["--output-dir", tmp, "--target", "qemu"])
            manifest = json.loads((Path(tmp) / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual([artifact["name"] for artifact in manifest["artifacts"]], ["qemu"])


if __name__ == "__main__":
    unittest.main()
