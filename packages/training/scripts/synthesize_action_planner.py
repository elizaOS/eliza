"""Synthesize TOON message_handler training records for every elizaOS action.

For every action in `/tmp/action_inventory_enriched.json`, this script
produces N=30 supervised records (configurable) where:

  - currentMessage is a templated user prompt designed to trigger that
    specific action (uses the action's description + similes to phrase
    realistic prompts).
  - memoryEntries vary in length (1, 3, 8, 15 prior turns) so the model
    sees both short DMs and long group threads.
  - availableActions includes the target action plus a sample of 6-12
    other actions (so the planner has to choose).
  - expectedResponse is a TOON message_handler document selecting that
    action, with templated params when the parameter shape is known.

Output: data/synthesized/action_planner_coverage.jsonl

Usage:
    uv run python scripts/synthesize_action_planner.py
    uv run python scripts/synthesize_action_planner.py --n-per-action 50
    uv run python scripts/synthesize_action_planner.py --only TRANSFER_TOKEN,MESSAGE
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    build, stable_id,
)

INVENTORY = Path("/tmp/action_inventory_enriched.json")
OUT_PATH = ROOT / "data" / "synthesized" / "action_planner_coverage.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-action")


# ─────────────────────────── seed pools ───────────────────────────────────

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
    "milady", "eliza",
]
USER_NAMES = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas",
]
CHANNELS = ["dm", "group", "public", "general"]

# Filler chat used to pad memoryEntries
FILLER_TURNS = [
    ("hey", "hi"), ("morning", "morning!"), ("what's up?", "not much, you?"),
    ("how's it going", "good, busy day"), ("any news?", "all quiet"),
    ("loved your post", "thanks!"), ("brb", "ok"),
    ("did you see what {other} said?", "yeah, wild"),
    ("running late", "no worries"),
    ("interesting take", "thanks, took a while to draft"),
]

# Universal control actions — always available
UNIVERSAL_ACTIONS = ["REPLY", "IGNORE", "STOP", "NONE"]

# Per-action heuristic param schemas. These are conservative — most
# actions get empty `params` in the synthesized output. Only common
# parametric shapes are templated here. The student learns *that the
# planner emits TOON, with the right action name, and with params iff
# they are clearly mentioned in the user message*.
PARAM_TEMPLATES: dict[str, list[dict[str, Any]]] = {
    "MESSAGE": [
        {"operation": "send", "to": "{user}", "body": "ok, will do"},
        {"operation": "send", "to": "{user}", "body": "sounds good"},
    ],
    "TRANSFER_TOKEN": [
        {"to": "{wallet}", "amount": "{amount}", "token": "{token}"},
    ],
    "EXECUTE_TRADE": [
        {"action": "buy", "amount": "{amount}", "symbol": "{token}"},
        {"action": "sell", "amount": "{amount}", "symbol": "{token}"},
    ],
    "PLACE_CALL": [{"number": "{phone}"}],
    "CREATE_TASK": [{"title": "{task_title}"}],
    "DELETE_TASK": [{"id": "{id}"}],
    "GET_BALANCE": [{}, {"address": "{wallet}"}],
    "EXECUTE_DATABASE_QUERY": [
        {"sql": "SELECT count(*) FROM messages WHERE userId = '{user_id}'"},
        {"sql": "SELECT name, ts FROM tasks WHERE status = 'open'"},
    ],
    "UPDATE_OWNER_NAME": [{"name": "{user}"}],
    "UPDATE_IDENTITY": [{"name": "{agent}"}],
    "SCHEDULE_FOLLOW_UP": [{"when": "+30m", "topic": "{task_title}"}],
    "WEB_SEARCH": [{"query": "{query}"}],
    "PLAY_TRACK": [{"title": "{track}"}],
    "STOP_MUSIC": [{}],
    "SET_VOLUME": [{"level": "{volume}"}],
    "POST": [{"operation": "send", "text": "{tweet_text}"}],
    "REPLY_TO_TWEET": [{"to": "{tweet_id}", "text": "{tweet_text}"}],
}

# Slot fillers
SLOTS = {
    "wallet": ["0x4A7E1...", "0xC0F3...", "0x9B22...", "vitalik.eth"],
    "amount": ["1.5", "10", "0.25", "100", "5000"],
    "token": ["ETH", "USDC", "SOL", "BTC", "DAI"],
    "phone": ["+1-415-555-0123", "+44-20-7946-0958", "+33-1-42-86-83-26"],
    "task_title": ["Review Q4 plan", "draft launch email", "check Dexscreener", "ping support"],
    "id": ["task-12", "task-99", "task-001"],
    "user_id": ["user_4f2a", "user_9c11"],
    "query": ["latest fed rate decision", "n8n cron docs", "claude opus 4.7 release notes"],
    "track": ["Lo-Fi Beats", "Boards of Canada - Roygbiv", "Aphex Twin - Avril 14th"],
    "volume": ["20", "50", "75", "100"],
    "tweet_text": ["just shipped", "watching the chart", "interesting times"],
    "tweet_id": ["1758932..."],
}


def fill_slots(template: dict[str, str], rng: random.Random,
               agent: str, user: str) -> dict[str, str]:
    """Replace `{slot}` placeholders in param values with sampled fillers."""
    out: dict[str, str] = {}
    for k, v in template.items():
        if not isinstance(v, str):
            out[k] = v
            continue
        s = v
        for slot, options in SLOTS.items():
            if "{" + slot + "}" in s:
                s = s.replace("{" + slot + "}", rng.choice(options))
        s = s.replace("{user}", user).replace("{agent}", agent)
        out[k] = s
    return out


# ───────────────────── prompt phrasing per action ──────────────────────────

# These are sentence templates mapping to specific action vocabularies.
# When the action name + similes match certain patterns, the matching
# template is used. Otherwise we fall back to a generic "please do X"
# phrasing built from the description.

GENERIC_PHRASINGS = [
    "{agent}, can you {verb}?",
    "@{agent} {verb} please",
    "hey {agent}, {verb}",
    "{agent} - {verb}",
    "could you {verb}",
    "{verb}",
    "please {verb}",
    "now {verb}",
]


def derive_verb(action_name: str, description: str) -> str:
    """Turn an action like 'TRANSFER_TOKEN' into a verb phrase."""
    if description:
        # Use the first sentence of the description, lower-cased and
        # trimmed of trailing period.
        first = re.split(r"[.\n]", description, maxsplit=1)[0].strip()
        if first and len(first) < 200:
            return first[0].lower() + first[1:]
    # Fall back: synthesize from the action name
    parts = action_name.lower().split("_")
    if not parts:
        return "do that"
    return " ".join(parts)


def make_prompt(action: dict[str, Any], rng: random.Random,
                agent: str, user: str) -> str:
    verb = derive_verb(action["name"], action.get("description") or "")
    # Some actions have a slot in the verb: pick a slot value if mentioned
    slot_specific = ""
    if "send" in verb and "message" in verb:
        slot_specific = f" to {rng.choice(USER_NAMES)} saying \"{rng.choice(['ok', 'on it', 'thanks'])}\""
    elif "transfer" in verb or "send" in verb:
        if "token" in verb or "amount" in verb:
            slot_specific = f" {rng.choice(SLOTS['amount'])} {rng.choice(SLOTS['token'])} to {rng.choice(SLOTS['wallet'])}"
    elif "call" in verb and "phone" in action.get("description", "").lower():
        slot_specific = f" {rng.choice(SLOTS['phone'])}"
    elif "search" in verb or "query" in verb:
        slot_specific = f" for \"{rng.choice(SLOTS['query'])}\""
    elif "play" in verb and "music" in (action.get("description") or "").lower():
        slot_specific = f" \"{rng.choice(SLOTS['track'])}\""

    template = rng.choice(GENERIC_PHRASINGS)
    return template.format(agent=agent, verb=verb + slot_specific).strip()


# ─────────────────── memory + record assembly ──────────────────────────────

def make_memory(rng: random.Random, length: int, agent: str,
                user: str, channel: str) -> list[dict[str, str]]:
    if length == 0:
        return []
    pool = [(t.format(other=rng.choice(USER_NAMES)),
             r.format(other=rng.choice(USER_NAMES)))
            for t, r in FILLER_TURNS]
    rng.shuffle(pool)
    out: list[dict[str, str]] = []
    speakers = [user, rng.choice(USER_NAMES), agent]
    for i in range(length):
        sp = speakers[i % len(speakers)]
        text = pool[i % len(pool)][i % 2]
        out.append({
            "role": "user" if sp != agent else "assistant",
            "speaker": sp,
            "content": text,
            "channel": channel,
        })
    return out


def encode_action_planner_toon(
    *, thought: str, actions: list[dict[str, Any]],
    providers: list[str], text: str, simple: bool,
) -> str:
    """Render a TOON message_handler document.

    Format:
      thought: <text>
      actions[N]:
        - name: ACTION_NAME
          params:
            key: value
      providers: PROV1,PROV2
      text: <text>
      simple: true|false
    """
    lines = [f"thought: {thought}"]
    if not actions:
        lines.append("actions:")
    else:
        lines.append(f"actions[{len(actions)}]:")
        for a in actions:
            lines.append(f"  - name: {a['name']}")
            params = a.get("params") or {}
            if params:
                lines.append("    params:")
                for k, v in params.items():
                    if isinstance(v, str) and ("\n" in v or '"' in v or "," in v):
                        # Quote values with special chars
                        v_esc = v.replace('"', '\\"')
                        lines.append(f'      {k}: "{v_esc}"')
                    else:
                        lines.append(f"    {' ':>2}{k}: {v}")
    if providers:
        lines.append("providers: " + ",".join(providers))
    else:
        lines.append("providers:")
    if text:
        lines.append(f"text: {text}")
    else:
        lines.append("text:")
    lines.append(f"simple: {'true' if simple else 'false'}")
    return "\n".join(lines)


def synthesize_for_action(
    *, action: dict[str, Any], n: int, rng: random.Random,
    other_actions: list[str],
) -> list[dict[str, Any]]:
    """Generate N supervised records for one action."""
    name = action["name"]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    lengths_pool = [0, 1, 3, 8, 15]
    param_templates = PARAM_TEMPLATES.get(name, [{}])

    attempts = 0
    while len(out) < n and attempts < n * 4:
        attempts += 1
        agent = rng.choice(AGENT_NAMES)
        user = rng.choice(USER_NAMES)
        channel = rng.choice(CHANNELS)
        mem_len = rng.choice(lengths_pool)

        prompt = make_prompt(action, rng, agent, user)
        memory = make_memory(rng, mem_len, agent, user, channel)
        current = {
            "role": "user", "speaker": user,
            "content": prompt, "channel": channel,
        }

        # Available actions: the target + a sample of others + universals
        sample = rng.sample(other_actions, k=min(8, len(other_actions)))
        avail = list(dict.fromkeys([name] + sample + UNIVERSAL_ACTIONS))

        # Plan the TOON output. Most cases just call the target action;
        # a fraction also chain a REPLY for natural conversation.
        params_template = rng.choice(param_templates)
        params = fill_slots(params_template, rng, agent, user) if params_template else {}
        actions_list = [{"name": name, "params": params}]
        chain_reply = rng.random() < 0.25 and name not in UNIVERSAL_ACTIONS
        text_field = ""
        if chain_reply:
            actions_list.append({"name": "REPLY"})
            text_field = rng.choice([
                "On it.", "Done.", "Got it.", "Will do.", "Heading there now.",
                "One sec.", "Working on it.",
            ])

        thought = rng.choice([
            f"{user} is asking me to {derive_verb(name, action.get('description') or '')}.",
            f"User wants {name} executed.",
            f"This calls for {name}.",
            f"I should run {name} for this request.",
        ])
        providers = []
        if rng.random() < 0.3:
            providers = rng.sample(["FACTS", "RECENT_MESSAGES", "TIME", "ENTITIES"],
                                   k=rng.randint(1, 2))

        toon = encode_action_planner_toon(
            thought=thought, actions=actions_list,
            providers=providers, text=text_field,
            simple=(not chain_reply and len(actions_list) == 1),
        )

        key = stable_id(name, prompt[:120], mem_len)
        if key in seen:
            continue
        seen.add(key)

        rec = build(
            roomName=stable_id("action-planner", name, prompt[:120], mem_len),
            agentId=agent.lower(),
            memoryEntries=memory,
            currentMessage=current,
            expectedResponse=toon,
            availableActions=avail,
            task_type="message_handler",
            source_dataset="synth-action-planner",
            license="synthetic",
            split="train",
            extra_metadata={
                "target_action": name,
                "memory_window": mem_len,
                "channel": channel,
                "agent_name": agent,
                "plugin": derive_plugin(action["file"]),
            },
        ).to_dict()
        out.append(rec)
    return out


def derive_plugin(file_path: str) -> str:
    parts = file_path.split("/")
    if "plugins" in parts:
        return parts[parts.index("plugins") + 1]
    if "agent" in parts:
        return "core-agent"
    if "core" in parts:
        return "core"
    return "other"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-per-action", type=int, default=30)
    ap.add_argument("--only", type=str, default="",
                    help="comma-separated action names (smoke test)")
    ap.add_argument("--seed", type=int, default=0xE71A05)
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    args = ap.parse_args()

    if not INVENTORY.exists():
        log.error("missing inventory at %s. Run the inventory step first.", INVENTORY)
        return 1
    actions = json.loads(INVENTORY.read_text())
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        actions = [a for a in actions if a["name"] in wanted]
        if not actions:
            log.error("no actions matched --only %s", args.only)
            return 1

    rng = random.Random(args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)

    # Pool of "other actions" used when populating availableActions
    all_action_names = sorted({a["name"] for a in json.loads(INVENTORY.read_text())})

    seen_keys: set[str] = set()
    n_total = 0
    by_plugin: dict[str, int] = {}

    with args.out.open("w", encoding="utf-8") as f:
        for action in actions:
            recs = synthesize_for_action(
                action=action,
                n=args.n_per_action,
                rng=rng,
                other_actions=[n for n in all_action_names if n != action["name"]],
            )
            kept = 0
            for r in recs:
                k = r["roomName"]
                if k in seen_keys:
                    continue
                seen_keys.add(k)
                f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
                kept += 1
            n_total += kept
            plug = derive_plugin(action["file"])
            by_plugin[plug] = by_plugin.get(plug, 0) + kept
            if n_total % 500 == 0:
                log.info("  emitted %d records so far (last: %s)", n_total, action["name"])

    log.info("done — %d records → %s", n_total, args.out)
    log.info("by plugin:")
    for k, v in sorted(by_plugin.items(), key=lambda x: -x[1]):
        log.info("  %-40s %d", k, v)
    return 0


if __name__ == "__main__":
    sys.exit(main())
