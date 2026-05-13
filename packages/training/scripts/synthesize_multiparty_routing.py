"""Build canonical `should_respond` records from multi-party chat corpora.

Four sources are consumed (download via scripts/download_datasets.py first):

  - ishiki-labs/multi-party-dialogue
        Pre-labeled. Each row already has target_speaker, context_turns,
        current_turn, and a SPEAK/SILENT decision. Map directly to
        RESPOND / IGNORE.

  - mrfakename/multilight-sharegpt
        ShareGPT-style scripted multi-character roleplay. We walk each
        conversation, pick a real character as the "agent", chunk K
        prior turns as memory + the next turn from a different
        character as currentMessage, and label by whether the agent
        spoke next (RESPOND) or somebody else did (IGNORE).

  - CFettuccini/multipartyconv
        CSV of `<s>[INST]>>{user1} : msg>>{user2} : msg...` strings.
        Same chunk-and-roleplay logic as multilight-sharegpt.

  - nu-dialogue/multi-relational-multi-party-chat-corpus
        Japanese multi-party JSON dialogues, fetched separately as a
        zip from the upstream GitHub release (the HF entry is a script
        loader that snapshot_download skips).

Output: data/synthesized/multiparty_should_respond.jsonl

Each record matches the canonical eliza shape and uses task_type
"should_respond" — same task_type the runtime's should_respond
template/handler consumes — with the supervised target rendered as
the native JSON document {name, reasoning, action, primaryContext,
secondaryContexts, evidenceTurnIds}.

Usage:
    uv run python scripts/synthesize_multiparty_routing.py \\
        --n 10000 --p-respond 0.5 --memory-window 12
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import random
import re
import sys
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Iterable, Iterator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    ACTION_IGNORE, ACTION_RESPOND, ACTION_STOP,
    build, stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

RAW_DIR = ROOT / "data" / "raw"
OUT_PATH = ROOT / "data" / "synthesized" / "multiparty_should_respond.jsonl"
NU_DIALOGUE_GITHUB_ZIP = (
    "https://codeload.github.com/nu-dialogue/"
    "multi-relational-multi-party-chat-corpus/zip/refs/tags/v1.0.0"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-multiparty")


# ─────────────────────── shared structures + helpers ────────────────────────

# A "turn" is a normalized chat message inside a conversation.
#   speaker:  display name of the participant (string)
#   text:     utterance text (string)
#   turn_id:  optional id for evidence references (string or "")
#
# A "conversation" is an ordered list of turns sharing a room.

PRIMARY_CONTEXT_DEFAULT = "general"


def _has_addressing(text: str, speaker: str) -> bool:
    """Heuristic: does `text` directly address participant `speaker`?

    Looks for explicit @-mention, a name token at the start (`Bob,`),
    or the name as a standalone token anywhere.
    """
    if not text or not speaker:
        return False
    t = text.lower()
    s = speaker.lower().strip()
    if not s or s in {"user", "human", "ai", "assistant", "bot"}:
        return False
    if f"@{s}" in t:
        return True
    if re.search(rf"^\s*{re.escape(s)}\s*[,:?!]", t, re.I):
        return True
    if re.search(rf"\b{re.escape(s)}\b", t, re.I):
        return True
    return False


def _build_record(
    *,
    slug: str,
    license: str,
    split: str,
    agent_name: str,
    context_turns: list[dict[str, str]],
    current_turn: dict[str, str],
    action: str,
    reasoning: str,
    encoder: ExpectedResponseEncoder,
    extra_metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Render one canonical eliza `should_respond` record."""
    if not agent_name or not current_turn.get("text"):
        return None

    target = {
        "name": agent_name,
        "reasoning": reasoning,
        "action": action,
        "primaryContext": PRIMARY_CONTEXT_DEFAULT,
        "secondaryContexts": "",
        "evidenceTurnIds": "",
    }
    payload = encoder.encode(target)

    memory = [
        {
            "role": "user",
            "speaker": (t.get("speaker") or "user")[:60],
            "content": (t.get("text") or "")[:2000],
            "channel": "public",
        }
        for t in context_turns
        if (t.get("text") or "").strip()
    ]
    current = {
        "role": "user",
        "speaker": (current_turn.get("speaker") or "user")[:60],
        "content": (current_turn.get("text") or "")[:2000],
        "channel": "public",
    }

    md: dict[str, Any] = {
        "agent_name": agent_name,
        "synth_target_action": action,
        "task_type_handler": "should_respond",
    }
    if extra_metadata:
        md.update(extra_metadata)

    return build(
        roomName=stable_id(slug, agent_name, current["content"][:120], action),
        agentId=agent_name.lower(),
        memoryEntries=memory,
        currentMessage=current,
        expectedResponse=payload,
        availableActions=[ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP],
        task_type="should_respond",
        source_dataset=slug,
        license=license,
        split=split,
        extra_metadata=md,
    ).to_dict()


