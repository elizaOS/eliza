"""Tests for the Eliza-1 manifest generator + validator (Python side)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.manifest.eliza1_manifest import (
    ELIZA_1_MANIFEST_SCHEMA_VERSION,
    REQUIRED_KERNELS_BY_TIER,
    Eliza1ManifestError,
    FileEntry,
    KernelVerification,
    LineageEntry,
    build_manifest,
    parse_ctx_string,
    parse_text_ctx_from_filename,
    validate_manifest,
    write_manifest,
)

SHA = "0" * 64


def passing_backends() -> dict[str, KernelVerification]:
    return {
        b: KernelVerification(status="pass", at_commit="abc1234", report=f"{b}.txt")
        for b in ("metal", "vulkan", "cuda", "cpu")
    }


def base_kwargs(tier: str = "desktop-9b") -> dict:
    return dict(
        tier=tier,
        version="1.0.0",
        published_at="2026-05-10T00:00:00Z",
        lineage={
            "text": LineageEntry(base="eliza-1-text-backbone", license="apache-2.0"),
            "voice": LineageEntry(base="eliza-1-voice-backbone", license="apache-2.0"),
            "drafter": LineageEntry(base="eliza-1-drafter", license="apache-2.0"),
            "asr": LineageEntry(base="eliza-1-asr", license="apache-2.0"),
            "vision": LineageEntry(base="eliza-1-vision", license="apache-2.0"),
        },
        files={
            "text": [
                FileEntry(path=f"text/eliza-1-{tier}-64k.gguf", sha256=SHA, ctx=65536)
            ],
            "voice": [FileEntry(path="tts/omnivoice-1.7b.gguf", sha256=SHA)],
            "asr": [FileEntry(path="asr/asr.gguf", sha256=SHA)],
            "vision": [FileEntry(path=f"vision/mmproj-{tier}.gguf", sha256=SHA)],
            "dflash": [FileEntry(path=f"dflash/drafter-{tier}.gguf", sha256=SHA)],
            "cache": [FileEntry(path="cache/voice-preset-default.bin", sha256=SHA)],
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
        e2e_loop_ok=True,
        thirty_turn_ok=True,
        ram_budget_min_mb=7000,
        ram_budget_recommended_mb=9500,
        default_eligible=True,
    )


def test_schema_version_constant():
    assert ELIZA_1_MANIFEST_SCHEMA_VERSION == "1"


def test_build_manifest_happy_path():
    manifest = build_manifest(**base_kwargs())
    assert manifest["tier"] == "desktop-9b"
    assert manifest["id"] == "eliza-1-desktop-9b"
    assert manifest["defaultEligible"] is True
    assert manifest["$schema"].endswith("eliza-1.manifest.v1.json")
    # Validates against itself.
    assert validate_manifest(manifest) == ()


def test_build_manifest_accepts_optional_component_slots_and_voice_caps():
    kwargs = base_kwargs()
    kwargs["lineage"] = {
        **kwargs["lineage"],
        "embedding": LineageEntry(base="eliza-1-embedding", license="apache-2.0"),
        "vad": LineageEntry(base="eliza-1-vad", license="mit"),
        "wakeword": LineageEntry(base="eliza-1-wakeword", license="apache-2.0"),
    }
    kwargs["files"] = {
        **kwargs["files"],
        "embedding": [FileEntry(path="embedding/eliza-1-embed.gguf", sha256=SHA)],
        "vad": [FileEntry(path="vad/eliza-1-vad.onnx", sha256=SHA)],
        "wakeword": [FileEntry(path="wakeword/eliza-1.onnx", sha256=SHA)],
    }
    kwargs.update(
        embed_mteb_score=0.62,
        embed_mteb_passed=True,
        vad_latency_ms_median=16.0,
        vad_latency_ms_passed=True,
        expressive_tag_faithfulness=0.9,
        expressive_mos=4.1,
        expressive_tag_leakage=0.01,
        expressive_passed=True,
        voice_capabilities=["tts", "emotion-tags"],
    )
    manifest = build_manifest(**kwargs)
    assert manifest["files"]["embedding"][0]["path"].startswith("embedding/")
    assert manifest["voice"]["capabilities"] == ["tts", "emotion-tags"]
    assert validate_manifest(manifest) == ()


@pytest.mark.parametrize(
    "tier",
    ["lite-0_6b", "mobile-1_7b", "desktop-9b", "pro-27b", "server-h200"],
)
def test_every_tier_validates(tier: str):
    manifest = build_manifest(**base_kwargs(tier))
    assert validate_manifest(manifest) == ()


def test_missing_required_kernel_rejected():
    kwargs = base_kwargs("desktop-9b")
    kwargs["kernels_required"] = ["turboquant_q4", "qjl", "polarquant"]  # no dflash
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("dflash" in e for e in exc.value.errors)


def test_default_eligible_with_failing_eval_rejected():
    kwargs = base_kwargs("desktop-9b")
    kwargs["text_eval_passed"] = False
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("textEval" in e for e in exc.value.errors)
    assert any("defaultEligible" in e for e in exc.value.errors)


def test_default_eligible_with_failing_voice_rtf_rejected():
    kwargs = base_kwargs("desktop-9b")
    kwargs["voice_rtf_passed"] = False
    with pytest.raises(Eliza1ManifestError):
        build_manifest(**kwargs)


def test_default_eligible_with_failing_e2e_rejected():
    kwargs = base_kwargs("desktop-9b")
    kwargs["e2e_loop_ok"] = False
    with pytest.raises(Eliza1ManifestError):
        build_manifest(**kwargs)


def test_component_files_require_matching_lineage_and_eval_gate():
    kwargs = base_kwargs("desktop-9b")
    kwargs["lineage"] = {
        k: v for k, v in kwargs["lineage"].items() if k != "asr"
    }
    kwargs["asr_wer"] = None
    kwargs["asr_wer_passed"] = None
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("lineage.asr" in e for e in exc.value.errors)
    assert any("evals.asrWer" in e for e in exc.value.errors)


def test_expressive_voice_capabilities_require_expressive_eval():
    kwargs = base_kwargs("desktop-9b")
    kwargs["voice_capabilities"] = ["tts", "singing"]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("evals.expressive" in e for e in exc.value.errors)


def test_default_eligible_with_failing_backend_rejected():
    kwargs = base_kwargs("desktop-9b")
    backends = passing_backends()
    backends["cuda"] = KernelVerification(
        status="fail", at_commit="abc1234", report="cuda.txt"
    )
    kwargs["verified_backends"] = backends
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("cuda" in e for e in exc.value.errors)


def test_lite_tier_does_not_require_cuda_pass():
    """Lite tier ships on metal/vulkan/cpu — a failing cuda backend
    must not block lite publishing."""

    kwargs = base_kwargs("lite-0_6b")
    backends = passing_backends()
    backends["cuda"] = KernelVerification(
        status="fail", at_commit="abc1234", report="cuda.txt"
    )
    kwargs["verified_backends"] = backends
    manifest = build_manifest(**kwargs)
    assert validate_manifest(manifest) == ()


def test_long_context_requires_turbo3_tcq():
    kwargs = base_kwargs("desktop-9b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-desktop-9b-128k.gguf", sha256=SHA, ctx=131072)
    ]
    kwargs["kernels_required"] = [
        k for k in kwargs["kernels_required"] if k != "turbo3_tcq"
    ]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("turbo3_tcq" in e for e in exc.value.errors)


def test_long_context_rejects_turbo3_tcq_optional_only():
    kwargs = base_kwargs("desktop-9b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-desktop-9b-128k.gguf", sha256=SHA, ctx=131072)
    ]
    kwargs["kernels_required"] = [
        k for k in kwargs["kernels_required"] if k != "turbo3_tcq"
    ]
    kwargs["kernels_optional"] = ["turbo3_tcq"]
    with pytest.raises(Eliza1ManifestError) as exc:
        build_manifest(**kwargs)
    assert any("kernels.required" in e for e in exc.value.errors)


def test_long_context_with_turbo3_tcq_in_required_passes():
    kwargs = base_kwargs("desktop-9b")
    kwargs["files"]["text"] = [
        FileEntry(path="text/eliza-1-desktop-9b-128k.gguf", sha256=SHA, ctx=131072)
    ]
    kwargs["kernels_required"] = list(REQUIRED_KERNELS_BY_TIER["desktop-9b"])
    kwargs["kernels_optional"] = []
    manifest = build_manifest(**kwargs)
    assert validate_manifest(manifest) == ()


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


# ---------------------------------------------------------------------------
# Context-suffix parser (shared by publish + manifest builder)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("64k", 65536),
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
        parse_text_ctx_from_filename(Path("text/eliza-1-desktop-9b-64k.gguf"))
        == 65536
    )
    assert (
        parse_text_ctx_from_filename(Path("text/eliza-1-server-h200-256k.gguf"))
        == 262144
    )


def test_parse_text_ctx_from_filename_returns_none_when_no_suffix():
    assert parse_text_ctx_from_filename(Path("text/eliza-1-mobile-1_7b.gguf")) is None
    assert parse_text_ctx_from_filename(Path("dflash/drafter-9b.gguf")) is None
