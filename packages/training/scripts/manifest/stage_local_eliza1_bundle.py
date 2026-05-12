#!/usr/bin/env python3
"""Complete a local Eliza-1 bundle with non-publishable stand-in assets.

This is a local staging helper, not a release publisher. It is intentionally
separate from ``scripts.publish.orchestrator`` because a real HF release must
fail unless final weights, hardware verification, evals, and license evidence
are complete. This helper fills the local on-disk layout so runtime smoke
tests can exercise the bundle shape while preserving non-publishable
provenance in ``evidence/release.json`` and the manifest gates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Mapping, Sequence

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

try:
    from .eliza1_manifest import (
        ELIZA_1_BACKENDS,
        ELIZA_1_VOICE_MANIFEST_VERSION,
        REQUIRED_KERNELS_BY_TIER,
        SUPPORTED_BACKENDS_BY_TIER,
        VOICE_PRESET_CACHE_PATH,
        FileEntry,
        KernelVerification,
        LineageEntry,
        build_manifest,
        parse_text_ctx_from_filename,
        validate_manifest,
        write_manifest,
    )
    from .eliza1_platform_plan import CONTEXTS_BY_TIER, text_artifact_name
except ImportError:  # pragma: no cover - direct script execution path
    from eliza1_manifest import (
        ELIZA_1_BACKENDS,
        ELIZA_1_VOICE_MANIFEST_VERSION,
        REQUIRED_KERNELS_BY_TIER,
        SUPPORTED_BACKENDS_BY_TIER,
        VOICE_PRESET_CACHE_PATH,
        FileEntry,
        KernelVerification,
        LineageEntry,
        build_manifest,
        parse_text_ctx_from_filename,
        validate_manifest,
        write_manifest,
    )
    from eliza1_platform_plan import CONTEXTS_BY_TIER, text_artifact_name

from benchmarks.eliza1_gates import apply_gates
from scripts.quantization._kernel_manifest import kernel_manifest_fragment

LOCAL_MODEL_ROOT: Final[Path] = (
    Path.home() / ".eliza" / "local-inference" / "models"
)
DEFAULT_BUNDLE_DIR: Final[Path] = LOCAL_MODEL_ROOT / "eliza-1-2b.bundle"
DEFAULT_TEXT_STANDIN_CANDIDATES: Final[tuple[Path, ...]] = (
    LOCAL_MODEL_ROOT / "qwen3.5-4b-dflash" / "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    LOCAL_MODEL_ROOT / "qwen3.5-4b-dflash.gguf",
)
DEFAULT_DRAFTER_STANDIN_CANDIDATES: Final[tuple[Path, ...]] = (
    LOCAL_MODEL_ROOT
    / "qwen3.5-4b-dflash-drafter-q4"
    / "Qwen3.5-4B-DFlash-Q4_K_M.repaired.gguf",
    LOCAL_MODEL_ROOT
    / "qwen3.5-4b-dflash-drafter-q4"
    / "Qwen3.5-4B-DFlash-Q4_K_M.gguf",
    LOCAL_MODEL_ROOT / "qwen3.5-4b-dflash-drafter-q4.repaired.gguf",
    LOCAL_MODEL_ROOT / "qwen3.5-4b-dflash-drafter-q4.gguf",
)
VISION_TIERS: Final[set[str]] = {"0_8b", "2b", "4b", "9b", "27b", "27b-256k"}

DEFAULT_RAM_BUDGET_MB: Final[Mapping[str, tuple[int, int]]] = {
    "0_8b": (1800, 2400),
    "2b": (3500, 5000),
    "4b": (6000, 8000),
    "9b": (7000, 9500),
    "27b": (24000, 32000),
    "27b-256k": (48000, 64000),
}
DEFAULT_VOICE_CAPABILITIES: Final[tuple[str, ...]] = (
    "tts",
    "emotion-tags",
    "singing",
)
CHECKSUM_PATH: Final[Path] = Path("checksums/SHA256SUMS")
LOCAL_EVIDENCE_NAME: Final[str] = "local-bundle-completion.json"
REQUIRED_RELEASE_DIRS: Final[tuple[str, ...]] = (
    "text",
    "dflash",
    "vision",
    "tts",
    "asr",
    "vad",
    "cache",
    "evals",
    "checksums",
    "licenses",
    "evidence",
    "source",
    "quantization",
)


@dataclass(frozen=True, slots=True)
class StagedFile:
    role: str
    source: str
    destination: str
    sha256: str
    sizeBytes: int
    method: str
    provenance: str


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _first_existing(candidates: Sequence[Path], label: str) -> Path:
    for path in candidates:
        if path.is_file():
            return path
    rendered = "\n  - ".join(str(p) for p in candidates)
    raise FileNotFoundError(f"no local {label} stand-in found:\n  - {rendered}")


def _bundle_source_candidates(bundle_dir: Path, subdir: str) -> tuple[Path, ...]:
    source_dir = bundle_dir / "source" / subdir
    if not source_dir.is_dir():
        return ()
    return tuple(sorted(p for p in source_dir.glob("*.gguf") if p.is_file()))


def _is_under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _choose_source(
    *,
    explicit: Path | None,
    bundle_dir: Path,
    source_subdir: str,
    fallback_candidates: Sequence[Path],
    label: str,
) -> Path:
    if explicit is not None:
        return explicit
    bundled = _bundle_source_candidates(bundle_dir, source_subdir)
    if bundled:
        return bundled[0]
    return _first_existing(fallback_candidates, label)


def _json_write(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def _text_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _stage_file(
    *,
    role: str,
    source: Path,
    destination: Path,
    provenance: str,
    force: bool,
) -> StagedFile:
    source = source.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_sha = sha256_file(source)

    if destination.exists():
        dest_sha = sha256_file(destination)
        if dest_sha == source_sha:
            method = "existing"
        elif force:
            destination.unlink()
            method = _link_or_copy(source, destination)
        else:
            raise FileExistsError(
                f"{destination} already exists with sha256 {dest_sha}; "
                f"expected {source_sha}. Re-run with --force to replace it."
            )
    else:
        method = _link_or_copy(source, destination)

    return StagedFile(
        role=role,
        source=str(source),
        destination=str(destination),
        sha256=source_sha,
        sizeBytes=destination.stat().st_size,
        method=method,
        provenance=provenance,
    )


def _link_or_copy(source: Path, destination: Path) -> str:
    try:
        os.link(source, destination)
        return "hardlink"
    except OSError:
        shutil.copy2(source, destination)
        return "copy"


def _ensure_release_dirs(bundle_dir: Path) -> None:
    for rel in REQUIRED_RELEASE_DIRS:
        (bundle_dir / rel).mkdir(parents=True, exist_ok=True)


def _load_smoke_report(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    if not path.is_file():
        raise FileNotFoundError(f"local smoke report does not exist: {path}")
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"local smoke report must contain a JSON object: {path}")
    return data


def _default_smoke_report() -> Path | None:
    root = _repo_root() / "packages" / "inference" / "reports" / "local-e2e"
    candidates = sorted(root.glob("*/fused-voice-ffi-smoke.json"))
    return candidates[-1] if candidates else None


def _voice_rtf_from_smoke(smoke: Mapping[str, Any] | None) -> float:
    if not smoke:
        return 0.0
    tts = smoke.get("tts")
    if not isinstance(tts, dict) or tts.get("ok") is not True:
        return 0.0
    audio_seconds = tts.get("audioSeconds")
    synthesize_ms = tts.get("synthesizeMs")
    if not isinstance(audio_seconds, (int, float)) or audio_seconds <= 0:
        return 0.0
    if not isinstance(synthesize_ms, (int, float)) or synthesize_ms < 0:
        return 0.0
    return round(float(synthesize_ms) / (float(audio_seconds) * 1000.0), 4)


def _source_result(smoke: Mapping[str, Any] | None) -> str:
    if not smoke:
        return "not-run"
    return str(smoke.get("result") or "unknown")


def _publish_blocking_reasons(
    *,
    tier: str,
    smoke: Mapping[str, Any] | None,
) -> list[str]:
    reasons = [
        f"text artifact is a local stand-in, not final Eliza-1 {tier} text weights",
        f"DFlash drafter is a local stand-in, not a drafter trained and verified against final Eliza-1 {tier} text weights",
        "required text quality, ASR WER, VAD latency, expressive voice, DFlash acceptance, first-token, first-audio, barge-in, 30-turn, mobile RSS, and thermal evals are missing or failed",
        "required Metal, Vulkan, and CPU backend verification is not pass for the staged bytes",
        "text and DFlash license blobs are local provenance notes, not release-reviewed license attestations",
        "release evidence is local-standin and cannot be uploaded by the publish orchestrator",
    ]
    asr = smoke.get("asr") if isinstance(smoke, dict) else None
    if isinstance(asr, dict) and asr.get("ok") is not True:
        reasons.append(
            "local fused voice smoke report is partial-pass because ASR is not wired in ABI v1"
        )
    elif smoke is None:
        reasons.append("no local fused voice smoke report was attached")
    return reasons


def _write_licenses(bundle_dir: Path, *, tier: str, force: bool) -> list[str]:
    license_texts = {
        "LICENSE.text": (
            "Eliza-1 local text stand-in provenance note.\n\n"
            "This bundle uses a local stand-in text GGUF for runtime layout "
            "testing. It is not a final Eliza-1 1.7B text checkpoint and "
            "is not release-reviewed for publishing.\n"
        ),
        "LICENSE.dflash": (
            "Eliza-1 local DFlash stand-in provenance note.\n\n"
            "This bundle uses a local stand-in drafter GGUF for runtime "
            "layout testing. It is not trained or verified against final "
            "Eliza-1 1.7B text weights and is not publishable.\n"
        ),
        "LICENSE.eliza-1": (
            "Eliza-1 local bundle license notice.\n\n"
            "This is a non-publishable local staging bundle. Release "
            "licensing must be regenerated from final component licenses "
            "before any upload candidate is created.\n"
        ),
    }
    if tier in VISION_TIERS:
        license_texts["LICENSE.vision"] = (
            "Eliza-1 local vision stand-in provenance note.\n\n"
            "This bundle may use a source-only mmproj GGUF for runtime "
            "layout testing. It is not a final Eliza-1 vision artifact and "
            "is not release-reviewed for publishing.\n"
        )
    written: list[str] = []
    for name, text in license_texts.items():
        path = bundle_dir / "licenses" / name
        if path.exists() and not force:
            written.append(f"licenses/{name}")
            continue
        _text_write(path, text)
        written.append(f"licenses/{name}")
    return written


_GGUF_DRAFTER_TARGET_CHECKPOINT_KEY: Final[str] = (
    "dflash-draft.target_checkpoint_sha256"
)


def _read_drafter_target_checkpoint_sha256(drafter_path: Path) -> str | None:
    """Read the target text-checkpoint sha256 the drafter was distilled
    against, recorded as a GGUF metadata string by ``distill_dflash_drafter.py``.

    Returns ``None`` for local stand-in drafters (source-converted GGUFs
    have no such key). The publish path treats a missing key as a hard
    error; this staging helper only records what it finds.
    """
    try:
        from gguf import GGUFReader  # type: ignore
    except ImportError:
        return None
    try:
        reader = GGUFReader(str(drafter_path), "r")
    except Exception:
        return None
    field = reader.fields.get(_GGUF_DRAFTER_TARGET_CHECKPOINT_KEY)
    if field is None:
        return None
    try:
        return str(field.parts[field.data[0]].tobytes().decode("utf-8"))
    except Exception:
        return None


def _write_target_meta(
    *,
    bundle_dir: Path,
    tier: str,
    text_files: Sequence[StagedFile],
    drafter_file: StagedFile,
    reasons: Sequence[str],
) -> None:
    if not text_files:
        raise ValueError("_write_target_meta requires at least one text file")
    primary_text = text_files[0]
    required_kernels = list(REQUIRED_KERNELS_BY_TIER.get(tier, ()))
    drafter_target_sha = _read_drafter_target_checkpoint_sha256(
        Path(drafter_file.destination)
    )
    # Drafter↔target alignment (training AGENTS.md §2): the drafter MUST
    # have been distilled against the exact text checkpoint it ships with.
    # Local stand-in drafters have no recorded hash, so this is False here;
    # the real publish gate refuses to ship a drafter where this is not True.
    drafter_matches_target = (
        drafter_target_sha is not None
        and drafter_target_sha == primary_text.sha256
    )
    _json_write(
        bundle_dir / "dflash" / "target-meta.json",
        {
            "schemaVersion": 2,
            "tier": tier,
            "status": "local-standin",
            "publishEligible": False,
            "targetText": {
                "path": str(
                    Path(primary_text.destination).relative_to(bundle_dir)
                ),
                "sha256": primary_text.sha256,
                "provenance": primary_text.provenance,
                "finalElizaWeights": False,
            },
            "targetTextVariants": [
                {
                    "path": str(Path(item.destination).relative_to(bundle_dir)),
                    "sha256": item.sha256,
                    "provenance": item.provenance,
                    "finalElizaWeights": False,
                }
                for item in text_files
            ],
            "drafter": {
                "path": str(
                    Path(drafter_file.destination).relative_to(bundle_dir)
                ),
                "sha256": drafter_file.sha256,
                "provenance": drafter_file.provenance,
                "finalElizaWeights": False,
                # sha256 of the text checkpoint this drafter was distilled
                # against, copied from the drafter GGUF's
                # `dflash-draft.target_checkpoint_sha256` metadata key.
                "targetCheckpointSha256": drafter_target_sha,
                "matchesTargetCheckpoint": drafter_matches_target,
            },
            # Speculative-decode acceptance windows: [draftMin, draftMax]
            # tokens proposed per step plus the measured acceptance rate.
            # Null until a real bundle is published with measured numbers
            # (eval harness → `evals/voice-rtf.json` + this block).
            "acceptanceWindow": None,
            "acceptanceRate": None,
            # Kernel capabilities the runtime must satisfy to load this
            # bundle's DFlash path. Mirrors `eliza-1.manifest.json`
            # `kernels.required` so the dflash binary's CAPABILITIES.json
            # can be checked against the bundle without re-reading the
            # full manifest.
            "kernelCaps": {
                "required": required_kernels,
                "optional": [],
            },
            "publishBlockingReasons": list(reasons),
        },
    )


def _write_eval_files(
    *,
    bundle_dir: Path,
    tier: str,
    generated_at: str,
    smoke_report_path: Path | None,
    smoke: Mapping[str, Any] | None,
    voice_rtf: float,
    reasons: Sequence[str],
) -> dict[str, Any]:
    results = {
        "text_eval": None,
        "voice_rtf": voice_rtf if voice_rtf > 0 else None,
        "asr_wer": None,
        "vad_latency_ms": None,
        "vad_boundary_ms": None,
        "vad_endpoint_ms": None,
        "vad_false_barge_in_rate": None,
        "first_token_latency_ms": None,
        "first_audio_latency_ms": None,
        "barge_in_cancel_ms": None,
        "thirty_turn_ok": False,
        "e2e_loop_ok": False,
        "dflash_acceptance": None,
        "expressive_tag_faithfulness": None,
        "expressive_mos": None,
        "expressive_tag_leakage": None,
        "mobile_peak_rss_mb": None,
        "mobile_thermal_ok": None,
    }
    aggregate = {
        "schemaVersion": 1,
        "tier": tier,
        "generatedAt": generated_at,
        "status": "local-standin",
        "publishEligible": False,
        "results": results,
        "sourceReports": [
            str(smoke_report_path) if smoke_report_path is not None else None
        ],
        "publishBlockingReasons": list(reasons),
    }
    _json_write(bundle_dir / "evals" / "aggregate.json", aggregate)

    gate_report = apply_gates(aggregate)
    _json_write(
        bundle_dir / "evals" / "local_staging_validation.json",
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "status": "fail",
            "publishEligible": False,
            "gateReport": gate_report.to_dict(),
            "publishBlockingReasons": list(reasons),
        },
    )
    _json_write(
        bundle_dir / "evals" / "text-eval.json",
        {
            "schemaVersion": 1,
            "status": "not-run",
            "score": 0.0,
            "passed": False,
            "reason": "local stand-in text artifact has no held-out quantized text eval",
        },
    )
    _json_write(
        bundle_dir / "evals" / "voice-rtf.json",
        {
            "schemaVersion": 1,
            "status": "fail" if voice_rtf > 0 else "not-run",
            "rtf": voice_rtf,
            "passed": False,
            "sourceResult": _source_result(smoke),
            "sourceReport": (
                str(smoke_report_path) if smoke_report_path is not None else None
            ),
        },
    )
    _json_write(
        bundle_dir / "evals" / "e2e-loop.json",
        {
            "schemaVersion": 1,
            "status": "fail",
            "e2eLoopOk": False,
            "thirtyTurnOk": False,
            "passed": False,
            "sourceResult": _source_result(smoke),
            "publishBlockingReasons": list(reasons),
        },
    )
    return gate_report.to_dict()


def _write_backend_reports(
    *,
    bundle_dir: Path,
    tier: str,
    generated_at: str,
    git_sha: str,
    smoke_report_path: Path | None,
    reasons: Sequence[str],
) -> dict[str, KernelVerification]:
    out: dict[str, KernelVerification] = {}
    supported = set(SUPPORTED_BACKENDS_BY_TIER[tier])
    for backend in ELIZA_1_BACKENDS:
        if backend in supported:
            status = "fail"
            report = (
                "evals/cpu_reference.json"
                if backend == "cpu"
                else f"evals/{backend}_verify.json"
            )
            reason = (
                f"{backend} verification was not recorded as 8/8 PASS for "
                "the staged local stand-in bytes"
            )
        else:
            status = "skipped"
            report = f"not-applicable-for-{tier}"
            reason = f"{backend} is not a supported backend for tier {tier}"
        if backend in supported:
            _json_write(
                bundle_dir / report,
                {
                    "schemaVersion": 1,
                    "backend": backend,
                    "status": status,
                    "atCommit": git_sha,
                    "generatedAt": generated_at,
                    "report": (
                        str(smoke_report_path)
                        if backend == "metal" and smoke_report_path is not None
                        else "not-run"
                    ),
                    "publishEligible": False,
                    "reason": reason,
                    "publishBlockingReasons": list(reasons),
                },
            )
            _json_write(
                bundle_dir / "evals" / f"{backend}_dispatch.json",
                {
                    "schemaVersion": 1,
                    "backend": backend,
                    "status": "fail",
                    "runtimeReady": False,
                    "atCommit": git_sha,
                    "generatedAt": generated_at,
                    "report": "not-run",
                    "publishEligible": False,
                    "reason": reason,
                    "publishBlockingReasons": list(reasons),
                },
            )
        out[backend] = KernelVerification(
            status=status,
            at_commit=git_sha,
            report=report,
        )
    return out


def _write_platform_evidence(
    *,
    bundle_dir: Path,
    generated_at: str,
    git_sha: str,
    smoke_report_path: Path | None,
    smoke: Mapping[str, Any] | None,
    reasons: Sequence[str],
) -> None:
    host = smoke.get("host") if isinstance(smoke, dict) else None
    _json_write(
        bundle_dir / "evidence" / "platform" / "darwin-arm64-metal.json",
        {
            "schemaVersion": 1,
            "target": "darwin-arm64-metal",
            "backend": "metal",
            "status": "fail",
            "device": host if isinstance(host, dict) else "not-recorded",
            "atCommit": git_sha,
            "generatedAt": generated_at,
            "report": str(smoke_report_path) if smoke_report_path else "not-run",
            "voiceAbi": (
                smoke.get("tts", {}).get("ok")
                if isinstance(smoke, dict) and isinstance(smoke.get("tts"), dict)
                else False
            ),
            "publishEligible": False,
            "reason": "local smoke evidence is partial and is not release platform evidence",
            "publishBlockingReasons": list(reasons),
        },
    )


def _write_quantization_sidecars(
    *,
    bundle_dir: Path,
    tier: str,
    generated_at: str,
    reasons: Sequence[str],
) -> list[str]:
    specs = (
        ("turboquant.json", "turboquant"),
        ("fused_turboquant.json", "fused-turboquant"),
        ("qjl_config.json", "qjl"),
        ("polarquant_config.json", "polarquant"),
    )
    written: list[str] = []
    for filename, method in specs:
        rel = Path("quantization") / filename
        _json_write(
            bundle_dir / rel,
            {
                "schemaVersion": 1,
                "tier": tier,
                "method": method,
                "status": "local-standin",
                "publishEligible": False,
                "generatedAt": generated_at,
                "kernel_manifest": kernel_manifest_fragment(method),
                "runtimeContract": {
                    "required": True,
                    "skipPolicy": "hard-error",
                    "finalElizaWeights": False,
                },
                "publishBlockingReasons": list(reasons),
            },
        )
        written.append(str(rel))
    return written


def _collect_files(bundle_dir: Path) -> dict[str, list[FileEntry]]:
    def entries(subdir: str, *, text: bool = False) -> list[FileEntry]:
        root = bundle_dir / subdir
        if not root.is_dir():
            return []
        out: list[FileEntry] = []
        for path in sorted(p for p in root.iterdir() if p.is_file()):
            out.append(
                FileEntry(
                    path=str(path.relative_to(bundle_dir)),
                    sha256=sha256_file(path),
                    ctx=parse_text_ctx_from_filename(path) if text else None,
                )
            )
        return out

    return {
        "text": entries("text", text=True),
        "voice": entries("tts"),
        "asr": entries("asr"),
        "vision": entries("vision"),
        "dflash": entries("dflash"),
        "cache": entries("cache"),
        "vad": entries("vad"),
    }


def _read_lineage(bundle_dir: Path) -> dict[str, LineageEntry]:
    path = bundle_dir / "lineage.json"
    data: dict[str, Any] = {}
    if path.is_file():
        data = json.loads(path.read_text())
    out: dict[str, LineageEntry] = {}
    for slot, spec in data.items():
        if isinstance(spec, dict):
            out[slot] = LineageEntry(
                base=str(spec.get("base") or ""),
                license=str(spec.get("license") or ""),
            )
    return out


def _write_lineage(
    *,
    bundle_dir: Path,
    text_file: StagedFile,
    drafter_file: StagedFile,
    vision_file: StagedFile | None = None,
) -> dict[str, LineageEntry]:
    existing = {
        slot: asdict(entry)
        for slot, entry in _read_lineage(bundle_dir).items()
    }
    existing.update(
        {
            "text": {
                "base": (
                    f"local-standin:{text_file.source}"
                    f"@sha256:{text_file.sha256}"
                ),
                "license": "local stand-in; release license not attested",
            },
            "drafter": {
                "base": (
                    f"local-standin:{drafter_file.source}"
                    f"@sha256:{drafter_file.sha256}"
                ),
                "license": "local stand-in; release license not attested",
            },
        }
    )
    if vision_file is not None:
        existing["vision"] = {
            "base": (
                f"local-standin:{vision_file.source}"
                f"@sha256:{vision_file.sha256}"
            ),
            "license": "local stand-in; release license not attested",
        }
    _json_write(bundle_dir / "lineage.json", existing)
    return _read_lineage(bundle_dir)


def _load_source_models(path: Path | None) -> dict[str, dict[str, Any]] | None:
    """Load a `{slot: {repo, file?, convertedVia?, note?}}` JSON file.

    Used by `--release-state base-v1` to record where each upstream
    component comes from (the "base, not fine-tuned" provenance). Unknown
    slots / non-string repos are passed straight through to the manifest
    validator, which rejects them with a precise message.
    """
    if path is None:
        return None
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"--source-models must be a JSON object: {path}")
    return {str(k): dict(v) for k, v in data.items() if isinstance(v, dict)}


def _provenance_for(
    *, release_state: str | None, source_models: Mapping[str, Any] | None
) -> dict[str, Any] | None:
    """Build the manifest `provenance` block for a non-default release shape.

    `base-v1`  → finetuned=false (the upstream base model, GGUF + fully
                 optimized, NOT fine-tuned).
    `finetuned-v2` → finetuned=true.
    Anything else (incl. the default `local-standin` staging) → None.
    """
    if release_state not in {"base-v1", "finetuned-v2"}:
        return None
    return {
        "releaseState": release_state,
        "finetuned": release_state == "finetuned-v2",
        "sourceModels": dict(source_models) if source_models else {},
    }


def _manifest_for_local_bundle(
    *,
    bundle_dir: Path,
    tier: str,
    version: str,
    generated_at: str,
    lineage: Mapping[str, LineageEntry],
    files: Mapping[str, Sequence[FileEntry]],
    backends: Mapping[str, KernelVerification],
    voice_rtf: float,
    provenance: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    ram_min, ram_rec = DEFAULT_RAM_BUDGET_MB[tier]
    return build_manifest(
        tier=tier,
        version=version,
        published_at=generated_at,
        lineage=lineage,
        files=files,
        kernels_required=REQUIRED_KERNELS_BY_TIER[tier],
        kernels_optional=[],
        verified_backends=backends,
        text_eval_score=0.0,
        text_eval_passed=False,
        voice_rtf=voice_rtf,
        voice_rtf_passed=False,
        e2e_loop_ok=False,
        thirty_turn_ok=False,
        ram_budget_min_mb=ram_min,
        ram_budget_recommended_mb=ram_rec,
        default_eligible=False,
        asr_wer=1.0 if files.get("asr") else None,
        asr_wer_passed=False if files.get("asr") else None,
        vad_latency_ms_median=0.0 if files.get("vad") else None,
        vad_latency_ms_passed=False if files.get("vad") else None,
        vad_boundary_ms=0.0 if files.get("vad") else None,
        vad_endpoint_ms=0.0 if files.get("vad") else None,
        vad_false_barge_in_rate=1.0 if files.get("vad") else None,
        expressive_tag_faithfulness=0.0,
        expressive_mos=0.0,
        expressive_tag_leakage=1.0,
        expressive_passed=False,
        voice_capabilities=DEFAULT_VOICE_CAPABILITIES,
        voice_version=ELIZA_1_VOICE_MANIFEST_VERSION,
        voice_frozen=True,
        voice_cache_speaker_preset=VOICE_PRESET_CACHE_PATH,
        voice_cache_phrase_seed=VOICE_PRESET_CACHE_PATH,
        kernel_manifest_fragments=[
            kernel_manifest_fragment(method)
            for method in ("turboquant", "fused-turboquant", "qjl", "polarquant")
        ],
        provenance=provenance,
        require_publish_ready=False,
    )


def _render_readme(
    *,
    bundle_dir: Path,
    tier: str,
    reasons: Sequence[str],
) -> None:
    lines = [
        f"# eliza-1-{tier}",
        "",
        "Local staging bundle. This directory has the release layout shape, "
        "but it is not publish eligible.",
        "",
        "Publish blockers:",
        *(f"- {reason}" for reason in reasons),
        "",
        "See `evidence/release.json` and `evals/local_staging_validation.json`.",
        "",
    ]
    _text_write(bundle_dir / "README.md", "\n".join(lines))


def _all_checksum_inputs(bundle_dir: Path) -> list[Path]:
    out: list[Path] = []
    for path in sorted(bundle_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(bundle_dir)
        if rel == CHECKSUM_PATH:
            continue
        if any(part.startswith(".") for part in rel.parts):
            continue
        out.append(path)
    return out


def write_checksum_manifest(bundle_dir: Path) -> Path:
    checksum_path = bundle_dir / CHECKSUM_PATH
    checksum_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"{sha256_file(path)}  {path.relative_to(bundle_dir)}"
        for path in _all_checksum_inputs(bundle_dir)
    ]
    checksum_path.write_text("\n".join(lines) + "\n")
    return checksum_path


def validate_checksum_manifest(bundle_dir: Path) -> tuple[str, ...]:
    checksum_path = bundle_dir / CHECKSUM_PATH
    if not checksum_path.is_file():
        return (f"missing {CHECKSUM_PATH}",)
    recorded: dict[str, str] = {}
    errors: list[str] = []
    for line_no, raw in enumerate(checksum_path.read_text().splitlines(), start=1):
        if not raw.strip():
            continue
        parts = raw.split(None, 1)
        if len(parts) != 2:
            errors.append(f"{CHECKSUM_PATH}:{line_no}: expected '<sha>  <path>'")
            continue
        sha, rel = parts[0], parts[1].strip()
        recorded[rel] = sha
    expected = [str(p.relative_to(bundle_dir)) for p in _all_checksum_inputs(bundle_dir)]
    for rel in expected:
        if rel not in recorded:
            errors.append(f"{CHECKSUM_PATH}: missing {rel}")
            continue
        actual = sha256_file(bundle_dir / rel)
        if recorded[rel] != actual:
            errors.append(f"{CHECKSUM_PATH}: checksum mismatch for {rel}")
    return tuple(errors)


def _write_release_evidence(
    *,
    bundle_dir: Path,
    tier: str,
    generated_at: str,
    staged: Sequence[StagedFile],
    reasons: Sequence[str],
    provenance: Mapping[str, Any] | None = None,
) -> None:
    def rels(subdir: str) -> list[str]:
        root = bundle_dir / subdir
        if not root.is_dir():
            return []
        return sorted(str(p.relative_to(bundle_dir)) for p in root.iterdir() if p.is_file())

    license_files = [
        "licenses/LICENSE.text",
        "licenses/LICENSE.voice",
        "licenses/LICENSE.dflash",
        "licenses/LICENSE.eliza-1",
        "licenses/LICENSE.asr",
        "licenses/LICENSE.vad",
    ]
    if tier in VISION_TIERS:
        license_files.append("licenses/LICENSE.vision")

    # When a non-default release shape (base-v1 / finetuned-v2) is requested,
    # record it in the evidence — but this staging helper still produces a
    # NON-PUBLISHABLE bundle (stand-in bytes, no eval/kernel evidence), so
    # `publishEligible` and all the `final.*` (except `hashes`) stay false and
    # the `publishBlockingReasons` are kept. A real `base-v1` publish requires
    # the runbook in RELEASE_V1.md (real fork-built GGUFs, real quant sidecars,
    # real evals, real platform evidence) — only then do the `final.*` flags
    # flip true and `evidence/release.json` becomes `publishEligible: true`.
    release_state = "local-standin"
    source_models: dict[str, Any] = {}
    finetuned: bool | None = None
    if isinstance(provenance, Mapping) and provenance.get("releaseState") in {
        "base-v1",
        "finetuned-v2",
    }:
        release_state = str(provenance.get("releaseState"))
        source_models = dict(provenance.get("sourceModels") or {})
        finetuned = bool(provenance.get("finetuned"))

    evidence: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "tier": tier,
        "repoId": f"elizaos/eliza-1-{tier}",
        "releaseState": release_state,
        "publishEligible": False,
        "defaultEligible": False,
        "final": {
            "weights": False,
            "hashes": True,
            "evals": False,
            "licenses": False,
            "kernelDispatchReports": False,
            "platformEvidence": False,
            "sizeFirstRepoIds": False,
        },
        "weights": [
            *rels("text"),
            *rels("tts"),
            *rels("asr"),
            *rels("vad"),
            *rels("vision"),
            *rels("dflash"),
        ],
        "standIns": [asdict(item) for item in staged],
        "checksumManifest": str(CHECKSUM_PATH),
        "evalReports": rels("evals"),
        "quantizationSidecars": sorted(
            str(p.relative_to(bundle_dir))
            for p in (bundle_dir / "quantization").glob("*.json")
            if p.is_file()
        ),
        "licenseFiles": license_files,
        "kernelDispatchReports": {
            backend: f"evals/{backend}_dispatch.json"
            for backend in SUPPORTED_BACKENDS_BY_TIER[tier]
        },
        "platformEvidence": {
            "darwin-arm64-metal": "evidence/platform/darwin-arm64-metal.json"
        },
        "hf": {
            "repoId": f"elizaos/eliza-1-{tier}",
            "status": "blocked-local-standin",
        },
        "publishBlockingReasons": list(reasons),
    }
    if release_state in {"base-v1", "finetuned-v2"}:
        evidence["finetuned"] = finetuned
        evidence["sourceModels"] = source_models
        # Even with the requested release state, this is a STAGING bundle,
        # not a built/verified release. Be explicit so nobody mistakes it
        # for a publish candidate.
        evidence["hf"]["status"] = "blocked-staging-bundle-needs-built-bytes"
        evidence["publishBlockingReasons"] = [
            f"release shape `{release_state}` requested, but this is a local "
            "staging bundle: bytes are stand-ins, not fork-built GGUFs / real "
            "quant sidecars; eval and platform evidence are missing. Run the "
            "RELEASE_V1.md runbook to produce a publishable bundle.",
            *reasons,
        ]
    _json_write(bundle_dir / "evidence" / "release.json", evidence)


def _write_bundle_completion_evidence(
    *,
    bundle_dir: Path,
    tier: str,
    generated_at: str,
    staged: Sequence[StagedFile],
    reasons: Sequence[str],
    manifest_local_errors: Sequence[str],
    manifest_publish_errors: Sequence[str],
) -> None:
    _json_write(
        bundle_dir / "evidence" / LOCAL_EVIDENCE_NAME,
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "tier": tier,
            "bundleDir": str(bundle_dir),
            "publishEligible": False,
            "defaultEligible": False,
            "staged": [asdict(item) for item in staged],
            "manifestValidation": {
                "localNonPublishableErrors": list(manifest_local_errors),
                "publishReadyErrors": list(manifest_publish_errors),
            },
            "publishBlockingReasons": list(reasons),
        },
    )


def _write_repo_evidence(
    *,
    tier: str,
    generated_at: str,
    bundle_dir: Path,
    staged: Sequence[StagedFile],
    reasons: Sequence[str],
    manifest_local_errors: Sequence[str],
    manifest_publish_errors: Sequence[str],
    checksum_errors: Sequence[str],
    gate_report: Mapping[str, Any],
) -> Path:
    report_dir = (
        _repo_root()
        / "packages"
        / "inference"
        / "reports"
        / "local-e2e"
        / generated_at[:10]
    )
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / f"eliza-1-{tier}-local-bundle-completion.json"
    _json_write(
        report_path,
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "tier": tier,
            "bundleDir": str(bundle_dir),
            "publishEligible": False,
            "defaultEligible": False,
            "staged": [asdict(item) for item in staged],
            "generatedBundleFiles": sorted(
                str(p.relative_to(bundle_dir))
                for p in bundle_dir.rglob("*")
                if p.is_file()
                and not any(part.startswith(".") for part in p.relative_to(bundle_dir).parts)
            ),
            "manifestValidation": {
                "localNonPublishableOk": not manifest_local_errors,
                "localNonPublishableErrors": list(manifest_local_errors),
                "publishReadyOk": not manifest_publish_errors,
                "publishReadyErrors": list(manifest_publish_errors),
            },
            "checksumValidation": {
                "ok": not checksum_errors,
                "errors": list(checksum_errors),
            },
            "gateReport": gate_report,
            "publishBlockingReasons": list(reasons),
        },
    )
    return report_path


def _git_short_sha() -> str:
    import subprocess

    proc = subprocess.run(
        ["git", "-C", str(_repo_root()), "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    return "unknown"


def stage_local_bundle(args: argparse.Namespace) -> dict[str, Any]:
    tier = args.tier
    bundle_dir = args.bundle_dir.resolve()
    _ensure_release_dirs(bundle_dir)
    generated_at = args.generated_at or _now_iso()
    git_sha = _git_short_sha()
    contexts = (
        CONTEXTS_BY_TIER[tier]
        if getattr(args, "all_contexts", False)
        else (args.context or CONTEXTS_BY_TIER[tier][-1],)
    )

    text_source = _choose_source(
        explicit=args.text_source,
        bundle_dir=bundle_dir,
        source_subdir="text",
        fallback_candidates=DEFAULT_TEXT_STANDIN_CANDIDATES,
        label="text",
    )
    drafter_source = _choose_source(
        explicit=args.drafter_source,
        bundle_dir=bundle_dir,
        source_subdir="dflash",
        fallback_candidates=DEFAULT_DRAFTER_STANDIN_CANDIDATES,
        label="DFlash drafter",
    )
    smoke_report_path = (
        args.local_smoke_report
        if args.local_smoke_report is not None
        else _default_smoke_report()
    )
    smoke = _load_smoke_report(smoke_report_path)
    voice_rtf = _voice_rtf_from_smoke(smoke)
    reasons = _publish_blocking_reasons(tier=tier, smoke=smoke)
    # Optional non-default release shape. `base-v1` = the upstream BASE
    # models, GGUF + fully optimized, NOT fine-tuned (records provenance).
    release_state = getattr(args, "release_state", None)
    source_models = _load_source_models(getattr(args, "source_models", None))
    provenance = _provenance_for(
        release_state=release_state, source_models=source_models
    )

    drafter_dest = bundle_dir / "dflash" / f"drafter-{tier}.gguf"
    text_staged = [
        _stage_file(
            role=f"text:{ctx}",
            source=text_source,
            destination=bundle_dir / text_artifact_name(tier, ctx),
            provenance=(
                "local-source-candidate"
                if _is_under(text_source, bundle_dir / "source")
                else "local-standin"
            ),
            force=args.force,
        )
        for ctx in contexts
    ]
    staged = [
        *text_staged,
        _stage_file(
            role="dflash",
            source=drafter_source,
            destination=drafter_dest,
            provenance=(
                "local-source-candidate"
                if _is_under(drafter_source, bundle_dir / "source")
                else "local-standin"
            ),
            force=args.force,
        ),
    ]
    vision_candidates = _bundle_source_candidates(bundle_dir, "vision")
    if tier in VISION_TIERS and vision_candidates:
        staged.append(
            _stage_file(
                role="vision",
                source=vision_candidates[0],
                destination=bundle_dir / "vision" / f"mmproj-{tier}.gguf",
                provenance="local-source-candidate",
                force=args.force,
            )
        )

    _write_licenses(bundle_dir, tier=tier, force=args.force)
    vision_staged = next((item for item in staged if item.role == "vision"), None)
    lineage = _write_lineage(
        bundle_dir=bundle_dir,
        text_file=text_staged[0],
        drafter_file=staged[len(text_staged)],
        vision_file=vision_staged,
    )
    _write_target_meta(
        bundle_dir=bundle_dir,
        tier=tier,
        text_files=text_staged,
        drafter_file=staged[len(text_staged)],
        reasons=reasons,
    )
    gate_report = _write_eval_files(
        bundle_dir=bundle_dir,
        tier=tier,
        generated_at=generated_at,
        smoke_report_path=smoke_report_path,
        smoke=smoke,
        voice_rtf=voice_rtf,
        reasons=reasons,
    )
    backends = _write_backend_reports(
        bundle_dir=bundle_dir,
        tier=tier,
        generated_at=generated_at,
        git_sha=git_sha,
        smoke_report_path=smoke_report_path,
        reasons=reasons,
    )
    _write_platform_evidence(
        bundle_dir=bundle_dir,
        generated_at=generated_at,
        git_sha=git_sha,
        smoke_report_path=smoke_report_path,
        smoke=smoke,
        reasons=reasons,
    )
    quantization_sidecars = _write_quantization_sidecars(
        bundle_dir=bundle_dir,
        tier=tier,
        generated_at=generated_at,
        reasons=reasons,
    )

    files = _collect_files(bundle_dir)
    manifest = _manifest_for_local_bundle(
        bundle_dir=bundle_dir,
        tier=tier,
        version=args.version,
        generated_at=generated_at,
        lineage=lineage,
        files=files,
        backends=backends,
        voice_rtf=voice_rtf,
        provenance=provenance,
    )
    manifest_path = write_manifest(
        manifest,
        bundle_dir / "eliza-1.manifest.json",
        require_publish_ready=False,
    )
    _render_readme(bundle_dir=bundle_dir, tier=tier, reasons=reasons)
    manifest_local_errors = validate_manifest(
        manifest,
        require_publish_ready=False,
    )
    manifest_publish_errors = validate_manifest(manifest)

    _write_release_evidence(
        bundle_dir=bundle_dir,
        tier=tier,
        generated_at=generated_at,
        staged=staged,
        reasons=reasons,
        provenance=provenance,
    )
    _write_bundle_completion_evidence(
        bundle_dir=bundle_dir,
        tier=tier,
        generated_at=generated_at,
        staged=staged,
        reasons=reasons,
        manifest_local_errors=manifest_local_errors,
        manifest_publish_errors=manifest_publish_errors,
    )
    checksum_path = write_checksum_manifest(bundle_dir)
    checksum_errors = validate_checksum_manifest(bundle_dir)
    repo_evidence = _write_repo_evidence(
        tier=tier,
        generated_at=generated_at,
        bundle_dir=bundle_dir,
        staged=staged,
        reasons=reasons,
        manifest_local_errors=manifest_local_errors,
        manifest_publish_errors=manifest_publish_errors,
        checksum_errors=checksum_errors,
        gate_report=gate_report,
    )

    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "tier": tier,
        "bundleDir": str(bundle_dir),
        "manifest": str(manifest_path),
        "checksums": str(checksum_path),
        "repoEvidence": str(repo_evidence),
        "publishEligible": False,
        "defaultEligible": False,
        "staged": [asdict(item) for item in staged],
        "quantizationSidecars": quantization_sidecars,
        "manifestValidation": {
            "localNonPublishableOk": not manifest_local_errors,
            "localNonPublishableErrors": list(manifest_local_errors),
            "publishReadyOk": not manifest_publish_errors,
            "publishReadyErrors": list(manifest_publish_errors),
        },
        "checksumValidation": {
            "ok": not checksum_errors,
            "errors": list(checksum_errors),
        },
        "publishBlockingReasons": reasons,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", default="2b", choices=tuple(CONTEXTS_BY_TIER))
    ap.add_argument("--bundle-dir", type=Path, default=DEFAULT_BUNDLE_DIR)
    ap.add_argument("--text-source", type=Path, default=None)
    ap.add_argument("--drafter-source", type=Path, default=None)
    ap.add_argument("--context", choices=tuple({c for v in CONTEXTS_BY_TIER.values() for c in v}), default=None)
    ap.add_argument(
        "--all-contexts",
        action="store_true",
        help="Stage every required context variant for the tier using the selected source candidate.",
    )
    ap.add_argument("--version", default="0.0.0-local.1")
    ap.add_argument("--generated-at", default=None)
    ap.add_argument(
        "--release-state",
        default=None,
        choices=("base-v1", "finetuned-v2"),
        help=(
            "Record a non-default release shape in the manifest's `provenance` "
            "block and `evidence/release.json`. `base-v1` = the upstream BASE "
            "models, GGUF + fully optimized, NOT fine-tuned (the v1 product). "
            "Requires --source-models so per-component provenance can be "
            "recorded. NOTE: this staging helper still produces a "
            "NON-PUBLISHABLE bundle (stand-in bytes, no eval/kernel evidence) "
            "— see RELEASE_V1.md for the real publish path."
        ),
    )
    ap.add_argument(
        "--source-models",
        type=Path,
        default=None,
        help=(
            "Path to a JSON `{slot: {repo, file?, convertedVia?, note?}}` map "
            "of upstream component sources. Used with --release-state. The "
            "manifest validator requires coverage for every shipped component "
            "on a base-v1 manifest."
        ),
    )
    ap.add_argument("--local-smoke-report", type=Path, default=None)
    ap.add_argument("--force", action="store_true")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    report = stage_local_bundle(args)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["checksumValidation"]["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
