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
import hashlib
import json
import os
import shutil
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

DEFAULT_REPO_ID = "elizaos/eliza-1"
DEFAULT_BUNDLES_ROOT = Path.home() / ".eliza" / "local-inference" / "models"
TIERS: tuple[str, ...] = (
    "0_8b",
    "2b",
    "4b",
)
KOKORO_TIERS: set[str] = set()
OMNIVOICE_TIERS = {"0_8b", "2b", "4b"}
PUBLISH_METADATA_DIRS = frozenset(
    {"checksums", "evidence", "evals", "licenses", "quantization"}
)
PUBLISH_METADATA_FILES = frozenset({"README.md", "lineage.json"})
PUBLISHABLE_RELEASE_STATES = frozenset({"base-v1", "upload-candidate", "final"})
REQUIRED_FINAL_FLAGS = (
    "weights",
    "hashes",
    "evals",
    "licenses",
    "kernelDispatchReports",
    "platformEvidence",
    "sizeFirstRepoIds",
)


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


def _iter_manifest_file_entries(manifest: dict[str, Any]) -> Iterable[dict[str, Any]]:
    files = manifest.get("files")
    if not isinstance(files, dict):
        return
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                yield entry


def _publishable_bundle_relpaths(bundle_dir: Path, manifest: dict[str, Any]) -> list[str]:
    """Return the runtime bundle files that should be published to the Hub.

    Local staging bundles may contain large ``source/`` inputs used to build
    GGUF artifacts. The app only needs the manifest-declared runtime files and
    release metadata, so avoid publishing build inputs into the single model
    repo.
    """

    rels: set[str] = {"eliza-1.manifest.json"}
    rels.update(_iter_manifest_paths(manifest))
    rels.update(
        rel for rel in PUBLISH_METADATA_FILES if _safe_bundle_child(bundle_dir, rel).is_file()
    )
    for metadata_dir in PUBLISH_METADATA_DIRS:
        root = bundle_dir / metadata_dir
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.is_file():
                rels.add(path.relative_to(bundle_dir).as_posix())
    return sorted(rels)


def _safe_bundle_child(bundle_dir: Path, rel: str) -> Path:
    if not rel or Path(rel).is_absolute():
        raise ValueError(f"invalid bundle-relative path: {rel!r}")
    root = bundle_dir.resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"bundle path escapes root: {rel!r}")
    return target


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _voice_policy_warnings(tier: str, manifest: dict[str, Any]) -> list[str]:
    voice_paths = [p.lower() for p in _iter_manifest_paths(manifest) if p.startswith("tts/") or "voice" in p.lower()]
    has_kokoro = any("kokoro" in p for p in voice_paths)
    has_omnivoice = any("omnivoice" in p or "omni" in p for p in voice_paths)
    warnings: list[str] = []
    if tier in OMNIVOICE_TIERS and not has_omnivoice:
        warnings.append(f"{tier}: expected OmniVoice artifacts for active Eliza-1 tiers")
    return warnings


def _release_evidence_errors(bundle_dir: Path, tier: str) -> list[str]:
    evidence_path = bundle_dir / "evidence" / "release.json"
    if not evidence_path.is_file():
        return [f"missing release evidence: {evidence_path}"]
    try:
        evidence = _load_json(evidence_path)
    except Exception as exc:  # noqa: BLE001 - operator report should keep going
        return [f"release evidence is not readable JSON: {exc}"]

    errors: list[str] = []
    if evidence.get("tier") != tier:
        errors.append(f"release evidence tier {evidence.get('tier')!r} does not match {tier}")
    release_state = evidence.get("releaseState")
    if release_state not in PUBLISHABLE_RELEASE_STATES:
        errors.append(
            f"releaseState {release_state!r} is not publishable "
            f"(expected one of {sorted(PUBLISHABLE_RELEASE_STATES)})"
        )
    if evidence.get("publishEligible") is not True:
        errors.append("evidence/release.json publishEligible is not true")

    final = evidence.get("final")
    if not isinstance(final, dict):
        errors.append("evidence/release.json final block is missing or not an object")
    else:
        for flag in REQUIRED_FINAL_FLAGS:
            if final.get(flag) is not True:
                errors.append(f"evidence/release.json final.{flag} is not true")

    hf = evidence.get("hf")
    if not isinstance(hf, dict):
        errors.append("evidence/release.json hf block is missing or not an object")
    else:
        if hf.get("repoId") not in {DEFAULT_REPO_ID, "elizaos/eliza-1"}:
            errors.append(f"evidence/release.json hf.repoId is unexpected: {hf.get('repoId')!r}")
        if hf.get("pathPrefix") != f"bundles/{tier}":
            errors.append(
                f"evidence/release.json hf.pathPrefix {hf.get('pathPrefix')!r} "
                f"does not match bundles/{tier}"
            )
    return errors


