"""Phase 1 + Phase 2: drive scenarios through a teacher model.

Phase 1 (smoke): `--only FINALIZE_WORKSPACE`
Phase 2 (sweep): no --only, walks every action with a populated scenario pool.

The default endpoint is the development OpenAI-compatible Groq endpoint, but
the teacher model and endpoint are CLI/env configuration. Resume-safe via
per-action JSONL scenario-id keys.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.toon import ToonDecoder  # noqa: E402

from . import emit, validate as v  # noqa: E402
from .personas import Persona, PERSONAS  # noqa: E402
from .prompt import (  # noqa: E402
    build_canonical_record,
    build_tool_specs,
    build_user_messages,
    system_prompt_for_action,
    visible_actions_for,
)


CATALOG_PATH = ROOT / "data" / "prompts" / "actions-catalog.json"
POOL_DIR = ROOT / "scripts" / "harness" / "scenario_pool"
LOG_DIR = ROOT / "data" / "synthesized" / "harness" / "logs"

DEFAULT_API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_API_KEY_ENV = "GROQ_API_KEY"
DEFAULT_DEV_MODEL = "openai/gpt-oss-120b"


def default_teacher_model() -> str:
    return (
        os.environ.get("MILADY_HARNESS_MODEL")
        or os.environ.get("MILADY_COLLECTION_MODEL")
        or DEFAULT_DEV_MODEL
    )


def stable_scenario_id(action: str, idx: int, user_message: str) -> str:
    h = hashlib.sha256()
    h.update(action.encode())
    h.update(b"\x00")
    h.update(str(idx).encode())
    h.update(b"\x00")
    h.update(user_message.encode("utf-8"))
    return h.hexdigest()[:16]


def load_catalog() -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))["actions"]
    by_name_map = {a["name"]: a for a in catalog}
    return catalog, by_name_map


def load_scenarios_for(action_name: str) -> list[dict[str, Any]]:
    p = POOL_DIR / f"{action_name}.jsonl"
    if not p.exists():
        return []
    out: list[dict[str, Any]] = []
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def pick_persona(scenario: dict[str, Any]) -> Persona:
    """Map scenario language + persona label to one of the 8 fixed personas."""
    lang = scenario.get("language") or "en"
    desired_register = (scenario.get("persona") or "").lower()

    # exact language match
    candidates = [p for p in PERSONAS if p.language == lang]
    if not candidates:
        candidates = list(PERSONAS)

    # try register match
    for p in candidates:
        if desired_register and desired_register in p.register:
            return p
    return candidates[0]


def determine_task_type(action: dict[str, Any]) -> str:
    """Decide which template to use.

    The catalog only carries `message_handler`-style actions today (the
    runtime emits message_handler envelopes for both direct actions and
    TASK_CALL routing). We default to message_handler everywhere; the
    validator handles both shapes.
    """
    return "message_handler"


async def call_openai_compatible(
    client: httpx.AsyncClient,
    api_key: str,
    messages: list[dict[str, str]],
    sem: asyncio.Semaphore,
    *,
    api_url: str,
    model: str,
    reasoning_effort: str,
    temperature: float,
    max_tokens: int = 800,
) -> tuple[str, str]:
    """Returns (content, raw_reasoning) on success or empty strings."""
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "milady-training-harness/1.0",
    }
    backoff = 5.0
    last_content = ""
    last_reasoning = ""
    for attempt in range(8):
        async with sem:
            try:
                r = await client.post(api_url, json=payload, headers=headers, timeout=120.0)
            except (httpx.HTTPError, asyncio.TimeoutError):
                if attempt == 7:
                    return last_content, last_reasoning
                await asyncio.sleep(backoff)
                backoff = min(backoff * 1.7, 60)
                continue
        if r.status_code == 429:
            try:
                wait = float(r.headers.get("retry-after", backoff))
            except ValueError:
                wait = backoff
            await asyncio.sleep(wait + 1.0)
            backoff = min(backoff * 1.7, 60)
            continue
        if r.status_code in (403, 502, 503, 504):
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.7, 60)
            continue
        if r.status_code != 200:
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.5, 30)
            continue
        try:
            data = r.json()
            choice = data["choices"][0]["message"]
            content = (choice.get("content") or "").strip()
            reasoning = (choice.get("reasoning") or "").strip()
        except (KeyError, ValueError, IndexError):
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.5, 30)
            continue
        last_content = content or last_content
        last_reasoning = reasoning or last_reasoning
        if content:
            return content, reasoning
        # if no content, but reasoning has TOON-looking text, return that
        if reasoning and ("\n" in reasoning) and (":" in reasoning):
            return reasoning, reasoning
        await asyncio.sleep(backoff)
        backoff = min(backoff * 1.5, 30)
    return last_content, last_reasoning


async def process_scenario(
    *,
    client: httpx.AsyncClient,
    api_key: str,
    action: dict[str, Any],
    catalog: list[dict[str, Any]],
    catalog_action_names: set[str],
    api_url: str,
    model: str,
    reasoning_effort: str,
    scenario: dict[str, Any],
    scenario_idx: int,
    decoder: ToonDecoder,
    decoder_lock: asyncio.Lock,
    sem: asyncio.Semaphore,
) -> dict[str, Any]:
    """Returns a status dict: {ok, reason, accepted, scenario_id}."""
    action_name = action["name"]
    user_message = scenario["user_message"]
    scenario_id = stable_scenario_id(action_name, scenario_idx, user_message)

    persona = pick_persona(scenario)
    task_type = determine_task_type(action)

    available_actions = visible_actions_for(action, catalog)
    tool_specs = build_tool_specs(action)
    system_prompt = system_prompt_for_action(
        agent_id="milady",
        action_name=action_name,
        available_actions=available_actions,
        tool_specs=tool_specs,
    )
    messages = build_user_messages(persona=persona, user_message=user_message, system_prompt=system_prompt)

    expected_arg_keys = scenario.get("expected_arg_keys") or []

    raw, reasoning = await call_openai_compatible(
        client,
        api_key,
        messages,
        sem,
        api_url=api_url,
        model=model,
        reasoning_effort=reasoning_effort,
        temperature=0.7,
    )

    async def _validate(text: str) -> v.ValidationResult:
        async with decoder_lock:
            return v.validate(
                raw_response=text,
                decoder=decoder,
                task_type=task_type,
                scenario_kind=scenario["kind"],
                expected_action=action_name,
                expected_arg_keys=expected_arg_keys,
                catalog_action_names=catalog_action_names,
            )

    result = await _validate(raw) if raw else v.ValidationResult(False, "no content")
    if not result.ok:
        # retry once at lower temp
        retry_raw, retry_reasoning = await call_openai_compatible(
            client,
            api_key,
            messages,
            sem,
            api_url=api_url,
            model=model,
            reasoning_effort=reasoning_effort,
            temperature=0.4,
        )
        retry_result = await _validate(retry_raw) if retry_raw else v.ValidationResult(False, "no content")
        if retry_result.ok:
            raw = retry_raw
            result = retry_result
        else:
            emit.append_failure({
                "action": action_name,
                "scenario_id": scenario_id,
                "scenario_kind": scenario["kind"],
                "user_message": user_message,
                "first_reason": result.reason,
                "second_reason": retry_result.reason,
                "raw_first": raw[:1500] if raw else "",
                "raw_second": retry_raw[:1500] if retry_raw else "",
            })
            return {
                "ok": False,
                "scenario_id": scenario_id,
                "reason": retry_result.reason or result.reason,
                "accepted": False,
            }

    # Accepted. Emit canonical record.
    record = build_canonical_record(
        persona=persona,
        action=action,
        catalog=catalog,
        user_message=user_message,
        system_prompt=system_prompt,
        available_actions=available_actions,
        tool_specs=tool_specs,
        expected_response=result.cleaned_text,
        scenario_kind=scenario["kind"],
        expected_action=action_name,
        expected_arg_keys=expected_arg_keys,
        task_type=task_type,
    )
    record["metadata"]["harness_scenario_id"] = scenario_id
    emit.append_record(action_name, record)
    return {
        "ok": True,
        "scenario_id": scenario_id,
        "reason": result.reason,
        "accepted": True,
    }


async def process_action(
    *,
    client: httpx.AsyncClient,
    api_key: str,
    action: dict[str, Any],
    catalog: list[dict[str, Any]],
    catalog_action_names: set[str],
    api_url: str,
    model: str,
    reasoning_effort: str,
    decoder: ToonDecoder,
    decoder_lock: asyncio.Lock,
    sem: asyncio.Semaphore,
    stats_lock: asyncio.Lock,
    global_stats: dict[str, Any],
) -> dict[str, Any]:
    name = action["name"]
    scenarios = load_scenarios_for(name)
    already = emit.existing_keys(name)

    accepted = 0
    rejected = 0
    failure_reasons: dict[str, int] = {}

    todo: list[tuple[int, dict[str, Any]]] = []
    for idx, sc in enumerate(scenarios):
        sid = stable_scenario_id(name, idx, sc.get("user_message", ""))
        if sid in already:
            continue
        todo.append((idx, sc))

    for idx, sc in todo:
        result = await process_scenario(
            client=client,
            api_key=api_key,
            action=action,
            catalog=catalog,
            catalog_action_names=catalog_action_names,
            api_url=api_url,
            model=model,
            reasoning_effort=reasoning_effort,
            scenario=sc,
            scenario_idx=idx,
            decoder=decoder,
            decoder_lock=decoder_lock,
            sem=sem,
            )
        if result["accepted"]:
            accepted += 1
        else:
            rejected += 1
            failure_reasons[result["reason"][:80] or "unknown"] = (
                failure_reasons.get(result["reason"][:80] or "unknown", 0) + 1
            )
        async with stats_lock:
            global_stats["done"] += 1
            if result["accepted"]:
                global_stats["accepted"] += 1
            else:
                global_stats["rejected"] += 1

    return {
        "action": name,
        "scenarios": len(scenarios),
        "skipped_existing": len(already),
        "accepted": accepted,
        "rejected": rejected,
        "failure_reasons": failure_reasons,
    }


async def main_async(args: argparse.Namespace) -> None:
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        print(f"error: {args.api_key_env} not set", file=sys.stderr)
        sys.exit(2)

    catalog, by_name_map = load_catalog()
    catalog_action_names = {a["name"] for a in catalog}

    if args.only:
        wanted = set(args.only.split(","))
        actions = [a for a in catalog if a["name"] in wanted]
    else:
        actions = [a for a in catalog if (POOL_DIR / f"{a['name']}.jsonl").exists()]

    if not actions:
        print("error: no actions to process (scenario pool empty?)", file=sys.stderr)
        sys.exit(2)

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    decoder = ToonDecoder()
    decoder_lock = asyncio.Lock()
    sem = asyncio.Semaphore(args.concurrency)
    stats_lock = asyncio.Lock()
    global_stats = {"done": 0, "accepted": 0, "rejected": 0}

    manifest = emit.load_manifest()

    start = time.time()
    print(
        f"[harness] processing {len(actions)} actions, concurrency={args.concurrency}, "
        f"provider={args.provider_label}, model={args.model}",
        file=sys.stderr,
    )

    async with httpx.AsyncClient(http2=False, limits=httpx.Limits(
        max_connections=args.concurrency * 2,
        max_keepalive_connections=args.concurrency,
    )) as client:

        async def reporter():
            while True:
                await asyncio.sleep(15)
                el = time.time() - start
                rps = global_stats["done"] / max(1, el)
                print(
                    f"[progress] done={global_stats['done']} accepted={global_stats['accepted']} "
                    f"rejected={global_stats['rejected']} rps={rps:.2f} elapsed={el:.0f}s",
                    file=sys.stderr,
                )

        rep_task = asyncio.create_task(reporter())
        try:
            tasks = [
                process_action(
                    client=client,
                    api_key=api_key,
                    action=action,
                    catalog=catalog,
                    catalog_action_names=catalog_action_names,
                    api_url=args.api_url,
                    model=args.model,
                    reasoning_effort=args.reasoning_effort,
                    decoder=decoder,
                    decoder_lock=decoder_lock,
                    sem=sem,
                    stats_lock=stats_lock,
                    global_stats=global_stats,
                )
                for action in actions
            ]
            results = await asyncio.gather(*tasks)
        finally:
            rep_task.cancel()
            try:
                await rep_task
            except asyncio.CancelledError:
                pass

    decoder.close()

    for r in results:
        manifest["actions"][r["action"]] = {
            "scenarios": r["scenarios"],
            "skipped_existing": r["skipped_existing"],
            "accepted": r["accepted"],
            "rejected": r["rejected"],
            "failure_reasons": r["failure_reasons"],
        }
    manifest["last_run_elapsed_sec"] = round(time.time() - start, 1)
    manifest["last_run_actions"] = len(actions)
    manifest["last_run_global"] = global_stats
    manifest["last_run_teacher"] = {
        "provider": args.provider_label,
        "model": args.model,
        "api_url": args.api_url,
        "api_key_env": args.api_key_env,
        "reasoning_effort": args.reasoning_effort or None,
    }
    emit.save_manifest(manifest)

    elapsed = time.time() - start
    print(f"[harness done] global={global_stats} elapsed={elapsed:.0f}s", file=sys.stderr)
    # Print per-action summary
    for r in sorted(results, key=lambda x: -x["accepted"]):
        top_reason = ""
        if r["failure_reasons"]:
            tk = max(r["failure_reasons"].items(), key=lambda kv: kv[1])
            top_reason = f"  top_fail='{tk[0]}'(x{tk[1]})"
        print(
            f"  {r['action']:36s} scenarios={r['scenarios']:3d} "
            f"skipped={r['skipped_existing']:3d} accepted={r['accepted']:3d} "
            f"rejected={r['rejected']:3d}{top_reason}",
            file=sys.stderr,
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=str, default="", help="comma-separated action names")
    ap.add_argument("--concurrency", type=int, default=16)
    ap.add_argument("--model", default=default_teacher_model())
    ap.add_argument("--api-url", default=os.environ.get("MILADY_HARNESS_API_URL", DEFAULT_API_URL))
    ap.add_argument("--api-key-env", default=os.environ.get("MILADY_HARNESS_API_KEY_ENV", DEFAULT_API_KEY_ENV))
    ap.add_argument("--provider-label", default=os.environ.get("MILADY_HARNESS_PROVIDER", "groq-dev"))
    ap.add_argument("--reasoning-effort", default=os.environ.get("MILADY_HARNESS_REASONING_EFFORT", "low"))
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
