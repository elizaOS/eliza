"""Phase 0: scenario pool generator.

For every catalog action we ask a configured teacher model once (per action)
for 25 distinct user messages spanning persona/register/language/argument
completeness, then persist them as JSONL under
`scripts/harness/scenario_pool/<action>.jsonl`.

Resume-safe: if the per-action JSONL already has >=20 lines, skip.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CATALOG_PATH = ROOT / "data" / "prompts" / "actions-catalog.json"
POOL_DIR = ROOT / "scripts" / "harness" / "scenario_pool"
LOG_DIR = ROOT / "data" / "synthesized" / "harness" / "logs"

DEFAULT_API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_API_KEY_ENV = "GROQ_API_KEY"
# Development models are intentionally not pinned here. Pass --model or set
# ELIZA_HARNESS_MODEL / ELIZA_COLLECTION_MODEL for the provider under test.
DEFAULT_DEV_MODEL = ""


def default_teacher_model() -> str:
    return (
        os.environ.get("ELIZA_HARNESS_MODEL")
        or os.environ.get("ELIZA_COLLECTION_MODEL")
        or DEFAULT_DEV_MODEL
    )

# Variation budget per action (~25 scenarios).
SCENARIO_BUDGET = (
    ("complete_args", 8),
    ("required_only", 6),
    ("missing_required", 4),
    ("multilingual", 4),
    ("distractor", 3),
)

ALL_LANGS = ("es", "pt", "ja", "zh")


def required_keys(action: dict[str, Any]) -> list[str]:
    return [p["name"] for p in (action.get("parameters") or []) if p.get("required")]


def optional_keys(action: dict[str, Any]) -> list[str]:
    return [p["name"] for p in (action.get("parameters") or []) if not p.get("required")]


SYSTEM_PROMPT = (
    "You generate diverse user-message scenarios for an LLM action-routing dataset. "
    "Each scenario is a single user utterance that should trigger a specific action.\n\n"
    "Output STRICT JSON: a single JSON object with key `scenarios` whose value is an "
    "ARRAY of objects, one per scenario. Each scenario object has keys:\n"
    "  - kind: one of complete_args | required_only | missing_required | multilingual | distractor\n"
    "  - language: ISO code (en, es, pt, ja, zh, fr, de, ko, ru)\n"
    "  - persona: short label (casual / formal / terse / verbose / non-native / impatient)\n"
    "  - user_message: the actual utterance, naturally phrased, 5-50 words\n"
    "  - notes: <=10 words explaining what makes this scenario distinct\n\n"
    "Rules:\n"
    "- Vary phrasing (imperative, declarative, question, abbreviation).\n"
    "- For `complete_args` scenarios: user supplies enough info to fill all required args plus some optional ones.\n"
    "- For `required_only`: user supplies the bare minimum (only required args).\n"
    "- For `missing_required`: user is vague enough that the agent should ask a clarifying question; required args are NOT supplied.\n"
    "- For `multilingual`: translate the request into the requested language naturally.\n"
    "- For `distractor`: text mentions some OTHER action's name or similar wording, but the actual intent maps to THIS action.\n"
    "- No emojis. No code fences. Only plain text in `user_message`.\n"
    "- No markdown. No prose before or after the JSON object."
)


def build_user_prompt(action: dict[str, Any], catalog: list[dict[str, Any]]) -> str:
    req = required_keys(action)
    opt = optional_keys(action)
    other_action_names = sorted({a["name"] for a in catalog if a["name"] != action["name"]})[:30]
    parts = [
        f"Action: {action['name']}",
        f"Plugin: {action.get('plugin') or '(unknown)'}",
        f"Description: {action.get('description') or '(no description)'}",
        f"Required parameters: {req or '(none)'}",
        f"Optional parameters: {opt or '(none)'}",
        f"Example call: {json.dumps(action.get('example_call') or {}, ensure_ascii=False)}",
        f"Similes: {action.get('similes') or []}",
        "",
        "Generate exactly 25 distinct scenarios with this distribution:",
        "  - 8 complete_args (en mostly, some es/pt/fr)",
        "  - 6 required_only",
        "  - 4 missing_required (forces clarifying REPLY, not action)",
        f"  - 4 multilingual (one each in: {', '.join(random.sample(list(ALL_LANGS), k=4))})",
        "  - 3 distractor (mention other action names but actually want THIS action)",
        "",
        "Other actions in the catalog you can reference for distractors:",
        ", ".join(other_action_names),
        "",
        "Return ONLY the JSON object {\"scenarios\":[...]}, no prose, no fences.",
    ]
    return "\n".join(parts)


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def strip_fences(text: str) -> str:
    m = _FENCE_RE.search(text)
    if m:
        return m.group(1).strip()
    return text.strip()


def parse_scenarios(text: str) -> list[dict[str, Any]]:
    """Robust JSON extraction for gpt-oss output."""
    cleaned = strip_fences(text)
    # find first { and last }
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return []
    blob = cleaned[start:end + 1]
    try:
        obj = json.loads(blob)
    except json.JSONDecodeError:
        return []
    arr = obj.get("scenarios")
    if not isinstance(arr, list):
        return []
    out: list[dict[str, Any]] = []
    for sc in arr:
        if not isinstance(sc, dict):
            continue
        msg = sc.get("user_message")
        kind = sc.get("kind")
        if not isinstance(msg, str) or not msg.strip():
            continue
        if kind not in {"complete_args", "required_only", "missing_required", "multilingual", "distractor"}:
            continue
        out.append({
            "kind": kind,
            "language": sc.get("language") or "en",
            "persona": sc.get("persona") or "casual",
            "user_message": msg.strip(),
            "notes": (sc.get("notes") or "")[:200],
        })
    return out


async def generate_for_action(
    client: httpx.AsyncClient,
    api_key: str,
    action: dict[str, Any],
    catalog: list[dict[str, Any]],
    sem: asyncio.Semaphore,
    *,
    api_url: str,
    model: str,
    reasoning_effort: str,
    use_response_format: bool,
) -> list[dict[str, Any]]:
    user_prompt = build_user_prompt(action, catalog)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.8,
        "max_tokens": 5000,
    }
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    if use_response_format:
        payload["response_format"] = {"type": "json_object"}
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "eliza-training-harness/1.0",
    }
    backoff = 5.0
    for attempt in range(6):
        async with sem:
            try:
                r = await client.post(api_url, json=payload, headers=headers, timeout=120.0)
            except (httpx.HTTPError, asyncio.TimeoutError):
                if attempt == 5:
                    return []
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
            content = (data["choices"][0]["message"].get("content") or "").strip()
        except (KeyError, ValueError, IndexError):
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.5, 30)
            continue
        if not content:
            # try reasoning fallback
            try:
                content = (data["choices"][0]["message"].get("reasoning") or "").strip()
            except (KeyError, IndexError):
                content = ""
        scenarios = parse_scenarios(content)
        if len(scenarios) >= 18:
            return scenarios
        # quality retry: if we got <18 scenarios drop temp, retry
        payload["temperature"] = max(0.2, payload.get("temperature", 0.8) - 0.15)
    return []


def to_pool_record(action: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    req = required_keys(action)
    return {
        "action_name": action["name"],
        "plugin": action.get("plugin"),
        "kind": scenario["kind"],
        "persona": scenario["persona"],
        "language": scenario["language"],
        "user_message": scenario["user_message"],
        "notes": scenario.get("notes") or "",
        # for the validator
        "expected_action": action["name"],
        "expected_arg_keys": req,
        "scenario_kind": scenario["kind"],
    }


def existing_pool_size(action_name: str) -> int:
    p = POOL_DIR / f"{action_name}.jsonl"
    if not p.exists():
        return 0
    return sum(1 for _ in p.open("r", encoding="utf-8"))


async def main_async(args: argparse.Namespace) -> None:
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        print(f"error: {args.api_key_env} not set", file=sys.stderr)
        sys.exit(2)

    catalog_doc = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    catalog: list[dict[str, Any]] = catalog_doc["actions"]

    if args.only:
        wanted = set(args.only.split(","))
        catalog = [a for a in catalog if a["name"] in wanted]

    POOL_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    todo: list[dict[str, Any]] = []
    skipped = 0
    for action in catalog:
        n = existing_pool_size(action["name"])
        if n >= 20 and not args.force:
            skipped += 1
            continue
        todo.append(action)

    print(
        f"[scenarios] catalog={len(catalog)} todo={len(todo)} skipped={skipped} "
        f"provider={args.provider_label} model={args.model}",
        file=sys.stderr,
    )
    if not todo:
        return

    sem = asyncio.Semaphore(args.concurrency)
    stats = {"ok": 0, "fail": 0, "scenarios": 0}
    start = time.time()

    async with httpx.AsyncClient(http2=False, limits=httpx.Limits(
        max_connections=args.concurrency * 2,
        max_keepalive_connections=args.concurrency,
    )) as client:

        async def runner(action: dict[str, Any]) -> None:
            scenarios = await generate_for_action(
                client,
                api_key,
                action,
                catalog_doc["actions"],
                sem,
                api_url=args.api_url,
                model=args.model,
                reasoning_effort=args.reasoning_effort,
                use_response_format=not args.no_response_format,
            )
            if not scenarios:
                stats["fail"] += 1
                print(f"[fail] {action['name']}", file=sys.stderr)
                return
            out_path = POOL_DIR / f"{action['name']}.jsonl"
            with out_path.open("w", encoding="utf-8") as f:
                for sc in scenarios:
                    f.write(json.dumps(to_pool_record(action, sc), ensure_ascii=False) + "\n")
            stats["ok"] += 1
            stats["scenarios"] += len(scenarios)
            print(f"[ok] {action['name']:40s} -> {len(scenarios)} scenarios", file=sys.stderr)

        await asyncio.gather(*(runner(a) for a in todo))

    elapsed = time.time() - start
    print(
        f"[scenarios done] ok={stats['ok']} fail={stats['fail']} "
        f"total_scenarios={stats['scenarios']} elapsed={elapsed:.0f}s",
        file=sys.stderr,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--only", type=str, default="", help="comma-separated action names")
    ap.add_argument("--force", action="store_true", help="regenerate even if pool exists")
    ap.add_argument("--model", default=default_teacher_model())
    ap.add_argument("--api-url", default=os.environ.get("ELIZA_HARNESS_API_URL", DEFAULT_API_URL))
    ap.add_argument("--api-key-env", default=os.environ.get("ELIZA_HARNESS_API_KEY_ENV", DEFAULT_API_KEY_ENV))
    ap.add_argument("--provider-label", default=os.environ.get("ELIZA_HARNESS_PROVIDER", "groq-dev"))
    ap.add_argument("--reasoning-effort", default=os.environ.get("ELIZA_HARNESS_REASONING_EFFORT", "low"))
    ap.add_argument(
        "--no-response-format",
        action="store_true",
        help="omit OpenAI JSON response_format for compatible endpoints that do not support it",
    )
    args = ap.parse_args()
    if not args.model:
        raise SystemExit(
            "--model is required unless ELIZA_HARNESS_MODEL or "
            "ELIZA_COLLECTION_MODEL is set"
        )
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
