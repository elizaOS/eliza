"""Extract every elizaOS prompt template into a single registry.

Sources:
  1. Canonical templates: `eliza/packages/prompts/prompts/*.txt` (38 files).
  2. Action-embedded templates: TypeScript template strings inside
     `eliza/apps/*/src/actions/*.ts` and `eliza/packages/typescript/src/`
     where the file declares a *_PROMPT, *_TEMPLATE, *_TPL, or composePrompt
     literal containing handlebars `{{var}}` and a `# Task:` header or a
     trailing `output:`/`Respond using native JSON` block.

Output: `training/data/prompts/registry.json`

Each entry:
  {
    "task_id":              "should_respond",
    "source_path":          "eliza/packages/prompts/prompts/should_respond.txt",
    "source_kind":          "canonical | action",
    "template":             "<full text>",
    "variables":            ["agentName", "providers", ...],
    "output_format":        "payload | json | text | unknown",
    "expected_keys":        ["decision", ...],   // best-effort from example block
    "examples":             [ "<example block>", ... ]
  }

Used by:
  * `synthesize_targets.py` — knows which template to render and what schema
    the supervised target should match.
  * `normalize.py` — uses `expected_keys` to validate that emitted native JSON
    targets match the prompt's declared schema.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # /home/shaw/eliza
TRAIN_ROOT = Path(__file__).resolve().parents[1]
ELIZA = ROOT / "eliza"
CANONICAL_DIR = ELIZA / "packages" / "prompts" / "prompts"
TS_ACTION_GLOBS = [
    ELIZA / "apps",                            # apps/*/src/actions/*.ts
    ELIZA / "packages" / "typescript" / "src", # core actions/evaluators
]
OUT_DIR = TRAIN_ROOT / "data" / "prompts"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("extract")

VAR_RE = re.compile(r"\{\{\s*([#/])?([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")

# A TS template literal that smells like a prompt. We require:
#   - exported as `const X = \`...\`` or `export const X = \`...\``
#   - contains at least one handlebars var
#   - is at least 200 chars
TS_TEMPLATE_RE = re.compile(
    r"(?ms)"
    r"(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*(?:_PROMPT|_TEMPLATE|_TPL|_PROMPT_TEMPLATE))\s*"
    r"(?::\s*[^\n=]+)?\s*=\s*`([^`]+)`"
)

# Pull native JSON example block keys (lines like "key: value" appearing in an
# Example: section) so synthesize_targets.py knows the target schema.
EXAMPLE_BLOCK_RE = re.compile(
    r"(?ms)^Example\s*:\s*\n((?:[ \t]*[A-Za-z_][A-Za-z0-9_]*\s*:[^\n]*\n?)+)"
)


@dataclass
class PromptEntry:
    task_id: str
    source_path: str
    source_kind: str
    template: str
    variables: list[str] = field(default_factory=list)
    output_format: str = "unknown"
    expected_keys: list[str] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)


def detect_output_format(text: str) -> str:
    lower = text.lower()
    if "payload" in lower:
        return "payload"
    if "respond with json" in lower or "```json" in lower or "json schema" in lower:
        return "json"
    if "yaml" in lower:
        return "yaml"
    return "text"


def extract_examples_and_keys(text: str) -> tuple[list[str], list[str]]:
    examples: list[str] = []
    keys: set[str] = set()
    for m in EXAMPLE_BLOCK_RE.finditer(text):
        block = m.group(1).strip()
        examples.append(block)
        for line in block.splitlines():
            head = line.split(":", 1)[0].strip()
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", head):
                keys.add(head)
    return examples, sorted(keys)


def extract_variables(text: str) -> list[str]:
    out: dict[str, None] = {}
    for kind, name in VAR_RE.findall(text):
        # Skip block helpers like {{#each items}} ... {{/each}} markers' control
        # tokens themselves (kind == '#' or '/'); the inner var name still
        # counts as a variable reference.
        if kind in ("#", "/") and name in {"each", "if", "unless", "with"}:
            continue
        out.setdefault(name, None)
    return list(out)


def from_canonical_file(path: Path) -> PromptEntry:
    text = path.read_text(encoding="utf-8")
    task_id = path.stem
    examples, keys = extract_examples_and_keys(text)
    return PromptEntry(
        task_id=task_id,
        source_path=str(path.relative_to(ROOT)),
        source_kind="canonical",
        template=text,
        variables=extract_variables(text),
        output_format=detect_output_format(text),
        expected_keys=keys,
        examples=examples,
    )


def looks_like_prompt(text: str) -> bool:
    if "{{" not in text:
        return False
    if len(text) < 200:
        return False
    lower = text.lower()
    return any(
        marker in lower
        for marker in (
            "# task",
            "task:",
            "respond with",
            "respond using",
            "output:",
            "instructions:",
            "you are",
        )
    )


def from_typescript_file(path: Path) -> list[PromptEntry]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    out: list[PromptEntry] = []
    for m in TS_TEMPLATE_RE.finditer(text):
        const_name, body = m.group(1), m.group(2)
        # Resolve a handful of escaped sequences common in TS template literals.
        decoded = body.replace("\\`", "`").replace("\\${", "${")
        if not looks_like_prompt(decoded):
            continue
        examples, keys = extract_examples_and_keys(decoded)
        # Convert THE_PROMPT_TEMPLATE → the_prompt
        slug = const_name.lower()
        for suf in ("_prompt_template", "_template", "_prompt", "_tpl"):
            if slug.endswith(suf):
                slug = slug[: -len(suf)]
                break
        out.append(PromptEntry(
            task_id=f"{path.stem}.{slug}",
            source_path=str(path.relative_to(ROOT)),
            source_kind="action",
            template=decoded,
            variables=extract_variables(decoded),
            output_format=detect_output_format(decoded),
            expected_keys=keys,
            examples=examples,
        ))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT_DIR / "registry.json")
    ap.add_argument("--include-actions", action="store_true", default=True,
                    help="also walk eliza/apps/**/src/actions and core typescript")
    ap.add_argument("--print-stats", action="store_true")
    args = ap.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)

    if not CANONICAL_DIR.exists():
        log.error("canonical prompts dir missing: %s", CANONICAL_DIR)
        return 1

    entries: list[PromptEntry] = []

    canonical_files = sorted(CANONICAL_DIR.glob("*.txt"))
    log.info("canonical prompts: %d files", len(canonical_files))
    for p in canonical_files:
        entries.append(from_canonical_file(p))

    if args.include_actions:
        ts_files: list[Path] = []
        for base in TS_ACTION_GLOBS:
            if not base.exists():
                continue
            ts_files.extend(base.rglob("*.ts"))
        # de-dupe + filter out node_modules / dist / .turbo
        seen: set[Path] = set()
        ts_files = [
            p for p in ts_files
            if not any(part in {"node_modules", "dist", ".turbo", "test", "__tests__"}
                       for part in p.parts)
            and p not in seen and not seen.add(p)
        ]
        log.info("scanning %d TypeScript files for embedded prompts", len(ts_files))
        for p in ts_files:
            entries.extend(from_typescript_file(p))

    by_task: dict[str, PromptEntry] = {}
    for e in entries:
        prev = by_task.get(e.task_id)
        if prev and prev.source_kind == "canonical":
            continue  # canonical wins on collision
        by_task[e.task_id] = e

    payload = {
        "version": 1,
        "generated_from": str(ELIZA.relative_to(ROOT)),
        "n_entries": len(by_task),
        "entries": [asdict(e) for e in by_task.values()],
    }
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("wrote %d prompt entries to %s", len(by_task), args.out)

    if args.print_stats:
        from collections import Counter
        kinds = Counter(e.source_kind for e in by_task.values())
        formats = Counter(e.output_format for e in by_task.values())
        log.info("by source_kind: %s", dict(kinds))
        log.info("by output_format: %s", dict(formats))
        log.info("payload-output prompts:")
        for e in by_task.values():
            if e.output_format == "payload":
                log.info("  %s  keys=%s", e.task_id, e.expected_keys)

    return 0


if __name__ == "__main__":
    sys.exit(main())
