#!/usr/bin/env python3
"""
Caveman compression for elizaOS Action / dynamic Provider descriptions.

Walks Action and Provider definitions in:
  - packages/agent/src/actions/*.ts        (core actions)
  - packages/agent/src/providers/*.ts      (core providers, dynamic only)
  - plugins/plugin-*/[src/]actions/*.ts    (plugin actions)
  - plugins/plugin-*/[src/]providers/*.ts  (plugin providers, dynamic only)

For each top-level `description: <literal-string>` field in an action / dynamic
provider object literal, generates a "caveman" compressed short version and
inserts a sibling `descriptionShort: "..."` line right after the description.

Skips:
  - Files where descriptionShort already exists for that object.
  - Non-literal descriptions (e.g. `description: spec.description`).
  - Non-dynamic providers.
  - Nested `description:` fields inside `parameters: [...]`, etc.

Usage:
  python3 scripts/caveman_compress.py [--dry-run] [--verbose] [--out report.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

ELIZA_ROOT = Path(__file__).parent.parent.parent.parent.resolve()

# ---------------------------------------------------------------------------
# Caveman compression
# ---------------------------------------------------------------------------

STOPWORDS = {
    "the", "a", "an", "of", "to", "is", "are", "was", "were", "be", "been",
    "have", "has", "had", "do", "does", "did", "will", "would", "can",
    "could", "should", "may", "might", "must", "in", "on", "at", "for",
    "with", "by", "from", "as", "that", "which", "this", "these", "those",
    "it", "its", "their", "your", "our", "my", "me", "you", "them", "us",
    "we", "i", "and", "or", "but", "if", "so", "into", "onto", "out",
    "than", "then", "such", "any", "all", "some", "no", "not",
    "there", "here", "where", "when", "while", "during", "about",
    "they", "he", "she", "also", "only", "more", "own",
}

FILLERS = {
    "just", "really", "actually", "basically", "simply", "very", "rather",
    "quite", "somewhat", "literally", "essentially", "fundamentally",
    "currently",
}

SHORTHAND = {
    "because": "bc",
    "with": "w/",
    "without": "wo/",
}

IRREGULAR_LEMMA = {
    "running": "run", "ran": "run", "runs": "run",
    "executes": "execute", "executed": "execute", "executing": "execute",
    "uses": "use", "used": "use", "using": "use",
    "sends": "send", "sent": "send", "sending": "send",
    "creates": "create", "created": "create", "creating": "create",
    "drafts": "draft", "drafted": "draft", "drafting": "draft",
    "drives": "drive", "drove": "drive", "driven": "drive", "driving": "drive",
    "generates": "generate", "generated": "generate", "generating": "generate",
    "fills": "fill", "filled": "fill", "filling": "fill",
    "stops": "stop", "stopped": "stop", "stopping": "stop",
    "approves": "approve", "approved": "approve", "approving": "approve",
    "watches": "watch", "watched": "watch", "watching": "watch",
    "lets": "let", "letting": "let",
    "checking": "check", "checked": "check", "checks": "check",
    "triages": "triage", "triaged": "triage", "triaging": "triage",
    "digests": "digest", "digested": "digest", "digesting": "digest",
    "responds": "respond", "responded": "respond", "responding": "respond",
    "searches": "search", "searched": "search", "searching": "search",
    "reads": "read", "reading": "read",
    "writes": "write", "wrote": "write", "written": "write", "writing": "write",
    "applies": "apply", "applied": "apply", "applying": "apply",
    "manages": "manage", "managed": "manage", "managing": "manage",
    "loads": "load", "loaded": "load", "loading": "load",
    "lists": "list", "listed": "list", "listing": "list",
    "fetches": "fetch", "fetched": "fetch", "fetching": "fetch",
    "returns": "return", "returned": "return", "returning": "return",
    "requires": "require", "required": "require", "requiring": "require",
    "provides": "provide", "provided": "provide", "providing": "provide",
    "registers": "register", "registered": "register", "registering": "register",
    "supports": "support", "supported": "support", "supporting": "support",
    "handles": "handle", "handled": "handle", "handling": "handle",
    "operates": "operate", "operated": "operate", "operating": "operate",
    "drains": "drain", "drained": "drain", "draining": "drain",
    "swaps": "swap", "swapped": "swap", "swapping": "swap",
    "transfers": "transfer", "transferred": "transfer", "transferring": "transfer",
    "deposits": "deposit", "deposited": "deposit", "depositing": "deposit",
    "withdraws": "withdraw", "withdrew": "withdraw", "withdrawing": "withdraw", "withdrawn": "withdraw",
    "spawns": "spawn", "spawned": "spawn", "spawning": "spawn",
    "starts": "start", "started": "start", "starting": "start",
    "ends": "end", "ended": "end", "ending": "end",
    "shows": "show", "showed": "show", "showing": "show", "shown": "show",
    "asks": "ask", "asked": "ask", "asking": "ask",
    "tells": "tell", "told": "tell", "telling": "tell",
    "given": "give", "gave": "give", "gives": "give", "giving": "give",
    "takes": "take", "took": "take", "taken": "take", "taking": "take",
    "made": "make", "makes": "make", "making": "make",
    "got": "get", "gets": "get", "getting": "get", "gotten": "get",
    "drilled": "drill", "drills": "drill", "drilling": "drill",
    "needed": "need", "needs": "need", "needing": "need",
    "added": "add", "adds": "add", "adding": "add",
    "removed": "remove", "removes": "remove", "removing": "remove",
    "selected": "select", "selects": "select", "selecting": "select",
    "saved": "save", "saves": "save", "saving": "save",
    "stored": "store", "stores": "store", "storing": "store",
    "queried": "query", "queries": "query", "querying": "query",
    "indexed": "index", "indexes": "index", "indexing": "index",
    "matches": "match", "matched": "match", "matching": "match",
    "injects": "inject", "injected": "inject", "injecting": "inject",
    "extracts": "extract", "extracted": "extract", "extracting": "extract",
    "extends": "extend", "extended": "extend", "extending": "extend",
    "sets": "set", "setting": "set",
    "calling": "call", "calls": "call", "called": "call",
    "posting": "post", "posts": "post", "posted": "post",
    "joining": "join", "joins": "join", "joined": "join",
    "leaving": "leave", "leaves": "leave", "left": "leave",
    "pinning": "pin", "pinned": "pin", "pins": "pin",
    "scheduling": "schedule", "schedules": "schedule", "scheduled": "schedule",
    "logging": "log", "logged": "log", "logs": "log",
    "tracking": "track", "tracked": "track", "tracks": "track",
    "displaying": "display", "displays": "display", "displayed": "display",
    "uploading": "upload", "uploads": "upload", "uploaded": "upload",
    "downloading": "download", "downloads": "download", "downloaded": "download",
    "playing": "play", "plays": "play", "played": "play",
    "having": "have",
    "being": "be",
    "doing": "do",
    "saying": "say", "says": "say", "said": "say",
    "released": "release", "releases": "release", "releasing": "release",
    "moves": "move", "moved": "move", "moving": "move",
    "named": "name", "names": "name", "naming": "name",
    "scoped": "scope", "scopes": "scope", "scoping": "scope",
    "based": "base",
    "raised": "raise", "raises": "raise", "raising": "raise",
    "noted": "note", "notes": "note", "noting": "note",
    "spaced": "space", "spaces": "space",
    "phased": "phase",
    "edited": "edit", "edits": "edit", "editing": "edit",
    "lived": "live", "lives": "live", "living": "live",
    "tied": "tie", "ties": "tie", "tying": "tie",
    "filed": "file", "files": "file", "filing": "file",
    "shared": "share", "shares": "share", "sharing": "share",
    "scared": "scare",
    "served": "serve", "serves": "serve", "serving": "serve",
    "scaled": "scale", "scales": "scale", "scaling": "scale",
    "pooled": "pool", "pools": "pool", "pooling": "pool",
    "sized": "size", "sizes": "size", "sizing": "size",
    "queued": "queue", "queues": "queue", "queuing": "queue",
    "viewed": "view", "views": "view", "viewing": "view",
    "labeled": "label", "labels": "label", "labeling": "label",
    "sourced": "source", "sources": "source",
    "owned": "own", "owns": "own", "owning": "own",
    "tagged": "tag", "tags": "tag", "tagging": "tag",
    "merged": "merge", "merges": "merge", "merging": "merge",
    "yields": "yield", "yielded": "yield", "yielding": "yield",
    "renamed": "rename", "renames": "rename", "renaming": "rename",
    "leaved": "leave",  # mistake-correction
    "preserved": "preserve", "preserves": "preserve", "preserving": "preserve",
    "stocked": "stock", "stocks": "stock",
    "linked": "link", "links": "link", "linking": "link",
    "ranked": "rank", "ranks": "rank", "ranking": "rank",
    "notified": "notify",
    "modified": "modify", "modifies": "modify", "modifying": "modify",
    "verified": "verify", "verifies": "verify", "verifying": "verify",
    "specified": "specify", "specifies": "specify", "specifying": "specify",
    "identified": "identify", "identifies": "identify", "identifying": "identify",
    "qualified": "qualify",
    "classified": "classify",
}


def _lemma(word: str) -> str:
    """Cheap deterministic lemmatizer covering common english verb endings."""
    lower = word.lower()
    # Possessive 's: drop the apostrophe + s entirely, return the bare noun.
    if lower.endswith("'s"):
        return lower[:-2]
    if "'" in lower:
        return lower
    if lower in IRREGULAR_LEMMA:
        return IRREGULAR_LEMMA[lower]
    if len(lower) > 4 and lower.endswith("ies"):
        return lower[:-3] + "y"
    if len(lower) > 5 and lower.endswith("ing"):
        base = lower[:-3]
        if len(base) >= 2 and base[-1] == base[-2] and base[-1] not in "lsz":
            base = base[:-1]
        # Restore silent "e":
        #   - stems ending in V + (c/g/s/v/z) (e.g. messaging->message,
        #     using->use, choosing->choose, gazing->gaze).
        #   - stems ending in consonant cluster + (c/g/s/v/z/e) where the
        #     cluster ends in r/l (e.g. sourcing->source, forcing->force,
        #     pulsing->pulse, surveiling->surveil, tracing->trace).
        if (
            len(base) >= 3
            and base[-1] in "cgsvz"
            and (base[-2] in "aeiouy" or base[-2] in "rln")
        ):
            return base + "e"
        return base
    if len(lower) > 4 and lower.endswith("ed"):
        base = lower[:-2]
        if base.endswith("e"):
            return base
        # Short 3-char stem CVC: restore silent "e" (based->base, fired->fire).
        if (
            len(base) == 3
            and base[-1] in "bcdfghjklmnpqrstvwxz"
            and base[-2] in "aeiouy"
            and base[-3] in "bcdfghjklmnpqrstvwxz"
        ):
            return base + "e"
        # Stems ending in c/g/s/v/z preceded by a vowel or consonant cluster
        # ending in r/l/n: restore "e" (changed->change, forced->force,
        # released->release, raced->race, ranged->range).
        if (
            len(base) >= 4
            and base[-1] in "cgsvz"
            and (base[-2] in "aeiouy" or base[-2] in "rln")
        ):
            return base + "e"
        return base if base else lower
    # -ches/-shes/-xes/-zes/-sses: strip "es" (relaunches -> relaunch).
    if len(lower) > 4 and (
        lower.endswith("ches")
        or lower.endswith("shes")
        or lower.endswith("xes")
        or lower.endswith("zes")
        or lower.endswith("sses")
    ):
        return lower[:-2]
    if (
        len(lower) > 3
        and lower.endswith("s")
        and not lower.endswith("ss")
        and not lower.endswith("us")
        and not lower.endswith("is")
        and not lower.endswith("os")
    ):
        return lower[:-1]
    return lower


# Common English words that look like proper nouns when title-cased at the
# start of a sentence. We always lemmatize and lowercase these.
_COMMON_INITIAL_TITLE = {
    "Get", "Use", "Post", "Posts", "Reply", "Replies", "Send", "Sends",
    "Run", "Runs", "Create", "Creates", "Update", "Updates", "Delete",
    "Deletes", "Read", "Reads", "Write", "Writes", "Set", "Sets",
    "Show", "Shows", "List", "Lists", "Make", "Makes", "Take", "Takes",
    "Provide", "Provides", "Provided", "Render", "Renders", "Returns",
    "Return", "Search", "Searches", "Fetch", "Fetches", "Allow", "Allows",
    "Manage", "Manages", "Compose", "Composes", "Compute", "Computes",
    "Add", "Adds", "Remove", "Removes", "Replace", "Replaces", "Open",
    "Opens", "Close", "Closes", "Stop", "Stops", "Start", "Starts",
    "Join", "Joins", "Leave", "Leaves", "Pin", "Pins", "Unpin", "Unpins",
    "Edit", "Edits", "Drop", "Drops", "Find", "Finds", "Track", "Tracks",
    "Trigger", "Triggers", "Build", "Builds", "Trigger", "Generate",
    "Generates", "Inject", "Injects", "Match", "Matches", "Apply",
    "Applies", "Drive", "Drives", "Bring", "Brings", "Append", "Appends",
    "Copy", "Copies", "Move", "Moves", "Save", "Saves", "Load", "Loads",
    "Cancel", "Cancels", "Confirm", "Confirms", "Schedule", "Schedules",
    "Connect", "Connects", "Disconnect", "Disconnects", "Lookup", "Resolve",
    "Resolves", "Spawn", "Spawns", "Watch", "Watches", "View", "Views",
    "Help", "Helps", "Pause", "Pauses", "Resume", "Resumes", "Toggle",
    "Toggles", "Enable", "Enables", "Disable", "Disables", "Install",
    "Installs", "Uninstall", "Uninstalls", "Reinstall", "Reinstalls",
    "Sync", "Syncs", "Reset", "Resets", "Restart", "Restarts", "Print",
    "Prints", "Notify", "Notifies", "Validate", "Validates", "Verify",
    "Verifies", "Check", "Checks", "Calls", "Call", "When", "Where",
    "How", "What", "Why", "Then", "Now", "Always", "Never", "Once",
    "Only", "Also", "Otherwise", "Used",
}


def _is_proper(token: str) -> bool:
    if token in _COMMON_INITIAL_TITLE:
        return False
    if len(token) >= 2 and token.isupper() and any(c.isalpha() for c in token):
        return True
    if (
        len(token) >= 2
        and token[0].isupper()
        and any(c.islower() for c in token[1:])
    ):
        return True
    return False


def caveman_compress(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    cleaned = (
        cleaned.replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("—", "-")
        .replace("–", "-")
    )
    cleaned = cleaned.rstrip(".").strip()

    tokens = re.findall(
        r"[A-Za-z][A-Za-z0-9_\-/]*'?[A-Za-z]*|\d+|[^\s\w]",
        cleaned,
    )

    out: list[str] = []
    sentence_start = True  # very first word is sentence-initial
    for tok in tokens:
        if not tok:
            continue
        if not re.match(r"[A-Za-z0-9]", tok[0]):
            if tok in {".", '"', "'", "`", "?", "!"}:
                if tok in {".", "!", "?"}:
                    sentence_start = True
                continue
            if tok in {",", ":", ";", "(", ")", "/", "-", "+", "&"}:
                out.append(tok)
            continue
        # Strip trailing apostrophe (e.g. 'foo' -> foo).
        if tok.endswith("'"):
            tok = tok[:-1]
            if not tok:
                continue

        lower = tok.lower()
        # Sentence-initial title-cased common words: lowercase + lemmatize.
        if sentence_start and tok and tok[0].isupper():
            sentence_start = False
            if lower in SHORTHAND:
                out.append(SHORTHAND[lower])
                continue
            if lower in STOPWORDS or lower in FILLERS:
                continue
            # If the token has an all-caps segment longer than 1 char (e.g.
            # "AGENT-scoped", "GET_SELF_STATUS"), keep verbatim.
            segments = re.split(r"[-_/]", tok)
            has_acronym = any(
                seg.isupper() and len(seg) >= 2 for seg in segments
            )
            if has_acronym:
                out.append(tok)
                continue
            # Treat as common word if not an all-caps acronym.
            if not (tok.isupper() and len(tok) >= 2):
                out.append(_lemma(tok))
                continue
            # All-caps: keep verbatim.
            out.append(tok)
            continue
        sentence_start = False

        if lower in SHORTHAND:
            out.append(SHORTHAND[lower])
            continue
        if lower in STOPWORDS or lower in FILLERS:
            continue
        if _is_proper(tok):
            out.append(tok)
            continue
        out.append(_lemma(tok))

    glued_parts: list[str] = []
    for tok in out:
        if tok in {",", ":", ";", ")"} and glued_parts:
            glued_parts[-1] = glued_parts[-1] + tok
        else:
            glued_parts.append(tok)
    glued = " ".join(glued_parts)
    glued = re.sub(r"\(\s+", "(", glued)
    glued = re.sub(r"\s+\)", ")", glued)
    glued = re.sub(r"\s+", " ", glued).strip()
    glued = glued.rstrip(",;:")
    return glued


# ---------------------------------------------------------------------------
# TS source manipulation
# ---------------------------------------------------------------------------

@dataclass
class Hit:
    file: Path
    desc_line: int            # 0-indexed line where `description:` keyword starts
    end_line: int             # 0-indexed line where the literal value ends
    indent: str               # leading whitespace of the description line
    description: str
    is_provider: bool
    object_kind: str          # "action" | "provider"
    has_existing_short: bool


_STRING_LITERAL_RE = re.compile(
    r"""
    (?P<q>["'`])
    (?:
        \\.
      | (?!(?P=q)).
    )*
    (?P=q)
    """,
    re.VERBOSE | re.DOTALL,
)


def _decode_string_literal(token: str) -> Optional[str]:
    if not token or len(token) < 2:
        return None
    quote = token[0]
    if quote not in "\"'`" or token[-1] != quote:
        return None
    body = token[1:-1]
    if quote in "\"'":
        # Decode common JS escapes via codecs.
        try:
            return bytes(body, "utf-8").decode("unicode_escape")
        except UnicodeDecodeError:
            return body
    if "${" in body:
        return None
    return body.replace("\\`", "`").replace("\\$", "$").replace("\\\\", "\\")


def _skip_ws_and_comments(text: str, i: int) -> int:
    while i < len(text):
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        if text[i:i + 2] == "//":
            nl = text.find("\n", i)
            if nl < 0:
                return len(text)
            i = nl + 1
            continue
        if text[i:i + 2] == "/*":
            close = text.find("*/", i + 2)
            if close < 0:
                return len(text)
            i = close + 2
            continue
        break
    return i


def _parse_description_value(text: str, start: int) -> tuple[Optional[str], int]:
    pos = _skip_ws_and_comments(text, start)
    if pos >= len(text) or text[pos] not in "\"'`":
        return None, pos
    parts: list[str] = []
    while True:
        pos = _skip_ws_and_comments(text, pos)
        if pos >= len(text) or text[pos] not in "\"'`":
            return None, pos
        m = _STRING_LITERAL_RE.match(text, pos)
        if not m:
            return None, pos
        decoded = _decode_string_literal(m.group(0))
        if decoded is None:
            return None, m.end()
        parts.append(decoded)
        pos = _skip_ws_and_comments(text, m.end())
        if pos < len(text) and text[pos] == "+":
            pos += 1
            continue
        break
    return "".join(parts), pos


def _skip_string(src: str, i: int) -> int:
    quote = src[i]
    j = i + 1
    while j < len(src):
        ch = src[j]
        if ch == "\\":
            j += 2
            continue
        if quote == "`" and ch == "$" and j + 1 < len(src) and src[j + 1] == "{":
            j += 2
            depth = 1
            while j < len(src) and depth > 0:
                cj = src[j]
                if cj == "{":
                    depth += 1
                elif cj == "}":
                    depth -= 1
                elif cj in "\"'`":
                    j = _skip_string(src, j)
                    if j < 0:
                        return -1
                    continue
                j += 1
            continue
        if ch == quote:
            return j + 1
        j += 1
    return -1


def _matching_brace(src: str, open_idx: int) -> Optional[int]:
    if src[open_idx] != "{":
        return None
    i = open_idx + 1
    depth = 1
    while i < len(src):
        ch = src[i]
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            depth -= 1
            if depth == 0:
                return i
            i += 1
            continue
        if ch == "/" and i + 1 < len(src):
            nxt = src[i + 1]
            if nxt == "/":
                nl = src.find("\n", i)
                if nl < 0:
                    return None
                i = nl + 1
                continue
            if nxt == "*":
                close = src.find("*/", i + 2)
                if close < 0:
                    return None
                i = close + 2
                continue
        if ch in "\"'`":
            i = _skip_string(src, i)
            if i < 0:
                return None
            continue
        i += 1
    return None


def _find_object_owner(src: str, desc_pos: int) -> Optional[int]:
    """Walk backward from desc_pos to find the nearest unmatched `{` (the
    object literal that owns this property)."""
    depth = 0
    i = desc_pos - 1
    in_string: Optional[str] = None
    while i >= 0:
        ch = src[i]
        if in_string is not None:
            if ch == in_string and (i == 0 or src[i - 1] != "\\"):
                in_string = None
            i -= 1
            continue
        if ch in "\"'`":
            # Walking backward through strings is tricky; skip quickly via
            # nearest opening of same quote on same line as a heuristic.
            j = src.rfind(ch, 0, i)
            if j < 0:
                return None
            i = j - 1
            continue
        if ch == "}":
            depth += 1
        elif ch == "{":
            if depth == 0:
                return i
            depth -= 1
        i -= 1
    return None


def _has_sibling_field(block: str, prop_indent: str, name: str) -> bool:
    pat = rf"(?m)^{re.escape(prop_indent)}{re.escape(name)}\s*[:?]"
    return re.search(pat, block) is not None


def _read_bool_field(block: str, prop_indent: str, name: str) -> Optional[bool]:
    pat = rf"(?m)^{re.escape(prop_indent)}{re.escape(name)}\s*:\s*(true|false)\b"
    m = re.search(pat, block)
    if not m:
        return None
    return m.group(1) == "true"


def _classify_object(block: str, prop_indent: str) -> Optional[str]:
    if not _has_sibling_field(block, prop_indent, "name"):
        return None
    has_handler = _has_sibling_field(block, prop_indent, "handler")
    has_validate = _has_sibling_field(block, prop_indent, "validate")
    has_examples = _has_sibling_field(block, prop_indent, "examples")
    has_similes = _has_sibling_field(block, prop_indent, "similes")
    has_get = _has_sibling_field(block, prop_indent, "get")
    has_dynamic = _has_sibling_field(block, prop_indent, "dynamic")
    has_position = _has_sibling_field(block, prop_indent, "position")
    has_relevance = _has_sibling_field(block, prop_indent, "relevanceKeywords")

    is_action = has_handler or (has_validate and (has_examples or has_similes))
    is_provider = has_get or has_dynamic or has_position or has_relevance

    if is_action and not is_provider:
        return "action"
    if is_provider and not is_action:
        return "provider"
    if is_action and is_provider:
        return "action" if has_handler else "provider"
    return None


def _line_at(line_starts: list[int], idx: int) -> int:
    lo, hi = 0, len(line_starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if line_starts[mid] <= idx:
            lo = mid
        else:
            hi = mid - 1
    return lo


def find_top_level_descriptions(file_path: Path) -> list[Hit]:
    src = file_path.read_text(encoding="utf-8")
    if "description" not in src:
        return []

    line_starts = [0]
    for i, ch in enumerate(src):
        if ch == "\n":
            line_starts.append(i + 1)

    hits: list[Hit] = []
    for m in re.finditer(r"(?m)^(?P<indent>[ \t]*)description\s*:", src):
        desc_line = _line_at(line_starts, m.start())
        indent = m.group("indent")
        if indent == "":
            # Top of file or a stray; not an object property.
            continue
        owner_start = _find_object_owner(src, m.start())
        if owner_start is None:
            continue
        owner_end = _matching_brace(src, owner_start)
        if owner_end is None:
            continue
        block = src[owner_start:owner_end + 1]
        kind = _classify_object(block, indent)
        if kind is None:
            continue
        existing_short = _has_sibling_field(block, indent, "descriptionShort")
        if kind == "provider":
            dyn = _read_bool_field(block, indent, "dynamic")
            if dyn is not True:
                continue
        decoded, value_end = _parse_description_value(src, m.end())
        if decoded is None:
            continue
        end_line = _line_at(line_starts, max(0, value_end - 1))
        hits.append(
            Hit(
                file=file_path,
                desc_line=desc_line,
                end_line=end_line,
                indent=indent,
                description=decoded,
                is_provider=(kind == "provider"),
                object_kind=kind,
                has_existing_short=existing_short,
            )
        )
    return hits


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

EXCLUDE_PARTS = {"node_modules", "dist", "generated", "__tests__", "test", "tests"}


def gather_target_files(eliza_root: Path) -> list[Path]:
    targets: list[Path] = []

    core_actions = eliza_root / "packages/agent/src/actions"
    core_providers = eliza_root / "packages/agent/src/providers"
    for d in (core_actions, core_providers):
        if not d.exists():
            continue
        for p in sorted(d.rglob("*.ts")):
            if any(part in EXCLUDE_PARTS for part in p.parts):
                continue
            if p.name.endswith(".test.ts") or p.name.endswith(".d.ts"):
                continue
            if p.name == "index.ts":
                continue
            targets.append(p)

    plugins = eliza_root / "plugins"
    if plugins.exists():
        for plugin_dir in sorted(plugins.iterdir()):
            if not plugin_dir.is_dir() or not plugin_dir.name.startswith("plugin-"):
                continue
            for sub in ("actions", "providers"):
                for d in plugin_dir.rglob(sub):
                    if not d.is_dir():
                        continue
                    if any(part in EXCLUDE_PARTS for part in d.parts):
                        continue
                    for p in sorted(d.rglob("*.ts")):
                        if any(part in EXCLUDE_PARTS for part in p.parts):
                            continue
                        if p.name.endswith(".test.ts") or p.name.endswith(".d.ts"):
                            continue
                        if p.name == "index.ts":
                            continue
                        targets.append(p)

    seen: set[Path] = set()
    unique: list[Path] = []
    for p in targets:
        if p in seen:
            continue
        seen.add(p)
        unique.append(p)
    return unique


# ---------------------------------------------------------------------------
# Edits
# ---------------------------------------------------------------------------

@dataclass
class EditResult:
    file: Path
    object_kind: str
    name: str
    description: str
    short: str
    inserted: bool
    reason: Optional[str] = None


def _ts_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'


def caveman_validate(original: str, short: str) -> tuple[bool, Optional[str]]:
    if not short:
        return False, "empty"
    short_words = re.findall(r"[A-Za-z][A-Za-z0-9_/-]*", short)
    if len(short_words) < 2:
        return False, "short<2_words"
    if short.strip() == original.strip():
        return False, "identical"
    if len(short) >= len(original):
        return False, "no_compression"
    return True, None


def _find_object_name(src: str, owner_start: int, prop_indent: str = "") -> str:
    end = _matching_brace(src, owner_start)
    if end is None:
        return ""
    block = src[owner_start:end + 1]
    indent_pat = re.escape(prop_indent) if prop_indent else r"\s*"
    # Try top-level (indent-aware) name field first.
    if prop_indent:
        m = re.search(rf'(?m)^{indent_pat}name\s*:\s*"([^"]+)"', block)
        if m:
            return m.group(1)
        m = re.search(rf"(?m)^{indent_pat}name\s*:\s*'([^']+)'", block)
        if m:
            return m.group(1)
        m = re.search(rf"(?m)^{indent_pat}name\s*:\s*([A-Za-z_][\w.]*)", block)
        if m:
            return m.group(1)
    # Fallback: any indentation.
    m = re.search(r'(?m)^\s*name\s*:\s*"([^"]+)"', block)
    if m:
        return m.group(1)
    m = re.search(r"(?m)^\s*name\s*:\s*'([^']+)'", block)
    if m:
        return m.group(1)
    m = re.search(r"(?m)^\s*name\s*:\s*([A-Za-z_][\w.]*)", block)
    if m:
        return m.group(1)
    pre = src[max(0, owner_start - 200):owner_start]
    vm = re.search(r"(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*\{$", pre.rstrip())
    if vm:
        return vm.group(1)
    return ""


def _name_for_hit(src: str, hit: Hit, line_starts: list[int]) -> str:
    desc_pos = line_starts[hit.desc_line] + len(hit.indent)
    owner_start = _find_object_owner(src, desc_pos)
    if owner_start is None:
        return ""
    return _find_object_name(src, owner_start, hit.indent)


def apply_edits_for_file(
    file_path: Path, dry_run: bool, verbose: bool
) -> list[EditResult]:
    hits = find_top_level_descriptions(file_path)
    if not hits:
        return []
    src = file_path.read_text(encoding="utf-8")
    line_starts = [0]
    for i, ch in enumerate(src):
        if ch == "\n":
            line_starts.append(i + 1)
    lines = src.splitlines(keepends=True)
    results: list[EditResult] = []

    sorted_hits = sorted(hits, key=lambda h: h.end_line, reverse=True)
    for hit in sorted_hits:
        name = _name_for_hit(src, hit, line_starts)
        if hit.has_existing_short:
            results.append(
                EditResult(
                    file=file_path,
                    object_kind=hit.object_kind,
                    name=name,
                    description=hit.description,
                    short="",
                    inserted=False,
                    reason="already_has_descriptionShort",
                )
            )
            continue
        short = caveman_compress(hit.description)
        ok, why = caveman_validate(hit.description, short)
        if not ok:
            results.append(
                EditResult(
                    file=file_path,
                    object_kind=hit.object_kind,
                    name=name,
                    description=hit.description,
                    short=short,
                    inserted=False,
                    reason=f"rejected:{why}",
                )
            )
            continue

        comma_line = hit.end_line
        for li in range(hit.end_line, min(len(lines), hit.end_line + 4)):
            if "," in lines[li]:
                comma_line = li
                break

        ts_value = _ts_string(short)
        insert_text = f"{hit.indent}descriptionShort: {ts_value},\n"
        lines.insert(comma_line + 1, insert_text)
        results.append(
            EditResult(
                file=file_path,
                object_kind=hit.object_kind,
                name=name,
                description=hit.description,
                short=short,
                inserted=True,
            )
        )

    if any(r.inserted for r in results) and not dry_run:
        file_path.write_text("".join(lines), encoding="utf-8")
    if verbose:
        for r in results:
            status = "INS" if r.inserted else f"SKIP[{r.reason}]"
            try:
                rel = r.file.relative_to(ELIZA_ROOT)
            except ValueError:
                rel = r.file
            print(f"{status} {rel} :: {r.name or '<anon>'}", file=sys.stderr)
    return results


# ---------------------------------------------------------------------------
# Type interface update
# ---------------------------------------------------------------------------

def ensure_type_field(eliza_root: Path, dry_run: bool) -> list[str]:
    f = eliza_root / "packages/core/src/types/components.ts"
    if not f.exists():
        return []
    src = f.read_text(encoding="utf-8")
    changes: list[str] = []
    new_src = src

    def insert_after_compressed(label: str, anchor_re: re.Pattern[str]) -> None:
        nonlocal new_src
        m = anchor_re.search(new_src)
        if not m:
            return
        block_start = new_src.rfind("export interface", 0, m.start())
        block_end = new_src.find("\n}", m.end())
        if block_start < 0 or block_end < 0:
            return
        block = new_src[block_start:block_end]
        if "descriptionShort" in block:
            return
        insertion = (
            "\n\t/** Caveman-compressed short description for prompt-cost reduction */\n"
            "\tdescriptionShort?: string;\n"
        )
        new_src = new_src[: m.end()] + insertion + new_src[m.end():]
        changes.append(f"added descriptionShort to {label}")

    insert_after_compressed(
        "Action",
        re.compile(
            r"export interface Action\s*\{[^}]*?descriptionCompressed\?:\s*string;",
            re.DOTALL,
        ),
    )
    insert_after_compressed(
        "Provider",
        re.compile(
            r"export interface Provider\s*\{[^}]*?descriptionCompressed\?:\s*string;",
            re.DOTALL,
        ),
    )

    if changes and not dry_run:
        f.write_text(new_src, encoding="utf-8")
    return changes


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--out", type=str)
    args = parser.parse_args(argv[1:])

    type_changes = ensure_type_field(ELIZA_ROOT, args.dry_run)
    for c in type_changes:
        print(f"[type] {c}", file=sys.stderr)

    files = gather_target_files(ELIZA_ROOT)
    if args.verbose:
        print(f"[scan] {len(files)} candidate files", file=sys.stderr)

    all_results: list[EditResult] = []
    for f in files:
        try:
            file_results = apply_edits_for_file(f, args.dry_run, args.verbose)
        except Exception as e:
            print(f"[error] {f}: {e}", file=sys.stderr)
            continue
        all_results.extend(file_results)

    actions_inserted = [
        r for r in all_results if r.inserted and r.object_kind == "action"
    ]
    providers_inserted = [
        r for r in all_results if r.inserted and r.object_kind == "provider"
    ]
    rejected = [
        r for r in all_results
        if not r.inserted and r.reason and r.reason.startswith("rejected:")
    ]
    skipped_existing = [
        r for r in all_results
        if not r.inserted and r.reason == "already_has_descriptionShort"
    ]

    def ratio(orig: str, short: str) -> float:
        ow = max(1, len(re.findall(r"\S+", orig)))
        sw = len(re.findall(r"\S+", short))
        return 1.0 - sw / ow

    inserted = actions_inserted + providers_inserted
    avg_ratio = (
        sum(ratio(r.description, r.short) for r in inserted) / max(1, len(inserted))
    )

    print("=" * 72)
    print(f"Actions   updated: {len(actions_inserted)}")
    print(f"Providers updated: {len(providers_inserted)}")
    print(f"Already had descriptionShort: {len(skipped_existing)}")
    print(f"Rejected (heuristic): {len(rejected)}")
    print(f"Avg word-count compression ratio: {avg_ratio:.2%}")
    print("=" * 72)

    import random
    random.seed(42)
    samples = random.sample(inserted, k=min(5, len(inserted))) if inserted else []
    for s in samples:
        try:
            rel = s.file.relative_to(ELIZA_ROOT)
        except ValueError:
            rel = s.file
        print()
        print(f"--- {rel} :: {s.name or '<anon>'} ({s.object_kind}) ---")
        print(f"description     : {s.description}")
        print(f"descriptionShort: {s.short}")

    if rejected:
        print()
        print("Rejected hits (kept long form, no descriptionShort added):")
        for r in rejected[:30]:
            try:
                rel = r.file.relative_to(ELIZA_ROOT)
            except ValueError:
                rel = r.file
            print(f"  - {rel} :: {r.name or '<anon>'} -> {r.reason}")

    if args.out:
        out_payload = {
            "actions_updated": len(actions_inserted),
            "providers_updated": len(providers_inserted),
            "already_short": len(skipped_existing),
            "rejected": [
                {
                    "file": str(r.file.relative_to(ELIZA_ROOT))
                    if str(r.file).startswith(str(ELIZA_ROOT))
                    else str(r.file),
                    "name": r.name,
                    "kind": r.object_kind,
                    "reason": r.reason,
                    "description": r.description,
                    "short_attempt": r.short,
                }
                for r in rejected
            ],
            "samples": [
                {
                    "file": str(s.file.relative_to(ELIZA_ROOT))
                    if str(s.file).startswith(str(ELIZA_ROOT))
                    else str(s.file),
                    "name": s.name,
                    "kind": s.object_kind,
                    "description": s.description,
                    "descriptionShort": s.short,
                }
                for s in samples
            ],
            "avg_compression_ratio": avg_ratio,
        }
        Path(args.out).write_text(json.dumps(out_payload, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
