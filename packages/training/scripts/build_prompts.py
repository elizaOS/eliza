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
LIFEOPS_HELPERS = ELIZA_ROOT / "apps" / "app-lifeops" / "test" / "helpers"
LIFEOPS_SCENARIOS = ELIZA_ROOT / "apps" / "app-lifeops" / "test" / "scenarios"
LIFEOPS_CATALOGS = LIFEOPS_SCENARIOS / "_catalogs"

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
    # TOON heuristic: explicit "TOON" mention or example block of `key: value`
    if "toon" in body:
        return "toon"
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
        return "toon"
    return "text"


def extract_expected_keys(template: str, output_format: str) -> list[str]:
    keys: set[str] = set()
    if output_format == "json":
        # Match keys in JSON-ish blocks
        for m in re.finditer(r'"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:', template):
            keys.add(m.group(1))
    elif output_format == "toon":
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


# --------------------------- lifeops cases ----------------------------------


SELF_CARE_PRD_IDS = [
    "workout-blocker-basic",
    "stretch-breaks",
    "goal-sleep-basic",
    "shower-weekly-basic",
    "shave-weekly-formal",
    "brush-teeth-basic",
    "brush-teeth-bedtime-wakeup",
    "brush-teeth-night-owl",
    "brush-teeth-repeat-confirm",
    "brush-teeth-retry-after-cancel",
    "brush-teeth-cancel",
    "brush-teeth-spanish",
    "brush-teeth-smalltalk-preference",
    "vitamins-with-meals",
    "water-default-frequency",
    "invisalign-weekday-lunch",
]

SELF_CARE_HABIT_IDS = [
    "habit.sit-ups-push-ups.daily-counts",
    "habit.morning-routine.full-stack",
    "habit.night-routine.full-stack",
]

# Variant rewrites mirroring lifeops-prompt-benchmark-cases.ts
def _normalize_sentence(text: str) -> str:
    return re.sub(r"[.!?]+$", "", text).strip()


def _strip_punctuation(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)).strip()


def _lowercase_first(text: str) -> str:
    if not text:
        return text
    return text[0].lower() + text[1:]


VARIANTS = [
    ("direct", "Direct", lambda b: b, ["baseline", "direct"], "positive", 1.0),
    (
        "adult-formal",
        "Adult Formal",
        lambda b: f"Please handle this carefully: {_normalize_sentence(b)}.",
        ["adult", "formal-register"],
        "positive",
        1.0,
    ),
    (
        "childlike",
        "Childlike",
        lambda b: f"Can you help me with this please? {_normalize_sentence(b)}.",
        ["childlike", "simple-language"],
        "positive",
        1.05,
    ),
    (
        "broken-english",
        "Broken English",
        lambda b: f"sorry my english not perfect but {_lowercase_first(_normalize_sentence(b))} please",
        ["multilingual", "broken-english"],
        "edge",
        1.2,
    ),
    (
        "naive-underspecified",
        "Naive",
        lambda b: f"I might be saying this badly, but I think I need this: {_lowercase_first(_normalize_sentence(b))}.",
        ["underspecified", "naive-mental-model"],
        "edge",
        1.15,
    ),
    (
        "expert-shorthand",
        "Expert Shorthand",
        lambda b: f"Handle this fast. {_normalize_sentence(b)}.",
        ["expert-shorthand", "compressed"],
        "positive",
        1.1,
    ),
    (
        "distracted-rambling",
        "Distracted",
        lambda b: f"I'm multitasking and might be rambling, but {_lowercase_first(_normalize_sentence(b))}.",
        ["distracted", "rambling"],
        "edge",
        1.15,
    ),
    (
        "voice-asr",
        "Voice ASR",
        lambda b: f"uh {_strip_punctuation(b).lower()} thanks",
        ["speech", "asr-noise"],
        "edge",
        1.1,
    ),
    (
        "self-correcting",
        "Self Correcting",
        lambda b: f"{_normalize_sentence(b)}. Actually, wait, let me say it better: {_normalize_sentence(b)}.",
        ["self-correction", "multi-phrase"],
        "edge",
        1.15,
    ),
    (
        "subtle-null",
        "Subtle Null",
        lambda b: f"Do not do this yet. I'm only thinking out loud: {_lowercase_first(_normalize_sentence(b))}.",
        ["null-case", "non-request", "confuser"],
        "null",
        2.0,
    ),
]


