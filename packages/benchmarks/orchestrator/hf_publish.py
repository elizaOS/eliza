"""Fail-closed HuggingFace dataset publishing for the generated benchmark_results tree.

``benchmark_results/`` is gitignored by the monorepo and carries its own nested
git repository whose local history is the publication audit log. ``publish-hf``
(the CLI subcommand in ``cli.py``) drives :func:`publish_to_hf`, which — under
``locking.latest_publication_lock`` — validates the latest-snapshot gates
(readiness = publishability + comparability + runtime gates, plus the artifact
guard), regenerates the ``exports/`` JSONL projections and a ``db_snapshots/``
SQLite copy (``VACUUM INTO``; the live WAL-mode database file is never copied
or uploaded), relativizes the absolute host paths the runner embeds in
``latest/``/``quarantine/``/``baselines/`` snapshots, commits the tree to the
nested repo, and uploads via ``HfApi.upload_folder`` (never ``git push`` — the
Hub hard-limits non-LFS git files). A publish is refused — fail closed — when
gates fail (unless ``--skip-gates``, which is recorded in the manifest), when
no HF token is configured, or when the secret scrub finds credential-shaped
content in the upload set.

The runner's ``_rebuild_latest_result_snapshots`` writes absolute paths and is
owned by concurrently-running campaigns, so path relativization is a publish-
time post-process here rather than a runner change. Likewise, per-run-group
auto-commits (``auto_commit_run_groups``, local only, never a push) are invoked
explicitly by the publish flow; wiring the hook into the runner after each
cohort is deliberately deferred to keep the runner stable.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
import re
import sqlite3
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .artifact_guard import ArtifactGuardReport, build_artifact_guard_report
from .db import connect_database, initialize_database, list_run_groups, list_runs
from .env_utils import git_head
from .latest_readiness import ReadinessReport, validate_latest_readiness
from .locking import latest_publication_lock

logger = logging.getLogger(__name__)

MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024

# Placeholder prefixes substituted for host-absolute path roots so published
# JSON never leaks local usernames or checkout locations. "." is the dataset
# root (benchmark_results/), "<eliza-repo>" the monorepo root, "~" the home dir.
REPO_ROOT_PLACEHOLDER = "<eliza-repo>"

# Mirrors the nested-repo .gitignore plus the git metadata itself. The same
# patterns are handed to HfApi.upload_folder so the printed would-publish set
# and the uploaded set agree. The live SQLite (WAL mode) must never ship — a
# mid-write copy is corrupt by construction; db_snapshots/ carries VACUUM'd
# copies instead. Lock files are runtime coordination noise, not results.
# Every bare-name pattern needs a "**/" twin: the local walker matches by
# basename at any depth, but huggingface_hub's filter_repo_objects fnmatches
# the full relative path only. Without the twins a nested copy (e.g.
# rg_x/orchestrator.sqlite) would be uploaded while absent from the printed
# set and the secret scrub — the unsafe direction of a set mismatch.
HF_UPLOAD_IGNORE_PATTERNS: tuple[str, ...] = (
    ".git/**",
    "**/.git/**",
    "*.sqlite-wal",
    "**/*.sqlite-wal",
    "*.sqlite-shm",
    "**/*.sqlite-shm",
    ".locks/**",
    "**/.locks/**",
    "orchestrator.sqlite",
    "**/orchestrator.sqlite",
    "*.lock",
    "**/*.lock",
    "tmp/**",
    "**/tmp/**",
    "__pycache__/**",
    "**/__pycache__/**",
)

MANIFEST_RELPATH = "meta/publish_manifest.json"

# Credential shapes refused by the pre-upload secret scrub. Byte patterns so
# the (binary) SQLite snapshots are scanned too. Findings report file + pattern
# name only — never the matched text.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    ("bearer_token", re.compile(rb"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{20,}")),
    ("sk_prefixed_key", re.compile(rb"\bsk-[A-Za-z0-9_\-]{20,}")),
    ("eliza_prefixed_key", re.compile(rb"\beliza_[A-Za-z0-9]{24,}")),
    ("hf_prefixed_token", re.compile(rb"\bhf_[A-Za-z0-9]{20,}")),
    ("aws_access_key_id", re.compile(rb"\bAKIA[0-9A-Z]{16}\b")),
    (
        "aws_secret_access_key",
        re.compile(rb"(?i)aws_secret_access_key[\"']?\s*[=:]\s*[\"']?[A-Za-z0-9/+=]{30,}"),
    ),
    ("pem_private_key", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
)

# Projection order for exports/runs.jsonl. Scalars ship as native JSONL
# columns; structured columns ship as canonical JSON strings (``*_json``) so
# the HF dataset viewer gets one stable per-config schema instead of a merge
# of every benchmark's metrics shape.
_RUNS_SCALAR_FIELDS: tuple[str, ...] = (
    "run_id",
    "run_group_id",
    "signature",
    "benchmark_id",
    "benchmark_directory",
    "status",
    "attempt",
    "agent",
    "provider",
    "model",
    "started_at",
    "ended_at",
    "duration_seconds",
    "cwd",
    "stdout_path",
    "stderr_path",
    "result_json_path",
    "score",
    "unit",
    "higher_is_better",
    "trajectory_count",
    "llm_call_count",
    "total_prompt_tokens",
    "total_completion_tokens",
    "total_cache_read_input_tokens",
    "total_cache_creation_input_tokens",
    "mean_latency_ms",
    "p95_latency_ms",
    "throughput_per_second",
    "error",
    "high_score_label",
    "high_score_value",
    "delta_to_high_score",
    "benchmark_version",
    "benchmarks_commit",
    "eliza_commit",
    "eliza_version",
)
_RUNS_JSON_FIELDS: tuple[str, ...] = (
    "extra_config",
    "command",
    "metrics",
    "trajectory_summary",
    "token_metrics",
    "cache_metrics",
    "performance_metrics",
    "artifacts",
)

_RUN_GROUPS_SCALAR_FIELDS: tuple[str, ...] = (
    "run_group_id",
    "created_at",
    "finished_at",
    "execution_namespace",
    "checkpoint_relpath",
    "cohort_status",
    "pause_retry_at",
    "pause_reason",
    "updated_at",
)
_RUN_GROUPS_JSON_FIELDS: tuple[str, ...] = (
    "request",
    "benchmarks",
    "repo_meta",
    "execution_contract",
    "pause_metadata",
    "storage_preflight",
)


class PublishRefusedError(RuntimeError):
    """A fail-closed refusal (gates, token, secrets, setup) with an operator message."""


@dataclass(frozen=True)
class PublishReport:
    """Everything the CLI prints and the tests assert about one publish attempt."""

    repo_id: str
    dry_run: bool
    private: bool
    skip_gates: bool
    gates_ok: bool
    gate_findings: tuple[str, ...]
    refusals: tuple[str, ...]
    run_group_ids: tuple[str, ...]
    eliza_commit: str | None
    upload_files: tuple[tuple[str, int], ...]
    skipped_oversize: tuple[tuple[str, int], ...]
    secret_findings: tuple[str, ...]
    export_counts: dict[str, int]
    db_snapshot: str
    nested_commit: str | None
    hf_result: str | None

    @property
    def would_publish(self) -> bool:
        return not self.refusals

    @property
    def upload_total_bytes(self) -> int:
        return sum(size for _, size in self.upload_files)


def resolve_hf_token() -> str | None:
    """HF_TOKEN wins over HUGGINGFACE_HUB_TOKEN; blank counts as absent."""
    for name in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def publish_to_hf(
    workspace_root: Path,
    *,
    repo_id: str,
    dry_run: bool,
    private: bool = True,
    skip_gates: bool = False,
    check_runtime_gates: bool = True,
    max_file_bytes: int = MAX_UPLOAD_FILE_BYTES,
) -> PublishReport:
    """Validate, regenerate, commit, and upload ``benchmark_results`` as a dataset.

    ``dry_run`` performs every local step (gates, exports, DB snapshot,
    relativization, manifest, secret scan) and computes the exact would-upload
    set, but never commits the nested repo, needs no token, and touches
    nothing remote. Refusals surface as ``report.refusals`` in dry-run and as
    :class:`PublishRefusedError` on a real publish.
    """
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    repo_root = workspace_root.parent
    _require_nested_repo(output_root)

    token: str | None = None
    if not dry_run:
        token = resolve_hf_token()
        if token is None:
            raise PublishRefusedError(
                "no HuggingFace token configured: set HF_TOKEN (or "
                "HUGGINGFACE_HUB_TOKEN) to a write token for the target org, "
                "or pass --dry-run to preview without uploading"
            )

    with latest_publication_lock(output_root):
        readiness = validate_latest_readiness(
            workspace_root,
            check_runtime_gates=check_runtime_gates,
        )
        guard = build_artifact_guard_report(workspace_root)
        gates_ok = readiness.ok and guard.ok
        gate_findings = _gate_finding_lines(readiness, guard)
        refusals: list[str] = []
        if not gates_ok:
            summary = (
                f"latest/ rows fail the publication gates ({len(gate_findings)} "
                "finding(s)); failing rows may only be published under the "
                "quarantine/ path they already occupy. Fix the findings or "
                "rerun with --skip-gates (recorded in the manifest)."
            )
            if skip_gates:
                logger.warning(
                    "[HfPublish] gates failed but --skip-gates was passed; "
                    "publishing anyway with %d finding(s) recorded in %s",
                    len(gate_findings),
                    MANIFEST_RELPATH,
                )
            else:
                refusals.append(summary)
                if not dry_run:
                    raise PublishRefusedError(
                        summary + "\n" + "\n".join(f"- {line}" for line in gate_findings)
                    )

        replacements = _path_replacements(output_root, repo_root)
        conn = connect_database(output_root / "orchestrator.sqlite")
        initialize_database(conn)
        run_group_ids = tuple(
            str(group["run_group_id"]) for group in list_run_groups(conn, limit=1_000_000)
        )
        export_counts = _write_exports(conn, output_root, replacements)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        db_snapshot = _write_db_snapshot(conn, output_root, stamp)
        conn.close()
        _relativize_snapshot_dirs(output_root, replacements)

        eliza_commit = git_head(repo_root)
        upload_files, skipped_oversize = _collect_upload_files(
            output_root,
            ignore_patterns=HF_UPLOAD_IGNORE_PATTERNS,
            max_file_bytes=max_file_bytes,
        )
        _write_manifest(
            output_root,
            replacements,
            repo_id=repo_id,
            dry_run=dry_run,
            private=private,
            skip_gates=skip_gates,
            gates_ok=gates_ok,
            readiness=readiness,
            guard=guard,
            eliza_commit=eliza_commit,
            run_group_ids=run_group_ids,
            upload_files=upload_files,
            skipped_oversize=skipped_oversize,
            max_file_bytes=max_file_bytes,
            export_counts=export_counts,
            db_snapshot=db_snapshot,
        )
        # The manifest is part of the published set; re-walk so its own entry
        # (and nothing else) joins the list with its real size.
        upload_files, skipped_oversize = _collect_upload_files(
            output_root,
            ignore_patterns=HF_UPLOAD_IGNORE_PATTERNS,
            max_file_bytes=max_file_bytes,
        )

        secret_findings = _scan_for_secrets(output_root, upload_files)
        if secret_findings:
            message = (
                "secret scrub refused the upload: credential-shaped content in "
                + ", ".join(secret_findings)
                + ". Remove or redact these before publishing."
            )
            refusals.append(message)
            if not dry_run:
                raise PublishRefusedError(message)

        # Relativization covers the derived JSON but not raw run artifacts or
        # the sqlite snapshot (rewriting captured logs would mutate evidence).
        # Those may embed absolute host paths, which is acceptable for the
        # default private dataset but not for a public one.
        if not private:
            host_path_findings = _scan_for_host_paths(output_root, upload_files)
            if host_path_findings:
                message = (
                    "public publish refused: absolute host paths in "
                    + ", ".join(host_path_findings)
                    + ". Publish privately, or redact these artifacts first."
                )
                refusals.append(message)
                if not dry_run:
                    raise PublishRefusedError(message)

        nested_commit: str | None = None
        hf_result: str | None = None
        if not dry_run and not refusals:
            nested_commit = auto_commit_run_groups(
                output_root,
                run_group_ids,
                eliza_commit=eliza_commit,
                context="publish-hf" + (" gates=SKIPPED" if skip_gates and not gates_ok else ""),
            )
            hf_result = _upload_to_hub(
                output_root,
                repo_id=repo_id,
                token=token or "",
                private=private,
                nested_commit=nested_commit,
                run_group_ids=run_group_ids,
                eliza_commit=eliza_commit,
                extra_ignores=tuple(rel for rel, _ in skipped_oversize),
            )

    return PublishReport(
        repo_id=repo_id,
        dry_run=dry_run,
        private=private,
        skip_gates=skip_gates,
        gates_ok=gates_ok,
        gate_findings=tuple(gate_findings),
        refusals=tuple(refusals),
        run_group_ids=run_group_ids,
        eliza_commit=eliza_commit,
        upload_files=tuple(upload_files),
        skipped_oversize=tuple(skipped_oversize),
        secret_findings=tuple(secret_findings),
        export_counts=export_counts,
        db_snapshot=db_snapshot,
        nested_commit=nested_commit,
        hf_result=hf_result,
    )


def auto_commit_run_groups(
    output_root: Path,
    run_group_ids: Sequence[str],
    *,
    eliza_commit: str | None,
    context: str = "run-group",
) -> str:
    """Commit the whole results tree to the nested repo. Local only — never a push.

    This is the per-run-group audit hook: the publish flow calls it once with
    every group it ships; a future runner integration calls it with the single
    group a cohort just finished.
    """
    _require_nested_repo(output_root)
    message = (
        f"{context}: rg={_format_run_group_ids(run_group_ids)} "
        f"eliza_commit={eliza_commit or 'unknown'}"
    )
    _run_git(output_root, "add", "-A")
    status = _run_git(output_root, "status", "--porcelain")
    if status.strip():
        _run_git(output_root, "commit", "-q", "-m", message)
    return _run_git(output_root, "rev-parse", "HEAD").strip()


def print_publish_report(report: PublishReport) -> None:
    mode = "DRY RUN" if report.dry_run else "PUBLISH"
    visibility = "private" if report.private else "public"
    print(f"publish-hf [{mode}] repo={report.repo_id} ({visibility})")
    print(
        f"Gates: {'ok' if report.gates_ok else 'FAILED'} "
        f"findings={len(report.gate_findings)} skip_gates={report.skip_gates}"
    )
    if not report.gates_ok:
        for line in report.gate_findings[:20]:
            print(f"- {line}")
        if len(report.gate_findings) > 20:
            print(f"- ... {len(report.gate_findings) - 20} more finding(s)")
    if report.skip_gates and not report.gates_ok:
        print(
            "WARNING: --skip-gates bypassed FAILING publication gates. The "
            f"published data does not meet the fail-closed bar; {MANIFEST_RELPATH} "
            "records the bypass and every finding."
        )
    print(
        f"Run groups: {len(report.run_group_ids)} "
        f"({_format_run_group_ids(report.run_group_ids)})"
    )
    print(f"eliza_commit: {report.eliza_commit or 'unknown'}")
    print(
        f"Exports: runs={report.export_counts.get('runs')} "
        f"run_groups={report.export_counts.get('run_groups')} "
        f"trajectory_turns={report.export_counts.get('trajectory_turns')}"
    )
    print(f"DB snapshot: {report.db_snapshot}")
    print(f"{'Would upload' if report.dry_run else 'Upload set'}: {len(report.upload_files)} file(s), {report.upload_total_bytes} bytes")
    for rel, size in report.upload_files:
        print(f"- {rel} ({size} bytes)")
    if report.skipped_oversize:
        print(f"Skipped over size cap ({len(report.skipped_oversize)} file(s), listed in {MANIFEST_RELPATH}):")
        for rel, size in report.skipped_oversize:
            print(f"- {rel} ({size} bytes)")
    if report.secret_findings:
        print("Secret scrub findings (upload refused until removed):")
        for finding in report.secret_findings:
            print(f"- {finding}")
    if report.refusals:
        print("PUBLISH " + ("WOULD BE " if report.dry_run else "") + "REFUSED:")
        for refusal in report.refusals:
            print(f"- {refusal}")
    elif report.dry_run:
        print("Dry run complete: nothing was committed or uploaded.")
    else:
        print(f"Nested repo commit: {report.nested_commit}")
        print(f"HF upload: {report.hf_result}")


def _require_nested_repo(output_root: Path) -> None:
    # `git -C output_root rev-parse` would resolve to the surrounding monorepo,
    # so the nested repo is detected by its own .git directory.
    if not (output_root / ".git").exists():
        raise PublishRefusedError(
            f"{output_root} is not a git repository. The results tree carries "
            "its own nested audit-log repo: run `git init -b main` there and "
            "add the results .gitignore before publishing."
        )


def _run_git(output_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(output_root), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed in {output_root}: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout


def _format_run_group_ids(run_group_ids: Sequence[str], limit: int = 8) -> str:
    ids = list(run_group_ids)
    if not ids:
        return "none"
    shown = ", ".join(ids[:limit])
    if len(ids) > limit:
        shown += f", ... +{len(ids) - limit} more"
    return shown


def _gate_finding_lines(
    readiness: ReadinessReport, guard: ArtifactGuardReport
) -> list[str]:
    lines = [
        f"{finding.scope}: {finding.reason} value={finding.value}"
        for finding in readiness.findings
    ]
    lines.extend(
        f"artifact-guard: generated artifact is committed: {path}"
        for path in guard.offending
    )
    return lines


def _path_replacements(output_root: Path, repo_root: Path) -> tuple[tuple[str, str], ...]:
    # Longest prefix first: output_root lives under repo_root, repo_root
    # (usually) under home. Applied as substring rewrites so paths embedded
    # mid-string (argv, error messages) are cleaned too.
    return (
        (str(output_root), "."),
        (str(repo_root), REPO_ROOT_PLACEHOLDER),
        (str(Path.home()), "~"),
    )


def _relativize(value: Any, replacements: tuple[tuple[str, str], ...]) -> Any:
    if isinstance(value, str):
        for old, new in replacements:
            value = value.replace(old + "/", new + "/")
            if value == old:
                value = new
        return value
    if isinstance(value, list):
        return [_relativize(item, replacements) for item in value]
    if isinstance(value, dict):
        return {
            _relativize(key, replacements): _relativize(item, replacements)
            for key, item in value.items()
        }
    return value


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _dump_json(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True)


def _jsonl_field(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _write_exports(
    conn: sqlite3.Connection,
    output_root: Path,
    replacements: tuple[tuple[str, str], ...],
) -> dict[str, int]:
    exports_dir = output_root / "exports"

    # Oldest-first for a stable, append-shaped table (list_runs returns newest-first).
    runs = [_relativize(record, replacements) for record in reversed(list_runs(conn, limit=None))]
    run_rows = [
        {
            **{field: record[field] for field in _RUNS_SCALAR_FIELDS},
            **{
                f"{field}_json": _jsonl_field(record.get(field))
                for field in _RUNS_JSON_FIELDS
            },
        }
        for record in runs
    ]
    _atomic_write_text(
        exports_dir / "runs.jsonl",
        "".join(_jsonl_field(row) + "\n" for row in run_rows),
    )

    groups = [
        _relativize(record, replacements)
        for record in reversed(list_run_groups(conn, limit=1_000_000))
    ]
    group_rows = [
        {
            **{field: record[field] for field in _RUN_GROUPS_SCALAR_FIELDS},
            **{
                f"{field}_json": _jsonl_field(record.get(field))
                for field in _RUN_GROUPS_JSON_FIELDS
            },
        }
        for record in groups
    ]
    _atomic_write_text(
        exports_dir / "run_groups.jsonl",
        "".join(_jsonl_field(row) + "\n" for row in group_rows),
    )

    turn_rows = [
        _relativize(dict(row), replacements)
        for row in conn.execute(
            """
            SELECT run_id, trajectory_file, turn_index, prompt_tokens,
                   completion_tokens, total_tokens, cached_tokens,
                   cache_creation_tokens, latency_ms, prompt_chars
            FROM benchmark_run_trajectories
            ORDER BY run_id ASC, trajectory_file ASC, turn_index ASC
            """
        ).fetchall()
    ]
    _atomic_write_text(
        exports_dir / "trajectory_turns.jsonl",
        "".join(_jsonl_field(row) + "\n" for row in turn_rows),
    )

    return {
        "runs": len(run_rows),
        "run_groups": len(group_rows),
        "trajectory_turns": len(turn_rows),
    }


def _write_db_snapshot(conn: sqlite3.Connection, output_root: Path, stamp: str) -> str:
    snapshot_dir = output_root / "db_snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    target = snapshot_dir / f"orchestrator-{stamp}.sqlite"
    # Same-second re-publish replaces its own snapshot; VACUUM INTO refuses
    # to overwrite an existing file.
    if target.exists():
        target.unlink()
    conn.commit()
    conn.execute("VACUUM INTO ?", (str(target),))
    # Latest-only on-disk retention: prior snapshots survive in the nested
    # repo's git history (the audit log), so keeping them on disk only grows
    # every future upload set — and a campaign-sized snapshot would trip the
    # per-file cap and silently drop ALL snapshots out of the upload.
    for stale in sorted(snapshot_dir.glob("orchestrator-*.sqlite")):
        if stale != target:
            stale.unlink()
    return f"db_snapshots/{target.name}"


def _relativize_snapshot_dirs(
    output_root: Path, replacements: tuple[tuple[str, str], ...]
) -> list[str]:
    """Rewrite absolute host paths in published derived JSON, in place.

    The runner re-embeds absolute paths on its next rebuild; every publish
    re-relativizes, so local tooling that regenerates these files is unaffected.
    """
    changed: list[str] = []
    candidates = [
        path
        for directory in ("latest", "quarantine", "baselines")
        for path in sorted((output_root / directory).glob("*.json"))
        if (output_root / directory).exists()
    ]
    viewer_data = output_root / "viewer_data.json"
    if viewer_data.exists():
        candidates.append(viewer_data)
    for path in candidates:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rewritten = _relativize(payload, replacements)
        if rewritten != payload:
            _atomic_write_text(path, _dump_json(rewritten))
            changed.append(path.relative_to(output_root).as_posix())
    return changed


def _matches_ignore_pattern(rel: str, pattern: str) -> bool:
    if pattern.endswith("/**"):
        prefix = pattern[: -len("**")]
        return rel.startswith(prefix) or f"/{prefix}" in rel
    basename = rel.rsplit("/", 1)[-1]
    return fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(basename, pattern)


def _is_ignored(rel: str, patterns: Sequence[str]) -> bool:
    return any(_matches_ignore_pattern(rel, pattern) for pattern in patterns)


def _collect_upload_files(
    output_root: Path,
    *,
    ignore_patterns: Sequence[str],
    max_file_bytes: int,
) -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    files: list[tuple[str, int]] = []
    skipped: list[tuple[str, int]] = []
    for path in sorted(output_root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(output_root).as_posix()
        if _is_ignored(rel, ignore_patterns):
            continue
        size = path.stat().st_size
        if size > max_file_bytes:
            skipped.append((rel, size))
        else:
            files.append((rel, size))
    return files, skipped


def _write_manifest(
    output_root: Path,
    replacements: tuple[tuple[str, str], ...],
    *,
    repo_id: str,
    dry_run: bool,
    private: bool,
    skip_gates: bool,
    gates_ok: bool,
    readiness: ReadinessReport,
    guard: ArtifactGuardReport,
    eliza_commit: str | None,
    run_group_ids: tuple[str, ...],
    upload_files: list[tuple[str, int]],
    skipped_oversize: list[tuple[str, int]],
    max_file_bytes: int,
    export_counts: dict[str, int],
    db_snapshot: str,
) -> None:
    payload = {
        "schema": "eliza.benchmark_results_publish_manifest.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "repo_id": repo_id,
        "dry_run": dry_run,
        "private": private,
        "skip_gates": skip_gates,
        "gates": {
            "ok": gates_ok,
            "readiness": json.loads(readiness.to_json()),
            "artifact_guard": {
                "ok": guard.ok,
                "checked_count": guard.checked_count,
                "offending": list(guard.offending),
            },
        },
        "monorepo_commit": eliza_commit,
        "run_group_ids": list(run_group_ids),
        "exports": export_counts,
        "db_snapshot": db_snapshot,
        "max_upload_file_bytes": max_file_bytes,
        "upload_file_count": len(upload_files),
        "upload_total_bytes": sum(size for _, size in upload_files),
        "skipped_oversize": [
            {"path": rel, "size_bytes": size} for rel, size in skipped_oversize
        ],
    }
    _atomic_write_text(
        output_root / MANIFEST_RELPATH,
        _dump_json(_relativize(payload, replacements)),
    )


def _scan_for_host_paths(
    output_root: Path, upload_files: Sequence[tuple[str, int]]
) -> list[str]:
    """Files in the upload set that still embed absolute home-dir paths."""
    needles = (b"/home/", b"/Users/", b"/root/")
    findings: list[str] = []
    for rel, _size in upload_files:
        data = (output_root / rel).read_bytes()
        if any(needle in data for needle in needles):
            findings.append(rel)
    return findings


def _scan_for_secrets(
    output_root: Path, upload_files: Sequence[tuple[str, int]]
) -> list[str]:
    findings: list[str] = []
    for rel, _size in upload_files:
        data = (output_root / rel).read_bytes()
        matched = sorted(
            {name for name, pattern in _SECRET_PATTERNS if pattern.search(data)}
        )
        if matched:
            findings.append(f"{rel} ({', '.join(matched)})")
    return findings


def _upload_to_hub(
    output_root: Path,
    *,
    repo_id: str,
    token: str,
    private: bool,
    nested_commit: str,
    run_group_ids: tuple[str, ...],
    eliza_commit: str | None,
    extra_ignores: tuple[str, ...],
) -> str:
    import huggingface_hub

    api = huggingface_hub.HfApi(token=token)
    api.create_repo(
        repo_id=repo_id,
        repo_type="dataset",
        private=private,
        exist_ok=True,
    )
    # upload_folder, never git push: the Hub caps non-LFS git files at 10MB,
    # while the HTTP commit API routes large files through LFS automatically.
    result = api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(output_root),
        ignore_patterns=[*HF_UPLOAD_IGNORE_PATTERNS, *extra_ignores],
        commit_message=(
            f"publish-hf {nested_commit} "
            f"rg={_format_run_group_ids(run_group_ids)} "
            f"eliza_commit={eliza_commit or 'unknown'}"
        ),
    )
    return str(result)
