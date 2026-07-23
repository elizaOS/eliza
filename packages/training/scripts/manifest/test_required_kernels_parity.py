"""Keeps the Python manifest publisher and TypeScript runtime kernel requirements identical."""

from __future__ import annotations

import re
from pathlib import Path

from scripts.manifest.eliza1_manifest import (
    ELIZA_1_TIERS,
    RECIPE_TARGETS_BY_REQUIRED_KERNEL,
    REQUIRED_KERNELS_BY_TIER,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
SCHEMA_TS = (
    REPO_ROOT
    / "plugins"
    / "plugin-local-inference"
    / "src"
    / "services"
    / "manifest"
    / "schema.ts"
)

def _parse_schema_map(name: str) -> dict[str, list[str]]:
    """Extract a ``Record<Eliza1Tier, …>`` string-array literal from schema.ts.

    The maps are plain object literals of string arrays, e.g.::

        export const REQUIRED_KERNELS_BY_TIER: … = {
            "2b": ["turboquant_q4"],
            …
        };

    so a regex lift is sufficient and avoids depending on a JS/TS parser.
    """
    source = SCHEMA_TS.read_text(encoding="utf-8")
    decl = re.search(
        rf"export const {re.escape(name)}\s*:\s*[^=]*=\s*\{{(.*?)\n\}};",
        source,
        re.DOTALL,
    )
    if decl is None:
        raise AssertionError(
            f"could not locate `export const {name}` object literal in {SCHEMA_TS}"
        )
    body = decl.group(1)

    parsed: dict[str, list[str]] = {}
    for tier_match in re.finditer(
        r'"(?P<tier>[^"]+)"\s*:\s*\[(?P<items>[^\]]*)\]', body
    ):
        tier = tier_match.group("tier")
        items = re.findall(r'"([^"]+)"', tier_match.group("items"))
        parsed[tier] = items
    if not parsed:
        raise AssertionError(f"parsed zero tiers from `{name}` in {SCHEMA_TS}")
    return parsed


def test_schema_file_present() -> None:
    assert SCHEMA_TS.is_file(), f"schema.ts not found at {SCHEMA_TS}"


def test_tier_sets_match() -> None:
    """Both surfaces enumerate the same Eliza-1 tiers."""
    ts_required = _parse_schema_map("REQUIRED_KERNELS_BY_TIER")
    ts_optional = _parse_schema_map("OPTIONAL_KERNELS_BY_TIER")
    py_tiers = set(REQUIRED_KERNELS_BY_TIER)

    assert set(ts_required) == py_tiers, (
        "schema.ts REQUIRED_KERNELS_BY_TIER tiers diverge from Python: "
        f"ts={sorted(ts_required)} py={sorted(py_tiers)}"
    )
    assert set(ts_optional) == py_tiers, (
        "schema.ts OPTIONAL_KERNELS_BY_TIER tiers diverge from Python: "
        f"ts={sorted(ts_optional)} py={sorted(py_tiers)}"
    )
    assert set(ELIZA_1_TIERS) == py_tiers, (
        "Python ELIZA_1_TIERS diverge from REQUIRED_KERNELS_BY_TIER keys"
    )


def test_kernel_vocabulary_matches() -> None:
    """Every required runtime kernel has a Python quantization recipe mapping."""
    ts_required = _parse_schema_map("REQUIRED_KERNELS_BY_TIER")

    ts_kernels: set[str] = set()
    for kernels in ts_required.values():
        ts_kernels.update(kernels)

    known = set(RECIPE_TARGETS_BY_REQUIRED_KERNEL)
    unknown = ts_kernels - known
    assert not unknown, (
        "schema.ts names kernel(s) with no Python recipe-target mapping "
        f"in RECIPE_TARGETS_BY_REQUIRED_KERNEL: {sorted(unknown)}"
    )


def test_required_kernels_match_exactly() -> None:
    """The publisher and runtime reject any per-tier requirement drift."""
    ts_required = _parse_schema_map("REQUIRED_KERNELS_BY_TIER")

    for tier in ELIZA_1_TIERS:
        py_req = set(REQUIRED_KERNELS_BY_TIER[tier])
        ts_req = set(ts_required[tier])
        assert py_req == ts_req, (
            f"tier {tier}: Python and TypeScript required kernels diverge. "
            f"python={sorted(py_req)} typescript={sorted(ts_req)}"
        )


def test_every_python_required_kernel_has_a_recipe_target() -> None:
    """Each Python-required kernel maps to at least one recipe target.

    Guards the second Python contract surface: the validator only emits a
    publish-ready manifest when every required kernel resolves to recipe
    metadata, so a required kernel with no ``RECIPE_TARGETS`` entry is an
    unbuildable contract.
    """
    for tier in ELIZA_1_TIERS:
        for kernel in REQUIRED_KERNELS_BY_TIER[tier]:
            targets = RECIPE_TARGETS_BY_REQUIRED_KERNEL.get(kernel)
            assert targets, (
                f"tier {tier}: required kernel {kernel!r} has no recipe target "
                f"in RECIPE_TARGETS_BY_REQUIRED_KERNEL"
            )