# Static parser: extract ScenarioLike fields from a *.scenario.ts file
# We only need: id, title, domain, first message text, and finalChecks selectedAction names.
SCENARIO_ID_RE = re.compile(r'\bid:\s*"([^"]+)"')
SCENARIO_TITLE_RE = re.compile(r'\btitle:\s*"([^"]+)"')
SCENARIO_DOMAIN_RE = re.compile(r'\bdomain:\s*"([^"]+)"')
SCENARIO_TAGS_RE = re.compile(r"\btags:\s*\[([^\]]*)\]")
TURN_TEXT_RE = re.compile(
    r'kind:\s*"message"[\s\S]*?text:\s*("([^"\\]|\\.)*"|`([^`\\]|\\.)*`)',
)
ACTION_NAME_FINAL_RE = re.compile(
    r'(?:type:\s*"(?:selectedAction|actionCalled)"[\s\S]*?actionName:\s*("[^"]+"|\[[^\]]+\]))',
)


def _parse_string_literal(literal: str) -> str:
    literal = literal.strip()
    if literal.startswith('"'):
        return bytes(literal[1:-1], "utf-8").decode("unicode_escape")
    if literal.startswith("`"):
        return literal[1:-1]
    return literal


def parse_scenario_file(path: Path) -> dict[str, Any] | None:
    try:
        text = path.read_text()
    except FileNotFoundError:
        return None
    sid = SCENARIO_ID_RE.search(text)
    if not sid:
        return None
    title = SCENARIO_TITLE_RE.search(text)
    domain = SCENARIO_DOMAIN_RE.search(text)
    tags_match = SCENARIO_TAGS_RE.search(text)
    tags: list[str] = []
    if tags_match:
        for m in re.finditer(r'"([^"]+)"', tags_match.group(1)):
            tags.append(m.group(1))
    # First message turn
    turn = TURN_TEXT_RE.search(text)
    first_text = ""
    if turn:
        first_text = _parse_string_literal(turn.group(1))
    # selectedAction / actionCalled lists
    selected_actions: list[str] = []
    for m in ACTION_NAME_FINAL_RE.finditer(text):
        v = m.group(1).strip()
        if v.startswith("["):
            selected_actions.extend(re.findall(r'"([^"]+)"', v))
        else:
            inner = re.findall(r'"([^"]+)"', v)
            if inner:
                selected_actions.extend(inner)
    # de-dup, drop REPLY for benchmark anchors
    seen: dict[str, None] = {}
    for a in selected_actions:
        if a == "REPLY":
            continue
        seen[a] = None
    selected_actions = list(seen.keys())
    return {
        "id": sid.group(1),
        "title": title.group(1) if title else sid.group(1),
        "domain": domain.group(1) if domain else "lifeops",
        "tags": tags,
        "firstMessage": first_text,
        "selectedActions": selected_actions,
    }


def derive_self_care_expectation(scenario: dict[str, Any]) -> dict[str, Any]:
    sid = scenario["id"]
    if sid == "brush-teeth-smalltalk-preference":
        return {
            "expectedAction": None,
            "acceptableActions": ["REPLY"],
            "forbiddenActions": ["LIFE"],
            "expectedOperation": None,
            "notes": (
                "First-turn self-care smalltalk is a subtle non-request. Reply "
                "conversationally and wait until the user explicitly asks to create "
                "or save the routine."
            ),
        }
    return {
        "expectedAction": "LIFE",
        "acceptableActions": [],
        "forbiddenActions": [],
        "expectedOperation": None,
    }


def derive_ea_expectation(scenario: dict[str, Any]) -> dict[str, Any]:
    sel = scenario["selectedActions"]
    return {
        "expectedAction": sel[0] if sel else None,
        "acceptableActions": sel[1:],
        "forbiddenActions": sel,
        "expectedOperation": None,
    }


