"""Autonomous corpus scaler.

End-to-end pipeline: generate a batch via Cerebras, validate, run
PerfectAgent for STATIC scenarios (drop semantically broken ones), and
import survivors directly into the per-domain module. Tracks total
Cerebras spend and aborts cleanly when a budget cap is hit.

Operator usage::

    python -m eliza_lifeops_bench.scenarios._authoring.scale_corpus \
        --mode static --domain calendar --n 30 --budget-usd 5.0

Outputs:
- ``_authoring/candidates/<mode>/<domain>_batch_<N>.json`` — raw valid candidates
- ``_authoring/candidates/drop_log.md`` — append-only drop reasons
- ``_authoring/candidates/spend_log.jsonl`` — per-call cost telemetry
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ...clients.base import ClientCall
from ...clients.factory import make_client
from ...lifeworld.snapshots import SNAPSHOT_SPECS, build_world_for, package_root, snapshots_dir
from ...types import Domain, Scenario, ScenarioMode
from .._personas import ALL_PERSONAS
from .generate_candidates import (
    SPEC_LIVE_PATH,
    SPEC_PATH,
    _build_prompt,
    _load_existing_examples,
    _load_existing_live_examples,
    _strip_code_fences,
    _summarize_action_manifest,
    _summarize_personas,
    _summarize_snapshot,
)
from .import_reviewed import (
    DOMAIN_TO_LIST_NAME,
    DOMAIN_TO_LIVE_LIST_NAME,
    PERSONA_VAR_BY_ID,
    SCENARIOS_DIR,
    _render_scenario,
    _splice_into_module,
)
from .validate import validate_batch

DEFAULT_MANIFEST = package_root() / "manifests" / "actions.manifest.json"
DEFAULT_SNAPSHOT_DIR = snapshots_dir()
CANDIDATES_DIR = Path(__file__).parent / "candidates"
DROP_LOG = CANDIDATES_DIR / "drop_log.md"
SPEND_LOG = CANDIDATES_DIR / "spend_log.jsonl"


@dataclass
class BatchOutcome:
    """Counts + cost for one generate→validate→conformance→import batch."""

    requested: int = 0
    generated: int = 0
    validated: int = 0
    conformance_passed: int = 0
    imported: int = 0
    cost_usd: float = 0.0
    drops: list[tuple[str, str]] = field(default_factory=list)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log_drops(domain: str, mode: str, drops: list[tuple[str, str]]) -> None:
    if not drops:
        return
    DROP_LOG.parent.mkdir(parents=True, exist_ok=True)
    with DROP_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"\n## {_now_iso()} {mode}/{domain}\n")
        for cid, reason in drops:
            fh.write(f"- {cid}: {reason}\n")


def _log_spend(domain: str, mode: str, cost: float, prompt_tokens: int, completion_tokens: int) -> None:
    SPEND_LOG.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": _now_iso(),
        "domain": domain,
        "mode": mode,
        "cost_usd": cost,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
    }
    with SPEND_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


async def _cerebras_call(
    messages: list[dict[str, Any]],
    *,
    provider: str,
    model: str | None,
    max_tokens: int,
) -> tuple[str, float, int, int]:
    """Returns (content, cost_usd, prompt_tokens, completion_tokens)."""
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
        raise RuntimeError("Cerebras response had no content")
    # Unpriced models surface as ``None`` from the client; treat as 0.0
    # locally here so the authoring tool's spend log still aggregates a
    # number. The benchmark runner pipeline preserves ``None`` end-to-end.
    cost_value = float(response.cost_usd) if response.cost_usd is not None else 0.0
    return (
        response.content,
        cost_value,
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
    )


def _world_factory_for(scenario: Scenario):
    """Replicates the test_conformance helper for ad-hoc PerfectAgent runs."""
    spec_name = "medium_seed_2026" if scenario.world_seed == 2026 else "tiny_seed_42"
    spec = next(s for s in SNAPSHOT_SPECS if s.name == spec_name)

    def _factory(_seed: int, _now_iso: str):
        return build_world_for(spec)

    return _factory


async def _conformance_check_one(scenario: Scenario, supported: set[str]) -> tuple[bool, str]:
    """Run PerfectAgent against the scenario; return (passed, reason)."""
    gt_names = {a.name for a in scenario.ground_truth_actions}
    if not gt_names.issubset(supported):
        unsupported = sorted(gt_names - supported)
        return True, f"executor-unsupported actions skipped: {unsupported}"

    from ...agents import PerfectAgent
    from ...runner import LifeOpsBenchRunner

    agent = PerfectAgent(scenario)

    async def agent_fn(history, tools):
        return await agent(history, tools)

    runner = LifeOpsBenchRunner(
        agent_fn=agent_fn,
        world_factory=_world_factory_for(scenario),
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=10.0,
        per_scenario_timeout_s=15,
    )
    try:
        result = await runner.run_one(scenario, scenario.world_seed)
    except Exception as exc:  # pragma: no cover - surface as drop reason
        return False, f"runner exception: {exc!r}"
    if result.total_score < 0.999:
        return False, (
            f"PerfectAgent score={result.total_score:.3f} "
            f"terminated={result.terminated_reason}"
        )
    return True, ""


def _scenario_from_candidate(c: dict[str, Any]) -> Scenario:
    """Materialize a Scenario dataclass from a validated candidate dict."""
    from ...types import Action, FirstQuestionFallback

    persona = next(p for p in ALL_PERSONAS if p.id == c["persona_id"])
    actions = [Action(name=a["name"], kwargs=a["kwargs"]) for a in c["ground_truth_actions"]]
    fallback_dict = c.get("first_question_fallback")
    fallback = (
        FirstQuestionFallback(canned_answer=fallback_dict["canned_answer"], applies_when=fallback_dict["applies_when"])
        if fallback_dict
        else None
    )
    mode = ScenarioMode.LIVE if c["mode"] == "live" else ScenarioMode.STATIC
    return Scenario(
        id=c["id"],
        name=c["name"],
        domain=Domain(c["domain"]),
        mode=mode,
        persona=persona,
        instruction=c["instruction"],
        ground_truth_actions=actions,
        required_outputs=list(c.get("required_outputs", [])),
        first_question_fallback=fallback,
        world_seed=c["world_seed"],
        max_turns=c.get("max_turns", 8),
        description=c.get("description", ""),
        success_criteria=list(c.get("success_criteria", [])),
        world_assertions=list(c.get("world_assertions", [])),
    )


def _next_batch_index(domain: str, mode: str) -> int:
    out_dir = CANDIDATES_DIR / mode
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = re.compile(rf"^{re.escape(domain)}_batch_(\d+)\.json$")
    indices = []
    for p in out_dir.iterdir():
        m = pattern.match(p.name)
        if m:
            indices.append(int(m.group(1)))
    return (max(indices) + 1) if indices else 1


async def run_batch(
    *,
    mode: str,
    domain: Domain,
    n: int,
    provider: str,
    model: str | None,
    max_tokens: int,
    example_count: int,
) -> BatchOutcome:
    outcome = BatchOutcome(requested=n)

    snapshot_name = "medium_seed_2026"
    snapshot_path = DEFAULT_SNAPSHOT_DIR / f"{snapshot_name}.json"
    spec = (SPEC_LIVE_PATH if mode == "live" else SPEC_PATH).read_text(encoding="utf-8")
    manifest_summary = _summarize_action_manifest(DEFAULT_MANIFEST)
    snapshot_summary = _summarize_snapshot(snapshot_path)
    persona_summary = _summarize_personas()
    if mode == "live":
        examples = _load_existing_live_examples(domain, example_count)
    else:
        examples = _load_existing_examples(domain, example_count)

    messages = _build_prompt(
        domain,
        n,
        spec=spec,
        manifest_summary=manifest_summary,
        snapshot_summary=snapshot_summary,
        persona_summary=persona_summary,
        examples=examples,
        mode=mode,
    )

    raw, cost, p_tokens, c_tokens = await _cerebras_call(
        messages, provider=provider, model=model, max_tokens=max_tokens
    )
    outcome.cost_usd = cost
    _log_spend(domain.value, mode, cost, p_tokens, c_tokens)

    cleaned = _strip_code_fences(raw)
    try:
        candidates = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        outcome.drops.append(("<batch>", f"json_parse_error: {exc}"))
        return outcome
    if not isinstance(candidates, list):
        outcome.drops.append(("<batch>", "non-array root"))
        return outcome

    outcome.generated = len(candidates)

    # Domain + mode pre-filter (so the validator doesn't waste cycles).
    filtered: list[dict[str, Any]] = []
    for c in candidates:
        cid = c.get("id", "<unknown>") if isinstance(c, dict) else "<bad-shape>"
        if not isinstance(c, dict):
            outcome.drops.append((str(cid), "candidate is not an object"))
            continue
        if c.get("domain") != domain.value:
            outcome.drops.append((str(cid), f"wrong domain {c.get('domain')!r}"))
            continue
        if c.get("mode") != mode:
            outcome.drops.append((str(cid), f"wrong mode {c.get('mode')!r}"))
            continue
        filtered.append(c)

    results = validate_batch(
        filtered, manifest_path=DEFAULT_MANIFEST, snapshot_path=snapshot_path
    )

    valid: list[dict[str, Any]] = []
    for c, r in zip(filtered, results, strict=True):
        if r.is_valid:
            valid.append(c)
        else:
            outcome.drops.append(
                (
                    r.candidate_id,
                    "validate: " + "; ".join(f"{i.path}={i.message}" for i in r.issues),
                )
            )
    outcome.validated = len(valid)

    # Cross-batch ID dedup against current corpus + within batch.
    from .. import SCENARIOS_BY_ID
    from ..live import LIVE_SCENARIOS_BY_ID

    seen_ids: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for c in valid:
        cid = c["id"]
        if cid in SCENARIOS_BY_ID or cid in LIVE_SCENARIOS_BY_ID or cid in seen_ids:
            outcome.drops.append((cid, "duplicate id"))
            continue
        seen_ids.add(cid)
        deduped.append(c)

    # Conformance check: only for static.
    final: list[dict[str, Any]] = []
    if mode == "static":
        from ...runner import supported_actions

        supported = supported_actions()
        for c in deduped:
            try:
                scenario = _scenario_from_candidate(c)
            except Exception as exc:
                outcome.drops.append((c["id"], f"materialize_error: {exc!r}"))
                continue
            passed, reason = await _conformance_check_one(scenario, supported)
            if passed:
                outcome.conformance_passed += 1
                final.append(c)
            else:
                outcome.drops.append((c["id"], f"conformance: {reason}"))
    else:
        for c in deduped:
            try:
                _scenario_from_candidate(c)
            except Exception as exc:
                outcome.drops.append((c["id"], f"materialize_error: {exc!r}"))
                continue
            outcome.conformance_passed += 1
            final.append(c)

    if not final:
        return outcome

    # Persist the surviving batch as JSON for traceability.
    out_dir = CANDIDATES_DIR / mode
    idx = _next_batch_index(domain.value, mode)
    out_path = out_dir / f"{domain.value}_batch_{idx:03d}.json"
    out_path.write_text(json.dumps(final, indent=2), encoding="utf-8")

    # Import directly into the per-domain module.
    rendered = "".join(_render_scenario(c) for c in final)
    personas_needed = {PERSONA_VAR_BY_ID[c["persona_id"]] for c in final}
    if mode == "live":
        module_path = SCENARIOS_DIR / "live" / f"{domain.value}.py"
        list_name = DOMAIN_TO_LIVE_LIST_NAME[domain.value]
        _splice_into_module(
            module_path, list_name, rendered,
            personas_needed=personas_needed, is_live=True,
        )
    else:
        module_path = SCENARIOS_DIR / f"{domain.value}.py"
        list_name = DOMAIN_TO_LIST_NAME[domain.value]
        _splice_into_module(
            module_path, list_name, rendered,
            personas_needed=personas_needed, is_live=False,
        )
    outcome.imported = len(final)
    return outcome


async def _async_main(args: argparse.Namespace) -> int:
    domain = Domain(args.domain)
    spent = 0.0
    total_imported = 0
    total_validated = 0
    total_generated = 0
    all_drops: list[tuple[str, str]] = []

    for batch_no in range(1, args.batches + 1):
        if spent >= args.budget_usd:
            print(f"[scale_corpus] hit budget cap at batch {batch_no}; stopping")
            break
        print(f"[scale_corpus] {args.mode}/{domain.value} batch {batch_no}/{args.batches} (spent ${spent:.4f})")
        t0 = time.perf_counter()
        outcome = await run_batch(
            mode=args.mode,
            domain=domain,
            n=args.n,
            provider=args.provider,
            model=args.model,
            max_tokens=args.max_tokens,
            example_count=args.example_count,
        )
        elapsed = time.perf_counter() - t0
        spent += outcome.cost_usd
        total_imported += outcome.imported
        total_validated += outcome.validated
        total_generated += outcome.generated
        all_drops.extend(outcome.drops)
        print(
            f"  generated={outcome.generated} validated={outcome.validated} "
            f"conformance_passed={outcome.conformance_passed} imported={outcome.imported} "
            f"cost=${outcome.cost_usd:.4f} elapsed={elapsed:.1f}s"
        )

    _log_drops(domain.value, args.mode, all_drops)
    print(
        f"[scale_corpus] DONE {args.mode}/{domain.value}: "
        f"imported={total_imported}/{total_generated} "
        f"validated_rate={(total_validated / total_generated * 100) if total_generated else 0:.0f}% "
        f"imported_rate={(total_imported / total_generated * 100) if total_generated else 0:.0f}% "
        f"spent=${spent:.4f}"
    )
    print(f"BATCH_RESULT {json.dumps({'domain': domain.value, 'mode': args.mode, 'imported': total_imported, 'validated': total_validated, 'generated': total_generated, 'spent_usd': spent})}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scale_corpus")
    parser.add_argument("--domain", required=True, choices=[d.value for d in Domain])
    parser.add_argument("--mode", required=True, choices=["static", "live"])
    parser.add_argument("--n", type=int, default=30, help="Candidates requested per batch.")
    parser.add_argument("--batches", type=int, default=1)
    parser.add_argument("--budget-usd", type=float, default=2.0)
    parser.add_argument("--provider", default="cerebras")
    parser.add_argument("--model", default=None)
    parser.add_argument("--max-tokens", type=int, default=12288)
    parser.add_argument("--example-count", type=int, default=5)
    args = parser.parse_args(argv)
    return asyncio.run(_async_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
