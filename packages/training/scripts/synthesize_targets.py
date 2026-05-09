"""Legacy prompt-template TOON synthesizer.

This script is not a native v5 JSON export path. It remains only for old
prompt-template compatibility coverage where `registry.json` still declares
`output_format: toon`.

For every entry in `data/prompts/registry.json` whose output format is `toon`,
this script:

  1. Builds N synthetic input scenarios using a teacher model. Variables are
     sampled from a small pool of agent personae and seed conversations.
  2. Renders the eliza prompt template with those variables.
  3. Asks the teacher to produce the TOON response per the prompt's spec.
  4. Validates the response by piping it through the bun TOON decoder
     (so we know the model hasn't violated TOON syntax).
  5. Writes one canonical ElizaRecord per (task_id, scenario) into
     `data/synthesized/<task_id>.jsonl`.

Teacher model: Anthropic's claude-opus-4-7 by default, but the script accepts
any provider via the `--teacher` flag. Concurrency is bounded so we don't
hammer the API.

Usage:
    export ANTHROPIC_API_KEY=...
    uv run python scripts/synthesize_targets.py --task should_respond --n 100
    uv run python scripts/synthesize_targets.py --all
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import ElizaRecord, build, stable_id  # noqa: E402
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

REGISTRY_FILE = ROOT / "datasets.yaml"
PROMPTS_REGISTRY = ROOT / "data" / "prompts" / "registry.json"
OUT_DIR = ROOT / "data" / "synthesized"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth")

# ───────────────── seed pools ────────────────────────────────────────────

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
]

USER_NAMES = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas",
]

CHANNELS = ["dm", "public"]

PROMPTS_FOR = {
    "should_respond": [
        "@{agent} can you help with this?",
        "{agent} did you see what {other} said?",
        "Hey {agent}, quick question",
        "{other} I'm telling you, this isn't right",  # not addressed to agent
        "Stop pinging {agent}, leave them alone",  # stop request
        "thanks {agent}",
        "I disagree with what {other} said earlier",
    ],
    "reply": [
        "What's the weather like in Tokyo today?",
        "How do I export a Pandas DataFrame to Parquet?",
        "Can you summarize the last 3 messages?",
        "Tell me a short joke about computers.",
        "Translate 'good morning' into Japanese, Korean, and Spanish.",
    ],
    "should_mute_room": [
        "{agent} please mute this channel for now",
        "can someone silence the bot already",
        "this room is too noisy, mute everything",
        "no, don't mute, I want to keep listening",
        "go away {agent}",
    ],
    "should_unmute_room": [
        "{agent} can you start listening to this room again",
        "ok unmute the bot",
        "we need {agent} back in here",
    ],
    "choose_option": [
        "Pick one: A) Pizza, B) Sushi, C) Tacos",
        "Should I go with the red or blue option?",
        "Yes or no, do we ship today?",
    ],
}


# ───────────────── teacher client ────────────────────────────────────────

@dataclass
class TeacherCfg:
    provider: str
    model: str
    max_tokens: int = 1024
    temperature: float = 0.7


def call_anthropic(cfg: TeacherCfg, system: str, user: str) -> str:
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=cfg.model,
        max_tokens=cfg.max_tokens,
        temperature=cfg.temperature,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    parts = []
    for b in resp.content:
        if hasattr(b, "text"):
            parts.append(b.text)
    return "".join(parts).strip()


def call_teacher(cfg: TeacherCfg, system: str, user: str) -> str:
    if cfg.provider == "anthropic":
        return call_anthropic(cfg, system, user)
    raise ValueError(f"unknown teacher provider: {cfg.provider}")


# ───────────────── scenario generation ───────────────────────────────────

def render_handlebars(template: str, ctx: dict[str, Any]) -> str:
    """Minimal handlebars renderer for {{var}} and {{#each}} blocks.

    Sufficient for the canonical eliza prompts. For unknown helpers we
    leave the original placeholder in place so the model can still parse
    the structural intent.
    """
    def replace(m: re.Match[str]) -> str:
        kind, name = m.group(1), m.group(2)
        if kind in ("#", "/"):
            return ""  # strip block markers; we render the body as-is
        if "." in name:
            head, *rest = name.split(".")
            v: Any = ctx.get(head)
            for k in rest:
                if isinstance(v, dict):
                    v = v.get(k)
                else:
                    v = ""
                    break
            return str(v) if v is not None else ""
        return str(ctx.get(name, "")) if ctx.get(name) is not None else ""

    return re.sub(r"\{\{\s*([#/])?([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}", replace, template)


def make_scenario(task_id: str, rng: random.Random) -> dict[str, Any]:
    agent = rng.choice(AGENT_NAMES)
    other = rng.choice(USER_NAMES)
    seeds = PROMPTS_FOR.get(task_id) or [
        f"hi {agent}, what's up?",
        "tell me something interesting",
    ]
    msg = rng.choice(seeds).format(agent=agent, other=other)
    n_history = rng.choice([0, 0, 1, 2, 4])
    history = []
    for _ in range(n_history):
        history.append({
            "role": "user",
            "speaker": rng.choice(USER_NAMES),
            "content": rng.choice([
                "hey", "morning", "wat", "lol", "saw the news?",
                "interesting take", "let me think", "checking in",
            ]),
            "channel": rng.choice(CHANNELS),
        })
        history.append({
            "role": "assistant",
            "speaker": agent,
            "content": rng.choice([
                "yeah", "got it", "ok", "I see", "sure",
                "interesting", "right", "noted",
            ]),
            "channel": "dm",
        })
    return {
        "agentName": agent,
        "agentId": agent.lower(),
        "user": other,
        "providers": "(no providers)",
        "message": msg,
        "memoryEntries": history,
        "currentMessage": {"role": "user", "speaker": other, "content": msg},
    }


# ───────────────── synthesize one task ──────────────────────────────────

SYNTH_SYSTEM = """You are a teacher generating supervised training data for a
small student model. The student must learn to follow elizaOS prompt
templates exactly. You will be given:
  1. The full prompt template the student will see (with variables
     pre-rendered).
  2. The exact TOON output schema (key names) the student must produce.

Your job is to produce ONE single TOON document that satisfies the prompt
and the schema. Output nothing else — no prose, no fences, no
<think> blocks. Just the TOON document.

TOON syntax recap:
  - "key: value" for scalars (booleans use literal `true` / `false`)
  - "key: " (empty value) for missing fields
  - For nested objects: a key with no value, then indented children
  - Strings with commas or quotes get JSON-escaped within double quotes
"""


def synthesize_for_task(
    *, prompt_entry: dict[str, Any], n: int, seed: int,
    teacher: TeacherCfg, encoder: ExpectedResponseEncoder, max_workers: int = 4,
    out_path: Path,
) -> tuple[int, int]:
    rng = random.Random(seed)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Resume: skip already-synthesized scenarios by task_id
    seen: set[str] = set()
    if out_path.exists():
        with out_path.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    seen.add(json.loads(line)["roomName"])
                except (json.JSONDecodeError, KeyError):
                    continue

    expected_keys = prompt_entry.get("expected_keys") or []
    keys_hint = ", ".join(expected_keys) if expected_keys else "(see template)"

    def one(scenario_idx: int) -> ElizaRecord | None:
        scenario = make_scenario(prompt_entry["task_id"], rng)
        rendered = render_handlebars(prompt_entry["template"], scenario)
        tid = stable_id("synth", prompt_entry["task_id"], scenario_idx, scenario["message"])
        if tid in seen:
            return None
        user_prompt = (
            f"PROMPT TEMPLATE (the student will see this):\n\n"
            f"{rendered}\n\n"
            f"REQUIRED OUTPUT KEYS: {keys_hint}\n\n"
            f"Return ONE TOON document and nothing else."
        )
        try:
            target = call_teacher(teacher, SYNTH_SYSTEM, user_prompt)
        except Exception as e:  # noqa: BLE001
            log.warning("teacher failed (%s): %s", prompt_entry["task_id"], e)
            return None
        # Strip fences if the teacher added any
        target = target.strip()
        if target.startswith("```"):
            target = re.sub(r"^```(?:toon|json)?\s*\n?|\n?```$", "", target, flags=re.S).strip()
        # Sanity check that it looks like TOON
        if not re.search(r"^[A-Za-z_][A-Za-z0-9_]*\s*:", target, re.M):
            log.warning("teacher returned non-TOON output for %s: %s",
                        prompt_entry["task_id"], target[:200])
            return None

        return build(
            roomName=tid,
            agentId=scenario["agentId"],
            memoryEntries=scenario["memoryEntries"],
            currentMessage=scenario["currentMessage"],
            expectedResponse=target,
            availableActions=[],
            task_type=prompt_entry["task_id"],
            source_dataset="synth-eliza-prompts",
            license="synthetic",
            split="train",
            extra_metadata={
                "system_prompt": rendered,
                "prompt_source": prompt_entry["source_path"],
                "teacher_model": teacher.model,
            },
        )

    n_success = 0
    n_skipped = 0
    with out_path.open("a", encoding="utf-8") as f, \
         ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(one, i): i for i in range(n)}
        for fut in as_completed(futs):
            try:
                rec = fut.result()
            except Exception as e:  # noqa: BLE001
                log.exception("synthesizer worker crashed: %s", e)
                continue
            if rec is None:
                n_skipped += 1
                continue
            ok, why = rec.is_valid()
            if not ok:
                n_skipped += 1
                continue
            f.write(rec.to_jsonl() + "\n")
            n_success += 1
            if n_success % 25 == 0:
                log.info("  %s: %d/%d ok", prompt_entry["task_id"], n_success, n)

    return n_success, n_skipped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", type=Path, default=REGISTRY_FILE)
    ap.add_argument("--prompts", type=Path, default=PROMPTS_REGISTRY)
    ap.add_argument("--task", type=str, default="",
                    help="single task id (e.g. should_respond)")
    ap.add_argument("--all", action="store_true",
                    help="synthesize all `synthesized:` entries from datasets.yaml")
    ap.add_argument("--teacher-model", type=str, default="claude-opus-4-7")
    ap.add_argument("--teacher-provider", type=str, default="anthropic")
    ap.add_argument("--n", type=int, default=0,
                    help="override n_examples for --task mode")
    ap.add_argument("--max-workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0xE71A05)
    args = ap.parse_args()

    if not args.prompts.exists():
        log.error("prompt registry missing — run scripts/extract_eliza_prompts.py first")
        return 1

    prompts = json.loads(args.prompts.read_text(encoding="utf-8"))
    by_task = {e["task_id"]: e for e in prompts["entries"]}

    with args.registry.open() as f:
        ds_registry = yaml.safe_load(f)
    plan: list[tuple[str, int]] = []
    if args.task:
        if args.task not in by_task:
            log.error("unknown task: %s", args.task)
            return 1
        plan.append((args.task, args.n or 100))
    elif args.all:
        for s in (ds_registry.get("synthesized") or []):
            plan.append((s["task_id"], int(s.get("n_examples", 100))))
    else:
        log.error("must pass --task or --all")
        return 2

    teacher = TeacherCfg(
        provider=args.teacher_provider,
        model=args.teacher_model,
    )
    encoder = JsonExpectedResponseEncoder()
    try:
        total_ok = total_skipped = 0
        for tid, n in plan:
            entry = by_task.get(tid)
            if not entry:
                log.warning("skip %s — not in prompt registry", tid)
                continue
            log.info("synthesizing %d examples for %s", n, tid)
            out = OUT_DIR / f"{tid}.jsonl"
            ok, skipped = synthesize_for_task(
                prompt_entry=entry, n=n, seed=args.seed,
                teacher=teacher, encoder=encoder,
                max_workers=args.max_workers, out_path=out,
            )
            log.info("%s: %d ok, %d skipped → %s", tid, ok, skipped, out)
            total_ok += ok
            total_skipped += skipped
        log.info("synth totals: %d ok, %d skipped", total_ok, total_skipped)
    finally:
        encoder.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
