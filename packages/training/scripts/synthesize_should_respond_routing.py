"""Synthesize **name-injection / ping / username-match** routing records.

This is a sibling to ``synthesize_routing.py`` but specifically targeted at
the ``should_respond_with_context`` task. We mine real chat turns from the
already-downloaded dialogue corpora and **augment** them with controlled
name/handle/ping signals so the trained agent learns:

  * direct mention by name → RESPOND
  * @-handle / username matches the agent → RESPOND
  * role-style address ("the assistant should ...") → RESPOND
  * "{agent} stop pinging me" / "shut up {agent}" → STOP
  * message clearly addressed to a different name → IGNORE
  * casual user-to-user chitchat → IGNORE
  * speaker IS the agent (echo of self) → IGNORE
  * name appears as quoted/referenced context, not address → IGNORE

Each record is one canonical eliza row with TOON-encoded
``expectedResponse`` keyed ``{name, reasoning, action, primaryContext,
secondaryContexts, evidenceTurnIds}`` and ``task_type =
should_respond_with_context``.

Inputs (mined; whichever exist):
  - ``data/raw/discord-chat/output_file.csv`` — multi-line conversations
    packed into one CSV cell per row. We split on "\\n" and parse
    ``"<handle#tag>: <message>"`` lines.
  - ``data/raw/discord-dialogues/data/train.parquet`` — text column with
    ``<|im_start|>user|>`` / ``<|im_start|>assistant|>`` segments.
  - ``data/raw/telegram-filtered-messages/data/*.parquet`` — single
    sentences plus ``channel_id``; we hash-derive a pseudo-handle.

Output:
  - ``data/synthesized/should_respond_routing.jsonl``

Usage:
    .venv/bin/python scripts/synthesize_should_respond_routing.py --n 50000
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import random
import re
import sys
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
OUT_PATH = ROOT / "data" / "synthesized" / "should_respond_routing.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-should-respond-routing")


# Keep this aligned with the prompt brief — these are the candidate agent
# identities the synthesizer rolls into each augmented turn.
AGENT_NAMES = [
    "mira", "nova", "axiom", "remi", "kai",
    "juno", "lyra", "silver", "eden", "ash",
]

# Pool of "different addressee" names for IGNORE — make sure none collide
# with the agent name pool above.
OTHER_NAMES = [
    "bob", "alice", "carl", "dana", "evan", "fiona", "greg", "hana",
    "ivan", "jules", "ken", "leo", "maya", "nate", "owen", "petra",
    "quinn", "raj", "sara", "theo", "uma", "vince", "wes", "xander",
    "yara", "zane", "marcus", "nadia", "oscar", "priya",
]

# Speaker token regexp for discord-chat lines like "Daj#7482: hello"
DISCORD_LINE_RE = re.compile(r"^([^\s:][^\n:]{0,40}):\s+(.+)$")
DIALOGUE_TURN_RE = re.compile(
    r"<\|im_start\|>(user|assistant)\n(.*?)<\|im_end\|>",
    re.DOTALL,
)


# ───────────────────────────── loaders ──────────────────────────────────────

def iter_discord_chat() -> Iterator[dict[str, Any]]:
    """Yield {speaker, content, channel} rows from data/raw/discord-chat."""
    path = RAW_DIR / "discord-chat" / "output_file.csv"
    if not path.exists():
        return
    # Bump CSV field-size limit; rows pack large conversations in one cell.
    csv.field_size_limit(sys.maxsize)
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            if not row:
                continue
            cell = row[0]
            if not cell or cell == "data":
                continue
            channel = f"discord-chat-{abs(hash(cell)) % 9999:04d}"
            for line in cell.split("\n"):
                line = line.strip()
                if not line:
                    continue
                m = DISCORD_LINE_RE.match(line)
                if not m:
                    continue
                speaker, content = m.group(1).strip(), m.group(2).strip()
                if (
                    not content
                    or len(content) < 2
                    or content.lower() == "joined the server."
                ):
                    continue
                yield {
                    "speaker": speaker[:40],
                    "content": content[:600],
                    "channel": channel,
                    "source": "discord-chat",
                }


def iter_discord_dialogues() -> Iterator[dict[str, Any]]:
    """Yield turns from data/raw/discord-dialogues/data/train.parquet.

    Each parquet row packs a multi-turn dialogue using ``<|im_start|>user|>``
    / ``<|im_start|>assistant|>`` markers; we split into individual turns
    with synthetic ``user_X`` / ``asst_X`` speakers (unique per dialogue so
    they look like distinct users in chat).
    """
    path = RAW_DIR / "discord-dialogues" / "data" / "train.parquet"
    if not path.exists():
        return
    import pyarrow.parquet as pq  # noqa: PLC0415
    table = pq.read_table(path, columns=["text"])
    for idx, row in enumerate(table.to_pylist()):
        text = row.get("text") or ""
        if not text:
            continue
        channel = f"discord-dlg-{idx % 9999:04d}"
        # Stable per-dialogue handles
        u_handle = f"user_{idx % 8000:04d}"
        a_handle = f"asst_{idx % 8000:04d}"
        for m in DIALOGUE_TURN_RE.finditer(text):
            role, content = m.group(1), m.group(2).strip()
            if not content or len(content) < 2:
                continue
            speaker = u_handle if role == "user" else a_handle
            yield {
                "speaker": speaker,
                "content": content[:600],
                "channel": channel,
                "source": "discord-dialogues",
            }


def iter_telegram() -> Iterator[dict[str, Any]]:
    """Yield turns from data/raw/telegram-filtered-messages/data/*.parquet."""
    base = RAW_DIR / "telegram-filtered-messages" / "data"
    if not base.exists():
        return
    import pyarrow.parquet as pq  # noqa: PLC0415
    for path in sorted(base.glob("*.parquet")):
        table = pq.read_table(path, columns=["sentence", "channel_id"])
        rows = table.to_pylist()
        for row in rows:
            sent = (row.get("sentence") or "").strip()
            ch = row.get("channel_id")
            if not sent or len(sent) < 2 or ch is None:
                continue
            speaker = f"tg_{abs(int(ch)) % 9999:04d}"
            yield {
                "speaker": speaker,
                "content": sent[:600],
                "channel": f"telegram-{abs(int(ch)) % 9999:04d}",
                "source": "telegram-filtered-messages",
            }


# Cap per source to avoid loading hundreds of MB of pure background chatter.
SOURCE_LOADERS: dict[str, tuple[Any, int]] = {
    "discord-chat": (iter_discord_chat, 220_000),
    "discord-dialogues": (iter_discord_dialogues, 220_000),
    "telegram-filtered-messages": (iter_telegram, 220_000),
}


def load_corpus(sources: list[str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Stream all configured sources into a single in-memory list."""
    msgs: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for slug in sources:
        loader, cap = SOURCE_LOADERS[slug]
        n = 0
        for msg in loader():
            msgs.append(msg)
            n += 1
            if n >= cap:
                break
        counts[slug] = n
        log.info("loaded %d turns from %s", n, slug)
    return msgs, counts


# ───────────────────────── name / address helpers ───────────────────────────

NAME_TOKEN_RES = {n: re.compile(rf"\b{re.escape(n)}\b", re.I) for n in AGENT_NAMES}
OTHER_TOKEN_RES = {n: re.compile(rf"\b{re.escape(n)}\b", re.I) for n in OTHER_NAMES}


def message_mentions(text: str, name: str) -> bool:
    pattern = NAME_TOKEN_RES.get(name) or re.compile(rf"\b{re.escape(name)}\b", re.I)
    return bool(pattern.search(text))


def message_mentions_other_agent(text: str, except_name: str) -> bool:
    """Return True if the text already mentions another agent in the pool —
    we want to skip those when injecting a fresh name to keep signals clean.
    """
    for n in AGENT_NAMES:
        if n == except_name:
            continue
        if NAME_TOKEN_RES[n].search(text):
            return True
    return False


# ────────────────────── augmenter dispatch table ───────────────────────────

# direct mention templates (RESPOND / direct_mention)
DIRECT_MENTION_TEMPLATES = [
    "hey @{agent}, {body}",
    "{agent}, {body}",
    "@{agent} {body}",
    "{agent} {body}",
    "{body} — what do you think, {agent}?",
    "yo {agent}: {body}",
    "{agent}, can you weigh in on this? {body}",
    "{agent} {body}?",
    "/cc {agent} {body}",
]

# username-match templates (RESPOND / username_match) — speaker handle
# becomes a variant of the agent name; the message either uses @handle or
# refers back to the bot account.
USERNAME_HANDLE_TEMPLATES = [
    "{agent}",
    "{agent}_official",
    "_{agent}",
    "the_{agent}",
    "{agent}.bot",
    "@{agent}",
]
USERNAME_MENTION_TEMPLATES = [
    "@{handle} {body}",
    "@{handle}, {body}",
    "{body} cc @{handle}",
    "calling @{handle} on this — {body}",
    "summoning @{handle}: {body}",
]

# role-style address (RESPOND / role_address)
ROLE_ADDRESS_TEMPLATES = [
    "could the assistant answer this — {body}",
    "the bot should handle this. {body}",
    "@everyone the AI on this please: {body}",
    "agent, {body}",
    "ai, can you {body}",
    "the assistant should {body}",
    "@bot {body}",
    "hey bot, {body}",
]

# stop signals (STOP)
STOP_TEMPLATES = [
    "{agent} stop pinging me",
    "shut up {agent}",
    "be quiet {agent}, leave us alone",
    "{agent} please stop",
    "leave us alone {agent}",
    "stop {agent}, this is between us",
    "@{agent} mute yourself please",
    "{agent} stop responding to every message",
    "shut up bot",
    "stop, agent — we're talking",
]

# different-addressee (IGNORE / different_addressee)
DIFFERENT_ADDRESSEE_TEMPLATES = [
    "@{other} {body}",
    "{other}, {body}",
    "hey {other}: {body}",
    "{other} can you take a look? {body}",
    "{body} — {other}?",
    "/cc {other} {body}",
    "@{other}, {body}",
]

# quoted reference (IGNORE / quoted_reference)
QUOTED_REFERENCE_TEMPLATES = [
    "yesterday {agent} said something interesting about {body}",
    "did you see what {agent} posted? {body}",
    "{agent}'s take was {body}",
    "i was reading {agent}'s old message — {body}",
    "remember when {agent} mentioned {body}? wild.",
    "according to {agent}, {body}",
    "{agent} would probably hate {body}",
]


def _shorten_body(text: str, max_chars: int = 160) -> str:
    """Trim a chat turn to a short, clean body fragment we can drop into a
    template. Lowercases the leading character only when it's a word
    starter to avoid weirdness like ``@bob YeahLikeISaid``.
    """
    body = text.strip().rstrip(".!?")
    if len(body) > max_chars:
        body = body[:max_chars].rstrip()
    return body


# ───────────────────────── augmentation strategies ─────────────────────────

def augment_direct_mention(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    body = _shorten_body(base["content"])
    template = rng.choice(DIRECT_MENTION_TEMPLATES)
    new_text = template.format(agent=agent, body=body).strip()
    reasoning = f"direct mention of {agent} in the latest message — addressed to the agent."
    out = dict(base)
    out["content"] = new_text
    return out, reasoning, "direct_mention"


def augment_username_match(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    handle_template = rng.choice(USERNAME_HANDLE_TEMPLATES)
    handle = handle_template.format(agent=agent)
    # Speaker mentions the agent's handle (someone else is the speaker, the
    # agent's @handle appears in the message).
    body = _shorten_body(base["content"])
    template = rng.choice(USERNAME_MENTION_TEMPLATES)
    new_text = template.format(handle=handle, body=body).strip()
    reasoning = f"message contains @{handle} which matches the agent username '{agent}' — addressed to the agent."
    out = dict(base)
    out["content"] = new_text
    return out, reasoning, "username_match"


def augment_role_address(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    body = _shorten_body(base["content"])
    template = rng.choice(ROLE_ADDRESS_TEMPLATES)
    new_text = template.format(body=body).strip()
    reasoning = "role-style address ('the assistant should ...') invokes the AI even without a name token."
    out = dict(base)
    out["content"] = new_text
    return out, reasoning, "role_address"


def augment_stop(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    template = rng.choice(STOP_TEMPLATES)
    new_text = template.format(agent=agent).strip()
    reasoning = f"the user is explicitly asking {agent} to stop responding."
    out = dict(base)
    out["content"] = new_text
    return out, reasoning, "stop"


def augment_different_addressee(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    other = rng.choice(OTHER_NAMES)
    body = _shorten_body(base["content"])
    template = rng.choice(DIFFERENT_ADDRESSEE_TEMPLATES)
    new_text = template.format(other=other, body=body).strip()
    reasoning = f"message is addressed to {other}, not {agent} — the agent should not respond."
    out = dict(base)
    out["content"] = new_text
    return out, reasoning, "different_addressee"


def augment_group_chitchat(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    # No augmentation — leave the message as-is, but require it to NOT
    # mention agent or another agent name. The caller already filters for
    # that condition before invoking this strategy.
    reasoning = f"casual chitchat between users; no addressing of {agent}."
    return dict(base), reasoning, "group_chitchat"


def augment_self(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    out = dict(base)
    out["speaker"] = agent  # the agent's own handle
    reasoning = f"the speaker IS {agent}; the agent must not respond to its own message."
    return out, reasoning, "self"


def augment_quoted_reference(
    base: dict[str, Any], agent: str, rng: random.Random,
) -> tuple[dict[str, Any], str, str]:
    body = _shorten_body(base["content"], max_chars=120)
    template = rng.choice(QUOTED_REFERENCE_TEMPLATES)
    new_text = template.format(agent=agent, body=body).strip()
    reasoning = (
        f"{agent}'s name appears but the speaker is referencing past content, "
        f"not addressing the agent — IGNORE."
    )
    out = dict(base)
    out["content"] = new_text
    return out, reasoning, "quoted_reference"


# Distribution targets per the brief, expressed as relative weights inside
# each top-level action bucket.
SIGNAL_BUCKETS = {
    ACTION_RESPOND: [
        ("direct_mention", augment_direct_mention, 0.60),
        ("username_match", augment_username_match, 0.15),
        ("role_address", augment_role_address, 0.25),
    ],
    ACTION_IGNORE: [
        ("different_addressee", augment_different_addressee, 0.45),
        ("group_chitchat", augment_group_chitchat, 0.30),
        ("self", augment_self, 0.10),
        ("quoted_reference", augment_quoted_reference, 0.15),
    ],
    ACTION_STOP: [
        ("stop", augment_stop, 1.0),
    ],
}


def pick_strategy(action: str, rng: random.Random):
    bucket = SIGNAL_BUCKETS[action]
    r = rng.random()
    cum = 0.0
    for kind, fn, w in bucket:
        cum += w
        if r <= cum:
            return kind, fn
    return bucket[-1][0], bucket[-1][1]


# ───────────────────────────── synthesis ────────────────────────────────────

def find_clean_base(
    pool: list[dict[str, Any]], agent: str, *,
    max_tries: int = 60, require_clean: bool, rng: random.Random,
) -> dict[str, Any] | None:
    """Pick a base turn that doesn't already mention any agent-pool name
    (when ``require_clean`` is set). For group_chitchat / IGNORE we
    additionally require the text to not contain any other-pool name to
    keep the negative signal clear."""
    n = len(pool)
    if n == 0:
        return None
    for _ in range(max_tries):
        cand = pool[rng.randrange(n)]
        text = cand["content"]
        if require_clean and message_mentions_other_agent(text, except_name=""):
            continue
        # Reject overly short or generated-looking artifacts that don't
        # carry any conversational substance.
        if len(text) < 6:
            continue
        return cand
    return None


def find_clean_chitchat_base(
    pool: list[dict[str, Any]], agent: str, *,
    max_tries: int = 80, rng: random.Random,
) -> dict[str, Any] | None:
    """For group_chitchat we additionally need the text NOT to address any
    OTHER name at all (no `bob, ...` / `@alice ...`), or it stops being
    pure chitchat."""
    n = len(pool)
    if n == 0:
        return None
    for _ in range(max_tries):
        cand = pool[rng.randrange(n)]
        text = cand["content"]
        if message_mentions_other_agent(text, except_name=""):
            continue
        if any(p.search(text) for p in OTHER_TOKEN_RES.values()):
            continue
        if "@" in text:
            continue
        if len(text) < 8 or len(text) > 280:
            continue
        return cand
    return None


def build_memory(
    pool: list[dict[str, Any]], current_channel: str, *,
    window: int, rng: random.Random, agent: str,
) -> list[dict[str, Any]]:
    """Sample a small bundle of recent-looking turns to drop into
    memoryEntries. We bias toward turns whose channel matches the current
    one for realism, but accept random ones if the channel is sparse."""
    n = len(pool)
    if n == 0 or window <= 0:
        return []
    k = rng.randint(max(1, window // 2), window)
    picks: list[dict[str, Any]] = []
    tries = 0
    while len(picks) < k and tries < k * 6:
        tries += 1
        cand = pool[rng.randrange(n)]
        text = cand["content"]
        # Drop memory entries that already contain the agent name —
        # otherwise the model cheats by carrying the signal across turns.
        if message_mentions(text, agent):
            continue
        picks.append({
            "role": "user",
            "speaker": cand["speaker"],
            "content": text,
            "channel": current_channel,
        })
    return picks


def synthesize_one(
    *, pool: list[dict[str, Any]], agent: str, action: str,
    encoder: ExpectedResponseEncoder, rng: random.Random, memory_window: int,
) -> dict[str, Any] | None:
    kind, augmenter = pick_strategy(action, rng)

    # Find a usable base turn for the chosen strategy.
    if kind == "group_chitchat":
        base = find_clean_chitchat_base(pool, agent, rng=rng)
    else:
        base = find_clean_base(pool, agent, require_clean=True, rng=rng)
    if base is None:
        return None

    augmented, reasoning, signal_kind = augmenter(base, agent, rng)

    # Build the memory window from random other turns in the same source
    # (channel-matched when possible).
    channel = augmented.get("channel") or "public"
    is_dm = rng.random() < 0.18  # small fraction labeled as DM
    channel_label = "dm" if is_dm else "public"

    memory = build_memory(
        pool, current_channel=channel, window=memory_window, rng=rng, agent=agent,
    )

    current = {
        "role": "user",
        "speaker": augmented["speaker"],
        "content": augmented["content"],
        "channel": channel_label,
    }

    target = {
        "name": agent,
        "reasoning": reasoning,
        "action": action,
        "primaryContext": "general",
        "secondaryContexts": "",
        "evidenceTurnIds": "",
    }
    expected = encoder.encode(target)

    rec = build(
        roomName=stable_id(
            "routing-v2", agent, signal_kind, current["content"][:140], action,
        ),
        agentId=agent,
        memoryEntries=memory,
        currentMessage=current,
        expectedResponse=expected,
        availableActions=[ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP],
        task_type="should_respond_with_context",
        source_dataset="synth-should-respond-routing",
        license="cc-by-sa-4.0",
        split="train",
        extra_metadata={
            "signal_kind": signal_kind,
            "agent_name": agent,
            "synth_target_action": action,
            "base_source": base.get("source", "unknown"),
        },
    )
    return rec.to_dict()


# ───────────────────────────────── main ─────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=50000)
    ap.add_argument("--p-respond", type=float, default=0.36)
    ap.add_argument("--p-ignore", type=float, default=0.56)
    ap.add_argument("--p-stop", type=float, default=0.08)
    ap.add_argument("--memory-window", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0xE71A05)
    ap.add_argument(
        "--sources",
        type=str,
        default="discord-chat,discord-dialogues,telegram-filtered-messages",
        help="comma-separated dialogue source slugs in data/raw/",
    )
    args = ap.parse_args()

    total = args.p_respond + args.p_ignore + args.p_stop
    if abs(total - 1.0) > 1e-6:
        log.warning("p_respond+p_ignore+p_stop = %.4f (not 1.0)", total)

    rng = random.Random(args.seed)

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    pool, source_counts = load_corpus(sources)
    if not pool:
        log.error("no chat messages loaded — verify data/raw/ contains the "
                  "expected dialogue corpora.")
        return 1

    rng.shuffle(pool)
    log.info("total turns in pool: %d", len(pool))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    encoder = JsonExpectedResponseEncoder()
    n_respond = n_ignore = n_stop = n_skipped = 0
    signal_counts: dict[str, int] = {}

    try:
        with OUT_PATH.open("w", encoding="utf-8") as out:
            for i in range(args.n):
                roll = rng.random()
                if roll < args.p_respond:
                    action = ACTION_RESPOND
                elif roll < args.p_respond + args.p_ignore:
                    action = ACTION_IGNORE
                else:
                    action = ACTION_STOP

                agent = rng.choice(AGENT_NAMES)
                rec = synthesize_one(
                    pool=pool, agent=agent, action=action,
                    encoder=encoder, rng=rng,
                    memory_window=args.memory_window,
                )
                if rec is None:
                    n_skipped += 1
                    continue

                out.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")

                if action == ACTION_RESPOND:
                    n_respond += 1
                elif action == ACTION_IGNORE:
                    n_ignore += 1
                else:
                    n_stop += 1

                kind = rec["metadata"]["signal_kind"]
                signal_counts[kind] = signal_counts.get(kind, 0) + 1

                done = n_respond + n_ignore + n_stop
                if done % 2500 == 0:
                    log.info(
                        "progress: %d total — RESPOND=%d IGNORE=%d STOP=%d (skipped=%d)",
                        done, n_respond, n_ignore, n_stop, n_skipped,
                    )
    finally:
        encoder.close()

    log.info(
        "done — RESPOND=%d IGNORE=%d STOP=%d (skipped=%d) → %s",
        n_respond, n_ignore, n_stop, n_skipped, OUT_PATH,
    )
    log.info("signal_kind distribution:")
    for k, v in sorted(signal_counts.items(), key=lambda kv: -kv[1]):
        log.info("  %-22s %d", k, v)
    log.info("source loadcounts: %s", source_counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
