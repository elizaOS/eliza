"""Tests for the Eliza-1 license attestation module + the evidence finalizer."""

from __future__ import annotations

import json
import hashlib
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
from scripts.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_DFLASH_TIERS,
    REQUIRED_KERNELS_BY_TIER,
    SUPPORTED_BACKENDS_BY_TIER,
)
from scripts.manifest.eliza1_platform_plan import (  # noqa: E402
    REQUIRED_PLATFORM_EVIDENCE_BY_TIER,
)


def test_every_attestation_has_a_loadable_verbatim_text() -> None:
    for a in ATTESTATIONS:
        text = license_text(a.text_file)
        assert text.strip(), f"{a.bundle_file}: empty license text {a.text_file}"
        # Sanity: the embedded SPDX header line is what verify_bundle_licenses checks.
        assert "SPDX-License-Identifier:" in a.render()
        assert text.strip() in a.render()


def test_components_select_the_right_attestations() -> None:
    # Legacy/no-vision bundle shape: no embedding, no vision, but ships the
    # wakeword license note.
    lite = {
        a.bundle_file
        for a in attestations_for_components(
            ["text", "voice", "asr", "vad", "dflash", "wakeword"]
        )
    }
    assert "LICENSE.embedding" not in lite
    assert "LICENSE.vision" not in lite
    assert "LICENSE.wakeword" in lite
    assert {
        "LICENSE.text",
        "LICENSE.voice",
        "LICENSE.dflash",
        "LICENSE.eliza-1",
    } <= lite

    # mmproj tier: vision + embedding present.
    pro = {
        a.bundle_file
        for a in attestations_for_components(
            ["text", "voice", "asr", "vad", "dflash", "embedding", "vision"]
        )
    }
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

from scripts.manifest.finalize_eliza1_evidence import (  # noqa: E402
    ELIZA_1_HF_REPO,
    finalize,
)


