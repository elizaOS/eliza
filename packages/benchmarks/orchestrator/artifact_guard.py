"""Guard against committing generated benchmark output (#10199).

Acceptance criterion for the benchmark review flow: *"The script fails clearly
when ... generated artifacts would be committed accidentally"* and *"Keep
generated run output ignored; commit only final reviewed markdown scorecards and
lightweight manifests."*

`benchmarks/CLAUDE.md` is explicit: anything under ``benchmark_results/`` and
per-benchmark run output (result JSON, SQLite DBs, trajectories, logs, coverage)
is generated and must never be committed. The repo ``.gitignore`` encodes this
with a handful of ``!`` negations for the three intentionally-reviewed artifacts.

This module turns that convention into an enforceable gate. It classifies a
repo-relative path as a generated artifact by matching **directory components**
(``benchmark_results``/``benchmark_results*``/``test_output``/``trajectories``)
and the two generated trajectory filenames — never a bare substring, so source
files like ``frontend/assets/trajectories.js`` or ``tests/test_outputs.py`` are
never flagged. The three ``.gitignore``-negated reviewed artifacts are
allow-listed here to stay in 1:1 sync with the ignore rules.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

# Mirrors the ``!`` negations under ``benchmark_results/`` in the repo
# ``.gitignore``: the reviewed artifacts that ARE intentionally committed.
ALLOWLISTED_REVIEWED_ARTIFACTS: frozenset[str] = frozenset(
    {
        "benchmark_results/bfcl/bfcl_best_results.json",
        "benchmark_results/mint/MINT-BENCHMARK-REPORT.md",
        "benchmark_results/mint/mint-benchmark-results.json",
    }
)

# Generated files that live outside a generated directory but are still output.
GENERATED_FILENAMES: frozenset[str] = frozenset(
    {"trajectories.art.jsonl", "trajectories.grpo.groups.json"}
)

GitRunner = Callable[[list[str]], str]


def _normalize(path: str) -> str:
    normalized = path.strip().replace("\\", "/")
    return normalized[2:] if normalized.startswith("./") else normalized


def _is_generated_dir_component(component: str) -> bool:
    # ``benchmark_results`` and ``benchmark_results*`` (the ``.gitignore`` glob),
    # plus the ``test_output`` and ``trajectories`` output directories — matched
    # as whole path components so ``test_outputs.py`` / ``trajectories.js`` don't
    # false-positive.
    return (
        component == "test_output"
        or component == "trajectories"
        or component.startswith("benchmark_results")
    )


def _in_benchmark_scope(parts: list[str]) -> bool:
    # The ``.gitignore`` scopes generated output to the benchmark tree
    # (``/benchmarks/**`` → ``packages/benchmarks/…`` or a top-level
    # ``benchmarks/…``) and the repo-root ``benchmark_results/``. A ``trajectories``
    # directory anywhere else — ``packages/core/src/features/trajectories`` source,
    # UI components, or intentionally-committed ``test-results/evidence/…``
    # evidence — is NOT benchmark run output and must never be flagged.
    if parts and parts[0].startswith("benchmark_results"):
        return True
    if "benchmarks" not in parts:
        return False
    index = parts.index("benchmarks")
    return index == 0 or (index == 1 and parts[0] == "packages")


def is_generated_artifact(path: str) -> bool:
    """True when ``path`` (repo-relative) is generated benchmark output that must
    not be committed. Allow-listed reviewed artifacts return ``False``."""
    norm = _normalize(path)
    if not norm:
        return False
    if any(
        norm == allowed or norm.endswith(f"/{allowed}")
        for allowed in ALLOWLISTED_REVIEWED_ARTIFACTS
    ):
        return False
    parts = norm.split("/")
    if not _in_benchmark_scope(parts):
        return False
    if any(_is_generated_dir_component(component) for component in parts[:-1]):
        return True
    return parts[-1] in GENERATED_FILENAMES


def find_committed_generated_artifacts(paths: Iterable[str]) -> tuple[str, ...]:
    """Filter an iterable of repo-relative paths down to the generated artifacts
    that would be committed. Pure — the unit-testable core of the guard."""
    seen: set[str] = set()
    offending: list[str] = []
    for path in paths:
        norm = _normalize(path)
        if norm in seen:
            continue
        seen.add(norm)
        if is_generated_artifact(norm):
            offending.append(norm)
    return tuple(sorted(offending))


@dataclass(frozen=True)
class ArtifactGuardReport:
    ok: bool
    checked_count: int
    offending: tuple[str, ...]

    def to_markdown(self) -> str:
        if self.ok:
            return (
                "# Benchmark artifact guard\n\n"
                f"OK — checked {self.checked_count} tracked file(s); "
                "no generated benchmark output is committed.\n"
            )
        lines = [
            "# Benchmark artifact guard",
            "",
            f"FAILED — {len(self.offending)} generated artifact(s) are committed "
            "or staged and must not be:",
            "",
        ]
        lines.extend(f"- `{path}`" for path in self.offending)
        lines.extend(
            [
                "",
                "Generated benchmark output (result JSON, SQLite DBs, trajectories,"
                " logs, coverage) is gitignored by design — `git rm --cached` these"
                " and keep only reviewed markdown scorecards outside"
                " `benchmark_results/`. See `packages/benchmarks/CLAUDE.md`.",
                "",
            ]
        )
        return "\n".join(lines)


def _default_git_runner(repo_root: Path) -> GitRunner:
    def run(args: list[str]) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout

    return run


def build_artifact_guard_report(
    workspace_root: Path,
    run_git: GitRunner | None = None,
) -> ArtifactGuardReport:
    """Scan the git index (tracked + staged-for-add files) for generated
    benchmark output that would be committed.

    ``run_git`` is injectable so the classifier can be tested without a real
    repository; by default it shells out to ``git ls-files`` at the repo root.
    """
    repo_root = workspace_root.parent  # workspace_root is ``.../packages``
    runner = run_git or _default_git_runner(repo_root)
    tracked = [line for line in runner(["ls-files"]).splitlines() if line.strip()]
    offending = find_committed_generated_artifacts(tracked)
    return ArtifactGuardReport(
        ok=not offending,
        checked_count=len(tracked),
        offending=offending,
    )
