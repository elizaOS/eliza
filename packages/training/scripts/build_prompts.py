"""Build registry-v2.json (prompts) and actions-catalog.json from elizaOS sources.

Produces three artifacts:
- packages/training/data/prompts/registry-v2.json
- packages/training/data/prompts/actions-catalog.json
- (coverage report is written separately by build_prompt_coverage.py)
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ELIZA_ROOT = Path(__file__).parent.parent.parent.parent.resolve()
TRAINING_ROOT = Path(__file__).parent.parent.resolve()

V1_REGISTRY = TRAINING_ROOT / "data" / "prompts" / "registry.json"
V2_REGISTRY = TRAINING_ROOT / "data" / "prompts" / "registry-v2.json"
ACTIONS_CATALOG = TRAINING_ROOT / "data" / "prompts" / "actions-catalog.json"

CORE_PROMPTS_DIR = ELIZA_ROOT / "packages" / "prompts" / "prompts"
PLUGIN_PROMPT_GLOB = "plugins/*/prompts/*.txt"

# ----------------------------- helpers --------------------------------------

VAR_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}")


def extract_variables(template: str) -> list[str]:
    return sorted({m.group(1) for m in VAR_RE.finditer(template)})


def detect_output_format(template: str) -> str:
    body = template.lower()
    # Strong markers first.
    if "```json" in body or re.search(r"\{\s*\"[a-z_]+\"\s*:", template):
        return "json"
    if re.search(r"</?[a-z_][a-z_0-9]*\s*[/>]", template):
        # e.g. <thought>, <response>, </think>, <action>
        return "xml"
    # native JSON heuristic: explicit "native JSON" mention or example block of `key: value`
    if "payload" in body:
        return "payload"
    # crude: 3+ consecutive lines that look like `key: value`
    kv_lines = 0
    max_run = 0
    for line in template.splitlines():
        stripped = line.strip()
        if re.match(r"^[a-z_][a-z_0-9]*\s*:\s.*", stripped):
            kv_lines += 1
            max_run = max(max_run, kv_lines)
        else:
            kv_lines = 0
    if max_run >= 3:
        return "payload"
    return "text"


def extract_expected_keys(template: str, output_format: str) -> list[str]:
    keys: set[str] = set()
    if output_format == "json":
        # Match keys in JSON-ish blocks
        for m in re.finditer(r'"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:', template):
            keys.add(m.group(1))
    elif output_format == "payload":
        # Look at lines that occur after an "Example:" / "output:" label
        in_example = False
        for raw in template.splitlines():
            stripped = raw.strip()
            low = stripped.lower()
            if low.startswith("example") or low.startswith("output"):
                in_example = True
                continue
            if in_example:
                if not stripped:
                    # blank may end an example
                    continue
                m = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$", stripped)
                if m:
                    keys.add(m.group(1))
                else:
                    # encountering non-key line ends example block
                    pass
        # also pick up keys mentioned inline
        for m in re.finditer(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*", template, re.MULTILINE):
            keys.add(m.group(1))
    elif output_format == "xml":
        for m in re.finditer(r"<([a-zA-Z_][a-zA-Z0-9_-]*)>", template):
            keys.add(m.group(1))
    return sorted(keys)


def extract_first_example(template: str, output_format: str) -> list[str]:
    """Best effort: extract a leading example block if present."""
    examples: list[str] = []
    # JSON code block
    for m in re.finditer(r"```json\s*\n([\s\S]+?)```", template):
        examples.append(m.group(1).strip())
        break
    if examples:
        return examples
    # Look for "Example:" or "example:" block
    m = re.search(r"\n\s*Example[s]?\s*:?\s*\n([\s\S]+?)(?:\n\n|$)", template)
    if m:
        examples.append(m.group(1).rstrip())
    return examples


# --------------------------- v1 carry-over ----------------------------------


def load_v1_entries() -> list[dict[str, Any]]:
    data = json.loads(V1_REGISTRY.read_text())
    return list(data.get("entries", []))


# --------------------------- core/plugin prompts ----------------------------


def build_core_entries() -> list[dict[str, Any]]:
    """Re-derive entries for core prompts to ensure consistency, but keep them
    aligned with v1 source_kind=canonical so downstream consumers still match."""
    entries: list[dict[str, Any]] = []
    for txt in sorted(CORE_PROMPTS_DIR.glob("*.txt")):
        template = txt.read_text()
        fmt = detect_output_format(template)
        entries.append(
            {
                "task_id": txt.stem,
                "source_path": str(txt.relative_to(ELIZA_ROOT.parent)),
                "source_kind": "core",
                "plugin": None,
                "template": template,
                "variables": extract_variables(template),
                "output_format": fmt,
                "expected_keys": extract_expected_keys(template, fmt),
                "examples": extract_first_example(template, fmt),
            }
        )
    return entries


def build_plugin_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for txt in sorted((ELIZA_ROOT / "plugins").glob("*/prompts/*.txt")):
        plugin = txt.parent.parent.name  # plugin-shell etc.
        template = txt.read_text()
        fmt = detect_output_format(template)
        entries.append(
            {
                "task_id": f"{plugin}.{txt.stem}",
                "source_path": str(txt.relative_to(ELIZA_ROOT.parent)),
                "source_kind": "plugin",
                "plugin": plugin,
                "template": template,
                "variables": extract_variables(template),
                "output_format": fmt,
                "expected_keys": extract_expected_keys(template, fmt),
                "examples": extract_first_example(template, fmt),
            }
        )
    return entries


# --------------------------- main -------------------------------------------


def main() -> None:
    v1_entries = load_v1_entries()

    core_entries = build_core_entries()
    plugin_entries = build_plugin_entries()

    # For core prompts, prefer hand-curated v1 entries, then append discovered
    # core .txt prompts that are absent from v1.
    merged_core: list[dict[str, Any]] = []
    seen_core: set[str] = set()
    for v1e in v1_entries:
        if v1e.get("source_kind") in (None, "canonical", "core"):
            new_entry = dict(v1e)
            new_entry["source_kind"] = "core"
            new_entry.setdefault("plugin", None)
            merged_core.append(new_entry)
            seen_core.add(v1e["task_id"])
    for ce in core_entries:
        if ce["task_id"] not in seen_core:
            merged_core.append(ce)

    # Carry forward v1 entries that pointed at action source files (extraction prompts
    # embedded in TypeScript). They are not core .txt prompts and should remain.
    inline_action_entries: list[dict[str, Any]] = []
    for v1e in v1_entries:
        if v1e.get("source_kind") == "action":
            new_entry = dict(v1e)
            new_entry.setdefault("plugin", None)
            inline_action_entries.append(new_entry)

    all_entries = merged_core + inline_action_entries + plugin_entries

    out = {
        "version": 2,
        "generated_from": "eliza-core+plugins",
        "n_entries": len(all_entries),
        "n_core": len(merged_core),
        "n_inline_action": len(inline_action_entries),
        "n_plugin": len(plugin_entries),
        "entries": all_entries,
    }
    V2_REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    V2_REGISTRY.write_text(json.dumps(out, indent=2))
    print(
        f"wrote {V2_REGISTRY} entries={len(all_entries)} "
        f"core={len(merged_core)} plugin={len(plugin_entries)}"
    )


if __name__ == "__main__":
    main()