# ──────────────────────────── ishiki-labs loader ────────────────────────────

# Pre-labeled. Each row → exactly one record.
def iter_ishiki_records(
    *, slug: str, license: str, encoder: ExpectedResponseEncoder,
) -> Iterator[dict[str, Any]]:
    base = RAW_DIR / slug
    if not base.exists():
        return
    for path in sorted(base.rglob("*.jsonl")):
        # split inferred from path: train/val/test
        parts = {p.lower() for p in path.parts}
        if "train" in parts:
            split = "train"
        elif "val" in parts or "validation" in parts or "dev" in parts:
            split = "validation"
        elif "test" in parts:
            split = "test"
        else:
            split = "train"
        # skip the pre-filtering dumps that are not a clean split
        if "stage4_filtered_samples" in path.name or "filtering_summary" in path.name:
            continue
        # Optionally use the with_reasoning variant — same rows but with
        # extra reasoning field; we prefer it for richer reasoning text.
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                target = r.get("target_speaker") or ""
                if not target:
                    continue
                ctx = r.get("context_turns") or []
                cur = r.get("current_turn") or {}
                if not isinstance(cur, dict) or not cur.get("text"):
                    continue
                decision = (r.get("decision") or "").upper()
                if decision == "SPEAK":
                    action = ACTION_RESPOND
                elif decision == "SILENT":
                    action = ACTION_IGNORE
                else:
                    continue
                reasoning = (
                    r.get("reason")
                    or ("target was directly addressed by the speaker"
                        if action == ACTION_RESPOND
                        else "another participant is being addressed; agent should stay silent")
                )
                rec = _build_record(
                    slug=slug,
                    license=license,
                    split=split,
                    agent_name=str(target),
                    context_turns=[
                        {"speaker": str(t.get("speaker") or ""), "text": str(t.get("text") or "")}
                        for t in ctx if isinstance(t, dict)
                    ],
                    current_turn={
                        "speaker": str(cur.get("speaker") or ""),
                        "text": str(cur.get("text") or ""),
                    },
                    action=action,
                    reasoning=str(reasoning)[:400],
                    encoder=encoder,
                    extra_metadata={
                        "ishiki_meeting_id": r.get("meeting_id"),
                        "ishiki_decision_point_id": r.get("decision_point_id"),
                        "ishiki_category": r.get("category"),
                        "ishiki_source": r.get("source"),
                        "ishiki_target_is_addressed": r.get("target_is_addressed"),
                        "ishiki_target_spoke_next": r.get("target_spoke_next"),
                    },
                )
                if rec:
                    yield rec


# ───────────────────── multilight-sharegpt loader ───────────────────────────

