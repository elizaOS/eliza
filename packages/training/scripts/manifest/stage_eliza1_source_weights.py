#!/usr/bin/env python3
"""Stage upstream source text / drafter GGUFs for Eliza-1 conversion.

This script acquires the best currently available upstream GGUF payloads that
can seed Eliza-1 training/quantization, but it deliberately writes them under
``source/`` and records blockers. These files are not final Eliza-1 release
weights until the training/eval/publish gates emit the required ``text/`` and
``dflash/`` artifacts listed by ``eliza1_platform_plan.py``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Sequence

# Path to the elizaOS/llama.cpp fork's `llama-quantize` binary. The fork's
# CMake build emits this binary under
# `plugins/plugin-local-inference/native/llama.cpp/build/<backend>/bin/`.
# Callers may override via `--quantizer-bin` or the
# `ELIZA_LLAMA_QUANTIZE_BIN` environment variable.
DEFAULT_QUANTIZER_BIN_ENV: Final[str] = "ELIZA_LLAMA_QUANTIZE_BIN"

try:  # pragma: no cover - import availability is environment-dependent
    from huggingface_hub import HfApi, hf_hub_download
except ModuleNotFoundError:  # pragma: no cover - env-only path
    HfApi = None  # type: ignore[assignment]
    hf_hub_download = None  # type: ignore[assignment]

try:
    from .eliza1_manifest import ELIZA_1_TIERS
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import ELIZA_1_TIERS

HF_RETRY_ATTEMPTS: Final[int] = 4
HF_RETRY_BASE_DELAY_SEC: Final[float] = 2.0


def require_hf_hub(*, require_download: bool = False) -> tuple[Any, Any]:
    global HfApi, hf_hub_download
    if HfApi is None or (require_download and hf_hub_download is None):
        try:
            from huggingface_hub import HfApi as ImportedHfApi
            from huggingface_hub import hf_hub_download as imported_hf_hub_download
        except ModuleNotFoundError as exc:  # pragma: no cover - env-only path
            raise SystemExit(
                "huggingface_hub is required for non-dry-run source staging; "
                "install the training deps or run inside the training environment"
            ) from exc
        HfApi = ImportedHfApi
        hf_hub_download = imported_hf_hub_download
    if HfApi is None or (require_download and hf_hub_download is None):
        raise SystemExit(
            "huggingface_hub is required for non-dry-run source staging; "
            "install the training deps or run inside the training environment"
        )
    return HfApi, hf_hub_download


@dataclass(frozen=True, slots=True)
class SourceArtifact:
    kind: str
    repo: str
    filename: str
    destination: str
    license: str
    status: str
    notes: tuple[str, ...] = ()


TEXT_SOURCES: Final[dict[str, SourceArtifact]] = {
    "0_8b": SourceArtifact(
        kind="text",
        repo="unsloth/Qwen3.5-0.8B-GGUF",
        filename="Qwen3.5-0.8B-Q8_0.gguf",
        destination="source/text/qwen3.5-0_8b-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=(
            "GGUF mirror of the official Qwen/Qwen3.5-0.8B base.",
            "Final Eliza-1 0.8B still needs training plus Q3_K_M quantization.",
        ),
    ),
    "2b": SourceArtifact(
        kind="text",
        repo="unsloth/Qwen3.5-2B-GGUF",
        filename="Qwen3.5-2B-Q8_0.gguf",
        destination="source/text/qwen3.5-2b-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=(
            "GGUF mirror of the official Qwen/Qwen3.5-2B base.",
            "Final Eliza-1 2B still needs training plus Q4_K_M quantization.",
        ),
    ),
    "4b": SourceArtifact(
        kind="text",
        repo="unsloth/Qwen3.5-4B-GGUF",
        filename="Qwen3.5-4B-Q8_0.gguf",
        destination="source/text/qwen3.5-4b-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 4B still needs training plus Q4_K_M quantization.",),
    ),
    "9b": SourceArtifact(
        kind="text",
        repo="unsloth/Qwen3.5-9B-GGUF",
        filename="Qwen3.5-9B-Q8_0.gguf",
        destination="source/text/qwen3.5-9b-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=(
            "Final Eliza-1 9B still needs training plus Q4_K_M quantization.",
            "Qwen3.5 is the active Eliza-1 backbone family.",
        ),
    ),
    "27b": SourceArtifact(
        kind="text",
        repo="unsloth/Qwen3.5-27B-GGUF",
        filename="Qwen3.5-27B-Q8_0.gguf",
        destination="source/text/qwen3.5-27b-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 27B uses Qwen3.5 and still needs training plus Q4_K_M quantization.",),
    ),
    "27b-256k": SourceArtifact(
        kind="text",
        repo="unsloth/Qwen3.5-27B-GGUF",
        filename="Qwen3.5-27B-Q8_0.gguf",
        destination="source/text/qwen3.5-27b-256k-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 27B-256k uses Qwen3.5 and still needs long-context assembly plus Q4_K_M quantization.",),
    ),
    "27b-1m": SourceArtifact(
        kind="text",
        repo="unsloth/Qwen3.5-27B-GGUF",
        filename="Qwen3.5-27B-Q8_0.gguf",
        destination="source/text/qwen3.5-27b-1m-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 27B-1m uses Qwen3.5 and still needs long-context assembly plus Q4_K_M quantization.",),
    ),
}

DRAFTER_SOURCES: Final[dict[str, SourceArtifact | None]] = {
    "0_8b": None,
    "2b": None,
    "4b": None,
    "9b": None,
    "27b": None,
    "27b-256k": None,
    "27b-1m": None,
}

# mmproj-F16 sources per tier. Every Qwen3.5 base (0.8B/2B/4B/9B/27B) ships
# its own `mmproj-F16.gguf` in the matching unsloth repo. The 27B projector
# is shared verbatim across the 27b / 27b-256k / 27b-1m text-context variants
# (per the catalog comment at packages/shared/src/local-inference/catalog.ts
# and `plugins/plugin-local-inference/native/reports/porting/2026-05-14/mmproj-qwen35vl-plan.md`),
# so the long-context tiers reuse the 27B source byte-for-byte.
#
# Per-tier quantization (handled downstream by `llama-quantize` against the
# fork at `plugins/plugin-local-inference/native/llama.cpp/`):
#   0_8b              -> Q4_K_M
#   2b / 4b / 9b      -> Q8_0
#   27b / 27b-256k / 27b-1m -> Q8_0
# The full canonical chain and the architectural reasoning for why
# TurboQuant / PolarQuant / QJL are NOT applied to mmproj projectors are
# documented in the 2026-05-14 plan memo cited above and in
# `packages/training/release-staging/mmproj/manifest.json` once Phase 2
# has executed.
def _vision_source(tier: str, size: str) -> SourceArtifact:
    return SourceArtifact(
        kind="vision",
        repo=f"unsloth/Qwen3.5-{size}-GGUF",
        filename="mmproj-F16.gguf",
        destination=f"source/vision/qwen3.5-{tier}-mmproj-f16.gguf",
        license="apache-2.0",
        status="source-only",
        notes=(
            f"Upstream mmproj-F16 for the {size} projector; quantized to "
            f"{'Q4_K_M' if tier == '0_8b' else 'Q8_0'} during Phase 2 staging.",
        ),
    )


VISION_SOURCES: Final[dict[str, SourceArtifact | None]] = {
    "0_8b": _vision_source("0_8b", "0.8B"),
    "2b": _vision_source("2b", "2B"),
    "4b": _vision_source("4b", "4B"),
    "9b": _vision_source("9b", "9B"),
    "27b": _vision_source("27b", "27B"),
    "27b-256k": _vision_source("27b-256k", "27B"),
    "27b-1m": _vision_source("27b-1m", "27B"),
}

# Per-tier mmproj quantization target. Authoritative source: the live
# contract in `docs/ELIZA_1_BUNDLE_EXTRAS.json#vision.perTier` plus the
# plan memo at
# `plugins/plugin-local-inference/native/reports/porting/2026-05-14/mmproj-qwen35vl-plan.md`.
MMPROJ_QUANT_BY_TIER: Final[dict[str, str]] = {
    "0_8b": "Q4_K_M",
    "2b": "Q8_0",
    "4b": "Q8_0",
    "9b": "Q8_0",
    "27b": "Q8_0",
    "27b-256k": "Q8_0",
    "27b-1m": "Q8_0",
}

# Per-tier tensor-type overrides passed to `llama-quantize --tensor-type`.
# These keep specific projector tensors at F16 when the chosen block-quant
# (Q8_0 here) requires a row alignment the tensor doesn't satisfy.
#
#   - `v.patch_embd.weight` is a 16x16x3xN convolutional patch embedding:
#     16 cols are not divisible by Q8_0's required 32 (or Q4_K's 256).
#     Q4_K_M takes the path through `ggml`'s F16 fallback automatically;
#     Q8_0 needs the explicit override or it bails with
#     "Unsupported tensor size encountered".
#   - For the 9B/27B "large" projector arch, `v.blk.<N>.ffn_down.weight`
#     uses hidden_dim=4304 (4304 mod 32 == 16), so every ffn_down row in
#     every vision block must stay F16 in the Q8_0 output.
MMPROJ_QUANT_TENSOR_OVERRIDES: Final[dict[str, dict[str, str]]] = {
    "0_8b": {"v\\.patch_embd\\.weight": "f16"},
    "2b": {"v\\.patch_embd\\.weight": "f16"},
    "4b": {"v\\.patch_embd\\.weight": "f16"},
    "9b": {
        "v\\.patch_embd\\.weight": "f16",
        "v\\.blk\\.[0-9]+\\.ffn_down\\.weight": "f16",
    },
    "27b": {
        "v\\.patch_embd\\.weight": "f16",
        "v\\.blk\\.[0-9]+\\.ffn_down\\.weight": "f16",
    },
    "27b-256k": {
        "v\\.patch_embd\\.weight": "f16",
        "v\\.blk\\.[0-9]+\\.ffn_down\\.weight": "f16",
    },
    "27b-1m": {
        "v\\.patch_embd\\.weight": "f16",
        "v\\.blk\\.[0-9]+\\.ffn_down\\.weight": "f16",
    },
}


def retry_hf(callable_, *args: Any, **kwargs: Any) -> Any:
    last_error: Exception | None = None
    for attempt in range(HF_RETRY_ATTEMPTS):
        try:
            return callable_(*args, **kwargs)
        except Exception as exc:  # pragma: no cover - network-only path
            last_error = exc
            if attempt == HF_RETRY_ATTEMPTS - 1:
                break
            time.sleep(HF_RETRY_BASE_DELAY_SEC * (attempt + 1))
    assert last_error is not None
    raise last_error


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def materialize(cached: Path, destination: Path, link_mode: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if link_mode == "hardlink":
        try:
            if destination.exists() or destination.is_symlink():
                if destination.samefile(cached):
                    return
                destination.unlink()
            os.link(cached, destination)
            return
        except OSError:
            pass
    shutil.copy2(cached, destination)


def stage_one(
    artifact: SourceArtifact,
    *,
    bundle_dir: Path,
    revision: str,
    link_mode: str,
    dry_run: bool,
) -> dict[str, Any]:
    destination = bundle_dir / artifact.destination
    if dry_run:
        return {
            **asdict(artifact),
            "revision": revision,
            "path": str(destination),
            "dryRun": True,
        }
    cached = Path(
        retry_hf(
            require_hf_hub(require_download=True)[1],
            repo_id=artifact.repo,
            filename=artifact.filename,
            revision=revision,
            repo_type="model",
        )
    )
    materialize(cached, destination, link_mode)
    return {
        **asdict(artifact),
        "revision": revision,
        "path": str(destination),
        "linkMode": link_mode,
        "sizeBytes": destination.stat().st_size,
        "sha256": sha256_file(destination),
    }


def write_source_license_notes(bundle_dir: Path, artifacts: Sequence[SourceArtifact], *, dry_run: bool) -> None:
    if dry_run:
        return
    license_dir = bundle_dir / "licenses"
    license_dir.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, list[SourceArtifact]] = {}
    for artifact in artifacts:
        grouped.setdefault(artifact.kind, []).append(artifact)
    for kind, items in grouped.items():
        lines = [
            f"Eliza-1 {kind} source-weight acquisition notes.",
            "These files are not final Eliza-1 release weights until the publish gates pass.",
            "",
        ]
        for item in items:
            lines.append(f"- {item.repo}/{item.filename} ({item.license}, {item.status})")
        (license_dir / f"LICENSE.source-{kind}").write_text("\n".join(lines) + "\n")


def quantize_mmproj(
    *,
    source_f16: Path,
    target_quantized: Path,
    quant: str,
    tensor_overrides: dict[str, str],
    quantizer_bin: Path,
) -> dict[str, Any]:
    """Run `llama-quantize` on a staged F16 mmproj GGUF.

    The projector quantization step is deliberately a thin wrapper around
    the fork's `llama-quantize` binary. No TurboQuant / PolarQuant / QJL
    is applied here: those recipes target the text-backbone body and KV
    cache, not the vision projector (see `packages/training/AGENTS.md`
    s3 and the 2026-05-14 mmproj plan memo). Producing an
    `mmproj-<tier>-Q4_POLAR.gguf` would violate the fail-loudly
    precondition contract.
    """
    if not quantizer_bin.exists():
        raise SystemExit(
            f"llama-quantize binary not found at {quantizer_bin}. Build the "
            "elizaOS/llama.cpp fork or set ELIZA_LLAMA_QUANTIZE_BIN."
        )
    cmd: list[str] = [str(quantizer_bin)]
    for pattern, qtype in tensor_overrides.items():
        cmd.extend(["--tensor-type", f"{pattern}={qtype}"])
    cmd.extend([str(source_f16), str(target_quantized), quant])
    target_quantized.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if completed.returncode != 0 or not target_quantized.exists():
        raise SystemExit(
            "llama-quantize failed for "
            f"{source_f16} -> {target_quantized} ({quant}). "
            f"stderr tail:\n{completed.stderr[-2000:]}"
        )
    return {
        "quant": quant,
        "command": cmd,
        "outputPath": str(target_quantized),
        "outputSizeBytes": target_quantized.stat().st_size,
        "outputSha256": sha256_file(target_quantized),
        "tensorOverrides": tensor_overrides,
    }


def resolve_quantizer_bin(arg_value: Path | None) -> Path:
    if arg_value is not None:
        return arg_value.resolve()
    env_override = os.environ.get(DEFAULT_QUANTIZER_BIN_ENV)
    if env_override:
        return Path(env_override).resolve()
    # Default location relative to the repo root.
    repo_root = Path(__file__).resolve().parents[4]
    return (
        repo_root
        / "plugins/plugin-local-inference/native/llama.cpp/build/linux-x64-cuda/bin/llama-quantize"
    )


def stage_sources(args: argparse.Namespace) -> dict[str, Any]:
    bundle_dir = args.bundle_dir.resolve()
    HfApi, _ = require_hf_hub()
    api = HfApi()
    artifacts: list[SourceArtifact] = [TEXT_SOURCES[args.tier]]
    for optional in (DRAFTER_SOURCES[args.tier], VISION_SOURCES[args.tier]):
        if optional is not None:
            artifacts.append(optional)

    revisions: dict[str, str] = {}
    for repo in sorted({artifact.repo for artifact in artifacts}):
        revisions[repo] = str(retry_hf(api.model_info, repo).sha)

    files = [
        stage_one(
            artifact,
            bundle_dir=bundle_dir,
            revision=revisions[artifact.repo],
            link_mode=args.link_mode,
            dry_run=args.dry_run,
        )
        for artifact in artifacts
    ]

    quantized: list[dict[str, Any]] = []
    if (
        getattr(args, "quantize_mmproj", False)
        and VISION_SOURCES[args.tier] is not None
        and not args.dry_run
    ):
        vision_artifact = VISION_SOURCES[args.tier]
        assert vision_artifact is not None
        source_f16 = bundle_dir / vision_artifact.destination
        quant = MMPROJ_QUANT_BY_TIER[args.tier]
        overrides = MMPROJ_QUANT_TENSOR_OVERRIDES[args.tier]
        target_quantized = bundle_dir / "vision" / f"mmproj-{args.tier}.gguf"
        quantizer_bin = resolve_quantizer_bin(getattr(args, "quantizer_bin", None))
        quantized.append(
            quantize_mmproj(
                source_f16=source_f16,
                target_quantized=target_quantized,
                quant=quant,
                tensor_overrides=overrides,
                quantizer_bin=quantizer_bin,
            )
        )

    blockers = []
    if DRAFTER_SOURCES[args.tier] is None:
        blockers.append(
            f"No upstream DFlash drafter GGUF found for tier {args.tier}; final dflash/drafter-{args.tier}.gguf remains missing."
        )
    blockers.extend(
        [
            "Final Eliza-1 text GGUFs must be generated from trained Eliza-1 checkpoints, not renamed source weights.",
            "Final evals/checksums/licenses/release evidence and elizaos HF upload records remain publish-blocking.",
        ]
    )

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tier": args.tier,
        "bundleDir": str(bundle_dir),
        "sources": {repo: {"revision": revision} for repo, revision in revisions.items()},
        "files": files,
        "quantized": quantized,
        "blockers": blockers,
        "dryRun": args.dry_run,
    }
    if not args.dry_run:
        evidence = bundle_dir / "evidence" / "source-weights.json"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        write_source_license_notes(bundle_dir, artifacts, dry_run=False)
    return report


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, choices=ELIZA_1_TIERS)
    ap.add_argument("--bundle-dir", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--link-mode",
        choices=("copy", "hardlink"),
        default="hardlink",
        help="Materialize downloaded Hub cache files by copy or hardlink.",
    )
    ap.add_argument(
        "--quantize-mmproj",
        action="store_true",
        help=(
            "After staging the F16 mmproj source, run `llama-quantize` to "
            "produce bundles/<tier>/vision/mmproj-<tier>.gguf at the "
            "per-tier canonical quant (Q4_K_M for 0_8b, Q8_0 elsewhere). "
            "Requires the elizaOS/llama.cpp fork's llama-quantize binary."
        ),
    )
    ap.add_argument(
        "--quantizer-bin",
        type=Path,
        default=None,
        help=(
            "Override path to `llama-quantize`. Defaults to "
            "$ELIZA_LLAMA_QUANTIZE_BIN, then "
            "plugins/plugin-local-inference/native/llama.cpp/build/linux-x64-cuda/bin/llama-quantize."
        ),
    )
    return ap.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    print(json.dumps(stage_sources(args), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
