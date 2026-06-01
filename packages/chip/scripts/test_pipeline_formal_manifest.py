#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / "scripts/pipeline_check.py"


def load_pipeline_module():
    spec = importlib.util.spec_from_file_location("pipeline_check", PIPELINE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FormalManifestGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pipeline = load_pipeline_module()

    def write_manifest(self, root: Path, *, mode: str, evidence_class: str) -> None:
        report = root / "build/reports"
        report.mkdir(parents=True)
        log = report / "formal.log"
        log.write_text("fallback completed\n", encoding="utf-8")

        def entry_for(target: str) -> dict:
            entry = {
                "status": "fallback_pass" if evidence_class.startswith("fallback") else "pass",
                "evidence_class": evidence_class,
                "paths": {
                    "log": "build/reports/formal.log",
                    "log_sha256": self.pipeline.sha256(log),
                },
            }
            if evidence_class.startswith("sby_"):
                entry["sby"] = {
                    "spec": f"verify/formal/{target}.sby",
                    "engines": ["smtbmc z3"],
                    "tasks": {"default": {"mode": "bmc", "depth": "4"}},
                    "covered_files": ["rtl/example.sv"],
                }
            return entry

        manifest = {
            "schema": "e1-chip-formal-evidence-v1",
            "mode": mode,
            "fallback_equivalent_to_sby": False,
            "strict_release_claim_allowed": mode == "sby-deep-top",
            "deep_top_required_for_release": True,
            "release_claim": (
                "strict_formal_bmc_evidence"
                if mode == "sby-deep-top"
                else "strict_requires_sby_and_deep_top"
            ),
            "entries": {target: entry_for(target) for target in self.pipeline.FORMAL_TARGETS},
            "source_hashes": {"scripts/run_formal.sh": "dummy"},
        }
        (report / "formal_manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def test_non_strict_formal_allows_labeled_fallback_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_manifest(root, mode="fallback", evidence_class="fallback_structural_only")
            self.assertEqual(self.pipeline.validate_formal_manifest(root, strict=False), [])

    def test_strict_formal_rejects_fallback_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_manifest(root, mode="fallback", evidence_class="fallback_structural_only")
            errors = self.pipeline.validate_formal_manifest(root, strict=True)
        self.assertIn("strict pipeline requires formal manifest mode=sby-deep-top", errors)
        self.assertTrue(
            any(error.startswith("formal e1_npu: strict gate rejects") for error in errors)
        )

    def test_strict_formal_accepts_deep_sby_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_manifest(root, mode="sby-deep-top", evidence_class="sby_bmc_deep")
            self.assertEqual(self.pipeline.validate_formal_manifest(root, strict=True), [])

    def test_sby_manifest_requires_solver_depth_and_covered_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_manifest(root, mode="sby-deep-top", evidence_class="sby_bmc_deep")
            manifest_path = root / "build/reports/formal_manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["entries"]["e1_npu"].pop("sby")
            manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            errors = self.pipeline.validate_formal_manifest(root, strict=True)
        self.assertIn("formal e1_npu: missing SBY metadata", errors)


if __name__ == "__main__":
    unittest.main()
