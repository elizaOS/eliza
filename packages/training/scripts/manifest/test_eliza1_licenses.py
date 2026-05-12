"""Tests for the Eliza-1 license attestation module + the evidence finalizer."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.eliza1_licenses import (  # noqa: E402
    ATTESTATIONS,
    attestations_for_components,
    license_text,
    verify_bundle_licenses,
    write_bundle_licenses,
)


def test_every_attestation_has_a_loadable_verbatim_text() -> None:
    for a in ATTESTATIONS:
        text = license_text(a.text_file)
        assert text.strip(), f"{a.bundle_file}: empty license text {a.text_file}"
        # Sanity: the embedded SPDX header line is what verify_bundle_licenses checks.
        assert "SPDX-License-Identifier:" in a.render()
        assert text.strip() in a.render()


def test_components_select_the_right_attestations() -> None:
    # Lite tier: no embedding, no vision, but ships the wakeword license note.
    lite = {a.bundle_file for a in attestations_for_components(
        ["text", "voice", "asr", "vad", "dflash", "wakeword"]
    )}
    assert "LICENSE.embedding" not in lite
    assert "LICENSE.vision" not in lite
    assert "LICENSE.wakeword" in lite
    assert {"LICENSE.text", "LICENSE.voice", "LICENSE.dflash", "LICENSE.eliza-1"} <= lite

    # mmproj tier: vision + embedding present.
    pro = {a.bundle_file for a in attestations_for_components(
        ["text", "voice", "asr", "vad", "dflash", "embedding", "vision"]
    )}
    assert "LICENSE.vision" in pro
    assert "LICENSE.embedding" in pro


def test_write_then_verify_round_trips(tmp_path: Path) -> None:
    licenses_dir = tmp_path / "bundle" / "licenses"
    components = ["text", "voice", "asr", "vad", "dflash", "vision"]
    written, sidecar = write_bundle_licenses(licenses_dir, components)
    assert "licenses/license-manifest.json" in written
    assert sidecar["bundleSpdx"] == "CC-BY-NC-SA-4.0"
    assert verify_bundle_licenses(licenses_dir, components) == []

    # Corrupting a file's text is caught.
    (licenses_dir / "LICENSE.text").write_text("not the apache license\n")
    problems = verify_bundle_licenses(licenses_dir, components)
    assert any("LICENSE.text" in p for p in problems)


def test_eliza_1_umbrella_is_cc_by_nc_sa() -> None:
    eliza1 = next(a for a in ATTESTATIONS if a.bundle_file == "LICENSE.eliza-1")
    assert eliza1.spdx == "CC-BY-NC-SA-4.0"
    rendered = eliza1.render()
    assert "non-commercial" in rendered.lower()
    assert "Attribution-NonCommercial-ShareAlike 4.0 International" in rendered


def test_qwen3_asr_and_embedding_remain_upstream_exceptions() -> None:
    asr = next(a for a in ATTESTATIONS if a.bundle_file == "LICENSE.asr")
    embedding = next(a for a in ATTESTATIONS if a.bundle_file == "LICENSE.embedding")

    assert "Qwen3-ASR-0.6B-GGUF" in asr.upstream_repo
    assert "Qwen3-ASR-1.7B-GGUF" in asr.upstream_repo
    assert "Qwen3 upstream exception" in asr.render()
    assert "Qwen3.5-ASR" not in asr.render()
    assert "Qwen3-Embedding-0.6B-GGUF" in embedding.upstream_repo
    assert "Qwen3.5-Embedding" not in embedding.render()


# --- evidence finalizer -----------------------------------------------------

from scripts.manifest.finalize_eliza1_evidence import finalize  # noqa: E402


def _minimal_staged_bundle(root: Path, tier: str) -> Path:
    bundle = root / f"eliza-1-{tier}.bundle"
    (bundle / "text").mkdir(parents=True)
    (bundle / "text" / f"eliza-1-{tier}-32k.gguf").write_bytes(b"\x00gguf\x00")
    (bundle / "evals").mkdir(parents=True)
    # Eval aggregate with a failing gate (mirrors the real staged state).
    (bundle / "evals" / "aggregate.json").write_text(json.dumps({
        "schemaVersion": 1,
        "tier": tier,
        "gateReport": {
            "tier": tier,
            "passed": False,
            "gates": [
                {"name": "text_eval", "passed": False, "skipped": False, "required": True,
                 "reason": "text_eval below threshold"},
            ],
        },
    }))
    (bundle / "evidence").mkdir(parents=True)
    (bundle / "evidence" / "release.json").write_text(json.dumps({
        "schemaVersion": 1, "tier": tier, "repoId": "elizaos/eliza-1",
        "repoPath": f"bundles/{tier}",
        "releaseState": "weights-staged",
        "final": {"weights": True, "hashes": False, "evals": False, "licenses": False,
                  "kernelDispatchReports": False, "platformEvidence": False, "sizeFirstRepoIds": False},
    }))
    return bundle


def test_finalize_sets_licenses_true_and_keeps_the_rest_honest(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    evidence = finalize(bundle, tmp_path)
    assert evidence["final"]["licenses"] is True
    # Real upstream license text + sidecar were written.
    assert (bundle / "licenses" / "license-manifest.json").is_file()
    assert verify_bundle_licenses(bundle / "licenses", ["text", "voice", "asr", "vad", "dflash"]) == []
    # Everything that needs GPU/operator work stays false.
    assert evidence["final"]["evals"] is False
    assert evidence["final"]["kernelDispatchReports"] is False
    assert evidence["final"]["platformEvidence"] is False
    assert evidence["publishEligible"] is False
    assert evidence["defaultEligible"] is False
    assert evidence["releaseState"] == "weights-staged"
    # Hashes recomputed -> SHA256SUMS present and covers files.
    assert evidence["final"]["hashes"] is True
    assert (bundle / "checksums" / "SHA256SUMS").is_file()
    # Every required platform target + supported backend has an evidence file.
    for target_path in evidence["platformEvidence"].values():
        assert (bundle / target_path).is_file()
    for dispatch_path in evidence["kernelDispatchReports"].values():
        assert (bundle / dispatch_path).is_file()
    # Blocking reasons are a precise non-empty list.
    assert evidence["publishBlockingReasons"]
    assert any("eval gates" in r for r in evidence["publishBlockingReasons"])
    assert any("releaseState is 'weights-staged'" in r for r in evidence["publishBlockingReasons"])


def test_finalize_dev_workstation_partial_evidence_on_cpu_and_vulkan(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    finalize(bundle, tmp_path)
    cpu = json.loads((bundle / "evidence" / "platform" / "linux-x64-cpu.json").read_text())
    assert cpu["status"] == "pending"
    assert "partialEvidence" in cpu
    assert "Arrow Lake" in cpu["device"]
    vulkan = json.loads((bundle / "evidence" / "platform" / "linux-x64-vulkan.json").read_text())
    assert vulkan["status"] == "pending"
    assert "vulkanDispatchSmoke" in vulkan["partialEvidence"]
    # Metal stays needs-hardware.
    metal_dispatch = json.loads((bundle / "evals" / "metal_dispatch.json").read_text())
    assert metal_dispatch["status"] == "needs-hardware"
    assert metal_dispatch["runtimeReady"] is False
