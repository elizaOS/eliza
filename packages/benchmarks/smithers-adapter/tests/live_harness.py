"""Helpers for tests that run the real Smithers Bun harness locally."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

_HARNESS_DEPS = (
    ("smithers-orchestrator", ("smithers-orchestrator@*", "smithers-orchestrator")),
    ("@ai-sdk/openai", ("@ai-sdk+openai@*", "@ai-sdk/openai")),
    ("ai", ("ai@*", "ai")),
    ("zod", ("zod@*", "zod")),
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _dep_exists(node_modules: Path, dep: str) -> bool:
    return (node_modules / dep).exists()


def _has_harness_deps(node_modules: Path) -> bool:
    return all(_dep_exists(node_modules, dep) for dep, _ in _HARNESS_DEPS)


def _find_bun_store_dep(repo_root: Path, pattern: str, package_path: str) -> Path | None:
    bun_root = repo_root / "node_modules" / ".bun"
    matches = sorted(bun_root.glob(f"{pattern}/node_modules/{package_path}"))
    return matches[-1] if matches else None


def _symlink_dep(node_modules: Path, dep: str, source: Path) -> None:
    target = node_modules / dep
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return
    target.symlink_to(source, target_is_directory=True)


def materialize_live_smithers_install(install_dir: Path) -> None:
    """Create a Smithers install usable by ``SmithersClient`` tests.

    The preferred path uses the repository's Bun store so tests do not mutate
    the checkout or download packages. Setting ``SMITHERS_LIVE_SUBPROCESS_PROOF=1``
    allows a temporary ``bun add`` fallback for machines without the store.
    """
    repo_root = _repo_root()
    install_dir.mkdir(parents=True, exist_ok=True)

    for candidate in (
        repo_root / "node_modules",
        repo_root / "plugins" / "plugin-workflow" / "node_modules",
    ):
        if _has_harness_deps(candidate):
            (install_dir / "node_modules").symlink_to(candidate, target_is_directory=True)
            return

    node_modules = install_dir / "node_modules"
    for dep, (pattern, package_path) in _HARNESS_DEPS:
        source = _find_bun_store_dep(repo_root, pattern, package_path)
        if source is None:
            break
        _symlink_dep(node_modules, dep, source)
    else:
        return

    if os.environ.get("SMITHERS_LIVE_SUBPROCESS_PROOF") != "1":
        pytest.skip(
            "set SMITHERS_LIVE_SUBPROCESS_PROOF=1 to provision JS deps and run the live Smithers proof"
        )

    (install_dir / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
    subprocess.run(
        [
            os.environ.get("BUN_BIN", "bun"),
            "add",
            "smithers-orchestrator@0.26.1",
            "@ai-sdk/openai",
            "ai",
            "zod",
        ],
        cwd=install_dir,
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