def build_lifeops_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    # ---- self-care PRD scenarios (in app-lifeops/test/scenarios) ----
    for scen_id in SELF_CARE_PRD_IDS:
        path = LIFEOPS_SCENARIOS / f"{scen_id}.scenario.ts"
        scen = parse_scenario_file(path)
        if scen is None:
            continue
        if not scen["firstMessage"]:
            continue
        expectation = derive_self_care_expectation(scen)
        for variant_id, variant_label, rewrite, axes, risk_class, weight in VARIANTS:
            base = scen["firstMessage"]
            prompt = rewrite(base)
            positive = variant_id != "subtle-null"
            expected_action = expectation["expectedAction"] if positive else None
            entry_template = (
                "Lifeops self-care benchmark prompt.\n\n"
                f"Scenario: {scen['title']} ({scen['id']})\n"
                f"Variant: {variant_label}\n"
                f"User message: {prompt}\n\n"
                "Expected action: "
                f"{expected_action if expected_action else 'REPLY (no durable action)'}"
            )
            entries.append(
                {
                    "task_id": f"lifeops.{scen['id']}.{variant_id}",
                    "source_path": str(path.relative_to(ELIZA_ROOT.parent)),
                    "source_kind": "lifeops",
                    "plugin": None,
                    "template": entry_template,
                    "variables": [],
                    "output_format": "text",
                    "expected_keys": [],
                    "examples": [
                        json.dumps(
                            {
                                "expectedAction": expected_action,
                                "acceptableActions": (
                                    list(expectation["acceptableActions"])
                                    if positive
                                    else ["REPLY"]
                                ),
                                "forbiddenActions": (
                                    list(expectation["forbiddenActions"])
                                    if positive
                                    else [
                                        a
                                        for a in [
                                            expectation["expectedAction"],
                                            *expectation["acceptableActions"],
                                            *expectation["forbiddenActions"],
                                        ]
                                        if a
                                    ]
                                ),
                            }
                        )
                    ],
                    "lifeops_meta": {
                        "suiteId": "lifeops-self-care",
                        "baseScenarioId": scen["id"],
                        "scenarioTitle": scen["title"],
                        "domain": scen["domain"],
                        "basePrompt": base,
                        "prompt": prompt,
                        "variantId": variant_id,
                        "variantLabel": variant_label,
                        "axes": axes,
                        "riskClass": "null" if expected_action is None and positive else risk_class,
                        "benchmarkWeight": (
                            max(weight, 2.0)
                            if positive and expected_action is None
                            else weight
                        ),
                        "expectedAction": expected_action,
                        "acceptableActions": (
                            list(expectation["acceptableActions"])
                            if positive
                            else ["REPLY"]
                        ),
                        "forbiddenActions": (
                            list(expectation["forbiddenActions"]) if positive else []
                        ),
                        "tags": [
                            "lifeops-self-care",
                            scen["domain"],
                            variant_id,
                            *scen["tags"],
                        ],
                    },
                }
            )

    # ---- self-care habit scenarios (under eliza/test/scenarios/lifeops.habits) ----
    habit_dir = ELIZA_ROOT / "test" / "scenarios" / "lifeops.habits"
    for scen_id in SELF_CARE_HABIT_IDS:
        path = habit_dir / f"{scen_id}.scenario.ts"
        scen = parse_scenario_file(path)
        if scen is None or not scen["firstMessage"]:
            continue
        expectation = derive_self_care_expectation(scen)
        for variant_id, variant_label, rewrite, axes, risk_class, weight in VARIANTS:
            base = scen["firstMessage"]
            prompt = rewrite(base)
            positive = variant_id != "subtle-null"
            expected_action = expectation["expectedAction"] if positive else None
            entries.append(
                {
                    "task_id": f"lifeops.{scen['id']}.{variant_id}",
                    "source_path": str(path.relative_to(ELIZA_ROOT.parent)),
                    "source_kind": "lifeops",
                    "plugin": None,
                    "template": (
                        "Lifeops habit benchmark prompt.\n\n"
                        f"Scenario: {scen['title']} ({scen['id']})\n"
                        f"Variant: {variant_label}\n"
                        f"User message: {prompt}"
                    ),
                    "variables": [],
                    "output_format": "text",
                    "expected_keys": [],
                    "examples": [],
                    "lifeops_meta": {
                        "suiteId": "lifeops-self-care",
                        "baseScenarioId": scen["id"],
                        "scenarioTitle": scen["title"],
                        "domain": scen["domain"],
                        "basePrompt": base,
                        "prompt": prompt,
                        "variantId": variant_id,
                        "variantLabel": variant_label,
                        "axes": axes,
                        "riskClass": "null" if expected_action is None and positive else risk_class,
                        "benchmarkWeight": weight,
                        "expectedAction": expected_action,
                        "acceptableActions": [],
                        "forbiddenActions": [],
                        "tags": ["lifeops-self-care", scen["domain"], variant_id, *scen["tags"]],
                    },
                }
            )

    # ---- executive-assistant scenarios from catalog ----
    catalog_path = LIFEOPS_CATALOGS / "ice-bambam-executive-assistant.json"
    catalog = json.loads(catalog_path.read_text())
    ea_scen_dir = ELIZA_ROOT / "test" / "scenarios" / "executive-assistant"
    for entry in catalog.get("scenarios", []):
        scen_id = entry["id"]
        # Try to load detailed scenario file (some may be missing); the catalog
        # already contains the prompts and actions we need either way.
        scen_path = ea_scen_dir / f"{scen_id}.scenario.ts"
        scen_detail = parse_scenario_file(scen_path) if scen_path.exists() else None

        actions = list(entry.get("actions", []))
        # filter out REPLY similar to TS code
        actions = [a for a in actions if a != "REPLY"]
        expected_action = actions[0] if actions else None
        title = entry.get("title", scen_id)
        domain = entry.get("suite", "executive-assistant")
        base_prompt = (
            entry.get("benchmarkPrompt") or entry.get("examplePrompt") or ""
        ).strip()
        if not base_prompt and scen_detail:
            base_prompt = scen_detail["firstMessage"]
        if not base_prompt:
            continue
        for variant_id, variant_label, rewrite, axes, risk_class, weight in VARIANTS:
            prompt = rewrite(base_prompt)
            positive = variant_id != "subtle-null"
            ea_expected = expected_action if positive else None
            entries.append(
                {
                    "task_id": f"lifeops.{scen_id}.{variant_id}",
                    "source_path": str(catalog_path.relative_to(ELIZA_ROOT.parent)),
                    "source_kind": "lifeops",
                    "plugin": None,
                    "template": (
                        "Lifeops executive-assistant benchmark prompt.\n\n"
                        f"Scenario: {title} ({scen_id})\n"
                        f"Variant: {variant_label}\n"
                        f"User message: {prompt}\n\n"
                        f"Expected primary action: "
                        f"{ea_expected if ea_expected else 'REPLY (no durable action)'}"
                    ),
                    "variables": [],
                    "output_format": "text",
                    "expected_keys": [],
                    "examples": [
                        json.dumps(
                            {
                                "expectedAction": ea_expected,
                                "acceptableActions": (
                                    actions[1:] if positive else ["REPLY"]
                                ),
                                "forbiddenActions": (
                                    [] if positive else actions
                                ),
                            }
                        )
                    ],
                    "lifeops_meta": {
                        "suiteId": "lifeops-executive-assistant",
                        "baseScenarioId": scen_id,
                        "scenarioTitle": title,
                        "domain": domain,
                        "basePrompt": base_prompt,
                        "prompt": prompt,
                        "variantId": variant_id,
                        "variantLabel": variant_label,
                        "axes": axes,
                        "riskClass": risk_class,
                        "benchmarkWeight": weight,
                        "expectedAction": ea_expected,
                        "acceptableActions": (
                            actions[1:] if positive else ["REPLY"]
                        ),
                        "forbiddenActions": [] if positive else actions,
                        "tags": ["lifeops-executive-assistant", domain, variant_id],
                    },
                }
            )
    return entries


# --------------------------- main -------------------------------------------


def main() -> None:
    v1_entries = load_v1_entries()

    core_entries = build_core_entries()
    plugin_entries = build_plugin_entries()
    lifeops_entries = build_lifeops_entries()

    # For core prompts, prefer v1 entries (they are hand-curated), but fill in any
    # core txt files not yet in v1.
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

    all_entries = merged_core + inline_action_entries + plugin_entries + lifeops_entries

    out = {
        "version": 2,
        "generated_from": "eliza-core+plugins+lifeops",
        "n_entries": len(all_entries),
        "n_core": len(merged_core),
        "n_inline_action": len(inline_action_entries),
        "n_plugin": len(plugin_entries),
        "n_lifeops": len(lifeops_entries),
        "entries": all_entries,
    }
    V2_REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    V2_REGISTRY.write_text(json.dumps(out, indent=2))
    print(
        f"wrote {V2_REGISTRY} entries={len(all_entries)} "
        f"core={len(merged_core)} plugin={len(plugin_entries)} lifeops={len(lifeops_entries)}"
    )


if __name__ == "__main__":
    main()
