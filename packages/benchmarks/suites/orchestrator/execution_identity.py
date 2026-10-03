"""Binds benchmark resume and provider checkpoints to complete execution inputs.

Comparison grouping is deliberately separate from this source-sensitive cache
identity. Generated output and dependency caches do not change an execution;
runtime source, revisions, corpus, harnesses, and lockfiles do.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from benchmarks.lib.repository import monorepo_root

from .types import BenchmarkAdapter, RunRequest


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


_STORAGE_CONTROL_KEYS = frozenset(
    {
        "campaign_storage_min_free_bytes",
        "campaign_storage_expected_headroom_bytes",
        "campaign_storage_check_interval_s",
    }
)
_NAMESPACE_RUNTIME_KEYS = _STORAGE_CONTROL_KEYS | frozenset(
    {
        "_replace_adapter_defaults",
        "campaign_silent_timeout_s",
        "claude_subscription_gateway_url",
        "eliza_bench_http_timeout_s",
        "hermes_timeout_s",
        "hl_bench_command_timeout_s",
        "openclaw_timeout_s",
        "timeout_s",
    }
)
_FINGERPRINT_EXCLUDED_PARTS = frozenset(
    {
        ".cache",
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".turbo",
        ".venv",
        "__pycache__",
        "artifacts",
        "benchmark_results",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "outputs",
        "results",
        "runs",
        "venv",
    }
)


@dataclass(frozen=True)
class PhaseExecutionIdentity:
    namespace: str
    contract: Mapping[str, object]
    checkpoint_relpath: str


def build_phase_execution_identity(
    *,
    workspace_root: Path,
    adapter: BenchmarkAdapter,
    request: RunRequest,
    harnesses: tuple[str, ...],
    repo_meta: Mapping[str, str | None],
) -> PhaseExecutionIdentity:
    """Build the PID/run-group-independent replay identity for one phase."""

    extra = dict(request.extra_config)
    dataset_config = {
        key: value
        for key, value in extra.items()
        if key not in _NAMESPACE_RUNTIME_KEYS
        and key
        not in {
            "campaign_corpus_sha256",
            "campaign_phase",
            "campaign_profile",
            "reasoning_effort",
        }
    }
    source_fingerprint = _relevant_source_fingerprint(
        workspace_root=workspace_root,
        adapter=adapter,
    )
    explicit_corpus = extra.get("campaign_corpus_sha256")
    if explicit_corpus is not None and (
        not isinstance(explicit_corpus, str) or not explicit_corpus.strip()
    ):
        raise ValueError("campaign_corpus_sha256 must be a non-empty string")
    corpus_sha256 = (
        explicit_corpus.strip()
        if isinstance(explicit_corpus, str)
        else hashlib.sha256(
            _canonical_json(
                {
                    "adapter_directory": adapter.directory,
                    "benchmarks_commit": repo_meta.get("benchmarks_commit"),
                    "dataset_config": dataset_config,
                    "source_fingerprint_sha256": source_fingerprint,
                }
            ).encode("utf-8")
        ).hexdigest()
    )
    contract: dict[str, object] = {
        "schema_version": 2,
        "repositories": dict(repo_meta),
        "campaign_profile": str(extra.get("campaign_profile") or "ad-hoc"),
        "benchmark_id": adapter.id,
        "benchmark_directory": adapter.directory,
        "phase": str(extra.get("campaign_phase") or "single"),
        "dataset_config": dataset_config,
        "corpus_sha256": corpus_sha256,
        "source_fingerprint_sha256": source_fingerprint,
        "model": request.model.strip(),
        "provider": request.provider.strip().lower(),
        "reasoning_effort": str(extra.get("reasoning_effort") or "").strip().lower(),
        "harnesses": list(harnesses),
    }
    digest = hashlib.sha256(_canonical_json(contract).encode("utf-8")).hexdigest()
    namespace = f"benchmark-phase-v2-{digest}"
    return PhaseExecutionIdentity(
        namespace=namespace,
        contract=contract,
        checkpoint_relpath=(f".subscription-checkpoints/{namespace}/responses.jsonl"),
    )


def _relevant_source_fingerprint(
    *,
    workspace_root: Path,
    adapter: BenchmarkAdapter,
) -> str:
    """Hash dirty source/corpus inputs that a Git HEAD cannot represent."""

    benchmarks_root = workspace_root / "suites"
    runtime_root = monorepo_root(workspace_root)
    candidate_roots = (
        benchmarks_root / adapter.directory,
        benchmarks_root / "orchestrator",
        benchmarks_root / "claude-subscription-gateway",
        workspace_root / "harnesses",
        runtime_root / "plugins",
        *(p for p in sorted((runtime_root / "packages").glob("*")) if p != workspace_root),
        runtime_root / "package.json",
        runtime_root / "bun.lock",
        runtime_root / "patches",
        workspace_root / "registry",
        workspace_root / "framework",
        workspace_root / "lib",
        workspace_root / "package.json",
        workspace_root / "bun.lock",
        workspace_root / "bun.lockb",
        *sorted(workspace_root.glob("*.py")),
    )
    files: set[Path] = set()
    for root in candidate_roots:
        if root.is_file():
            files.add(root)
            continue
        if not root.is_dir():
            continue
        for directory, subdirs, names in os.walk(root, followlinks=False):
            subdirs[:] = sorted(
                name
                for name in subdirs
                if name not in _FINGERPRINT_EXCLUDED_PARTS
                and not (Path(directory) / name).is_symlink()
            )
            for name in names:
                path = Path(directory) / name
                if name.startswith(".env") or path.is_symlink():
                    continue
                if path.is_file():
                    files.add(path)
    digest = hashlib.sha256()
    fingerprint_base = runtime_root
    for path in sorted(files, key=lambda value: value.as_posix()):
        relative = path.relative_to(fingerprint_base).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(path.stat().st_size.to_bytes(8, "big"))
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()
