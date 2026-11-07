"""Release publishing: upload."""

from __future__ import annotations
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Mapping, Sequence
from eliza_training.manifest.audit_hf_eliza1_release import (  # noqa: E402
    DEFAULT_DATASET_REPO,
    audit_hf_release,
)
from .context import (
    CHECKSUMS_PATH,
    EXIT_HF_AUDIT_FAIL,
    EXIT_HF_PUSH_FAIL,
    EXIT_RELEASE_EVIDENCE_FAIL,
    OrchestratorError,
    PublishContext,
    RELEASE_EVIDENCE_PATH,
    _bundle_repo_path,
    _git_short_sha,
    log,
)
from .evidence import _write_checksum_manifest, validate_release_evidence
from .layout import _read_sidecar


def _hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def push_to_hf(
    ctx: PublishContext,
    manifest_path: Path,
    readme_path: Path,
    upload_pairs: Sequence[tuple[Path, str]],
) -> dict[str, Any] | None:
    """Push the bundle to ``ctx.repo_id``. No-op when ``ctx.dry_run``.

    Returns the HF payload commit evidence on success so the release
    sidecar can be finalized and uploaded in a follow-up commit.
    """
    if ctx.dry_run:
        log.info(
            "[push] dry-run: would push %d files to %s",
            len(upload_pairs) + 2,
            ctx.repo_id,
        )
        return None

    if not _hf_token():
        raise OrchestratorError(
            "HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set; refusing to push.",
            EXIT_HF_PUSH_FAIL,
        )

    try:
        from huggingface_hub import CommitOperationAdd, HfApi
        from huggingface_hub.errors import RepositoryNotFoundError
    except ImportError as exc:  # pragma: no cover
        raise OrchestratorError(
            "huggingface_hub is required to push; "
            "install via `uv run --with huggingface_hub ...`",
            EXIT_HF_PUSH_FAIL,
        ) from exc

    api = HfApi(token=_hf_token())
    try:
        api.repo_info(ctx.repo_id, repo_type="model")
    except RepositoryNotFoundError:
        api.create_repo(
            repo_id=ctx.repo_id,
            repo_type="model",
            private=not ctx.public,
            exist_ok=False,
        )

    operations = [
        CommitOperationAdd(
            path_in_repo=_bundle_repo_path(ctx, "eliza-1.manifest.json"),
            path_or_fileobj=str(manifest_path),
        ),
        CommitOperationAdd(
            path_in_repo=_bundle_repo_path(ctx, "README.md"),
            path_or_fileobj=str(readme_path),
        ),
    ]
    for src, target in upload_pairs:
        operations.append(
            CommitOperationAdd(path_in_repo=target, path_or_fileobj=str(src))
        )

    commit_info = api.create_commit(
        repo_id=ctx.repo_id,
        repo_type="model",
        operations=operations,
        commit_message=f"eliza-1-{ctx.tier}: publish bundle",
    )
    uploaded_paths = [
        _bundle_repo_path(ctx, "eliza-1.manifest.json"),
        _bundle_repo_path(ctx, "README.md"),
        *(target for _, target in upload_pairs),
    ]
    return _upload_evidence_from_commit(
        ctx,
        commit_info=commit_info,
        uploaded_paths=uploaded_paths,
    )


def _upload_evidence_from_commit(
    ctx: PublishContext,
    *,
    commit_info: object,
    uploaded_paths: Sequence[str],
) -> dict[str, Any]:
    commit = (
        getattr(commit_info, "oid", None)
        or getattr(commit_info, "commit_id", None)
        or getattr(commit_info, "commit_hash", None)
    )
    url = getattr(commit_info, "commit_url", None) or getattr(commit_info, "url", None)
    if not commit or not url:
        raise OrchestratorError(
            "HF upload completed but the client did not return commit/url "
            "evidence; refusing to finalize release evidence.",
            EXIT_HF_PUSH_FAIL,
        )
    return {
        "repoId": ctx.repo_id,
        "status": "uploaded",
        "commit": str(commit),
        "url": str(url),
        "uploadedPaths": sorted(set(uploaded_paths)),
    }


