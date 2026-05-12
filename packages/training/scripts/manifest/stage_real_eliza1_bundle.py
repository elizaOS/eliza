#!/usr/bin/env python3
"""Assemble a real-weights Eliza-1 bundle from staged components.

This is one step further along than ``stage_local_eliza1_bundle.py``: it
takes *real* upstream-derived GGUF text weights (already quantized to the
tier's release quant), real DFlash drafter weights stamped against the
text checkpoint, real quantization-recipe sidecars produced by the
``scripts/quantization/*_apply.py`` recipes, and real voice/ASR/VAD
assets staged from Hugging Face, and produces a bundle directory with the
layout from ``packages/inference/AGENTS.md`` §2.

What it does NOT do — and what keeps the bundle ``publishEligible:false``
until E5's eval harness and the per-backend kernel verification pass:

- It does not run the held-out quantized text eval, voice RTF, ASR WER,
  expressive voice, DFlash acceptance, e2e loop, 30-turn, or mobile RSS
  /thermal evals. Those land in ``evals/`` as ``not-run`` / ``fail``.
- It does not run ``metal_verify`` / ``vulkan_verify`` / the CPU
  reference harness against the staged bytes. Backend reports are
  ``fail``.

It DOES set ``evidence/release.json`` ``final.weights = true`` — the
weights in the bundle are the real release weights (per the
"weights unchanged for now" mandate, the base backbones rebranded
Eliza-1 with lineage recorded in the manifest). The remaining
``final.*`` flags stay false, ``publishEligible`` stays false, and
``releaseState`` is ``weights-staged`` — the publish orchestrator still
refuses to upload until the evals/verification gates are green.
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
    from .eliza1_platform_plan import CONTEXTS_BY_TIER, TEXT_QUANT_BY_TIER, text_artifact_name
    from . import stage_eliza1_bundle_assets as assets_mod
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
    from eliza1_platform_plan import CONTEXTS_BY_TIER, TEXT_QUANT_BY_TIER, text_artifact_name
    import stage_eliza1_bundle_assets as assets_mod

from benchmarks.eliza1_gates import apply_gates

VISION_TIERS: Final[set[str]] = {"9b", "27b", "27b-256k", "27b-1m"}
EMBEDDING_TIERS: Final[set[str]] = {"1_7b", "9b", "27b", "27b-256k", "27b-1m"}

# `(min, recommended)` MB per tier — keep in sync with
# `scripts/publish/orchestrator.py::DEFAULT_RAM_BUDGET_MB`. `0_6b`/`1_7b`
# reflect the 2026-05-11 e2e voice-loop benchmark (fused `llama-server`
# voice-on co-resident footprint: ~3.1 GB / ~4.8 GB server peak RSS).
DEFAULT_RAM_BUDGET_MB: Final[Mapping[str, tuple[int, int]]] = {
    "0_6b": (2500, 3700),
    "1_7b": (4000, 5500),
    "9b": (7000, 9500),
    "27b": (24000, 32000),
    "27b-256k": (48000, 64000),
    "27b-1m": (96000, 128000),
}
DEFAULT_VOICE_CAPABILITIES: Final[tuple[str, ...]] = ("tts", "emotion-tags", "singing")
CHECKSUM_PATH: Final[Path] = Path("checksums/SHA256SUMS")
REQUIRED_RELEASE_DIRS: Final[tuple[str, ...]] = (
    "text", "dflash", "vision", "tts", "asr", "vad", "cache", "evals",
    "checksums", "licenses", "evidence", "quantization", "embedding",
)
# The quantization-recipe sidecars the publish orchestrator requires, mapped
# to the per-recipe output filename inside --recipes-dir/<recipe>/.
RECIPE_SIDECARS: Final[tuple[tuple[str, str, str], ...]] = (
    ("turbo", "turboquant.json", "quantization/turboquant.json"),
    ("fused", "fused_turboquant.json", "quantization/fused_turboquant.json"),
    ("qjl", "qjl_config.json", "quantization/qjl_config.json"),
    ("polar", "polarquant_config.json", "quantization/polarquant_config.json"),
)
POLAR_ARTIFACTS_NAME: Final[str] = "polarquant_artifacts.safetensors"

_GGUF_DRAFTER_TARGET_CHECKPOINT_KEY: Final[str] = "dflash-draft.target_checkpoint_sha256"


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


def _git_short_sha() -> str:
    import subprocess

    proc = subprocess.run(
        ["git", "-C", str(_repo_root()), "rev-parse", "--short", "HEAD"],
        capture_output=True, text=True, check=False,
    )
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else "unknown"


def _json_write(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def _text_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _ensure_release_dirs(bundle_dir: Path, *, tier: str) -> None:
    for rel in REQUIRED_RELEASE_DIRS:
        if rel == "vision" and tier not in VISION_TIERS:
            continue
        if rel == "embedding" and tier not in EMBEDDING_TIERS:
            continue
        (bundle_dir / rel).mkdir(parents=True, exist_ok=True)


def _link_or_copy(source: Path, destination: Path) -> str:
    try:
        os.link(source, destination)
        return "hardlink"
    except OSError:
        shutil.copy2(source, destination)
        return "copy"


def _stage_file(*, role: str, source: Path, destination: Path, provenance: str, force: bool) -> StagedFile:
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
                f"{destination} exists with sha256 {dest_sha}; expected {source_sha}. Re-run with --force."
            )
    else:
        method = _link_or_copy(source, destination)
    return StagedFile(
        role=role, source=str(source), destination=str(destination),
        sha256=source_sha, sizeBytes=destination.stat().st_size, method=method, provenance=provenance,
    )


def _read_drafter_target_checkpoint_sha256(drafter_path: Path) -> str | None:
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


def _publish_blocking_reasons(*, tier: str, text_substituted: bool, drafter_stamp_only: bool) -> list[str]:
    reasons: list[str] = []
    if text_substituted:
        reasons.append(
            f"text backbone for {tier} is the closest publicly-available Qwen3 base (Qwen3.5/3.6 not "
            "publicly resolvable); the substitution is recorded in the manifest lineage block"
        )
    if drafter_stamp_only:
        reasons.append(
            f"DFlash drafter for {tier} is stamped against the text-checkpoint sha256 but not yet "
            "re-distilled to the rebranded text weights; acceptance-rate eval is pending"
        )
    reasons.extend([
        "required text quality, ASR WER, VAD latency, expressive voice, DFlash acceptance, first-token, "
        "first-audio, barge-in, 30-turn, mobile RSS, and thermal evals are not yet run for these bytes",
        "required Metal, Vulkan, and CPU backend verification has not been run against the staged bytes",
        "release evidence is weights-staged, not an upload candidate; the publish orchestrator will not upload",
    ])
    return reasons


def _write_licenses(bundle_dir: Path, *, tier: str, text_lineage_repo: str, force: bool) -> None:
    texts = {
        "LICENSE.text": (
            "Eliza-1 text backbone license notice.\n\n"
            f"The text weights in this bundle are derived from {text_lineage_repo} (Apache-2.0), "
            "rebranded Eliza-1 in user-facing strings per the project's branding policy. The upstream "
            "lineage and Apache-2.0 license terms are recorded in eliza-1.manifest.json's lineage.text block.\n\n"
            "Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0\n"
        ),
        "LICENSE.dflash": (
            "Eliza-1 DFlash drafter license notice.\n\n"
            "The DFlash speculative-decoding drafter is a small student model aligned to the Eliza-1 text "
            "checkpoint (sha256 recorded in dflash/target-meta.json). It inherits the text backbone's "
            "Apache-2.0 lineage. The DFlash method itself is open research (see packages/inference/AGENTS.md §3).\n\n"
            "Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0\n"
        ),
        "LICENSE.eliza-1": (
            "Eliza-1 bundle license notice.\n\n"
            "Eliza-1 is a non-commercial open-source on-device model line. This bundle is composed of "
            "components under permissive (Apache-2.0 / MIT) and CC-compatible terms; see the per-component "
            "LICENSE.* files and the manifest lineage block for the full breakdown. If the project pivots "
            "to commercial licensing, the CC-BY-NC-SA voice training-data lineage must be re-evaluated.\n"
        ),
    }
    if tier in VISION_TIERS:
        texts["LICENSE.vision"] = (
            "Eliza-1 vision (mmproj) license notice.\n\n"
            "The multimodal projector weights are derived from the text backbone's vision tower "
            f"({text_lineage_repo}-family, Apache-2.0). Lineage recorded in eliza-1.manifest.json.\n"
        )
    if tier in EMBEDDING_TIERS:
        texts["LICENSE.embedding"] = (
            "Eliza-1 embedding model license notice.\n\n"
            "The text-embedding artifact is Qwen3-Embedding-0.6B (Apache-2.0, 1024-dim Matryoshka, 32k ctx). "
            "Lineage recorded in eliza-1.manifest.json's lineage.embedding block.\n\n"
            "Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0\n"
        )
    for name, text in texts.items():
        path = bundle_dir / "licenses" / name
        if path.exists() and not force:
            continue
        _text_write(path, text)


def _stage_recipe_sidecars(bundle_dir: Path, recipes_dir: Path, *, force: bool) -> list[StagedFile]:
    out: list[StagedFile] = []
    for sub, fname, rel in RECIPE_SIDECARS:
        src = recipes_dir / sub / fname
        if not src.is_file():
            raise FileNotFoundError(f"recipe sidecar missing: {src}")
        dest = bundle_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        out.append(StagedFile(
            role=f"quantization:{sub}", source=str(src), destination=str(dest),
            sha256=sha256_file(dest), sizeBytes=dest.stat().st_size, method="copy",
            provenance=f"recipe-output:{sub}",
        ))
    # PolarQuant codes artifact (the INT4-kernel payload) is a real recipe
    # output but NOT a manifest-required file and can be multi-GB; the
    # polarquant_config.json sidecar records its provenance. Record its
    # sha256 in the bundle's quantization/polarquant_artifacts.json metadata
    # so a downstream INT4 pipeline can fetch it, without shipping the bytes.
    polar_art = recipes_dir / "polar" / POLAR_ARTIFACTS_NAME
    if polar_art.is_file():
        meta_dest = bundle_dir / "quantization" / "polarquant_artifacts.json"
        _json_write(meta_dest, {
            "schemaVersion": 1,
            "artifact": POLAR_ARTIFACTS_NAME,
            "sha256": sha256_file(polar_art),
            "sizeBytes": polar_art.stat().st_size,
            "note": ("PolarQuant int8-codes + fp16-norms safetensors produced by "
                     "polarquant_apply.py; not shipped in the bundle (size); the "
                     "downstream INT4 inference path materializes it from the "
                     "training rig or a separate artifact repo."),
        })
        out.append(StagedFile(
            role="quantization:polar-artifacts-meta", source=str(polar_art), destination=str(meta_dest),
            sha256=sha256_file(meta_dest), sizeBytes=meta_dest.stat().st_size, method="metadata-only",
            provenance="recipe-output:polar",
        ))
    return out


def _write_target_meta(*, bundle_dir: Path, tier: str, text_files: Sequence[StagedFile],
                       drafter_file: StagedFile, reasons: Sequence[str]) -> None:
    primary_text = text_files[0]
    required_kernels = list(REQUIRED_KERNELS_BY_TIER.get(tier, ()))
    drafter_target_sha = _read_drafter_target_checkpoint_sha256(Path(drafter_file.destination))
    drafter_matches = drafter_target_sha is not None and drafter_target_sha == primary_text.sha256
    _json_write(bundle_dir / "dflash" / "target-meta.json", {
        "schemaVersion": 2,
        "tier": tier,
        "status": "weights-staged",
        "publishEligible": False,
        "targetText": {
            "path": str(Path(primary_text.destination).relative_to(bundle_dir)),
            "sha256": primary_text.sha256,
            "provenance": primary_text.provenance,
            "finalElizaWeights": True,
        },
        "targetTextVariants": [
            {"path": str(Path(it.destination).relative_to(bundle_dir)), "sha256": it.sha256,
             "provenance": it.provenance, "finalElizaWeights": True}
            for it in text_files
        ],
        "drafter": {
            "path": str(Path(drafter_file.destination).relative_to(bundle_dir)),
            "sha256": drafter_file.sha256,
            "provenance": drafter_file.provenance,
            "finalElizaWeights": True,
            "targetCheckpointSha256": drafter_target_sha,
            "matchesTargetCheckpoint": drafter_matches,
        },
        "acceptanceWindow": None,
        "acceptanceRate": None,
        "kernelCaps": {"required": required_kernels, "optional": []},
        "publishBlockingReasons": list(reasons),
    })


def _write_eval_files(*, bundle_dir: Path, tier: str, generated_at: str, reasons: Sequence[str],
                      has_asr: bool, has_vad: bool, has_embedding: bool) -> dict[str, Any]:
    results = {
        "text_eval": None, "voice_rtf": None, "asr_wer": None, "vad_latency_ms": None,
        "vad_boundary_ms": None, "vad_endpoint_ms": None,
        "vad_false_barge_in_rate": None,
        "first_token_latency_ms": None, "first_audio_latency_ms": None, "barge_in_cancel_ms": None,
        "thirty_turn_ok": False, "e2e_loop_ok": False, "dflash_acceptance": None,
        "expressive_tag_faithfulness": None, "expressive_mos": None, "expressive_tag_leakage": None,
        "mobile_peak_rss_mb": None, "mobile_thermal_ok": None, "embed_mteb": None,
    }
    aggregate = {
        "schemaVersion": 1, "tier": tier, "generatedAt": generated_at,
        "status": "weights-staged", "publishEligible": False, "results": results,
        "sourceReports": [], "publishBlockingReasons": list(reasons),
    }
    _json_write(bundle_dir / "evals" / "aggregate.json", aggregate)
    gate_report = apply_gates(aggregate)
    _json_write(bundle_dir / "evals" / "local_staging_validation.json", {
        "schemaVersion": 1, "generatedAt": generated_at, "status": "fail",
        "publishEligible": False, "gateReport": gate_report.to_dict(),
        "publishBlockingReasons": list(reasons),
    })
    _json_write(bundle_dir / "evals" / "text-eval.json", {
        "schemaVersion": 1, "status": "not-run", "score": 0.0, "passed": False,
        "reason": "held-out quantized text eval not yet run for these bytes",
    })
    _json_write(bundle_dir / "evals" / "voice-rtf.json", {
        "schemaVersion": 1, "status": "not-run", "rtf": 0.0, "passed": False,
        "reason": "voice RTF eval not yet run for these bytes",
    })
    _json_write(bundle_dir / "evals" / "e2e-loop.json", {
        "schemaVersion": 1, "status": "not-run", "e2eLoopOk": False, "thirtyTurnOk": False,
        "passed": False, "publishBlockingReasons": list(reasons),
    })
    return gate_report.to_dict()


def _write_backend_reports(*, bundle_dir: Path, tier: str, generated_at: str, git_sha: str,
                           reasons: Sequence[str]) -> dict[str, KernelVerification]:
    out: dict[str, KernelVerification] = {}
    supported = set(SUPPORTED_BACKENDS_BY_TIER[tier])
    for backend in ELIZA_1_BACKENDS:
        if backend in supported:
            report = "evals/cpu_reference.json" if backend == "cpu" else f"evals/{backend}_verify.json"
            reason = f"{backend} verification not yet run against the staged Eliza-1 {tier} bytes"
            _json_write(bundle_dir / report, {
                "schemaVersion": 1, "backend": backend, "status": "fail", "atCommit": git_sha,
                "generatedAt": generated_at, "report": "not-run", "publishEligible": False,
                "reason": reason, "publishBlockingReasons": list(reasons),
            })
            _json_write(bundle_dir / "evals" / f"{backend}_dispatch.json", {
                "schemaVersion": 1, "backend": backend, "status": "fail", "runtimeReady": False,
                "atCommit": git_sha, "generatedAt": generated_at, "report": "not-run",
                "publishEligible": False, "reason": reason, "publishBlockingReasons": list(reasons),
            })
            out[backend] = KernelVerification(status="fail", at_commit=git_sha, report=report)
        else:
            out[backend] = KernelVerification(status="skipped", at_commit=git_sha,
                                              report=f"not-applicable-for-{tier}")
    return out


def _write_platform_evidence(*, bundle_dir: Path, generated_at: str, git_sha: str,
                             reasons: Sequence[str]) -> None:
    _json_write(bundle_dir / "evidence" / "platform" / "linux-x64-cpu.json", {
        "schemaVersion": 1, "target": "linux-x64-cpu", "backend": "cpu", "status": "fail",
        "device": "this-machine: 24-core x86, CPU-only", "atCommit": git_sha,
        "generatedAt": generated_at, "report": "not-run", "publishEligible": False,
        "reason": "no on-device verify-on-load pass has been run for these bytes",
        "publishBlockingReasons": list(reasons),
    })


def _collect_files(bundle_dir: Path, *, tier: str) -> dict[str, list[FileEntry]]:
    def entries(subdir: str, *, text: bool = False) -> list[FileEntry]:
        root = bundle_dir / subdir
        if not root.is_dir():
            return []
        out: list[FileEntry] = []
        for path in sorted(p for p in root.iterdir() if p.is_file()):
            out.append(FileEntry(
                path=str(path.relative_to(bundle_dir)),
                sha256=sha256_file(path),
                ctx=parse_text_ctx_from_filename(path) if text else None,
            ))
        return out

    files = {
        "text": entries("text", text=True),
        "voice": entries("tts"),
        "asr": entries("asr"),
        "vision": entries("vision"),
        "dflash": entries("dflash"),
        "cache": entries("cache"),
        "vad": entries("vad"),
    }
    if tier in EMBEDDING_TIERS:
        files["embedding"] = entries("embedding")
    return files


_LINEAGE_SLOT_DIR: Final[Mapping[str, str]] = {
    "voice": "tts", "asr": "asr", "vad": "vad", "wakeword": "wakeword",
    "vision": "vision", "embedding": "embedding",
}


def _write_lineage(*, bundle_dir: Path, tier: str, text_repo: str, text_rev: str, text_note: str,
                   drafter_target_sha: str | None, drafter_stamp_only: bool,
                   has_embedding: bool, has_vision: bool) -> dict[str, LineageEntry]:
    path = bundle_dir / "lineage.json"
    data: dict[str, Any] = {}
    if path.is_file():
        data = json.loads(path.read_text())
    # Drop optional-component lineage entries whose files aren't actually in
    # the bundle (the asset stager always writes a wakeword lineage entry even
    # when --skip-wakeword is set; the manifest validator rejects that).
    for slot, subdir in _LINEAGE_SLOT_DIR.items():
        d = bundle_dir / subdir
        if slot in data and (not d.is_dir() or not any(p.is_file() for p in d.iterdir())):
            data.pop(slot, None)
    text_base = f"{text_repo}@{text_rev}"
    text_license = "apache-2.0"
    data["text"] = {
        "base": text_base,
        "license": text_license,
        # Wave-6 manifest only validates base+license; the note is preserved
        # in the bundle's lineage.json for provenance.
        "note": text_note,
    }
    data["drafter"] = {
        "base": (
            f"dflash-{tier}-drafter (stamped against text checkpoint sha256={drafter_target_sha})"
            if drafter_stamp_only else f"dflash-{tier}-drafter (distilled against {text_base})"
        ),
        "license": "apache-2.0",
    }
    if has_vision and "vision" not in data:
        data["vision"] = {"base": f"{text_repo}-vision-tower@{text_rev}", "license": "apache-2.0"}
    if has_embedding:
        data["embedding"] = {"base": "Qwen/Qwen3-Embedding-0.6B", "license": "apache-2.0"}
    _json_write(path, data)
    out: dict[str, LineageEntry] = {}
    for slot, spec in data.items():
        if isinstance(spec, dict):
            out[slot] = LineageEntry(base=str(spec.get("base") or ""), license=str(spec.get("license") or ""))
    return out


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
    lines = [f"{sha256_file(p)}  {p.relative_to(bundle_dir)}" for p in _all_checksum_inputs(bundle_dir)]
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
        recorded[parts[1].strip()] = parts[0]
    for rel in [str(p.relative_to(bundle_dir)) for p in _all_checksum_inputs(bundle_dir)]:
        if rel not in recorded:
            errors.append(f"{CHECKSUM_PATH}: missing {rel}")
            continue
        if recorded[rel] != sha256_file(bundle_dir / rel):
            errors.append(f"{CHECKSUM_PATH}: checksum mismatch for {rel}")
    return tuple(errors)


def _write_release_evidence(*, bundle_dir: Path, tier: str, generated_at: str,
                            staged: Sequence[StagedFile], reasons: Sequence[str]) -> None:
    def rels(subdir: str) -> list[str]:
        root = bundle_dir / subdir
        if not root.is_dir():
            return []
        return sorted(str(p.relative_to(bundle_dir)) for p in root.iterdir() if p.is_file())

    license_files = [
        "licenses/LICENSE.text", "licenses/LICENSE.voice", "licenses/LICENSE.dflash",
        "licenses/LICENSE.eliza-1", "licenses/LICENSE.asr", "licenses/LICENSE.vad",
    ]
    if tier in VISION_TIERS:
        license_files.append("licenses/LICENSE.vision")
    if tier in EMBEDDING_TIERS:
        license_files.append("licenses/LICENSE.embedding")
    _json_write(bundle_dir / "evidence" / "release.json", {
        "schemaVersion": 1, "generatedAt": generated_at, "tier": tier,
        "repoId": f"elizaos/eliza-1-{tier}", "releaseState": "weights-staged",
        "publishEligible": False, "defaultEligible": False,
        "final": {
            "weights": True,             # the real release weights are in the bundle
            "hashes": True,              # checksums/SHA256SUMS covers every byte
            "evals": False,              # E5's eval harness still owes its JSONs
            "licenses": False,           # release-reviewed license attestations pending
            "kernelDispatchReports": False,
            "platformEvidence": False,
            "sizeFirstRepoIds": False,
        },
        "weights": [*rels("text"), *rels("tts"), *rels("asr"), *rels("vad"),
                    *rels("vision"), *rels("embedding"), *rels("dflash")],
        "stagedFiles": [asdict(it) for it in staged],
        "checksumManifest": str(CHECKSUM_PATH),
        "evalReports": rels("evals"),
        "quantizationSidecars": sorted(str(p.relative_to(bundle_dir))
                                       for p in (bundle_dir / "quantization").glob("*")
                                       if p.is_file()),
        "licenseFiles": license_files,
        "kernelDispatchReports": {b: f"evals/{b}_dispatch.json" for b in SUPPORTED_BACKENDS_BY_TIER[tier]},
        "platformEvidence": {"linux-x64-cpu": "evidence/platform/linux-x64-cpu.json"},
        "hf": {"repoId": f"elizaos/eliza-1-{tier}", "status": "blocked-weights-staged"},
        "publishBlockingReasons": list(reasons),
    })


def _render_readme(*, bundle_dir: Path, tier: str, reasons: Sequence[str], text_repo: str) -> None:
    lines = [
        f"# eliza-1-{tier}", "",
        "Staged Eliza-1 bundle with **real release weights** in the layout from "
        "packages/inference/AGENTS.md §2. Not yet publish-eligible: the eval harness and "
        "per-backend kernel verification are pending.", "",
        f"Text backbone lineage: `{text_repo}` (Apache-2.0), rebranded Eliza-1 in user-facing strings; "
        "see `eliza-1.manifest.json` lineage block.", "",
        "Publish blockers:",
        *(f"- {r}" for r in reasons), "",
        "See `evidence/release.json` and `evals/local_staging_validation.json`.", "",
    ]
    _text_write(bundle_dir / "README.md", "\n".join(lines))


def stage_real_bundle(args: argparse.Namespace) -> dict[str, Any]:
    tier = args.tier
    bundle_dir = args.bundle_dir.resolve()
    recipes_dir = args.recipes_dir.resolve()
    text_gguf = args.text_gguf.resolve()
    drafter_gguf = args.drafter_gguf.resolve()
    generated_at = args.generated_at or _now_iso()
    git_sha = _git_short_sha()
    _ensure_release_dirs(bundle_dir, tier=tier)
    contexts = CONTEXTS_BY_TIER[tier]

    # 1. Stage real voice/ASR/VAD assets from HF (writes lineage.json, licenses, cache preset).
    # Always copy (not hardlink): the HF hub cache stores files as relative
    # symlinks into blobs/, and os.link() of a symlink links the symlink
    # itself, producing a broken relative symlink outside the cache dir.
    if not args.skip_assets:
        assets_args = argparse.Namespace(
            tier=tier, bundle_dir=bundle_dir, dry_run=False, link_mode="copy",
            asr_repo=None, asr_file=None, asr_mmproj_file=None, upload_repo=None,
            upload_prefix="", public=False,
            # openWakeWord is opt-in / hide-not-disable; skipping it keeps the
            # bundle smaller and the voice pipeline still works (VAD-gated /
            # push-to-talk). E3/E5 can add it later if a tier needs it.
            skip_wakeword=getattr(args, "skip_wakeword", True),
            include_vad_onnx_fallback=getattr(
                args, "include_vad_onnx_fallback", False
            ),
        )
        assets_mod.stage_assets(assets_args)

    # 2. Stage embedding (non-0_6b) — Qwen3-Embedding-0.6B GGUF.
    has_embedding = tier in EMBEDDING_TIERS
    if has_embedding and not args.skip_assets:
        try:
            from huggingface_hub import HfApi, hf_hub_download
            api = HfApi()
            rev = str(api.model_info("Qwen/Qwen3-Embedding-0.6B-GGUF").sha)
            cached = Path(hf_hub_download(repo_id="Qwen/Qwen3-Embedding-0.6B-GGUF",
                                          filename="Qwen3-Embedding-0.6B-Q8_0.gguf", revision=rev,
                                          repo_type="model"))
            dest = bundle_dir / "embedding" / "eliza-1-embedding.gguf"
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                dest.unlink()
            shutil.copy2(cached, dest)
        except Exception as exc:  # pragma: no cover - network path
            raise SystemExit(f"failed to stage embedding GGUF for {tier}: {exc}") from exc

    text_substituted = bool(args.text_substituted)
    drafter_stamp_only = bool(args.drafter_stamp_only)
    reasons = _publish_blocking_reasons(tier=tier, text_substituted=text_substituted,
                                        drafter_stamp_only=drafter_stamp_only)

    # 3. Text GGUFs — one per context variant (same source bytes; runtime caps ctx at activation).
    text_staged = [
        _stage_file(role=f"text:{ctx}", source=text_gguf,
                    destination=bundle_dir / text_artifact_name(tier, ctx),
                    provenance=f"eliza-1-text:{TEXT_QUANT_BY_TIER[tier]}", force=args.force)
        for ctx in contexts
    ]
    # 4. Drafter GGUF.
    drafter_staged = _stage_file(role="dflash", source=drafter_gguf,
                                 destination=bundle_dir / "dflash" / f"drafter-{tier}.gguf",
                                 provenance=("dflash-drafter:stamp-only" if drafter_stamp_only
                                             else "dflash-drafter:distilled"), force=args.force)
    # 5. Vision (mmproj) for vision tiers.
    vision_staged: StagedFile | None = None
    if tier in VISION_TIERS and args.vision_gguf is not None:
        vision_staged = _stage_file(role="vision", source=args.vision_gguf.resolve(),
                                    destination=bundle_dir / "vision" / f"mmproj-{tier}.gguf",
                                    provenance="eliza-1-vision", force=args.force)

    staged: list[StagedFile] = [*text_staged, drafter_staged]
    if vision_staged is not None:
        staged.append(vision_staged)
    # 6. Quantization recipe sidecars (+ polar artifacts).
    staged.extend(_stage_recipe_sidecars(bundle_dir, recipes_dir, force=args.force))

    drafter_target_sha = _read_drafter_target_checkpoint_sha256(Path(drafter_staged.destination))
    _write_licenses(bundle_dir, tier=tier, text_lineage_repo=args.text_lineage_repo, force=args.force)
    lineage = _write_lineage(bundle_dir=bundle_dir, tier=tier, text_repo=args.text_lineage_repo,
                             text_rev=args.text_lineage_rev, text_note=args.text_lineage_note,
                             drafter_target_sha=drafter_target_sha, drafter_stamp_only=drafter_stamp_only,
                             has_embedding=has_embedding, has_vision=vision_staged is not None)
    _write_target_meta(bundle_dir=bundle_dir, tier=tier, text_files=text_staged,
                       drafter_file=drafter_staged, reasons=reasons)
    files = _collect_files(bundle_dir, tier=tier)
    has_asr = bool(files.get("asr"))
    has_vad = bool(files.get("vad"))
    gate_report = _write_eval_files(bundle_dir=bundle_dir, tier=tier, generated_at=generated_at,
                                    reasons=reasons, has_asr=has_asr, has_vad=has_vad,
                                    has_embedding=has_embedding)
    backends = _write_backend_reports(bundle_dir=bundle_dir, tier=tier, generated_at=generated_at,
                                      git_sha=git_sha, reasons=reasons)
    _write_platform_evidence(bundle_dir=bundle_dir, generated_at=generated_at, git_sha=git_sha,
                             reasons=reasons)

    # 7. Manifest. require_publish_ready=False — failed eval/backend gates are expected at this stage.
    files = _collect_files(bundle_dir, tier=tier)  # re-collect after evidence writes
    ram_min, ram_rec = DEFAULT_RAM_BUDGET_MB[tier]
    from scripts.quantization._kernel_manifest import kernel_manifest_fragment
    manifest = build_manifest(
        tier=tier, version=args.version, published_at=generated_at, lineage=lineage, files=files,
        kernels_required=REQUIRED_KERNELS_BY_TIER[tier], kernels_optional=[],
        verified_backends=backends, text_eval_score=0.0, text_eval_passed=False,
        voice_rtf=0.0, voice_rtf_passed=False, e2e_loop_ok=False, thirty_turn_ok=False,
        ram_budget_min_mb=ram_min, ram_budget_recommended_mb=ram_rec, default_eligible=False,
        asr_wer=1.0 if has_asr else None, asr_wer_passed=False if has_asr else None,
        embed_mteb_score=0.0 if has_embedding else None,
        embed_mteb_passed=False if has_embedding else None,
        vad_latency_ms_median=0.0 if has_vad else None, vad_latency_ms_passed=False if has_vad else None,
        vad_boundary_ms=0.0 if has_vad else None,
        vad_endpoint_ms=0.0 if has_vad else None,
        vad_false_barge_in_rate=1.0 if has_vad else None,
        expressive_tag_faithfulness=0.0, expressive_mos=0.0, expressive_tag_leakage=1.0,
        expressive_passed=False, voice_capabilities=DEFAULT_VOICE_CAPABILITIES,
        voice_version=ELIZA_1_VOICE_MANIFEST_VERSION, voice_frozen=True,
        voice_cache_speaker_preset=VOICE_PRESET_CACHE_PATH, voice_cache_phrase_seed=VOICE_PRESET_CACHE_PATH,
        kernel_manifest_fragments=[kernel_manifest_fragment(m)
                                   for m in ("turboquant", "fused-turboquant", "qjl", "polarquant")],
        require_publish_ready=False,
    )
    manifest_path = write_manifest(manifest, bundle_dir / "eliza-1.manifest.json",
                                   require_publish_ready=False)
    _render_readme(bundle_dir=bundle_dir, tier=tier, reasons=reasons, text_repo=args.text_lineage_repo)
    manifest_local_errors = validate_manifest(manifest, require_publish_ready=False)
    manifest_publish_errors = validate_manifest(manifest)
    _write_release_evidence(bundle_dir=bundle_dir, tier=tier, generated_at=generated_at,
                            staged=staged, reasons=reasons)
    checksum_path = write_checksum_manifest(bundle_dir)
    checksum_errors = validate_checksum_manifest(bundle_dir)

    report_dir = (_repo_root() / "packages" / "inference" / "reports" / "local-e2e" / generated_at[:10])
    report_dir.mkdir(parents=True, exist_ok=True)
    repo_evidence = report_dir / f"eliza-1-{tier}-real-bundle-staging.json"
    _json_write(repo_evidence, {
        "schemaVersion": 1, "generatedAt": generated_at, "tier": tier, "bundleDir": str(bundle_dir),
        "publishEligible": False, "defaultEligible": False,
        "textBackbone": {"repo": args.text_lineage_repo, "revision": args.text_lineage_rev,
                         "quant": TEXT_QUANT_BY_TIER[tier], "substituted": text_substituted,
                         "note": args.text_lineage_note},
        "drafter": {"path": str(Path(drafter_staged.destination).relative_to(bundle_dir)),
                    "targetCheckpointSha256": drafter_target_sha, "stampOnly": drafter_stamp_only},
        "staged": [asdict(it) for it in staged],
        "generatedBundleFiles": sorted(str(p.relative_to(bundle_dir)) for p in bundle_dir.rglob("*")
                                       if p.is_file()
                                       and not any(part.startswith(".") for part in p.relative_to(bundle_dir).parts)),
        "manifestValidation": {"localNonPublishableOk": not manifest_local_errors,
                               "localNonPublishableErrors": list(manifest_local_errors),
                               "publishReadyOk": not manifest_publish_errors,
                               "publishReadyErrors": list(manifest_publish_errors)},
        "checksumValidation": {"ok": not checksum_errors, "errors": list(checksum_errors)},
        "gateReport": gate_report, "publishBlockingReasons": list(reasons),
    })
    return {
        "schemaVersion": 1, "generatedAt": generated_at, "tier": tier, "bundleDir": str(bundle_dir),
        "manifest": str(manifest_path), "checksums": str(checksum_path), "repoEvidence": str(repo_evidence),
        "publishEligible": False, "defaultEligible": False, "staged": [asdict(it) for it in staged],
        "manifestValidation": {"localNonPublishableOk": not manifest_local_errors,
                               "localNonPublishableErrors": list(manifest_local_errors),
                               "publishReadyOk": not manifest_publish_errors,
                               "publishReadyErrors": list(manifest_publish_errors)},
        "checksumValidation": {"ok": not checksum_errors, "errors": list(checksum_errors)},
        "publishBlockingReasons": reasons,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, choices=tuple(CONTEXTS_BY_TIER))
    ap.add_argument("--bundle-dir", required=True, type=Path)
    ap.add_argument("--text-gguf", required=True, type=Path,
                    help="Quantized text GGUF at the tier's release quant.")
    ap.add_argument("--drafter-gguf", required=True, type=Path,
                    help="DFlash drafter GGUF (stamped with dflash-draft.target_checkpoint_sha256).")
    ap.add_argument("--recipes-dir", required=True, type=Path,
                    help="Directory with turbo/, fused/, qjl/, polar/ subdirs holding recipe sidecars.")
    ap.add_argument("--vision-gguf", type=Path, default=None, help="mmproj GGUF for vision tiers.")
    ap.add_argument("--text-lineage-repo", required=True,
                    help="Upstream HF repo id the text backbone is derived from.")
    ap.add_argument("--text-lineage-rev", required=True, help="Upstream HF revision sha.")
    ap.add_argument("--text-lineage-note", default="",
                    help="Provenance note (e.g. why a substitute base was used).")
    ap.add_argument("--text-substituted", action="store_true",
                    help="Record that the text base is a substitute for the catalog-pinned family.")
    ap.add_argument("--drafter-stamp-only", action="store_true",
                    help="Record that the drafter is stamped, not re-distilled.")
    ap.add_argument("--skip-assets", action="store_true",
                    help="Skip the HF asset stage (voice/ASR/VAD already present in --bundle-dir).")
    ap.add_argument("--skip-wakeword", action="store_true", default=True,
                    help="Skip staging the optional openWakeWord graphs (default: skipped).")
    ap.add_argument("--with-wakeword", dest="skip_wakeword", action="store_false",
                    help="Stage the optional openWakeWord graphs into the bundle.")
    ap.add_argument(
        "--include-vad-onnx-fallback",
        action="store_true",
        help="Also stage legacy vad/silero-vad-int8.onnx alongside native GGML VAD.",
    )
    ap.add_argument("--link-mode", choices=("copy", "hardlink"), default="copy")
    ap.add_argument("--version", default="1.0.0-staged.1")
    ap.add_argument("--generated-at", default=None)
    ap.add_argument("--force", action="store_true")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    report = stage_real_bundle(args)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["checksumValidation"]["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
