#!/usr/bin/env python3
"""Unit tests for ``scripts/check_memory_2028_target.py``.

Synthesizes a minimal valid ``docs/spec-db/memory-2028-target.yaml`` in a
``tempfile.TemporaryDirectory()`` and monkey-patches the script's ``SPEC``
and ``NPU_SPEC`` constants so the validator runs against the synthetic
spec. Mutates the spec to drive every fail-closed branch.

Run:
    cd packages/chip && python3 -m unittest scripts.test_check_memory_2028_target
"""

from __future__ import annotations

import contextlib
import copy
import importlib
import io
import sys
import tempfile
import unittest
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

check_memory_2028_target = importlib.import_module("check_memory_2028_target")


def minimal_valid_spec() -> dict[str, Any]:
    return {
        "schema": "eliza.memory_2028_target.v1",
        "as_of": "2026-05-19",
        "target_year": 2028,
        "claim_boundary": "synthetic claim boundary",
        "source_anchors": ["jedec_lpddr6"],
        "external_memory": {
            "type": "LPDDR6",
            "width_bits": 128,
            "rate_gbps": 14.4,
        },
        "shared_system_cache": {"mib": 32, "ways": 8, "coherent": True},
        "npu_local_sram": {"mib": 64, "tiles": 16, "ecc": "SECDED"},
        "coherent_fabric": {"required": "TileLink-C"},
        "iommu": {"required": "RISC-V IOMMU or SMMUv3"},
        "qos": {
            "classes": ["Isochronous", "High", "Normal", "Best-effort"],
            "programmable_at_boot": True,
        },
        "compression_aware_dma": {"block_elements": 64, "modes": ["INT8", "INT4"]},
        "framebuffer_compression": {"format": "AFBC"},
        "cache_stash": {"latency_target_ns_max": 200},
        "rowhammer_policy": {
            "trr_enabled": True,
            "rfm_enabled": True,
            "on_die_ecc": True,
        },
        "phase_gates": {"P0": ["fabric"], "P1": ["slc", "tile_sram"]},
        "forbidden_claims_until_complete": [
            "180 GB/s external memory bandwidth",
            "64 MiB local SRAM",
        ],
    }


def minimal_npu_spec() -> dict[str, Any]:
    return {
        "schema": "eliza.npu_2028_target.v1",
        "numeric_targets": {
            "external_memory_bandwidth_gbps_min": 180,
            "local_sram_mib_min": 64,
        },
    }


@contextlib.contextmanager
def patched_validator(
    spec: dict[str, Any], npu_spec: dict[str, Any] | None = None
) -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        spec_path = root / "docs/spec-db/memory-2028-target.yaml"
        npu_path = root / "docs/spec-db/npu-2028-target.yaml"
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(yaml.safe_dump(spec, sort_keys=True), encoding="utf-8")
        npu_path.write_text(
            yaml.safe_dump(npu_spec or minimal_npu_spec(), sort_keys=True),
            encoding="utf-8",
        )
        with (
            mock.patch.object(check_memory_2028_target, "ROOT", root),
            mock.patch.object(check_memory_2028_target, "SPEC", spec_path),
            mock.patch.object(check_memory_2028_target, "NPU_SPEC", npu_path),
        ):
            yield root


def run_validator() -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            check_memory_2028_target.main()
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
    return code, stdout.getvalue(), stderr.getvalue()


class TestMemoryCheck(unittest.TestCase):
    def test_minimal_valid_passes(self) -> None:
        with patched_validator(minimal_valid_spec()):
            code, out, _err = run_validator()
        self.assertEqual(code, 0, out)
        self.assertIn("memory 2028 target check passed", out)

    def test_missing_required_field_fails(self) -> None:
        for field in (
            "schema",
            "as_of",
            "target_year",
            "external_memory",
            "shared_system_cache",
            "npu_local_sram",
            "coherent_fabric",
            "iommu",
            "qos",
            "compression_aware_dma",
            "framebuffer_compression",
            "cache_stash",
            "rowhammer_policy",
            "phase_gates",
            "forbidden_claims_until_complete",
        ):
            with self.subTest(field=field):
                spec = copy.deepcopy(minimal_valid_spec())
                spec.pop(field)
                with patched_validator(spec):
                    code, _out, err = run_validator()
                self.assertNotEqual(code, 0)
                self.assertIn(field, err)

    def test_wrong_schema_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["schema"] = "eliza.wrong.v1"
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("schema", err)

    def test_wrong_target_year_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["target_year"] = 2027
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("target_year", err)

    def test_missing_lpddr6_reference_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["external_memory"] = {"type": "DDR5", "width_bits": 64}
        spec["source_anchors"] = ["other"]
        spec["forbidden_claims_until_complete"] = ["external memory bandwidth"]
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("LPDDR6", err)

    def test_missing_tilelink_or_chi_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["coherent_fabric"] = {"required": "AXI-Lite"}
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("TileLink-C or CHI", err)

    def test_missing_iommu_block_fails(self) -> None:
        # The validator's blob-scan checks for the word "iommu" or "smmu" anywhere
        # in the serialized spec. Removing the field entirely is the cleanest mutation;
        # leaving it present still satisfies the blob-level keyword scan.
        spec = copy.deepcopy(minimal_valid_spec())
        spec.pop("iommu")
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("iommu", err.lower())

    def test_rowhammer_missing_trr_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["rowhammer_policy"] = {"rfm_enabled": True}
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("TRR", err)

    def test_rowhammer_missing_rfm_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["rowhammer_policy"] = {"trr_enabled": True}
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("RFM", err)

    def test_empty_forbidden_claims_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["forbidden_claims_until_complete"] = []
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("forbidden_claims_until_complete", err)

    def test_empty_phase_gates_fails(self) -> None:
        spec = copy.deepcopy(minimal_valid_spec())
        spec["phase_gates"] = {}
        with patched_validator(spec):
            code, _out, err = run_validator()
        self.assertNotEqual(code, 0)
        self.assertIn("phase_gates", err)


if __name__ == "__main__":
    unittest.main()
