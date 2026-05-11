#!/usr/bin/env python3
"""Stage and optionally push an Eliza-1 dataset candidate.

Dry-run is the default. A real local write requires ``--write``. A real
HuggingFace push additionally requires ``--push --allow-hf-push``.

The script only stages candidate-scoped files:

  data/candidates/eliza1/<candidate-id>/README.md
  data/candidates/eliza1/<candidate-id>/manifest.json
  data/candidates/eliza1/<candidate-id>/data/{train,validation,test}.jsonl

It refuses mixed JSONL schemas across split files and refuses user-export
writes/pushes unless privacy review is explicitly attested.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CANDIDATE_ROOT = ROOT / "data" / "candidates" / "eliza1"
DEFAULT_REPO_ID = "elizalabs/eliza-1-training-candidates"
SCHEMA_VERSION = "eliza1.dataset_candidate.v1"

SPLIT_TARGETS = {
    "train": Path("data/train.jsonl"),
    "validation": Path("data/validation.jsonl"),
    "test": Path("data/test.jsonl"),
}

ALLOWED_LOCAL_RELATIVE = {
    Path("README.md"),
    Path("manifest.json"),
    *SPLIT_TARGETS.values(),
}

ALLOWED_SOURCE_KINDS = {"public", "synthetic", "user_export"}
CANDIDATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,78}[a-z0-9]$")


class CandidateError(RuntimeError):
    """Raised when a candidate violates a safety or schema rule."""


@dataclass(frozen=True)
class SplitStats:
    split: str
    source: Path
    target: Path
    path_in_repo: str
    rows: int
    bytes: int
    sha256: str
    schema: str


@dataclass(frozen=True)
class CandidatePlan:
    candidate_id: str
    candidate_dir: Path
    repo_id: str
    source_kind: str
    privacy_reviewed: bool
    split_stats: tuple[SplitStats, ...]
    manifest: dict[str, Any]
    readme: str

    @property
    def dataset_schema(self) -> str:
        return str(self.manifest["datasetSchema"])


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _validate_candidate_id(candidate_id: str) -> str:
    normalized = candidate_id.strip().lower()
    if not CANDIDATE_ID_RE.match(normalized):
        raise CandidateError(
            "candidate id must be 3-80 chars of lowercase letters, digits, '.', '_', or '-'"
        )
    if ".." in normalized or "/" in normalized or "\\" in normalized:
        raise CandidateError("candidate id cannot contain path traversal")
    return normalized


def _ensure_under(path: Path, root: Path) -> None:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise CandidateError(f"refusing path outside candidate root: {path}") from exc


def _detect_schema(record: dict[str, Any]) -> str:
    if (
        record.get("format") == "eliza_native_v1"
        and isinstance(record.get("request"), dict)
        and isinstance(record.get("response"), dict)
    ):
        return "eliza_native_v1"

    eliza_fields = {
        "roomName",
        "agentId",
        "memoryEntries",
        "currentMessage",
        "expectedResponse",
        "availableActions",
        "metadata",
    }
    if eliza_fields <= set(record):
        return "eliza_record_v1"

    messages = record.get("messages")
    if isinstance(messages, list) and messages and all(
        isinstance(msg, dict)
        and isinstance(msg.get("role"), str)
        and "content" in msg
        for msg in messages
    ):
        return "chat_messages_v1"

    return "unknown"


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def _iter_jsonl(path: Path) -> Iterable[tuple[int, dict[str, Any]]]:
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CandidateError(f"{path}:{line_no}: invalid JSON: {exc.msg}") from exc
            if not isinstance(value, dict):
                raise CandidateError(f"{path}:{line_no}: record must be a JSON object")
            yield line_no, value


def inspect_split(split: str, source: Path, candidate_dir: Path) -> SplitStats:
    source = source.resolve()
    if not source.exists():
        raise CandidateError(f"missing {split} split: {source}")
    if source.suffix != ".jsonl":
        raise CandidateError(f"{split} split must be .jsonl: {source}")

    schemas: set[str] = set()
    rows = 0
    for line_no, record in _iter_jsonl(source):
        schema = _detect_schema(record)
        if schema == "unknown":
            raise CandidateError(f"{source}:{line_no}: unknown dataset schema")
        schemas.add(schema)
        rows += 1
        if len(schemas) > 1:
            raise CandidateError(f"{source}: mixed schemas inside one split: {sorted(schemas)}")
    if rows == 0:
        raise CandidateError(f"{source}: split has no records")
    if len(schemas) != 1:
        raise CandidateError(f"{source}: expected exactly one schema")

    target_rel = SPLIT_TARGETS[split]
    target = candidate_dir / target_rel
    path_in_repo = f"candidates/{candidate_dir.name}/{target_rel.as_posix()}"
    return SplitStats(
        split=split,
        source=source,
        target=target,
        path_in_repo=path_in_repo,
        rows=rows,
        bytes=source.stat().st_size,
        sha256=_sha256_file(source),
        schema=next(iter(schemas)),
    )


def build_plan(
    *,
    candidate_id: str,
    train: Path,
    validation: Path,
    test: Path,
    source_kind: str,
    privacy_reviewed: bool,
    repo_id: str = DEFAULT_REPO_ID,
    candidate_root: Path = DEFAULT_CANDIDATE_ROOT,
    generated_at: str | None = None,
) -> CandidatePlan:
    candidate_id = _validate_candidate_id(candidate_id)
    if source_kind not in ALLOWED_SOURCE_KINDS:
        raise CandidateError(f"source_kind must be one of {sorted(ALLOWED_SOURCE_KINDS)}")

    candidate_dir = (candidate_root / candidate_id).resolve()
    _ensure_under(candidate_dir, candidate_root)

    split_stats = (
        inspect_split("train", train, candidate_dir),
        inspect_split("validation", validation, candidate_dir),
        inspect_split("test", test, candidate_dir),
    )
    schemas = {stat.schema for stat in split_stats}
    if len(schemas) != 1:
        by_split = {stat.split: stat.schema for stat in split_stats}
        raise CandidateError(f"refusing mixed split schemas: {by_split}")

    dataset_schema = next(iter(schemas))
    generated_at = generated_at or _utc_now()
    path_prefix = f"candidates/{candidate_id}"

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": candidate_id,
        "generatedAt": generated_at,
        "datasetSchema": dataset_schema,
        "sourceKind": source_kind,
        "privacy": {
            "reviewed": bool(privacy_reviewed),
            "realUserExport": source_kind == "user_export",
            "note": (
                "Human privacy review attested before write/push."
                if privacy_reviewed
                else "Dry-run or non-user candidate; no privacy attestation recorded."
            ),
        },
        "hf": {
            "repoId": repo_id,
            "pathPrefix": path_prefix,
            "candidateOnly": True,
        },
        "contract": {
            "trainingReadySchema": "eliza_native_v1",
            "devProvidersPinned": False,
            "providerPolicy": (
                "Provider/model fields may remain as audit metadata in rows, "
                "but they are not part of the dataset contract."
            ),
            "opus47": "prepared_not_run",
            "vast": "canonical",
            "nebius": "deprecated_fallback",
        },
        "splits": {
            stat.split: {
                "path": SPLIT_TARGETS[stat.split].as_posix(),
                "rows": stat.rows,
                "bytes": stat.bytes,
                "sha256": stat.sha256,
                "sourceFileName": stat.source.name,
            }
            for stat in split_stats
        },
    }

    readme = _render_readme(manifest)
    return CandidatePlan(
        candidate_id=candidate_id,
        candidate_dir=candidate_dir,
        repo_id=repo_id,
        source_kind=source_kind,
        privacy_reviewed=privacy_reviewed,
        split_stats=split_stats,
        manifest=manifest,
        readme=readme,
    )


def _render_readme(manifest: dict[str, Any]) -> str:
    split_lines = []
    for split, info in manifest["splits"].items():
        split_lines.append(
            f"| {split} | `{info['path']}` | {info['rows']} | `{info['sha256']}` |"
        )
    splits = "\n".join(split_lines)
    return (
        "---\n"
        "license: other\n"
        "task_categories:\n"
        "  - text-generation\n"
        "language:\n"
        "  - en\n"
        "tags:\n"
        "  - eliza\n"
        "  - eliza-1\n"
        "  - candidate\n"
        "---\n"
        "\n"
        f"# Eliza-1 dataset candidate: {manifest['candidateId']}\n"
        "\n"
        "This is a staged dataset candidate, not a released training corpus.\n"
        "\n"
        f"- Schema: `{manifest['datasetSchema']}`\n"
        f"- Source kind: `{manifest['sourceKind']}`\n"
        f"- Privacy reviewed: `{str(manifest['privacy']['reviewed']).lower()}`\n"
        "- Dev providers pinned: `false`\n"
        "- Opus 4.7 status: `prepared_not_run`\n"
        "- Cloud training: Vast canonical; Nebius deprecated fallback only.\n"
        "\n"
        "## Splits\n"
        "\n"
        "| Split | Path | Rows | SHA-256 |\n"
        "| --- | --- | ---: | --- |\n"
        f"{splits}\n"
        "\n"
        "## Contract\n"
        "\n"
        "The training-ready schema is `eliza_native_v1`. Provider/model fields may\n"
        "exist as row-level audit metadata, but provider names, token accounting,\n"
        "latency, cost, and provider-specific metadata are not contract fields.\n"
    )


def _candidate_write_paths(plan: CandidatePlan) -> dict[Path, bytes | Path]:
    return {
        plan.candidate_dir / "README.md": plan.readme.encode("utf-8"),
        plan.candidate_dir / "manifest.json": json.dumps(
            plan.manifest, indent=2, sort_keys=True
        ).encode("utf-8")
        + b"\n",
        **{stat.target: stat.source for stat in plan.split_stats},
    }


def validate_write_allowed(plan: CandidatePlan) -> None:
    if plan.source_kind == "user_export" and not plan.privacy_reviewed:
        raise CandidateError(
            "refusing to write user-export candidate without --privacy-reviewed"
        )
    for target in _candidate_write_paths(plan):
        _ensure_under(target, plan.candidate_dir)
        rel = target.relative_to(plan.candidate_dir)
        if rel not in ALLOWED_LOCAL_RELATIVE:
            raise CandidateError(f"refusing non-candidate write path: {rel}")


def write_candidate(plan: CandidatePlan) -> None:
    validate_write_allowed(plan)
    for target, payload in _candidate_write_paths(plan).items():
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(payload, Path):
            if payload.resolve() == target.resolve():
                continue
            shutil.copyfile(payload, target)
        else:
            target.write_bytes(payload)


def _validate_push_paths(plan: CandidatePlan) -> list[tuple[Path, str]]:
    prefix = f"candidates/{plan.candidate_id}/"
    uploads = [
        (plan.candidate_dir / "README.md", f"{prefix}README.md"),
        (plan.candidate_dir / "manifest.json", f"{prefix}manifest.json"),
    ]
    uploads.extend((stat.target, stat.path_in_repo) for stat in plan.split_stats)
    for local, path_in_repo in uploads:
        if not local.exists():
            raise CandidateError(f"missing staged file for push: {local}")
        if not path_in_repo.startswith(prefix):
            raise CandidateError(f"refusing non-candidate repo path: {path_in_repo}")
    return uploads


def push_candidate(
    plan: CandidatePlan,
    *,
    allow_hf_push: bool,
    allow_user_export_push: bool,
    public: bool,
) -> int:
    if not allow_hf_push:
        raise CandidateError("refusing HF push without --allow-hf-push")
    if plan.source_kind == "user_export" and not allow_user_export_push:
        raise CandidateError(
            "refusing to push user-export candidate without --allow-user-export-push"
        )
    if plan.source_kind == "user_export" and not plan.privacy_reviewed:
        raise CandidateError(
            "refusing to push user-export candidate without --privacy-reviewed"
        )
    if not hf_token():
        raise CandidateError("HF_TOKEN or HUGGINGFACE_HUB_TOKEN is required for push")

    uploads = _validate_push_paths(plan)

    from huggingface_hub import CommitOperationAdd, HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())
    try:
        api.repo_info(plan.repo_id, repo_type="dataset")
    except RepositoryNotFoundError:
        api.create_repo(
            repo_id=plan.repo_id,
            repo_type="dataset",
            private=not public,
            exist_ok=False,
        )

    operations = [
        CommitOperationAdd(path_in_repo=path_in_repo, path_or_fileobj=str(local))
        for local, path_in_repo in uploads
    ]
    api.create_commit(
        repo_id=plan.repo_id,
        repo_type="dataset",
        operations=operations,
        commit_message=f"Stage eliza-1 dataset candidate {plan.candidate_id}",
    )
    return 0


def print_plan(plan: CandidatePlan) -> None:
    print(f"candidate: {plan.candidate_id}")
    print(f"schema: {plan.dataset_schema}")
    print(f"source_kind: {plan.source_kind}")
    print(f"privacy_reviewed: {str(plan.privacy_reviewed).lower()}")
    print(f"local_dir: {plan.candidate_dir}")
    print(f"hf_repo: {plan.repo_id}")
    print(f"hf_prefix: candidates/{plan.candidate_id}/")
    for stat in plan.split_stats:
        print(
            f"{stat.split}: {stat.rows} rows, {stat.bytes} bytes, "
            f"{stat.source} -> {stat.target.relative_to(plan.candidate_dir)}"
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--candidate-id", required=True)
    ap.add_argument("--train", required=True, type=Path)
    ap.add_argument("--validation", required=True, type=Path)
    ap.add_argument("--test", required=True, type=Path)
    ap.add_argument(
        "--source-kind",
        choices=sorted(ALLOWED_SOURCE_KINDS),
        default="user_export",
        help="Default is user_export so privacy review is required before writes.",
    )
    ap.add_argument("--privacy-reviewed", action="store_true")
    ap.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    ap.add_argument("--write", action="store_true", help="write the local candidate files")
    ap.add_argument("--push", action="store_true", help="push the staged candidate to HF")
    ap.add_argument("--allow-hf-push", action="store_true")
    ap.add_argument("--allow-user-export-push", action="store_true")
    ap.add_argument("--public", action="store_true", help="create HF repo public if missing")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        plan = build_plan(
            candidate_id=args.candidate_id,
            train=args.train,
            validation=args.validation,
            test=args.test,
            source_kind=args.source_kind,
            privacy_reviewed=args.privacy_reviewed,
            repo_id=args.repo_id,
        )
        print_plan(plan)
        if not args.write and not args.push:
            print("dry-run: no files written and no HF calls made")
            return 0
        if args.push and not args.write:
            raise CandidateError("--push requires --write so the staged files are auditable")
        if args.write:
            write_candidate(plan)
            print(f"wrote candidate files under {plan.candidate_dir}")
        if args.push:
            return push_candidate(
                plan,
                allow_hf_push=args.allow_hf_push,
                allow_user_export_push=args.allow_user_export_push,
                public=args.public,
            )
        return 0
    except CandidateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
