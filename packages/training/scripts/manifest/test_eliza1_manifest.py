"""Tests for the Eliza-1 manifest generator + validator (Python side)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.manifest import eliza1_manifest as manifest_mod
from scripts.manifest.eliza1_manifest import (
    ELIZA_1_MTP_TIERS,
    ELIZA_1_MANIFEST_SCHEMA_VERSION,
    ELIZA_1_TIERS,
    ELIZA_1_VISION_TIERS,
    REQUIRED_KERNELS_BY_TIER,
    VOICE_BACKENDS_BY_TIER,
    VOICE_QUANT_BY_TIER,
    VOICE_QUANT_LADDER_BY_TIER,
    Eliza1ManifestError,
    FileEntry,
    KernelVerification,
    LineageEntry,
    build_manifest,
    parse_ctx_string,
    parse_text_ctx_from_filename,
    text_context_for_manifest,
    validate_manifest,
    write_manifest,
)
from scripts.quantization._kernel_manifest import kernel_manifest_fragment

SHA = "0" * 64


def passing_backends() -> dict[str, KernelVerification]:
    return {
        b: KernelVerification(status="pass", at_commit="abc1234", report=f"{b}.txt")
        for b in ("metal", "vulkan", "cuda", "rocm", "cpu")
    }


def quantization_kernel_fragments() -> list[dict[str, object]]:
    return [
        kernel_manifest_fragment(method)
        for method in ("turboquant", "fused-turboquant", "qjl", "polarquant")
    ]


def text_file_for_tier(tier: str) -> FileEntry:
    return FileEntry(path=f"text/eliza-1-{tier}-128k.gguf", sha256=SHA, ctx=131072)


def base_kwargs(tier: str = "4b") -> dict:
    kwargs = dict(
        tier=tier,
        version="1.0.0",
        published_at="2026-05-10T00:00:00Z",
        lineage={
            "text": LineageEntry(base="eliza-1-text-backbone", license="apache-2.0"),
            "voice": LineageEntry(base="eliza-1-voice-backbone", license="apache-2.0"),
            "drafter": LineageEntry(base="eliza-1-drafter", license="apache-2.0"),
            "asr": LineageEntry(base="eliza-1-asr", license="apache-2.0"),
            "vision": LineageEntry(base="eliza-1-vision", license="apache-2.0"),
            "vad": LineageEntry(base="eliza-1-vad", license="apache-2.0"),
        },
        files={
            "text": [text_file_for_tier(tier)],
            "voice": [FileEntry(path="tts/omnivoice-base-Q4_K_M.gguf", sha256=SHA)],
            "asr": [FileEntry(path="asr/asr.gguf", sha256=SHA)],
            "vision": [FileEntry(path=f"vision/mmproj-{tier}.gguf", sha256=SHA)],
            "mtp": [FileEntry(path=f"mtp/drafter-{tier}.gguf", sha256=SHA)],
            "cache": [FileEntry(path="cache/voice-preset-default.bin", sha256=SHA)],
            "vad": [FileEntry(path="vad/silero-vad-v5.gguf", sha256=SHA)],
        },
        kernels_required=list(REQUIRED_KERNELS_BY_TIER[tier]),
        kernels_optional=[],
        verified_backends=passing_backends(),
        text_eval_score=0.71,
        text_eval_passed=True,
        voice_rtf=0.42,
        voice_rtf_passed=True,
        asr_wer=0.05,
        asr_wer_passed=True,
        vad_latency_ms_median=16.0,
        vad_latency_ms_passed=True,
        vad_boundary_ms=24.0,
        vad_endpoint_ms=80.0,
        vad_false_barge_in_rate=0.01,
        e2e_loop_ok=True,
        thirty_turn_ok=True,
        mtp_eval=True,
        mtp_acceptance_rate=0.71,
        mtp_speedup=1.8,
        mtp_passed=True,
        ram_budget_min_mb=7000,
        ram_budget_recommended_mb=9500,
        default_eligible=True,
        kernel_manifest_fragments=quantization_kernel_fragments(),
    )
    if tier not in ELIZA_1_MTP_TIERS:
        kwargs["lineage"].pop("drafter", None)
        kwargs["files"]["mtp"] = []
        kwargs["mtp_eval"] = False
        kwargs["mtp_acceptance_rate"] = None
        kwargs["mtp_speedup"] = None
        kwargs["mtp_passed"] = None
    if tier not in ELIZA_1_VISION_TIERS:
        kwargs["lineage"].pop("vision", None)
        kwargs["files"]["vision"] = []
    if VOICE_BACKENDS_BY_TIER[tier] == ("kokoro",):
        kwargs["files"]["voice"] = [
            FileEntry(path="tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf", sha256=SHA),
            FileEntry(path="tts/kokoro/tokenizer.json", sha256=SHA),
            FileEntry(path="tts/kokoro/voices/af_bella.bin", sha256=SHA),
        ]
    return kwargs


def test_schema_version_constant():
    assert ELIZA_1_MANIFEST_SCHEMA_VERSION == "1"


def test_text_context_prefers_gguf_metadata_over_filename(
    tmp_path: Path,
    monkeypatch,
):
    text_path = tmp_path / "text" / "eliza-1-2b-32k.gguf"
    text_path.parent.mkdir(parents=True)
    text_path.write_bytes(b"stand-in")
    monkeypatch.setattr(
        manifest_mod,
        "read_gguf_context_length",
        lambda path: 262144 if path == text_path else None,
    )

    assert text_context_for_manifest(text_path) == 262144


def test_eliza1_tier_ids_are_canonical():
    assert ELIZA_1_TIERS == (
        "2b",
        "4b",
        "9b",
        "27b",
        "27b-256k",
    )
    # Gemma 4 drops QJL/Polar (stock-q8_0 KV); only TurboQuant + TCQ remain.
    assert REQUIRED_KERNELS_BY_TIER["2b"] == (
        "turboquant_q4",
        "turbo3_tcq",
    )
    assert REQUIRED_KERNELS_BY_TIER["4b"] == (
        "turboquant_q4",
        "turbo3_tcq",
    )
    assert VOICE_BACKENDS_BY_TIER["2b"] == ("omnivoice", "kokoro")
    assert VOICE_BACKENDS_BY_TIER["4b"] == ("omnivoice", "kokoro")
    assert VOICE_BACKENDS_BY_TIER["9b"] == ("omnivoice", "kokoro")
    assert VOICE_BACKENDS_BY_TIER["27b"] == ("omnivoice",)


def _parse_publish_all_tiers() -> tuple[str, ...]:
    """Mechanically extract the TIERS bash array from publish_all_eliza1.sh.

    Matches ``readonly TIERS=("2b" "4b" ...)`` and returns the quoted tokens.
    Parsing (not importing) the shell keeps this a real cross-file agreement
    check rather than a duplicated constant.
    """
    import re

    sh_path = Path(__file__).resolve().parent.parent / "publish_all_eliza1.sh"
    assert sh_path.exists(), f"publish_all_eliza1.sh not found at {sh_path}"
    text = sh_path.read_text()
    m = re.search(r"^\s*(?:readonly\s+)?TIERS=\(([^)]*)\)", text, re.MULTILINE)
    assert m, "could not find the TIERS=(...) array in publish_all_eliza1.sh"
    return tuple(re.findall(r'"([^"]+)"', m.group(1)))


def test_catalog_manifest_publish_tiers_agree():
    """The Eliza-1 tier set is declared in THREE places that must stay in sync:
    eliza1_manifest.py::ELIZA_1_TIERS (here), catalog.ts::ELIZA_1_TIER_IDS (the
    runtime catalog, asserted in packages/shared/.../catalog.test.ts), and
    publish_all_eliza1.sh::TIERS (the per-tier publish matrix). Renaming a tier
    means updating all three together. This converts the previously
    comment-only invariant into an enforced one for two of the three surfaces
    (the TS surface is enforced in catalog.test.ts)."""
    expected = ("2b", "4b", "9b", "27b", "27b-256k")
    assert ELIZA_1_TIERS == expected
    assert _parse_publish_all_tiers() == expected, (
        "publish_all_eliza1.sh::TIERS drifted from eliza1_manifest.py::"
        "ELIZA_1_TIERS — update catalog.ts, eliza1_manifest.py, and "
        "publish_all_eliza1.sh together"
    )


def test_build_manifest_happy_path():
    manifest = build_manifest(**base_kwargs())
    assert manifest["tier"] == "4b"
    assert manifest["id"] == "eliza-1-4b"
    assert manifest["defaultEligible"] is True
    assert manifest["$schema"].endswith("eliza-1.manifest.v1.json")
    assert manifest["evals"]["vadLatencyMs"] == {
        "median": 16.0,
        "passed": True,
        "boundaryMs": 24.0,
        "endpointMs": 80.0,
        "falseBargeInRate": 0.01,
    }
    assert manifest["evals"]["mtp"] == {
        "acceptanceRate": 0.71,
        "speedup": 1.8,
        "passed": True,
    }
    # Validates against itself.
    assert validate_manifest(manifest) == ()


def test_legacy_onnx_vad_manifest_remains_compatible():
    kwargs = base_kwargs()
    kwargs["files"]["vad"] = [FileEntry(path="vad/silero-vad-int8.onnx", sha256=SHA)]
    manifest = build_manifest(**kwargs)
    assert manifest["files"]["vad"][0]["path"] == "vad/silero-vad-int8.onnx"
    assert validate_manifest(manifest) == ()


def test_build_manifest_accepts_optional_component_slots_and_voice_caps():
    kwargs = base_kwargs()
    kwargs["lineage"] = {
        **kwargs["lineage"],
        "embedding": LineageEntry(base="eliza-1-embedding", license="apache-2.0"),
        "imagegen": LineageEntry(base="stable-diffusion.cpp", license="apache-2.0"),
        "wakeword": LineageEntry(base="eliza-1-wakeword", license="apache-2.0"),
    }
    kwargs["files"] = {
        **kwargs["files"],
        "embedding": [FileEntry(path="embedding/eliza-1-embed.gguf", sha256=SHA)],
        "imagegen": [FileEntry(path="imagegen/sd-1.5-Q5_0.gguf", sha256=SHA)],
        "wakeword": [FileEntry(path="wakeword/eliza-1.onnx", sha256=SHA)],
    }
    kwargs.update(
        embed_mteb_score=0.62,
        embed_mteb_passed=True,
        expressive_tag_faithfulness=0.9,
        expressive_mos=4.1,
        expressive_tag_leakage=0.01,
        expressive_passed=True,
        voice_capabilities=["tts", "emotion-tags"],
    )
    manifest = build_manifest(**kwargs)
    assert manifest["files"]["embedding"][0]["path"].startswith("embedding/")
    assert manifest["files"]["imagegen"][0]["path"].startswith("imagegen/")
    assert manifest["voice"]["version"] == "1"
    assert manifest["voice"]["frozen"] is True
    assert manifest["voice"]["cache"]["speakerPreset"] == "cache/voice-preset-default.bin"
    assert manifest["voice"]["cache"]["phraseCacheSeed"] == "cache/voice-preset-default.bin"
    assert manifest["voice"]["capabilities"] == ["tts", "emotion-tags"]
    assert validate_manifest(manifest) == ()


def test_optional_eagle3_fields_do_not_change_required_tiers():
    kwargs = base_kwargs("2b")
    kwargs["eagle3_kernel"] = {
        "enabled": True,
        "capability": "eagle3",
        "specType": "draft-eagle3",
        "model": "RedHatAI/gemma-4-E2B-EAGLE3-head",
        "maxDraftTokens": 3,
    }
    kwargs["eagle3_eval"] = True
    kwargs["eagle3_acceptance_rate"] = 0.64
    kwargs["eagle3_speedup"] = 1.35
    kwargs["eagle3_passed"] = True

    manifest = build_manifest(**kwargs)

    assert "eagle3" not in REQUIRED_KERNELS_BY_TIER["2b"]
    assert manifest["kernels"]["eagle3"]["capability"] == "eagle3"
    assert manifest["evals"]["eagle3"] == {
        "acceptanceRate": 0.64,
        "speedup": 1.35,
        "passed": True,
    }
    assert validate_manifest(manifest) == ()


def test_optional_eagle3_failure_eval_validates_without_default_gate():
    kwargs = base_kwargs("4b")
    kwargs["eagle3_eval"] = True
    kwargs["eagle3_passed"] = False
    kwargs["eagle3_failure"] = "not run on EAGLE3-capable runtime"

    manifest = build_manifest(**kwargs)

    assert manifest["evals"]["eagle3"] == {
        "acceptanceRate": None,
        "speedup": None,
        "passed": False,
        "failure": "not run on EAGLE3-capable runtime",
    }
    assert validate_manifest(manifest) == ()


def test_eagle3_eval_rejects_passing_claim_without_measurements():
    kwargs = base_kwargs("4b")
    kwargs["eagle3_eval"] = True
    kwargs["eagle3_passed"] = True

    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)

    assert any("evals.eagle3" in e for e in exc.value.errors)


def test_eagle3_kernel_rejects_invalid_known_fields():
    kwargs = base_kwargs("4b")
    kwargs["eagle3_kernel"] = {"specType": "", "maxDraftTokens": 0}

    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)

    assert any("kernels.eagle3.specType" in e for e in exc.value.errors)
    assert any("kernels.eagle3.maxDraftTokens" in e for e in exc.value.errors)


@pytest.mark.parametrize("tier", ELIZA_1_TIERS)
def test_every_tier_validates(tier: str):
    manifest = build_manifest(**base_kwargs(tier))
    assert validate_manifest(manifest) == ()


def test_missing_required_kernel_rejected():
    kwargs = base_kwargs("4b")
    # turbo3_tcq is required for every tier; dropping it must be rejected.
    kwargs["kernels_required"] = ["turboquant_q4"]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("turbo3_tcq" in e for e in exc.value.errors)


def test_default_eligible_requires_recipe_manifest_for_quant_kernels():
    kwargs = base_kwargs("4b")
    kwargs["kernel_manifest_fragments"] = None
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("kernels.recipeManifest" in e for e in exc.value.errors)
    assert any("turboquant_q4->turbo4" in e for e in exc.value.errors)
    assert any("turbo3_tcq->turbo3_tcq" in e for e in exc.value.errors)


def test_default_eligible_with_failing_eval_rejected():
    kwargs = base_kwargs("4b")
    kwargs["text_eval_passed"] = False
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("textEval" in e for e in exc.value.errors)
    assert any("defaultEligible" in e for e in exc.value.errors)


def test_default_eligible_requires_measured_mtp_eval():
    kwargs = base_kwargs("4b")
    kwargs["mtp_speedup"] = None
    kwargs["mtp_passed"] = False
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("evals.mtp" in e for e in exc.value.errors)
    assert any("defaultEligible" in e for e in exc.value.errors)


def test_non_publishable_manifest_can_validate_for_local_staging():
    kwargs = base_kwargs("2b")
    kwargs["default_eligible"] = False
    kwargs["text_eval_score"] = 0.0
    kwargs["text_eval_passed"] = False
    kwargs["voice_rtf"] = 1.52
    kwargs["voice_rtf_passed"] = False
    kwargs["asr_wer"] = 1.0
    kwargs["asr_wer_passed"] = False
    kwargs["vad_latency_ms_median"] = 0.0
    kwargs["vad_latency_ms_passed"] = False
    kwargs["e2e_loop_ok"] = False
    kwargs["thirty_turn_ok"] = False
    kwargs["expressive_tag_faithfulness"] = 0.0
    kwargs["expressive_mos"] = 0.0
    kwargs["expressive_tag_leakage"] = 1.0
    kwargs["expressive_passed"] = False
    kwargs["voice_capabilities"] = ["tts", "emotion-tags", "singing"]
    backends = passing_backends()
    backends["metal"] = KernelVerification(
        status="fail", at_commit="abc1234", report="metal.txt"
    )
    backends["vulkan"] = KernelVerification(
        status="fail", at_commit="abc1234", report="vulkan.txt"
    )
    backends["cpu"] = KernelVerification(
        status="fail", at_commit="abc1234", report="cpu.txt"
    )
    kwargs["verified_backends"] = backends

    manifest = build_manifest(**kwargs, require_publish_ready=False)

    assert manifest["defaultEligible"] is False
    assert validate_manifest(manifest, require_publish_ready=False) == ()
    publish_errors = validate_manifest(manifest)
    assert any("textEval" in e for e in publish_errors)
    assert any("metal" in e for e in publish_errors)


def test_default_eligible_true_still_rejected_in_local_staging_mode():
    kwargs = base_kwargs("2b")
    kwargs["text_eval_passed"] = False

    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs, require_publish_ready=False)

    assert any("defaultEligible" in e for e in exc.value.errors)
    assert any("textEval" in e for e in exc.value.errors)


def test_default_eligible_with_failing_voice_rtf_rejected():
    kwargs = base_kwargs("4b")
    kwargs["voice_rtf_passed"] = False
    with pytest.raises(Eliza1ManifestError):
        build_manifest(**kwargs)


def test_default_eligible_with_failing_e2e_rejected():
    kwargs = base_kwargs("4b")
    kwargs["e2e_loop_ok"] = False
    with pytest.raises(Eliza1ManifestError):
        build_manifest(**kwargs)


def test_component_files_require_matching_lineage_and_eval_gate():
    kwargs = base_kwargs("4b")
    kwargs["lineage"] = {
        k: v for k, v in kwargs["lineage"].items() if k != "asr"
    }
    kwargs["asr_wer"] = None
    kwargs["asr_wer_passed"] = None
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("lineage.asr" in e for e in exc.value.errors)
    assert any("evals.asrWer" in e for e in exc.value.errors)


def test_vad_false_barge_in_metric_must_be_rate():
    kwargs = base_kwargs("4b")
    kwargs["vad_false_barge_in_rate"] = 1.2
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("falseBargeInRate" in e for e in exc.value.errors)


def test_default_eligible_requires_asr_and_vad_components():
    kwargs = base_kwargs("4b")
    kwargs["lineage"] = {
        k: v for k, v in kwargs["lineage"].items() if k not in {"asr", "vad"}
    }
    kwargs["files"]["asr"] = []
    kwargs["files"]["vad"] = []
    kwargs["asr_wer"] = None
    kwargs["asr_wer_passed"] = None
    kwargs["vad_latency_ms_median"] = None
    kwargs["vad_latency_ms_passed"] = None
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("files.asr" in e for e in exc.value.errors)
    assert any("files.vad" in e for e in exc.value.errors)


def test_expressive_voice_capabilities_require_expressive_eval():
    kwargs = base_kwargs("4b")
    kwargs["voice_capabilities"] = ["tts", "singing"]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("evals.expressive" in e for e in exc.value.errors)


def test_missing_voice_cache_file_rejected():
    kwargs = base_kwargs("4b")
    kwargs["files"]["cache"] = [
        FileEntry(path="cache/not-the-default-voice-cache.bin", sha256=SHA)
    ]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("voice cache" in e for e in exc.value.errors)


def test_default_eligible_with_failing_backend_rejected():
    kwargs = base_kwargs("4b")
    backends = passing_backends()
    backends["cuda"] = KernelVerification(
        status="fail", at_commit="abc1234", report="cuda.txt"
    )
    kwargs["verified_backends"] = backends
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("cuda" in e for e in exc.value.errors)


def test_lite_tier_does_not_require_cuda_or_rocm_pass():
    """Lite tier ships on metal/vulkan/cpu — failing cuda/rocm backends
    must not block lite publishing."""

    kwargs = base_kwargs("2b")
    backends = passing_backends()
    backends["cuda"] = KernelVerification(
        status="fail", at_commit="abc1234", report="cuda.txt"
    )
    backends["rocm"] = KernelVerification(
        status="fail", at_commit="abc1234", report="rocm.txt"
    )
    kwargs["verified_backends"] = backends
    manifest = build_manifest(**kwargs)
    assert validate_manifest(manifest) == ()


def test_desktop_tier_requires_rocm_pass():
    kwargs = base_kwargs("4b")
    backends = passing_backends()
    backends["rocm"] = KernelVerification(
        status="fail", at_commit="abc1234", report="rocm.txt"
    )
    kwargs["verified_backends"] = backends
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("rocm" in e for e in exc.value.errors)


def test_long_context_requires_turbo3_tcq():
    kwargs = base_kwargs("4b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-4b-128k.gguf", sha256=SHA, ctx=131072)
    ]
    kwargs["kernels_required"] = [
        k for k in kwargs["kernels_required"] if k != "turbo3_tcq"
    ]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("turbo3_tcq" in e for e in exc.value.errors)


def test_long_context_rejects_turbo3_tcq_optional_only():
    kwargs = base_kwargs("4b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-4b-128k.gguf", sha256=SHA, ctx=131072)
    ]
    kwargs["kernels_required"] = [
        k for k in kwargs["kernels_required"] if k != "turbo3_tcq"
    ]
    kwargs["kernels_optional"] = ["turbo3_tcq"]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("kernels.required" in e for e in exc.value.errors)


def test_long_context_with_turbo3_tcq_in_required_passes():
    kwargs = base_kwargs("4b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-4b-128k.gguf", sha256=SHA, ctx=131072)
    ]
    kwargs["kernels_required"] = list(REQUIRED_KERNELS_BY_TIER["4b"])
    kwargs["kernels_optional"] = []
    manifest = build_manifest(**kwargs)
    assert validate_manifest(manifest) == ()


def test_text_context_below_128k_is_rejected():
    kwargs = base_kwargs("2b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-2b-64k.gguf", sha256=SHA, ctx=65536)
    ]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("128k" in e for e in exc.value.errors)


def test_32k_release_path_is_rejected_even_when_gguf_metadata_is_long():
    kwargs = base_kwargs("2b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-2b-32k.gguf", sha256=SHA, ctx=262144)
    ]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("32k/64k" in e for e in exc.value.errors)


def test_validate_rejects_bad_sha256():
    manifest = build_manifest(**base_kwargs())
    manifest["files"]["text"][0]["sha256"] = "not-a-hash"
    errors = validate_manifest(manifest)
    assert errors
    assert any("sha256" in e for e in errors)


def test_validate_rejects_bad_semver():
    manifest = build_manifest(**base_kwargs())
    manifest["version"] = "v1"
    errors = validate_manifest(manifest)
    assert any("version" in e for e in errors)


def test_validate_rejects_id_not_matching_tier():
    manifest = build_manifest(**base_kwargs())
    manifest["id"] = "eliza-1-foo"
    errors = validate_manifest(manifest)
    assert any("id" in e for e in errors)


def test_validate_rejects_publishedat_with_timezone_offset():
    """publishedAt parity with the TS Zod validator.

    Zod's ``.datetime()`` default accepts only the ``Z`` suffix; offsets
    like ``+00:00`` are rejected. The Python regex must match so a
    manifest that round-trips through both sides validates identically.
    """
    manifest = build_manifest(**base_kwargs())
    manifest["publishedAt"] = "2026-05-10T00:00:00+00:00"
    errors = validate_manifest(manifest)
    assert any("publishedAt" in e for e in errors)


def test_validate_accepts_publishedat_with_z_suffix():
    manifest = build_manifest(**base_kwargs())
    manifest["publishedAt"] = "2026-05-10T00:00:00Z"
    assert validate_manifest(manifest) == ()
    manifest["publishedAt"] = "2026-05-10T00:00:00.123Z"
    assert validate_manifest(manifest) == ()


def test_write_manifest_emits_pretty_json(tmp_path: Path):
    manifest = build_manifest(**base_kwargs())
    out = tmp_path / "eliza-1.manifest.json"
    write_manifest(manifest, out)
    text = out.read_text()
    assert text.endswith("\n")
    # Pretty-printed: at least one indented line.
    assert "\n  " in text
    # Round-trip parses to the same content.
    assert json.loads(text) == manifest


def test_write_manifest_refuses_invalid(tmp_path: Path):
    manifest = build_manifest(**base_kwargs())
    manifest["evals"]["textEval"]["passed"] = False
    out = tmp_path / "bad.manifest.json"
    with pytest.raises(Eliza1ManifestError):
        write_manifest(manifest, out)
    assert not out.exists()


def test_write_manifest_allows_non_publishable_only_when_requested(
    tmp_path: Path,
):
    kwargs = base_kwargs("2b")
    kwargs["default_eligible"] = False
    kwargs["text_eval_score"] = 0.0
    kwargs["text_eval_passed"] = False
    kwargs["voice_rtf_passed"] = False
    kwargs["asr_wer_passed"] = False
    kwargs["vad_latency_ms_passed"] = False
    kwargs["e2e_loop_ok"] = False
    kwargs["thirty_turn_ok"] = False
    manifest = build_manifest(**kwargs, require_publish_ready=False)

    out = tmp_path / "local.manifest.json"
    with pytest.raises(Eliza1ManifestError):
        write_manifest(manifest, out)

    write_manifest(manifest, out, require_publish_ready=False)
    assert json.loads(out.read_text())["defaultEligible"] is False


# ---------------------------------------------------------------------------
# Context-suffix parser (shared by publish + manifest builder)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("128k", 131072),
        ("256k", 262144),
        ("1k", 1024),
    ],
)
def test_parse_ctx_string_accepts_k_suffix(value: str, expected: int):
    assert parse_ctx_string(value) == expected


@pytest.mark.parametrize(
    "bad",
    [
        "32",      # no `k` suffix
        "k",       # no digits
        "64K",     # uppercase K not accepted
        "64kb",    # extra chars
        "",
        "64.5k",   # not an integer
    ],
)
def test_parse_ctx_string_rejects_bad_input(bad: str):
    with pytest.raises(ValueError):
        parse_ctx_string(bad)


def test_parse_text_ctx_from_filename_finds_suffix_token():
    assert (
        parse_text_ctx_from_filename(Path("text/eliza-1-4b-128k.gguf"))
        == 131072
    )
    assert (
        parse_text_ctx_from_filename(Path("text/eliza-1-4b-256k.gguf"))
        == 262144
    )


def test_parse_text_ctx_from_filename_returns_none_when_no_suffix():
    assert parse_text_ctx_from_filename(Path("text/eliza-1-2b.gguf")) is None
    assert parse_text_ctx_from_filename(Path("mtp/drafter-4b.gguf")) is None


# ---------------------------------------------------------------------------
# base-v1 provenance block (the upstream base models, GGUF + fully optimized,
# NOT fine-tuned).
# ---------------------------------------------------------------------------


def _base_v1_provenance() -> dict:
    return {
        "releaseState": "base-v1",
        "finetuned": False,
        "sourceModels": {
            "text": {
                "repo": "unsloth/gemma-4-E4B-GGUF",
                "file": "gemma-4-E4B-Q4_K_M.gguf",
                "convertedVia": "<fork>/convert_hf_to_gguf.py",
            },
            "voice": {"repo": "Serveurperso/OmniVoice-GGUF"},
            "asr": {"repo": "ggml-org/Qwen3-ASR-0.6B-GGUF"},
            "vad": {"repo": "ggml-org/whisper-vad"},
            "vision": {"repo": "unsloth/gemma-4-E4B-GGUF", "file": "mmproj-F16.gguf"},
            "drafter": {"repo": "elizaos/eliza-1", "file": "bundles/4b/mtp/drafter-4b.gguf"},
        },
    }


def test_base_v1_manifest_blocks_until_gemma_asr_source_is_configured():
    kwargs = base_kwargs("4b")
    kwargs["provenance"] = _base_v1_provenance()
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)

    assert any("retired Qwen asr provenance" in e for e in exc.value.errors)


def test_base_v1_candidate_accepts_explicit_non_qwen_asr_source():
    kwargs = base_kwargs("4b")
    kwargs["default_eligible"] = False
    prov = _base_v1_provenance()
    prov["releaseState"] = "base-v1-candidate"
    prov["sourceModels"]["asr"] = {
        "repo": "example/gemma-compatible-asr-gguf",
        "file": "asr/eliza-1-asr.gguf",
    }
    kwargs["provenance"] = prov
    manifest = build_manifest(**kwargs)
    assert manifest["defaultEligible"] is False
    assert manifest["provenance"]["releaseState"] == "base-v1-candidate"
    assert manifest["provenance"]["finetuned"] is False
    assert manifest["provenance"]["sourceModels"]["asr"]["repo"].startswith("example/")
    assert validate_manifest(manifest) == ()


def test_base_v1_27b_provenance_requires_gemma4_text_source():
    assert (
        manifest_mod.canonical_source_repo_error(
            "text", "google/gemma-4-31B", tier="27b"
        )
        is None
    )
    error = manifest_mod.canonical_source_repo_error(
        "text", "Qwen/Qwen3-4B", tier="27b"
    )
    assert error is not None
    assert "Qwen/Qwen3-4B" in error


def test_base_v1_provenance_requires_finetuned_false():
    kwargs = base_kwargs("4b")
    prov = _base_v1_provenance()
    prov["finetuned"] = True  # contradicts base-v1
    kwargs["provenance"] = prov
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("finetuned" in e for e in exc.value.errors)


def test_base_v1_provenance_requires_coverage_for_shipped_components():
    kwargs = base_kwargs("4b")
    prov = _base_v1_provenance()
    del prov["sourceModels"]["asr"]  # but files.asr is non-empty
    del prov["sourceModels"]["vision"]
    kwargs["provenance"] = prov
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("provenance.sourceModels.asr" in e for e in exc.value.errors)
    assert any("provenance.sourceModels.vision" in e for e in exc.value.errors)


def test_base_v1_provenance_rejects_retired_qwen_asr_and_embedding_repos():
    kwargs = base_kwargs("4b")
    kwargs["lineage"] = {
        **kwargs["lineage"],
        "embedding": LineageEntry(base="qwen3-embedding", license="apache-2.0"),
    }
    kwargs["files"] = {
        **kwargs["files"],
        "embedding": [FileEntry(path="embedding/eliza-1-embedding.gguf", sha256=SHA)],
    }
    kwargs["embed_mteb_score"] = 0.62
    kwargs["embed_mteb_passed"] = True
    prov = _base_v1_provenance()
    prov["sourceModels"]["asr"] = {"repo": "ggml-org/Qwen3-ASR-1.7B-GGUF"}
    prov["sourceModels"]["embedding"] = {
        "repo": "Qwen/Qwen3-Embedding-0.6B-GGUF"
    }
    kwargs["provenance"] = prov

    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)

    assert any("retired Qwen asr provenance" in e for e in exc.value.errors)
    assert any("retired Qwen embedding provenance" in e for e in exc.value.errors)


def test_base_v1_provenance_rejects_unconfigured_gemma_asr_repo():
    kwargs = base_kwargs("4b")
    prov = _base_v1_provenance()
    prov["sourceModels"]["asr"] = {
        "repo": "example/gemma-compatible-asr-gguf"
    }
    kwargs["provenance"] = prov

    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)

    assert any("no canonical Gemma-compatible asr source" in e for e in exc.value.errors)


def test_provenance_rejects_unknown_release_state():
    manifest = build_manifest(**base_kwargs("4b"))
    manifest["provenance"] = {
        "releaseState": "not-a-state",
        "finetuned": False,
        "sourceModels": {},
    }
    errors = validate_manifest(manifest)
    assert any("releaseState" in e for e in errors)


def test_provenance_rejects_unknown_component_slot():
    manifest = build_manifest(**base_kwargs("4b"))
    manifest["provenance"] = {
        "releaseState": "base-v1",
        "finetuned": False,
        "sourceModels": {"text": {"repo": "x"}, "bogus": {"repo": "x"}},
    }
    errors = validate_manifest(manifest)
    assert any("unknown component slot" in e for e in errors)


# ---------------------------------------------------------------------------
# I8-quant — VOICE_QUANT_LADDER_BY_TIER coverage
# ---------------------------------------------------------------------------


def test_voice_quant_ladder_covers_every_tier():
    """Every tier in VOICE_QUANT_BY_TIER must have a ladder entry. Missing
    keys would silently break the
    stage_eliza1_bundle_assets.py ladder loop."""
    assert set(VOICE_QUANT_LADDER_BY_TIER.keys()) == set(VOICE_QUANT_BY_TIER.keys())


def test_voice_quant_ladder_mobile_tiers_publish_narrow_omnivoice_ladder():
    """OmniVoice-capable mobile tiers publish the narrow quant ladder."""
    expected = ("Q3_K_M", "Q4_K_M", "Q5_K_M")
    for tier in ("2b", "4b"):
        assert VOICE_QUANT_LADDER_BY_TIER[tier] == expected
        assert VOICE_BACKENDS_BY_TIER[tier] == ("omnivoice", "kokoro")


def test_voice_quant_ladder_large_tiers_have_full_kquant_ladder():
    """Large tiers (9b / 27b) ship OmniVoice and must
    publish the full Q3..Q8 ladder so the downloader can pick the level
    matching the host's RAM/SoC class at install time."""
    expected = ("Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0")
    for tier in ("9b", "27b"):
        assert VOICE_QUANT_LADDER_BY_TIER[tier] == expected
        assert "omnivoice" in VOICE_BACKENDS_BY_TIER[tier]


def test_voice_quant_default_is_in_ladder_for_omnivoice_tiers():
    """The runtime's default quant (VOICE_QUANT_BY_TIER) must be a member of
    the published ladder for every OmniVoice-shipping tier — otherwise the
    runtime would request a file the publish path never staged."""
    for tier, default_quant in VOICE_QUANT_BY_TIER.items():
        ladder = VOICE_QUANT_LADDER_BY_TIER[tier]
        if ladder:  # OmniVoice-shipping tier
            assert default_quant in ladder, (
                f"tier {tier!r}: default quant {default_quant!r} is not in "
                f"published ladder {ladder!r}"
            )
