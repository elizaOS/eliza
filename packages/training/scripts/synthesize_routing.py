"""Synthesize multi-thread RESPOND/IGNORE routing training records from
real Discord and Telegram chat data.

The training signal we want:

  - The agent shares a room with multiple concurrent conversations.
  - Some messages are directed at the agent (mentions, pings, name in
    the message). Those become `currentMessage` with target action
    RESPOND.
  - Some messages are background chat. Those become `currentMessage`
    with target action IGNORE.
  - For ambiguous turns we can inject a name token ("eliza, ..." /
    trailing "eliza?") to *create* a clear RESPOND signal.

Inputs:
  - `data/raw/discord-chat/`
  - `data/raw/telegram-filtered-messages/`
  - `data/raw/discord-dialogues/`
  (any subset works; missing sources are skipped)

Output:
  - `data/synthesized/dialogue_routing.jsonl` (one canonical eliza record
    per generated example)

Usage:
    uv run python scripts/synthesize_routing.py \
        --n 5000 \
        --p-respond 0.5 \
        --p-inject-name 0.4
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
from collections import deque
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    ACTION_IGNORE, ACTION_RESPOND, ACTION_STOP,
    build, stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

RAW_DIR = ROOT / "data" / "raw"
OUT_PATH = ROOT / "data" / "synthesized" / "dialogue_routing.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-routing")


AGENT_NAMES = [
    "eliza", "Eliza", "Iris", "Kai", "Ava", "Nova", "Echo",
    "Sage", "Atlas", "Lyra", "Pico", "Lumi", "Rune", "Vega",
    "Sol", "Orion", "Mira", "Tess", "milady",
]


# ───────────────────────────── loaders ──────────────────────────────────────

def _flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for v in value:
            if isinstance(v, dict):
                parts.append(v.get("text") or v.get("content") or "")
            else:
                parts.append(str(v))
        return " ".join(p for p in parts if p)
    if isinstance(value, dict):
        return value.get("text") or value.get("content") or ""
    return str(value)


def iter_chat_records(slug: str) -> Iterator[dict[str, Any]]:
    """Yield {speaker, content, channel, ts} from any of the dialogue sources.

    Each source has its own quirks; we accept the first sensible field.
    """
    base = RAW_DIR / slug
    if not base.exists():
        return
    for path in sorted(base.rglob("*")):
        if path.is_dir():
            continue
        if path.suffix == ".csv":
            try:
                import csv
                with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
                    sniff = f.read(4096)
                    f.seek(0)
                    has_header = csv.Sniffer().has_header(sniff)
                    reader = csv.DictReader(f) if has_header else csv.reader(f)
                    for row in reader:
                        if isinstance(row, dict):
                            msg = _to_chat_msg(row, slug)
                        else:
                            # Positional: best-effort {speaker:0, content:1}
                            msg = _to_chat_msg(
                                {"speaker": row[0] if len(row) > 0 else "user",
                                 "content": " ".join(row[1:]) if len(row) > 1 else (row[0] if row else "")},
                                slug,
                            )
                        if msg:
                            yield msg
            except Exception as e:  # noqa: BLE001
                log.warning("failed csv %s: %s", path, e)
        elif path.suffix == ".parquet":
            try:
                import pyarrow.parquet as pq
                table = pq.read_table(path)
                for row in table.to_pylist():
                    msg = _to_chat_msg(row, slug)
                    if msg:
                        yield msg
            except Exception as e:  # noqa: BLE001
                log.warning("failed parquet %s: %s", path, e)
        elif path.suffix in (".jsonl", ".json"):
            with path.open("r", encoding="utf-8", errors="replace") as f:
                first = f.readline()
                if not first:
                    continue
                if first.lstrip().startswith("["):
                    f.seek(0)
                    try:
                        data = json.load(f)
                    except json.JSONDecodeError:
                        continue
                    for row in data:
                        if isinstance(row, dict):
                            msg = _to_chat_msg(row, slug)
                            if msg:
                                yield msg
                    continue
                for line in [first] + list(f):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(row, dict):
                        msg = _to_chat_msg(row, slug)
                        if msg:
                            yield msg


def _to_chat_msg(row: dict, slug: str) -> dict | None:
    speaker = (
        row.get("author") or row.get("user") or row.get("speaker")
        or row.get("from") or row.get("name") or row.get("username") or ""
    )
    content = _flatten_text(
        row.get("content") or row.get("text") or row.get("message")
        or row.get("body") or row.get("value") or row.get("sentence") or ""
    )
    channel = (
        row.get("channel") or row.get("channel_name") or row.get("guild")
        or row.get("chat") or row.get("server") or row.get("channel_id") or ""
    )
    # If speaker is missing (telegram-filtered-messages strips it), make one
    # up so the dialogue mixer can still attribute turns; we only need the
    # content + a stable-ish handle.
    if not speaker and channel:
        # Hash-derived pseudo-handle so the same channel feels coherent.
        speaker = f"user_{abs(hash(str(channel))) % 10_000:04d}"
    if not content or len(content) < 2:
        return None
    if not speaker:
        speaker = "user"
    return {
        "speaker": str(speaker)[:40],
        "content": content[:2000],
        "channel": str(channel)[:40] or slug,
        "ts": row.get("timestamp") or row.get("ts") or row.get("date"),
    }


# ───────────────────────── routing logic ─────────────────────────────────

MENTION_RE = re.compile(r"<@!?\d+>|@\w+")


def has_explicit_ping(text: str) -> bool:
    return bool(MENTION_RE.search(text))


def has_name_token(text: str, agent: str) -> bool:
    pattern = re.compile(rf"\b{re.escape(agent)}\b", re.I)
    return bool(pattern.search(text))


def inject_name(text: str, agent: str, *, mode: str | None = None) -> tuple[str, str]:
    """Inject the agent name in a natural-feeling way and return
    (new_text, clue_label)."""
    rng = random.Random(hash((text, agent)) & 0x7FFFFFFF)
    mode = mode or rng.choice(["prefix", "suffix_question", "midline"])
    if mode == "prefix":
        return f"{agent}, {text.lstrip()}", "injected_name_prefix"
    if mode == "suffix_question":
        bare = text.rstrip(".!? \t\n")
        return f"{bare}, {agent}?", "injected_name_suffix"
    # midline: insert "(@<agent>)" after the first comma or first sentence
    parts = re.split(r"(\.|,|;)\s+", text, maxsplit=1)
    if len(parts) >= 3:
        return f"{parts[0]}{parts[1]} @{agent} {parts[2]}", "injected_name_midline"
    return f"@{agent} {text}", "injected_name_at"


# ───────────────────────────── synthesis ─────────────────────────────────

def synthesize_one(
    *, recent: list[dict[str, Any]], all_chat: list[dict[str, Any]],
    agent: str, target_action: str, p_inject_name: float,
    encoder: ExpectedResponseEncoder, rng: random.Random,
) -> dict[str, Any] | None:
    """Build one canonical eliza record where the agent must decide whether
    to RESPOND, IGNORE, or STOP given the supplied conversation context."""

    if not all_chat:
        return None

    # Pick a candidate currentMessage with the right characteristics
    pool = list(all_chat)
    rng.shuffle(pool)
    chosen = None
    clue = "none"
    for cand in pool[:200]:
        text = cand["content"]
        if target_action == ACTION_RESPOND:
            if has_explicit_ping(text):
                clue = "ping"
                chosen = cand
                break
            if has_name_token(text, agent):
                clue = "name_token"
                chosen = cand
                break
        elif target_action == ACTION_IGNORE:
            if not has_explicit_ping(text) and not has_name_token(text, agent):
                clue = "none"
                chosen = cand
                break
        else:  # STOP
            stop_markers = ("stop", "be quiet", "shut up", "leave me alone", "go away")
            if any(s in text.lower() for s in stop_markers) and (
                has_explicit_ping(text) or has_name_token(text, agent)
            ):
                clue = "stop_request"
                chosen = cand
                break

    if chosen is None:
        # Fall back: take the first candidate and (for RESPOND/STOP) inject signal
        chosen = pool[0] if pool else None
        if chosen is None:
            return None
        if target_action == ACTION_RESPOND and rng.random() < p_inject_name:
            chosen = dict(chosen)
            chosen["content"], clue = inject_name(chosen["content"], agent)
        elif target_action == ACTION_STOP:
            chosen = dict(chosen)
            chosen["content"] = f"stop pinging {agent}, leave them alone"
            clue = "stop_request_synth"
        else:
            return None  # couldn't find a clean ignore example without forcing

    current = {
        "role": "user",
        "speaker": chosen["speaker"],
        "content": chosen["content"],
        "channel": chosen.get("channel") or "public",
    }

    # Build memoryEntries: a few interleaved threads from `recent` to simulate
    # multiple concurrent conversations. We tag with each speaker so the agent
    # can see who's talking to whom.
    memory: list[dict[str, Any]] = []
    for m in recent[-12:]:
        memory.append({
            "role": "user",
            "speaker": m["speaker"],
            "content": m["content"],
            "channel": m.get("channel") or current["channel"],
        })

    reasoning = {
        ACTION_RESPOND: {
            "ping": f"{agent} was directly @-mentioned.",
            "name_token": f"the latest message contains '{agent}' as a name token addressed to the agent.",
            "injected_name_prefix": f"the message opens with '{agent},' addressing the agent.",
            "injected_name_suffix": "the message ends with the agent's name as a question.",
            "injected_name_midline": f"the message addresses {agent} mid-sentence.",
            "injected_name_at": f"the message begins with @{agent}.",
        }.get(clue, "the latest message is addressed to the agent."),
        ACTION_IGNORE: "no explicit address to the agent; chatter between other users.",
        ACTION_STOP: "the user is asking the agent to stop responding.",
    }[target_action]

    target = {
        "name": agent,
        "reasoning": reasoning,
        "action": target_action,
        "primaryContext": "general",
        "secondaryContexts": "",
        "evidenceTurnIds": "",
    }
    toon = encoder.encode(target)

    return build(
        roomName=stable_id("dialogue_routing", agent, current["content"][:120], target_action),
        agentId=agent.lower(),
        memoryEntries=memory,
        currentMessage=current,
        expectedResponse=toon,
        availableActions=[ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP],
        task_type="dialogue_routing",
        source_dataset="synth-dialogue-routing",
        license="synthetic",
        split="train",
        extra_metadata={
            "agent_name": agent,
            "dialogue_clue": clue,
            "synth_target_action": target_action,
        },
    ).to_dict()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5000)
    ap.add_argument("--p-respond", type=float, default=0.45,
                    help="fraction of synthesized records labeled RESPOND")
    ap.add_argument("--p-stop", type=float, default=0.05,
                    help="fraction labeled STOP")
    ap.add_argument("--p-inject-name", type=float, default=0.4,
                    help="prob. of injecting agent name into a RESPOND example")
    ap.add_argument("--seed", type=int, default=0xE71A05)
    ap.add_argument("--memory-window", type=int, default=24,
                    help="how many recent turns to feed into memoryEntries")
    ap.add_argument("--sources", type=str,
                    default="discord-chat,telegram-filtered-messages,discord-dialogues",
                    help="comma-separated dialogue source slugs in data/raw/")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Stream all chat into a single list (keep memory bounded by sampling).
    all_msgs: list[dict] = []
    for slug in [s.strip() for s in args.sources.split(",") if s.strip()]:
        n = 0
        for msg in iter_chat_records(slug):
            all_msgs.append(msg)
            n += 1
            if n >= 200_000:  # cap per source
                break
        log.info("loaded %d messages from %s", n, slug)

    if not all_msgs:
        log.error("no chat messages found in any source. did you download "
                  "discord-chat / telegram-filtered-messages / discord-dialogues?")
        return 1

    rng.shuffle(all_msgs)
    log.info("total chat messages: %d", len(all_msgs))

    encoder = JsonExpectedResponseEncoder()
    n_respond = n_ignore = n_stop = 0
    n_skipped = 0

    try:
        with OUT_PATH.open("w", encoding="utf-8") as out:
            recent: deque[dict] = deque(maxlen=args.memory_window)
            for i in range(args.n):
                # Feed the next batch of msgs into recent for context realism
                if all_msgs:
                    recent.append(all_msgs[i % len(all_msgs)])

                roll = rng.random()
                if roll < args.p_respond:
                    target_action = ACTION_RESPOND
                elif roll < args.p_respond + args.p_stop:
                    target_action = ACTION_STOP
                else:
                    target_action = ACTION_IGNORE

                agent = rng.choice(AGENT_NAMES)
                rec = synthesize_one(
                    recent=list(recent), all_chat=all_msgs,
                    agent=agent, target_action=target_action,
                    p_inject_name=args.p_inject_name,
                    encoder=encoder, rng=rng,
                )
                if rec is None:
                    n_skipped += 1
                    continue

                out.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
                if target_action == ACTION_RESPOND:
                    n_respond += 1
                elif target_action == ACTION_STOP:
                    n_stop += 1
                else:
                    n_ignore += 1

                if (n_respond + n_ignore + n_stop) % 500 == 0 and (n_respond + n_ignore + n_stop):
                    log.info(
                        "progress: %d RESPOND, %d IGNORE, %d STOP, %d skipped",
                        n_respond, n_ignore, n_stop, n_skipped,
                    )
    finally:
        encoder.close()

    log.info("done — %d RESPOND, %d IGNORE, %d STOP, %d skipped → %s",
             n_respond, n_ignore, n_stop, n_skipped, OUT_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
