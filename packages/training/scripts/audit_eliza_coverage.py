"""Eliza coverage auditor.

Reports which canonical eliza actions / evaluators / providers (declared in
`eliza/packages/core/src/features/*/{actions,evaluators,providers}/*.ts`) are
represented in our training corpus, and flags gaps where the model would have
no examples of a known action.

Outputs (deterministic, sorted keys/lists):
  - data/synthesized/review/eliza_canonical_surface.json
  - data/synthesized/review/corpus_surface.json
  - data/synthesized/review/eliza_coverage.json
  - data/synthesized/review/eliza_coverage.md

CLI:
  uv run python scripts/audit_eliza_coverage.py \
    --eliza-root <path-to-eliza>/packages/core/src \
    --corpus data/final/train.jsonl \
    --report data/synthesized/review/eliza_coverage.json \
    --markdown data/synthesized/review/eliza_coverage.md \
    [--max-records 100000] [--full]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


# ---------------------------------------------------------------------------
# canonical surface extraction (read-only walk of eliza/packages/core/src)
# ---------------------------------------------------------------------------

# Match `const spec = requireActionSpec("FOO")` / requireProviderSpec / require
# EvaluatorSpec. Captures (alias, kind, name).
SPEC_ALIAS_RE = re.compile(
    r"(?:const|let|var)\s+(\w+)\s*=\s*"
    r"require(Action|Provider|Evaluator)Spec\(\s*[\"']([^\"']+)[\"']\s*\)",
)

# `export const fooBar(Action|Provider|Evaluator)(?:: T)? = {`
EXPORT_OBJ_RE = re.compile(
    r"export\s+const\s+(\w+(?:Action|Provider|Evaluator))"
    r"\s*(?::\s*[\w<>,\s\[\]|]+\s*)?=\s*\{",
)

# Within an object body: `name: ...` until first `,` or `\n`. Captures the
# right-hand-side expression (literal string, member access, identifier, etc.).
NAME_FIELD_RE = re.compile(
    r"\bname\s*:\s*([^,\n]+?)\s*(?:,|\n)",
)
DESCRIPTION_FIELD_RE = re.compile(
    r"\bdescription\s*:\s*((?:\"(?:[^\"\\]|\\.)*\")|(?:'(?:[^'\\]|\\.)*')"
    r"|(?:`(?:[^`\\]|\\.)*`)|spec\.description)",
)

SKIP_FILE_NAMES = {"index.ts"}


@dataclass(frozen=True)
class CanonicalEntry:
    name: str
    kind: str  # "action" | "evaluator" | "provider"
    file: str
    category: str
    description: str
    extraction: str  # how `name` was resolved: literal | spec | enum | unresolved


def _balanced_brace_end(src: str, open_idx: int) -> int:
    """Return idx (exclusive) of `}` matching `{` at `open_idx`. String- and
    template-literal-aware. Returns -1 on imbalance."""
    assert src[open_idx] == "{"
    depth = 0
    i = open_idx
    n = len(src)
    mode = "code"
    while i < n:
        ch = src[i]
        if mode == "sq":
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == "'":
                mode = "code"
        elif mode == "dq":
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == '"':
                mode = "code"
        elif mode == "tpl":
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == "`":
                mode = "code"
        elif mode == "lcomment":
            if ch == "\n":
                mode = "code"
        elif mode == "bcomment":
            if ch == "*" and i + 1 < n and src[i + 1] == "/":
                mode = "code"
                i += 2
                continue
        else:  # code
            if ch == "/" and i + 1 < n and src[i + 1] == "/":
                mode = "lcomment"
                i += 2
                continue
            if ch == "/" and i + 1 < n and src[i + 1] == "*":
                mode = "bcomment"
                i += 2
                continue
            if ch == "'":
                mode = "sq"
            elif ch == '"':
                mode = "dq"
            elif ch == "`":
                mode = "tpl"
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
        i += 1
    return -1


def _parse_string_literal(s: str) -> str | None:
    s = s.strip()
    if not s:
        return None
    q = s[0]
    if q not in ("'", '"', "`"):
        return None
    j = 1
    out: list[str] = []
    while j < len(s):
        ch = s[j]
        if ch == "\\" and j + 1 < len(s):
            out.append(s[j + 1])
            j += 2
            continue
        if ch == q:
            return "".join(out)
        out.append(ch)
        j += 1
    return None


def _resolve_name(
    expr: str,
    spec_aliases: dict[str, str],
    string_consts: dict[str, str],
) -> tuple[str | None, str]:
    """Return (resolved_name, extraction_mode)."""
    expr = expr.strip().rstrip(",")
    lit = _parse_string_literal(expr)
    if lit is not None:
        return lit, "literal"
    m = re.match(r"^(\w+)\s*\.\s*name$", expr)
    if m and m.group(1) in spec_aliases:
        return spec_aliases[m.group(1)], "spec"
    m = re.match(r"^(\w+)$", expr)
    if m and m.group(1) in string_consts:
        return string_consts[m.group(1)], "const"
    return None, "unresolved"


def _resolve_description(
    expr: str | None,
    spec_aliases: dict[str, str],
) -> str:
    if expr is None:
        return ""
    expr = expr.strip()
    lit = _parse_string_literal(expr)
    if lit is not None:
        return lit
    if expr == "spec.description" or re.match(r"^\w+\s*\.\s*description$", expr):
        return "(from spec)"
    return ""


def _category_from_path(path: Path) -> str:
    """Path is .../features/<category>/<actions|evaluators|providers>/<file>.ts"""
    parts = path.parts
    if "features" in parts:
        idx = parts.index("features")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return "unknown"


def _enumerate_feature_files(
    eliza_root: Path,
    kind_dir: str,
) -> Iterable[Path]:
    """Yield .ts files under features/*/<kind_dir>/ (recursive but skip tests
    and barrels). Also walks single-file features (e.g. knowledge/actions.ts).
    """
    features_root = eliza_root / "features"
    if not features_root.is_dir():
        return
    for cat_dir in sorted(features_root.iterdir()):
        if not cat_dir.is_dir():
            continue
        # Pattern A: features/<cat>/<kind_dir>/*.ts (recursive, skip tests).
        sub = cat_dir / kind_dir
        if sub.is_dir():
            for p in sorted(sub.rglob("*.ts")):
                if p.name in SKIP_FILE_NAMES:
                    continue
                if p.name.endswith(".test.ts") or p.name.endswith(".d.ts"):
                    continue
                if p.name.endswith(".schema.ts"):
                    continue
                if "__tests__" in p.parts:
                    continue
                yield p
        # Pattern B: features/<cat>/(action|actions|provider|providers).ts
        # Catches collapsed features (knowledge/, autonomy/, plugin-manager/).
        singletons = {
            "actions": ["actions.ts", "action.ts"],
            "evaluators": ["evaluators.ts", "evaluator.ts"],
            "providers": ["providers.ts", "provider.ts", "documents-provider.ts"],
        }
        for fname in singletons.get(kind_dir, []):
            p = cat_dir / fname
            if p.is_file():
                yield p


def _extract_entries_from_file(
    path: Path,
    kind: str,  # "action" | "evaluator" | "provider"
    eliza_root: Path,
) -> tuple[list[CanonicalEntry], list[str]]:
    """Return (entries, warnings) where warnings is a list of "unresolved" hits."""
    src = path.read_text()
    spec_aliases: dict[str, str] = {}
    for m in SPEC_ALIAS_RE.finditer(src):
        alias, _kind, name = m.group(1), m.group(2), m.group(3)
        spec_aliases[alias] = name

    # File-local string consts: `const FOO = "BAR";` (also `export const`).
    string_consts: dict[str, str] = {}
    for m in re.finditer(
        r"(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*"
        r"([\"'])([^\"']+)\2\s*;",
        src,
    ):
        string_consts[m.group(1)] = m.group(3)

    entries: list[CanonicalEntry] = []
    warnings: list[str] = []

    for m in EXPORT_OBJ_RE.finditer(src):
        ident = m.group(1)
        # Filter the kind we want.
        if kind == "action" and not ident.endswith("Action"):
            continue
        if kind == "evaluator" and not ident.endswith("Evaluator"):
            continue
        if kind == "provider" and not ident.endswith("Provider"):
            continue
        open_brace = m.end() - 1
        close = _balanced_brace_end(src, open_brace)
        if close < 0:
            continue
        body = src[open_brace + 1 : close - 1]
        nm = NAME_FIELD_RE.search(body)
        if not nm:
            warnings.append(f"{path}:{ident}: no name field")
            continue
        name, mode = _resolve_name(nm.group(1), spec_aliases, string_consts)
        if not name:
            warnings.append(
                f"{path}:{ident}: could not resolve name expr `{nm.group(1).strip()}`",
            )
            continue
        # Validate convention: actions/providers/evaluators canonical names use
        # uppercase identifiers (with rare exceptions for evaluators that use
        # camelCase like `trustChangeEvaluator`). We accept anything non-empty.
        dm = DESCRIPTION_FIELD_RE.search(body)
        description = _resolve_description(dm.group(1) if dm else None, spec_aliases)
        if description == "(from spec)":
            description = ""  # we only have the spec marker, not the text.
        try:
            rel = path.relative_to(eliza_root.parent)
        except ValueError:
            rel = path
        entries.append(
            CanonicalEntry(
                name=name,
                kind=kind,
                file=str(rel),
                category=_category_from_path(path),
                description=description,
                extraction=mode,
            )
        )
    return entries, warnings


def build_canonical_surface(eliza_root: Path) -> tuple[dict, list[str]]:
    actions: dict[str, CanonicalEntry] = {}
    evaluators: dict[str, CanonicalEntry] = {}
    providers: dict[str, CanonicalEntry] = {}
    warnings: list[str] = []

    for kind, store, kind_dir in [
        ("action", actions, "actions"),
        ("evaluator", evaluators, "evaluators"),
        ("provider", providers, "providers"),
    ]:
        for f in _enumerate_feature_files(eliza_root, kind_dir):
            entries, warns = _extract_entries_from_file(f, kind, eliza_root)
            warnings.extend(warns)
            for e in entries:
                # First-seen wins; later duplicates are collisions. We log them
                # but keep the first (deterministic by sort order).
                if e.name in store and store[e.name].file != e.file:
                    warnings.append(
                        f"duplicate {kind} name `{e.name}`: "
                        f"{store[e.name].file} vs {e.file}",
                    )
                    continue
                store[e.name] = e

    surface = {
        "actions": [
            {
                "name": e.name,
                "file": e.file,
                "description": e.description,
                "category": e.category,
            }
            for e in sorted(actions.values(), key=lambda x: x.name)
        ],
        "evaluators": [
            {
                "name": e.name,
                "file": e.file,
                "description": e.description,
                "category": e.category,
            }
            for e in sorted(evaluators.values(), key=lambda x: x.name)
        ],
        "providers": [
            {
                "name": e.name,
                "file": e.file,
                "description": e.description,
                "category": e.category,
            }
            for e in sorted(providers.values(), key=lambda x: x.name)
        ],
    }
    return surface, warnings


# ---------------------------------------------------------------------------
# corpus surface extraction
# ---------------------------------------------------------------------------

# native JSON: `tool_calls[] NAME` or `actions: NAME` (single-action syntactic sugar)
NATIVE_JSON_ACTIONS_RE = re.compile(
    r"actions(?:\[\d+\])?\s*:\s*([A-Z][A-Z0-9_]+(?:\s*,\s*[A-Z][A-Z0-9_]+)*)",
)
# native JSON: `action: NAME` (singular) — used in routing emit shapes.
NATIVE_JSON_ACTION_SINGULAR_RE = re.compile(
    r"\baction\s*:\s*\"?([A-Z][A-Z0-9_]+)\"?",
)
# native JSON: `providers: [] NAME` (or array form `providers[N,2]:`).
NATIVE_JSON_PROVIDERS_RE = re.compile(
    r"providers(?:\[[^\]]*\])?\s*:\s*([A-Z][A-Z0-9_]+(?:\s*,\s*[A-Z][A-Z0-9_]+)*)",
)
# JSON-shape inside expectedResponse for action_planner: `"actions": ["X","Y"]`.
JSON_ACTIONS_RE = re.compile(
    r'"actions"\s*:\s*\[((?:\s*"[A-Z][A-Z0-9_]+"\s*,?\s*)+)\]',
)
JSON_PROVIDERS_RE = re.compile(
    r'"providers"\s*:\s*\[((?:\s*"[A-Z][A-Z0-9_]+"\s*,?\s*)+)\]',
)
# XML-shape: `<actions><action>X</action></actions>` and `<providers>...</providers>`.
XML_ACTION_RE = re.compile(r"<action>\s*([A-Z][A-Z0-9_]+)\s*</action>")
XML_PROVIDER_RE = re.compile(r"<provider>\s*([A-Z][A-Z0-9_]+)\s*</provider>")


def _scan_actions(text: str) -> set[str]:
    found: set[str] = set()
    for m in NATIVE_JSON_ACTIONS_RE.finditer(text):
        for tok in m.group(1).split(","):
            tok = tok.strip()
            if tok:
                found.add(tok)
    for m in NATIVE_JSON_ACTION_SINGULAR_RE.finditer(text):
        found.add(m.group(1))
    for m in JSON_ACTIONS_RE.finditer(text):
        for tok in re.findall(r'"([A-Z][A-Z0-9_]+)"', m.group(1)):
            found.add(tok)
    for m in XML_ACTION_RE.finditer(text):
        found.add(m.group(1))
    return found


def _scan_providers(text: str) -> set[str]:
    found: set[str] = set()
    for m in NATIVE_JSON_PROVIDERS_RE.finditer(text):
        for tok in m.group(1).split(","):
            tok = tok.strip()
            if tok:
                found.add(tok)
    for m in JSON_PROVIDERS_RE.finditer(text):
        for tok in re.findall(r'"([A-Z][A-Z0-9_]+)"', m.group(1)):
            found.add(tok)
    for m in XML_PROVIDER_RE.finditer(text):
        found.add(m.group(1))
    return found


@dataclass
class CorpusSurface:
    action_counts: Counter = field(default_factory=Counter)
    provider_counts: Counter = field(default_factory=Counter)
    available_action_counts: Counter = field(default_factory=Counter)
    task_type_counts: Counter = field(default_factory=Counter)
    n_records: int = 0


def scan_corpus(corpus_path: Path, max_records: int | None) -> CorpusSurface:
    surface = CorpusSurface()
    if not corpus_path.is_file():
        print(f"warn: corpus path not found: {corpus_path}", file=sys.stderr)
        return surface
    with corpus_path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if max_records is not None and i >= max_records:
                break
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            surface.n_records += 1
            for a in rec.get("availableActions") or []:
                if isinstance(a, str):
                    surface.available_action_counts[a] += 1
            er = rec.get("expectedResponse") or ""
            if isinstance(er, str):
                acts = _scan_actions(er)
                for a in acts:
                    surface.action_counts[a] += 1
                provs = _scan_providers(er)
                for p in provs:
                    surface.provider_counts[p] += 1
            md = rec.get("metadata") or {}
            tt = md.get("task_type")
            if isinstance(tt, str):
                surface.task_type_counts[tt] += 1
    return surface


# ---------------------------------------------------------------------------
# coverage report
# ---------------------------------------------------------------------------


def build_coverage(
    surface: dict,
    corpus: CorpusSurface,
) -> dict:
    canonical_actions = {a["name"] for a in surface["actions"]}
    canonical_evaluators = {e["name"] for e in surface["evaluators"]}
    canonical_providers = {p["name"] for p in surface["providers"]}

    # Action mentions in corpus (output side or availableActions side).
    action_mentions = (
        set(corpus.action_counts) | set(corpus.available_action_counts)
    )

    def total_count_actions(name: str) -> int:
        return corpus.action_counts.get(name, 0) + corpus.available_action_counts.get(
            name, 0
        )

    actions_covered = sorted(
        (
            {"name": a, "examples_in_corpus": total_count_actions(a)}
            for a in canonical_actions & action_mentions
        ),
        key=lambda d: d["name"],
    )
    actions_uncovered = sorted(canonical_actions - action_mentions)
    actions_non_canonical = sorted(action_mentions - canonical_actions)

    evaluators_covered = sorted(
        (
            {"name": e, "examples_in_corpus": corpus.provider_counts.get(e, 0)}
            for e in canonical_evaluators
            # Evaluators rarely appear in expectedResponse; a presence check on
            # provider/scan tokens is approximate. We treat them as uncovered
            # by default unless the name shows up in either side.
            if e in corpus.action_counts
            or e in corpus.provider_counts
            or e in corpus.available_action_counts
        ),
        key=lambda d: d["name"],
    )
    evaluators_uncovered = sorted(
        canonical_evaluators
        - set(corpus.action_counts)
        - set(corpus.provider_counts)
        - set(corpus.available_action_counts),
    )

    providers_covered = sorted(
        (
            {"name": p, "examples_in_corpus": corpus.provider_counts.get(p, 0)}
            for p in canonical_providers & set(corpus.provider_counts)
        ),
        key=lambda d: d["name"],
    )
    providers_uncovered = sorted(canonical_providers - set(corpus.provider_counts))
    providers_non_canonical = sorted(set(corpus.provider_counts) - canonical_providers)

    return {
        "actions": {
            "covered": actions_covered,
            "uncovered_canonical": actions_uncovered,
            "non_canonical_but_used": actions_non_canonical,
        },
        "evaluators": {
            "covered": evaluators_covered,
            "uncovered_canonical": evaluators_uncovered,
            "non_canonical_but_used": [],  # no scanner side for evaluators.
        },
        "providers": {
            "covered": providers_covered,
            "uncovered_canonical": providers_uncovered,
            "non_canonical_but_used": providers_non_canonical,
        },
    }


# ---------------------------------------------------------------------------
# markdown summary
# ---------------------------------------------------------------------------


def _category_coverage(
    surface: dict,
    coverage: dict,
    kind: str,  # actions | evaluators | providers
) -> list[tuple[str, int, int]]:
    """Return [(category, n_covered, n_canonical)] sorted by category."""
    by_cat: dict[str, list[str]] = {}
    for entry in surface[kind]:
        by_cat.setdefault(entry["category"], []).append(entry["name"])
    covered_names = {c["name"] for c in coverage[kind]["covered"]}
    out: list[tuple[str, int, int]] = []
    for cat in sorted(by_cat):
        names = by_cat[cat]
        n_covered = sum(1 for n in names if n in covered_names)
        out.append((cat, n_covered, len(names)))
    return out


def render_markdown(
    surface: dict,
    corpus: CorpusSurface,
    coverage: dict,
    corpus_path: Path,
) -> str:
    lines: list[str] = []
    lines.append("# Eliza coverage audit")
    lines.append("")
    lines.append(f"- corpus: `{corpus_path}`")
    lines.append(f"- records scanned: {corpus.n_records}")
    lines.append(f"- canonical actions: {len(surface['actions'])}")
    lines.append(f"- canonical evaluators: {len(surface['evaluators'])}")
    lines.append(f"- canonical providers: {len(surface['providers'])}")
    lines.append("")

    # ---- actions ----
    lines.append("## Actions")
    lines.append("")
    lines.append("### Top covered (by example count)")
    top_covered = sorted(
        coverage["actions"]["covered"],
        key=lambda d: (-d["examples_in_corpus"], d["name"]),
    )[:5]
    if not top_covered:
        lines.append("- (none)")
    for d in top_covered:
        lines.append(f"- `{d['name']}` — {d['examples_in_corpus']} examples")
    lines.append("")

    lines.append("### Top missing canonical actions")
    file_by_name = {a["name"]: a["file"] for a in surface["actions"]}
    missing = coverage["actions"]["uncovered_canonical"][:5]
    if not missing:
        lines.append("- (none — full coverage)")
    for nm in missing:
        lines.append(f"- `{nm}` — defined at `{file_by_name.get(nm, '?')}`")
    lines.append("")

    lines.append("### Non-canonical but used (potential plugin actions or slop)")
    non_canon = coverage["actions"]["non_canonical_but_used"][:25]
    if not non_canon:
        lines.append("- (none)")
    for nm in non_canon:
        n = corpus.action_counts.get(nm, 0) + corpus.available_action_counts.get(nm, 0)
        lines.append(f"- `{nm}` — {n} mentions")
    lines.append("")

    lines.append("### Coverage by category")
    for cat, ncov, ntot in _category_coverage(surface, coverage, "actions"):
        pct = (ncov / ntot * 100.0) if ntot else 0.0
        lines.append(f"- {cat}: {ncov} / {ntot} ({pct:.1f}%)")
    lines.append("")

    # ---- providers ----
    lines.append("## Providers")
    lines.append("")
    top_covered_p = sorted(
        coverage["providers"]["covered"],
        key=lambda d: (-d["examples_in_corpus"], d["name"]),
    )[:5]
    lines.append("### Top covered")
    if not top_covered_p:
        lines.append("- (none)")
    for d in top_covered_p:
        lines.append(f"- `{d['name']}` — {d['examples_in_corpus']} examples")
    lines.append("")
    lines.append("### Top missing canonical providers")
    file_by_name_p = {p["name"]: p["file"] for p in surface["providers"]}
    missing_p = coverage["providers"]["uncovered_canonical"][:5]
    if not missing_p:
        lines.append("- (none — full coverage)")
    for nm in missing_p:
        lines.append(f"- `{nm}` — defined at `{file_by_name_p.get(nm, '?')}`")
    lines.append("")
    lines.append("### Coverage by category")
    for cat, ncov, ntot in _category_coverage(surface, coverage, "providers"):
        pct = (ncov / ntot * 100.0) if ntot else 0.0
        lines.append(f"- {cat}: {ncov} / {ntot} ({pct:.1f}%)")
    lines.append("")

    # ---- evaluators ----
    lines.append("## Evaluators")
    lines.append("")
    lines.append("### Covered")
    if not coverage["evaluators"]["covered"]:
        lines.append("- (none — evaluators are rarely emitted in expectedResponse)")
    for d in coverage["evaluators"]["covered"]:
        lines.append(f"- `{d['name']}`")
    lines.append("")
    lines.append("### Top missing canonical evaluators")
    file_by_name_e = {e["name"]: e["file"] for e in surface["evaluators"]}
    missing_e = coverage["evaluators"]["uncovered_canonical"][:5]
    if not missing_e:
        lines.append("- (none)")
    for nm in missing_e:
        lines.append(f"- `{nm}` — defined at `{file_by_name_e.get(nm, '?')}`")
    lines.append("")

    lines.append("## Task type distribution")
    for tt, n in sorted(corpus.task_type_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:15]:
        lines.append(f"- {tt}: {n}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--eliza-root",
        type=Path,
        default=Path(__file__).parent.parent.parent.parent / "packages" / "core" / "src",
    )
    ap.add_argument(
        "--corpus",
        type=Path,
        default=Path("data/final/train.jsonl"),
    )
    ap.add_argument(
        "--report",
        type=Path,
        default=Path("data/synthesized/review/eliza_coverage.json"),
    )
    ap.add_argument(
        "--markdown",
        type=Path,
        default=Path("data/synthesized/review/eliza_coverage.md"),
    )
    ap.add_argument(
        "--surface-out",
        type=Path,
        default=Path("data/synthesized/review/eliza_canonical_surface.json"),
    )
    ap.add_argument(
        "--corpus-surface-out",
        type=Path,
        default=Path("data/synthesized/review/corpus_surface.json"),
    )
    ap.add_argument("--max-records", type=int, default=100_000)
    ap.add_argument("--full", action="store_true", help="ignore --max-records")
    args = ap.parse_args()

    if not args.eliza_root.is_dir():
        print(f"error: eliza root not found: {args.eliza_root}", file=sys.stderr)
        return 2

    surface, warnings = build_canonical_surface(args.eliza_root)
    if warnings:
        for w in warnings[:30]:
            print(f"warn: {w}", file=sys.stderr)
        if len(warnings) > 30:
            print(f"warn: ... and {len(warnings) - 30} more", file=sys.stderr)

    args.surface_out.parent.mkdir(parents=True, exist_ok=True)
    args.surface_out.write_text(
        json.dumps(surface, indent=2, sort_keys=True) + "\n",
    )

    max_records = None if args.full else args.max_records
    corpus = scan_corpus(args.corpus, max_records)

    corpus_surface = {
        "n_records": corpus.n_records,
        "available_action_counts": dict(
            sorted(corpus.available_action_counts.items()),
        ),
        "action_counts": dict(sorted(corpus.action_counts.items())),
        "provider_counts": dict(sorted(corpus.provider_counts.items())),
        "task_type_counts": dict(sorted(corpus.task_type_counts.items())),
    }
    args.corpus_surface_out.parent.mkdir(parents=True, exist_ok=True)
    args.corpus_surface_out.write_text(
        json.dumps(corpus_surface, indent=2, sort_keys=True) + "\n",
    )

    coverage = build_coverage(surface, corpus)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n")

    md = render_markdown(surface, corpus, coverage, args.corpus)
    args.markdown.parent.mkdir(parents=True, exist_ok=True)
    args.markdown.write_text(md)

    summary = {
        "n_records": corpus.n_records,
        "canonical_actions": len(surface["actions"]),
        "canonical_evaluators": len(surface["evaluators"]),
        "canonical_providers": len(surface["providers"]),
        "actions_covered": len(coverage["actions"]["covered"]),
        "actions_uncovered": len(coverage["actions"]["uncovered_canonical"]),
        "actions_non_canonical": len(coverage["actions"]["non_canonical_but_used"]),
        "providers_covered": len(coverage["providers"]["covered"]),
        "providers_uncovered": len(coverage["providers"]["uncovered_canonical"]),
        "providers_non_canonical": len(coverage["providers"]["non_canonical_but_used"]),
        "evaluators_covered": len(coverage["evaluators"]["covered"]),
        "evaluators_uncovered": len(coverage["evaluators"]["uncovered_canonical"]),
        "wrote": [
            str(args.surface_out),
            str(args.corpus_surface_out),
            str(args.report),
            str(args.markdown),
        ],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
