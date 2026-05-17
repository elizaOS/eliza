"""Cerebras-driven candidate scenario generator.

Operator usage::

    python -m eliza_lifeops_bench.scenarios._authoring.generate_candidates \\
        --domain calendar --n 20 --output candidates/calendar_batch_001.json

The script never auto-imports candidates into the corpus. The output
JSON is reviewed by a human and then explicitly imported via
``import_reviewed.py``.

Determinism: this script intentionally calls a live LLM, so its output
is not deterministic. The validator step is deterministic — running it
twice on the same JSON yields identical issues.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from ...clients.base import ClientCall
from ...clients.factory import make_client
from ...lifeworld.snapshots import package_root, snapshots_dir
from ...types import Domain
from .._personas import ALL_PERSONAS
from .validate import validate_batch

DEFAULT_MANIFEST = package_root() / "manifests" / "actions.manifest.json"
DEFAULT_SNAPSHOT_DIR = snapshots_dir()
SPEC_PATH = Path(__file__).parent / "spec.md"
SPEC_LIVE_PATH = Path(__file__).parent / "spec_live.md"


def _load_existing_live_examples(domain: Domain, count: int) -> list[dict[str, Any]]:
    """Load up to ``count`` hand-authored LIVE scenarios from the target domain."""
    from ..live import LIVE_SCENARIOS_BY_DOMAIN

    existing = LIVE_SCENARIOS_BY_DOMAIN.get(domain, [])[:count]
    out: list[dict[str, Any]] = []
    for scenario in existing:
        out.append(
            {
                "id": scenario.id,
                "name": scenario.name,
                "domain": scenario.domain.value,
                "mode": scenario.mode.value,
                "persona_id": scenario.persona.id,
                "instruction": scenario.instruction,
                "ground_truth_actions": [],
                "required_outputs": [],
                "first_question_fallback": None,
                "world_seed": scenario.world_seed,
                "max_turns": scenario.max_turns,
                "description": scenario.description,
                "success_criteria": list(scenario.success_criteria),
                "world_assertions": list(scenario.world_assertions),
            }
        )
    return out


def _load_existing_examples(domain: Domain, count: int) -> list[dict[str, Any]]:
    """Load up to ``count`` hand-authored scenarios from the target domain.

    Returned as plain dicts (the same shape candidates must follow).
    """
    from .. import SCENARIOS_BY_DOMAIN

    existing = SCENARIOS_BY_DOMAIN.get(domain, [])[:count]
    out: list[dict[str, Any]] = []
    for scenario in existing:
        fallback = scenario.first_question_fallback
        out.append(
            {
                "id": scenario.id,
                "name": scenario.name,
                "domain": scenario.domain.value,
                "mode": scenario.mode.value,
                "persona_id": scenario.persona.id,
                "instruction": scenario.instruction,
                "ground_truth_actions": [
                    {"name": a.name, "kwargs": a.kwargs}
                    for a in scenario.ground_truth_actions
                ],
                "required_outputs": list(scenario.required_outputs),
                "first_question_fallback": (
                    None
                    if fallback is None
                    else asdict(fallback)
                ),
                "world_seed": scenario.world_seed,
                "max_turns": scenario.max_turns,
                "description": scenario.description,
            }
        )
    return out


def _summarize_action_manifest(manifest_path: Path) -> str:
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    lines: list[str] = []
    for entry in raw.get("actions", []):
        function = entry.get("function") or {}
        name = function.get("name")
        params = (function.get("parameters") or {}).get("properties") or {}
        required = (function.get("parameters") or {}).get("required") or []
        if not isinstance(name, str):
            continue
        param_summary = ", ".join(
            f"{k}:{v.get('type', '?')}" + ("!" if k in required else "")
            for k, v in params.items()
        )
        lines.append(f"- {name}({param_summary})")
    return "\n".join(lines)


def _summarize_snapshot(snapshot_path: Path) -> str:
    raw = json.loads(snapshot_path.read_text(encoding="utf-8"))
    stores = raw.get("stores", {})
    lines: list[str] = [
        f"snapshot now_iso = {raw.get('now_iso')}, seed = {raw.get('seed')}",
    ]
    for kind, items in sorted(stores.items()):
        keys = list(items.keys())
        sample = ", ".join(keys[:3])
        lines.append(f"- {kind} ({len(keys)}): sample ids {sample}")
    return "\n".join(lines)


def _summarize_personas() -> str:
    lines: list[str] = []
    for persona in ALL_PERSONAS:
        lines.append(
            f"- {persona.id}: {persona.name} - {persona.communication_style}"
        )
    return "\n".join(lines)


def _build_prompt(
    domain: Domain,
    n: int,
    *,
    spec: str,
    manifest_summary: str,
    snapshot_summary: str,
    persona_summary: str,
    examples: list[dict[str, Any]],
    mode: str = "static",
) -> list[dict[str, Any]]:
    if mode == "live":
        system = (
            "You are a careful test-corpus author for an AI life assistant. "
            "You write LIVE scenarios that test the assistant's judgment in "
            "open-ended, multi-turn conversations. The user side is itself an "
            "LLM, and scoring is done by an LLM judge using success_criteria "
            "and world_assertions, NOT by exact action matching."
        )
        sections = [
            "# SPEC",
            spec,
            "# AVAILABLE PERSONAS",
            persona_summary,
            "# WORLD SNAPSHOT",
            snapshot_summary,
            "# EXAMPLES OF GOOD HAND-AUTHORED LIVE SCENARIOS",
            json.dumps(examples, indent=2),
            f"# TASK\nReturn a JSON array of {n} new LIVE scenarios for the "
            f"`{domain.value}` domain. mode MUST be 'live'. ground_truth_actions "
            "MUST be []. required_outputs MUST be []. first_question_fallback "
            "MUST be null. Each scenario MUST include success_criteria (2-4 "
            "items) and world_assertions (1-3 items). JSON only, no prose, no "
            "fences. Vary personas across the batch; do not duplicate ids of "
            "the existing examples. Use unique ids prefixed with "
            f"`live.{domain.value}.`.",
        ]
    else:
        system = (
            "You are a careful test-corpus author for an AI life assistant. "
            "You write scenarios that test the assistant's ability to dispatch "
            "the right action with the right arguments against a seeded world."
        )
        sections = [
            "# SPEC",
            spec,
            "# AVAILABLE ACTIONS",
            manifest_summary,
            "# AVAILABLE PERSONAS",
            persona_summary,
            "# WORLD SNAPSHOT",
            snapshot_summary,
            "# EXAMPLES OF GOOD HAND-AUTHORED SCENARIOS",
            json.dumps(examples, indent=2),
            f"# TASK\nReturn a JSON array of {n} new scenarios for the "
            f"`{domain.value}` domain. JSON only, no prose, no fences. Vary "
            "personas across the batch; do not duplicate ids of the existing "
            "examples.",
        ]
    user = "\n\n".join(sections)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _strip_code_fences(text: str) -> str:
    fence_pattern = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)
    match = fence_pattern.match(text.strip())
    if match:
        return match.group(1)
    return text.strip()


async def _call_cerebras(
    messages: list[dict[str, Any]],
    *,
    provider: str,
    model: str | None,
    max_tokens: int,
) -> str:
    client = make_client(provider, model=model)
    response = await client.complete(
        ClientCall(
            messages=messages,
            tools=None,
            temperature=0.7,
            max_tokens=max_tokens,
            reasoning_effort="medium",
        )
    )
    if response.content is None:
        raise RuntimeError(
            "Generator response had no content; check provider+model and try again."
        )
    return response.content


async def _async_main(args: argparse.Namespace) -> int:
    domain = Domain(args.domain)
    is_live = args.mode == "live"

    snapshot_name = "tiny_seed_42" if args.world_seed == 42 else "medium_seed_2026"
    snapshot_path = DEFAULT_SNAPSHOT_DIR / f"{snapshot_name}.json"

    spec = (SPEC_LIVE_PATH if is_live else SPEC_PATH).read_text(encoding="utf-8")
    manifest_summary = _summarize_action_manifest(DEFAULT_MANIFEST)
    snapshot_summary = _summarize_snapshot(snapshot_path)
    persona_summary = _summarize_personas()
    if is_live:
        examples = _load_existing_live_examples(domain, args.example_count)
    else:
        examples = _load_existing_examples(domain, args.example_count)

    messages = _build_prompt(
        domain,
        args.n,
        spec=spec,
        manifest_summary=manifest_summary,
        snapshot_summary=snapshot_summary,
        persona_summary=persona_summary,
        examples=examples,
        mode=args.mode,
    )

    if args.dry_run:
        print("--- prompt preview (system) ---")
        print(messages[0]["content"])
        print("--- prompt preview (user, first 4000 chars) ---")
        print(messages[1]["content"][:4000])
        return 0

    raw = await _call_cerebras(
        messages,
        provider=args.provider,
        model=args.model,
        max_tokens=args.max_tokens,
    )
    cleaned = _strip_code_fences(raw)
    try:
        candidates = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        print(f"Generator returned invalid JSON: {exc}", file=sys.stderr)
        if args.dump_invalid:
            args.dump_invalid.write_text(raw, encoding="utf-8")
        return 2
    if not isinstance(candidates, list):
        print("Generator returned a non-array JSON value.", file=sys.stderr)
        return 2

    results = validate_batch(
        candidates,
        manifest_path=DEFAULT_MANIFEST,
        snapshot_path=snapshot_path,
    )
    valid_candidates: list[dict[str, Any]] = []
    for candidate, result in zip(candidates, results, strict=True):
        if result.is_valid:
            valid_candidates.append(candidate)
        else:
            print(
                f"REJECT {result.candidate_id}: "
                + "; ".join(f"{i.path}: {i.message}" for i in result.issues),
                file=sys.stderr,
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(valid_candidates, indent=2),
        encoding="utf-8",
    )
    print(
        f"wrote {len(valid_candidates)}/{len(candidates)} valid candidates to {args.output}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="generate_candidates",
        description="Generate candidate LifeOpsBench scenarios via Cerebras.",
    )
    parser.add_argument("--domain", required=True, choices=[d.value for d in Domain])
    parser.add_argument("--n", type=int, default=10, help="Candidates to request.")
    parser.add_argument("--mode", default="static", choices=["static", "live"])
    parser.add_argument("--provider", default="cerebras")
    parser.add_argument("--model", default=None)
    parser.add_argument("--world-seed", type=int, default=2026)
    parser.add_argument("--example-count", type=int, default=5)
    parser.add_argument("--max-tokens", type=int, default=8192)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dump-invalid", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    return asyncio.run(_async_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