def finalize_release_evidence(
    ctx: PublishContext,
    layout: Mapping[str, Sequence[Path]],
    upload_evidence: Mapping[str, Any],
) -> tuple[Path, Path]:
    """Move evidence/release.json from candidate to final after HF upload.

    The payload upload commit is the non-circular proof for the final
    evidence. The final evidence sidecar and refreshed checksum manifest
    are uploaded in a small follow-up commit by ``push_final_release_evidence``.
    """

    release_path = ctx.bundle_dir / RELEASE_EVIDENCE_PATH
    evidence = _read_sidecar(release_path)
    hf = evidence.get("hf")
    if not isinstance(hf, dict):
        raise OrchestratorError(
            "release evidence: hf must be an object before finalization",
            EXIT_RELEASE_EVIDENCE_FAIL,
        )

    if evidence.get("releaseState") != "base-v1":
        evidence["releaseState"] = "final"
    final = dict(evidence.get("final") or {})
    final["sizeFirstRepoIds"] = True
    evidence["final"] = final
    hf["repoId"] = ctx.repo_id
    hf["status"] = "uploaded"
    hf["uploadEvidence"] = dict(upload_evidence)
    evidence["hf"] = hf
    release_path.write_text(json.dumps(evidence, indent=2, sort_keys=False) + "\n")

    checksum_path = _write_checksum_manifest(ctx, layout)
    validate_release_evidence(ctx, layout, allow_uploaded_evidence=True)
    return release_path, checksum_path


def push_final_release_evidence(
    ctx: PublishContext,
    release_path: Path,
    checksum_path: Path,
) -> None:
    """Upload final release evidence after the payload commit exists."""

    if ctx.dry_run:
        return
    if not _hf_token():
        raise OrchestratorError(
            "HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set; refusing "
            "to push final release evidence.",
            EXIT_HF_PUSH_FAIL,
        )
    try:
        from huggingface_hub import CommitOperationAdd, HfApi
    except ImportError as exc:  # pragma: no cover
        raise OrchestratorError(
            "huggingface_hub is required to push final release evidence; "
            "install via `uv run --with huggingface_hub ...`",
            EXIT_HF_PUSH_FAIL,
        ) from exc

    api = HfApi(token=_hf_token())
    api.create_commit(
        repo_id=ctx.repo_id,
        repo_type="model",
        operations=[
            CommitOperationAdd(
                path_in_repo=_bundle_repo_path(ctx, str(RELEASE_EVIDENCE_PATH)),
                path_or_fileobj=str(release_path),
            ),
            CommitOperationAdd(
                path_in_repo=_bundle_repo_path(ctx, str(CHECKSUMS_PATH)),
                path_or_fileobj=str(checksum_path),
            ),
        ],
        commit_message=f"eliza-1-{ctx.tier}: finalize release evidence",
    )


def run_hf_release_audit(ctx: PublishContext) -> None:
    """Block completed publishes unless the public HF release surface is green."""

    if ctx.dry_run:
        log.info("[hf-audit] dry-run: skipped because no Hub upload occurred")
        return
    report = audit_hf_release(model_repo=ctx.repo_id, dataset_repo=DEFAULT_DATASET_REPO)
    if report.ok:
        log.info(
            "[hf-audit] passed: model=%s dataset=%s checks=%d",
            report.model_repo,
            report.dataset_repo,
            len(report.checks),
        )
        return
    log.error("[hf-audit] failed after upload:\n%s", report.render())
    raise OrchestratorError(
        "HF release audit failed after upload; refusing to tag this publish.",
        EXIT_HF_AUDIT_FAIL,
    )


def tag_training_repo(ctx: PublishContext, version: str, dry_run: bool) -> str | None:
    """Apply ``eliza-1-<tier>-v<version>`` to HEAD of the training repo.

    Returns the tag name. In dry-run, prints the tag command and returns
    the tag name without invoking git.
    """
    tag_name = f"eliza-1-{ctx.tier}-v{version}"
    sha = _git_short_sha(ctx.training_repo_root)
    message = f"Publish {tag_name} (training-commit={sha})"

    if dry_run:
        log.info(
            "[tag] dry-run: would run `git tag -a %s -m %r` (HEAD=%s)",
            tag_name,
            message,
            sha,
        )
        return tag_name

    if shutil.which("git") is None:
        raise OrchestratorError(
            "git is not on PATH; cannot tag training repo",
            EXIT_HF_PUSH_FAIL,
        )

    proc = subprocess.run(
        [
            "git",
            "-C",
            str(ctx.training_repo_root),
            "tag",
            "-a",
            tag_name,
            "-m",
            message,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise OrchestratorError(
            f"git tag failed: {proc.stderr}",
            EXIT_HF_PUSH_FAIL,
        )
    return tag_name


def _read_version(ctx: PublishContext) -> str:
    """Read the bundle version from ``bundle/VERSION`` or default to 1.0.0."""
    p = ctx.bundle_dir / "VERSION"
    if p.is_file():
        v = p.read_text().strip()
        if v:
            return v
    return "1.0.0"