# Format: top-level {"conversations": [{"role": "characters", "content": "<list>"},
#                                       {"role": "<charName>", "content": "<turn>"}, ...]}
# But the file is a JSON array of such objects (or a JSON list per file).
def iter_multilight_conversations(slug: str) -> Iterator[list[dict[str, str]]]:
    base = RAW_DIR / slug
    if not base.exists():
        return
    for path in sorted(base.rglob("*.json")):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            continue
        for entry in data:
            if not isinstance(entry, dict):
                continue
            convs = entry.get("conversations") or entry.get("messages") or []
            if not isinstance(convs, list):
                continue
            turns: list[dict[str, str]] = []
            for m in convs:
                if not isinstance(m, dict):
                    continue
                role = str(m.get("role") or m.get("from") or "").strip()
                content = m.get("content") or m.get("value")
                if isinstance(content, list):
                    content = " ".join(
                        c.get("text", "") if isinstance(c, dict) else str(c)
                        for c in content
                    )
                content = str(content or "").strip()
                if not content:
                    continue
                # Skip the metadata/system "characters" turn — it's a
                # description of the cast, not a real utterance.
                if role.lower() in {"characters", "system", "narrator", ""}:
                    continue
                turns.append({"speaker": role, "text": content, "turn_id": ""})
            if len(turns) >= 4:
                yield turns


# ──────────────────────── multipartyconv loader ─────────────────────────────

# CSV with one column `text`. Each cell:
#   <s>[INST]>>{user1} : msg>>{user2} : msg...[/INST]...
_MPC_TURN_RE = re.compile(r">>\{([^}]+)\}\s*:\s*(.*?)(?=>>\{[^}]+\}\s*:|\[/INST\]|$)", re.S)


def iter_multipartyconv_conversations(slug: str) -> Iterator[list[dict[str, str]]]:
    base = RAW_DIR / slug
    if not base.exists():
        return
    # Some rows pack many turns into one cell (>128 KB); raise the limit.
    csv.field_size_limit(min(sys.maxsize, 64 * 1024 * 1024))
    for path in sorted(base.rglob("*.csv")):
        with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                text = row.get("text") or row.get("conversation") or ""
                if not text:
                    continue
                turns: list[dict[str, str]] = []
                for m in _MPC_TURN_RE.finditer(text):
                    speaker = m.group(1).strip()
                    msg = m.group(2).strip()
                    if not speaker or not msg:
                        continue
                    if speaker.lower() in {"deleted", "[deleted]", "automoderator"}:
                        continue
                    turns.append({"speaker": speaker, "text": msg, "turn_id": ""})
                if len(turns) >= 4:
                    yield turns


# ──────────────────────── nu-dialogue loader (zip) ──────────────────────────

# JSON shape per dialogue file:
#   {"dialogue_id": "...", "interlocutors": ["a","b","c"],
#    "utterances": [{"interlocutor_id": "a", "text": "..."}...]}
def _ensure_nu_dialogue_extracted(slug: str) -> Path:
    """The HF entry is a script loader that the standard downloader skips
    (allow_patterns excludes .py). Fetch the upstream GitHub zip directly
    on first call.
    """
    base = RAW_DIR / slug
    base.mkdir(parents=True, exist_ok=True)
    marker = base / ".nu_dialogue_unpacked"
    if marker.exists():
        return base
    log.info("fetching nu-dialogue github release zip → %s", base)
    with urllib.request.urlopen(NU_DIALOGUE_GITHUB_ZIP, timeout=60) as resp:
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            if not name.endswith(".json"):
                continue
            if "/dialogues/" not in name:
                continue
            target = base / Path(*Path(name).parts[1:])  # drop "<repo>-<ver>/" root
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(name))
    marker.write_text("done\n", encoding="utf-8")
    return base


def iter_nu_dialogue_conversations(slug: str) -> Iterator[list[dict[str, str]]]:
    base = _ensure_nu_dialogue_extracted(slug)
    for path in sorted(base.rglob("*.json")):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        utts = data.get("utterances") or []
        if not isinstance(utts, list):
            continue
        turns: list[dict[str, str]] = []
        for u in utts:
            if not isinstance(u, dict):
                continue
            speaker = str(u.get("interlocutor_id") or u.get("speaker") or "").strip()
            text = str(u.get("text") or "").strip()
            if not speaker or not text:
                continue
            turns.append({
                "speaker": speaker,
                "text": text,
                "turn_id": str(u.get("utterance_id") or ""),
            })
        if len(turns) >= 4:
            yield turns


