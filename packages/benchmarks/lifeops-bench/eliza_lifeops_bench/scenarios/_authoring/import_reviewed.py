"""Append reviewed candidate scenarios into the right per-domain module.

Operator usage::

    python -m eliza_lifeops_bench.scenarios._authoring.import_reviewed \\
        candidates/calendar_batch_001.json --domain calendar

The script:
1. Re-validates every candidate against the manifest + snapshot. Any
   invalid entry aborts the import for the whole batch — review locally
   first.
2. Renders each candidate as a Python ``Scenario(...)`` literal.
3. Appends the rendered block to ``scenarios/<domain>.py`` just before
   the closing ``]`` of the ``<DOMAIN>_SCENARIOS`` list.

The script never overwrites existing entries. Re-importing a candidate
with a duplicate id aborts.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ...lifeworld.snapshots import package_root, snapshots_dir
from ...types import Domain
from .. import SCENARIOS_BY_ID
from .validate import validate_batch

DEFAULT_MANIFEST = package_root() / "manifests" / "actions.manifest.json"
DEFAULT_SNAPSHOT_DIR = snapshots_dir()
SCENARIOS_DIR = Path(__file__).resolve().parents[1]

PERSONA_VAR_BY_ID: dict[str, str] = {
    "alex_eng": "PERSONA_ALEX_ENG",
    "ria_pm": "PERSONA_RIA_PM",
    "sam_founder": "PERSONA_SAM_FOUNDER",
    "maya_parent": "PERSONA_MAYA_PARENT",
    "dev_freelancer": "PERSONA_DEV_FREELANCER",
    "nora_consultant": "PERSONA_NORA_CONSULTANT",
    "owen_retiree": "PERSONA_OWEN_RETIREE",
    "tara_night": "PERSONA_TARA_NIGHT",
    "kai_student": "PERSONA_KAI_STUDENT",
    "lin_ops": "PERSONA_LIN_OPS",
}

DOMAIN_TO_LIST_NAME: dict[str, str] = {
    "calendar": "CALENDAR_SCENARIOS",
    "mail": "MAIL_SCENARIOS",
    "messages": "MESSAGES_SCENARIOS",
    "contacts": "CONTACTS_SCENARIOS",
    "reminders": "REMINDERS_SCENARIOS",
    "finance": "FINANCE_SCENARIOS",
    "travel": "TRAVEL_SCENARIOS",
    "health": "HEALTH_SCENARIOS",
    "sleep": "SLEEP_SCENARIOS",
    "focus": "FOCUS_SCENARIOS",
}

DOMAIN_TO_LIVE_LIST_NAME: dict[str, str] = {
    domain: f"LIVE_{name}" for domain, name in DOMAIN_TO_LIST_NAME.items()
}


def _render_value(value: Any, indent: int) -> str:
    """Render a JSON-shaped value as a Python literal with stable formatting."""
    pad = " " * indent
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return repr(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        items = [
            f"{pad}    {_render_value(item, indent + 4)},"
            for item in value
        ]
        return "[\n" + "\n".join(items) + f"\n{pad}]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [
            f"{pad}    {repr(k)}: {_render_value(v, indent + 4)},"
            for k, v in value.items()
        ]
        return "{\n" + "\n".join(items) + f"\n{pad}}}"
    raise TypeError(f"unrenderable value type {type(value).__name__}")


def _render_action(action: dict[str, Any], indent: int) -> str:
    pad = " " * indent
    return (
        "Action(\n"
        f"{pad}    name={action['name']!r},\n"
        f"{pad}    kwargs={_render_value(action.get('kwargs', {}), indent + 4)},\n"
        f"{pad})"
    )


def _render_fallback(fallback: dict[str, Any] | None, indent: int) -> str:
    if fallback is None:
        return "None"
    pad = " " * indent
    return (
        "FirstQuestionFallback(\n"
        f"{pad}    canned_answer={fallback['canned_answer']!r},\n"
        f"{pad}    applies_when={fallback['applies_when']!r},\n"
        f"{pad})"
    )


def _render_scenario(candidate: dict[str, Any]) -> str:
    persona_var = PERSONA_VAR_BY_ID[candidate["persona_id"]]
    actions = candidate["ground_truth_actions"]
    if actions:
        actions_block = (
            "[\n            "
            + ",\n            ".join(_render_action(a, 12) for a in actions)
            + ",\n        ]"
        )
    else:
        actions_block = "[]"
    required = repr(candidate.get("required_outputs", []))
    description = candidate["description"]
    domain_value = candidate["domain"].upper()
    mode_value = candidate["mode"].upper()
    extra = ""
    success = candidate.get("success_criteria")
    if success:
        rendered_success = "[\n            " + ",\n            ".join(repr(s) for s in success) + ",\n        ]"
        extra += f"        success_criteria={rendered_success},\n"
    assertions = candidate.get("world_assertions")
    if assertions:
        rendered_assertions = "[\n            " + ",\n            ".join(repr(s) for s in assertions) + ",\n        ]"
        extra += f"        world_assertions={rendered_assertions},\n"
    return (
        "    Scenario(\n"
        f"        id={candidate['id']!r},\n"
        f"        name={candidate['name']!r},\n"
        f"        domain=Domain.{domain_value},\n"
        f"        mode=ScenarioMode.{mode_value},\n"
        f"        persona={persona_var},\n"
        f"        instruction={candidate['instruction']!r},\n"
        f"        ground_truth_actions={actions_block},\n"
        f"        required_outputs={required},\n"
        f"        first_question_fallback={_render_fallback(candidate.get('first_question_fallback'), 8)},\n"
        f"        world_seed={candidate['world_seed']},\n"
        f"        max_turns={candidate['max_turns']},\n"
        f"        description={description!r},\n"
        f"{extra}"
        "    ),\n"
    )


def _splice_into_module(module_path: Path, list_name: str, rendered: str) -> None:
    text = module_path.read_text(encoding="utf-8")
    marker = f"{list_name}: list[Scenario] = ["
    if marker not in text:
        raise ValueError(f"could not find list marker {marker!r} in {module_path}")
    head, _, rest = text.partition(marker)
    body, sep, tail = rest.partition("\n]")
    if not sep:
        raise ValueError(
            f"could not find closing bracket for {list_name} in {module_path}"
        )
    new_text = head + marker + body + rendered + sep + tail
    module_path.write_text(new_text, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="import_reviewed")
    parser.add_argument("input", type=Path, help="Reviewed candidates JSON file.")
    parser.add_argument("--domain", required=True, choices=list(DOMAIN_TO_LIST_NAME))
    parser.add_argument("--mode", default="static", choices=["static", "live"])
    parser.add_argument("--world-seed", type=int, default=2026)
    args = parser.parse_args(argv)

    candidates = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(candidates, list):
        print("input file must contain a JSON array", file=sys.stderr)
        return 2

    snapshot_name = "tiny_seed_42" if args.world_seed == 42 else "medium_seed_2026"
    snapshot_path = DEFAULT_SNAPSHOT_DIR / f"{snapshot_name}.json"
    results = validate_batch(
        candidates,
        manifest_path=DEFAULT_MANIFEST,
        snapshot_path=snapshot_path,
    )
    invalid = [r for r in results if not r.is_valid]
    if invalid:
        for r in invalid:
            for issue in r.issues:
                print(f"INVALID {r.candidate_id} -> {issue.path}: {issue.message}",
                      file=sys.stderr)
        return 2

    from .live import LIVE_SCENARIOS_BY_ID

    expected_mode = args.mode
    for candidate in candidates:
        if candidate["domain"] != args.domain:
            print(
                f"candidate {candidate['id']} has domain {candidate['domain']}, "
                f"expected {args.domain}",
                file=sys.stderr,
            )
            return 2
        if candidate.get("mode") != expected_mode:
            print(
                f"candidate {candidate['id']} has mode {candidate.get('mode')!r}, "
                f"expected {expected_mode!r}",
                file=sys.stderr,
            )
            return 2
        if candidate["id"] in SCENARIOS_BY_ID or candidate["id"] in LIVE_SCENARIOS_BY_ID:
            print(
                f"candidate {candidate['id']} already exists in the corpus",
                file=sys.stderr,
            )
            return 2

    rendered_blocks = "".join(_render_scenario(c) for c in candidates)
    if args.mode == "live":
        module_path = SCENARIOS_DIR / "live" / f"{args.domain}.py"
        list_name = DOMAIN_TO_LIVE_LIST_NAME[args.domain]
    else:
        module_path = SCENARIOS_DIR / f"{args.domain}.py"
        list_name = DOMAIN_TO_LIST_NAME[args.domain]
    _splice_into_module(module_path, list_name, rendered_blocks)
    print(f"appended {len(candidates)} scenarios to {module_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
