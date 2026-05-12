"""Publish staged Eliza-1 runtime bundles into one Hugging Face model repo.

The app catalog points every Eliza-1 tier at ``elizaos/eliza-1`` and resolves
files under ``bundles/<tier>/``. This publisher is the operator-side mirror of
that contract: it validates local ``eliza-1-<tier>.bundle`` directories, writes
the repo README, and uploads each bundle into the single model repo.

The v1 model repo is intentionally base/raw Qwen-lineage GGUF: converted and
Eliza-optimized for local inference, but not fine-tuned. Fine-tuned v2 weights
will replace or add promoted bundle revisions after the APOLLO SFT gates pass.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

DEFAULT_REPO_ID = "elizaos/eliza-1"
DEFAULT_BUNDLES_ROOT = Path.home() / ".eliza" / "local-inference" / "models"
TIERS: tuple[str, ...] = (
    "0_8b",
    "2b",
    "4b",
    "9b",
    "27b",
    "27b-256k",
    "27b-1m",
)
KOKORO_TIERS = {"0_8b", "2b", "4b", "9b"}
OMNIVOICE_TIERS = {"9b", "27b", "27b-256k", "27b-1m"}


@dataclass(frozen=True)
class BundlePlan:
    tier: str
    bundle_dir: str
    path_in_repo: str
    manifest_id: str | None
    manifest_tier: str | None
    file_count: int
    total_bytes: int
    uploadable: bool
    errors: tuple[str, ...]
    warnings: tuple[str, ...]


def _token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        blob = json.load(f)
    if not isinstance(blob, dict):
        raise ValueError(f"{path} did not contain a JSON object")
    return blob


def _iter_manifest_paths(manifest: dict[str, Any]) -> Iterable[str]:
    files = manifest.get("files")
    if not isinstance(files, dict):
        return
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                yield entry["path"]


def _safe_bundle_child(bundle_dir: Path, rel: str) -> Path:
    if not rel or Path(rel).is_absolute():
        raise ValueError(f"invalid bundle-relative path: {rel!r}")
    root = bundle_dir.resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"bundle path escapes root: {rel!r}")
    return target


def _voice_policy_warnings(tier: str, manifest: dict[str, Any]) -> list[str]:
    voice_paths = [p.lower() for p in _iter_manifest_paths(manifest) if p.startswith("tts/") or "voice" in p.lower()]
    has_kokoro = any("kokoro" in p for p in voice_paths)
    has_omnivoice = any("omnivoice" in p or "omni" in p for p in voice_paths)
    warnings: list[str] = []
    if tier in KOKORO_TIERS and not has_kokoro:
        warnings.append(f"{tier}: expected Kokoro voice artifacts for <=9B tiers")
    if tier in OMNIVOICE_TIERS and not has_omnivoice:
        warnings.append(f"{tier}: expected OmniVoice artifacts for >=9B tiers")
    return warnings


def plan_bundle(
    bundles_root: Path,
    tier: str,
    *,
    strict_voice_policy: bool = False,
) -> BundlePlan:
    bundle_dir = bundles_root / f"eliza-1-{tier}.bundle"
    path_in_repo = f"bundles/{tier}"
    errors: list[str] = []
    warnings: list[str] = []
    manifest_id: str | None = None
    manifest_tier: str | None = None
    file_count = 0
    total_bytes = 0

    if not bundle_dir.is_dir():
        errors.append(f"missing bundle directory: {bundle_dir}")
        return BundlePlan(
            tier,
            str(bundle_dir),
            path_in_repo,
            None,
            None,
            0,
            0,
            False,
            tuple(errors),
            tuple(warnings),
        )

    manifest_path = bundle_dir / "eliza-1.manifest.json"
    if not manifest_path.is_file():
        errors.append(f"missing manifest: {manifest_path}")
        manifest: dict[str, Any] = {}
    else:
        try:
            manifest = _load_json(manifest_path)
        except Exception as exc:  # noqa: BLE001 - operator report should keep going
            errors.append(f"manifest is not readable JSON: {exc}")
            manifest = {}
        manifest_id = manifest.get("id") if isinstance(manifest.get("id"), str) else None
        manifest_tier = manifest.get("tier") if isinstance(manifest.get("tier"), str) else None
        if manifest_id != f"eliza-1-{tier}":
            errors.append(f"manifest id {manifest_id!r} does not match eliza-1-{tier}")
        if manifest_tier != tier:
            errors.append(f"manifest tier {manifest_tier!r} does not match {tier}")

        seen: set[str] = {"eliza-1.manifest.json"}
        for rel in _iter_manifest_paths(manifest):
            try:
                target = _safe_bundle_child(bundle_dir, rel)
            except ValueError as exc:
                errors.append(str(exc))
                continue
            seen.add(rel)
            if not target.is_file():
                errors.append(f"missing manifest file: {rel}")
        voice_warnings = _voice_policy_warnings(tier, manifest)
        if strict_voice_policy:
            errors.extend(voice_warnings)
        else:
            warnings.extend(voice_warnings)

        for rel in seen:
            try:
                target = _safe_bundle_child(bundle_dir, rel)
            except ValueError:
                continue
            if target.is_file():
                file_count += 1
                total_bytes += target.stat().st_size

    return BundlePlan(
        tier=tier,
        bundle_dir=str(bundle_dir),
        path_in_repo=path_in_repo,
        manifest_id=manifest_id,
        manifest_tier=manifest_tier,
        file_count=file_count,
        total_bytes=total_bytes,
        uploadable=not errors,
        errors=tuple(errors),
        warnings=tuple(warnings),
    )


def build_model_card(repo_id: str, plans: Sequence[BundlePlan]) -> str:
    rows = [
        "| Tier | Remote path | Status | Files | Size | Voice note |",
        "| --- | --- | --- | ---: | ---: | --- |",
    ]
    for plan in plans:
        status = "ready" if plan.uploadable else "pending"
        size_gb = plan.total_bytes / (1024**3)
        voice_note = "; ".join(plan.warnings) if plan.warnings else "policy satisfied or not declared"
        rows.append(
            f"| {plan.tier} | `{plan.path_in_repo}/` | {status} | "
            f"{plan.file_count} | {size_gb:.2f} GiB | {voice_note} |"
        )
    return "\n".join(
        [
            "---",
            "license: other",
            "library_name: gguf",
            "tags:",
            "  - gguf",
            "  - qwen",
            "  - eliza-1",
            "  - local-inference",
            "---",
            "",
            "# Eliza-1",
            "",
            "Eliza-1 is the single elizaOS local-inference model repository. "
            "The v1 bundles are raw/base Qwen-lineage GGUF weights converted "
            "and packaged for the Eliza local harness; they are not fine-tuned.",
            "",
            "Runtime bundles live under `bundles/<tier>/` so the app can resolve "
            "the catalog manifest and all component files from one repo.",
            "",
            "APOLLO is the required optimizer for later fine-tuned releases. It "
            "keeps optimizer state small enough for full-parameter training on "
            "smaller GPUs, so publish scripts should not introduce a second "
            "optimizer path.",
            "",
            "## Bundle Matrix",
            "",
            *rows,
            "",
            "Quantization policy: Q4_K_M is the default published runtime "
            "artifact today; Q6_K and Q8_0 are tracked in the app catalog as "
            "higher-precision variants for the hardware optimizer to select "
            "when those files are published.",
            "",
            f"Repository: `{repo_id}`",
            "",
        ]
    )


def plan_bundles(
    bundles_root: Path,
    tiers: Sequence[str],
    *,
    strict_voice_policy: bool = False,
) -> list[BundlePlan]:
    return [
        plan_bundle(bundles_root, tier, strict_voice_policy=strict_voice_policy)
        for tier in tiers
    ]


def publish_plans(
    plans: Sequence[BundlePlan],
    *,
    repo_id: str,
    token: str,
    dry_run: bool,
) -> None:
    if dry_run:
        return
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="model", private=False, exist_ok=True)
    api.upload_file(
        path_or_fileobj=build_model_card(repo_id, plans).encode("utf-8"),
        path_in_repo="README.md",
        repo_id=repo_id,
        repo_type="model",
        commit_message="Update Eliza-1 model card",
    )
    for plan in plans:
        if not plan.uploadable:
            continue
        api.upload_folder(
            folder_path=plan.bundle_dir,
            path_in_repo=plan.path_in_repo,
            repo_id=repo_id,
            repo_type="model",
            ignore_patterns=[".DS_Store", "__MACOSX/*"],
            commit_message=f"Publish Eliza-1 {plan.tier} base GGUF bundle",
        )


def _print_summary(plans: Sequence[BundlePlan], *, repo_id: str, dry_run: bool) -> None:
    print(f"Eliza-1 model repo publish plan: {repo_id}")
    print(f"mode: {'dry-run' if dry_run else 'upload'}")
    for plan in plans:
        status = "ready" if plan.uploadable else "blocked"
        print(
            f"- {plan.tier}: {status}; files={plan.file_count}; "
            f"bytes={plan.total_bytes}; remote={plan.path_in_repo}/"
        )
        for warning in plan.warnings:
            print(f"  warning: {warning}")
        for error in plan.errors:
            print(f"  error: {error}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    ap.add_argument("--bundles-root", type=Path, default=DEFAULT_BUNDLES_ROOT)
    ap.add_argument("--tier", choices=TIERS, action="append", dest="tiers")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-missing", action="store_true")
    ap.add_argument("--strict-voice-policy", action="store_true")
    ap.add_argument("--report", type=Path, help="Optional JSON report path.")
    args = ap.parse_args(argv)

    tiers = args.tiers or list(TIERS)
    plans = plan_bundles(
        args.bundles_root,
        tiers,
        strict_voice_policy=args.strict_voice_policy,
    )
    _print_summary(plans, repo_id=args.repo_id, dry_run=args.dry_run)

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps({"repo_id": args.repo_id, "plans": [asdict(p) for p in plans]}, indent=2),
            encoding="utf-8",
        )

    blockers = [p for p in plans if not p.uploadable]
    if blockers and not args.allow_missing:
        return 2
    if not args.dry_run:
        token = _token()
        if not token:
            print("HF_TOKEN or HUGGINGFACE_HUB_TOKEN is required for upload", file=sys.stderr)
            return 2
        publish_plans(plans, repo_id=args.repo_id, token=token, dry_run=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
