"""Regression test: every Eliza-1 SFT training-orchestration script MUST
default to the APOLLO optimizer.

Background (user mandate, 2026-05-12, captured in
``packages/training/AGENTS.md`` and ``packages/training/CLAUDE.md``):

    All eliza-1 SFT training MUST use the APOLLO optimizer
    (apollo-torch). It is NEVER acceptable to silently downgrade to
    ``apollo_mini``, ``adamw``, ``muon``, or any other optimizer.
    ``apollo_mini`` is permitted ONLY when GPU memory forces it, and
    each occurrence MUST be justified inline with one of:

        # OOM: <one-line reason>
        # APOLLO_MINI_REASON: <one-line reason>

    AdamW and Muon are NEVER allowed in a published training run.

This test parses every ``build_eliza1_*.py`` and ``bootstrap_native_*``
training-orchestration script with the standard library ``ast`` module
(no regex on Python source) and asserts:

  * Any explicit optimizer literal is ``"apollo"`` — either as the
    ``default=`` of an ``argparse.add_argument("--optimizer", ...)``
    call, or as an ``optimizer="..."`` keyword to a known training
    entry point, or as a top-level ``optimizer = "..."`` assignment.
  * Any ``"apollo_mini"`` literal appears with a justification comment
    on one of the 5 source lines preceding it.
  * Banned strings (``"adamw"``, ``"muon"``, ``"sgd"``) never appear as
    optimizer literals — even commented-out — anywhere in the scanned
    scripts.

The test is intentionally conservative: data-builder scripts that do
NOT touch optimizer choice (and therefore have no ``optimizer`` AST
node) PASS. The test only fires when a script silently downgrades.
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from pathlib import Path
from typing import Final

import pytest

# ``packages/training/scripts``
SCRIPTS_DIR: Final[Path] = Path(__file__).resolve().parents[1] / "scripts"

# Scripts under audit. Per the task brief these are the ones the user
# explicitly owns: every ``build_eliza1_*.py`` plus the bootstrap
# native→eliza_native bridge. ``cloud_run.py`` is intentionally NOT in
# this list — it owns offer-search/status/teardown only and never sets
# an optimizer; Task 14 owns the cloud dispatcher shell.
AUDITED_SCRIPT_GLOBS: Final[tuple[str, ...]] = (
    "build_eliza1_*.py",
    "bootstrap_native_to_eliza_native.py",
)

# Allowed and banned optimizer literals. ``apollo_mini`` is conditionally
# allowed (requires inline justification — see ``_has_justification``).
ALLOWED_OPTIMIZERS: Final[frozenset[str]] = frozenset({"apollo"})
JUSTIFIED_ONLY_OPTIMIZERS: Final[frozenset[str]] = frozenset({"apollo_mini"})
BANNED_OPTIMIZERS: Final[frozenset[str]] = frozenset({"adamw", "muon", "sgd"})

# Comment markers that justify an ``apollo_mini`` literal on the
# following 5 source lines.
JUSTIFICATION_MARKERS: Final[tuple[str, ...]] = (
    "# OOM:",
    "# APOLLO_MINI_REASON:",
)
JUSTIFICATION_LOOKBACK_LINES: Final[int] = 5


def _audited_scripts() -> list[Path]:
    seen: set[Path] = set()
    out: list[Path] = []
    for pattern in AUDITED_SCRIPT_GLOBS:
        for path in sorted(SCRIPTS_DIR.glob(pattern)):
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            out.append(path)
    return out


def _iter_optimizer_literals(tree: ast.AST) -> Iterator[tuple[str, int]]:
    """Yield ``(literal_value, line_number)`` for every optimizer string
    literal in the AST.

    Three shapes count as an "optimizer literal":

      1. ``argparse.add_argument("--optimizer", ..., default="apollo")``
         — flag-style default for a CLI entry point.
      2. ``optimizer="apollo"`` keyword argument anywhere in the file.
      3. ``optimizer = "apollo"`` (or annotated equivalent) at any
         scope — module, function, or class.

    All other strings are ignored. The visitor walks the entire tree;
    nested calls/definitions are covered.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            yield from _from_call(node)
        elif isinstance(node, ast.Assign):
            yield from _from_assign(node)
        elif isinstance(node, ast.AnnAssign):
            yield from _from_ann_assign(node)


