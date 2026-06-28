"""Cross-language parity guard for the Eliza-1 kernel-requirement contract.

The required/optional-kernel-per-tier contract is declared twice:

  * TypeScript  — ``plugins/plugin-local-inference/src/services/manifest/schema.ts``
                  (``REQUIRED_KERNELS_BY_TIER`` / ``OPTIONAL_KERNELS_BY_TIER``),
                  consumed by the runtime + bundle downloader.
  * Python      — ``scripts/manifest/eliza1_manifest.py``
                  (``REQUIRED_KERNELS_BY_TIER`` / ``RECIPE_TARGETS_BY_REQUIRED_KERNEL``),
                  consumed by the manifest builder/validator at publish time.

Historically these two surfaces drifted silently: the Python validator treats
``turbo3_tcq`` as required on every tier, while ``schema.ts`` lists it as
*optional* (Gemma 4 ships stock q8_0 KV; ``turbo3_tcq`` only becomes mandatory
for long-context text variants, enforced separately in the Python validator's
``ctx > 64k`` rule). That single difference is a live product decision
(turbo3_tcq required-on-long-ctx vs optional-everywhere) and is NOT resolved
here — it is *pinned* in ``KNOWN_TIER_DIFFERENCES`` below so it can no longer
change on either side without a hard test failure forcing a re-decision.

Everything else (the kernel vocabulary, the universally-required base weight
quant, the per-tier set membership, and recipe-target coverage of every Python
required kernel) must match exactly. New drift fails CI loudly instead of
shipping a manifest the runtime rejects.
"""

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

# The single, deliberately-retained difference between the two surfaces:
# ``turbo3_tcq`` is required by the Python validator on every tier, but optional
# in schema.ts (it is mandated for long-context text variants by the validator's
# separate ``ctx > 64k`` rule, not by the per-tier required set). Resolving this
# is a maintainer product call (does Gemma's windowed-SWA stock KV displace the
# trellis kernel on the 256k tier?); the guard only keeps it from drifting
# silently. Maps tier -> kernels Python requires that schema.ts marks optional.
KNOWN_TIER_DIFFERENCES: dict[str, frozenset[str]] = {
    tier: frozenset({"turbo3_tcq"}) for tier in ELIZA_1_TIERS
}


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
    """Every kernel named in either schema.ts map is one Python recognizes."""
    ts_required = _parse_schema_map("REQUIRED_KERNELS_BY_TIER")
    ts_optional = _parse_schema_map("OPTIONAL_KERNELS_BY_TIER")

    ts_kernels: set[str] = set()
    for kernels in (*ts_required.values(), *ts_optional.values()):
        ts_kernels.update(kernels)

    known = set(RECIPE_TARGETS_BY_REQUIRED_KERNEL)
    unknown = ts_kernels - known
    assert not unknown, (
        "schema.ts names kernel(s) with no Python recipe-target mapping "
        f"in RECIPE_TARGETS_BY_REQUIRED_KERNEL: {sorted(unknown)}"
    )


def test_required_kernels_agree_modulo_known_differences() -> None:
    """Per tier, Python required == schema.ts required + the pinned differences.

    This is the core guard. The only kernel Python may require beyond the
    schema.ts required set is the explicitly-pinned ``turbo3_tcq``; any other
    addition or removal on either side fails loudly.
    """
    ts_required = _parse_schema_map("REQUIRED_KERNELS_BY_TIER")
    ts_optional = _parse_schema_map("OPTIONAL_KERNELS_BY_TIER")

    for tier in ELIZA_1_TIERS:
        py_req = set(REQUIRED_KERNELS_BY_TIER[tier])
        ts_req = set(ts_required[tier])
        ts_opt = set(ts_optional[tier])
        known_diff = KNOWN_TIER_DIFFERENCES[tier]

        # Python must require everything schema.ts requires.
        missing_in_py = ts_req - py_req
        assert not missing_in_py, (
            f"tier {tier}: schema.ts requires kernel(s) Python does not: "
            f"{sorted(missing_in_py)}"
        )

        # Anything Python requires beyond schema.ts's required set must be (a)
        # an explicitly-pinned known difference, and (b) actually classified
        # optional (not absent) on the schema.ts side.
        extra_in_py = py_req - ts_req
        assert extra_in_py == known_diff, (
            f"tier {tier}: Python-required kernels beyond schema.ts diverge "
            f"from the pinned KNOWN_TIER_DIFFERENCES. extra={sorted(extra_in_py)} "
            f"pinned={sorted(known_diff)}. If this is a real contract change, "
            f"update both surfaces and KNOWN_TIER_DIFFERENCES together."
        )
        assert known_diff <= ts_opt, (
            f"tier {tier}: pinned difference {sorted(known_diff)} is not listed "
            f"as optional in schema.ts (optional={sorted(ts_opt)}); the two "
            f"surfaces now genuinely disagree on this kernel's existence."
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