def _minimal_staged_bundle(root: Path, tier: str) -> Path:
    bundle = root / f"eliza-1-{tier}.bundle"
    payloads = {
        f"text/eliza-1-{tier}-128k.gguf": b"\x00gguf\x00",
        "tts/omnivoice-base-Q4_K_M.gguf": b"omnivoice-model",
        "tts/omnivoice-tokenizer-Q4_K_M.gguf": b"omnivoice-tokenizer",
        "tts/kokoro/model_q4.onnx": b"kokoro-model",
        "tts/kokoro/tokenizer.json": b"kokoro-tokenizer",
        "tts/kokoro/voices/af_bella.bin": b"kokoro-voice",
        "asr/eliza-1-asr.gguf": b"asr",
        f"vision/mmproj-{tier}.gguf": b"vision",
        "vad/silero-vad-v5.gguf": b"vad",
        "cache/voice-preset-default.bin": b"cache",
    }
    if tier in ELIZA_1_DFLASH_TIERS:
        payloads[f"dflash/drafter-{tier}.gguf"] = b"drafter"
    for rel, payload in payloads.items():
        path = bundle / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    sha = {
        rel: hashlib.sha256(payload).hexdigest() for rel, payload in payloads.items()
    }
    lineage = {
        "text": {"base": "local-text", "license": "apache-2.0"},
        "voice": {"base": "local-voice", "license": "apache-2.0"},
        "asr": {"base": "local-asr", "license": "apache-2.0"},
        "vision": {"base": "local-vision", "license": "apache-2.0"},
        "vad": {"base": "local-vad", "license": "mit"},
    }
    if tier in ELIZA_1_DFLASH_TIERS:
        lineage["drafter"] = {"base": "local-drafter", "license": "apache-2.0"}
    dflash_entries = (
        [
            {
                "path": f"dflash/drafter-{tier}.gguf",
                "sha256": sha[f"dflash/drafter-{tier}.gguf"],
            }
        ]
        if tier in ELIZA_1_DFLASH_TIERS
        else []
    )
    required_kernels = list(REQUIRED_KERNELS_BY_TIER[tier])
    (bundle / "eliza-1.manifest.json").write_text(
        json.dumps(
            {
                "$schema": "https://elizaos.ai/schemas/eliza-1.manifest.v1.json",
                "id": f"eliza-1-{tier}",
                "tier": tier,
                "version": "0.0.0-local.test",
                "publishedAt": "2026-05-12T00:00:00Z",
                "lineage": lineage,
                "files": {
                    "text": [
                        {
                            "path": f"text/eliza-1-{tier}-128k.gguf",
                            "sha256": sha[f"text/eliza-1-{tier}-128k.gguf"],
                            "ctx": 131072,
                        }
                    ],
                    "voice": [
                        {
                            "path": "tts/omnivoice-base-Q4_K_M.gguf",
                            "sha256": sha["tts/omnivoice-base-Q4_K_M.gguf"],
                        },
                        {
                            "path": "tts/omnivoice-tokenizer-Q4_K_M.gguf",
                            "sha256": sha["tts/omnivoice-tokenizer-Q4_K_M.gguf"],
                        },
                        {
                            "path": "tts/kokoro/model_q4.onnx",
                            "sha256": sha["tts/kokoro/model_q4.onnx"],
                        },
                        {
                            "path": "tts/kokoro/tokenizer.json",
                            "sha256": sha["tts/kokoro/tokenizer.json"],
                        },
                        {
                            "path": "tts/kokoro/voices/af_bella.bin",
                            "sha256": sha["tts/kokoro/voices/af_bella.bin"],
                        },
                    ],
                    "asr": [
                        {
                            "path": "asr/eliza-1-asr.gguf",
                            "sha256": sha["asr/eliza-1-asr.gguf"],
                        }
                    ],
                    "vision": [
                        {
                            "path": f"vision/mmproj-{tier}.gguf",
                            "sha256": sha[f"vision/mmproj-{tier}.gguf"],
                        }
                    ],
                    "dflash": dflash_entries,
                    "cache": [
                        {
                            "path": "cache/voice-preset-default.bin",
                            "sha256": sha["cache/voice-preset-default.bin"],
                        }
                    ],
                    "vad": [
                        {
                            "path": "vad/silero-vad-v5.gguf",
                            "sha256": sha["vad/silero-vad-v5.gguf"],
                        }
                    ],
                },
                "kernels": {
                    "required": required_kernels,
                    "optional": [],
                    "verifiedBackends": {
                        b: {"status": "skipped", "atCommit": "test", "report": "test"}
                        for b in ("metal", "vulkan", "cuda", "rocm", "cpu")
                    },
                },
                "evals": {
                    "textEval": {"score": 0.0, "passed": False},
                    "voiceRtf": {"rtf": 1.0, "passed": False},
                    "asrWer": {"wer": 1.0, "passed": False},
                    "vadLatencyMs": {"median": 0.0, "passed": False},
                    "e2eLoopOk": False,
                    "thirtyTurnOk": False,
                },
                "ramBudgetMb": {"min": 1, "recommended": 2},
                "defaultEligible": False,
            }
        ),
        encoding="utf-8",
    )
    (bundle / "evals").mkdir(parents=True)
    # Eval aggregate with a failing gate (mirrors the real staged state).
    (bundle / "evals" / "aggregate.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "tier": tier,
                "gateReport": {
                    "tier": tier,
                    "passed": False,
                    "gates": [
                        {
                            "name": "text_eval",
                            "passed": False,
                            "skipped": False,
                            "required": True,
                            "reason": "text_eval below threshold",
                        },
                    ],
                },
            }
        )
    )
    (bundle / "evidence").mkdir(parents=True)
    (bundle / "evidence" / "release.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "tier": tier,
                "repoId": "elizalabs/eliza-1",
                "repoPath": f"bundles/{tier}",
                "releaseState": "weights-staged",
                "final": {
                    "weights": True,
                    "hashes": False,
                    "evals": False,
                    "licenses": False,
                    "kernelDispatchReports": False,
                    "platformEvidence": False,
                    "sizeFirstRepoIds": False,
                },
            }
        )
    )
    return bundle


def _mark_harness_evidence_passed(bundle: Path, tier: str) -> None:
    (bundle / "evals" / "aggregate.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "tier": tier,
                "gateReport": {
                    "tier": tier,
                    "passed": True,
                    "gates": [
                        {
                            "name": "text_eval",
                            "passed": True,
                            "skipped": False,
                            "required": True,
                        }
                    ],
                },
            }
        )
    )
    graph_kernel_set = ["turbo3", "turbo4", "turbo3_tcq", "qjl", "polar"]
    text_sha = hashlib.sha256(
        (bundle / f"text/eliza-1-{tier}-128k.gguf").read_bytes()
    ).hexdigest()
    for backend in SUPPORTED_BACKENDS_BY_TIER[tier]:
        (bundle / "evals" / f"{backend}_dispatch.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "backend": backend,
                    "tier": tier,
                    "status": "pass",
                    "runtimeReady": True,
                    "atCommit": "test",
                    "modelSha256": text_sha,
                    "kernelSet": graph_kernel_set,
                    "graphDispatch": {
                        "cacheFamilies": graph_kernel_set,
                        "command": "llama-cli --cache-type-k <family>",
                        "logs": [f"evals/{backend}_dispatch.log"],
                    },
                    "device": f"test-{backend}",
                    "report": f"{backend}-dispatch.json",
                }
            )
        )
        (bundle / "evals" / f"{backend}_dispatch.log").write_text("ok\n")
    platform_dir = bundle / "evidence" / "platform"
    platform_dir.mkdir(parents=True, exist_ok=True)
    for target in REQUIRED_PLATFORM_EVIDENCE_BY_TIER[tier]:
        (platform_dir / f"{target}.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "target": target,
                    "backend": target.rsplit("-", 1)[-1],
                    "tier": tier,
                    "status": "pass",
                    "atCommit": "test",
                    "report": f"{target}.json",
                    "device": "test-device",
                    "voiceAbi": (
                        True if target == "ios-arm64-metal" else "not-applicable"
                    ),
                }
            )
        )
    release_path = bundle / "evidence" / "release.json"
    release = json.loads(release_path.read_text())
    release["releaseState"] = "base-v1"
    release["finetuned"] = False
    release["sourceModels"] = {"text": {"repo": "Qwen/Qwen3.5-0.8B-Base"}}
    release_path.write_text(json.dumps(release), encoding="utf-8")