# ──────── chunk-and-roleplay synth for unlabeled conversation corpora ───────

def _conversation_speakers(turns: list[dict[str, str]]) -> list[str]:
    seen: list[str] = []
    for t in turns:
        sp = (t.get("speaker") or "").strip()
        if sp and sp not in seen:
            seen.append(sp)
    return seen


def synth_from_conversation(
    *,
    turns: list[dict[str, str]],
    slug: str,
    license: str,
    split: str,
    encoder: ExpectedResponseEncoder,
    rng: random.Random,
    memory_window: int,
    p_respond: float,
    target_action: str | None = None,
) -> dict[str, Any] | None:
    """Pick one (agent, current_turn, context) triple from `turns` and
    label RESPOND / IGNORE based on whether the agent actually spoke
    next in the original conversation (or the current turn explicitly
    addresses the agent).
    """
    speakers = _conversation_speakers(turns)
    if len(speakers) < 2 or len(turns) < 4:
        return None

    # Walk the conversation looking for an (i, agent) where:
    #   - turn i is from someone other than `agent`
    #   - turn i+1 exists (so we know who spoke next)
    # We try a small number of random positions, biased toward the
    # `target_action` we want.
    attempts = []
    indices = list(range(2, len(turns) - 1))
    rng.shuffle(indices)
    for i in indices[:60]:
        cur = turns[i]
        nxt = turns[i + 1]
        cur_speaker = cur.get("speaker") or ""
        nxt_speaker = nxt.get("speaker") or ""
        if not cur_speaker or not nxt_speaker:
            continue

        # Choose the agent based on what label we want this row to carry.
        #   RESPOND target: agent = whoever spoke NEXT (or who is named in cur)
        #   IGNORE  target: agent = a participant who is NOT cur_speaker
        #                   AND who did NOT speak next AND is NOT addressed
        if target_action == ACTION_RESPOND:
            if nxt_speaker == cur_speaker:
                continue
            agent = nxt_speaker
            addressed = _has_addressing(cur.get("text", ""), agent)
            spoke_next = True
            if not (addressed or spoke_next):
                continue
            reasoning = (
                f"the latest message contains '{agent}' as a name token addressed to them."
                if addressed else
                f"the conversation flow expects {agent} to respond next."
            )
        else:  # IGNORE
            candidates = [s for s in speakers
                          if s != cur_speaker and s != nxt_speaker
                          and not _has_addressing(cur.get("text", ""), s)]
            if not candidates:
                continue
            agent = rng.choice(candidates)
            reasoning = "no explicit address to the agent; the speaker is talking to someone else."

        ctx_start = max(0, i - memory_window)
        ctx = turns[ctx_start:i]
        rec = _build_record(
            slug=slug,
            license=license,
            split=split,
            agent_name=agent,
            context_turns=ctx,
            current_turn=cur,
            action=target_action,
            reasoning=reasoning,
            encoder=encoder,
            extra_metadata={
                "next_speaker": nxt_speaker,
                "memory_window": memory_window,
            },
        )
        if rec:
            attempts.append(rec)
            return rec
    return None


# ─────────────────────────────── main loop ──────────────────────────────────