def plan_bundle(
    bundles_root: Path,
    tier: str,
    *,
    strict_voice_policy: bool = False,
    verify_hashes: bool = True,
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

        for entry in _iter_manifest_file_entries(manifest):
            rel = entry["path"]
            try:
                target = _safe_bundle_child(bundle_dir, rel)
            except ValueError as exc:
                errors.append(str(exc))
                continue
            if not target.is_file():
                errors.append(f"missing manifest file: {rel}")
                continue
            expected_sha = entry.get("sha256")
            if verify_hashes and isinstance(expected_sha, str):
                got_sha = _sha256_file(target)
                if got_sha != expected_sha:
                    errors.append(
                        f"sha256 mismatch for {rel}: manifest={expected_sha} actual={got_sha}"
                    )
        voice_warnings = _voice_policy_warnings(tier, manifest)
        if strict_voice_policy:
            errors.extend(voice_warnings)
        else:
            warnings.extend(voice_warnings)
        errors.extend(_release_evidence_errors(bundle_dir, tier))

        for rel in _publishable_bundle_relpaths(bundle_dir, manifest):
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
    verify_hashes: bool = True,
) -> list[BundlePlan]:
    return [
        plan_bundle(
            bundles_root,
            tier,
            strict_voice_policy=strict_voice_policy,
            verify_hashes=verify_hashes,
        )
        for tier in tiers
    ]


def _hardlink_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def _mirror_for_large_folder_upload(plan: BundlePlan, staging_root: Path) -> Path:
    source_root = Path(plan.bundle_dir)
    manifest = _load_json(source_root / "eliza-1.manifest.json")
    dest_root = staging_root / plan.path_in_repo
    for rel in _publishable_bundle_relpaths(source_root, manifest):
        source = _safe_bundle_child(source_root, rel)
        if source.is_file():
            _hardlink_or_copy(source, dest_root / rel)
    return staging_root


def _mirror_for_upload_folder(plan: BundlePlan, staging_root: Path) -> Path:
    source_root = Path(plan.bundle_dir)
    manifest = _load_json(source_root / "eliza-1.manifest.json")
    dest_root = staging_root / "bundle"
    for rel in _publishable_bundle_relpaths(source_root, manifest):
        source = _safe_bundle_child(source_root, rel)
        if source.is_file():
            _hardlink_or_copy(source, dest_root / rel)
    return dest_root


def publish_plans(
    plans: Sequence[BundlePlan],
    *,
    repo_id: str,
    token: str,
    dry_run: bool,
    large_folder_upload: bool = False,
    large_folder_workers: int | None = None,
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
        if large_folder_upload:
            parent = Path(plan.bundle_dir).parent
            with tempfile.TemporaryDirectory(
                prefix=f"eliza1-{plan.tier}-hf-",
                dir=str(parent),
            ) as tmp:
                staging_root = _mirror_for_large_folder_upload(plan, Path(tmp))
                api.upload_large_folder(
                    repo_id=repo_id,
                    repo_type="model",
                    folder_path=staging_root,
                    num_workers=large_folder_workers,
                )
        else:
            parent = Path(plan.bundle_dir).parent
            with tempfile.TemporaryDirectory(
                prefix=f"eliza1-{plan.tier}-hf-",
                dir=str(parent),
            ) as tmp:
                folder_path = _mirror_for_upload_folder(plan, Path(tmp))
                api.upload_folder(
                    folder_path=folder_path,
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
    ap.add_argument(
        "--skip-hash-verify",
        action="store_true",
        help="Only check manifest file presence; do not hash large GGUF files.",
    )
    ap.add_argument(
        "--large-folder-upload",
        action="store_true",
        help="Use Hugging Face upload_large_folder with a repo-shaped hardlink staging tree.",
    )
    ap.add_argument("--large-folder-workers", type=int)
    ap.add_argument("--report", type=Path, help="Optional JSON report path.")
    args = ap.parse_args(argv)

    tiers = args.tiers or list(TIERS)
    plans = plan_bundles(
        args.bundles_root,
        tiers,
        strict_voice_policy=args.strict_voice_policy,
        verify_hashes=not args.skip_hash_verify,
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
        publish_plans(
            plans,
            repo_id=args.repo_id,
            token=token,
            dry_run=False,
            large_folder_upload=args.large_folder_upload,
            large_folder_workers=args.large_folder_workers,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
