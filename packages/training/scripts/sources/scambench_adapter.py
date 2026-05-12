"""ScamBench → canonical eliza `reply` records for refusal SFT.

Reads `lalalune/scambench-training` (already cached locally as parquet
shards under `data/raw/scambench/`) and emits one canonical eliza record
per scam-trigger entry (plus a calibrated slice of legitimate entries to
guard against over-refusal).

Output: `data/synthesized/scambench/scambench.jsonl`
        `data/synthesized/scambench/manifest.json`

Each record has:
  - `task_type = "reply"`
  - JSON `expectedResponse` shaped like
        {"thought":"<first-person inner thought>","reply":{"text":"<safe response>","channel":"chat"}}
  - `metadata.system_prompt` rendered from `data/prompts/registry.json`'s
    `reply` template via the handlebars helper in
    `scripts/format_for_training.py`.
  - `metadata.scam_category` mapped from the upstream `scenario_category`
    onto the canonical taxonomy:
        phishing | impersonation | crypto-scam | sextortion | romance
        tech-support | wire-fraud | other  (plus `none` for legitimate)

Why this is a separate adapter from `scambench_passthrough` /
`scam_defense_corpus`:

The existing adapters emit the FULL planner envelope
(`thought, actions, providers, text, simple`) under `task_type =
scam_defense`. That is the right shape for the agent's planner stage.

For abliterated-model recovery we need a TIGHT, plain reply target tied
to the canonical `reply` system prompt — no planner overhead. This
adapter writes that shape so the SFT pass can re-instill refusal as the
direct `reply` behavior, in addition to the planner-level scam-defense
data already in the corpus.

Run:
    uv run python scripts/sources/scambench_adapter.py
    uv run python scripts/sources/scambench_adapter.py --validate
    uv run python scripts/sources/scambench_adapter.py --limit 200
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterator

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import _load_prompt_registry, render_handlebars  # noqa: E402
from lib.eliza_record import build  # noqa: E402
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

RAW_DIR = ROOT / "data" / "raw" / "scambench" / "data"
TRAIN_PARQUET = RAW_DIR / "train" / "train-00000-of-00001.parquet"
OUT_DIR = ROOT / "data" / "synthesized" / "scambench"
OUT_FILE = OUT_DIR / "scambench.jsonl"
MANIFEST_FILE = OUT_DIR / "manifest.json"

SOURCE_SLUG = "scambench"
LICENSE = "cc-by-sa-4.0"
SPLIT = "train"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("scambench-adapter")


# ─────────────── scam-category taxonomy ─────────────────────────────────
# The user-facing canonical taxonomy is small and stable. We map the
# upstream `scenario_category` (154 values) onto eight categories plus a
# `none` bucket for legitimate / benign control records. Anything that
# doesn't match an explicit rule lands in `other` (with the upstream
# label preserved under metadata.scenario_category for traceability).

CATEGORY_RULES: list[tuple[re.Pattern[str], str]] = [
    # crypto must come first — "crypto-investment-scam" should be crypto-scam not wire-fraud
    (re.compile(r"crypto|token|presale|airdrop|nft|wallet|seed[-_ ]?phrase|private[-_ ]?key|metamask|defi|^rug|pump[-_ ]?(and|dump)|web3|bitcoin|ethereum", re.I), "crypto-scam"),
    (re.compile(r"phish|smish|vish|fake[-_ ]?(login|page|invoice|alert)|credential[-_ ]?(harvest|theft|phish)|secret[-_ ]?exfiltrat|exfiltrat|password[-_ ]?(leak|harvest)|key[-_ ]?theft", re.I), "phishing"),
    (re.compile(r"sextort|nude|nudify|cam[-_ ]?girl|onlyfans|intimate", re.I), "sextortion"),
    (re.compile(r"romance|dating|catfish|lonely|widow|heart[-_ ]?strings", re.I), "romance"),
    (re.compile(r"tech[-_ ]?support|microsoft[-_ ]?support|apple[-_ ]?support|virus[-_ ]?detected|computer[-_ ]?(slow|infected)|remote[-_ ]?desktop|teamviewer|anydesk", re.I), "tech-support"),
    (re.compile(r"wire|advance[-_ ]?fee|419|nigeri|inheritance|grant|lottery|prize|mule|moneygram|western[-_ ]?union|investment[-_ ]?scam", re.I), "wire-fraud"),
    # impersonation last so it doesn't shadow more specific buckets above
    (re.compile(r"impersonat|spoof|fake[-_ ]?(boss|ceo|admin|support|bank)|admin[-_ ]?override|government|police|tax|irs|hmrc|bafin|bizum|banorte|caixa|dsi|family[-_ ]?member|grandparent|ceo[-_ ]?fraud|business[-_ ]?email[-_ ]?compromise|bec\b", re.I), "impersonation"),
]

# Explicit override map for upstream scenario_category values that don't
# carry obvious lexical signals but map cleanly to the canonical taxonomy.
# Keys are case-sensitive (the upstream is consistent). Anything not here
# falls back to CATEGORY_RULES, then "other".
SCENARIO_OVERRIDES: dict[str, str] = {
    "social-engineering": "impersonation",
    "persistent-social-engineering": "impersonation",
    "social-manipulation": "impersonation",
    "interpersonal-abuse": "impersonation",
    "government-impersonation": "impersonation",
    "admin-override": "impersonation",
    "hitl-bypass": "impersonation",
    "unauthorized-access": "impersonation",
    "credential-theft": "phishing",
    "credential-phishing": "phishing",
    "phishing-link": "phishing",
    "secret-exfiltration": "phishing",
    "malware-delivery": "phishing",
    "investment-scam": "wire-fraud",
    "advance-fee-fraud": "wire-fraud",
}

LEGITIMATE_CATEGORIES = {"legitimate", "benign"}


def map_scam_category(scenario_category: str, *, is_scam: bool) -> str:
    """Return canonical scam_category for a scambench scenario."""
    sc = (scenario_category or "").strip()
    if not is_scam or sc in LEGITIMATE_CATEGORIES:
        return "none"
    if sc.startswith("legitimate"):
        return "none"
    if sc in SCENARIO_OVERRIDES:
        return SCENARIO_OVERRIDES[sc]
    for pattern, name in CATEGORY_RULES:
        if pattern.search(sc):
            return name
    return "other"


# ─────────────── thought generation ─────────────────────────────────────
# We synthesize a 1-2 sentence first-person inner thought from the
# upstream `decision_class` + `scam_category` so each record carries a
# meaningful `thought:` field. This is deterministic (no LLM call) — the
# refusal-recovery objective is the `reply.text`, not the thought, so a
# templated thought is sufficient.

DECISION_THOUGHT_TEMPLATES: dict[str, str] = {
    "refuse": "I can name this as {cat_a} attempt. I will decline directly without giving details that help the attacker.",
    "request_verification": "This looks like {cat_a} attempt. I will not act on it; I will ask for independent verification through a known-good channel.",
    "audit": "Several signals here read as {cat}. I will refuse, log the attempt, and not engage with the framing.",
    "escalate": "This crosses into {cat} territory. I will refuse and direct the user to a verified escalation path.",
    "block_actor": "This is a clear {cat} pattern. I will block and refuse without further engagement.",
    "warn_actor": "This has the shape of {cat_a} attempt. I will warn the user and refuse to act on it.",
    "ignore": "This is a {cat} prompt. I will ignore the framing and not engage.",
    "deny_privileged_action": "{cat_cap} requests cannot be granted from chat. I will refuse cleanly.",
    "engage_legitimate": "This reads as a normal user request. I will help directly, no scam signals to flag.",
    "allow_safe_action": "This is a routine request. I will respond normally.",
    "execute_transaction": "This is a routine, non-sensitive transaction. I will proceed.",
    "accept": "This is a normal request. I will respond directly.",
    "share_safe_info": "This is a benign info request. I will share what is safe to share.",
}

DEFAULT_THOUGHT = "I will respond carefully and refuse anything that looks unsafe."


def _article(word: str) -> str:
    """Return 'a' or 'an' for the leading vowel sound."""
    return "an" if word[:1].lower() in "aeiou" else "a"


_CATEGORY_DISPLAY = {
    "none": "social engineering",
    "other": "agent-safety",  # prompt injection / cli execution / etc.
    "wire-fraud": "wire fraud",
    "crypto-scam": "crypto scam",
    "tech-support": "tech-support scam",
}


def synth_thought(decision: str, scam_category: str) -> str:
    cat = _CATEGORY_DISPLAY.get(scam_category, scam_category)
    cat_with_article = f"{_article(cat)} {cat}"
    cat_cap = cat[:1].upper() + cat[1:] if cat else "Unsafe"
    tpl = DECISION_THOUGHT_TEMPLATES.get(decision)
    if not tpl:
        return DEFAULT_THOUGHT
    return tpl.format(cat=cat, cat_a=cat_with_article, cat_cap=cat_cap)


# ─────────────── system-prompt rendering ────────────────────────────────

_REPLY_TEMPLATE_CACHE: str | None = None


def reply_system_prompt(agent_name: str) -> str:
    """Render the canonical `reply` template from the prompt registry."""
    global _REPLY_TEMPLATE_CACHE
    if _REPLY_TEMPLATE_CACHE is None:
        registry = _load_prompt_registry()
        entry = registry.get("reply")
        if not entry:
            raise RuntimeError(
                "registry.json is missing the `reply` task template — "
                "cannot render system prompt."
            )
        _REPLY_TEMPLATE_CACHE = entry["template"]
    return render_handlebars(
        _REPLY_TEMPLATE_CACHE,
        {"agentName": agent_name, "providers": ""},
    )


# ─────────────── parquet → canonical record ─────────────────────────────


def iter_parquet_records(path: Path) -> Iterator[dict[str, Any]]:
    """Yield raw parquet rows as plain dicts."""
    table = pq.read_table(path)
    cols = table.column_names
    for i in range(table.num_rows):
        yield {c: table[c][i].as_py() for c in cols}


def extract_last_user(messages: list[dict[str, Any]]) -> tuple[str, str]:
    """Return (speaker, content) of the last user-role message in the list."""
    for m in reversed(messages):
        role = (m.get("role") or "").lower()
        if role == "user":
            return (m.get("speaker") or "user"), (m.get("content") or "")
    return "user", ""


def extract_memory(messages: list[dict[str, Any]], agent_id: str) -> list[dict[str, Any]]:
    """Build memoryEntries from everything before the final user turn.

    System turns are dropped (they ride in metadata.system_prompt). The
    final user turn is `currentMessage`; the assistant turn after it (if
    any) is the supervised target and lives in `expectedResponse`.
    """
    # Find index of last user turn
    last_user_idx = -1
    for idx in range(len(messages) - 1, -1, -1):
        if (messages[idx].get("role") or "").lower() == "user":
            last_user_idx = idx
            break
    if last_user_idx < 0:
        return []
    memory = []
    for m in messages[:last_user_idx]:
        role = (m.get("role") or "").lower()
        if role not in ("user", "assistant"):
            continue
        content = (m.get("content") or "").strip()
        if not content:
            continue
        memory.append({
            "role": role,
            "speaker": m.get("speaker") or (agent_id if role == "assistant" else "user"),
            "content": content,
            "channel": m.get("channel") or "chat",
        })
    return memory


# ─────────────── main pipeline ──────────────────────────────────────────


def load_existing_state(path: Path) -> tuple[set[str], int, int]:
    """Resume-safe: read existing output and return:

      - seen_ids: set of source_ids already emitted
      - legitimate_emitted: count of records whose scam_category is "none"
      - trigger_emitted: count of records whose scam_category is not "none"

    The legitimate count lets the second pass enforce
    `legitimate_ratio` across the cumulative output rather than just the
    current run, so re-runs don't blow past the cap.
    """
    seen: set[str] = set()
    legit = 0
    trig = 0
    if not path.exists():
        return seen, legit, trig
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            md = rec.get("metadata") or {}
            src_id = md.get("source_id")
            if src_id:
                seen.add(src_id)
            cat = md.get("scam_category") or ""
            if cat == "none":
                legit += 1
            else:
                trig += 1
    return seen, legit, trig


def adapt_row(
    row: dict[str, Any],
    *,
    encoder: ExpectedResponseEncoder,
    agent_id: str = "milady",
) -> tuple[dict[str, Any] | None, str]:
    """Adapt one parquet row to a canonical eliza record dict.

    Returns (record_dict, drop_reason). drop_reason is empty on success.
    """
    src_id = row.get("id") or ""
    response = (row.get("response_text") or "").strip()
    if not response:
        return None, "empty response_text"

    msgs_raw = row.get("messages")
    if isinstance(msgs_raw, str):
        try:
            messages = json.loads(msgs_raw)
        except json.JSONDecodeError:
            return None, "malformed messages JSON"
    elif isinstance(msgs_raw, list):
        messages = msgs_raw
    else:
        return None, "missing messages"

    if not messages:
        return None, "empty messages"

    speaker, last_user = extract_last_user(messages)
    if not last_user.strip():
        return None, "no last_user content"

    decision = (row.get("decision_class") or "").strip()
    scenario_category = (row.get("scenario_category") or "").strip()
    is_scam = bool(row.get("should_trigger_scam_defense"))
    scam_category = map_scam_category(scenario_category, is_scam=is_scam)

    thought = synth_thought(decision, scam_category)

    target = {
        "thought": thought,
        "reply": {
            "text": response,
            "channel": "chat",
        },
    }
    expected_response = encoder.encode(target)

    sys_prompt = reply_system_prompt(agent_id)

    memory = extract_memory(messages, agent_id)
    current = {
        "role": "user",
        "speaker": speaker or "user",
        "content": last_user,
        "channel": "chat",
    }

    extra_md = {
        "source_id": src_id,
        "scam_category": scam_category,
        "scenario_category": scenario_category,
        "decision_class": decision,
        "should_trigger_scam_defense": is_scam,
        "language": row.get("language") or "",
        "system_prompt": sys_prompt,
    }
    reasoning = (row.get("reasoning_trace") or "").strip()
    if reasoning:
        extra_md["upstream_reasoning_trace"] = reasoning[:1000]

    rec = build(
        roomName="scambench-room",
        agentId=agent_id,
        memoryEntries=memory,
        currentMessage=current,
        expectedResponse=expected_response,
        availableActions=[],
        task_type="reply",
        source_dataset=SOURCE_SLUG,
        license=LICENSE,
        split=SPLIT,
        extra_metadata=extra_md,
    )
    ok, why = rec.is_valid()
    if not ok:
        return None, f"validation: {why}"
    return rec.to_dict(), ""


def run_pipeline(
    *,
    limit: int = 0,
    english_only: bool = True,
    legitimate_ratio: float = 0.25,
) -> dict[str, Any]:
    """Read the parquet, emit canonical records, write manifest.

    Args:
      limit: cap output records (0 = unlimited).
      english_only: only emit `language=='en'` rows.
      legitimate_ratio: fraction of total output that should be
        legitimate/benign (control records to avoid over-refusal).
        Trigger records are always emitted; legitimate records are
        truncated to hit this ratio.
    """
    if not TRAIN_PARQUET.exists():
        raise FileNotFoundError(
            f"missing scambench parquet at {TRAIN_PARQUET}. "
            f"Run the dataset downloader first."
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    seen_ids, prior_legit, prior_trig = load_existing_state(OUT_FILE)
    log.info(
        "resume: %d records already in %s (prior_trigger=%d prior_legit=%d)",
        len(seen_ids), OUT_FILE, prior_trig, prior_legit,
    )

    encoder = JsonExpectedResponseEncoder()

    in_count = 0
    out_count = 0
    dropped: Counter[str] = Counter()
    by_category: Counter[str] = Counter()
    by_language: Counter[str] = Counter()
    by_decision: Counter[str] = Counter()
    by_scam_category: Counter[str] = Counter()

    # Two-pass: count attack/legitimate up front, then cap legitimate to
    # the ratio. We stream-write so memory stays bounded.

    # Pass 1: count category populations (cheap — int counters only).
    legitimate_total = 0
    trigger_total = 0
    for row in iter_parquet_records(TRAIN_PARQUET):
        if english_only and row.get("language") != "en":
            continue
        if (row.get("response_text") or "").strip() == "":
            continue
        if row.get("should_trigger_scam_defense"):
            trigger_total += 1
        else:
            legitimate_total += 1

    log.info(
        "pass1: trigger=%d legitimate=%d (english_only=%s)",
        trigger_total, legitimate_total, english_only,
    )

    # Cap legitimate so they do not exceed `legitimate_ratio` of the
    # final corpus. Solve: legit_kept / (legit_kept + trigger) = ratio
    if legitimate_ratio <= 0:
        legitimate_cap = 0
    elif legitimate_ratio >= 1.0:
        legitimate_cap = legitimate_total
    else:
        # legit_kept = ratio * (trigger + legit_kept)
        # legit_kept * (1 - ratio) = ratio * trigger
        legitimate_cap = int(legitimate_ratio / (1.0 - legitimate_ratio) * trigger_total)
        legitimate_cap = min(legitimate_cap, legitimate_total)

    log.info("pass2: emitting all triggers + up to %d legitimate", legitimate_cap)

    # Pass 2: stream + write. legitimate_emitted is cumulative across
    # runs (loaded from existing output) so the cap is honored after
    # resume.
    legitimate_emitted = prior_legit
    with OUT_FILE.open("a", encoding="utf-8") as out:
        for row in iter_parquet_records(TRAIN_PARQUET):
            in_count += 1
            if english_only and row.get("language") != "en":
                dropped["non_english"] += 1
                continue

            src_id = row.get("id") or ""
            if src_id in seen_ids:
                dropped["already_seen"] += 1
                continue

            is_trigger = bool(row.get("should_trigger_scam_defense"))
            if not is_trigger:
                if legitimate_emitted >= legitimate_cap:
                    dropped["legitimate_capped"] += 1
                    continue

            rec, why = adapt_row(row, encoder=encoder)
            if rec is None:
                dropped[why or "unknown"] += 1
                continue

            out.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
            out_count += 1
            seen_ids.add(src_id)

            md = rec["metadata"]
            by_category[md.get("scenario_category") or "?"] += 1
            by_language[md.get("language") or "?"] += 1
            by_decision[md.get("decision_class") or "?"] += 1
            by_scam_category[md.get("scam_category") or "?"] += 1

            if not is_trigger:
                legitimate_emitted += 1

            if limit and out_count >= limit:
                log.info("hit --limit %d, stopping early", limit)
                break

    encoder.close()

    manifest = {
        "source_dataset": SOURCE_SLUG,
        "license": LICENSE,
        "input_path": str(TRAIN_PARQUET),
        "output_path": str(OUT_FILE),
        "total_in": in_count,
        "total_out": out_count,
        "dropped": dict(dropped.most_common()),
        "by_scam_category": dict(by_scam_category.most_common()),
        "by_scenario_category": dict(by_category.most_common(40)),
        "by_decision_class": dict(by_decision.most_common()),
        "by_language": dict(by_language.most_common()),
        "english_only": english_only,
        "legitimate_ratio_target": legitimate_ratio,
        "legitimate_emitted": legitimate_emitted,
    }
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    log.info(
        "done: in=%d out=%d dropped=%d -> %s",
        in_count, out_count, sum(dropped.values()), OUT_FILE,
    )
    log.info("manifest at %s", MANIFEST_FILE)
    return manifest


# ─────────────── validation ─────────────────────────────────────────────


def validate_output(*, sample: int = 25) -> tuple[bool, list[str]]:
    """Schema + JSON expectedResponse check on the emitted file."""
    if not OUT_FILE.exists():
        return False, [f"output file missing: {OUT_FILE}"]

    errors: list[str] = []
    n_checked = 0

    with OUT_FILE.open("r", encoding="utf-8") as f:
        for idx, line in enumerate(f):
            if n_checked >= sample:
                break
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                errors.append(f"line {idx}: bad JSON: {e}")
                continue

            for key in ("roomName", "agentId", "memoryEntries", "currentMessage",
                        "expectedResponse", "availableActions", "metadata"):
                if key not in rec:
                    errors.append(f"line {idx}: missing top-level key {key!r}")

            md = rec.get("metadata") or {}
            for key in ("task_type", "source_dataset", "scam_category", "system_prompt"):
                if key not in md:
                    errors.append(f"line {idx}: missing metadata.{key}")

            if md.get("task_type") != "reply":
                errors.append(f"line {idx}: unexpected task_type={md.get('task_type')}")
            if md.get("source_dataset") != SOURCE_SLUG:
                errors.append(f"line {idx}: unexpected source_dataset={md.get('source_dataset')}")

            try:
                decoded = json.loads(rec["expectedResponse"])
            except (TypeError, json.JSONDecodeError) as e:
                errors.append(f"line {idx}: JSON expectedResponse decode failed: {e}")
                continue

            if not isinstance(decoded, dict):
                errors.append(f"line {idx}: expectedResponse did not decode to dict")
                continue
            if "thought" not in decoded:
                errors.append(f"line {idx}: expectedResponse missing thought")
            reply = decoded.get("reply")
            if not isinstance(reply, dict):
                errors.append(f"line {idx}: expectedResponse missing reply object")
                continue
            if "text" not in reply or not str(reply["text"]).strip():
                errors.append(f"line {idx}: expectedResponse reply.text empty")
            if reply.get("channel") != "chat":
                errors.append(f"line {idx}: expectedResponse reply.channel != chat")

            n_checked += 1

    return len(errors) == 0, errors


# ─────────────── CLI ────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=0,
                    help="cap output records (0 = unlimited)")
    ap.add_argument("--all-languages", action="store_true",
                    help="include non-English records (default: english only)")
    ap.add_argument("--legitimate-ratio", type=float, default=0.25,
                    help="target fraction of output that is legitimate (default 0.25)")
    ap.add_argument("--validate", action="store_true",
                    help="run schema + JSON expectedResponse check on existing output")
    ap.add_argument("--sample-size", type=int, default=25,
                    help="how many records to validate (with --validate)")
    args = ap.parse_args()

    if args.validate:
        ok, errors = validate_output(sample=args.sample_size)
        if ok:
            print(f"validate: OK — checked {args.sample_size} records cleanly")
            return 0
        print(f"validate: {len(errors)} errors")
        for e in errors[:25]:
            print(f"  - {e}")
        return 1

    manifest = run_pipeline(
        limit=args.limit,
        english_only=not args.all_languages,
        legitimate_ratio=args.legitimate_ratio,
    )
    print(json.dumps({
        "total_out": manifest["total_out"],
        "by_scam_category": manifest["by_scam_category"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