def test_finalize_sets_licenses_true_and_keeps_the_rest_honest(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    evidence = finalize(bundle, tmp_path)
    assert evidence["final"]["licenses"] is True
    # Real upstream license text + sidecar were written.
    assert (bundle / "licenses" / "license-manifest.json").is_file()
    assert (
        verify_bundle_licenses(
            bundle / "licenses",
            [
                "text",
                "voice",
                "asr",
                "vad",
                "dflash",
                "vision",
                "kokoro",
                "omnivoice",
            ],
        )
        == []
    )
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
    assert any(
        "releaseState is 'weights-staged'" in r
        for r in evidence["publishBlockingReasons"]
    )


def test_finalize_syncs_voice_lineage_to_staged_backends(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")

    finalize(bundle, tmp_path)

    lineage = json.loads((bundle / "lineage.json").read_text())
    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    assert "Serveurperso/OmniVoice-GGUF" in lineage["voice"]["base"]
    assert "onnx-community/Kokoro-82M-v1.0-ONNX" in lineage["voice"]["base"]
    assert lineage["voice"]["backends"] == ["omnivoice", "kokoro"]
    assert manifest["lineage"]["voice"] == {
        "base": lineage["voice"]["base"],
        "license": "apache-2.0",
    }


def test_finalize_syncs_manifest_hashes_for_changed_payloads(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    cache_path = bundle / "cache" / "voice-preset-default.bin"
    cache_path.write_bytes(b"new preset bytes")

    finalize(bundle, tmp_path)

    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    cache_entry = next(
        entry
        for entry in manifest["files"]["cache"]
        if entry["path"] == "cache/voice-preset-default.bin"
    )
    assert cache_entry["sha256"] == hashlib.sha256(cache_path.read_bytes()).hexdigest()
    assert not any(
        "files.cache" in reason for reason in json.loads(
            (bundle / "evidence" / "release.json").read_text()
        )["publishBlockingReasons"]
    )


def test_finalize_prunes_stale_optional_license_files(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    manifest_path = bundle / "eliza-1.manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"]["voice"] = [
        entry
        for entry in manifest["files"]["voice"]
        if not entry["path"].startswith("tts/omnivoice-")
    ]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    for path in (bundle / "tts").glob("omnivoice-*.gguf"):
        path.unlink()
    licenses = bundle / "licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    (licenses / "LICENSE.kokoro").write_text("stale kokoro split license\n")
    (licenses / "LICENSE.wakeword").write_text("stale wakeword license\n")

    finalize(bundle, tmp_path)

    assert not (licenses / "LICENSE.kokoro").exists()
    assert not (licenses / "LICENSE.wakeword").exists()
    assert (
        verify_bundle_licenses(
            licenses,
            ["text", "voice", "asr", "vad", "dflash", "vision", "kokoro"],
        )
        == []
    )


def test_finalize_does_not_block_on_provisional_eval_rows(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    aggregate_path = bundle / "evals" / "aggregate.json"
    aggregate = json.loads(aggregate_path.read_text())
    aggregate["gateReport"]["failures"] = ["text_eval: text_eval below threshold"]
    aggregate["gateReport"]["gates"] = [
        {
            "name": "text_eval",
            "passed": False,
            "skipped": False,
            "blocking": True,
            "required": True,
            "provisional": False,
            "reason": "text_eval below threshold",
        },
        {
            "name": "asr_wer",
            "passed": False,
            "skipped": True,
            "blocking": False,
            "required": True,
            "provisional": True,
            "reason": "not measured",
        },
    ]
    aggregate_path.write_text(json.dumps(aggregate), encoding="utf-8")

    evidence = finalize(bundle, tmp_path)

    assert evidence["final"]["evals"] is False
    blockers = "\n".join(evidence["publishBlockingReasons"])
    assert "text_eval failed" in blockers
    assert "asr_wer" not in blockers


def test_finalize_syncs_harness_evidence_and_release_checksum(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    (bundle / "evals" / "android_e2e.json").write_text(
        json.dumps({"status": "pass", "tier": "0_8b"}),
        encoding="utf-8",
    )

    evidence = finalize(bundle, tmp_path)
    release_path = bundle / "evidence" / "release.json"
    sums = {
        rel: digest
        for digest, rel in (
            line.split(None, 1)
            for line in (bundle / "checksums" / "SHA256SUMS").read_text().splitlines()
        )
    }

    assert "evals/android_e2e.json" in evidence["evalReports"]
    assert (
        sums["evals/android_e2e.json"]
        == hashlib.sha256(
            (bundle / "evals" / "android_e2e.json").read_bytes()
        ).hexdigest()
    )
    assert (
        sums["evidence/release.json"]
        == hashlib.sha256(release_path.read_bytes()).hexdigest()
    )


def test_finalize_reports_manifest_errors_separately_from_hashes(
    tmp_path: Path,
) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    manifest_path = bundle / "eliza-1.manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"]["text"][0]["ctx"] = 32768
    manifest["files"]["text"][0]["path"] = "text/eliza-1-0_8b-32k.gguf"
    old_path = bundle / "text" / "eliza-1-0_8b-128k.gguf"
    new_path = bundle / "text" / "eliza-1-0_8b-32k.gguf"
    old_path.rename(new_path)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    evidence = finalize(bundle, tmp_path)

    assert evidence["final"]["hashes"] is True
    assert evidence["manifestValidation"]["ok"] is False
    assert any(
        "manifest validation failed" in r for r in evidence["publishBlockingReasons"]
    )
    assert not any("stale" in r for r in evidence["publishBlockingReasons"])


def test_finalize_requires_upload_evidence_for_sizefirst(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "2b")
    _mark_harness_evidence_passed(bundle, "2b")
    release_path = bundle / "evidence" / "release.json"
    release = json.loads(release_path.read_text())
    release.setdefault("final", {})["sizeFirstRepoIds"] = True
    release_path.write_text(json.dumps(release), encoding="utf-8")

    evidence = finalize(bundle, tmp_path)

    assert evidence["final"]["sizeFirstRepoIds"] is False
    assert evidence["publishEligible"] is False
    assert evidence["defaultEligible"] is False
    assert any(
        "sizeFirstRepoIds not recorded" in r
        for r in evidence["publishBlockingReasons"]
    )
    assert evidence["repoId"] == ELIZA_1_HF_REPO
    assert evidence["hf"]["repoId"] == ELIZA_1_HF_REPO
    assert evidence["hf"]["status"] == "blocked-base-v1"


def test_finalize_demotes_stale_dispatch_pass_to_pending(tmp_path: Path) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    _mark_harness_evidence_passed(bundle, "0_8b")
    dispatch_path = bundle / "evals" / "metal_dispatch.json"
    dispatch = json.loads(dispatch_path.read_text())
    dispatch["modelSha256"] = "f" * 64
    dispatch_path.write_text(json.dumps(dispatch), encoding="utf-8")

    evidence = finalize(bundle, tmp_path)
    rewritten = json.loads(dispatch_path.read_text())

    assert evidence["final"]["kernelDispatchReports"] is False
    assert rewritten["runtimeReady"] is False
    assert "invalidPreviousReport" in rewritten


def test_finalize_dev_workstation_partial_evidence_on_cpu_and_vulkan(
    tmp_path: Path,
) -> None:
    bundle = _minimal_staged_bundle(tmp_path, "0_8b")
    finalize(bundle, tmp_path)
    cpu = json.loads(
        (bundle / "evidence" / "platform" / "linux-x64-cpu.json").read_text()
    )
    assert cpu["status"] == "pending"
    assert "partialEvidence" in cpu
    assert "Arrow Lake" in cpu["device"]
    vulkan = json.loads(
        (bundle / "evidence" / "platform" / "linux-x64-vulkan.json").read_text()
    )
    assert vulkan["status"] == "pending"
    assert "vulkanDispatchSmoke" in vulkan["partialEvidence"]
    # Metal stays needs-hardware.
    metal_dispatch = json.loads((bundle / "evals" / "metal_dispatch.json").read_text())
    assert metal_dispatch["status"] == "needs-hardware"
    assert metal_dispatch["runtimeReady"] is False
