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
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Sequence

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
        destination="source/text/qwen3.5-0.8b-q8_0.gguf",
        license="apache-2.0",
        status="source-only",
        notes=(
            "Replaces the old Qwen3 small-tier placeholder; Qwen3.5's smallest public tier is 0.8B.",
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
            "Replaces the old Qwen3 small-tier placeholder; Qwen3.5's nearest public tier is 1.7B.",
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
        filename="Qwen3.5-9B-Q4_K_M.gguf",
        destination="source/text/qwen3.5-9b-q4_k_m.gguf",
        license="apache-2.0",
        status="conversion-candidate",
        notes=("Final Eliza-1 9B still needs Eliza fine-tune/eval gates.",),
    ),
    "27b": SourceArtifact(
        kind="text",
        repo="batiai/Qwen3.6-27B-GGUF",
        filename="Qwen-Qwen3.6-27B-Q4_K_M.gguf",
        destination="source/text/qwen3.6-27b-q4_k_m.gguf",
        license="apache-2.0",
        status="conversion-candidate",
        notes=(
            "Selected direct Qwen3.6 conversion with Q4_K_M and separate mmproj.",
            "Final Eliza-1 27B still needs Eliza fine-tune/eval gates.",
        ),
    ),
    "27b-256k": SourceArtifact(
        kind="text",
        repo="batiai/Qwen3.6-27B-GGUF",
        filename="Qwen-Qwen3.6-27B-Q4_K_M.gguf",
        destination="source/text/qwen3.6-27b-q4_k_m.gguf",
        license="apache-2.0",
        status="conversion-candidate",
        notes=(
            "Same text source as 27b; final 256k artifact needs long-context eval.",
        ),
    ),
    "27b-1m": SourceArtifact(
        kind="text",
        repo="batiai/Qwen3.6-27B-GGUF",
        filename="Qwen-Qwen3.6-27B-Q4_K_M.gguf",
        destination="source/text/qwen3.6-27b-q4_k_m.gguf",
        license="apache-2.0",
        status="conversion-candidate",
        notes=(
            "Same text source as 27b; final 1m artifact needs GH200-class long-context eval.",
        ),
    ),
}

DRAFTER_SOURCES: Final[dict[str, SourceArtifact | None]] = {
    "0_8b": None,
    "2b": None,
    "4b": None,
    "9b": SourceArtifact(
        kind="dflash",
        repo="lym00/Qwen3.5-9B-DFlash-GGUF-Test",
        filename="Qwen3.5-9B-DFlash-q8_0.gguf",
        destination="source/dflash/qwen3.5-9b-dflash-q8_0.gguf",
        license="mit",
        status="test-candidate-not-release",
        notes=(
            "Upstream repo is explicitly a test repo; do not publish as final.",
        ),
    ),
    "27b": SourceArtifact(
        kind="dflash",
        repo="spiritbuun/Qwen3.6-27B-DFlash-GGUF",
        filename="dflash-draft-3.6-q8_0.gguf",
        destination="source/dflash/qwen3.6-27b-dflash-q8_0.gguf",
        license="mit",
        status="conversion-candidate",
        notes=("Q8_0 is upstream recommended for preserving acceptance.",),
    ),
    "27b-256k": SourceArtifact(
        kind="dflash",
        repo="spiritbuun/Qwen3.6-27B-DFlash-GGUF",
        filename="dflash-draft-3.6-q8_0.gguf",
        destination="source/dflash/qwen3.6-27b-dflash-q8_0.gguf",
        license="mit",
        status="conversion-candidate",
        notes=("Same drafter source as 27b; final 256k acceptance gate remains open.",),
    ),
    "27b-1m": SourceArtifact(
        kind="dflash",
        repo="spiritbuun/Qwen3.6-27B-DFlash-GGUF",
        filename="dflash-draft-3.6-q8_0.gguf",
        destination="source/dflash/qwen3.6-27b-dflash-q8_0.gguf",
        license="mit",
        status="conversion-candidate",
        notes=("Same drafter source as 27b; final 1m acceptance gate remains open.",),
    ),
}

VISION_SOURCES: Final[dict[str, SourceArtifact | None]] = {
    "0_8b": SourceArtifact(
        kind="vision",
        repo="unsloth/Qwen3.5-0.8B-GGUF",
        filename="mmproj-F16.gguf",
        destination="source/vision/qwen3.5-0.8b-mmproj-f16.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 0.8B vision/mmproj release artifact is not produced yet.",),
    ),
    "2b": SourceArtifact(
        kind="vision",
        repo="unsloth/Qwen3.5-2B-GGUF",
        filename="mmproj-F16.gguf",
        destination="source/vision/qwen3.5-2b-mmproj-f16.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 2B vision/mmproj release artifact is not produced yet.",),
    ),
    "4b": SourceArtifact(
        kind="vision",
        repo="unsloth/Qwen3.5-4B-GGUF",
        filename="mmproj-F16.gguf",
        destination="source/vision/qwen3.5-4b-mmproj-f16.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 4B vision/mmproj release artifact is not produced yet.",),
    ),
    "9b": SourceArtifact(
        kind="vision",
        repo="unsloth/Qwen3.5-9B-GGUF",
        filename="mmproj-F16.gguf",
        destination="source/vision/qwen3.5-9b-mmproj-f16.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 9B vision/mmproj release artifact is not produced yet.",),
    ),
    "27b": SourceArtifact(
        kind="vision",
        repo="batiai/Qwen3.6-27B-GGUF",
        filename="mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf",
        destination="source/vision/qwen3.6-27b-mmproj-q6_k.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Final Eliza-1 27B vision/mmproj release artifact is not produced yet.",),
    ),
    "27b-256k": SourceArtifact(
        kind="vision",
        repo="batiai/Qwen3.6-27B-GGUF",
        filename="mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf",
        destination="source/vision/qwen3.6-27b-mmproj-q6_k.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Same vision source as 27b; final 256k image eval remains open.",),
    ),
    "27b-1m": SourceArtifact(
        kind="vision",
        repo="batiai/Qwen3.6-27B-GGUF",
        filename="mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf",
        destination="source/vision/qwen3.6-27b-mmproj-q6_k.gguf",
        license="apache-2.0",
        status="source-only",
        notes=("Same vision source as 27b; final 1m image eval remains open.",),
    ),
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
    return ap.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    print(json.dumps(stage_sources(args), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