def _from_call(node: ast.Call) -> Iterator[tuple[str, int]]:
    is_add_argument = (
        isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_argument"
    )
    if is_add_argument:
        first = node.args[0] if node.args else None
        flag = first.value if isinstance(first, ast.Constant) and isinstance(first.value, str) else None
        if flag == "--optimizer":
            for kw in node.keywords:
                if kw.arg == "default" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                    yield kw.value.value, kw.value.lineno

    for kw in node.keywords:
        if kw.arg == "optimizer" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
            yield kw.value.value, kw.value.lineno


def _from_assign(node: ast.Assign) -> Iterator[tuple[str, int]]:
    if not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
        return
    for target in node.targets:
        name = _target_name(target)
        if name == "optimizer" or name == "OPTIMIZER" or name == "DEFAULT_OPTIMIZER":
            yield node.value.value, node.value.lineno


def _from_ann_assign(node: ast.AnnAssign) -> Iterator[tuple[str, int]]:
    if not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
        return
    name = _target_name(node.target)
    if name == "optimizer" or name == "OPTIMIZER" or name == "DEFAULT_OPTIMIZER":
        yield node.value.value, node.value.lineno


def _target_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _has_justification(source_lines: list[str], lineno: int) -> bool:
    """Return True iff one of the JUSTIFICATION_MARKERS appears on any
    of the JUSTIFICATION_LOOKBACK_LINES source lines preceding ``lineno``.

    Line numbers are 1-indexed (matching ``ast.AST.lineno``).
    """
    start = max(1, lineno - JUSTIFICATION_LOOKBACK_LINES)
    end = lineno  # exclusive upper bound is fine; markers must be ABOVE
    for i in range(start, end):
        line = source_lines[i - 1] if i - 1 < len(source_lines) else ""
        for marker in JUSTIFICATION_MARKERS:
            if marker in line:
                return True
    return False


@pytest.mark.parametrize("script", _audited_scripts(), ids=lambda p: p.name)
def test_optimizer_default_is_apollo(script: Path) -> None:
    """Every optimizer literal in an audited script MUST be ``apollo``.

    ``apollo_mini`` is allowed only with an inline justification
    comment. Banned optimizer names (``adamw`` / ``muon`` / ``sgd``)
    fail the test outright. Scripts with NO optimizer literal pass —
    pure data-builder scripts are expected to have none.
    """
    source = script.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(script))
    source_lines = source.splitlines()

    violations: list[str] = []
    for value, lineno in _iter_optimizer_literals(tree):
        normalized = value.strip().lower()
        if normalized in ALLOWED_OPTIMIZERS:
            continue
        if normalized in BANNED_OPTIMIZERS:
            violations.append(
                f"{script.name}:{lineno}: BANNED optimizer literal {value!r} — "
                "AdamW/Muon/SGD are never allowed (user mandate 2026-05-12)."
            )
            continue
        if normalized in JUSTIFIED_ONLY_OPTIMIZERS:
            if not _has_justification(source_lines, lineno):
                violations.append(
                    f"{script.name}:{lineno}: optimizer literal {value!r} requires "
                    f"a justification comment ({' or '.join(JUSTIFICATION_MARKERS)}) "
                    f"within {JUSTIFICATION_LOOKBACK_LINES} lines above. "
                    "Per AGENTS.md, apollo_mini is allowed ONLY when GPU memory forces it."
                )
            continue
        violations.append(
            f"{script.name}:{lineno}: unexpected optimizer literal {value!r}; "
            f"only {sorted(ALLOWED_OPTIMIZERS | JUSTIFIED_ONLY_OPTIMIZERS)} are accepted."
        )

    assert not violations, "\n".join(violations)


def test_audited_scripts_are_discoverable() -> None:
    """Sanity check: the glob actually matched the scripts the brief
    enumerates. If somebody renames a build script and the test silently
    skips it, we want to find out here, not in production.
    """
    names = {p.name for p in _audited_scripts()}
    expected = {
        "build_eliza1_sft_0_6b.py",
        "build_eliza1_sft_0_8b.py",
        "build_eliza1_fullcorpus.py",
        "build_eliza1_smoke_corpus.py",
        "bootstrap_native_to_eliza_native.py",
    }
    missing = expected - names
    assert not missing, f"audited script glob missed expected files: {sorted(missing)}"


def test_audited_scripts_parse_clean() -> None:
    """Every audited script must parse with ``ast.parse``. A SyntaxError
    here would mean the regression check above silently skipped a file.
    """
    for script in _audited_scripts():
        ast.parse(script.read_text(encoding="utf-8"), filename=str(script))