def _conversations_for_slug(slug: str) -> Iterable[list[dict[str, str]]]:
    if "multilight" in slug:
        return iter_multilight_conversations(slug)
    if "multipartyconv" in slug:
        return iter_multipartyconv_conversations(slug)
    if "multi-relational" in slug or "nu-dialogue" in slug:
        return iter_nu_dialogue_conversations(slug)
    return ()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10000,
                    help="number of records to generate from unlabeled "
                         "conversation corpora; ishiki passes through whole-cloth.")
    ap.add_argument("--p-respond", type=float, default=0.5)
    ap.add_argument("--memory-window", type=int, default=12)
    ap.add_argument("--seed", type=int, default=0xE71A05)
    ap.add_argument("--ishiki-slug", type=str,
                    default="ishiki-labs-multi-party-dialogue")
    ap.add_argument("--unlabeled-sources", type=str,
                    default=("mrfakename-multilight-sharegpt,"
                             "cfettuccini-multipartyconv,"
                             "nu-dialogue-multi-relational-mp"),
                    help="comma-separated slugs in data/raw/")
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    encoder = JsonExpectedResponseEncoder()
    out_path: Path = args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    n_respond = n_ignore = n_total = 0
    seen: set[str] = set()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            # 1) pre-labeled ishiki rows — pass through completely
            log.info("emitting ishiki-labs records...")
            for rec in iter_ishiki_records(
                slug=args.ishiki_slug,
                license="apache-2.0",
                encoder=encoder,
            ):
                key = stable_id(
                    rec["metadata"].get("ishiki_decision_point_id") or "",
                    rec["currentMessage"]["content"][:200],
                )
                if key in seen:
                    continue
                seen.add(key)
                out.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
                n_total += 1
                if rec["metadata"].get("synth_target_action") == ACTION_RESPOND:
                    n_respond += 1
                else:
                    n_ignore += 1
            log.info("  ishiki: emitted %d (RESPOND=%d, IGNORE=%d)",
                     n_total, n_respond, n_ignore)

            # 2) unlabeled corpora — chunk + roleplay
            unlabeled = [s.strip() for s in args.unlabeled_sources.split(",") if s.strip()]
            target_each = max(1, args.n // max(1, len(unlabeled)))
            for slug in unlabeled:
                log.info("synthesizing from %s (target %d records)...", slug, target_each)
                conv_iter = _conversations_for_slug(slug)
                license = (
                    "apache-2.0" if "multilight" in slug
                    else "unknown" if "multipartyconv" in slug
                    else "cc-by-nd-4.0"
                )
                kept = 0
                resp_kept = ign_kept = 0
                # round-robin RESPOND / IGNORE so we end up ~50/50
                want_respond = True
                conv_pool: list[list[dict[str, str]]] = []
                for conv in conv_iter:
                    conv_pool.append(conv)
                    if len(conv_pool) >= 5000:
                        break
                if not conv_pool:
                    log.warning("  %s: no conversations loaded", slug)
                    continue
                rng.shuffle(conv_pool)

                # Cycle through the pool until we have target_each records.
                idx = 0
                stalls = 0
                while kept < target_each and stalls < target_each * 3:
                    conv = conv_pool[idx % len(conv_pool)]
                    idx += 1
                    # Round-robin RESPOND / IGNORE so the unlabeled output
                    # converges on ~50/50 even when conversations reject
                    # one side. p_respond tilts the global balance.
                    if want_respond and rng.random() < args.p_respond * 2:
                        target_action = ACTION_RESPOND
                    else:
                        target_action = ACTION_IGNORE
                    split = "train"
                    rec = synth_from_conversation(
                        turns=conv, slug=slug, license=license, split=split,
                        encoder=encoder, rng=rng,
                        memory_window=args.memory_window,
                        p_respond=args.p_respond,
                        target_action=target_action,
                    )
                    if rec is None:
                        stalls += 1
                        continue
                    key = stable_id(
                        slug,
                        rec["metadata"].get("agent_name") or "",
                        rec["currentMessage"]["content"][:200],
                        target_action,
                    )
                    if key in seen:
                        stalls += 1
                        continue
                    seen.add(key)
                    out.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
                    kept += 1
                    n_total += 1
                    if target_action == ACTION_RESPOND:
                        resp_kept += 1
                        n_respond += 1
                        want_respond = False
                    else:
                        ign_kept += 1
                        n_ignore += 1
                        want_respond = True
                log.info("  %s: emitted %d (RESPOND=%d, IGNORE=%d)",
                         slug, kept, resp_kept, ign_kept)
    finally:
        encoder.close()

    log.info("done — %d records (RESPOND=%d, IGNORE=%d) → %s",
             n_total, n_respond, n_ignore, out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
